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
  for (const migration of ['0001_init.sql','0002_indexes.sql','0003_password_auth.sql','0004_organize.sql','0005_single_household.sql','0006_document_version.sql','0007_ocr_attempts.sql','0008_bridge_fingerprint.sql','0009_calendar_subscriptions.sql','0010_ocr_utc_budget.sql']){
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
    async get(key){const data=blobs.get(key);return data?{body:new Blob([data]).stream(),arrayBuffer:()=>new Blob([data]).arrayBuffer()}:null;},
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
  const changed=await req(env,`/api/candidates/${candidate.id}/commit`,{...options,
    data:{...body,date:'2026-11-13'}});
  assert.equal(changed.response.status,409,JSON.stringify(changed.data));
  assert.equal(changed.data.code,'RETRY_PAYLOAD_CHANGED');
  assert.equal(callCount,1);
  assert.equal(env.DB.sql.prepare('SELECT length(request_fingerprint) n FROM integration_links').get().n,64);
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


test('owner reorders active attachment IDs with version CAS; no R2 operation',async()=>{
  const env=makeEnv(),owner=await boot(env);
  const form=bytes=>{const f=new FormData();f.append('file',new File([new Uint8Array([255,216,255,224,...bytes])],`page-${bytes[0]}.jpg`,{type:'image/jpeg'}));f.append('retention','original');return f;};
  const first=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:form([11,22])});
  const id=first.data.document_id;
  assert.equal((await req(env,`/api/documents/${id}/attachments`,{method:'POST',...auth(owner),form:form([33,44])})).response.status,201);
  const before=(await req(env,`/api/documents/${id}`,auth(owner))).data.document;
  const ids=before.attachments.map(x=>x.id);
  assert.equal(ids.length,2);
  let r2Reads=0,r2Writes=0;
  const originals={...env.DOCUMENTS};
  env.DOCUMENTS.get=async(...args)=>{r2Reads++;return originals.get(...args)};
  env.DOCUMENTS.put=async(...args)=>{r2Writes++;return originals.put(...args)};
  const update=()=>req(env,`/api/documents/${id}/attachments/order`,{method:'PATCH',...auth(owner),data:{version:before.version,attachment_ids:[ids[1],ids[0]]}});
  const result=await update();
  assert.equal(result.response.status,200,JSON.stringify(result.data));
  const after=(await req(env,`/api/documents/${id}`,auth(owner))).data.document;
  assert.deepEqual(after.attachments.map(x=>x.id),[ids[1],ids[0]]);
  assert.equal(after.version,before.version+1);
  const repeat=await update();assert.equal(repeat.response.status,409);
  const invalid=await req(env,`/api/documents/${id}/attachments/order`,{method:'PATCH',...auth(owner),data:{version:after.version,attachment_ids:[ids[0],ids[0]]}});
  assert.equal(invalid.response.status,400);
  assert.equal(r2Reads,0);assert.equal(r2Writes,0);
});


test('DOCX text-layer analysis and optional R2 original respect user retention choice',async()=>{
  const {fileOf}=await import('./helpers/office-fixture.js');
  const {extractOfficeFile}=await import('../web/src/document-text.js');
  const file=await fileOf('notice.docx',[
    ['word/document.xml','<w:document><w:p><w:t>納付期限：2026年11月30日</w:t></w:p><w:p><w:t>ご請求金額：1200円</w:t></w:p></w:document>']
  ]);
  const parsed=await extractOfficeFile(file);
  const env=makeEnv(),owner=await boot(env);
  const summary=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
    title:file.name,text:parsed.text,source_type:'local_file',retention:'summary'
  }});
  assert.equal(summary.response.status,201,JSON.stringify(summary.data));
  assert.equal(env._blobs.size,0);
  const b=new FormData();b.append('file',file);b.append('retention','original');b.append('extracted_text',parsed.text);
  const saved=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:b});
  assert.equal(saved.response.status,201,JSON.stringify(saved.data));
  assert.equal(saved.data.text_layer_used,true);
  assert.equal(env._blobs.size,1);
  const doc=(await req(env,'/api/documents/'+saved.data.document_id,auth(owner))).data.document;
  assert.equal(doc.visibility,'private');
  assert.ok(doc.fields.some(x=>x.field_key==='due_date'));
  assert.ok(doc.fields.some(x=>x.field_key==='amount_jpy'));
  const fake=new File([new Uint8Array([80,75,3,4,0,0])],'fake.docx',
    {type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
  const bad=new FormData();bad.append('file',fake);bad.append('retention','original');
  const rejected=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:bad});
  assert.equal(rejected.response.status,415);
  assert.equal(env._blobs.size,1);
});

test('Office original with corrupt compressed XML is denied before any R2 put',async()=>{
 const {fileOf}=await import('./helpers/office-fixture.js');
 const env=makeEnv(),owner=await boot(env);
 const bad=await fileOf('corrupt.docx',[
  ['word/document.xml','<!DOCTYPE x [<!ENTITY s SYSTEM "file:///etc/passwd">]><w:document>&s;</w:document>']
 ],true);
 const f=new FormData();f.append('file',bad);f.append('retention','original');
 const result=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:f});
 assert.equal(result.response.status,415);
 assert.equal(env._blobs.size,0);
 assert.equal(Number(env.DB.sql.prepare('SELECT COUNT(*) AS n FROM storage_objects').get().n),0);
});

test('policy source date stays distinct from official verification through encrypted-free metadata backup',async()=>{
 const source=makeEnv(),owner=await boot(source);
 const text='発行日：令和8年11月11日（水）\n改正条例は令和8年12月1日（火）施行。\n対象外の条件に注意。';
 const imported=await req(source,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
  text,title:'条例確認',retention:'summary',source_type:'text'
 }});
 assert.equal(imported.response.status,201,JSON.stringify(imported.data));
 const detail=(await req(source,'/api/documents/'+imported.data.document_id,auth(owner))).data.document;
 assert.equal(detail.source_document_date,'2026-11-11');
 assert.match(detail.source_date_quote,/発行日/);
 assert.equal(detail.official_current_verified_at,null);
 assert.match(detail.explanation_zh,/官方现行有效性：尚未核验/);
 const exported=(await req(source,'/api/backups/export?scope=all',auth(owner))).data;
 assert.equal(exported.documents[0].document.source_document_date,'2026-11-11');
 exported.documents[0].document.official_current_verified_at='2099-01-01T00:00:00Z'; // Forged backup claim must be ignored.
 const target=makeEnv(),recipient=await boot(target);
 const restore=await req(target,'/api/backups/import-confirm',{method:'POST',...auth(recipient),
  data:{...exported,confirm:'RESTORE_METADATA'}});
 assert.equal(restore.response.status,200,JSON.stringify(restore.data));
 const restoredId=restore.data.restored[0];
 const verified=(await req(target,'/api/documents/'+restoredId,auth(recipient))).data.document;
 assert.equal(verified.source_document_date,'2026-11-11');
 assert.equal(verified.official_current_verified_at,null);
});


test('OCR same-image candidate cache prevents duplicate AI and R2 calls; no financial fields auto-approved',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const raw=new Uint8Array([255,216,255,224,12,9,18,48,71,45,55,90]);
 const f=new FormData();f.append('file',new File([raw],'private.jpg',{type:'image/jpeg'}));f.append('retention','original');
 const uploaded=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:f});
 assert.equal(uploaded.response.status,201,JSON.stringify(uploaded.data));
 const id=uploaded.data.document_id;
 const doc=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
 const aid=doc.attachments[0].id;
 env.ENABLE_EXPERIMENTAL_OCR='true';
 env.OCR_CALLS_PER_USER_DAY='2';
 let aiCalls=0,r2Reads=0;
 env.AI={async run(model,input){
   aiCalls++;assert.ok(input.image.startsWith('data:image/jpeg;base64,'));
   assert.equal(input.task,'query');assert.equal(input.reasoning,false);
   return {answer:'納付期限：令和8年11月30日\n請求金額：1,200円',metrics:{input_tokens:300,output_tokens:55}};
 }};
 env.DOCUMENTS.get=async key=>{
   r2Reads++;
   const stored=env._blobs.get(key);
   return stored?{arrayBuffer:async()=>stored.buffer.slice(stored.byteOffset,stored.byteOffset+stored.byteLength)}:null;
 };
 const body={method:'POST',...auth(owner),data:{confirm:true,attachment_id:aid}};
 const first=await req(env,'/api/documents/'+id+'/ocr',body);
 assert.equal(first.response.status,200,JSON.stringify(first.data));
 assert.equal(first.data.cached,false);
 assert.equal(first.data.verified,false);
 assert.equal(first.data.needs_human_review,true);
 assert.ok(first.data.usage.neurons_estimated>0);
 const second=await req(env,'/api/documents/'+id+'/ocr',body);
 assert.equal(second.response.status,200,JSON.stringify(second.data));
 assert.equal(second.data.cached,true);
 assert.equal(second.data.text,first.data.text);
 assert.equal(aiCalls,1);assert.equal(r2Reads,1);
 assert.equal(env.DB.sql.prepare("SELECT state FROM ocr_attempts").get().state,'success');
 assert.equal(env.DB.sql.prepare("SELECT ai_calls FROM usage_daily").get().ai_calls,1);
 const unchanged=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
 assert.equal(unchanged.extracted_text_ja,null);
 assert.equal(unchanged.fields.length,0);
 assert.equal((await req(env,'/api/documents/'+id+'/attachments/'+aid+'/trash',
  {method:'POST',...auth(owner),data:{}})).response.status,200);
 const gone=await req(env,'/api/documents/'+id+'/attachments/'+aid+'/permanent-delete',
  {method:'POST',...auth(owner),data:{confirm:'DELETE_FOREVER'}});
 assert.equal(gone.response.status,200,JSON.stringify(gone.data));
 assert.equal(env.DB.sql.prepare("SELECT COUNT(*) n FROM ocr_attempts").get().n,0);
});
test('empty OCR response is cached without fake text and cannot repeatedly consume AI quota',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const raw=new Uint8Array([255,216,255,224,10,20,30,40]);
 const f=new FormData();f.append('file',new File([raw],'small.jpg',{type:'image/jpeg'}));f.append('retention','original');
 const uploaded=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:f});
 const id=uploaded.data.document_id;
 const detail=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
 const aid=detail.attachments[0].id;
 env.ENABLE_EXPERIMENTAL_OCR='true';
 let calls=0,r2Reads=0;
 env.AI={async run(){calls++;return {success:true,result:{}};}};
 env.DOCUMENTS.get=async key=>{
  r2Reads++;const b=env._blobs.get(key);
  return {arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.length)};
 };
 const options={method:'POST',...auth(owner),data:{confirm:true,attachment_id:aid}};
 const first=await req(env,'/api/documents/'+id+'/ocr',options);
 assert.equal(first.response.status,422,JSON.stringify(first.data));
 assert.equal(first.data.code,'OCR_EMPTY');
 const repeated=await req(env,'/api/documents/'+id+'/ocr',options);
 assert.equal(repeated.response.status,422);
 assert.equal(repeated.data.code,'OCR_EMPTY_CACHED');
 assert.equal(calls,1);assert.equal(r2Reads,1);
 assert.equal(env.DB.sql.prepare("SELECT state,candidate_text_ja FROM ocr_attempts").get().candidate_text_ja,null);
 assert.equal(env.DB.sql.prepare("SELECT ai_calls FROM usage_daily").get().ai_calls,1);
});
test('wrong-owner OCR access cannot read R2 or model and empty quota never fetches original',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const f=new FormData();f.append('file',new File([new Uint8Array([255,216,255,224,17])],'x.jpg',{type:'image/jpeg'}));f.append('retention','original');
 const up=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:f});
 const id=up.data.document_id;
 const aid=(await req(env,'/api/documents/'+id,auth(owner))).data.document.attachments[0].id;
 const invited=await req(env,'/api/household/invites',{method:'POST',...auth(owner),data:{invitee_email:'b@example.invalid'}});
 const joined=await req(env,'/api/household/join',{method:'POST',data:{invite_token:invited.data.invite_token,email:'b@example.invalid',password:'member-long-secret123'}});
 const other={cookie:joined.response.headers.get('set-cookie').split(';')[0],csrf:joined.data.csrf_token};
 env.ENABLE_EXPERIMENTAL_OCR='true';env.OCR_CALLS_PER_USER_DAY='0';
 let reads=0,calls=0;
 env.AI={async run(){calls++;return {answer:'日本語テキスト'};}};
 env.DOCUMENTS.get=async()=>{reads++;throw Error('must not be read')};
 const badOwner=await req(env,'/api/documents/'+id+'/ocr',{method:'POST',...auth(other),data:{confirm:true,attachment_id:aid}});
 assert.equal(badOwner.response.status,404);
 const budget=await req(env,'/api/documents/'+id+'/ocr',{method:'POST',...auth(owner),data:{confirm:true,attachment_id:aid}});
 assert.equal(budget.response.status,503);
 assert.equal(budget.data.code,'OCR_BUDGET_DISABLED');
 assert.equal(reads,0);assert.equal(calls,0);
});


test('verified DOCX, XLSX and PPTX originals restore to D1/R2 only once per SHA',async()=>{
 const {fileOf}=await import('./helpers/office-fixture.js');
 const env=makeEnv(),owner=await boot(env);
 const doc=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
   source_type:'text',retention:'summary',title:'演示文稿备份恢复测试',text:'納付期限：2026年11月30日\n金額：1200円'
 }});
 assert.equal(doc.response.status,201);
 const id=doc.data.document_id;
 const files=[
  await fileOf('report.docx',[['word/document.xml','<w:document><w:p><w:t>日本語説明書</w:t></w:p></w:document>']],true),
  await fileOf('report.xlsx',[['xl/workbook.xml','<workbook/>'],['xl/worksheets/sheet1.xml','<worksheet><c r="A1" t="inlineStr"><is><t>納付期限</t></is></c></worksheet>']],true),
  await fileOf('report.pptx',[['ppt/presentation.xml','<p:presentation/>'],['ppt/slides/slide1.xml','<p:sld><p:sp><a:t>対象外の条件</a:t></p:sp></p:sld>']],true)
 ];
 for(const file of files){
  const bytes=new Uint8Array(await file.arrayBuffer());
  const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const form=()=>{const f=new FormData();f.append('file',file);f.append('sha256',sha);f.append('label',file.name);return f;};
  const first=await req(env,`/api/documents/${id}/attachments/restore-upload`,
    {method:'POST',...auth(owner),form:form()});
  assert.equal(first.response.status,201,JSON.stringify(first.data));
  const count=env._blobs.size;
  const replay=await req(env,`/api/documents/${id}/attachments/restore-upload`,
    {method:'POST',...auth(owner),form:form()});
  assert.equal(replay.response.status,200,JSON.stringify(replay.data));
  assert.equal(replay.data.already_restored,true);
  assert.equal(env._blobs.size,count);
 }
 assert.equal(env._blobs.size,3);
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM attachments').get().n,3);
});


test('R2 DELETE succeeds but document D1 cleanup fails: retry converges without orphan index',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const form=new FormData();
 form.append('file',new File([new Uint8Array([255,216,255,224,11,8,7,6])],'remove.jpg',{type:'image/jpeg'}));
 form.append('retention','original');
 const created=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form});
 const id=created.data.document_id;
 assert.equal(created.response.status,201);
 await req(env,'/api/documents/'+id+'/trash',{method:'POST',...auth(owner),data:{}});
 const priorBatch=env.DB.batch.bind(env.DB);
 let deletionCount=0,failOnce=true;
 const priorDelete=env.DOCUMENTS.delete.bind(env.DOCUMENTS);
 env.DOCUMENTS.delete=async key=>{deletionCount++;await priorDelete(key)};
 env.DB.batch=async statements=>{
  if(deletionCount>0&&failOnce){failOnce=false;throw Error('D1 unavailable AFTER R2 DELETE');}
  return priorBatch(statements);
 };
 const first=await req(env,'/api/documents/'+id+'/permanent-delete',{
  method:'POST',...auth(owner),data:{confirm:'DELETE_FOREVER'}
 });
 assert.equal(first.response.status,503,JSON.stringify(first.data));
 assert.equal(first.data.code,'METADATA_CLEANUP_FAILED');
 assert.equal(env._blobs.size,0);
 assert.equal(env.DB.sql.prepare("SELECT lifecycle FROM documents WHERE id=?").get(id).lifecycle,'deletion_pending');
 assert.equal(env.DB.sql.prepare("SELECT state FROM storage_objects").get().state,'deletion_pending');
 assert.equal(env.DB.sql.prepare("SELECT COUNT(*) n FROM deletion_jobs").get().n,1);
 const retry=await req(env,'/api/documents/'+id+'/permanent-delete',{
  method:'POST',...auth(owner),data:{confirm:'DELETE_FOREVER'}
 });
 assert.equal(retry.response.status,200,JSON.stringify(retry.data));
 assert.equal(env.DB.sql.prepare("SELECT COUNT(*) n FROM documents").get().n,0);
 assert.equal(env.DB.sql.prepare("SELECT COUNT(*) n FROM storage_objects").get().n,0);
 assert.equal(env.DB.sql.prepare("SELECT COUNT(*) n FROM deletion_jobs").get().n,0);
 assert.equal(env._blobs.size,0);
 assert.equal(deletionCount,2); // precise same-key DELETE is idempotent
});
test('R2 DELETE succeeds but attachment cleanup fails: retry physically and logically removes it',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const form=new FormData();
 form.append('file',new File([new Uint8Array([255,216,255,224,91,82,73,64])],'delete.jpg',{type:'image/jpeg'}));
 form.append('retention','original');
 const uploaded=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form});
 const id=uploaded.data.document_id;
 const doc=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
 const aid=doc.attachments[0].id;
 await req(env,'/api/documents/'+id+'/attachments/'+aid+'/trash',{
  method:'POST',...auth(owner),data:{}
 });
 const originalBatch=env.DB.batch.bind(env.DB);
 const originalDelete=env.DOCUMENTS.delete.bind(env.DOCUMENTS);
 let deleted=false,failing=true;
 env.DOCUMENTS.delete=async key=>{deleted=true;await originalDelete(key)};
 env.DB.batch=async statements=>{
  if(deleted&&failing){failing=false;throw Error('D1 commit failed');}
  return originalBatch(statements);
 };
 const first=await req(env,'/api/documents/'+id+'/attachments/'+aid+'/permanent-delete',{
  method:'POST',...auth(owner),data:{confirm:'DELETE_FOREVER'}
 });
 assert.equal(first.response.status,503);
 assert.equal(first.data.code,'METADATA_CLEANUP_FAILED');
 assert.equal(env._blobs.size,0);
 const retry=await req(env,'/api/documents/'+id+'/attachments/'+aid+'/permanent-delete',{
  method:'POST',...auth(owner),data:{confirm:'DELETE_FOREVER'}
 });
 assert.equal(retry.response.status,200,JSON.stringify(retry.data));
 assert.equal(env.DB.sql.prepare("SELECT COUNT(*) n FROM attachments").get().n,0);
 assert.equal(env.DB.sql.prepare("SELECT COUNT(*) n FROM storage_objects").get().n,0);
});


test('password change checks old password, revokes own sessions and preserves household member credentials',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const invite=await req(env,'/api/household/invites',{method:'POST',...auth(owner),data:{invitee_email:'b@example.com'}});
 const join=await req(env,'/api/household/join',{method:'POST',data:{invite_token:invite.data.invite_token,email:'b@example.com',password:'member-long-secret123'}});
 assert.equal(join.response.status,201);
 const memberCookie=join.response.headers.get('set-cookie').split(';')[0];
 const wrong=await req(env,'/api/auth/change-password',{method:'POST',...auth(owner),
   data:{current_password:'not-the-real-password',new_password:'new-secure-password-6789'}});
 assert.equal(wrong.response.status,401);
 const same=await req(env,'/api/auth/change-password',{method:'POST',...auth(owner),
   data:{current_password:'owner-long-secret123',new_password:'owner-long-secret123'}});
 assert.equal(same.response.status,409);
 const changed=await req(env,'/api/auth/change-password',{method:'POST',...auth(owner),
   data:{current_password:'owner-long-secret123',new_password:'new-secure-password-6789'}});
 assert.equal(changed.response.status,200,JSON.stringify(changed.data));
 assert.equal(changed.data.reauth_required,true);
 assert.match(changed.response.headers.get('set-cookie'),/Max-Age=0/);
 assert.equal((await req(env,'/api/me',auth(owner))).response.status,401);
 assert.equal((await req(env,'/api/me',{cookie:memberCookie})).response.status,200);
 const oldLogin=await req(env,'/api/auth/login',{method:'POST',
   data:{email:'a@example.com',password:'owner-long-secret123'}});
 assert.equal(oldLogin.response.status,401);
 const fresh=await req(env,'/api/auth/login',{method:'POST',
   data:{email:'a@example.com',password:'new-secure-password-6789'}});
 assert.equal(fresh.response.status,200,JSON.stringify(fresh.data));
});


test('atomic cross-app sender lock blocks double-click while first target request is in flight',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
  retention:'summary',source_type:'text',text:'ご請求金額：1,200円\n納付期限：令和8年11月30日（月)'
 }});
 const id=imported.data.document_id;
 const doc=(await req(env,`/api/documents/${id}`,auth(owner))).data.document;
 const amt=doc.fields.find(x=>x.field_key==='amount_jpy');
 assert.ok(amt);
 assert.equal((await req(env,`/api/fields/${amt.id}`,{method:'PATCH',...auth(owner),
   data:{review_state:'confirmed',normalized_value:'1200'}})).response.status,200);
 const candidate=(await req(env,`/api/documents/${id}/candidates`,auth(owner))).data.items.find(x=>x.candidate_kind==='finance');
 assert.ok(candidate);
 const actor=env.DB.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
 env.BRIDGE_USER_MAP=JSON.stringify({[actor]:{kakebo:'mapped-ledger-user'}});
 env.KAKEBO_BRIDGE_SECRET='concurrency-secret-with-enough-entropy-abc';
 let signal,release,calls=0;
 const started=new Promise(resolve=>signal=resolve);
 const gate=new Promise(resolve=>release=resolve);
 env.KAKEBO_BRIDGE_SERVICE={async fetch(){
  calls++;signal();await gate;return Response.json({ok:true,remote_id:'entry-999'});
 }};
 const url=`/api/candidates/${candidate.id}/commit`;
 const args={method:'POST',...auth(owner),data:{confirm:'CONFIRM_ACCOUNTING',
   payment_confirmed:true,date:'2026-11-12',category:'税金',payment_source:'現金'},
   extraHeaders:{'Idempotency-Key':'confirm-ledger-001'}};
 const first=req(env,url,args);
 await started;
 const simultaneous=await req(env,url,args);
 assert.equal(simultaneous.response.status,409);
 assert.equal(simultaneous.data.code,'SENDING');
 assert.equal(calls,1);
 release();
 assert.equal((await first).response.status,200);
 const repeat=await req(env,url,args);
 assert.equal(repeat.data.already_synced,true);
 assert.equal(calls,1);
 assert.equal(env.DB.sql.prepare('SELECT attempt_count n FROM integration_links').get().n,1);
});


test('UTC daily OCR budget is shared across both accounts and never claims Cloudflare account headroom',async()=>{
 const env=makeEnv(),owner=await boot(env);
 env.ENABLE_EXPERIMENTAL_OCR='true';
 env.OCR_CALLS_PER_USER_DAY='3';
 env.OCR_APP_UTC_DAILY_LIMIT='1';
 let calls=0,reads=0;
 env.AI={async run(){calls++;return {answer:'納付期限：2026年11月30日',metrics:{input_tokens:25,output_tokens:9}};}};
 const originalGet=env.DOCUMENTS.get.bind(env.DOCUMENTS);
 env.DOCUMENTS.get=async k=>{reads++;return originalGet(k);};
 async function add(user,byte){
  const form=new FormData();
  form.append('file',new File([new Uint8Array([255,216,255,224,byte,4,5,6])],'sample.jpg',{type:'image/jpeg'}));
  form.append('retention','original');
  const uploaded=await req(env,'/api/documents/import/file',{method:'POST',...auth(user),form});
  assert.equal(uploaded.response.status,201);
  const id=uploaded.data.document_id;
  const data=(await req(env,`/api/documents/${id}`,auth(user))).data.document;
  return {id,aid:data.attachments[0].id};
 }
 const first=await add(owner,1);
 const ok=await req(env,`/api/documents/${first.id}/ocr`,{method:'POST',...auth(owner),
  data:{confirm:true,attachment_id:first.aid}});
 assert.equal(ok.response.status,200,JSON.stringify(ok.data));
 const invited=await req(env,'/api/household/invites',{method:'POST',...auth(owner),data:{invitee_email:'partner@example.invalid'}});
 assert.equal(invited.response.status,201,JSON.stringify(invited.data));
 const join=await req(env,'/api/household/join',{method:'POST',data:{invite_token:invited.data.invite_token,email:'partner@example.invalid',password:'partner-secret-long-2026'}});
 assert.equal(join.response.status,201,JSON.stringify(join.data));
 const partner={cookie:join.response.headers.get('set-cookie').split(';')[0],csrf:join.data.csrf_token,user:join.data.user};
 const second=await add(partner,2);
 const fail=await req(env,`/api/documents/${second.id}/ocr`,{method:'POST',...auth(partner),
  data:{confirm:true,attachment_id:second.aid}});
 assert.equal(fail.response.status,429,JSON.stringify(fail.data));
 assert.equal(fail.data.code,'OCR_APP_UTC_LIMIT');
 assert.equal(calls,1);assert.equal(reads,1);
 const totals=env.DB.sql.prepare('SELECT calls,reserved FROM ocr_app_utc_daily').get();
 assert.equal(totals.calls,1);assert.equal(totals.reserved,0);
 const usage=await req(env,'/api/usage',auth(partner));
 assert.equal(usage.data.app_utc_day.calls,1);
 assert.equal(usage.data.app_utc_day.limit,1);
 assert.equal(usage.data.cloudflare_account_remaining,null);
});
test('stale OCR pending does not retry automatically and requires explicit second approval',async()=>{
 const {OCR_MODEL,OCR_PROMPT_VERSION}=await import('../worker/ocr.js');
 const env=makeEnv(),owner=await boot(env);
 const form=new FormData();
 form.append('file',new File([new Uint8Array([255,216,255,224,21,22,23,24])],'pending.jpg',{type:'image/jpeg'}));
 form.append('retention','original');
 const uploaded=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form});
 const id=uploaded.data.document_id;
 const doc=(await req(env,`/api/documents/${id}`,auth(owner))).data.document;
 const aid=doc.attachments[0].id;
 const object=env.DB.sql.prepare('SELECT object_id FROM attachments WHERE id=?').get(aid).object_id;
 const actor=env.DB.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
 const old=new Date(Date.now()-26*3600000).toISOString();
 env.DB.sql.prepare(`INSERT INTO ocr_attempts(id,owner_id,object_id,model_id,prompt_version,state,created_at,updated_at)
  VALUES(?,?,?,?,?,'pending',?,?)`).run('pending-rec-1',actor,object,OCR_MODEL,OCR_PROMPT_VERSION,old,old);
 env.ENABLE_EXPERIMENTAL_OCR='true';
 let called=0;
 env.AI={async run(){called++;return {answer:'申請期限：2026年11月30日'};}};
 const path=`/api/documents/${id}/ocr`;
 const base={method:'POST',...auth(owner),data:{confirm:true,attachment_id:aid}};
 const blocked=await req(env,path,base);
 assert.equal(blocked.response.status,409);
 assert.equal(blocked.data.code,'OCR_PENDING_STALE');
 assert.equal(called,0);
 const approved=await req(env,path,{...base,data:{...base.data,retry_stale:true}});
 assert.equal(approved.response.status,200,JSON.stringify(approved.data));
 assert.equal(called,1);
 const cache=env.DB.sql.prepare('SELECT state,attempt_count FROM ocr_attempts').get();
 assert.equal(cache.state,'success');assert.equal(cache.attempt_count,2);
 const totals=env.DB.sql.prepare('SELECT calls,reserved FROM ocr_app_utc_daily').get();
 assert.equal(totals.calls,1);assert.equal(totals.reserved,0);
});


test('Google Drive Picker source provenance is recorded only after explicit original upload',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const file=new File([new Uint8Array([255,216,255,224,77,88,99,100])],'notice.jpg',{type:'image/jpeg'});
 const form=new FormData();form.append('file',file);form.append('retention','original');form.append('source_type','google_drive');
 const imported=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form});
 assert.equal(imported.response.status,201,JSON.stringify(imported.data));
 const source=env.DB.sql.prepare('SELECT source_type FROM document_sources WHERE document_id=?').get(imported.data.document_id);
 assert.equal(source.source_type,'google_drive');
 const before=env._blobs.size;
 const badForm=new FormData();badForm.append('file',new File([new Uint8Array([255,216,255,224,51,52])],'bad.jpg',{type:'image/jpeg'}));
 badForm.append('retention','original');badForm.append('source_type','remote_url');
 const denied=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:badForm});
 assert.equal(denied.response.status,400);
 assert.equal(denied.data.code,'INVALID_SOURCE');
 assert.equal(env._blobs.size,before);
});


test('direct reanalysis cannot destroy remote attempts or regenerate idempotency keys',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const created=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
  retention:'summary',source_type:'text',
  text:'納付金額：1,200円\n納付期限：令和8年11月30日（月)'
 }});
 assert.equal(created.response.status,201);
 const id=created.data.document_id;
 let candidates=(await req(env,`/api/documents/${id}/candidates`,auth(owner))).data.items;
 assert.ok(candidates.length);
 const c=candidates[0],actor=env.DB.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
 const target=c.candidate_kind==='finance'?'kakebo':c.candidate_kind==='homeflow_task'?'homeflow':'zhixue';
 const linkId='link-lock-'+id;
 env.DB.sql.prepare(`INSERT INTO integration_links(id,candidate_id,target,idempotency_key,state,attempt_count,updated_at)
   VALUES(?,?,?,?,?,?,?)`).run(linkId,c.id,target,'jda:'+target+':'+c.id,'failed',1,new Date().toISOString());
 // Reproduce a future client forcing analysis instead of using the source-text editor.
 env.DB.sql.prepare('UPDATE documents SET analysis_status=? WHERE id=?').run('draft',id);
 const blocked=await req(env,`/api/documents/${id}/analyze`,{
  method:'POST',...auth(owner),data:{}
 });
 assert.equal(blocked.response.status,409,JSON.stringify(blocked.data));
 assert.equal(blocked.data.code,'INTEGRATION_HISTORY_LOCKED');
 candidates=(await req(env,`/api/documents/${id}/candidates`,auth(owner))).data.items;
 assert.ok(candidates.some(item=>item.id===c.id));
 const preserved=env.DB.sql.prepare('SELECT id,attempt_count FROM integration_links WHERE id=?').get(linkId);
 assert.equal(preserved.id,linkId);
 assert.equal(preserved.attempt_count,1);
});


test('private Japanese sentences cannot be sent to vocabulary-only study bridge or misleadingly marked ready',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
  retention:'summary',source_type:'text',text:'ご請求金額：1200円\n納付期限：令和8年11月30日（月)'
 }});
 const docId=imported.data.document_id;
 const now=new Date().toISOString(),candidateId='sentences000000000000000000000000';
 env.DB.sql.prepare(`INSERT INTO action_candidates(id,document_id,candidate_kind,payload_json,created_at,updated_at)
   VALUES(?,?,?,?,?,?)`).run(candidateId,docId,'sentence',
   JSON.stringify({sentence:'期限までに支払います。',translation_zh:'在期限之前付款'}),now,now);
 const actor=env.DB.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
 env.BRIDGE_USER_MAP=JSON.stringify({[actor]:{zhixue:'single-study-owner'}});
 env.ZHIXUE_BRIDGE_SECRET='signed-study-secret-long-enough-to-test';
 let networkRequests=0;
 env.ZHIXUE_BRIDGE_SERVICE={async fetch(){networkRequests++;return Response.json({ok:true,remote_id:'incorrect'})}};
 const preview=await req(env,`/api/candidates/${candidateId}/preview`,auth(owner));
 assert.equal(preview.response.status,200,JSON.stringify(preview.data));
 assert.equal(preview.data.available,false);
 assert.match(preview.data.note,/私人句卡/);
 const commit=await req(env,`/api/candidates/${candidateId}/commit`,{
   method:'POST',...auth(owner),data:{confirm:'CONFIRM_STUDY',privacy_confirmed:true,
     redacted_sentence:'期限までに支払います。'},
   extraHeaders:{'Idempotency-Key':'explicit-sentence-request'}
 });
 assert.equal(commit.response.status,503,JSON.stringify(commit.data));
 assert.equal(commit.data.code,'STUDY_SENTENCE_NOT_READY');
 assert.equal(networkRequests,0);
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM integration_links').get().n,0);
});
