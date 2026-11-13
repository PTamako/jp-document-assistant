import {hashString,isoNow} from './security.js';
import {analyzeDocumentAi,getDocumentAiCache} from './intelligence.js';

const MAX_AUTO_ATTEMPTS=2; // initial call + one transient 5xx/network retry
const STALE_RUNNING_MS=120000;
const RETRY_BASE_MS=90000;
const active=new Set();
const get=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const run=(db,sql,...args)=>db.prepare(sql).bind(...args).run();
const validProvider=p=>p==='gemini'||p==='cloudflare';
// Never automatically spend another scarce free request on an ambiguous
// network/timeout failure. A user may retry explicitly after checking status.
const retryable=new Set(['gemini_service_overloaded','gemini_service_unavailable','gemini_retry_cooldown']);
const finalStates=new Set(['success','cached']);

export async function enqueueDocumentAi(env,doc){
  const provider=doc.ai_provider||'none';
  if(!validProvider(provider))return {ai_status:'rules_only'};
  if(!doc.extracted_text_ja)return {ai_status:'awaiting_text'};
  if(provider==='gemini'&&!doc.ai_consent_at)return {ai_status:'privacy_blocked'};
  if(doc.extracted_text_ja.length>9000)return {ai_status:'too_long'};
  const cached=await getDocumentAiCache(env.DB,doc);
  if(cached?.status==='success')return {ai_status:'cached'};
  const now=isoNow(),hash=await hashString(doc.extracted_text_ja);
  const old=await get(env.DB,'SELECT * FROM document_ai_jobs WHERE document_id=?',doc.id);
  if(!old){
    const inserted=await run(env.DB,`INSERT OR IGNORE INTO document_ai_jobs(document_id,provider,source_sha,state,attempts,next_attempt_at,updated_at)
       VALUES(?,?,?,'queued',0,?,?)`,doc.id,provider,hash,now,now);
    if(inserted.meta?.changes===1)return {ai_status:'queued'};
  }
  const changed=await run(env.DB,`UPDATE document_ai_jobs SET provider=?,source_sha=?,state='queued',attempts=0,
      next_attempt_at=?,started_at=NULL,updated_at=?,last_error=NULL
      WHERE document_id=? AND (
         provider<>? OR source_sha<>? OR state IN ('done','failed')
      )`,provider,hash,now,now,doc.id,provider,hash);
  return {ai_status:changed.meta?.changes===1?'queued':'in_progress'};
}

export async function getDocumentAiJob(db,id,doc=null){
  const job=await get(db,'SELECT state,attempts,next_attempt_at,last_error,provider,source_sha FROM document_ai_jobs WHERE document_id=?',id);
  if(!job)return null;
  // A previous provider/source must never masquerade as the currently selected AI job.
  if(doc&&(job.provider!==(doc.ai_provider||'none')||!doc.extracted_text_ja||
      job.source_sha!==await hashString(doc.extracted_text_ja)))return null;
  return {state:job.state,attempts:job.attempts,next_attempt_at:job.next_attempt_at,last_error:job.last_error};
}

async function finish(db,id,attempts,sourceSha,state,error=null,at=isoNow()){
  await run(db,`UPDATE document_ai_jobs SET state=?,next_attempt_at=?,last_error=?,updated_at=?
    WHERE document_id=? AND state='running' AND attempts=? AND source_sha=?`,
    state,at,error,isoNow(),id,attempts,sourceSha);
}

export async function processDocumentAiJob(env,id){
  if(active.has(id))return {ai_status:'in_progress'};
  active.add(id);
  try{
    const now=isoNow();
    const claim=await run(env.DB,`UPDATE document_ai_jobs SET state='running',attempts=attempts+1,
       started_at=?,updated_at=? WHERE document_id=? AND state IN ('queued','retry_wait')
       AND next_attempt_at<=?`,now,now,id,now);
    if(claim.meta?.changes!==1)return {ai_status:'in_progress'};
    const job=await get(env.DB,'SELECT * FROM document_ai_jobs WHERE document_id=?',id);
    const doc=await get(env.DB,`SELECT id,category,ai_provider,ai_consent_at,extracted_text_ja
       FROM documents WHERE id=? AND lifecycle='active'`,id);
    if(!doc||doc.ai_provider!==job.provider||!doc.extracted_text_ja||
       await hashString(doc.extracted_text_ja)!==job.source_sha){
      await finish(env.DB,id,job.attempts,job.source_sha,'failed','stale_or_deleted');
      return {ai_status:'stale_or_deleted'};
    }
    let result;
    try{result=await analyzeDocumentAi(env,doc);}
    catch{result={ai_status:'provider_failed'};}
    // An old result may have arrived after source edit or provider switch.
    const status=result.ai_status;
    if(finalStates.has(status)){
      await finish(env.DB,id,job.attempts,job.source_sha,'done');
    }else if(retryable.has(status)&&job.attempts<MAX_AUTO_ATTEMPTS){
      const jitter=Math.floor(Math.random()*15000);
      const delay=status==='gemini_retry_cooldown'
        ?Math.max(RETRY_BASE_MS,(result.retry_after_seconds||60)*1000):RETRY_BASE_MS;
      await finish(env.DB,id,job.attempts,job.source_sha,'retry_wait',status,
        new Date(Date.now()+delay+jitter).toISOString());
    }else{
      await finish(env.DB,id,job.attempts,job.source_sha,'failed',status);
    }
    return result;
  }finally{active.delete(id);}
}

export async function runDueDocumentAiJobs(env){
  const now=isoNow(),stale=new Date(Date.now()-STALE_RUNNING_MS).toISOString();
  // Process once per cron, avoiding a stuck 'running' state after a Worker timeout.
  await run(env.DB,`UPDATE document_ai_jobs SET state='queued',next_attempt_at=?,updated_at=?
    WHERE state='running' AND updated_at<? AND attempts<2`,now,now,stale);
  await run(env.DB,`UPDATE document_ai_jobs SET state='failed',last_error='processing_timeout',updated_at=?
    WHERE state='running' AND updated_at<? AND attempts>=2`,now,stale);
  const rows=(await env.DB.prepare(`SELECT document_id FROM document_ai_jobs
     WHERE state IN ('queued','retry_wait') AND next_attempt_at<=?
     ORDER BY next_attempt_at LIMIT 2`).bind(now).all()).results||[];
  for(const row of rows)await processDocumentAiJob(env,row.document_id);
  return rows.length;
}
