import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {documentExecutionRoute} from '../worker/document-execution.js';
const root=new URL('../',import.meta.url);
test('source reservation SQLite locks version/recycle/candidate mutation during uncertain finance write',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  for(const p of ['0001_init.sql','0003_password_auth.sql',
    '0020_homeflow_identity_links.sql','0021_homeflow_sso_pending.sql',
    '0022_homeflow_session_proofs.sql','0023_document_member_sync_intents.sql',
    '0024_document_execution_reservation.sql'])
    db.exec(readFileSync(new URL('migrations/'+p,root),'utf8'));
  const now=new Date().toISOString(),candidate='a'.repeat(32),document='b'.repeat(32);
  db.prepare('INSERT INTO households(id,name,created_at,updated_at) VALUES(?,?,?,?)')
   .run('local','test',now,now);
  db.prepare('INSERT INTO users(id,household_id,email_norm,display_name,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
   .run('member','local','m@test.invalid','M','member',now,now);
  db.prepare('INSERT INTO documents(id,owner_id,household_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)')
   .run(document,'member','local','Private',now,now);
  db.prepare('INSERT INTO action_candidates(id,document_id,candidate_kind,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)')
   .run(candidate,document,'finance','{}',now,now);
  db.prepare('INSERT INTO homeflow_identity_links(homeflow_user_id,homeflow_household_id,local_user_id,verified_at) VALUES(?,?,?,?)')
   .run('hfmember','primary','member',now);
  db.prepare('INSERT INTO document_member_sync_intents(candidate_id,document_id,local_user_id,homeflow_user_id,homeflow_household_id,target_app,candidate_kind,document_version,candidate_updated_at,payload_sha256,payload_cipher,payload_iv,status,approval_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'+
   "'submitted',?,?,?)").run(candidate,document,'member','hfmember','primary','kakebo',
   'finance',1,now,'a'.repeat(64),'encrypted','iv',
   '55555555-5555-4555-8555-555555555555',now,now);
  db.prepare('INSERT INTO document_member_execution_reservations(candidate_id,approval_id,document_id,requester_user_id,household_id,payload_sha256,status,reserved_at) VALUES(?,?,?,?,?,?,?,?)')
   .run(candidate,'55555555-5555-4555-8555-555555555555',document,
    'hfmember','primary','a'.repeat(64),'executing',Date.now());
  assert.throws(()=>db.prepare('UPDATE documents SET version=version+1 WHERE id=?').run(document),/DOCUMENT_EXECUTION_IN_FLIGHT/);
  assert.throws(()=>db.prepare("UPDATE documents SET lifecycle='trashed' WHERE id=?").run(document),/DOCUMENT_EXECUTION_IN_FLIGHT/);
  assert.throws(()=>db.prepare('UPDATE action_candidates SET updated_at=? WHERE id=?').run(now,candidate),/DOCUMENT_EXECUTION_IN_FLIGHT/);
  assert.throws(()=>db.prepare('DELETE FROM action_candidates WHERE id=?').run(candidate),/DOCUMENT_EXECUTION_IN_FLIGHT/);
  assert.throws(()=>db.prepare('DELETE FROM document_member_execution_reservations').run(),/DOCUMENT_EXECUTION_RESERVATION_NO_DELETE/);
  db.prepare("UPDATE document_member_execution_reservations SET status='applied',target_entry_id=3,approver_user_id='owner',applied_at=? WHERE candidate_id=?")
   .run(Date.now(),candidate);
  assert.throws(()=>db.prepare("UPDATE document_member_execution_reservations SET target_entry_id=4").run(),/DOCUMENT_EXECUTION_RECEIPT_IMMUTABLE/);
  db.prepare('UPDATE documents SET version=version+1 WHERE id=?').run(document);
 }finally{db.close()}
});
test('finance execution route refuses unconfigured and browser invocation without target writes',async()=>{
 const request=new Request('https://document.test/api/internal/document-actions/execute',{
  method:'POST',headers:{origin:'https://evil.test',cookie:'a=b',
   'content-type':'application/json'},body:'{}'});
 const disabled=await documentExecutionRoute(request,{},'execute');
 assert.equal(disabled.status,503);
 assert.equal((await disabled.json()).applied,false);
});
