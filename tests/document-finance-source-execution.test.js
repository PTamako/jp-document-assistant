import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {webcrypto,createHmac} from 'node:crypto';
import {documentExecutionRoute} from '../worker/document-execution.js';
import {sealDocumentIntent} from '../worker/document-intent-crypto.js';
import {hashString} from '../worker/security.js';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const doc='b'.repeat(32),candidate='a'.repeat(32);
const requestId='55555555-5555-4555-8555-555555555555';
const actor='hf-member',approver='hf-owner',hh='primary';
const cipherKey='1'.repeat(64),executeKey='2'.repeat(64);
const proofKey='3'.repeat(64),targetKey='4'.repeat(64);
const nonce='5'.repeat(64);
const signed=(domain,secret,stamp,raw)=>createHmac('sha256',Buffer.from(secret,'hex'))
  .update(domain+'\n'+stamp+'\n'+raw).digest('hex');
function database(){
 const sql=new DatabaseSync(':memory:');
 for(const name of ['0001_init.sql','0003_password_auth.sql',
   '0020_homeflow_identity_links.sql','0021_homeflow_sso_pending.sql',
   '0022_homeflow_session_proofs.sql','0023_document_member_sync_intents.sql',
   '0024_document_execution_reservation.sql'])
  sql.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const wrap=statement=>({
  bind(...values){return{
   first:async()=>sql.prepare(statement).get(...values)||null,
   run:async()=>({meta:{changes:sql.prepare(statement).run(...values).changes}}),
   sync:()=>({meta:{changes:sql.prepare(statement).run(...values).changes}})
  }}
 });
 const db={prepare:wrap,async batch(items){
  sql.exec('BEGIN IMMEDIATE');
  try{
   const out=items.map(x=>x.sync());
   sql.exec('COMMIT');return out;
  }catch(e){sql.exec('ROLLBACK');throw e}
 }};
 return {sql,db};
}
async function fixture(){
 const {sql,db}=database(),now=new Date().toISOString();
 sql.prepare('INSERT INTO households(id,name,created_at,updated_at) VALUES(?,?,?,?)')
  .run('local','Home',now,now);
 for(const [local,home,role] of [['local-member',actor,'member'],
   ['local-owner',approver,'owner']]){
  sql.prepare('INSERT INTO users(id,household_id,email_norm,display_name,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
   .run(local,'local',local+'@test.invalid',local,role,now,now);
  sql.prepare('INSERT INTO homeflow_identity_links(homeflow_user_id,homeflow_household_id,local_user_id,verified_at) VALUES(?,?,?,?)')
   .run(home,hh,local,now);
 }
 sql.prepare('INSERT INTO documents(id,owner_id,household_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)')
  .run(doc,'local-member','local','私人收据',now,now);
 sql.prepare('INSERT INTO action_candidates(id,document_id,candidate_kind,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)')
  .run(candidate,doc,'finance',JSON.stringify({kind:'expense'}),now,now);
 const payload={operation:'entry',type:'expense',date:'2026-11-14',
  amount:1420,category:'食費',merchant:'セブン-イレブン',note:'现金收据',
  paymentSource:'现金',source_kind:'document_assistant',
  account_id:'c'.repeat(32),account_version:1,account_kind:'cash'};
 const snapshot=JSON.stringify({source_document_id:doc,source_candidate_id:candidate,
  source_document_version:1,candidate_updated_at:now,candidate_kind:'finance',
  homeflow_user_id:actor,homeflow_household_id:hh,target_app:'kakebo',payload});
 const digest=await hashString(snapshot),env={
  APP_ENV:'production',DOCUMENT_EXECUTION_ENABLED:'true',
  HOMEFLOW_DOCUMENT_EXECUTION_SECRET:executeKey,
  DOCUMENT_APPROVAL_VERIFICATION_SECRET:proofKey,
  DOCUMENT_FINANCE_TARGET_SECRET:targetKey,
  DOCUMENT_INTENT_ENCRYPTION_KEY:cipherKey,DB:db
 };
 const identity={candidate_id:candidate,document_id:doc,local_user_id:'local-member',
  homeflow_user_id:actor,homeflow_household_id:hh,target_app:'kakebo',
  candidate_kind:'finance',document_version:1,candidate_updated_at:now,
  payload_sha256:digest};
 const encrypted=await sealDocumentIntent(env,identity,snapshot);
 sql.prepare('INSERT INTO document_member_sync_intents (candidate_id,document_id,'+
  'local_user_id,homeflow_user_id,homeflow_household_id,target_app,candidate_kind,'+
  'document_version,candidate_updated_at,payload_sha256,payload_cipher,payload_iv,'+
  'status,approval_id,created_at,updated_at) '+
  'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'+"'submitted'"+',?,?,?)')
 .run(candidate,doc,'local-member',actor,hh,'kakebo','finance',1,now,digest,
  encrypted.payload_cipher,encrypted.payload_iv,requestId,now,now);
 const wire={request_id:requestId,resource_id:candidate,household_id:hh,
  requester_user_id:actor,payload_sha256:digest,execution_nonce:nonce};
 const counters={homeflow:0,target:0,sourceCheck:0};
 let persisted=null;
 env.HOMEFLOW_BRIDGE_SERVICE={async fetch(req){
  counters.homeflow++;
  assert.equal(new URL(req.url).pathname,'/api/internal/approvals/verify');
  assert.equal(req.headers.get('origin'),null);
  assert.equal(req.headers.get('cookie'),null);
  const raw=await req.text(),stamp=req.headers.get('x-approval-timestamp');
  assert.equal(req.headers.get('x-approval-signature'),
   signed('jpda:execution-proof',proofKey,stamp,raw));
  const b=JSON.parse(raw);
  assert.equal(b.execution_nonce,nonce);
  assert.equal(b.idempotency_key,'jpda:sync:'+candidate);
  assert.equal(b.purpose,'execute');
  assert.equal(b.expected_version,null);
  assert.equal(b.payload_sha256,digest);
  assert.doesNotMatch(raw,/セブン|现金收据|私人收据/);
  return Response.json({ok:true,verified:true,execution_authorized:true,
   execution_status:'executing',source_app:'jp-document-assistant',
   target_app:'kakebo',operation:'document.sync.finance',
   resource_type:'document_sync_candidate',request_id:requestId,
   resource_id:candidate,household_id:hh,requester_user_id:actor,
   payload_sha256:digest,idempotency_key:'jpda:sync:'+candidate,
   expected_version:null,approver_user_id:approver,
   approved_at:Date.now()-1000,expires_at:Date.now()+600000,applied:false});
 }};
 env.KAKEIBO_DOCUMENT_FINANCE_SERVICE={async fetch(req){
  counters.target++;
  assert.equal(new URL(req.url).pathname,'/api/internal/document-finance/execute');
  assert.equal(req.headers.get('origin'),null);
  assert.equal(req.headers.get('cookie'),null);
  const raw=await req.text(),stamp=req.headers.get('x-approval-timestamp');
  assert.equal(req.headers.get('x-approval-signature'),
   signed('jpda:finance-execute',targetKey,stamp,raw));
  const b=JSON.parse(raw);
  assert.equal(b.request_id,requestId);
  assert.equal(b.account_id,'c'.repeat(32));
  assert.equal(b.account_version,1);
  assert.equal(b.merchant,'セブン-イレブン');
  assert.equal(b.amount_jpy,1420);
  assert.equal(b.execution_nonce,nonce);
  const proof={request_id:requestId,resource_id:candidate,household_id:hh,
    requester_user_id:actor,payload_sha256:digest,operation_sha256:b.operation_sha256};
  const srcRaw=JSON.stringify(proof),srcStamp=String(Date.now());
  const sourceResult=await documentExecutionRoute(new Request(
   'https://document.internal/api/internal/document-actions/source-check',{
    method:'POST',headers:{'content-type':'application/json',
      'x-approval-client':'kakeibo','x-approval-timestamp':srcStamp,
      'x-approval-signature':signed('kakeibo:document-source-check',targetKey,
       srcStamp,srcRaw)},body:srcRaw
   }),env,'source-check');
  counters.sourceCheck++;
  assert.equal(sourceResult.status,200,await sourceResult.clone().text());
  if(!persisted)persisted={ok:true,applied:true,approval_id:requestId,
    candidate_id:candidate,household_id:hh,requester_user_id:actor,
    payload_sha256:digest,operation_sha256:b.operation_sha256,
    approver_user_id:approver,entry_id:12,applied_at:Date.now()};
  return Response.json({...persisted,already_applied:counters.target>1});
 }};
 const make=async(extra={})=>{
  const body=JSON.stringify(wire),stamp=String(Date.now());
  const request=new Request('https://document.internal/api/internal/document-actions/execute',{
   method:'POST',headers:{'content-type':'application/json','x-approval-client':'homeflow',
    'x-approval-timestamp':stamp,
    'x-approval-signature':signed('homeflow:document-execute',executeKey,stamp,body),
    ...extra},body});
  const res=await documentExecutionRoute(request,env,'execute');
  return {status:res.status,data:await res.json()};
 };
 return {sql,env,make,counters,digest};
}
test('approved document finance source executes frozen AES-GCM snapshot, persists receipt and audits actual approver once',async()=>{
 const f=await fixture();
 try{
  const first=await f.make();
  assert.equal(first.status,200,JSON.stringify(first.data));
  assert.equal(first.data.applied,true);
  assert.equal(first.data.entry_id,12);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM document_member_execution_reservations').get().n,1);
  const journal=f.sql.prepare('SELECT * FROM document_member_execution_reservations').get();
  assert.equal(journal.status,'applied');
  assert.equal(journal.approver_user_id,approver);
  assert.equal(journal.target_entry_id,12);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM audit_events').get().n,1);
  assert.equal(f.sql.prepare('SELECT actor_user_id FROM audit_events').get().actor_user_id,'local-owner');
  const replay=await f.make();
  assert.equal(replay.status,200,JSON.stringify(replay.data));
  assert.equal(replay.data.already_applied,true);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM audit_events').get().n,1);
  assert.equal(f.counters.target,2);
  assert.equal(f.counters.sourceCheck,2);
  assert.equal((await f.make({origin:'https://attacker.invalid'})).status,403);
  assert.equal(f.counters.target,2);
 }finally{f.sql.close()}
});
test('document finance rejects revoked source and non-production execution before target mutation',async()=>{
 const f=await fixture();
 try{
  f.sql.prepare("UPDATE homeflow_identity_links SET state='revoked',revoked_at=? WHERE homeflow_user_id=?")
   .run(new Date().toISOString(),actor);
  const denied=await f.make();
  assert.equal(denied.status,409,JSON.stringify(denied.data));
  assert.equal(f.counters.target,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM document_member_execution_reservations').get().n,0);
  f.env.APP_ENV='preview';
  assert.equal((await f.make()).status,503);
  assert.equal(f.counters.homeflow,0);
 }finally{f.sql.close()}
});
