import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createHmac,webcrypto} from 'node:crypto';
import {documentTaskSourceRoute} from '../worker/document-task-source.js';
import {sealDocumentIntent} from '../worker/document-intent-crypto.js';
import {hashString} from '../worker/security.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const candidate='a'.repeat(32),doc='b'.repeat(32),hh='homeflow-household';
const approvalId='55555555-5555-4555-8555-555555555555',member='hf-member',owner='hf-owner';
const cipherKey='1'.repeat(64),sharedKey='2'.repeat(64),proofKey='3'.repeat(64),nonce='4'.repeat(64);
const sign=(domain,secret,stamp,raw)=>createHmac('sha256',Buffer.from(secret,'hex'))
 .update(domain+'\n'+stamp+'\n'+raw).digest('hex');
const request=(mode,body,overrides={})=>{
 const stamp=String(Date.now()),raw=JSON.stringify(body);
 return new Request('https://document.internal/api/internal/document-task/'+mode,{
  method:'POST',headers:{'content-type':'application/json','x-approval-client':'homeflow',
   'x-approval-timestamp':stamp,'x-approval-signature':sign('homeflow:document-task-'+mode,
    sharedKey,stamp,raw),...overrides},body:raw});
};
function sqlite(){
 const sql=new DatabaseSync(':memory:');
 sql.exec('PRAGMA foreign_keys=ON');
 for(const name of ['0001_init.sql','0003_password_auth.sql',
  '0020_homeflow_identity_links.sql','0021_homeflow_sso_pending.sql',
  '0022_homeflow_session_proofs.sql','0023_document_member_sync_intents.sql',
  '0024_document_execution_reservation.sql',
  '0025_document_task_execution_reservation.sql'])
  sql.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const db={prepare(q){return{bind(...args){return{
  first:async()=>sql.prepare(q).get(...args)||null,
  run:async()=>({meta:{changes:sql.prepare(q).run(...args).changes}}),
  sync:()=>({meta:{changes:sql.prepare(q).run(...args).changes}})
 }}}},async batch(stmts){
  sql.exec('BEGIN IMMEDIATE');
  try{const list=stmts.map(x=>x.sync());sql.exec('COMMIT');return list}
  catch(e){sql.exec('ROLLBACK');throw e}
 }};
 return {sql,db};
}
async function fixture(){
 const {sql,db}=sqlite(),now=new Date().toISOString();
 sql.prepare('INSERT INTO households(id,name,created_at,updated_at) VALUES(?,?,?,?)')
  .run('local','Home',now,now);
 for(const [local,id,role] of [['local-member',member,'member'],['local-owner',owner,'owner']]){
  sql.prepare('INSERT INTO users(id,household_id,email_norm,display_name,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
   .run(local,'local',local+'@test.invalid',local,role,now,now);
  sql.prepare('INSERT INTO homeflow_identity_links(homeflow_user_id,homeflow_household_id,local_user_id,verified_at) VALUES(?,?,?,?)')
   .run(id,hh,local,now);
 }
 sql.prepare('INSERT INTO documents(id,owner_id,household_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)')
  .run(doc,'local-member','local','Private original must not leak',now,now);
 sql.prepare('INSERT INTO action_candidates(id,document_id,candidate_kind,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)')
  .run(candidate,doc,'homeflow_task',
   JSON.stringify({task_type:'deadline',title:'配送確認',due_on:'2026-11-19'}),now,now);
 const task={operation:'task',title:'配送確認',dueOn:'2026-11-19',visibility:'private',
  assignee:null,bonusPoints:0,remindEnabled:true};
 const frozen=JSON.stringify({source_document_id:doc,source_candidate_id:candidate,
  source_document_version:1,candidate_updated_at:now,candidate_kind:'homeflow_task',
  homeflow_user_id:member,homeflow_household_id:hh,target_app:'homeflow',payload:task});
 const digest=await hashString(frozen);
 const env={APP_ENV:'production',DOCUMENT_TASK_EXECUTION_ENABLED:'true',
  HOMEFLOW_DOCUMENT_EXECUTION_SECRET:sharedKey,DOCUMENT_APPROVAL_VERIFICATION_SECRET:proofKey,
  DOCUMENT_INTENT_ENCRYPTION_KEY:cipherKey,DB:db};
 const identity={candidate_id:candidate,document_id:doc,local_user_id:'local-member',
  homeflow_user_id:member,homeflow_household_id:hh,target_app:'homeflow',
  candidate_kind:'homeflow_task',document_version:1,candidate_updated_at:now,
  payload_sha256:digest};
 const encrypted=await sealDocumentIntent(env,identity,frozen);
 sql.prepare('INSERT INTO document_member_sync_intents (candidate_id,document_id,'+
  'local_user_id,homeflow_user_id,homeflow_household_id,target_app,candidate_kind,'+
  'document_version,candidate_updated_at,payload_sha256,payload_cipher,payload_iv,'+
  "status,approval_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'submitted',?,?,?)")
  .run(candidate,doc,'local-member',member,hh,'homeflow','homeflow_task',1,now,digest,
   encrypted.payload_cipher,encrypted.payload_iv,approvalId,now,now);
 const wire={request_id:approvalId,resource_id:candidate,household_id:hh,
  requester_user_id:member,payload_sha256:digest,execution_nonce:nonce};
 let proofs=0;
 env.HOMEFLOW_BRIDGE_SERVICE={async fetch(req){
  proofs++;
  assert.equal(new URL(req.url).pathname,'/api/internal/approvals/verify');
  const raw=await req.text(),stamp=req.headers.get('x-approval-timestamp');
  assert.equal(req.headers.get('x-approval-signature'),
   sign('jpda:execution-proof',proofKey,stamp,raw));
  const b=JSON.parse(raw);
  assert.equal(b.request_id,approvalId);
  assert.equal(b.execution_nonce,nonce);
  assert.equal(b.idempotency_key,'jpda:sync:'+candidate);
  assert.doesNotMatch(raw,/Private original|配送確認/);
  return Response.json({ok:true,verified:true,execution_authorized:true,
   execution_status:'executing',source_app:'jp-document-assistant',
   target_app:'homeflow',operation:'document.sync.homeflow',
   resource_type:'document_sync_candidate',request_id:approvalId,
   resource_id:candidate,household_id:hh,requester_user_id:member,
   payload_sha256:digest,idempotency_key:'jpda:sync:'+candidate,
   expected_version:null,approver_user_id:owner,approved_at:Date.now()-1000,
   expires_at:Date.now()+300000,applied:false});
 }};
 const prepare=async(extra={})=>{
  const res=await documentTaskSourceRoute(request('prepare',wire,extra),env,'prepare');
  return {status:res.status,data:await res.json()}
 };
 const ack={request_id:approvalId,resource_id:candidate,household_id:hh,
  requester_user_id:member,payload_sha256:digest,
  operation_sha256:await hashString(JSON.stringify(task)),
  task_id:'99999999-9999-4999-8999-999999999999',
  approver_user_id:owner,applied_at:Date.now()};
 const receipt=async(b=ack,extra={})=>{
  const res=await documentTaskSourceRoute(request('receipt',b,extra),env,'receipt');
  return {status:res.status,data:await res.json()}
 };
 return {sql,env,wire,digest,task,prepare,receipt,ack,proofs:()=>proofs};
}
test('real encrypted task source preparation, version lock, exact signed receipt and replay',async()=>{
 const f=await fixture();
 try{
  const prepared=await f.prepare();
  assert.equal(prepared.status,200,JSON.stringify(prepared.data));
  assert.equal(prepared.data.verified,true);
  assert.equal(prepared.data.applied,false);
  assert.deepEqual(prepared.data.task,f.task);
  assert.equal(prepared.data.operation_sha256,f.ack.operation_sha256);
  assert.equal(f.sql.prepare('SELECT status FROM document_task_execution_reservations').get().status,'executing');
  assert.throws(()=>f.sql.prepare('UPDATE documents SET version=version+1 WHERE id=?').run(doc),/DOC_TASK_SOURCE_EXECUTING/);
  assert.throws(()=>f.sql.prepare('DELETE FROM action_candidates WHERE id=?').run(candidate),/DOC_TASK_SOURCE_EXECUTING/);
  const second=await f.prepare();
  assert.equal(second.status,200,JSON.stringify(second.data));
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM document_task_execution_reservations').get().n,1);
  const applied=await f.receipt();
  assert.equal(applied.status,200,JSON.stringify(applied.data));
  assert.equal(applied.data.applied,true);
  const r=f.sql.prepare('SELECT * FROM document_task_execution_reservations').get();
  assert.equal(r.status,'applied');
  assert.equal(r.task_id,f.ack.task_id);
  assert.equal(r.approver_user_id,owner);
  assert.equal(f.sql.prepare('SELECT actor_user_id FROM audit_events').get().actor_user_id,'local-owner');
  const replay=await f.receipt();
  assert.equal(replay.status,200);
  assert.equal(replay.data.already_applied,true);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM audit_events').get().n,1);
  assert.throws(()=>f.sql.prepare('DELETE FROM document_task_execution_reservations').run(),/NO_DELETE/);
 }finally{f.sql.close()}
});
test('revoked mapping, changed document and forged signature all fail closed before reservation',async()=>{
 for(const kind of ['revoked','version','badSignature','browser','disabled']){
  const f=await fixture();
  try{
   if(kind==='revoked')f.sql.prepare("UPDATE homeflow_identity_links SET state='revoked',revoked_at=? WHERE homeflow_user_id=?")
    .run(new Date().toISOString(),member);
   if(kind==='version')f.sql.prepare('UPDATE documents SET version=version+1 WHERE id=?').run(doc);
   if(kind==='disabled')f.env.DOCUMENT_TASK_EXECUTION_ENABLED='false';
   const res=kind==='badSignature'||kind==='browser'?
    await f.prepare(kind==='browser'?{origin:'https://bad.invalid'}:{'x-approval-signature':'0'.repeat(64)}):
    await f.prepare();
   assert.notEqual(res.status,200,kind);
   assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM document_task_execution_reservations').get().n,0,kind);
  }finally{f.sql.close()}
 }
});
test('receipt without reservation, wrong approver, altered digest and double IDs never mark applied',async()=>{
 const f=await fixture();
 try{
  assert.notEqual((await f.receipt()).status,200);
  assert.equal((await f.prepare()).status,200);
  for(const bad of [
   {...f.ack,approver_user_id:'intruder'},
   {...f.ack,operation_sha256:'e'.repeat(64)},
   {...f.ack,request_id:'11111111-1111-4111-8111-111111111111'}
  ]){
   assert.notEqual((await f.receipt(bad)).status,200);
  }
  assert.equal(f.sql.prepare('SELECT status FROM document_task_execution_reservations').get().status,'executing');
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM audit_events').get().n,0);
 }finally{f.sql.close()}
});
test('additive reservation migration replays without deleting an executing lock',async()=>{
 const f=await fixture();
 try{
  assert.equal((await f.prepare()).status,200);
  f.sql.exec(readFileSync(new URL('../migrations/0025_document_task_execution_reservation.sql',import.meta.url),'utf8'));
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM document_task_execution_reservations').get().n,1);
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name='idx_document_task_reservations_approval'").get().n,1);
 }finally{f.sql.close()}
});
