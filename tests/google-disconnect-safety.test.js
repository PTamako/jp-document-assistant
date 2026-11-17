import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {handleBrowserGoogle} from '../worker/google-browser-oauth.js';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const secret='a'.repeat(64),user='local-user-1',email='test@example.invalid';
const iv=Uint8Array.from({length:12},(_,i)=>i+1);
const b64=b=>Buffer.from(b).toString('base64');
async function grant(service,refresh){
 const key=await crypto.subtle.importKey('raw',Buffer.from(secret,'hex'),
  {name:'AES-GCM'},false,['encrypt']);
 const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,
  additionalData:new TextEncoder().encode('jpda-google-'+service+':'+user)},
  key,new TextEncoder().encode(refresh));
 return {user_id:user,service,google_email:email,status:'connected',
  refresh_cipher:b64(new Uint8Array(data)),refresh_iv:b64(iv)};
}
function db(records){
 const current=[...records];
 return {
  records:current,
  prepare(sql){return {bind(...args){return {
   async first(){
    if(sql.startsWith('SELECT * FROM google_oauth_grants'))
     return current.find(x=>x.user_id===args[0]&&x.service===args[1])||null;
    if(sql.includes('SELECT 1 FROM google_oauth_grants'))
     return current.find(x=>x.user_id===args[0]&&x.service!==args[1]&&
      x.google_email===args[2]&&x.status==='connected')?{found:1}:null;
    throw Error('Unexpected query '+sql);
   },
   async run(){
    if(sql.startsWith('DELETE FROM google_oauth_grants')){
     const index=current.findIndex(x=>x.user_id===args[0]&&x.service===args[1]);
     if(index>=0)current.splice(index,1);
    }else if(!sql.startsWith('DELETE FROM google_oauth_pending'))
     throw Error('Unexpected write '+sql);
    return {meta:{changes:1}};
   }
  }}}}
 };
}
async function disconnect(env,service){
 const request=new Request('https://example.com/api/google/oauth/disconnect',{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({service})});
 const response=await handleBrowserGoogle(request,env,{user_id:user},new URL(request.url));
 return {status:response.status,data:await response.json()};
}
const envWith=db=>({
 DB:db,GOOGLE_OAUTH_CLIENT_ID:'client.apps.googleusercontent.com',
 GOOGLE_OAUTH_CLIENT_SECRET:'mock-secret',GOOGLE_TOKEN_ENCRYPTION_KEY:secret
});
test('Google disconnect preserves another connected service for the same Google account',async()=>{
 const records=db([await grant('gmail','gmail-refresh'),await grant('drive','drive-refresh')]);
 let network=0;
 const env={...envWith(records),GOOGLE_OAUTH_FETCH:async()=>{network++;throw Error('no remote revoke expected')}};
 const result=await disconnect(env,'drive');
 assert.equal(result.status,200);
 assert.equal(result.data.connected,false);
 assert.equal(result.data.remote_revocation_skipped_to_protect_other_service,true);
 assert.equal(result.data.remotely_revoked,false);
 assert.equal(network,0);
 assert.deepEqual(records.records.map(x=>x.service),['gmail']);
 assert.doesNotMatch(JSON.stringify(result.data),/drive-refresh|gmail-refresh/);
});
test('Google disconnect remotely revokes a standalone grant without exposing refresh token',async()=>{
 const records=db([await grant('drive','private-refresh-token')]);
 const calls=[];
 const env={...envWith(records),GOOGLE_OAUTH_FETCH:async(url,options)=>{
  calls.push({url,options});
  return new Response('',{status:200});
 }};
 const result=await disconnect(env,'drive');
 assert.equal(result.status,200);
 assert.equal(result.data.remotely_revoked,true);
 assert.equal(result.data.remote_revocation_skipped_to_protect_other_service,false);
 assert.equal(records.records.length,0);
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,'https://oauth2.googleapis.com/revoke');
 assert.equal(new URLSearchParams(calls[0].options.body).get('token'),'private-refresh-token');
 assert.doesNotMatch(JSON.stringify(result.data),/private-refresh-token/);
});
test('Google local disconnect remains final when remote revoke is unreachable',async()=>{
 const records=db([await grant('drive','private-refresh-token')]);
 const env={...envWith(records),GOOGLE_OAUTH_FETCH:async()=>{throw Error('network timeout')}};
 const result=await disconnect(env,'drive');
 assert.equal(result.status,200);
 assert.equal(result.data.remotely_revoked,false);
 assert.equal(records.records.length,0);
});
