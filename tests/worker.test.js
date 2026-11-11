import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import app from '../worker/index.js';
import {hmacHex} from '../worker/security.js';
import {createZip} from '../web/src/zip.js';
import {readBackup,restoreBatch} from '../web/src/backup-client.js';
import {readLocalText} from '../web/src/mail-import.js';

if (!globalThis.crypto) globalThis.crypto=webcrypto;
const root = new URL('../', import.meta.url);
function d1() {
  const sql=new DatabaseSync(':memory:');
  for (const migration of ['0001_init.sql','0002_indexes.sql','0003_password_auth.sql','0004_organize.sql','0005_single_household.sql']){
    sql.exec(fs.readFileSync(new URL(`migrations/${migration}`,root),'utf8'));
  }
  const wrap = statement => ({
    bind(...params){return wrap(sql.prepare(statement).bind ? statement : statement)._bound(params);},
    _bound(params){return {
      first:async()=>sql.prepare(statement).get(...params)||null,
      all:async()=>({results:sql.prepare(statement).all(...params)}),
      run:async()=>({meta:{changes:sql.prepare(statement).run(...params).changes}}),
      _runSync:()=>sql.prepare(statement).run(...params)
    }}
  });
  return {sql,prepare(statement){return wrap(statement);},async batch(stmts){
    sql.exec('BEGIN IMMEDIATE');try{
      const out=stmts.map(x=>x._runSync());sql.exec('COMMIT');return out.map(x=>({meta:{changes:x.changes}}));
    }catch(e){sql.exec('ROLLBACK');throw e;}
  }};
}
function makeEnv(){
  const db=d1(), blobs=new Map(),r2={
    async put(key,data){blobs.set(key,new Uint8Array(data));},
    async get(key){return blobs.has(key)?{body:new Blob([blobs.get(key)]).stream()}:null;},
    async head(key){return blobs.has(key)?{size:blobs.get(key).length}:null;},
    async delete(key){blobs.delete(key);}
  };
  return {DB:db,DOCUMENTS:r2,ASSETS:{fetch:()=>new Response('app')},SESSION_HMAC_KEY:'local-test-secret-with-enough-entropy-abcdef',BOOTSTRAP_ADMIN_TOKEN:'local-only-bootstrap-admin-123456',R2_BUCKET_NAME:'test-private',_blobs:blobs};
}
async function req(env,path,{method='GET',data,cookie,csrf,form,extraHeaders={}}={}){
  const headers={Origin:'https://app.example.test',...extraHeaders};
  if(cookie)headers.Cookie=cookie;
  if(csrf)headers['X-CSRF-Token']=csrf;
  let body;
  if(form){body=form;}else if(data!==undefined){headers['Content-Type']='application/json';body=JSON.stringify(data);}
  const response=await app.fetch(new Request(`https://app.example.test${path}`,{method,headers,body}),env);
  const type=response.headers.get('Content-Type')||'';
  return {response,data:type.includes('application/json')?await response.json():null};
}
async function boot(env){
  const r=await req(env,'/api/auth/bootstrap',{method:'POST',data:{setup_token:env.BOOTSTRAP_ADMIN_TOKEN,email:'a@example.com',password:'owner-long-secret123',display_name:'甲'}});
  assert.equal(r.response.status,201,JSON.stringify(r.data));
  return {cookie:r.response.headers.get('set-cookie').split(';')[0],csrf:r.data.csrf_token,user:r.data.user};
}
function auth(p){return {cookie:p.cookie,csrf:p.csrf};}

test('bootstrap is one-time, default private and text import needs review',async()=>{
  const env=makeEnv(),p=await boot(env);
  const second=await req(env,'/api/auth/bootstrap',{method:'POST',data:{setup_token:env.BOOTSTRAP_ADMIN_TOKEN,email:'x@example.com',password:'some-long-password'}});
  assert.equal(second.response.status,409);
  const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(p),data:{title:'缴费通知',retention:'summary',source_type:'text',visibility:'shared',text:'納付期限：令和8年11月30日（月）\n納付金額：12,340円\n税額 12340'}});
  assert.equal(imported.response.status,201,JSON.stringify(imported.data));
  const d=await req(env,`/api/documents/${imported.data.document_id}`,auth(p));
  assert.equal(d.data.document.visibility,'private');
  assert.equal(d.data.document.fields.find(x=>x.field_key==='due_date').normalized_value,'2026-11-30');
  assert.equal(d.data.document.fields.find(x=>x.field_key==='amount_jpy').normalized_value,'12340');
  assert.equal(d.data.document.analysis_status,'needs_review');
  const dup=await req(env,'/api/documents/import/text',{method:'POST',...auth(p),data:{retention:'summary',source_type:'text',text:'納付期限：令和8年11月30日（月）\n納付金額：12,340円\n税額 12340'}});
  assert.equal(dup.data.document_id,imported.data.document_id);
});

test('private documents are not exposed to invited user and shared only when confirmed',async()=>{
  const env=makeEnv(),a=await boot(env);
  const inv=await req(env,'/api/household/invites',{method:'POST',...auth(a),data:{invitee_email:'b@example.com'}});
  const joined=await req(env,'/api/household/join',{method:'POST',data:{invite_token:inv.data.invite_token,email:'b@example.com',password:'member-long-secret123',display_name:'乙'}});
  assert.equal(joined.response.status,201,JSON.stringify(joined.data));
  const b={cookie:joined.response.headers.get('set-cookie').split(';')[0],csrf:joined.data.csrf_token};
  const imp=await req(env,'/api/documents/import/text',{method:'POST',...auth(a),data:{retention:'summary',source_type:'text',text:'申請はこちら 11月30日'}});
  const id=imp.data.document_id;
  assert.equal((await req(env,`/api/documents/${id}`,auth(b))).response.status,404);
  const doc=(await req(env,`/api/documents/${id}`,auth(a))).data.document;
  const fail=await req(env,`/api/documents/${id}`,{method:'PATCH',...auth(a),data:{visibility:'shared',version:doc.version}});
  assert.equal(fail.response.status,409);
  const ok=await req(env,`/api/documents/${id}`,{method:'PATCH',...auth(a),data:{visibility:'shared',version:doc.version,confirm_sensitive_share:true}});
  assert.equal(ok.response.status,200);
  assert.equal((await req(env,`/api/documents/${id}`,auth(b))).response.status,200);
  assert.equal((await req(env,`/api/documents/${id}/trash`,{method:'POST',...auth(b),data:{}})).response.status,404);
});

test('trash restores without deleting R2; permanent deletion removes R2 and private rows',async()=>{
  const env=makeEnv(),a=await boot(env);
  const bytes=new Uint8Array([0xff,0xd8,0xff,0xe0,1,2,3,4]);
  const f=new FormData();f.append('file',new File([bytes],'scan.jpg',{type:'image/jpeg'}));f.append('retention','original');
  const imp=await req(env,'/api/documents/import/file',{method:'POST',...auth(a),form:f});
  assert.equal(imp.response.status,201,JSON.stringify(imp.data));
  const id=imp.data.document_id;assert.equal(env._blobs.size,1);
  let t=await req(env,`/api/documents/${id}/trash`,{method:'POST',...auth(a),data:{}});
  assert.equal(t.response.status,200);assert.equal(env._blobs.size,1);
  assert.equal((await req(env,`/api/documents/${id}`,auth(a))).response.status,404);
  assert.equal((await req(env,`/api/documents/${id}/restore`,{method:'POST',...auth(a),data:{}})).response.status,200);
  assert.equal(env._blobs.size,1);
  await req(env,`/api/documents/${id}/trash`,{method:'POST',...auth(a),data:{}});
  const gone=await req(env,`/api/documents/${id}/permanent-delete`,{method:'POST',...auth(a),data:{confirm:'DELETE_FOREVER'}});
  assert.equal(gone.response.status,200,JSON.stringify(gone.data));
  assert.equal(env._blobs.size,0);
  assert.equal(Number(env.DB.sql.prepare('SELECT COUNT(*) n FROM documents').get().n),0);
});

test('CSRF rejects state mutation and target-app bridge fails closed',async()=>{
  const env=makeEnv(),p=await boot(env);
  const failed=await req(env,'/api/documents/import/text',{method:'POST',cookie:p.cookie,data:{retention:'summary',source_type:'text',text:'納付金額 1200円'}});
  assert.equal(failed.response.status,403);
  const imp=await req(env,'/api/documents/import/text',{method:'POST',...auth(p),data:{retention:'summary',source_type:'text',text:'ご請求金額：1,200円\n納付期限 令和8年11月30日'}});
  const id=imp.data.document_id;
  const cand=(await req(env,`/api/documents/${id}/candidates`,auth(p))).data.items;
  assert.ok(cand.length>0);
  const commit=await req(env,`/api/candidates/${cand[0].id}/commit`,{method:'POST',...auth(p),data:{}});
  assert.equal(commit.response.status,409);
  const confirmed=await req(env,`/api/candidates/${cand[0].id}/commit`,{method:'POST',...auth(p),data:{confirm:'CONFIRM_ACCOUNTING',payment_confirmed:true,date:'2026-11-12',category:'税金',payment_source:'銀行'}});
  assert.equal(confirmed.response.status,400); // Idempotency-Key required; no remote call
  assert.equal(Number(env.DB.sql.prepare('SELECT COUNT(*) n FROM integration_links').get().n),0);
});

test('explicit attachment trash / restore / permanent delete and R2 failure retry',async()=>{
  const env=makeEnv(),a=await boot(env);
  const f=new FormData();f.append('file',new File([new Uint8Array([255,216,255,224,9,8,7,6])],'file.jpg',{type:'image/jpeg'}));f.append('retention','original');
  const added=await req(env,'/api/documents/import/file',{method:'POST',...auth(a),form:f});
  const id=added.data.document_id;
  const detail=(await req(env,`/api/documents/${id}`,auth(a))).data.document;
  const aid=detail.attachments[0].id;
  const deny=await req(env,`/api/documents/${id}/attachments/${aid}/permanent-delete`,{method:'POST',...auth(a),data:{confirm:'DELETE_FOREVER'}});
  assert.equal(deny.response.status,409);
  assert.equal((await req(env,`/api/documents/${id}/attachments/${aid}/trash`,{method:'POST',...auth(a),data:{}})).response.status,200);
  assert.equal((await req(env,`/api/documents/${id}/attachments/${aid}/restore`,{method:'POST',...auth(a),data:{}})).response.status,200);
  await req(env,`/api/documents/${id}/attachments/${aid}/trash`,{method:'POST',...auth(a),data:{}});
  let firstTry=true;
  env.DOCUMENTS.delete=async k=>{if(firstTry){firstTry=false;throw Error('fake r2 failure')}env._blobs.delete(k)};
  const fail=await req(env,`/api/documents/${id}/attachments/${aid}/permanent-delete`,{method:'POST',...auth(a),data:{confirm:'DELETE_FOREVER'}});
  assert.equal(fail.response.status,503);
  assert.equal(env._blobs.size,1);
  const retry=await req(env,`/api/documents/${id}/attachments/${aid}/permanent-delete`,{method:'POST',...auth(a),data:{confirm:'DELETE_FOREVER'}});
  assert.equal(retry.response.status,200,JSON.stringify(retry.data));
  assert.equal(env._blobs.size,0);
  assert.equal((await req(env,`/api/documents/${id}`,auth(a))).data.document.attachments.length,0);
});

test('backup JSON roundtrip only restores metadata and does not send remote integrations',async()=>{
  const env=makeEnv(),a=await boot(env);
  const imp=await req(env,'/api/documents/import/text',{method:'POST',...auth(a),data:{retention:'summary',source_type:'text',text:'納付期限：令和8年11月30日\n納付金額：500円'}});
  assert.equal(imp.response.status,201);
  const exportDoc=(await req(env,'/api/backups/export?scope=all',auth(a))).data;
  assert.equal(exportDoc.documents.length,1);
  assert.equal(exportDoc.documents[0].fields.length,2);
  const preview=await req(env,'/api/backups/import-preview',{method:'POST',...auth(a),data:exportDoc});
  assert.equal(preview.data.preview[0].action,'skip_duplicate');
  const confirmed=await req(env,'/api/backups/import-confirm',{method:'POST',...auth(a),data:{...exportDoc,confirm:'RESTORE_METADATA'}});
  assert.equal(confirmed.data.restored.length,0);
  assert.equal(confirmed.data.remote_syncs_sent,0);
});


test('signed ledger integration requires reviewed fields, uses fixed key and safely retries lost responses',async()=>{
  const env=makeEnv(),user=await boot(env);
  const imp=await req(env,'/api/documents/import/text',{method:'POST',...auth(user),data:{
    retention:'summary',source_type:'text',text:'ご請求金額：1,200円\n納付期限：令和8年11月30日（月)'
  }});
  const id=imp.data.document_id;
  const detail=(await req(env,`/api/documents/${id}`,auth(user))).data.document;
  const money=detail.fields.find(x=>x.field_key==='amount_jpy');
  assert.ok(money);
  const candidates=(await req(env,`/api/documents/${id}/candidates`,auth(user))).data.items;
  const candidate=candidates.find(x=>x.candidate_kind==='finance');assert.ok(candidate);
  const key='attempt_12345678',body={confirm:'CONFIRM_ACCOUNTING',payment_confirmed:true,
    date:'2026-11-12',category:'税金',payment_source:'現金'};
  const options={method:'POST',...auth(user),data:body,extraHeaders:{'Idempotency-Key':key}};
  // Never forward unreviewed amount, even with a correct user confirmation.
  const unreviewed=await req(env,`/api/candidates/${candidate.id}/commit`,options);
  assert.equal(unreviewed.response.status,503); // No service configured; fails closed.
  assert.equal((await req(env,`/api/fields/${money.id}`,{
    method:'PATCH',...auth(user),data:{review_state:'confirmed',normalized_value:'1200'}
  })).response.status,200);
  const actor=env.DB.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
  env.BRIDGE_USER_MAP=JSON.stringify({[actor]:{kakebo:'kakebo-test-owner'}});
  env.KAKEBO_BRIDGE_SECRET='signed-test-secret-strong-enough-123456789';
  const targetWrites=new Map();let callCount=0;
  env.KAKEBO_BRIDGE_SERVICE={async fetch(request){
    const raw=await request.text(),ts=request.headers.get('X-DA-Timestamp');
    assert.equal(request.headers.get('X-DA-Signature'),await hmacHex(env.KAKEBO_BRIDGE_SECRET,`${ts}\n${raw}`));
    const msg=JSON.parse(raw);assert.equal(msg.actor_user_id,'kakebo-test-owner');
    assert.equal(msg.payload.amount,1200);
    assert.equal(msg.idempotency_key,`jda:kakebo:${candidate.id}`);
    callCount++;
    if(!targetWrites.has(msg.idempotency_key))targetWrites.set(msg.idempotency_key,'entry-001');
    if(callCount===1)throw Error('response lost after target already committed');
    return Response.json({ok:true,remote_id:targetWrites.get(msg.idempotency_key),reused:true});
  }};
  const first=await req(env,`/api/candidates/${candidate.id}/commit`,options);
  assert.equal(first.response.status,503);
  const blockedReset=await req(env,`/api/documents/${id}/source-text`,{
    method:'PATCH',...auth(user),data:{text:'ご請求金額：900円',confirm_reset_review:true}
  });
  assert.equal(blockedReset.response.status,409);
  assert.equal(blockedReset.data.code,'INTEGRATION_HISTORY_LOCKED');
  const retry=await req(env,`/api/candidates/${candidate.id}/commit`,options);
  assert.equal(retry.response.status,200,JSON.stringify(retry.data));
  assert.equal(retry.data.remote_id,'entry-001');
  const again=await req(env,`/api/candidates/${candidate.id}/commit`,options);
  assert.equal(again.data.already_synced,true);
  assert.equal(callCount,2);
  assert.equal(targetWrites.size,1);
  const change=await req(env,`/api/fields/${money.id}`,{method:'PATCH',...auth(user),data:{review_state:'corrected',normalized_value:'1300'}});
  assert.equal(change.response.status,409);
  assert.equal(change.data.code,'REMOTE_RECORD_UNCHANGED');
  const confirmedChange=await req(env,`/api/fields/${money.id}`,{method:'PATCH',...auth(user),data:{review_state:'corrected',normalized_value:'1300',confirm_remote_unchanged:true}});
  assert.equal(confirmedChange.response.status,200);
  assert.equal(confirmedChange.data.linked_records_unchanged,true);
  assert.equal(callCount,2); // Never automatically re-post the updated amount.
});


test('invalid calendar dates are rejected during manual verification',async()=>{
  const env=makeEnv(),user=await boot(env);
  const imp=await req(env,'/api/documents/import/text',{method:'POST',...auth(user),data:{
    retention:'summary',source_type:'text',text:'納付期限：令和8年2月28日\n納付金額：1,200円'
  }});
  const doc=(await req(env,`/api/documents/${imp.data.document_id}`,auth(user))).data.document;
  const deadline=doc.fields.find(x=>x.field_key==='due_date');
  assert.ok(deadline);
  const invalid=await req(env,`/api/fields/${deadline.id}`,{method:'PATCH',...auth(user),data:{review_state:'corrected',normalized_value:'2026-02-30'}});
  assert.equal(invalid.response.status,400);
  const valid=await req(env,`/api/fields/${deadline.id}`,{method:'PATCH',...auth(user),data:{review_state:'confirmed',normalized_value:'2026-02-28'}});
  assert.equal(valid.response.status,200);
});

test('permanent document deletion preserves an R2 object still referenced elsewhere',async()=>{
  const env=makeEnv(),user=await boot(env);
  const add=()=>{const f=new FormData();f.append('file',new File([new Uint8Array([255,216,255,224,1,2,3,4])],'same.jpg',{type:'image/jpeg'}));f.append('retention','original');return f;};
  const first=await req(env,'/api/documents/import/file',{method:'POST',...auth(user),form:add()});
  assert.equal(first.response.status,201);
  const oldId=first.data.document_id;
  assert.equal((await req(env,`/api/documents/${oldId}/trash`,{method:'POST',...auth(user),data:{}})).response.status,200);
  const second=await req(env,'/api/documents/import/file',{method:'POST',...auth(user),form:add()});
  assert.equal(second.response.status,201);
  assert.notEqual(second.data.document_id,oldId);
  assert.equal(env._blobs.size,1);
  const removed=await req(env,`/api/documents/${oldId}/permanent-delete`,{method:'POST',...auth(user),data:{confirm:'DELETE_FOREVER'}});
  assert.equal(removed.response.status,200,JSON.stringify(removed.data));
  assert.equal(removed.data.r2_deleted_objects,0);
  assert.equal(env._blobs.size,1);
  const current=(await req(env,`/api/documents/${second.data.document_id}`,auth(user))).data.document;
  assert.equal(current.attachments.length,1);
  assert.equal((await req(env,`/api/documents/${second.data.document_id}/attachments/${current.attachments[0].id}/content`,auth(user))).response.status,200);
});


test('a second use of an invite cannot create a user, including racing join attempts',async()=>{
  const env=makeEnv(),owner=await boot(env);
  const invite=await req(env,'/api/household/invites',{method:'POST',...auth(owner),data:{invitee_email:'family@example.com'}});
  assert.equal(invite.response.status,201);
  const join=()=>req(env,'/api/household/join',{method:'POST',data:{invite_token:invite.data.invite_token,email:'family@example.com',password:'another-long-password',display_name:'家人'}});
  const [a,b]=await Promise.all([join(),join()]);
  assert.deepEqual([a.response.status,b.response.status].sort(),[201,409]);
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) count FROM users').get().count,2);
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) count FROM password_credentials').get().count,2);
});


test('ZIP + original R2 roundtrip restores missing originals without duplicating metadata',async()=>{
  const source=makeEnv(),owner=await boot(source);
  const bytes=new Uint8Array([255,216,255,224,10,20,30,40]);
  const form=new FormData();form.append('file',new File([bytes],'original.jpg',{type:'image/jpeg'}));form.append('retention','original');
  const imported=await req(source,'/api/documents/import/file',{method:'POST',...auth(owner),form});
  assert.equal(imported.response.status,201);
  const sourceId=imported.data.document_id;
  const archive=(await req(source,'/api/backups/export?scope=all',auth(owner))).data;
  const a=archive.documents[0].attachments[0];
  a.backup_path=`originals/${sourceId}/${a.id}.jpg`;
  archive.includes_originals=true;
  const original=await req(source,`/api/backups/original/${sourceId}/${a.id}`,auth(owner));
  assert.equal(original.response.status,200);
  const originalBytes=new Uint8Array(await original.response.arrayBuffer());
  const zip=createZip([{name:'manifest.json',bytes:JSON.stringify(archive)},{name:a.backup_path,bytes:originalBytes}]);
  const parsed=await readBackup(new File([zip],'family.zip',{type:'application/zip'}));
  assert.equal(parsed.data.documents.length,1);
  const target=makeEnv(),restoreOwner=await boot(target);
  const api=async (path,options={})=>{
    const isForm=options.body instanceof FormData;
    const r=await req(target,path,{method:options.method||'GET',...auth(restoreOwner),
      ...(isForm?{form:options.body}:{data:options.body})});
    if(!r.response.ok)throw Error(`${path}: ${JSON.stringify(r.data)}`);
    return r.data;
  };
  // Simulate a previous metadata-only restore. A later ZIP containing originals
  // must still upload those originals, not skip them as a duplicate document.
  const metadata=await api('/api/backups/import-confirm',{method:'POST',body:{...archive,confirm:'RESTORE_METADATA'}});
  assert.equal(metadata.restored.length,1);
  const first=await restoreBatch(api,parsed,true);
  assert.equal(first.metadata_restored,0);
  assert.equal(first.already_existed,1);
  assert.equal(first.originals_restored,1);
  assert.deepEqual(first.failures,[]);
  const docId=metadata.restored[0];
  const saved=(await api(`/api/documents/${docId}`)).document;
  assert.equal(saved.attachments.length,1);
  const savedId=saved.attachments[0].id;
  const read=await req(target,`/api/documents/${docId}/attachments/${savedId}/content`,auth(restoreOwner));
  assert.deepEqual(new Uint8Array(await read.response.arrayBuffer()),bytes);
  const again=await restoreBatch(api,parsed,true);
  assert.equal(again.originals_restored,0);
  assert.equal(again.already_restored_originals,1);
  assert.equal(target._blobs.size,1);
  // Simulate a lost physical R2 object while metadata remains. A verified user
  // backup must recover bytes instead of falsely reporting already-restored.
  const key=[...target._blobs.keys()][0];target._blobs.delete(key);
  const recovered=await restoreBatch(api,parsed,true);
  assert.equal(recovered.originals_restored,1);
  assert.equal(target._blobs.size,1);
  assert.deepEqual(target._blobs.get(key),bytes);
});


test('HomeFlow delegated assignee explicitly carries bonus and synced status survives bridge disconnect',async()=>{
  const env=makeEnv(),owner=await boot(env);
  const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
    retention:'summary',source_type:'text',text:'納付期限：令和8年11月30日'
  }});
  const id=imported.data.document_id;
  const doc=(await req(env,`/api/documents/${id}`,auth(owner))).data.document;
  const shared=await req(env,`/api/documents/${id}`,{method:'PATCH',...auth(owner),data:{visibility:'shared',version:doc.version,confirm_sensitive_share:true}});
  assert.equal(shared.response.status,200);
  const deadline=doc.fields.find(x=>x.field_key==='due_date');
  assert.equal((await req(env,`/api/fields/${deadline.id}`,{method:'PATCH',...auth(owner),data:{review_state:'confirmed',normalized_value:'2026-11-30'}})).response.status,200);
  const candidates=(await req(env,`/api/documents/${id}/candidates`,auth(owner))).data.items;
  const task=candidates.find(x=>x.candidate_kind==='homeflow_task');assert.ok(task);
  const actor=env.DB.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
  env.BRIDGE_USER_MAP=JSON.stringify({[actor]:{homeflow:'homeflow_owner_123'}});
  env.HOMEFLOW_BRIDGE_SECRET='homeflow-test-secret-with-enough-entropy-1234';
  let calls=0;
  env.HOMEFLOW_BRIDGE_SERVICE={async fetch(r){
    const raw=await r.text(),stamp=r.headers.get('X-DA-Timestamp');
    assert.equal(r.headers.get('X-DA-Signature'),await hmacHex(env.HOMEFLOW_BRIDGE_SECRET,`${stamp}\n${raw}`));
    const msg=JSON.parse(raw);
    assert.equal(msg.actor_user_id,'homeflow_owner_123');
    assert.equal(msg.payload.visibility,'household');
    assert.equal(msg.payload.assignee,'other_household_user');
    assert.equal(msg.payload.bonusPoints,2);
    assert.equal(msg.idempotency_key,`jda:homeflow:${task.id}`);
    calls++;
    return Response.json({ok:true,remote_id:'homeflow-task-id',reused:false});
  }};
  const preview=(await req(env,`/api/candidates/${task.id}/preview`,auth(owner))).data;
  assert.equal(preview.account_mapping_ready,true);
  const body={confirm:'CONFIRM_TASK',title:'确认缴费',visibility:'household',assignee:'other_household_user',bonus_points:2};
  const opts={method:'POST',...auth(owner),data:body,extraHeaders:{'Idempotency-Key':'homeflow_test_request_123'}};
  const sent=await req(env,`/api/candidates/${task.id}/commit`,opts);
  assert.equal(sent.response.status,200,JSON.stringify(sent.data));
  assert.equal(calls,1);
  delete env.HOMEFLOW_BRIDGE_SECRET;delete env.HOMEFLOW_BRIDGE_SERVICE;
  const repeat=await req(env,`/api/candidates/${task.id}/commit`,opts);
  assert.equal(repeat.data.already_synced,true);
  assert.equal(calls,1);
});

test('simultaneous permanent document deletions cannot abandon a shared R2 object',async()=>{
  const env=makeEnv(),owner=await boot(env);
  const form=()=>{const f=new FormData();f.append('file',new File([new Uint8Array([255,216,255,224,24,50,76])],'same.jpg',{type:'image/jpeg'}));f.append('retention','original');return f;};
  const one=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:form()});
  assert.equal(one.response.status,201);
  assert.equal((await req(env,`/api/documents/${one.data.document_id}/trash`,{method:'POST',...auth(owner),data:{}})).response.status,200);
  const two=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:form()});
  assert.equal(two.response.status,201);
  assert.equal(env._blobs.size,1);
  assert.equal((await req(env,`/api/documents/${two.data.document_id}/trash`,{method:'POST',...auth(owner),data:{}})).response.status,200);
  const [a,b]=await Promise.all([one,two].map(x=>req(env,`/api/documents/${x.data.document_id}/permanent-delete`,{method:'POST',...auth(owner),data:{confirm:'DELETE_FOREVER'}})));
  assert.deepEqual([a.response.status,b.response.status],[200,200],JSON.stringify([a.data,b.data]));
  assert.equal(env._blobs.size,0,'the final shared object must be physically deleted');
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM storage_objects').get().n,0);
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM deletion_jobs').get().n,0);
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM attachments').get().n,0);
});

test('simultaneous attachment deletions converge on one physical R2 cleanup',async()=>{
  const env=makeEnv(),owner=await boot(env);
  const form=()=>{const f=new FormData();f.append('file',new File([new Uint8Array([255,216,255,224,12,34,56])],'same.jpg',{type:'image/jpeg'}));f.append('retention','original');return f;};
  const first=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:form()});
  const docId=first.data.document_id;
  const second=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{source_type:'text',retention:'summary',text:'別の文書'} });
  assert.equal(second.response.status,201);
  const doc2=second.data.document_id;
  const added=await req(env,`/api/documents/${doc2}/attachments`,{method:'POST',...auth(owner),form:form()});
  assert.equal(added.response.status,201,JSON.stringify(added.data));
  const firstDoc=(await req(env,`/api/documents/${docId}`,auth(owner))).data.document;
  const id1=firstDoc.attachments[0].id,id2=added.data.attachment_id;
  for(const [doc,aid] of [[docId,id1],[doc2,id2]]){
    assert.equal((await req(env,`/api/documents/${doc}/attachments/${aid}/trash`,{method:'POST',...auth(owner),data:{}})).response.status,200);
  }
  const [a,b]=await Promise.all([[docId,id1],[doc2,id2]].map(([doc,aid])=>
    req(env,`/api/documents/${doc}/attachments/${aid}/permanent-delete`,{method:'POST',...auth(owner),data:{confirm:'DELETE_FOREVER'}})));
  assert.deepEqual([a.response.status,b.response.status],[200,200],JSON.stringify([a.data,b.data]));
  assert.equal(env._blobs.size,0);
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM storage_objects').get().n,0);
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM deletion_jobs').get().n,0);
});


test('user-selected EML is decoded in RAM, then explicitly imported as private text without R2 reads',async()=>{
  const env=makeEnv(),owner=await boot(env);
  const body=[
    'From: issuer@example.invalid','Subject: =?UTF-8?B?5pSv5omV44GE6YCa55/O?=',
    'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','',
    '納付期限：令和8年11月30日','ご請求金額：1,200円'
  ].join('\r\n');
  const file=new File([body],'mail.eml',{type:'message/rfc822'});
  const parsed=await readLocalText(file);
  assert.equal(parsed.source_type,'mail_forward');
  assert.equal(env._blobs.size,0); // File selection / parsing alone does no upload.
  const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
    title:parsed.title,text:parsed.text,source_type:parsed.source_type,retention:'summary'
  }});
  assert.equal(imported.response.status,201,JSON.stringify(imported.data));
  const detail=(await req(env,`/api/documents/${imported.data.document_id}`,auth(owner))).data.document;
  assert.equal(detail.visibility,'private');
  assert.ok(detail.fields.some(f=>f.field_key==='due_date'));
  assert.ok(detail.fields.some(f=>f.field_key==='amount_jpy'));
  assert.equal(env.DB.sql.prepare('SELECT source_type FROM document_sources LIMIT 1').get().source_type,'mail_forward');
  assert.equal(env._blobs.size,0);
});
