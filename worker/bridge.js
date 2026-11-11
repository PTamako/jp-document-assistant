// Cross-application integration is opt-in and fail-closed. Never write to another app's D1.
// All requests are authenticated server-to-server and assigned a stable idempotency key.
import { randomToken, hmacHex, isoNow, hashString } from './security.js';
import { json, bad, readJson, failure } from './http.js';
const TARGETS={finance:'kakebo',homeflow_task:'homeflow',vocabulary:'zhixue',sentence:'zhixue'};
const CONFIRMATIONS={finance:'CONFIRM_ACCOUNTING',homeflow_task:'CONFIRM_TASK',vocabulary:'CONFIRM_STUDY',sentence:'CONFIRM_STUDY'};
const first=(db,s,...a)=>db.prepare(s).bind(...a).first();
const run=(db,s,...a)=>db.prepare(s).bind(...a).run();
const trim=(s,max)=>typeof s==='string'?s.trim().slice(0,max):'';
const safeVal=(v)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
function config(env,target){
  // The operator supplies this per-deployment, never from a browser request.
  const upper=target.toUpperCase();
  const service=env[`${upper}_BRIDGE_SERVICE`];
  const secret=env[`${upper}_BRIDGE_SECRET`];
  const endpoint=env[`${upper}_BRIDGE_URL`];
  if(typeof secret!=='string'||secret.length<32)return null;
  if(!service && !(typeof endpoint==='string'&&/^https:\/\//.test(endpoint)))return null;
  let url;
  try{url=new URL(endpoint||'https://internal.invalid/api/bridge/document-assistant');}catch{return null;}
  if(url.username||url.password||url.hash||url.search||url.protocol!=='https:'||url.pathname!=='/api/bridge/document-assistant')return null;
  return {secret,url:url.href,fetcher:service?.fetch?.bind(service)||fetch};
}
async function checkedFields(env,docId){
  const rs=(await env.DB.prepare('SELECT field_key,normalized_value,review_state FROM document_fields WHERE document_id=?').bind(docId).all()).results||[];
  return new Map(rs.filter(x=>['confirmed','corrected'].includes(x.review_state)).map(x=>[x.field_key,x.normalized_value]));
}
function validatedPayload(target,item,approved,body){
  const x=JSON.parse(item.payload_json);
  if(target==='kakebo'){
    const amountText=approved.get(x.kind==='income'?'net_salary':'amount_jpy');
    const amount=Number(amountText);
    if(!safeVal(amount)||amount!==x.amount_jpy)bad('必须先核对金额；金额修改后请重新生成候选','REVIEW_REQUIRED',409);
    if(!['income','expense'].includes(x.kind))bad('信用卡还款/账单不能直接作为收支','NOT_EXPENSE',409);
    if(body.payment_confirmed!==true||!/^(?:19|20)\d\d-\d\d-\d\d$/.test(body.date||''))bad('请确认真实付款或到账日期','CONFIRM_REQUIRED',409);
    if(!trim(body.category,80)||!trim(body.payment_source,100))bad('请选择目标账本的类别与支付账户','MISSING_MAPPING',422);
    return {operation:'entry',type:x.kind,date:body.date,amount,category:trim(body.category,80),paymentSource:trim(body.payment_source,100),note:trim(body.note,180),source_kind:'document_assistant'};
  }
  if(target==='homeflow'){
    const date=approved.get('due_date');
    if(!date||date!==x.due_on)bad('截止日期未经人工核验','REVIEW_REQUIRED',409);
    if(!['private','household'].includes(body.visibility))bad('任务可见性无效');
    if(item.visibility==='private'&&body.visibility!=='private')bad('私人文书不能创建共享任务','PRIVACY_BOUNDARY',403);
    return {operation:'task',title:trim(body.title||x.title,120),dueOn:date,visibility:body.visibility,assignee:trim(body.assignee,60)||null,remindEnabled:body.remindEnabled!==false};
  }
  if(target==='zhixue'){
    if(item.candidate_kind==='sentence'){
      if(!trim(body.redacted_sentence,220))bad('请确认脱敏后的句子');
      return {operation:'sentence',language:'ja',sentence:trim(body.redacted_sentence,220),meaning_zh:trim(x.translation_zh,400)};
    }
    if(!trim(x.term,100)||!trim(x.meaning_zh,200))bad('不完整的词条不可同步');
    if(body.privacy_confirmed!==true)bad('请确认学习内容不包含个人资料','PRIVACY_CONFIRM_REQUIRED',409);
    const redacted=trim(body.redacted_term||x.term,100);
    if(/[\d０-９]{5,}|@|〒/.test(redacted))bad('学习内容疑似含私人信息','PII_WARNING',409);
    return {operation:'vocabulary',language:'ja',term:redacted,reading:trim(x.reading,100),meaning_zh:trim(x.meaning_zh,200),skip_existing:true};
  }
  bad('不支持的联动目标');
}
export async function getBridgeStatus(env,p){
  return json({targets:Object.fromEntries(['kakebo','homeflow','zhixue'].map(t=>[t,{configured:!!config(env,t),requires_explicit_confirmation:true,identity_mapping:'server_approved'}]))});
}
export async function candidatePreview(request,env,p,id){
  const item=await first(env.DB,`SELECT c.*,d.owner_id,d.lifecycle,d.visibility,d.id document_id,d.title FROM action_candidates c JOIN documents d ON d.id=c.document_id WHERE c.id=?`,id);
  if(!item||item.owner_id!==p.user_id||item.lifecycle!=='active')bad('候选不存在','NOT_FOUND',404);
  const target=TARGETS[item.candidate_kind];
  const fields=await checkedFields(env,item.document_id);
  const link=await first(env.DB,'SELECT state,remote_id,attempt_count,last_error_code FROM integration_links WHERE candidate_id=?',id);
  return json({candidate_id:id,target,kind:item.candidate_kind,payload:JSON.parse(item.payload_json),confirmed_fields:Object.fromEntries(fields),confirmation_phrase:CONFIRMATIONS[item.candidate_kind],integration:link||null,available:!!config(env,target),account_mapping_ready:false,note:'请对照原文和目标 App 账号确认。任何金额都不会因识别成功而自动记账。'});
}
export async function commitCandidate(request,env,p,id){
  const item=await first(env.DB,`SELECT c.*,d.owner_id,d.lifecycle,d.visibility,d.id document_id,d.title FROM action_candidates c JOIN documents d ON d.id=c.document_id WHERE c.id=?`,id);
  if(!item||item.owner_id!==p.user_id||item.lifecycle!=='active')bad('候选不存在','NOT_FOUND',404);
  const target=TARGETS[item.candidate_kind];
  const data=await readJson(request,9000);
  if(data.confirm!==CONFIRMATIONS[item.candidate_kind])bad('需要明确二次确认','CONFIRM_REQUIRED',409);
  const supplied=request.headers.get('Idempotency-Key');
  if(!supplied||!/^[A-Za-z0-9._:-]{8,120}$/.test(supplied))bad('需要合法 Idempotency-Key','IDEMPOTENCY_REQUIRED',400);
  const dest=config(env,target);
  if(!dest)return failure('BRIDGE_NOT_CONFIGURED','该 App 的安全联动服务尚未配置；没有写入目标 App',503);
  const fields=await checkedFields(env,item.document_id);
  const payload=validatedPayload(target,item,fields,data);
  // Explicit mapping is provisioned by the owner after independent authorization in each app.
  const mappings=env.BRIDGE_USER_MAP;
  let identities;
  try{identities=JSON.parse(mappings||'{}');}catch{identities={};}
  const remoteUser=identities[p.user_id]?.[target];
  if(!remoteUser||typeof remoteUser!=='string')return failure('ACCOUNT_NOT_LINKED','尚未完成目标账号的独立授权和身份映射；没有发送联动',403);
  const existing=await first(env.DB,'SELECT * FROM integration_links WHERE candidate_id=? AND target=?',id,target);
  if(existing?.state==='synced'||existing?.state==='linked_existing')return json({ok:true,already_synced:true,remote_id:existing.remote_id,target});
  const key=existing?.idempotency_key||`jda:${target}:${id}`;
  if(existing?.state==='sending' && Date.now()-Date.parse(existing.updated_at)<60000)return failure('SENDING','联动请求尚在处理；请一分钟后使用同一请求重试',409);
  const now=isoNow();
  if(!existing)await run(env.DB,`INSERT OR IGNORE INTO integration_links(id,candidate_id,target,idempotency_key,state,updated_at) VALUES(?,?,?,?,?,?)`,randomToken(16),id,target,key,'pending',now);
  const updated=await run(env.DB,`UPDATE integration_links SET state='sending',updated_at=?,attempt_count=attempt_count+1 WHERE candidate_id=? AND target=? AND state IN ('pending','failed','sending')`,now,id,target);
  if(updated.meta?.changes!==1)return failure('LINK_CONFLICT','联动状态发生变化，请刷新后重试',409);
  const requestPayload={source:'jp-document-assistant',source_document_id:item.document_id,source_candidate_id:id,actor_user_id:remoteUser,idempotency_key:key,payload};
  const raw=JSON.stringify(requestPayload),timestamp=String(Date.now());
  const signature=await hmacHex(dest.secret,`${timestamp}\n${raw}`);
  let answer;
  try{
    const response=await dest.fetcher(new Request(dest.url,{method:'POST',headers:{'Content-Type':'application/json','X-DA-Timestamp':timestamp,'X-DA-Signature':signature,'Idempotency-Key':key},body:raw}));
    answer=await response.json().catch(()=>({}));
    if(!response.ok||!answer?.ok||typeof answer.remote_id!=='string'||!answer.remote_id)throw new Error('BRIDGE_RESPONSE_FAILED');
  }catch{
    // The target may have committed while the reply was lost; always retry with the SAME key.
    await run(env.DB,"UPDATE integration_links SET state='failed',last_error_code='BRIDGE_UNCONFIRMED',updated_at=? WHERE candidate_id=? AND target=?",isoNow(),id,target);
    return failure('BRIDGE_UNCONFIRMED','目标应用可能已收到请求但尚未确认结果。请重试同一候选（不会换幂等键）',503);
  }
  await run(env.DB,"UPDATE integration_links SET state='synced',remote_id=?,synced_at=?,last_error_code=NULL,updated_at=? WHERE candidate_id=? AND target=?",answer.remote_id,isoNow(),isoNow(),id,target);
  return json({ok:true,target,remote_id:answer.remote_id,reused:!!answer.reused});
}
