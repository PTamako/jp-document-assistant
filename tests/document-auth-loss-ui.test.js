import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {documentIdentityExpired} from '../web/src/session-auth.js';

test('only the document identity 401 removes the private workspace',()=>{
 for(const code of ['UNAUTHENTICATED','HOMEFLOW_LOGIN_REQUIRED']){
  assert.equal(documentIdentityExpired(401,code),true,code);
  assert.equal(documentIdentityExpired(403,code),false,code);
 }
 for(const code of ['GOOGLE_REAUTH_REQUIRED','GOOGLE_INVALID_GRANT','GOOGLE_GMAIL_DENIED',
  'INVALID_CREDENTIALS','BAD_CSRF','NOT_FOUND','']){
  assert.equal(documentIdentityExpired(401,code),false,code);
 }
 assert.equal(documentIdentityExpired(503,'UNAUTHENTICATED'),false);
});

test('every authenticated API response failure clears visible private state immediately',()=>{
 const app=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
 const start=app.indexOf('async function api(');
 const end=app.indexOf('function accountApi(',start);
 assert.ok(start>=0&&end>start);
 const route=app.slice(start,end);
 assert.match(route,/documentIdentityExpired\(resp\.status,code\)/);
 assert.match(route,/if\(sessionLost\)\{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if\(user\.value\)clearHomeflowSsoPending\(\);\s*clearPrivateWorkspace\(\);/);
 assert.ok(route.indexOf('clearPrivateWorkspace()')>route.indexOf('accountEpoch.assertCurrent(epoch)'));
});
