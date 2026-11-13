// Stage D/E: durable, private member intent -> signed HomeFlow pending review.
// NO target-app bridge call is made here. Approval does not authorize execution;
// document.sync.* needs its own verified executor, which is NOT implemented.
import {randomToken,hashString,isoNow} from './security.js';
import {json,bad,readJson,failure} from './http.js';
import {validatedPayload} from './bridge.js';

const idPattern=/^[a-f0-9]{32}$/;
const hashPattern=/^[a-f0-9]{64}$/;
// Unlike the document-assistant's legacy UTF-8 bridge secrets, HomeFlow
// approval secrets are 32 raw bytes encoded as 64 hex characters.
async function approvalSignature(secret,stamp,raw){
 const bytes=Uint8Array.from(secret.match(/.{2}/g),x=>parseInt(x,16));
 const key=await crypto.subtle.importKey('raw',bytes,
  {name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signed=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(
  'jp-document-assistant\n'+stamp+'\n'+raw));
 return Array.from(new Uint8Array(signed),b=>b.toString(16).padStart(2,'0')).join('');
}
const kinds={
 finance:{target:'kakebo',confirm:'CONFIRM_ACCOUNTING'},
 homeflow_task:{target:'homeflow',confirm:'CONFIRM_TASK'},
 vocabulary:{target:'it-study-platform',confirm:'CONFIRM_STUDY'},
 sentence:{target:'it-study-platform',confirm:'CONFIRM_STUDY'}
};
const allowedInput=new Set(['confirm','payment_confirmed','date','transfer_date',
 'category','payment_source','note','visibility','title','assignee',
 'bonus_points','remindEnabled','task_share_confirmed',
 'privacy_confirmed','redacted_sentence','redacted_term']);
const dbFirst=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const dbRun=(db,sql,...args)=>db.prepare(sql).bind(...args).run();
export function documentMemberApprovalReady(env){
 return env.HOMEFLOW_SSO_ENABLED==='true'&&
  env.DOCUMENT_APPROVAL_SUBMISSION_ENABLED==='true'&&
  typeof env.DOCUMENT_APPROVAL_SUBMISSION_SECRET==='string'&&
  hashPattern.test(env.DOCUMENT_APPROVAL_SUBMISSION_SECRET)&&
  typeof env.HOMEFLOW_BRIDGE_SERVICE?.fetch==='function'&&
  typeof env.DB?.prepare==='function';
}
function checkedMember(p){
 if(p?.role!=='member'||p.auth_source!=='homeflow'||
  !p.homeflow_user_id||!p.homeflow_household_id)
  bad('仅经过 HomeFlow 验证的家庭成员可以申请审批','SSO_MEMBER_REQUIRED',403);
}
async function candidate(env,p,id){
 if(!idPattern.test(id))bad('候选不存在','NOT_FOUND',404);
 const item=await dbFirst(env.DB,`SELECT c.*,d.id document_id,d.owner_id,d.household_id,
  d.lifecycle,d.visibility,d.version document_version
  FROM action_candidates c JOIN documents d ON d.id=c.document_id
  WHERE c.id=?`,id);
 if(!item||item.owner_id!==p.user_id||item.household_id!==p.household_id||
  item.lifecycle!=='active'||!Object.hasOwn(kinds,item.candidate_kind))
  bad('候选不存在','NOT_FOUND',404);
 // A previously attempted/synced direct bridge must never create an
 // independent approval that might later duplicate the remote action.
 const linked=await dbFirst(env.DB,
  'SELECT id FROM integration_links WHERE candidate_id=? LIMIT 1',id);
 if(linked)bad('候选已有关联记录，不能重新生成审批','ALREADY_LINKED',409);
 return item;
}
async function fields(env,docId){
 const response=await env.DB.prepare('SELECT field_key,normalized_value,review_state '+
  'FROM document_fields WHERE document_id=?').bind(docId).all();
 return new Map((response.results||[]).filter(x=>
  x.review_state==='confirmed'||x.review_state==='corrected')
  .map(x=>[x.field_key,x.normalized_value]));
}
function publicStatus(row,approvalStatus=null){
 return {ok:true,candidate_id:row.candidate_id,
  approval_id:row.approval_id||null,approval_submitted:row.status==='submitted',
  approval_status:approvalStatus||(
   row.status==='submitted'?'submitted_status_unknown':'prepared_unconfirmed'),
  payload_sha256:row.payload_sha256,
  applied:false,target_changed:false};
}
export async function documentMemberApprovalStatus(env,p,id){
 checkedMember(p);
 if(!documentMemberApprovalReady(env))
  return json({ok:false,code:'DOCUMENT_APPROVAL_DISABLED',applied:false},503);
 const item=await candidate(env,p,id);
 const row=await dbFirst(env.DB,'SELECT * FROM document_member_sync_intents WHERE candidate_id=?',id);
 return json(row&&row.local_user_id===p.user_id&&
  row.homeflow_user_id===p.homeflow_user_id?
  publicStatus(row):{ok:true,candidate_id:item.id,approval_submitted:false,
   approval_status:'not_submitted',approval_id:null,applied:false,target_changed:false});
}
export async function requestDocumentMemberApproval(request,env,p,id){
 checkedMember(p);
 if(!documentMemberApprovalReady(env))
  return failure('DOCUMENT_APPROVAL_DISABLED','文书审批服务暂未启用，没有提交申请或写入目标应用',503);
 const item=await candidate(env,p,id);
 const body=await readJson(request,4500);
 if(!body||typeof body!=='object'||Array.isArray(body)||
  body.confirm!==kinds[item.candidate_kind].confirm)
  bad('需要明确确认审批内容','CONFIRM_REQUIRED',409);
 const target=kinds[item.candidate_kind].target,now=isoNow();
 const resume=body.resume_existing===true;
 let digest,snapshot;
 if(resume){
  // Only an explicit original-intent recovery is allowed. We do NOT infer
  // a new snapshot from altered form fields or replay another user's data.
  if(Object.keys(body).length!==2||
     Object.keys(body).some(k=>!['confirm','resume_existing'].includes(k)))
   bad('重试申请格式无效','INVALID_RETRY',400);
  const original=await dbFirst(env.DB,
   'SELECT * FROM document_member_sync_intents WHERE candidate_id=?',id);
  if(!original||original.local_user_id!==p.user_id||
    original.homeflow_user_id!==p.homeflow_user_id||
    original.homeflow_household_id!==p.homeflow_household_id||
    original.document_id!==item.document_id||
    original.document_version!==item.document_version||
    original.candidate_updated_at!==item.updated_at||
    original.candidate_kind!==item.candidate_kind||
    original.target_app!==target)
   bad('申请原始版本已变化，不能重试','APPROVAL_RETRY_CONFLICT',409);
  digest=original.payload_sha256;snapshot=original.payload_json;
  if(!hashPattern.test(digest)||await hashString(snapshot)!==digest)
   bad('申请快照完整性不符','APPROVAL_SNAPSHOT_INVALID',409);
 }else{
  if(Object.keys(body).some(k=>!allowedInput.has(k)))
   bad('不支持的审批字段','INVALID_APPROVAL_FIELDS',400);
  const approved=await fields(env,item.document_id);
  // Same business verification as owner confirmation, but no target call.
  const payload=validatedPayload(
   target==='it-study-platform'?'zhixue':target,item,approved,body);
  const envelope={source_document_id:item.document_id,source_candidate_id:id,
   source_document_version:item.document_version,
   candidate_updated_at:item.updated_at,candidate_kind:item.candidate_kind,
   homeflow_user_id:p.homeflow_user_id,
   homeflow_household_id:p.homeflow_household_id,target_app:target,payload};
  snapshot=JSON.stringify(envelope);digest=await hashString(snapshot);
  await dbRun(env.DB,`INSERT INTO document_member_sync_intents
   (candidate_id,document_id,local_user_id,homeflow_user_id,
    homeflow_household_id,target_app,candidate_kind,document_version,
    candidate_updated_at,payload_sha256,payload_json,status,created_at,updated_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?)
   ON CONFLICT(candidate_id) DO NOTHING`,
   id,item.document_id,p.user_id,p.homeflow_user_id,p.homeflow_household_id,
   target,item.candidate_kind,item.document_version,item.updated_at,
   digest,snapshot,now,now);
 }
 const stored=await dbFirst(env.DB,
  'SELECT * FROM document_member_sync_intents WHERE candidate_id=?',id);
 if(!stored||stored.local_user_id!==p.user_id||
  stored.homeflow_user_id!==p.homeflow_user_id||
  stored.homeflow_household_id!==p.homeflow_household_id||
  stored.target_app!==target||stored.payload_sha256!==digest||
  stored.payload_json!==snapshot)
  bad('申请内容与已有候选快照不同，请先核对原申请','APPROVAL_INTENT_CONFLICT',409);
 // Confirmation is frozen in private D1 before HomeFlow sees the digest.
 // If the response is lost, repeat the same signed hash and candidate ID;
 // HomeFlow will return its original immutable request instead of duplicating.
 const wire={household_id:p.homeflow_household_id,
  requester_user_id:p.homeflow_user_id,resource_id:id,
  payload_sha256:digest,target_app:target};
 const raw=JSON.stringify(wire),stamp=String(Date.now());
 const signature=await approvalSignature(env.DOCUMENT_APPROVAL_SUBMISSION_SECRET,
  stamp,raw);
 let response,data;
 try{
  response=await env.HOMEFLOW_BRIDGE_SERVICE.fetch(new Request(
   'https://homeflow.internal/api/internal/approvals/document-submit',{
    method:'POST',redirect:'manual',
    headers:{'Content-Type':'application/json','Accept':'application/json',
     'X-Approval-Client':'jp-document-assistant',
     'X-Approval-Timestamp':stamp,'X-Approval-Signature':signature},
    body:raw
   }));
  const rawReply=await response.text();
  if(rawReply.length>2200)throw Error('unverified reply');
  data=JSON.parse(rawReply);
 }catch{
  return failure('APPROVAL_SUBMISSION_UNCONFIRMED',
   'HomeFlow 申请结果暂无法确认；原申请已安全保存，重试不会创建第二份，也没有写入目标应用',503);
 }
 if(![200,201].includes(response.status)||!data?.ok||
  typeof data.approval_id!=='string'||
  !/^[a-f0-9-]{36}$/i.test(data.approval_id)||
  data.resource_id!==id||data.target_app!==target||
  data.payload_sha256!==digest||
  data.requester_user_id!==p.homeflow_user_id||
  data.household_id!==p.homeflow_household_id||
  !['pending','approved','rejected','cancelled','expired','failed_final','conflict'].includes(data.status)||
  data.applied!==false||data.target_changed!==false){
  return failure('APPROVAL_SUBMISSION_UNCONFIRMED',
   'HomeFlow 没有返回可验证的审批回执，原申请已保存；没有写入目标应用',503);
 }
 if(stored.approval_id&&stored.approval_id!==data.approval_id)
  bad('审批编号发生冲突，请核对','APPROVAL_ID_CONFLICT',409);
 if(stored.status!=='submitted'){
  const output=await env.DB.batch([
   env.DB.prepare(`UPDATE document_member_sync_intents
    SET status='submitted',approval_id=?,updated_at=?
    WHERE candidate_id=? AND local_user_id=? AND homeflow_user_id=?
      AND status='prepared' AND approval_id IS NULL`)
    .bind(data.approval_id,now,id,p.user_id,p.homeflow_user_id),
   env.DB.prepare(`INSERT INTO audit_events(id,actor_user_id,kind,entity_type,entity_id,created_at)
    SELECT ?,?,'document_sync_approval_submitted','candidate',?,?
    FROM document_member_sync_intents WHERE candidate_id=? AND changes()=1`)
    .bind(randomToken(16),p.user_id,id,now,id)
  ]);
  if(output.some(x=>x.meta?.changes!==1)){
   const raced=await dbFirst(env.DB,
    'SELECT status,approval_id FROM document_member_sync_intents WHERE candidate_id=?',id);
   if(raced?.status!=='submitted'||raced.approval_id!==data.approval_id)
    return failure('APPROVAL_ACK_CONFLICT','审批回执保存未完成，请重试原申请',503);
  }
 }
 return json({...publicStatus({...stored,status:'submitted',approval_id:data.approval_id},data.status),
  replayed:data.replayed===true});
}
