import { json, bad, failure, readJson } from './http.js';
import { randomToken, isoNow } from './security.js';

// Experimental OCR is OFF by default and returns ONLY private, unverified suggestions.
// Same-owner same-R2-object requests share one attempt record; no public image URLs.
const dbFirst=(db,s,...a)=>db.prepare(s).bind(...a).first();
const dbRun=(db,s,...a)=>db.prepare(s).bind(...a).run();
export const OCR_MODEL='@cf/moondream/moondream3.1-9B-A2B';
export const OCR_PROMPT_VERSION='verbatim-20261111-v2';
const todayJst=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const encoded=bytes=>{
 let out='';for(let i=0;i<bytes.length;i+=8192)out+=String.fromCharCode(...bytes.subarray(i,i+8192));
 return btoa(out);
};
const shaHex=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))]
 .map(x=>x.toString(16).padStart(2,'0')).join('');
const safeNum=x=>Number.isFinite(x)&&x>=0?Number(x):null;
export function normalizeOcrOutput(raw){
 const data=raw&&typeof raw==='object'&&raw.result&&typeof raw.result==='object'?raw.result:raw;
 const answer=typeof data?.answer==='string'?data.answer.trim():'';
 const metrics=data?.metrics&&typeof data.metrics==='object'?data.metrics:{};
 const input=safeNum(metrics.input_tokens),output=safeNum(metrics.output_tokens);
 const estimated=input!==null&&output!==null?
  Math.round((input*27273+output*90909)/10000)/100:null;
 // Never return arbitrary provider content or diagnostic data that might contain PII.
 const shape=data&&typeof data==='object'?
  Object.keys(data).filter(k=>/^[a-z_]{1,30}$/i.test(k)).slice(0,12).join(','):'non_object';
 return {text:answer,input_tokens:input,output_tokens:output,neurons_estimated:estimated,shape};
}
const cacheQuery=`SELECT * FROM ocr_attempts WHERE owner_id=? AND object_id=? AND model_id=? AND prompt_version=?`;
async function updateState(db,p,row,state,text,normalized){
 await dbRun(db,`UPDATE ocr_attempts SET state=?,candidate_text_ja=?,input_tokens=?,output_tokens=?,
   neurons_estimated=?,provider_shape=?,updated_at=? WHERE owner_id=? AND object_id=? AND model_id=? AND prompt_version=?`,
   state,text,normalized?.input_tokens??null,normalized?.output_tokens??null,
   normalized?.neurons_estimated??null,normalized?.shape??null,isoNow(),p.user_id,row.object_id,
   OCR_MODEL,OCR_PROMPT_VERSION);
}
const badReply='视觉模型未返回可验证的日文内容，已记录结果避免重复调用，请手动输入；不会编造识别文字。';
export async function ocrAttachment(request,env,p,id){
 const options=await readJson(request,1800);
 if(options.confirm!==true)bad('必须明确确认 OCR 可能消耗账户共享免费额度','CONFIRM_REQUIRED',409);
 const attachmentId=String(options.attachment_id||'');
 if(!/^[a-f0-9]{32}$/.test(attachmentId))bad('请选择图片附件');
 const row=await dbFirst(env.DB,`SELECT o.id object_id,o.object_key,o.bytes,o.mime,o.sha256 FROM attachments a
   JOIN storage_objects o ON o.id=a.object_id JOIN documents d ON d.id=a.document_id
   WHERE d.id=? AND d.owner_id=? AND d.lifecycle='active' AND a.id=? AND a.state='active' AND o.state='ready'`,
   id,p.user_id,attachmentId);
 if(!row)bad('私人图片不存在','NOT_FOUND',404);
 if(!/^image\/(?:jpeg|png|webp)$/.test(row.mime)||row.bytes>1024*1024)
   bad('免费 OCR 单张图片仅接受已压缩到 1MB 以内的 JPEG/PNG/WebP','OCR_LIMIT',422);
 // Check D1 first. Cached hit MUST NOT touch either R2 or Workers AI.
 const existing=await dbFirst(env.DB,cacheQuery,p.user_id,row.object_id,OCR_MODEL,OCR_PROMPT_VERSION);
 if(existing?.state==='success')return json({ok:true,verified:false,cached:true,needs_human_review:true,
   text:existing.candidate_text_ja,model:OCR_MODEL,
   usage:{input_tokens:existing.input_tokens,output_tokens:existing.output_tokens,
    neurons_estimated:existing.neurons_estimated,source:'cached_estimate'},
   warning:'已复用私有 OCR 候选；没有再次请求 AI 或原图。请对照原件确认。'});
 if(existing?.state==='empty')return failure('OCR_EMPTY_CACHED',badReply,422);
 if(existing?.state==='pending')return failure('OCR_IN_PROGRESS','该文件已有识别任务处理中；未发送重复请求',409);
 if(existing?.state==='failed'&&Date.now()-Date.parse(existing.updated_at)<60*60000)
   return failure('OCR_RETRY_PAUSED','模型上次调用失败，为保护免费额度一小时内不重复尝试',429);
 if(env.ENABLE_EXPERIMENTAL_OCR!=='true'||!env.AI)
   return failure('OCR_NOT_VERIFIED','免费日文 OCR 尚未通过真实脱敏样本验收，请人工输入/修改文字',503);
 const day=todayJst(),limit=Math.min(3,Math.max(0,Number(env.OCR_CALLS_PER_USER_DAY||1)));
 if(limit===0)return failure('OCR_BUDGET_DISABLED','OCR 免费调用预算已设为零',503);
 await dbRun(env.DB,'INSERT OR IGNORE INTO usage_daily(user_id,local_day) VALUES(?,?)',p.user_id,day);
 const quota=await dbRun(env.DB,`UPDATE usage_daily SET ai_reserved=ai_reserved+1 WHERE user_id=? AND local_day=?
   AND ai_calls+ai_reserved<?`,p.user_id,day,limit);
 if(quota.meta?.changes!==1)
   return failure('OCR_BUDGET_EXHAUSTED','今天此 App 的 OCR 尝试预算已用完；Cloudflare 整个账号剩余额度未知',429);
 const now=isoNow();
 try{
   const claimed=existing?
    await dbRun(env.DB,`UPDATE ocr_attempts SET state='pending',candidate_text_ja=NULL,
      attempt_count=attempt_count+1,updated_at=? WHERE id=? AND state='failed' AND updated_at=?`,
      now,existing.id,existing.updated_at):
    await dbRun(env.DB,`INSERT OR IGNORE INTO ocr_attempts
      (id,owner_id,object_id,model_id,prompt_version,state,created_at,updated_at)
      VALUES(?,?,?,?,?,'pending',?,?)`,randomToken(16),p.user_id,row.object_id,OCR_MODEL,OCR_PROMPT_VERSION,now,now);
   if(claimed.meta?.changes!==1){
     await dbRun(env.DB,'UPDATE usage_daily SET ai_reserved=MAX(0,ai_reserved-1) WHERE user_id=? AND local_day=?',p.user_id,day);
     return failure('OCR_IN_PROGRESS','该图片已有识别记录；未发起重复模型请求',409);
   }
 }catch{
   await dbRun(env.DB,'UPDATE usage_daily SET ai_reserved=MAX(0,ai_reserved-1) WHERE user_id=? AND local_day=?',p.user_id,day);
   return failure('OCR_CACHE_FAILED','无法保证 AI 去重，因此没有发起模型请求',503);
 }
 let invoked=false,response=null;
 try{
   const file=await env.DOCUMENTS.get(row.object_key);
   if(!file)throw new Error('ORIGINAL_MISSING');
   const bytes=new Uint8Array(await file.arrayBuffer());
   if(bytes.length!==row.bytes||await shaHex(bytes)!==row.sha256)throw new Error('ORIGINAL_MISMATCH');
   invoked=true;
   response=await env.AI.run(OCR_MODEL,{
     task:'query',image:`data:${row.mime};base64,${encoded(bytes)}`,
     question:'Transcribe all legible Japanese document text verbatim, preserving printed line breaks, dates and prices. For unreadable portions write [不明]. Do not invent any missing text.',
     reasoning:false,temperature:0,max_tokens:1500,stream:false
   });
 }catch{
   await updateState(env.DB,p,row,'failed',null,null);
   await dbRun(env.DB,`UPDATE usage_daily SET ai_calls=ai_calls+?,ai_reserved=MAX(0,ai_reserved-1)
     WHERE user_id=? AND local_day=?`,invoked?1:0,p.user_id,day);
   return failure(invoked?'OCR_PROVIDER_FAILED':'OCR_ORIGINAL_INVALID',
     invoked?'模型没有返回结果；未修改文书，已保存失败状态防止重复耗费。':'原图缺失或哈希校验失败，未调用模型。',503);
 }
 const parsed=normalizeOcrOutput(response);
 const valid=parsed.text.length>=6&&parsed.text.length<=12000&&/[ぁ-んァ-ヶ一-龯々]/.test(parsed.text);
 // This cache holds an unverified suggestion, never a confirmed field.
 await updateState(env.DB,p,row,valid?'success':'empty',valid?parsed.text:null,parsed);
 await dbRun(env.DB,`UPDATE usage_daily SET ai_calls=ai_calls+1,ai_reserved=MAX(0,ai_reserved-1)
   WHERE user_id=? AND local_day=?`,p.user_id,day);
 if(!valid)return failure('OCR_EMPTY',badReply,422);
 return json({ok:true,verified:false,needs_human_review:true,cached:false,
   text:parsed.text,model:OCR_MODEL,
   usage:{input_tokens:parsed.input_tokens,output_tokens:parsed.output_tokens,
     neurons_estimated:parsed.neurons_estimated,source:'model_metrics_estimate'},
   warning:'OCR 仅是候选文字，不能自动创建收入、支出或待办；请对照原件人工保存。'});
}
