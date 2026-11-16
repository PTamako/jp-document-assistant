// Signed HomeFlow -> document candidate check and durable task receipt.
// This module NEVER creates a HomeFlow task itself. Only a separately gated
// HomeFlow transaction kernel may post after a fresh leased source proof.
import {openDocumentIntent,documentIntentKeyReady} from './document-intent-crypto.js';
import {hashString,randomToken,isoNow} from './security.js';

const hex=/^[a-f0-9]{64}$/i, id32=/^[a-f0-9]{32}$/i;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const core=['request_id','resource_id','household_id','requester_user_id','payload_sha256'];
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&
 Object.keys(o).sort().join(',')===keys.slice().sort().join(',');
const reply=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
const refuse=(code,status=409)=>reply({ok:false,code,applied:false},status);
const same=(a,b)=>a===b;
const enabled=e=>e.APP_ENV==='production'&&e.DOCUMENT_TASK_EXECUTION_ENABLED==='true'&&
 typeof e.HOMEFLOW_DOCUMENT_EXECUTION_SECRET==='string'&&hex.test(e.HOMEFLOW_DOCUMENT_EXECUTION_SECRET)&&
 typeof e.DOCUMENT_APPROVAL_VERIFICATION_SECRET==='string'&&hex.test(e.DOCUMENT_APPROVAL_VERIFICATION_SECRET)&&
 documentIntentKeyReady(e)&&!!e.DB?.prepare&&typeof e.HOMEFLOW_BRIDGE_SERVICE?.fetch==='function';
async function mac(secret,domain,stamp,raw){
 const k=await crypto.subtle.importKey('raw',Uint8Array.from(
  secret.match(/.{2}/g),x=>parseInt(x,16)),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const bytes=await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(domain+'\n'+stamp+'\n'+raw));
 return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
}
async function body(req,secret,domain,expected){
 if(req.method!=='POST'||req.headers.has('origin')||req.headers.has('cookie')||
  req.headers.has('authorization')||req.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||
  req.headers.get('x-approval-client')!=='homeflow')return null;
 const stamp=req.headers.get('x-approval-timestamp');
 const signature=req.headers.get('x-approval-signature');
 if(!/^\d{13}$/.test(stamp||'')||Math.abs(Date.now()-Number(stamp))>300000||!hex.test(signature||''))return null;
 let raw,b;try{raw=await req.text();if(raw.length>2100)return null;b=JSON.parse(raw)}catch{return null}
 if(!exact(b,expected)||!same(await mac(secret,domain,stamp,raw),signature)||
  !uuid.test(b.request_id)||!id32.test(b.resource_id)||!hex.test(b.payload_sha256)||
  typeof b.household_id!=='string'||!b.household_id||b.household_id.length>128||
  typeof b.requester_user_id!=='string'||!b.requester_user_id||b.requester_user_id.length>128)return null;
 return b;
}
async function sourceRow(db,b){
 return db.prepare('SELECT i.*,d.owner_id,d.lifecycle,d.version AS live_version,'+
  'c.updated_at AS live_candidate_updated_at,c.payload_json AS live_candidate_payload,'+
  'u.role AS local_role,u.status AS local_status,l.state AS link_state,'+
  'l.homeflow_household_id AS link_household FROM document_member_sync_intents i '+
  'JOIN documents d ON d.id=i.document_id '+
  'JOIN action_candidates c ON c.id=i.candidate_id AND c.document_id=d.id '+
  'JOIN users u ON u.id=i.local_user_id '+
  'JOIN homeflow_identity_links l ON l.homeflow_user_id=i.homeflow_user_id '+
  'AND l.local_user_id=i.local_user_id '+
  'WHERE i.approval_id=? AND i.candidate_id=? LIMIT 1')
  .bind(b.request_id,b.resource_id).first();
}
const matching=(r,b)=>r&&r.status==='submitted'&&r.target_app==='homeflow'&&
 r.candidate_kind==='homeflow_task'&&r.homeflow_user_id===b.requester_user_id&&
 r.homeflow_household_id===b.household_id&&r.payload_sha256===b.payload_sha256;
const live=(r,b)=>matching(r,b)&&r.owner_id===r.local_user_id&&
 r.lifecycle==='active'&&r.document_version===r.live_version&&
 r.candidate_updated_at===r.live_candidate_updated_at&&
 r.local_role==='member'&&r.local_status==='active'&&r.link_state==='active'&&
 r.link_household===b.household_id;
async function frozenTask(env,row,b){
 try{
  const raw=await openDocumentIntent(env,row);
  if(await hashString(raw)!==b.payload_sha256)return null;
  const envelope=JSON.parse(raw),t=envelope.payload;
  if(envelope.source_document_id!==row.document_id||
   envelope.source_candidate_id!==b.resource_id||
   envelope.source_document_version!==row.document_version||
   envelope.candidate_updated_at!==row.candidate_updated_at||
   envelope.candidate_kind!=='homeflow_task'||envelope.target_app!=='homeflow'||
   envelope.homeflow_user_id!==b.requester_user_id||
   envelope.homeflow_household_id!==b.household_id||
   !exact(t,['operation','title','dueOn','visibility','assignee','bonusPoints','remindEnabled'])||
   t.operation!=='task'||typeof t.title!=='string'||!t.title.trim()||t.title.length>120||
   typeof t.dueOn!=='string'||!/^20\d\d-\d\d-\d\d$/.test(t.dueOn)||
   !Number.isFinite(Date.parse(t.dueOn+'T00:00:00Z'))||
   new Date(t.dueOn+'T00:00:00Z').toISOString().slice(0,10)!==t.dueOn||
   !['private','household'].includes(t.visibility)||
   (t.assignee!==null&&(typeof t.assignee!=='string'||!t.assignee||t.assignee.length>60))||
   !Number.isSafeInteger(t.bonusPoints)||t.bonusPoints<0||t.bonusPoints>10000||
   typeof t.remindEnabled!=='boolean')return null;
  const candidate=JSON.parse(row.live_candidate_payload);
  if(candidate?.task_type==='delivery'){
   const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',
    year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
   if(t.dueOn<today)return null;
  }
  return {task:t,operation_sha256:await hashString(JSON.stringify(t))};
 }catch{return null}
}
async function approvedLease(env,b){
 const req={...b,idempotency_key:'jpda:sync:'+b.resource_id,
  expected_version:null,purpose:'execute'};
 const raw=JSON.stringify(req),stamp=String(Date.now());
 try{
  const response=await env.HOMEFLOW_BRIDGE_SERVICE.fetch(new Request(
   'https://homeflow.internal/api/internal/approvals/verify',{method:'POST',
   redirect:'manual',headers:{'content-type':'application/json',
    'x-approval-client':'jp-document-assistant','x-approval-timestamp':stamp,
    'x-approval-signature':await mac(env.DOCUMENT_APPROVAL_VERIFICATION_SECRET,
     'jpda:execution-proof',stamp,raw)},body:raw}));
  if(response.status!==200||response.headers.has('location'))return false;
  const text=await response.text();if(text.length>1900)return false;
  const v=JSON.parse(text);
  return v.ok===true&&v.verified===true&&v.execution_authorized===true&&
   v.execution_status==='executing'&&v.source_app==='jp-document-assistant'&&
   v.target_app==='homeflow'&&v.operation==='document.sync.homeflow'&&
   v.resource_type==='document_sync_candidate'&&
   v.request_id===b.request_id&&v.resource_id===b.resource_id&&
   v.household_id===b.household_id&&v.requester_user_id===b.requester_user_id&&
   v.payload_sha256===b.payload_sha256&&
   v.idempotency_key==='jpda:sync:'+b.resource_id&&v.expected_version===null&&
   v.approver_user_id&&v.approver_user_id!==b.requester_user_id&&
   Number.isSafeInteger(v.approved_at)&&Number.isSafeInteger(v.expires_at)&&
   v.expires_at>Date.now()&&v.applied===false;
 }catch{return false}
}
async function prepare(env,b){
 if(!hex.test(b.execution_nonce))return refuse('invalid_execution_nonce',403);
 const row=await sourceRow(env.DB,b);
 if(!live(row,b))return refuse('task_source_changed');
 const result=await frozenTask(env,row,b);
 if(!result)return refuse('task_snapshot_invalid');
 if(!await approvedLease(env,b))return refuse('approval_proof_failed',403);
 const existing=await env.DB.prepare('SELECT * FROM document_task_execution_reservations '+
  'WHERE candidate_id=? OR approval_id=? LIMIT 1').bind(b.resource_id,b.request_id).first();
 if(existing&&(
  existing.status!=='executing'||existing.candidate_id!==b.resource_id||
  existing.approval_id!==b.request_id||existing.document_id!==row.document_id||
  existing.requester_user_id!==b.requester_user_id||
  existing.household_id!==b.household_id||
  existing.payload_sha256!==b.payload_sha256||
  existing.operation_sha256!==result.operation_sha256))
  return refuse('task_reservation_conflict');
 if(!existing){
  try{
   await env.DB.prepare('INSERT OR IGNORE INTO document_task_execution_reservations '+
    '(candidate_id,approval_id,document_id,requester_user_id,household_id,'+
    'payload_sha256,operation_sha256,status,reserved_at) '+
    "SELECT i.candidate_id,i.approval_id,i.document_id,i.homeflow_user_id,"+
    "i.homeflow_household_id,i.payload_sha256,?,'executing',? "+
    'FROM document_member_sync_intents i '+
    'JOIN documents d ON d.id=i.document_id '+
    'JOIN action_candidates c ON c.id=i.candidate_id AND c.document_id=d.id '+
    'JOIN homeflow_identity_links l ON l.homeflow_user_id=i.homeflow_user_id '+
    'AND l.local_user_id=i.local_user_id '+
    'JOIN users u ON u.id=i.local_user_id '+
    "WHERE i.candidate_id=? AND i.approval_id=? AND i.status='submitted' "+
    "AND i.candidate_kind='homeflow_task' AND i.target_app='homeflow' "+
    'AND i.payload_sha256=? AND d.owner_id=i.local_user_id '+
    "AND d.lifecycle='active' AND d.version=i.document_version "+
    "AND c.updated_at=i.candidate_updated_at AND l.state='active' "+
    "AND l.homeflow_household_id=i.homeflow_household_id AND u.role='member' "+
    "AND u.status='active'")
    .bind(result.operation_sha256,Date.now(),b.resource_id,b.request_id,
     b.payload_sha256).run();
  }catch{return refuse('task_reservation_failed',503)}
  const persisted=await env.DB.prepare('SELECT * FROM document_task_execution_reservations WHERE candidate_id=?')
   .bind(b.resource_id).first();
  if(!persisted||persisted.status!=='executing'||persisted.approval_id!==b.request_id||
   persisted.operation_sha256!==result.operation_sha256)
   return refuse('task_reservation_unconfirmed',503);
 }
 return reply({ok:true,verified:true,applied:false,approval_id:b.request_id,
  candidate_id:b.resource_id,household_id:b.household_id,
  requester_user_id:b.requester_user_id,payload_sha256:b.payload_sha256,
  operation_sha256:result.operation_sha256,task:result.task});
}
async function recordReceipt(env,b){
 if(!uuid.test(b.task_id)||!hex.test(b.operation_sha256)||
  !Number.isSafeInteger(b.applied_at)||b.applied_at<1||
  typeof b.approver_user_id!=='string'||!b.approver_user_id||
  b.approver_user_id===b.requester_user_id)return refuse('invalid_task_receipt',403);
 const r=await env.DB.prepare('SELECT * FROM document_task_execution_reservations WHERE candidate_id=? OR approval_id=? LIMIT 1')
  .bind(b.resource_id,b.request_id).first();
 if(!r||r.candidate_id!==b.resource_id||r.approval_id!==b.request_id||
  r.household_id!==b.household_id||r.requester_user_id!==b.requester_user_id||
  r.payload_sha256!==b.payload_sha256||
  r.operation_sha256!==b.operation_sha256)return refuse('receipt_not_reserved');
 if(r.status==='applied'){
  const exactReply=r.task_id===b.task_id&&r.approver_user_id===b.approver_user_id&&
   r.applied_at===b.applied_at;
  return exactReply?reply({ok:true,applied:true,task_id:r.task_id,already_applied:true})
   :refuse('receipt_identity_conflict');
 }
 const owner=await env.DB.prepare('SELECT l.local_user_id FROM homeflow_identity_links l '+
  'JOIN users u ON u.id=l.local_user_id WHERE l.homeflow_user_id=? '+
  "AND l.homeflow_household_id=? AND l.state='active' "+
  "AND u.role='owner' AND u.status='active' LIMIT 1")
  .bind(b.approver_user_id,b.household_id).first();
 if(!owner)return refuse('approver_identity_invalid');
 const at=isoNow();
 try{
  const result=await env.DB.batch([
   env.DB.prepare('UPDATE document_task_execution_reservations '+
    "SET status='applied',task_id=?,approver_user_id=?,applied_at=? "+
    "WHERE candidate_id=? AND approval_id=? AND status='executing' "+
    'AND household_id=? AND requester_user_id=? AND payload_sha256=? '+
    'AND operation_sha256=?')
    .bind(b.task_id,b.approver_user_id,b.applied_at,b.resource_id,b.request_id,
     b.household_id,b.requester_user_id,b.payload_sha256,b.operation_sha256),
   env.DB.prepare('INSERT INTO audit_events '+
    '(id,actor_user_id,kind,entity_type,entity_id,created_at) '+
    "SELECT ?,?,'document_task_applied_by_approver','candidate',?,? "+
    'FROM document_task_execution_reservations '+
    "WHERE candidate_id=? AND status='applied' AND changes()=1")
    .bind(randomToken(16),owner.local_user_id,b.resource_id,at,b.resource_id)
  ]);
  if(result.some(x=>x.meta?.changes!==1))return refuse('receipt_write_conflict',503);
 }catch{return refuse('receipt_write_conflict',503)}
 return reply({ok:true,applied:true,task_id:b.task_id,already_applied:false});
}
export async function documentTaskSourceRoute(req,env,mode){
 if(!enabled(env))return refuse('document_task_execution_disabled',503);
 if(!['prepare','receipt'].includes(mode))return refuse('not_found',404);
 const expected=mode==='prepare'?[...core,'execution_nonce']:
  [...core,'operation_sha256','task_id','approver_user_id','applied_at'];
 const b=await body(req,env.HOMEFLOW_DOCUMENT_EXECUTION_SECRET,
  mode==='prepare'?'homeflow:document-task-prepare':'homeflow:document-task-receipt',expected);
 if(!b)return refuse('unauthorized',403);
 return mode==='prepare'?prepare(env,b):recordReceipt(env,b);
}
