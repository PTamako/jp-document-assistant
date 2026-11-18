import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
 validHomeflowSsoPending,persistHomeflowSsoRecovery,
 restoreHomeflowSsoRecovery,clearHomeflowSsoRecovery
} from '../web/src/homeflow-sso-recovery.js';

const token=n=>String(n).repeat(64);
const proof=()=>({state:token('a'),resume_secret:token('b'),until:Date.now()+300000});
function fakeStore(){
 let value=null;
 return {
  async put(x){value=structuredClone(x);},
  async get(){return value===null?null:structuredClone(value);},
  async delete(){value=null;}
 };
}

test('iPhone PWA restart can recover the five-minute proof without Safari or sessionStorage',async()=>{
 const store=fakeStore(),pending=proof();
 await persistHomeflowSsoRecovery(pending,store);
 assert.deepEqual(await restoreHomeflowSsoRecovery(store),pending);
 await clearHomeflowSsoRecovery(store);
 assert.equal(await restoreHomeflowSsoRecovery(store),null);
});

test('recovery refuses wrong, expired, or overlong proof and purges stale records',async()=>{
 const store=fakeStore(),pending=proof();
 assert.equal(validHomeflowSsoPending(pending),true);
 assert.equal(validHomeflowSsoPending({...pending,until:Date.now()-1}),false);
 assert.equal(validHomeflowSsoPending({...pending,until:Date.now()+3600000}),false);
 assert.equal(validHomeflowSsoPending({...pending,resume_secret:'short'}),false);
 await assert.rejects(persistHomeflowSsoRecovery({...pending,state:'short'},store),/过期/);
 await store.put({...pending,until:Date.now()-1});
 assert.equal(await restoreHomeflowSsoRecovery(store),null);
 assert.equal(await store.get(),null);
});

test('public /api/me 401 must not destroy pending SSO and PWA must recover before Safari handoff',()=>{
 const app=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
 assert.match(app,/if\(user\.value\)clearHomeflowSsoPending\(\);\s*clearPrivateWorkspace\(\)/);
 assert.match(app,/homeflowSsoPending\.value=homeflowSsoAvailable\.value&&!!\(await readHomeflowSsoPendingWithRecovery\(\)\)/);
 assert.match(app,/if\(isIosStandalonePwa\(\)\)await persistHomeflowSsoRecovery\(pending\);[\s\S]*?handoffHomeflowBrowserAuthorization/);
 assert.match(app,/const p=await readHomeflowSsoPendingWithRecovery\(\)/);
 assert.match(app,/if\(!user\.value\)\{void refreshHomeflowSsoAvailability\(\)\.then\(\(\)=>resumeHomeflowSsoIfReady\(\)\);return;\}/);
 assert.doesNotMatch(app,/localStorage\.setItem\(SSO_PENDING_KEY/);
});
