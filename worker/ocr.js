// Experimental Workers AI OCR adapter. Never report success for empty/ambiguous model output.
// Opt-in only; caller sees the raw suggestion and must save corrected text manually.
import { json, bad, failure, readJson } from './http.js';
const first=(db,s,...a)=>db.prepare(s).bind(...a).first();
const run=(db,s,...a)=>db.prepare(s).bind(...a).run();
const model='@cf/moondream/moondream3.1-9B-A2B';
const dayJst=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const b64=a=>{let s='';for(let i=0;i<a.length;i+=8192)s+=String.fromCharCode(...a.subarray(i,i+8192));return btoa(s);};
export async function ocrAttachment(request,env,p,id){
  const options=await readJson(request,1800);
  if(options.confirm!==true)bad('需要明确确认本次 OCR 用量','CONFIRM_REQUIRED',409);
  if(env.ENABLE_EXPERIMENTAL_OCR!=='true'||!env.AI)return failure('OCR_NOT_VERIFIED','免费日文 OCR 尚未通过真实脱敏样本测试，当前请粘贴或人工核对文字',503);
  const aid=options.attachment_id;
  if(!/^[a-f0-9]{32}$/.test(String(aid||'')))bad('请选择附件');
  const row=await first(env.DB,`SELECT o.object_key,o.bytes,o.mime,o.sha256 FROM attachments a
    JOIN storage_objects o ON o.id=a.object_id JOIN documents d ON d.id=a.document_id
    WHERE d.id=? AND d.owner_id=? AND d.lifecycle='active' AND a.id=? AND a.state='active' AND o.state='ready'`,id,p.user_id,aid);
  if(!row)bad('附件不存在','NOT_FOUND',404);
  if(!/^image\/(?:jpeg|png|webp)$/.test(row.mime)||row.bytes>1024*1024)bad('免费模型单次测试只接受 1 MB 内的优化图片','OCR_LIMIT',422);
  const day=dayJst(),limit=Math.min(3,Math.max(0,Number(env.OCR_CALLS_PER_USER_DAY||1)));
  if(limit===0)return failure('OCR_BUDGET_DISABLED','当前设定了零调用上限',503);
  await run(env.DB,'INSERT OR IGNORE INTO usage_daily(user_id,local_day) VALUES(?,?)',p.user_id,day);
  const claim=await run(env.DB,'UPDATE usage_daily SET ai_reserved=ai_reserved+1 WHERE user_id=? AND local_day=? AND ai_reserved+ai_calls<?',p.user_id,day,limit);
  if(claim.meta?.changes!==1)return failure('OCR_BUDGET_EXHAUSTED','今日免费 OCR 测试预算已用完',429);
  let response;
  try{
    const file=await env.DOCUMENTS.get(row.object_key);
    if(!file)bad('私有原件缺失','ORIGINAL_MISSING',404);
    const data=new Uint8Array(await file.arrayBuffer());
    response=await env.AI.run(model,{task:'query',image:`data:${row.mime};base64,${b64(data)}`,question:'Please transcribe all readable Japanese text verbatim, preserving line breaks, numbers and dates. Do not invent unreadable characters. Return only the transcription.',reasoning:false,temperature:0,max_tokens:1800,stream:false});
  }catch{
    await run(env.DB,'UPDATE usage_daily SET ai_calls=ai_calls+1,ai_reserved=ai_reserved-1 WHERE user_id=? AND local_day=?',p.user_id,day);
    return failure('OCR_PROVIDER_FAILED','OCR 服务无法返回结果，未修改文书；请使用人工输入',503);
  }
  await run(env.DB,'UPDATE usage_daily SET ai_calls=ai_calls+1,ai_reserved=ai_reserved-1 WHERE user_id=? AND local_day=?',p.user_id,day);
  const answer=typeof response?.answer==='string'?response.answer.trim():'';
  if(answer.length<6||!/[ぁ-んァ-ヶ一-龯]/.test(answer))return failure('OCR_EMPTY','模型没有返回可核验的日文文字，未保存任何识别结果',422);
  return json({ok:true,verified:false,needs_human_review:true,text:answer,model,warning:'模型文字只是候选。请逐一对照原图检查金额、期限和个人资料，确认后再保存。'});
}
