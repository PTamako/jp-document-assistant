import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { integrationStatus, homeflowMemberOptions } from '../worker/bridge.js';
import { hmacHex } from '../worker/security.js';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const candidateId='a'.repeat(32),secret='safe-local-test-secret-for-bridge-20261113';
const uid='owner';
function makeEnv({remoteState='trashed',enabled=true}={}){
  const key='jda:kakebo:'+candidateId;
  const calls=[];
  const DB={prepare(sql){return {bind(...args){return {
    async first(){
      if(sql.includes('JOIN documents'))return {id:candidateId,document_id:'doc1',
        owner_id:uid,lifecycle:'active',candidate_kind:'finance'};
      if(sql.includes('FROM integration_links'))
        return {state:'synced',remote_id:'417',idempotency_key:key};
      throw Error('Unexpected SELECT '+sql);
    },
    async run(){throw Error('A read-only reconciliation must never write');}
  }}}}};
  const KAKEBO_BRIDGE_SERVICE={async fetch(req){
    const payload=JSON.parse(await req.text());
    assert.equal(payload.payload.operation,'status');
    assert.equal(payload.idempotency_key,key);
    assert.equal(payload.actor_user_id,'ledgerActor');
    assert.equal(req.headers.get('Idempotency-Key'),key);
    const expected=await hmacHex(secret,req.headers.get('X-DA-Timestamp')+'\n'+JSON.stringify(payload));
    assert.equal(req.headers.get('X-DA-Signature'),expected);
    calls.push(payload.payload.operation);
    return Response.json({ok:true,exists:remoteState!=='missing',
      remote_id:remoteState==='missing'?null:'417',record_state:remoteState});
  }};
  return {env:{DB,KAKEBO_BRIDGE_SERVICE:enabled?KAKEBO_BRIDGE_SERVICE:null,
    KAKEBO_BRIDGE_SECRET:secret,
    BRIDGE_USER_MAP:JSON.stringify({[uid]:{kakebo:'ledgerActor',homeflow:'family_actor_123'}})},
    calls};
}

test('signed ledger status resolves target trash without touching the accounting record',async()=>{
  const {env,calls}=makeEnv();
  const response=await integrationStatus(env,{user_id:uid},candidateId);
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(data.stored_state,'synced');
  assert.equal(data.record_state,'trashed');
  assert.equal(data.needs_attention,true);
  assert.deepEqual(calls,['status']);
});
test('ledger verification fails closed when the private bridge is unavailable',async()=>{
  const {env}=makeEnv({enabled:false});
  const response=await integrationStatus(env,{user_id:uid},candidateId);
  assert.equal(response.status,503);
  assert.equal((await response.json()).code,'STATUS_UNAVAILABLE');
});
test('HomeFlow member picker only accepts signed, scoped, validated choices',async()=>{
  const {env}=makeEnv();
  env.HOMEFLOW_BRIDGE_SERVICE={async fetch(req){
    const body=JSON.parse(await req.text());
    assert.equal(body.payload.operation,'members');
    assert.equal(body.actor_user_id,'family_actor_123');
    assert.equal(req.headers.get('Idempotency-Key'),'jda:homeflow:'+candidateId);
    assert.equal(req.headers.get('X-DA-Signature'),
      await hmacHex(secret,req.headers.get('X-DA-Timestamp')+'\n'+JSON.stringify(body)));
    return Response.json({ok:true,members:[
      {id:'family_actor_123',label:'自己',self:true},
      {id:'family_other_12',label:'家人',self:false},
      {id:'invalid',label:'外部成员',self:false}
    ]});
  }};
  env.HOMEFLOW_BRIDGE_SECRET=secret;
  const result=await homeflowMemberOptions(env,uid,candidateId);
  assert.deepEqual(result.members,[
    {id:'family_actor_123',label:'自己',self:true},
    {id:'family_other_12',label:'家人',self:false}
  ]);
});
test('deadline re-analysis retains original provenance and rejects inferred dates',()=>{
  const source=readFileSync(new URL('../worker/index.js',import.meta.url),'utf8');
  assert.ok(source.includes("SELECT field_key,normalized_value,review_state,source_quote FROM document_fields WHERE document_id=?"));
  assert.ok(source.includes("!String(due.source_quote||'').startsWith('年份自动补全')"));
  assert.ok(source.includes("validCivilDate(String(due.normalized_value||''))"));
});
test('HomeFlow assignee selection uses picker instead of internal IDs',()=>{
  const app=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
  assert.ok(app.includes("openChoice('taskAssignee')"));
  assert.ok(app.includes('homeflowMemberChoices'));
  assert.ok(!app.includes('负责人 HomeFlow 用户 ID'));
  assert.ok(app.includes('核对家計簿状态'));
});

test('HomeFlow private assignment never displays both people, and paid delegated assignment is validated before sending',()=>{
  const ui=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
  assert.ok(!ui.includes('未指定（双方）'));
  assert.ok(ui.includes("const needsOtherAssigneeBonus=computed"));
  assert.match(ui,/needsOtherAssigneeBonus\.value&&[\s\S]*?!Number\.isSafeInteger\(candidateDraft\.bonus_points\)/);
  assert.ok(ui.includes('min="1" max="10000"'));
});
