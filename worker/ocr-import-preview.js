import {json,failure,bad} from './http.js';
import {OCR_MODEL,normalizeOcrOutput} from './ocr.js';

// Explicit one-page Workers AI OCR preview, without saving the source to R2.
// Uses the exact same per-user and app counters as saved-image Workers AI OCR.
const jstDay=()=>new Intl.DateTimeFormat('sv-SE',{
  timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'
}).format(new Date());
const utcDay=()=>new Date().toISOString().slice(0,10);
const run=(db,sql,...args)=>db.prepare(sql).bind(...args).run();
const b64=bytes=>{
  let text='';
  for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(text);
};
async function finish(env,user,day,utc,invoked){
  const count=invoked?1:0;
  await env.DB.batch([
    env.DB.prepare('UPDATE usage_daily SET ai_calls=ai_calls+?,ai_reserved=MAX(0,ai_reserved-1) WHERE user_id=? AND local_day=?')
      .bind(count,user.user_id,day),
    env.DB.prepare('UPDATE ocr_app_utc_daily SET calls=calls+?,reserved=MAX(0,reserved-1) WHERE day_utc=?')
      .bind(count,utc)
  ]);
}
export async function workersAiImportPreview(request,env,user){
  if(env.ENABLE_EXPERIMENTAL_OCR!=='true'||!env.AI?.run)
    return failure('OCR_NOT_READY','Workers AI 图片识别暂不可用',503);
  const size=Number(request.headers.get('content-length')||0);
  if(size>1150000)return failure('OCR_PREVIEW_TOO_LARGE','扫描图片不能超过 900KB',413);
  if(!/^multipart\/form-data;/i.test(request.headers.get('content-type')||''))
    bad('请提供单张扫描图片','INVALID_OCR_FORM',415);
  let form;
  try{form=await request.formData();}catch{bad('无法读取扫描图片','INVALID_OCR_FORM',400);}
  if(form.get('confirm_workers_ai')!=='true')bad('请确认发送至 Cloudflare Workers AI','OCR_CONSENT_REQUIRED',409);
  const file=form.get('file');
  if(!(file instanceof Blob)||file.size<100||file.size>900*1024||file.type!=='image/jpeg')
    return failure('OCR_PREVIEW_FILE_INVALID','请提供压缩后的 JPEG 图片（900KB 以内）',422);
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(bytes.length!==file.size||bytes[0]!==255||bytes[1]!==216||
      bytes[bytes.length-2]!==255||bytes[bytes.length-1]!==217)
    return failure('OCR_PREVIEW_FILE_INVALID','JPEG 格式无效',422);
  const limit=Math.max(0,Math.min(5,Number(env.OCR_CALLS_PER_USER_DAY??5)));
  const appLimit=Math.max(0,Math.min(5,Number(env.OCR_APP_UTC_DAILY_LIMIT??5)));
  if(!limit||!appLimit)return failure('OCR_BUDGET_DISABLED','Workers AI OCR 今日额度未开放',503);
  const day=jstDay(),utc=utcDay();
  await run(env.DB,'INSERT OR IGNORE INTO usage_daily(user_id,local_day) VALUES(?,?)',user.user_id,day);
  const userClaim=await run(env.DB,`UPDATE usage_daily SET ai_reserved=ai_reserved+1 WHERE user_id=? AND local_day=? AND ai_calls+ai_reserved<?`,
    user.user_id,day,limit);
  if(userClaim.meta?.changes!==1)
    return failure('OCR_BUDGET_EXHAUSTED','今天的 Workers AI OCR 次数已用完',429);
  let appClaimed=false,invoked=false;
  try{
    await run(env.DB,'INSERT OR IGNORE INTO ocr_app_utc_daily(day_utc) VALUES(?)',utc);
    const appClaim=await run(env.DB,`UPDATE ocr_app_utc_daily SET reserved=reserved+1 WHERE day_utc=? AND calls+reserved<?`,utc,appLimit);
    if(appClaim.meta?.changes!==1)return failure('OCR_APP_UTC_LIMIT','今天的 Workers AI OCR 次数已用完',429);
    appClaimed=true;
    invoked=true;
    const result=await env.AI.run(OCR_MODEL,{
      task:'query',image:'data:image/jpeg;base64,'+b64(bytes),
      question:'Transcribe all legible Japanese document text verbatim, preserving printed line breaks, dates and prices. For unreadable portions write [不明]. Do not invent missing text.',
      reasoning:false,temperature:0,max_tokens:1500,stream:false
    });
    const parsed=normalizeOcrOutput(result);
    if(parsed.text.length<6||parsed.text.length>12000||!/[ぁ-んァ-ヶ一-龯々]/.test(parsed.text))
      return failure('OCR_EMPTY','没有识别出可用日文，请试试 OCR.space',422);
    return json({ok:true,text:parsed.text,verified:false,provider:'Workers AI',uploaded_pages:1});
  }catch{
    return failure('OCR_PROVIDER_FAILED','Workers AI 识别失败，请稍后重试',503);
  }finally{
    // Reserved requests never consume a second app quota. A provider invocation
    // consumes a slot even when it failed; validation/transport errors do not.
    if(appClaimed)await finish(env,user,day,utc,invoked);
    else await run(env.DB,'UPDATE usage_daily SET ai_reserved=MAX(0,ai_reserved-1) WHERE user_id=? AND local_day=?',user.user_id,day);
  }
}
