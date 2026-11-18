import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {homeflowSsoProgress} from '../worker/homeflow-sso.js';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const origin='https://documents.example.test';
const state='a'.repeat(64),resumeSecret='b'.repeat(64);
const hash=value=>createHash('sha256').update(value).digest('hex');
function env(row,reads){
 return {
  HOMEFLOW_SSO_ENABLED:'true',
  HOMEFLOW_SSO_ENCRYPTION_KEY:'c'.repeat(64),
  SESSION_HMAC_KEY:'s'.repeat(48),
  HOMEFLOW_OAUTH_ORIGIN:'https://homeflow.example.test',
  DA_PUBLIC_ORIGIN:origin,
  HOMEFLOW_BRIDGE_SERVICE:{fetch:async()=>{throw Error('unexpected target call');}},
  DB:{prepare(sql){
    assert.match(sql,/SELECT status,code_cipher,expires_at,resume_secret_hash/);
    return {bind:(_stateHash,requestOrigin)=>({
      async first(){reads.push({_stateHash,requestOrigin});return row;}
    })};
  }}
 };
}
function request(data={state,resume_secret:resumeSecret},from=origin){
 return new Request(origin+'/api/homeflow-sso/progress',{
  method:'POST',headers:{origin:from,'content-type':'application/json'},
  body:JSON.stringify(data)
 });
}
const validRow=()=>({
 status:'pending',code_cipher:null,
 expires_at:new Date(Date.now()+180000).toISOString(),
 resume_secret_hash:hash(resumeSecret)
});
test('PWA readiness never consumes an unfinished callback and reveals no identity or code',async()=>{
 const reads=[],row=validRow(),e=env(row,reads);
 let r=await homeflowSsoProgress(request(),e,new URL(origin));
 assert.equal(r.status,200);
 assert.deepEqual(await r.json(),{ok:true,ready:false,progress:'waiting'});
 assert.equal(r.headers.get('Cache-Control'),'no-store');
 assert.equal(reads.length,1);
 assert.equal(reads[0]._stateHash,hash(state));
 assert.equal(reads[0].requestOrigin,origin);
 row.code_cipher='encrypted OAuth code';
 r=await homeflowSsoProgress(request(),e,new URL(origin));
 const body=await r.json();
 assert.deepEqual(body,{ok:true,ready:true,progress:'ready'});
 assert.doesNotMatch(JSON.stringify(body),/encrypted|user_id|household_id|resume_secret/i);
 assert.equal(reads.length,2);
});
test('PWA readiness rejects wrong origin, stale resume secret and extra fields',async()=>{
 const reads=[],e=env(validRow(),reads);
 for(const req of [
  request(undefined,'https://attacker.test'),
  request({state,resume_secret:'f'.repeat(64)}),
  request({state,resume_secret:resumeSecret,extra:'unexpected'})
 ]){
  const r=await homeflowSsoProgress(req,e,new URL(origin));
  assert.equal(r.status,403);
  assert.equal((await r.json()).code,'SSO_INVALID_PROOF');
 }
 assert.equal(reads.length,1,'wrong origin and extra fields do not query D1');
});
test('expired/consumed callback remains closed without resetting original login proof',async()=>{
 const row=validRow(),e=env(row,[]);
 row.status='consumed';
 let result=await homeflowSsoProgress(request(),e,new URL(origin));
 assert.deepEqual(await result.json(),{ok:true,ready:false,progress:'expired'});
 row.status='pending';
 row.expires_at='2020-01-01T00:00:00.000Z';
 result=await homeflowSsoProgress(request(),e,new URL(origin));
 assert.equal((await result.json()).progress,'expired');
});
test('original PWA resumes SSO automatically without storing proof in URL',()=>{
 const app=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
 assert.match(app,/async function resumeHomeflowSsoIfReady\(\)/);
 assert.match(app,/status\.ready===true\)\{\s*await completeHomeflowSso\(\)/);
 assert.match(app,/if\(!user\.value\)\{void refreshHomeflowSsoAvailability\(\)\.then\(\(\)=>resumeHomeflowSsoIfReady\(\)\);return;\}/);
 assert.match(app,/await resumeHomeflowSsoIfReady\(\);if\(!user\.value\)await refreshInitStatus\(\)/);
 assert.doesNotMatch(app,/authorization_url\s*\+\s*resume_secret/);
});
