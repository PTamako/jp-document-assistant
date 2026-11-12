import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gmailAuthorizePersistent} from '../web/src/gmail-persistent.js';

test('Gmail code authorization opens synchronously and never exposes refresh/access tokens',async()=>{
 let requested=0,exchanged=0,seenConfig,cb;
 const google={accounts:{oauth2:{initCodeClient(config){
   seenConfig=config;cb=config.callback;
   return {requestCode(){requested++;}}
 }}}};
 const promise=gmailAuthorizePersistent({
   clientId:'123-abc.apps.googleusercontent.com',google,
   exchangeCode:async code=>{exchanged++;assert.equal(code,'one-time-google-code');return {connected:true,google_email:'a@example.invalid'};}
 });
 assert.equal(requested,1,'must call GIS requestCode before losing direct click activation');
 assert.equal(seenConfig.ux_mode,'popup');
 assert.equal(seenConfig.scope,'https://www.googleapis.com/auth/gmail.readonly');
 cb({code:'one-time-google-code'});
 const grant=await promise;
 assert.equal(grant.connected,true);assert.equal(exchanged,1);
 const source=readFileSync(new URL('../web/src/gmail-persistent.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/localStorage|sessionStorage|indexedDB|document.cookie|refresh_token/);
});

test('Google code popup error and invalid code are fail-closed',async()=>{
 let onError;
 const google={accounts:{oauth2:{initCodeClient(config){onError=config.error_callback;
   return {requestCode(){onError({type:'popup_failed_to_open'});}};}}}};
 await assert.rejects(gmailAuthorizePersistent({
   clientId:'123-abc.apps.googleusercontent.com',google,exchangeCode:async()=>{throw Error('not called')}
 }),/PWA 阻止/);
 await assert.rejects(gmailAuthorizePersistent({
   clientId:'bad',google,exchangeCode:async()=>{}
 }),/客户端/);
});

test('PWA invokes browser redirect to grant Gmail access',()=>{
 const app=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
 assert.match(app,/startGoogleAuthorization\('gmail'\)/);
 assert.match(app,/api\/google\/gmail\/messages/);
 assert.match(app,/gmailPayloadToDocument\(/);
});
