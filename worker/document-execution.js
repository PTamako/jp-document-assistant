// Signed HomeFlow execution -> private source -> verified target.
// The document backend alone opens the AES-GCM snapshot. Browser has no route
// to execute or read its contents. Network errors are receipt-unknown.
import {openDocumentIntent} from './document-intent-crypto.js';
import {hashString,randomToken,isoNow} from './security.js';
const hex=/^[a-f0-9]{64}$/i,id32=/^[a-f0-9]{32}$/i;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const core=['request_id','resource_id','household_id','requester_user_id','payload_sha256'];
const reply=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store'}});
const refuse=(code,status=409)=>reply({ok:false,code,applied:false},status);
const exactKeys=(o,k)=>o&&typeof o==='object'&&!Array.isArray(o)&&
 Object.keys(o).sort().join(',')===k.slice().sort().join(',');
const eq=(a,b)=>{if(!hex.test(a||'')||!hex.test(b||''))return false;let d=0;
 for(let i=0;i<64;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0};
async function mac(secret,domain,stamp,raw){
 const key=await crypto.subtle.importKey('raw',
 Uint8Array.from(secret.match(/.{2}/g),x=>parseInt(x,16)),
 {name:'HMAC',hash:'SHA-256'},false,['sign']);
 const sig=await crypto.subtle.sign('HMAC',key,
  new TextEncoder().encode(domain+'\n'+stamp+'\n'+raw));
 return Array.from(new Uint8Array(sig),x=>x.toString(16).padStart(2,'0')).join('');
}
async function signedBody(req,secret,client,domain,keys){
 if(req.method!=='POST'||req.headers.has('cookie')||req.headers.has('origin')||
  req.headers.has('authorization')||
  req.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')
  return null;
 const stamp=req.headers.get('x-approval-timestamp');
 const sig=req.headers.get('x-approval-signature');
 if(req.headers.get('x-approval-client')!==client||
  !/^\d{13}$/.test(stamp||'')||Math.abs(Date.now()-Number(stamp))>300000||
  !hex.test(sig||''))return null;
 let raw,b;try{raw=await req.text();if(raw.length>1600)return null;b=JSON.parse(raw)}
 catch{return null}
 if(!exactKeys(b,keys)||!eq(await mac(secret,domain,stamp,raw),sig)||
  !uuid.test(b.request_id)||!id32.test(b.resource_id)||
  !hex.test(b.payload_sha256)||typeof b.household_id!=='string'||
  !b.household_id||b.household_id.length>128||
  typeof b.requester_user_id!=='string'||!b.requester_user_id||
  b.requester_user_id.length>128||
  (b.execution_nonce!==undefined&&!hex.test(b.execution_nonce))||
  (b.operation_sha256!==undefined&&!hex.test(b.operation_sha256)))return null;
 return b;
}
async function sourceRow(db,b){
 return db.prepare('SELECT i.*,d.owner_id,d.lifecycle,d.version AS live_version,'+
  'c.updated_at AS live_candidate_updated_at,u.role AS local_role,'+
  'u.status AS local_status,l.state AS link_state,'+
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
const matches=(row,b)=>row&&row.status==='submitted'&&
 row.candidate_kind==='finance'&&row.target_app==='kakebo'&&
 row.homeflow_user_id===b.requester_user_id&&
 row.homeflow_household_id===b.household_id&&row.payload_sha256===b.payload_sha256;
const active=(r,b)=>matches(r,b)&&r.owner_id===r.local_user_id&&
 r.lifecycle==='active'&&r.document_version===r.live_version&&
 r.candidate_updated_at===r.live_candidate_updated_at&&
 r.local_role==='member'&&r.local_status==='active'&&
 r.link_state==='active'&&r.link_household===b.household_id;
async function operation(env,row,b){
 try{
  const text=await openDocumentIntent(env,row);
  if(!eq(await hashString(text),b.payload_sha256))return null;
  const s=JSON.parse(text),p=s.payload;
  if(s.source_document_id!==row.document_id||
   s.source_candidate_id!==b.resource_id||
   s.source_document_version!==row.document_version||
   s.candidate_updated_at!==row.candidate_updated_at||
   s.candidate_kind!=='finance'||s.target_app!=='kakebo'||
   s.homeflow_user_id!==b.requester_user_id||
   s.homeflow_household_id!==b.household_id||
   p?.operation!=='entry'||p.source_kind!=='document_assistant'||
   !['income','expense'].includes(p.type)||!id32.test(p.account_id||'')||
   !Number.isSafeInteger(p.account_version)||p.account_version<1||
   !Number.isSafeInteger(p.amount)||p.amount<1||p.amount>10000000||
   typeof p.date!=='string'||!/^20\d\d-\d\d-\d\d$/.test(p.date)||
   !Number.isFinite(Date.parse(p.date+'T00:00:00Z'))||
   new Date(p.date+'T00:00:00Z').toISOString().slice(0,10)!==p.date||
   typeof p.category!=='string'||!p.category||p.category.length>80||
   typeof p.merchant!=='string'||!p.merchant||p.merchant.length>100||
   typeof p.note!=='string'||p.note.length>180||
   typeof p.paymentSource!=='string'||!p.paymentSource||p.paymentSource.length>100)
   return null;
  const op={account_id:p.account_id,account_version:p.account_version,
   type:p.type,amount_jpy:p.amount,date:p.date,merchant:p.merchant,
   category:p.category,note:p.note,payment_source:p.paymentSource};
  return {...op,operation_sha256:await hashString(JSON.stringify(op))};
 }catch{return null}
}
async function currentProof(env,b){
 const q={...b,idempotency_key:'jpda:sync:'+b.resource_id,
  expected_version:null,purpose:'execute'};
 const raw=JSON.stringify(q),stamp=String(Date.now());
 try{
  const res=await env.HOMEFLOW_BRIDGE_SERVICE.fetch(new Request(
   'https://homeflow.internal/api/internal/approvals/verify',{
   method:'POST',redirect:'manual',headers:{'content-type':'application/json',
    'x-approval-client':'jp-document-assistant','x-approval-timestamp':stamp,
    'x-approval-signature':await mac(env.DOCUMENT_APPROVAL_VERIFICATION_SECRET,
     'jpda:execution-proof',stamp,raw)},body:raw}));
  if(res.status!==200||res.headers.has('location'))return false;
  const text=await res.text();if(text.length>1900)return false;
  const p=JSON.parse(text);
  return p?.ok===true&&p.verified===true&&p.execution_authorized===true&&
   p.execution_status==='executing'&&p.operation==='document.sync.finance'&&
   p.source_app==='jp-document-assistant'&&p.target_app==='kakebo'&&
   p.resource_type==='document_sync_candidate'&&p.request_id===b.request_id&&
   p.resource_id===b.resource_id&&p.household_id===b.household_id&&
   p.requester_user_id===b.requester_user_id&&p.payload_sha256===b.payload_sha256&&
   p.idempotency_key==='jpda:sync:'+b.resource_id&&p.expected_version===null&&
   p.approver_user_id&&p.approver_user_id!==b.requester_user_id&&
   Number.isSafeInteger(p.approved_at)&&Number.isSafeInteger(p.expires_at)&&
   p.expires_at>Date.now()&&p.applied===false;
 }catch{return false}
}
async function reservation(db,b){
 await db.prepare('INSERT OR IGNORE INTO document_member_execution_reservations '+
 '(candidate_id,approval_id,document_id,requester_user_id,household_id,'+
 'payload_sha256,status,reserved_at) '+
 'SELECT i.candidate_id,i.approval_id,i.document_id,i.homeflow_user_id,'+
 'i.homeflow_household_id,i.payload_sha256,\'executing\',? '+
 'FROM document_member_sync_intents i '+
 'JOIN documents d ON d.id=i.document_id '+
 'JOIN action_candidates c ON c.id=i.candidate_id AND c.document_id=d.id '+
 'JOIN homeflow_identity_links l ON l.homeflow_user_id=i.homeflow_user_id '+
 'AND l.local_user_id=i.local_user_id '+
 'JOIN users u ON u.id=i.local_user_id '+
 'WHERE i.candidate_id=? AND i.approval_id=? AND i.payload_sha256=? '+
 'AND i.status=\'submitted\' AND i.candidate_kind=\'finance\' '+
 'AND i.target_app=\'kakebo\' AND d.owner_id=i.local_user_id '+
 'AND d.lifecycle=\'active\' AND d.version=i.document_version '+
 'AND c.updated_at=i.candidate_updated_at AND l.state=\'active\' '+
 'AND l.homeflow_household_id=i.homeflow_household_id '+
 'AND u.status=\'active\' AND u.role=\'member\' '+
 'AND NOT EXISTS(SELECT 1 FROM integration_links x WHERE x.candidate_id=i.candidate_id)')
 .bind(Date.now(),b.resource_id,b.request_id,b.payload_sha256).run();
 return db.prepare('SELECT * FROM document_member_execution_reservations WHERE approval_id=?')
 .bind(b.request_id).first();
}
const sameReservation=(r,b)=>r&&r.approval_id===b.request_id&&
 r.candidate_id===b.resource_id&&r.requester_user_id===b.requester_user_id&&
 r.household_id===b.household_id&&r.payload_sha256===b.payload_sha256;
async function target(env,b,op,receiptOnly){
 const fields=receiptOnly?b:{...b,...op};
 const raw=JSON.stringify(fields),stamp=String(Date.now());
 try{
  const response=await env.KAKEIBO_DOCUMENT_FINANCE_SERVICE.fetch(new Request(
   'https://kakeibo.internal/api/internal/document-finance/'+
   (receiptOnly?'receipt':'execute'),{
   method:'POST',redirect:'manual',headers:{'content-type':'application/json',
    'x-approval-client':'jp-document-assistant','x-approval-timestamp':stamp,
    'x-approval-signature':await mac(env.DOCUMENT_FINANCE_TARGET_SECRET,
     receiptOnly?'jpda:finance-receipt':'jpda:finance-execute',stamp,raw)},
   body:raw}));
  if(response.status!==200||response.headers.has('location'))return null;
  const text=await response.text();if(text.length>1900)return null;
  const result=JSON.parse(text);
  return result?.ok===true&&result.applied===true&&
   result.approval_id===b.request_id&&result.candidate_id===b.resource_id&&
   result.household_id===b.household_id&&
   result.requester_user_id===b.requester_user_id&&
   result.payload_sha256===b.payload_sha256&&
   Number.isSafeInteger(result.entry_id)&&result.entry_id>0&&
   Number.isSafeInteger(result.applied_at)&&result.applied_at>0&&
   result.approver_user_id&&result.approver_user_id!==b.requester_user_id&&
   (receiptOnly||result.operation_sha256===op.operation_sha256)?result:null;
 }catch{return null}
}
async function saveReceipt(db,b,receipt){
 const r=await db.prepare('SELECT * FROM document_member_execution_reservations WHERE approval_id=?')
 .bind(b.request_id).first();
 if(!sameReservation(r,b))return false;
 if(r.status==='applied')return r.target_entry_id===receipt.entry_id&&
  r.applied_at===receipt.applied_at&&r.approver_user_id===receipt.approver_user_id;
 try{
  const changes=await db.batch([
   db.prepare('UPDATE document_member_execution_reservations '+
    'SET status=\'applied\',target_entry_id=?,approver_user_id=?,applied_at=? '+
    'WHERE status=\'executing\' AND approval_id=? AND candidate_id=? AND payload_sha256=?')
    .bind(receipt.entry_id,receipt.approver_user_id,receipt.applied_at,
     b.request_id,b.resource_id,b.payload_sha256),
   db.prepare('INSERT INTO audit_events(id,actor_user_id,kind,entity_type,entity_id,created_at) '+
    'SELECT ?,l.local_user_id,\'document_sync_applied_by_approver\',\'candidate\',r.candidate_id,? '+
    'FROM document_member_execution_reservations r '+
    'JOIN homeflow_identity_links l ON l.homeflow_user_id=r.approver_user_id '+
    'AND l.homeflow_household_id=r.household_id AND l.state=\'active\' '+
    'WHERE r.approval_id=? AND changes()=1')
    .bind(randomToken(16),isoNow(),b.request_id)
  ]);
  return changes.length===2&&changes.every(x=>x.meta?.changes===1);
 }catch{
  const raced=await db.prepare('SELECT * FROM document_member_execution_reservations WHERE approval_id=?')
    .bind(b.request_id).first().catch(()=>null);
  return sameReservation(raced,b)&&raced.status==='applied'&&
   raced.target_entry_id===receipt.entry_id&&raced.applied_at===receipt.applied_at&&
   raced.approver_user_id===receipt.approver_user_id;
 }
}
const shape=(b,r)=>({ok:true,applied:true,status:'applied',approval_id:b.request_id,
 candidate_id:b.resource_id,household_id:b.household_id,
 requester_user_id:b.requester_user_id,payload_sha256:b.payload_sha256,
 entry_id:r.entry_id,applied_at:r.applied_at,already_applied:r.already_applied===true});
export async function documentExecutionRoute(request,env,mode){
 if(env.APP_ENV!=='production'||env.DOCUMENT_EXECUTION_ENABLED!=='true'||!hex.test(env.HOMEFLOW_DOCUMENT_EXECUTION_SECRET||'')||
  !hex.test(env.DOCUMENT_APPROVAL_VERIFICATION_SECRET||'')||
  !hex.test(env.DOCUMENT_FINANCE_TARGET_SECRET||'')||
  !hex.test(env.DOCUMENT_INTENT_ENCRYPTION_KEY||'')||
  typeof env.HOMEFLOW_BRIDGE_SERVICE?.fetch!=='function'||
  typeof env.KAKEIBO_DOCUMENT_FINANCE_SERVICE?.fetch!=='function'||
  typeof env.DB?.prepare!=='function')return refuse('DOCUMENT_EXECUTION_DISABLED',503);
 if(!['execute','receipt','source-check'].includes(mode))return refuse('NOT_FOUND',404);
 const check=mode==='source-check',receiptOnly=mode==='receipt';
 const b=await signedBody(request,check?env.DOCUMENT_FINANCE_TARGET_SECRET:
  env.HOMEFLOW_DOCUMENT_EXECUTION_SECRET,check?'kakeibo':'homeflow',
  check?'kakeibo:document-source-check':
    receiptOnly?'homeflow:document-receipt':'homeflow:document-execute',
  check?[...core,'operation_sha256']:receiptOnly?core:[...core,'execution_nonce']);
 if(!b)return refuse('UNAUTHORIZED',403);
 const db=env.DB,r=await sourceRow(db,b);
 if(!matches(r,b))return refuse('SOURCE_IDENTITY_CONFLICT',409);
 if(check){
  if(!active(r,b))return refuse('SOURCE_CHANGED',409);
  const lock=await db.prepare('SELECT * FROM document_member_execution_reservations WHERE approval_id=?')
   .bind(b.request_id).first();
  const op=await operation(env,r,b);
  if(!sameReservation(lock,b)||lock.status!=='executing'||!op||
   op.operation_sha256!==b.operation_sha256)return refuse('SOURCE_NOT_EXECUTABLE',409);
  return reply({ok:true,verified:true,applied:false,
   approval_id:b.request_id,candidate_id:b.resource_id,
   household_id:b.household_id,requester_user_id:b.requester_user_id,
   payload_sha256:b.payload_sha256,operation_sha256:op.operation_sha256});
 }
 if(receiptOnly){
  const receipt=await target(env,b,null,true);
  if(!receipt)return refuse('RECEIPT_UNKNOWN',503);
  const lock=await db.prepare('SELECT * FROM document_member_execution_reservations WHERE approval_id=?')
   .bind(b.request_id).first();
  if(!sameReservation(lock,b)||!await saveReceipt(db,b,receipt))
   return refuse('SOURCE_RECEIPT_UNCONFIRMED',503);
  return reply(shape(b,receipt));
 }
 if(!active(r,b))return refuse('SOURCE_CHANGED',409);
 const op=await operation(env,r,b);
 if(!op||!await currentProof(env,b))return refuse('SOURCE_OR_APPROVAL_CHANGED',409);
 let lock;try{lock=await reservation(db,b)}catch{return refuse('RESERVATION_FAILED',503)}
 if(!sameReservation(lock,b))return refuse('RESERVATION_CONFLICT',409);
 const receipt=await target(env,b,{...op,execution_nonce:b.execution_nonce},false);
 if(!receipt)return refuse('TARGET_RECEIPT_UNKNOWN',503);
 if(!await saveReceipt(db,b,receipt))return refuse('SOURCE_RECEIPT_UNCONFIRMED',503);
 return reply(shape(b,receipt));
}
