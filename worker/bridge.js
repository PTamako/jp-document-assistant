// Cross-application integration is opt-in and fail-closed. Never write to another app's D1.
// All requests are authenticated server-to-server and assigned a stable idempotency key.
import { randomToken, hmacHex, isoNow, hashString } from './security.js';
import { inferSbiInvestmentKind } from '../shared/sbi-investment.js';
import { json, bad, readJson, failure } from './http.js';
const TARGETS={finance:'kakebo',homeflow_task:'homeflow',vocabulary:'zhixue',sentence:'zhixue'};
const CONFIRMATIONS={finance:'CONFIRM_ACCOUNTING',homeflow_task:'CONFIRM_TASK',vocabulary:'CONFIRM_STUDY',sentence:'CONFIRM_STUDY'};
const first=(db,s,...a)=>db.prepare(s).bind(...a).first();
const run=(db,s,...a)=>db.prepare(s).bind(...a).run();
const trim=(s,max)=>typeof s==='string'?s.trim().slice(0,max):'';
const safeVal=(v)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
function authorizedMapping(env,userId,target){
  let all={};try{all=JSON.parse(env.BRIDGE_USER_MAP||'{}');}catch{}
  const id=all?.[userId]?.[target];
  return typeof id==='string'&&id.length>=1&&id.length<=100?id:null;
}
function config(env,target){
  // The operator supplies this per-deployment, never from a browser request.
  const upper=target.toUpperCase();
  const service=env[`${upper}_BRIDGE_SERVICE`];
  const secret=env[`${upper}_BRIDGE_SECRET`];
  const endpoint=env[`${upper}_BRIDGE_URL`];
  if(typeof secret!=='string'||secret.length<32)return null;
  if(!service && !(typeof endpoint==='string'&&/^https:\/\//.test(endpoint)))return null;
  let url;
  // A Service Binding dispatches to the private Worker directly. Never
  // route that request through a pages.dev hostname even if a legacy URL is configured.
  try{url=new URL(service?.fetch?'https://internal.invalid/api/bridge/document-assistant':endpoint);}catch{return null;}
  if(url.username||url.password||url.hash||url.search||url.protocol!=='https:'||url.pathname!=='/api/bridge/document-assistant')return null;
  return {secret,url:url.href,fetcher:service?.fetch?.bind(service)||fetch};
}
// Only show safe, predefined error categories returned by the target.
// 5xx and network failures are still unknown-outcome writes.
const KAKEBO_REJECTIONS={
 bridge_disabled:['TARGET_BRIDGE_DISABLED','家計簿未开启文书助手联动，本次没有记账'],
 bridge_not_configured:['TARGET_BRIDGE_NOT_CONFIGURED','家計簿联动密钥未配置，本次没有记账'],
 invalid_signature:['TARGET_INVALID_SIGNATURE','家計簿拒绝签名，请核对两端密钥，本次没有记账'],
 expired_signature:['TARGET_EXPIRED_SIGNATURE','家計簿拒绝过期请求，本次没有记账'],
 actor_not_allowed:['TARGET_ACTOR_NOT_ALLOWED','家計簿未授权当前账号映射，本次没有记账'],
 invalid_source:['TARGET_INVALID_SOURCE','家計簿拒绝联动来源或幂等键，本次没有记账'],
 invalid_entry:['TARGET_INVALID_ENTRY','家計簿拒绝日期、金额或分类，本次没有记账'],
 merchant_confirmation_required:['TARGET_MERCHANT_CONFIRMATION','请先在文书中确认商家或付款方，本次没有记账'],
 category_not_registered:['TARGET_CATEGORY_CHANGED','家計簿分类已更新，请重新选择分类，本次没有记账'],
 invalid_text:['TARGET_INVALID_TEXT','家計簿拒绝了文字字段，本次没有记账'],
 payment_source_missing:['TARGET_PAYMENT_SOURCE_MISSING','家計簿没有登记该支付方式，本次没有记账'],
 payment_source_invalid:['TARGET_PAYMENT_SOURCE_INVALID','家計簿支付方式无效，本次没有记账'],
 payment_source_archived:['TARGET_PAYMENT_SOURCE_ARCHIVED','家計簿支付方式已归档，本次没有记账'],
 duplicate_candidate:['TARGET_DUPLICATE_CANDIDATE','家計簿可能已有同店、同金额、同卡且时间相近的明细；未重复写入，请核对']
};
export function classifyBridgeRejection(target,status,body){
 if(target!=='kakebo'||!Number.isInteger(status)||status<400||status>=500)return null;
 const code=typeof body?.error==='string'?body.error:'';
 const known=Object.prototype.hasOwnProperty.call(KAKEBO_REJECTIONS,code)?KAKEBO_REJECTIONS[code]:null;
 const fallback={
  400:['TARGET_BAD_REQUEST','家計簿拒绝了请求，本次没有记账'],
  401:['TARGET_AUTH_FAILED','家計簿身份验证失败，本次没有记账'],
  403:['TARGET_FORBIDDEN','家計簿拒绝当前账号权限，本次没有记账'],
  404:['TARGET_ENDPOINT_DISABLED','家計簿联动接口不存在或尚未启用，本次没有记账'],
  409:['TARGET_CONFLICT','家計簿拒绝了重复或冲突记录，请核对明细'],
  429:['TARGET_RATE_LIMITED','家計簿联动频率受限，本次没有记账']
 };
 const value=known||fallback[status]||['TARGET_REJECTED','家計簿拒绝此次请求，本次没有记账'];
 return {code:value[0],message:value[1],status};
}

// Only a signed read-only lookup may release an old failed fingerprint.
// Never assume a timeout means the target ledger did not commit.
async function lookupKakeboIdempotency(dest,{key,actor,documentId,candidateId,operation='lookup'}){
 const payload={source:'jp-document-assistant',source_document_id:documentId,
  source_candidate_id:candidateId,actor_user_id:actor,idempotency_key:key,
  payload:{operation}};
 const raw=JSON.stringify(payload),timestamp=String(Date.now());
 try{
  const signature=await hmacHex(dest.secret,timestamp+'\n'+raw);
  const response=await dest.fetcher(new Request(dest.url,{method:'POST',
   headers:{'Content-Type':'application/json','X-DA-Timestamp':timestamp,
    'X-DA-Signature':signature,'Idempotency-Key':key},body:raw}));
  const data=await response.json().catch(()=>null);
  if(!response.ok||data?.ok!==true||typeof data.exists!=='boolean')return null;
  if(data.exists&&(!data.remote_id||typeof data.remote_id!=='string'))return null;
  return {exists:data.exists,remoteId:data.remote_id||null,
    recordState:['active','trashed','missing'].includes(data.record_state)?data.record_state:null};
 }catch{return null;}
}

async function checkedFields(env,docId){
  const rs=(await env.DB.prepare('SELECT field_key,normalized_value,review_state FROM document_fields WHERE document_id=?').bind(docId).all()).results||[];
  return new Map(rs.filter(x=>['confirmed','corrected'].includes(x.review_state)).map(x=>[x.field_key,x.normalized_value]));
}
function ledgerEntryType(x,merchant=x.merchant){
  if(['expense','transfer'].includes(x.kind)&&inferSbiInvestmentKind(merchant))return 'transfer';
  return x.kind;
}
export function validatedPayload(target,item,approved,body){
  const x=JSON.parse(item.payload_json);
  if(target==='kakebo'){
    const amountText=approved.get(x.kind==='income'?'net_salary':'amount_jpy');
    const amount=Number(amountText);
    if(!safeVal(amount)||amount!==x.amount_jpy)bad('必须先核对金额；金额修改后请重新生成候选','REVIEW_REQUIRED',409);
    if(body.payment_confirmed!==true||!/^(?:19|20)\d\d-\d\d-\d\d$/.test(body.date||''))bad('请确认真实付款或到账日期','CONFIRM_REQUIRED',409);
    if(!trim(body.category,80)||!trim(body.payment_source,100))bad('请选择目标账本的类别与支付账户','MISSING_MAPPING',422);
    // Reviewed source fields take precedence; do not trust browser-supplied
    // entry types, merchants or investment purposes.
    const merchant=trim(approved.get('merchant')||x.merchant,100);
    const type=ledgerEntryType(x,merchant);
    if(!['income','expense','transfer'].includes(type))bad('不支持的财务联动类型','INVALID_ENTRY_TYPE',409);
    const purpose=inferSbiInvestmentKind(merchant);
    if(type==='transfer'&&(!purpose||trim(body.category,80)!=='投資・資産移動'))
      bad('证券资金转移必须使用正确的投资类型与资产转移分类','INVALID_TRANSFER',422);
    const transferDate=type==='transfer'?trim(body.transfer_date,10):'';
    if(type==='transfer'&&(!/^(?:19|20)\d\d-\d\d-\d\d$/.test(transferDate)||
      !Number.isFinite(Date.parse(transferDate+'T00:00:00Z'))||
      new Date(transferDate+'T00:00:00Z').toISOString().slice(0,10)!==transferDate))
      bad('请先确认 SBI 证券资金实际生效日','TRANSFER_DATE_REQUIRED',422);
    const approvedTimestamp=String(approved.get('transaction_at')||'');
    const time=approvedTimestamp.slice(0,10)===body.date&&
      /^\d{4}-\d\d-\d\d (?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(approvedTimestamp)
      ?approvedTimestamp.slice(11,16):'';
    return {operation:'entry',type,date:body.date,time,amount,category:trim(body.category,80),
      paymentSource:trim(body.payment_source,100),merchant,note:trim(body.note,180),
      ...(type==='transfer'?{transferTarget:'sbi',transferDate,sbiPurpose:purpose}:{}),
      source_kind:'document_assistant'};
  }
  if(target==='homeflow'){
    const dateField=x.task_type==='delivery'?'event_date':'due_date';
    const date=approved.get(dateField);
    if(!date||date!==x.due_on)bad(dateField==='event_date'?'配送日期未经人工核验':'截止日期未经人工核验','REVIEW_REQUIRED',409);
    if(x.task_type==='delivery'){
      const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      if(date<today)bad('配送日期已过期，不允许创建过期配送待办','DELIVERY_DATE_PASSED',409);
    }
    if(!['private','household'].includes(body.visibility))bad('任务可见性无效');
    // Only a deliberately confirmed task is shared. The source document,
    // attachments and original text stay private in the document app.
    if(item.visibility==='private'&&body.visibility==='household'&&body.task_share_confirmed!==true)
      bad('私人文书生成家庭共享任务，需要确认共享任务信息','TASK_SHARE_CONFIRM_REQUIRED',409);
    const bonusPoints=body.bonus_points===undefined?0:Number(body.bonus_points);
    if(!Number.isSafeInteger(bonusPoints)||bonusPoints<0||bonusPoints>10000)bad('额外任务积分必须是 0～10000 的整数','INVALID_BONUS',400);
    return {operation:'task',title:trim(body.title||x.title,120),dueOn:date,visibility:body.visibility,assignee:trim(body.assignee,60)||null,bonusPoints,remindEnabled:body.remindEnabled!==false};
  }
  if(target==='zhixue'){
    if(item.candidate_kind==='sentence'){
      const redacted=trim(body.redacted_sentence,220);
      if(!redacted||!trim(x.translation_zh,400))bad('请确认完整的脱敏日文句子和中文翻译','INVALID_SENTENCE',400);
      if(body.privacy_confirmed!==true)bad('请确认句子不包含个人资料','PRIVACY_CONFIRM_REQUIRED',409);
      if(/[\\d０-９]{5,}|@|〒|\\n/.test(redacted))bad('句子疑似包含私人信息，请先脱敏','PII_WARNING',409);
      return {operation:'sentence',language:'ja',sentence:redacted,meaning_zh:trim(x.translation_zh,400),privacy_confirmed:true,skip_existing:true};
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
  return json({targets:Object.fromEntries(['kakebo','homeflow','zhixue'].map(t=>[t,{configured:!!config(env,t),account_mapping_ready:!!authorizedMapping(env,p.user_id,t),requires_explicit_confirmation:true,identity_mapping:'server_approved'}]))});
}
// Load only live catalogue labels; do not expose account numbers, balances,
// transaction history, or the identity mapping through this endpoint.
export async function ledgerPickerOptions(env,userId,kind,merchant='',recognizedPayment=''){
 const dest=config(env,'kakebo'),actor=authorizedMapping(env,userId,'kakebo');
 if(!dest)return {error:'家計簿安全联动尚未配置'};
 if(!actor)return {error:'家計簿账号尚未完成授权映射'};
 if(!['income','expense','transfer'].includes(kind))return {error:'不支持的记账类型'};
 const body=JSON.stringify({source:'jp-document-assistant',actor_user_id:actor,
  payload:{operation:'options',entryType:kind,merchant:String(merchant||'').slice(0,100),
    recognizedPayment:String(recognizedPayment||'').slice(0,80)}});
 const stamp=String(Date.now());
 let stage='sign';
 try{
  const signature=await hmacHex(dest.secret,stamp+'\n'+body);
  stage='fetch';
  const response=await dest.fetcher(new Request(dest.url,{method:'POST',headers:{
   'Content-Type':'application/json','X-DA-Timestamp':stamp,'X-DA-Signature':signature
  },body}));
  stage='parse';
  const parsed=await response.json().catch(()=>null);
  if(!response.ok){
   const reason=classifyBridgeRejection('kakebo',response.status,parsed);
   // Never send the untrusted response body or URL to the user's PWA.
   return {error:reason?.message||'家計簿接口暂时无法使用（HTTP '+response.status+'）'};
  }
  if(!parsed)return {error:'家計簿接口没有返回可用的数据格式（HTTP '+response.status+'）'};
  if(!parsed.ok)return {error:'家計簿接口未接受选项读取请求'};
  const safeList=(items,max)=>Array.isArray(items)?items.slice(0,120).filter(x=>
   typeof x?.value==='string'&&x.value.length>0&&x.value.length<=max&&
   typeof x?.label==='string'&&x.label.length>0&&x.label.length<=max
  ).map(x=>({value:x.value,label:x.label})):[];
  const categories=safeList(parsed.categories,80);
  const paymentSources=safeList(parsed.payment_sources,80);
  if(!categories.length||!paymentSources.length)
   return {error:'家計簿接口未返回可用分类或支付方式，请确认正式部署'};
  const suggested=parsed.suggested&&typeof parsed.suggested==='object'?parsed.suggested:{};
  const category=categories.some(x=>x.value===suggested.category)?suggested.category:'';
  const payment_source=paymentSources.some(x=>x.value===suggested.payment_source)?suggested.payment_source:'';
  return {data:{categories,paymentSources,suggested:{category,payment_source}}};
 }catch(e){
  const reason=String(e?.message||'');
  if(stage==='sign')return {error:'家計簿联动签名失败，请检查服务端配置'};
  if(stage==='fetch'&&/1042|same.zone|route.*worker/i.test(reason))
   return {error:'Cloudflare 不允许当前请求路径，请检查跨应用路由配置（1042）'};
  if(stage==='fetch')return {error:'无法连接家計簿正式接口（网络或路由错误）'};
  return {error:'家計簿选项响应处理失败'};
 }
}


/**
 * On-demand signed read-only reconciliation. A previously synced ledger entry
 * may later be moved to Kakebo's trash. Never recreate or restore it here.
 */
export async function integrationStatus(env,p,id){
  const item=await first(env.DB,`SELECT c.id,d.id document_id,d.owner_id,d.lifecycle,c.candidate_kind
    FROM action_candidates c JOIN documents d ON d.id=c.document_id WHERE c.id=?`,id);
  if(!item||item.owner_id!==p.user_id||item.lifecycle!=='active')
    bad('候选不存在','NOT_FOUND',404);
  const target=TARGETS[item.candidate_kind];
  const link=await first(env.DB,'SELECT state,remote_id,idempotency_key FROM integration_links WHERE candidate_id=? AND target=?',id,target);
  if(!link||!['synced','linked_existing'].includes(link.state))
    return json({ok:true,target,stored_state:link?.state||'not_synced',record_state:'not_synced'});
  if(target!=='kakebo')
    return json({ok:true,target,stored_state:link.state,record_state:'not_checked'});
  const dest=config(env,'kakebo'),actor=authorizedMapping(env,p.user_id,'kakebo');
  if(!dest||!actor)return failure('STATUS_UNAVAILABLE','家計簿状态暂不可核对，保留原同步记录',503);
  const found=await lookupKakeboIdempotency(dest,{
    key:link.idempotency_key,actor,documentId:item.document_id,candidateId:id,operation:'status'});
  if(!found?.recordState)return failure('STATUS_UNAVAILABLE','目标接口暂未返回可验证的状态，未改动账目',503);
  return json({ok:true,target,stored_state:link.state,record_state:found.recordState,
    needs_attention:found.recordState!=='active',remote_id:found.remoteId});
}

/** Read a signed, household-scoped assignee list; never expose other households. */
export async function homeflowMemberOptions(env,userId,candidateId){
  const dest=config(env,'homeflow'),actor=authorizedMapping(env,userId,'homeflow');
  if(!dest||!actor)return {error:'HomeFlow 账号尚未完成联动授权'};
  const key=`jda:homeflow:${candidateId}`;
  const raw=JSON.stringify({source:'jp-document-assistant',actor_user_id:actor,
    idempotency_key:key,payload:{operation:'members'}});
  const stamp=String(Date.now());
  try{
    const signature=await hmacHex(dest.secret,stamp+'\n'+raw);
    const response=await dest.fetcher(new Request(dest.url,{method:'POST',headers:{
      'Content-Type':'application/json','X-DA-Timestamp':stamp,
      'X-DA-Signature':signature,'Idempotency-Key':key},body:raw}));
    const data=await response.json().catch(()=>null);
    if(!response.ok||data?.ok!==true||!Array.isArray(data.members))
      return {error:'HomeFlow 负责人暂时无法读取'};
    const members=data.members.slice(0,2).filter(x=>
      typeof x?.id==='string'&&/^[a-zA-Z0-9_-]{8,80}$/.test(x.id)&&
      typeof x?.label==='string'&&x.label.length>0&&x.label.length<=60&&
      typeof x?.self==='boolean');
    if(!members.some(x=>x.self))return {error:'HomeFlow 当前成员无法核验'};
    return {members};
  }catch{return {error:'HomeFlow 成员列表读取失败'};}
}

export async function candidatePreview(request,env,p,id){
  const item=await first(env.DB,`SELECT c.*,d.owner_id,d.lifecycle,d.visibility,d.id document_id,d.title FROM action_candidates c JOIN documents d ON d.id=c.document_id WHERE c.id=?`,id);
  if(!item||item.owner_id!==p.user_id||item.lifecycle!=='active')bad('候选不存在','NOT_FOUND',404);
  const target=TARGETS[item.candidate_kind];
  const fields=await checkedFields(env,item.document_id);
  const link=await first(env.DB,'SELECT state,remote_id,attempt_count,last_error_code FROM integration_links WHERE candidate_id=?',id);
  const payload=JSON.parse(item.payload_json);
  const verifiedMerchant=fields.get('merchant')||payload.merchant;
  const entryType=target==='kakebo'?ledgerEntryType(payload,verifiedMerchant):null;
  // Member-initiated writes require a separately verified HomeFlow approval.
  // Until that executor is implemented, never look up private target accounts
  // or expose an enabled "sync" button merely because a bridge is configured.
  const approvalRequired=p.role!=='owner';
  const picker=!approvalRequired&&target==='kakebo'
    ?await ledgerPickerOptions(env,p.user_id,entryType,verifiedMerchant,payload.payment_source_hint):null;
  const members=!approvalRequired&&target==='homeflow'
    ?await homeflowMemberOptions(env,p.user_id,id):null;
  return json({candidate_id:id,target,kind:item.candidate_kind,payload,entry_type:entryType,ledger_options:picker?.data||null,
    ledger_options_error:picker?.error||null,
    homeflow_members:members?.members||null,homeflow_members_error:members?.error||null,
    confirmed_fields:Object.fromEntries(fields),confirmation_phrase:CONFIRMATIONS[item.candidate_kind],
    integration:link||null,available:!approvalRequired&&!!config(env,target),
    approval_required:approvalRequired,approval_submitted:false,applied:false,
    account_mapping_ready:!approvalRequired&&!!authorizedMapping(env,p.user_id,target),
    note:approvalRequired
      ?'当前成员需要 HomeFlow 管理员审批。本次尚未创建申请，也未同步到目标 App。'
      :'请对照原文及目标 App 的账号完成二次确认。生词和句子必须先脱敏，财务内容不能直接视为已付款。'});
}
export async function commitCandidate(request,env,p,id){
  const item=await first(env.DB,`SELECT c.*,d.owner_id,d.lifecycle,d.visibility,d.id document_id,d.title FROM action_candidates c JOIN documents d ON d.id=c.document_id WHERE c.id=?`,id);
  if(!item||item.owner_id!==p.user_id||item.lifecycle!=='active')bad('候选不存在','NOT_FOUND',404);
  const target=TARGETS[item.candidate_kind];
  // Hard server-side gate: neither a legacy member session nor a new SSO
  // member may write household finance, tasks, or private study targets
  // without a VERIFIED HomeFlow approval and scoped target executor.
  // Do not create an integration_link (or claim a remote write) here.
  if(p.role!=='owner')
    return failure('APPROVAL_REQUIRED',
      '普通成员跨应用同步需要 HomeFlow 审批；当前未提交申请，也未写入目标 App。',409);
  const data=await readJson(request,9000);
  if(data.confirm!==CONFIRMATIONS[item.candidate_kind])bad('需要明确二次确认','CONFIRM_REQUIRED',409);
  const supplied=request.headers.get('Idempotency-Key');
  if(!supplied||!/^[A-Za-z0-9._:-]{8,120}$/.test(supplied))bad('需要合法 Idempotency-Key','IDEMPOTENCY_REQUIRED',400);
  const existing=await first(env.DB,'SELECT * FROM integration_links WHERE candidate_id=? AND target=?',id,target);
  // A completed integration remains an established fact even after the user
  // disconnects the service; never falsely report it as not configured.
  if(existing?.state==='synced'||existing?.state==='linked_existing')return json({ok:true,already_synced:true,remote_id:existing.remote_id,target});
  const dest=config(env,target);
  if(!dest)return failure('BRIDGE_NOT_CONFIGURED','该 App 的安全联动服务尚未配置；没有写入目标 App',503);
  const fields=await checkedFields(env,item.document_id);
  const payload=validatedPayload(target,item,fields,data);
  const remoteUser=authorizedMapping(env,p.user_id,target);
  if(!remoteUser)return failure('ACCOUNT_NOT_LINKED','尚未完成目标账号的独立授权和身份映射；没有发送联动',403);
  const key=existing?.idempotency_key||`jda:${target}:${id}`;
  const requestPayload={source:'jp-document-assistant',source_document_id:item.document_id,source_candidate_id:id,actor_user_id:remoteUser,idempotency_key:key,payload};
  const raw=JSON.stringify(requestPayload),fingerprint=await hashString(raw),timestamp=String(Date.now());
  const staleBefore=new Date(Date.now()-120000).toISOString();
  // Changed payloads are prohibited until the owner explicitly confirms the
  // change AND the target's signed read-only lookup proves no prior entry.
  if(existing?.request_fingerprint&&existing.request_fingerprint!==fingerprint){
    if(target!=='kakebo'||existing.state!=='failed'||data.confirm_mapping_change!==true)
      return failure('RETRY_PAYLOAD_CHANGED','已有发送记录。若要更换分类或支付方式，请勾选核对并重新提交；未自动记账',409);
    if(existing.updated_at>staleBefore)return failure('SENDING','上次发送尚未结束，请稍后核对家計簿',409);
    const reconciliation=await lookupKakeboIdempotency(dest,{
      key,actor:remoteUser,documentId:item.document_id,candidateId:id});
    if(!reconciliation)return failure('RECONCILIATION_UNAVAILABLE','暂时无法核对家計簿是否已收录，已阻止修改和重复记账',503);
    const stampNow=isoNow();
    if(reconciliation.exists){
      const linked=await run(env.DB,`UPDATE integration_links
        SET state='linked_existing',remote_id=?,synced_at=?,last_error_code=NULL,updated_at=?
        WHERE candidate_id=? AND target=? AND request_fingerprint=? AND state='failed'`,
        reconciliation.remoteId,stampNow,stampNow,id,target,existing.request_fingerprint);
      if(linked.meta?.changes!==1)return failure('LINK_CONFLICT','同步记录已发生变化，请刷新',409);
      return json({ok:true,already_synced:true,recovered_prior:true,remote_id:reconciliation.remoteId,target});
    }
    const replaced=await run(env.DB,`UPDATE integration_links
      SET request_fingerprint=?,updated_at=?,last_error_code=NULL
      WHERE candidate_id=? AND target=? AND request_fingerprint=? AND state='failed'`,
      fingerprint,stampNow,id,target,existing.request_fingerprint);
    if(replaced.meta?.changes!==1)return failure('LINK_CONFLICT','同步记录已发生变化，请刷新',409);
  }
  if(existing&&!existing.request_fingerprint&&existing.attempt_count>0)
    return failure('LEGACY_RETRY_UNVERIFIED','旧联动缺少请求指纹，需人工核对目标 App 后再处理',409);
  if(existing?.state==='sending'&&existing.updated_at>staleBefore)
    return failure('SENDING','同一候选的联动正在处理中，没有发送第二份请求',409);
  const now=isoNow();
  if(!existing)await run(env.DB,`INSERT OR IGNORE INTO integration_links
    (id,candidate_id,target,idempotency_key,state,request_fingerprint,updated_at)
    VALUES(?,?,?,?,?,?,?)`,randomToken(16),id,target,key,'pending',fingerprint,now);
  // Atomic D1 CAS: exactly one sender claims pending/failed, or a truly stale sending state.
  const updated=await run(env.DB,`UPDATE integration_links SET state='sending',updated_at=?,
    attempt_count=attempt_count+1,request_fingerprint=COALESCE(request_fingerprint,?)
    WHERE candidate_id=? AND target=? AND (request_fingerprint=? OR request_fingerprint IS NULL)
      AND (state IN ('pending','failed') OR (state='sending' AND updated_at<=?))`,
    now,fingerprint,id,target,fingerprint,staleBefore);
  if(updated.meta?.changes!==1){
    const latest=await first(env.DB,'SELECT state,remote_id,request_fingerprint FROM integration_links WHERE candidate_id=? AND target=?',id,target);
    if(latest?.request_fingerprint&&latest.request_fingerprint!==fingerprint)
      return failure('RETRY_PAYLOAD_CHANGED','另一请求已经锁定不同内容；没有重复发送',409);
    if(latest?.state==='synced'||latest?.state==='linked_existing')
      return json({ok:true,already_synced:true,remote_id:latest.remote_id,target});
    return failure('SENDING','联动已有其他发送者正在处理，未重复发送',409);
  }
  const signature=await hmacHex(dest.secret,`${timestamp}\n${raw}`);
  let answer;
  try{
    const response=await dest.fetcher(new Request(dest.url,{method:'POST',headers:{'Content-Type':'application/json','X-DA-Timestamp':timestamp,'X-DA-Signature':signature,'Idempotency-Key':key},body:raw}));
    answer=await response.json().catch(()=>({}));
    // A known 4xx is a definitive no-write outcome; expose only a safe code.
    const rejected=classifyBridgeRejection(target,response.status,answer);
    if(rejected){
      await run(env.DB,`UPDATE integration_links SET state='failed',last_error_code=?,updated_at=?
        WHERE candidate_id=? AND target=? AND state='sending' AND updated_at=? AND request_fingerprint=?`,
        rejected.code,isoNow(),id,target,now,fingerprint);
      return failure(rejected.code,rejected.message,rejected.status);
    }
    if(!response.ok||!answer?.ok||typeof answer.remote_id!=='string'||!answer.remote_id)throw new Error('BRIDGE_RESPONSE_FAILED');
  }catch{
    // The target may have committed while the reply was lost; always retry with the SAME key.
    await run(env.DB,`UPDATE integration_links SET state='failed',last_error_code='BRIDGE_UNCONFIRMED',updated_at=?
      WHERE candidate_id=? AND target=? AND state='sending' AND updated_at=? AND request_fingerprint=?`,isoNow(),id,target,now,fingerprint);
    return failure('BRIDGE_UNCONFIRMED','目标应用可能已收到请求但尚未确认结果。请重试同一候选（不会换幂等键）',503);
  }
  const completed=await run(env.DB,`UPDATE integration_links SET state='synced',remote_id=?,synced_at=?,last_error_code=NULL,updated_at=?
    WHERE candidate_id=? AND target=? AND state='sending' AND updated_at=? AND request_fingerprint=?`,
    answer.remote_id,isoNow(),isoNow(),id,target,now,fingerprint);
  if(completed.meta?.changes!==1)return failure('LINK_CONFLICT','发送状态已被其他请求更新，请刷新后核对目标记录',409);
  return json({ok:true,target,remote_id:answer.remote_id,reused:!!answer.reused});
}
