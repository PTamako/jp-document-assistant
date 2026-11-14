// Private document -> Study execution. All mutation entry points are signed,
// backend-only, and default OFF. The source holds its own encrypted snapshot,
// lease-bound reservation, and a durable copy of the target's exact receipt.
// HomeFlow receives an opaque candidate ID, never a private vocabulary term.
import {openDocumentIntent,documentIntentKeyReady} from './document-intent-crypto.js';
import {hashString,randomToken,isoNow} from './security.js';

const hex=/^[a-f0-9]{64}$/i,id32=/^[a-f0-9]{32}$/i;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const core=['request_id','resource_id','household_id','requester_user_id','payload_sha256'];
const exact=(o,keys)=>!!o&&typeof o==='object'&&!Array.isArray(o)&&
 Object.keys(o).sort().join(',')===keys.slice().sort().join(',');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&
 Array.from(a).reduce((d,x,i)=>d|(x.charCodeAt(0)^b.charCodeAt(i)),0)===0;
const reply=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
const reject=(code,status=409)=>reply({ok:false,code,applied:false},status);
const enabled=e=>e.APP_ENV==='production'&&e.DOCUMENT_STUDY_EXECUTION_ENABLED==='true'&&
 hex.test(e.HOMEFLOW_STUDY_EXECUTION_SECRET||'')&&
 hex.test(e.DOCUMENT_APPROVAL_VERIFICATION_SECRET||'')&&
 hex.test(e.DOCUMENT_STUDY_TARGET_SECRET||'')&&
 hex.test(e.STUDY_DOCUMENT_SOURCE_SECRET||'')&&documentIntentKeyReady(e)&&
 !!e.DB?.prepare&&typeof e.HOMEFLOW_BRIDGE_SERVICE?.fetch==='function'&&
 typeof e.STUDY_DOCUMENT_EXECUTION_SERVICE?.fetch==='function';
async function hmac(secret,domain,stamp,raw){
 const k=await crypto.subtle.importKey('raw',Uint8Array.from(
  secret.match(/.{2}/g),x=>parseInt(x,16)),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const out=await crypto.subtle.sign('HMAC',k,
  new TextEncoder().encode(domain+'\n'+stamp+'\n'+raw));
 return Array.from(new Uint8Array(out),b=>b.toString(16).padStart(2,'0')).join('');
}
async function signed(req,secret,client,domain,keys){
 if(req.method!=='POST'||req.headers.has('origin')||req.headers.has('cookie')||
  req.headers.has('authorization')||
  req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/json'||
  req.headers.get('x-approval-client')!==client)return null;
 const stamp=req.headers.get('x-approval-timestamp')||'',
  signature=req.headers.get('x-approval-signature')||'';
 if(!/^\d{13}$/.test(stamp)||Math.abs(Date.now()-Number(stamp))>300000||
  !hex.test(signature))return null;
 let raw,b;try{raw=await req.text();if(raw.length>2500)return null;b=JSON.parse(raw)}
 catch{return null}
 if(!exact(b,keys)||!uuid.test(b.request_id)||!id32.test(b.resource_id)||
  !hex.test(b.payload_sha256)||typeof b.household_id!=='string'||
  !b.household_id||b.household_id.length>128||
  typeof b.requester_user_id!=='string'||!b.requester_user_id||
  b.requester_user_id.length>128||
  (b.execution_nonce!==undefined&&!hex.test(b.execution_nonce)))return null;
 return equal(await hmac(secret,domain,stamp,raw),signature)?b:null;
}
async function sourceRow(db,b){
 return db.prepare('SELECT i.*,d.owner_id,d.lifecycle,d.version AS live_version,'+
  'c.updated_at AS live_candidate_updated_at,c.payload_json AS live_candidate_payload,'+
  'u.role AS local_role,u.status AS local_status,l.state AS link_state,'+
  'l.homeflow_household_id AS link_household '+
  'FROM document_member_sync_intents i '+
  'JOIN documents d ON d.id=i.document_id '+
  'JOIN action_candidates c ON c.id=i.candidate_id AND c.document_id=d.id '+
  'JOIN users u ON u.id=i.local_user_id '+
  'JOIN homeflow_identity_links l ON l.homeflow_user_id=i.homeflow_user_id '+
  'AND l.local_user_id=i.local_user_id '+
  'WHERE i.approval_id=? AND i.candidate_id=? LIMIT 1')
  .bind(b.request_id,b.resource_id).first();
}
const matching=(r,b)=>!!r&&r.status==='submitted'&&
 r.target_app==='it-study-platform'&&['vocabulary','sentence'].includes(r.candidate_kind)&&
 r.homeflow_user_id===b.requester_user_id&&r.homeflow_household_id===b.household_id&&
 r.payload_sha256===b.payload_sha256;
const live=(r,b)=>matching(r,b)&&r.owner_id===r.local_user_id&&
 r.lifecycle==='active'&&r.document_version===r.live_version&&
 r.candidate_updated_at===r.live_candidate_updated_at&&
 r.local_role==='member'&&r.local_status==='active'&&r.link_state==='active'&&
 r.link_household===b.household_id;
async function frozen(env,row,b){
 try{
  const snapshot=await openDocumentIntent(env,row);
  if(!equal(await hashString(snapshot),b.payload_sha256)||snapshot.length>5000)return null;
  const s=JSON.parse(snapshot),p=s.payload;
  if(!exact(s,['source_document_id','source_candidate_id','source_document_version',
   'candidate_updated_at','candidate_kind','homeflow_user_id','homeflow_household_id',
   'target_app','payload'])||!p||typeof p!=='object'||Array.isArray(p)||
   s.source_document_id!==row.document_id||s.source_candidate_id!==b.resource_id||
   s.source_document_version!==row.document_version||
   s.candidate_updated_at!==row.candidate_updated_at||
   s.candidate_kind!==row.candidate_kind||s.target_app!=='it-study-platform'||
   s.homeflow_user_id!==b.requester_user_id||
   s.homeflow_household_id!==b.household_id||
   p.operation!==row.candidate_kind||p.language!=='ja'||p.skip_existing!==true)
   return null;
  return {snapshot,kind:row.candidate_kind};
 }catch{return null}
}
async function proof(env,b){
 const wire={...Object.fromEntries(core.map(k=>[k,b[k]])),
  idempotency_key:'jpda:sync:'+b.resource_id,expected_version:null,
  purpose:'execute',execution_nonce:b.execution_nonce};
 const raw=JSON.stringify(wire),stamp=String(Date.now());
 try{
  const response=await env.HOMEFLOW_BRIDGE_SERVICE.fetch(new Request(
   'https://homeflow.internal/api/internal/approvals/verify',{
   method:'POST',redirect:'manual',headers:{'content-type':'application/json',
    'x-approval-client':'jp-document-assistant','x-approval-timestamp':stamp,
    'x-approval-signature':await hmac(env.DOCUMENT_APPROVAL_VERIFICATION_SECRET,
     'jpda:execution-proof',stamp,raw)},body:raw}));
  if(response.status!==200||response.headers.has('location'))return false;
  const text=await response.text();if(text.length>2300)return false;
  const v=JSON.parse(text);
  return v.ok===true&&v.verified===true&&v.execution_authorized===true&&
   v.execution_status==='executing'&&v.source_app==='jp-document-assistant'&&
   v.target_app==='it-study-platform'&&v.operation==='document.sync.study'&&
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
async function reservation(db,row,b){
 const nonceHash=await hashString(b.execution_nonce);
 let r=await db.prepare('SELECT * FROM document_study_execution_reservations '+
  'WHERE approval_id=? OR candidate_id=? LIMIT 1').bind(b.request_id,b.resource_id).first();
 if(r){
  if(r.approval_id!==b.request_id||r.candidate_id!==b.resource_id||
   r.document_id!==row.document_id||r.requester_user_id!==b.requester_user_id||
   r.household_id!==b.household_id||r.payload_sha256!==b.payload_sha256||
   r.candidate_kind!==row.candidate_kind)return null;
  if(r.status==='executing'&&!equal(r.nonce_sha256,nonceHash)){
   await db.prepare('UPDATE document_study_execution_reservations SET nonce_sha256=? '+
    "WHERE approval_id=? AND candidate_id=? AND status='executing'")
    .bind(nonceHash,b.request_id,b.resource_id).run();
   r=await db.prepare('SELECT * FROM document_study_execution_reservations WHERE approval_id=?')
    .bind(b.request_id).first();
  }
  return r&&r.nonce_sha256===nonceHash?r:null;
 }
 await db.prepare('INSERT OR IGNORE INTO document_study_execution_reservations '+
  '(candidate_id,approval_id,document_id,requester_user_id,household_id,payload_sha256,'+
  "nonce_sha256,candidate_kind,status,reserved_at) "+
  "SELECT i.candidate_id,i.approval_id,i.document_id,i.homeflow_user_id,"+
  "i.homeflow_household_id,i.payload_sha256,?,i.candidate_kind,'executing',? "+
  'FROM document_member_sync_intents i '+
  'JOIN documents d ON d.id=i.document_id '+
  'JOIN action_candidates c ON c.id=i.candidate_id AND c.document_id=d.id '+
  'JOIN homeflow_identity_links l ON l.homeflow_user_id=i.homeflow_user_id '+
  'AND l.local_user_id=i.local_user_id JOIN users u ON u.id=i.local_user_id '+
  "WHERE i.candidate_id=? AND i.approval_id=? AND i.status='submitted' "+
  "AND i.target_app='it-study-platform' AND i.candidate_kind IN('vocabulary','sentence') "+
  'AND i.payload_sha256=? AND d.owner_id=i.local_user_id '+
  "AND d.lifecycle='active' AND d.version=i.document_version "+
  "AND c.updated_at=i.candidate_updated_at AND l.state='active' "+
  "AND l.homeflow_household_id=i.homeflow_household_id AND u.role='member' "+
  "AND u.status='active' AND NOT EXISTS(SELECT 1 FROM integration_links x "+
  'WHERE x.candidate_id=i.candidate_id)')
  .bind(nonceHash,Date.now(),b.resource_id,b.request_id,b.payload_sha256).run();
 r=await db.prepare('SELECT * FROM document_study_execution_reservations WHERE approval_id=?')
  .bind(b.request_id).first();
 return r&&r.candidate_id===b.resource_id&&r.requester_user_id===b.requester_user_id&&
  r.household_id===b.household_id&&r.payload_sha256===b.payload_sha256&&
  r.nonce_sha256===nonceHash?r:null;
}
const same=(r,b)=>r&&r.approval_id===b.request_id&&r.candidate_id===b.resource_id&&
 r.requester_user_id===b.requester_user_id&&r.household_id===b.household_id&&
 r.payload_sha256===b.payload_sha256;
async function target(env,mode,b,snapshot){
 const data=mode==='receipt'?Object.fromEntries(core.map(k=>[k,b[k]])):
  {...Object.fromEntries(core.map(k=>[k,b[k]])),
   execution_nonce:b.execution_nonce,snapshot};
 const raw=JSON.stringify(data),stamp=String(Date.now());
 try{
  const response=await env.STUDY_DOCUMENT_EXECUTION_SERVICE.fetch(new Request(
   'https://study.internal/api/internal/document-study/'+mode,{
   method:'POST',redirect:'manual',headers:{'content-type':'application/json',
    'x-approval-client':'jp-document-assistant','x-approval-timestamp':stamp,
    'x-approval-signature':await hmac(env.DOCUMENT_STUDY_TARGET_SECRET,
     'jpda:study-'+mode,stamp,raw)},body:raw}));
  if(response.status!==200||response.headers.has('location'))return null;
  const text=await response.text();if(text.length>2300)return null;
  const r=JSON.parse(text);
  return r.ok===true&&r.applied===true&&r.approval_id===b.request_id&&
   r.candidate_id===b.resource_id&&r.household_id===b.household_id&&
   r.requester_user_id===b.requester_user_id&&r.payload_sha256===b.payload_sha256&&
   ['vocabulary','sentence'].includes(r.kind)&&
   typeof r.remote_id==='string'&&r.remote_id.length>0&&r.remote_id.length<=256&&
   Number.isSafeInteger(r.applied_at)&&r.applied_at>0&&
   typeof r.approver_user_id==='string'&&r.approver_user_id&&
   r.approver_user_id!==b.requester_user_id?r:null;
 }catch{return null}
}
async function save(db,r,b,receipt){
 if(!same(r,b)||receipt.kind!==r.candidate_kind)return false;
 if(r.status==='applied')return r.target_remote_id===receipt.remote_id&&
  r.approver_user_id===receipt.approver_user_id&&r.applied_at===receipt.applied_at;
 const localOwner=await db.prepare('SELECT l.local_user_id FROM homeflow_identity_links l '+
  'JOIN users u ON u.id=l.local_user_id WHERE l.homeflow_user_id=? '+
  "AND l.homeflow_household_id=? AND u.role='owner' LIMIT 1")
  .bind(receipt.approver_user_id,b.household_id).first();
 if(!localOwner)return false;
 try{
  const tx=await db.batch([
   db.prepare('UPDATE document_study_execution_reservations '+
    "SET status='applied',target_remote_id=?,approver_user_id=?,applied_at=? "+
    "WHERE approval_id=? AND candidate_id=? AND status='executing' "+
    'AND requester_user_id=? AND household_id=? AND payload_sha256=?')
    .bind(receipt.remote_id,receipt.approver_user_id,receipt.applied_at,
     b.request_id,b.resource_id,b.requester_user_id,b.household_id,b.payload_sha256),
   db.prepare('INSERT INTO audit_events(id,actor_user_id,kind,entity_type,entity_id,created_at) '+
    "SELECT ?,?,'document_study_applied_by_approver','candidate',?,? "+
    'FROM document_study_execution_reservations '+
    "WHERE candidate_id=? AND status='applied' AND changes()=1")
    .bind(randomToken(16),localOwner.local_user_id,b.resource_id,isoNow(),b.resource_id)
  ]);
  return tx.every(x=>x.meta?.changes===1);
 }catch{
  const current=await db.prepare('SELECT * FROM document_study_execution_reservations '+
   'WHERE approval_id=?').bind(b.request_id).first().catch(()=>null);
  return same(current,b)&&current.status==='applied'&&
   current.target_remote_id===receipt.remote_id&&
   current.approver_user_id===receipt.approver_user_id&&
   current.applied_at===receipt.applied_at;
 }
}
function shape(b,r,replayed){
 return {ok:true,applied:true,approval_id:b.request_id,candidate_id:b.resource_id,
  household_id:b.household_id,requester_user_id:b.requester_user_id,
  payload_sha256:b.payload_sha256,remote_id:b.resource_id,
  approver_user_id:r.approver_user_id,applied_at:r.applied_at,already_applied:replayed};
}
export async function documentStudySourceRoute(request,env,mode){
 if(!enabled(env))return reject('document_study_execution_disabled',503);
 if(!['execute','receipt','source-check'].includes(mode))return reject('not_found',404);
 const check=mode==='source-check',receiptOnly=mode==='receipt';
 const b=await signed(request,check?env.STUDY_DOCUMENT_SOURCE_SECRET:
  env.HOMEFLOW_STUDY_EXECUTION_SECRET,check?'it-study-platform':'homeflow',
  check?'it-study:document-source-check':'homeflow:document-study-'+mode,
  check?[...core,'execution_nonce']:receiptOnly?core:[...core,'execution_nonce']);
 if(!b)return reject('unauthorized',403);
 const r=await sourceRow(env.DB,b);
 if(!matching(r,b))return reject('source_identity_conflict');
 let stored=await env.DB.prepare('SELECT * FROM document_study_execution_reservations '+
  'WHERE approval_id=? OR candidate_id=? LIMIT 1').bind(b.request_id,b.resource_id).first();
 if(check){
  if(!live(r,b)||!stored||stored.status!=='executing'||!same(stored,b)||
   !equal(stored.nonce_sha256,await hashString(b.execution_nonce))||
   !await frozen(env,r,b)||!await proof(env,b))
   return reject('study_source_not_executable');
  return reply({ok:true,verified:true,reserved:true,applied:false,
   approval_id:b.request_id,candidate_id:b.resource_id,household_id:b.household_id,
   requester_user_id:b.requester_user_id,payload_sha256:b.payload_sha256,
   snapshot_sha256:b.payload_sha256,execution_nonce_hash:stored.nonce_sha256});
 }
 if(stored?.status==='applied'){
  return same(stored,b)?reply(shape(b,stored,true)):reject('receipt_identity_conflict');
 }
 if(receiptOnly){
  if(!same(stored,b))return reject('receipt_not_reserved');
  const original=await target(env,'receipt',b,null);
  if(!original||!await save(env.DB,stored,b,original))
   return reject('study_receipt_unknown',503);
  return reply(shape(b,original,true));
 }
 if(!live(r,b))return reject('study_source_changed');
 const frozenIntent=await frozen(env,r,b);
 if(!frozenIntent||!await proof(env,b))return reject('study_source_or_proof_changed');
 try{stored=await reservation(env.DB,r,b)}catch{return reject('study_reservation_failed',503)}
 if(!same(stored,b))return reject('study_reservation_conflict');
 // A lost target response is repaired from the immutable target journal
 // before ever attempting another write with this request_id.
 const original=await target(env,'receipt',b,null);
 const result=original||await target(env,'execute',b,frozenIntent.snapshot);
 if(!result||!await save(env.DB,stored,b,result))
  return reject('study_target_receipt_unknown',503);
 return reply(shape(b,result,!!original||result.already_applied===true));
}
