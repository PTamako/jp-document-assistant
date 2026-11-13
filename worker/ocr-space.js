import {json,failure,readJson,bad} from './http.js';
import {randomToken,isoNow} from './security.js';
const first=(db,s,...a)=>db.prepare(s).bind(...a).first();
const run=(db,s,...a)=>db.prepare(s).bind(...a).run();
const MODEL='ocr-space-engine3',VER='v1-20261112';
export function parseOcrSpaceResult(data){
 if(data?.IsErroredOnProcessing||![1,2].includes(Number(data?.OCRExitCode)))return null;
 const pages=Array.isArray(data.ParsedResults)?data.ParsedResults:[];
 if(!pages.length||pages.length>3)return null;
 const found=pages.map((p,i)=>({page:i+1,content:Number(p.FileParseExitCode)===1&&typeof p.ParsedText==='string'?p.ParsedText.trim():''})).filter(x=>x.content);
 if(!found.length||!found.some(x=>/[ぁ-んァ-ン一-龯々]/.test(x.content)))return null;
 const text=found.map(x=>'【扫描第 '+x.page+' 页】\n'+x.content).join('\n\n');
 return text.length<=100000?text:null;
}
export async function ocrSpaceAttachment(request,env,p,documentId){
 const body=await readJson(request,1200);
 if(body.confirm_ocr_space!==true||body.confirm_private_upload!==true)
  bad('必须确认将本张图片／PDF 发送至 OCR.space 免费识别服务','OCR_CONSENT_REQUIRED',409);
 if(!env.OCR_SPACE_API_KEY||env.OCR_SPACE_FREE_ONLY_CONFIRMED!=='true')
  return failure('OCR_SPACE_NOT_CONFIGURED','免费 OCR.space 密钥或免费层确认尚未配置，未发送文件',503);
 const aid=String(body.attachment_id||'');
 if(!/^[a-f0-9]{32}$/.test(aid))bad('请选择附件','INVALID_ATTACHMENT',400);
 const row=await first(env.DB,"SELECT o.id object_id,o.object_key,o.bytes,o.mime,o.sha256 FROM documents d JOIN attachments a ON d.id=a.document_id JOIN storage_objects o ON o.id=a.object_id WHERE d.id=? AND d.owner_id=? AND d.lifecycle='active' AND a.id=? AND a.state='active' AND o.state='ready'",
  documentId,p.user_id,aid);
 if(!row)return failure('NOT_FOUND','当前文书的原件不存在',404);
 if(row.bytes>1024*1024||!['application/pdf','image/jpeg','image/png','image/webp'].includes(row.mime))
  return failure('OCR_SPACE_LIMIT','免费方案每份最多 1MB，仅支持 PDF / JPEG / PNG / WebP；PDF 最多三页',422);
 const cached=await first(env.DB,'SELECT * FROM ocr_attempts WHERE owner_id=? AND object_id=? AND model_id=? AND prompt_version=?',
  p.user_id,row.object_id,MODEL,VER);
 if(cached?.state==='success')return json({ok:true,verified:false,cached:true,text:cached.candidate_text_ja,
  warning:'云端识别文字未经确认，不会自动创建记账或待办'});
 // A temporary failure must not permanently poison an object's OCR cache.
 // Successful recognition is always reused; failed recognition gets ONE
 // explicitly triggered retry with a five-minute cooldown and daily budget.
 const age=Date.now()-Date.parse(cached?.updated_at||'');
 if(cached?.state==='pending'&&(!Number.isFinite(age)||age<24*60*60*1000))
  return failure('OCR_IN_PROGRESS','这份原件的 OCR 请求仍在处理；没有重复调用',409);
 if(cached?.state==='pending'&&body.retry_stale!==true)
  return failure('OCR_PENDING_STALE','上次请求已超过24小时；请明确选择重试',409);
 if(cached&&Number(cached.attempt_count||1)>=2)
  return failure('OCR_SPACE_RETRY_LIMIT','同一原件最多调用两次 OCR.space；请手动核对原文',409);
 if(cached&&['failed','empty'].includes(cached.state)&&
    (!Number.isFinite(age)||age<5*60*1000))
  return failure('OCR_SPACE_RETRY_COOLDOWN','上次 OCR 失败，五分钟后可手动重试',429);
 if(cached&&!['failed','empty','pending'].includes(cached.state))
  return failure('OCR_IN_PROGRESS','这份原件的 OCR 请求状态待核对',409);
 const utc=new Date().toISOString().slice(0,10),rawLimit=Number(env.OCR_SPACE_APP_UTC_DAILY_LIMIT??20);
 const limit=Number.isSafeInteger(rawLimit)?Math.min(30,Math.max(0,rawLimit)):0;
 if(!limit)return failure('OCR_BUDGET_DISABLED','本应用的云端 OCR 预算已关闭',503);
 const now=isoNow();
 await run(env.DB,'INSERT OR IGNORE INTO ocr_space_utc_daily(day_utc) VALUES(?)',utc);
 const quota=await run(env.DB,'UPDATE ocr_space_utc_daily SET calls=calls+1 WHERE day_utc=? AND calls<?',utc,limit);
 if(quota.meta?.changes!==1)
  return failure('OCR_BUDGET_EXHAUSTED','本应用今日免费云端 OCR 次数已达到限制',429);
 let claim;
 try{
  claim=cached
   ?await run(env.DB,`UPDATE ocr_attempts SET state='pending',attempt_count=attempt_count+1,
      candidate_text_ja=NULL,updated_at=? WHERE id=? AND owner_id=? AND object_id=?
      AND model_id=? AND prompt_version=? AND updated_at=? AND attempt_count<2
      AND state IN ('failed','empty','pending')`,
      now,cached.id,p.user_id,row.object_id,MODEL,VER,cached.updated_at)
   :await run(env.DB,"INSERT OR IGNORE INTO ocr_attempts(id,owner_id,object_id,model_id,prompt_version,state,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)",
      randomToken(16),p.user_id,row.object_id,MODEL,VER,now,now);
 }catch{
  await run(env.DB,'UPDATE ocr_space_utc_daily SET calls=MAX(0,calls-1) WHERE day_utc=?',utc);
  return failure('OCR_CACHE_FAILED','无法安全记录 OCR 请求，因此没有发送原件',503);
 }
 if(claim.meta?.changes!==1){
  // Concurrent callers must never issue duplicate OCR calls or spend quota.
  await run(env.DB,'UPDATE ocr_space_utc_daily SET calls=MAX(0,calls-1) WHERE day_utc=?',utc);
  return failure('OCR_IN_PROGRESS','这份原件已有识别请求；没有重复调用',409);
 }
 try{
  const object=await env.DOCUMENTS.get(row.object_key);
  if(!object)throw Error('ORIGINAL_MISSING');
  const bytes=new Uint8Array(await object.arrayBuffer());
  if(bytes.length!==row.bytes)throw Error('ORIGINAL_CHANGED');
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))]
    .map(x=>x.toString(16).padStart(2,'0')).join('');
  if(digest!==row.sha256)throw Error('ORIGINAL_MISMATCH');
  const form=new FormData();
  form.append('file',new Blob([bytes],{type:row.mime}),'document.'+({ 'application/pdf':'pdf','image/jpeg':'jpg','image/png':'png','image/webp':'webp' }[row.mime]));
  form.append('OCREngine','3');form.append('language','auto');form.append('scale','true');
  const response=await (env.OCR_SPACE_FETCH||fetch)('https://api.ocr.space/parse/image',{
   method:'POST',headers:{apikey:env.OCR_SPACE_API_KEY},body:form,
   signal:AbortSignal.timeout(25000)
  });
  if(!response.ok)throw Error('OCR_PROVIDER_FAILED');
  const parsed=parseOcrSpaceResult(await response.json());
  if(!parsed)throw Error('OCR_RESULT_EMPTY');
  await run(env.DB,"UPDATE ocr_attempts SET state='success',candidate_text_ja=?,updated_at=? WHERE owner_id=? AND object_id=? AND model_id=?",
   parsed,isoNow(),p.user_id,row.object_id,MODEL);
  return json({ok:true,verified:false,cached:false,text:parsed,
   warning:'内容由第三方免费 OCR 返回，仅用于人工核对；不会自动写入三个 App'});
 }catch{
  await run(env.DB,"UPDATE ocr_attempts SET state='failed',updated_at=? WHERE owner_id=? AND object_id=? AND model_id=?",
   isoNow(),p.user_id,row.object_id,MODEL);
  return failure('OCR_SPACE_FAILED','云端 OCR 未得到可验证文字，原文没有被修改，也不会自动重试',503);
 }
}
