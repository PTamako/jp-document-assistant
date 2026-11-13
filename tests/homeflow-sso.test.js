import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {webcrypto} from 'node:crypto';
import {startHomeFlowSso,callbackHomeFlowSso} from '../worker/homeflow-sso.js';
import {hashString} from '../worker/security.js';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const repo=new URL('../',import.meta.url);
const home='https://homeflow.example.test';
const app='https://app.example.test';
const ownerId='11111111-1111-4111-8111-111111111111';
const memberId='22222222-2222-4222-8222-222222222222';
const callbackUrl=app+'/api/homeflow-sso/callback';
const oldCookie='b'.repeat(64);
const now=()=>new Date().toISOString();
function d1(){
 const sqlite=new DatabaseSync(':memory:');
 for(const path of ['0001_init.sql','0003_password_auth.sql',
    '0013_google_oauth_grants.sql','0020_homeflow_identity_links.sql',
    '0021_homeflow_sso_pending.sql'])
   sqlite.exec(readFileSync(new URL('migrations/'+path,repo),'utf8'));
 const prepare=statement=>({
   bind(...params){
     const runSync=()=>sqlite.prepare(statement).run(...params);
     return {
       first:async()=>sqlite.prepare(statement).get(...params)||null,
       all:async()=>({results:sqlite.prepare(statement).all(...params)}),
       run:async()=>({meta:{changes:runSync().changes}}),
       runSync
     };
   }
 });
 return {sqlite,prepare,async batch(statements){
    sqlite.exec('BEGIN');
    try{
      const out=statements.map(x=>({meta:{changes:x.runSync().changes}}));
      sqlite.exec('COMMIT');
      return out;
    }catch(e){sqlite.exec('ROLLBACK');throw e;}
 }};
}
async function setup(){
 const db=d1(),sql=db.sqlite;
 const stamp=now();
 sql.prepare('INSERT INTO households(id,name,created_at,updated_at) VALUES(?,?,?,?)')
   .run('local-hh','legacy',stamp,stamp);
 sql.prepare(`INSERT INTO users
   (id,household_id,email_norm,display_name,role,created_at,updated_at)
   VALUES(?,?,?,?,?,?,?)`).run('local-owner','local-hh','legacy@example.invalid',
    'Legacy Owner','owner',stamp,stamp);
 sql.prepare('INSERT INTO sessions(id,user_id,secret_hash,expires_at,created_at) VALUES(?,?,?,?,?)')
   .run('legacy-session','local-owner',await hashString(oldCookie),
     new Date(Date.now()+86400000).toISOString(),stamp);
 sql.prepare(`INSERT INTO documents
    (id,owner_id,household_id,visibility,title,created_at,updated_at)
    VALUES(?,?,?,'private',?,?,?)`)
   .run('legacy-doc','local-owner','local-hh','Legacy private',stamp,stamp);
 sql.prepare(`INSERT INTO google_oauth_grants
   (user_id,service,google_email,scope,refresh_cipher,refresh_iv,status,created_at,updated_at)
   VALUES(?,'gmail',?,?,?,?, 'connected',?,?)`)
   .run('local-owner','legacy@example.invalid','gmail.readonly','old-encrypted-blob','iv',stamp,stamp);
 const env={
   DB:db,HOMEFLOW_SSO_ENABLED:'true',
   HOMEFLOW_SSO_ENCRYPTION_KEY:'a'.repeat(64),
   SESSION_HMAC_KEY:'test-only-hmac-secret-must-be-at-least-32-characters',
   HOMEFLOW_OAUTH_ORIGIN:home,DA_PUBLIC_ORIGIN:app
 };
 const state={hfUser:ownerId,hfRole:'owner',nickname:'小白',
   household:'primary',audience:'jp-document-assistant',
   codeVerifier:null,challenge:null,serviceCalls:0};
 env.HOMEFLOW_BRIDGE_SERVICE={
  async fetch(request){
   state.serviceCalls++;
   assert.equal(request.headers.get('origin'),null,
     'backend exchange must not use a browser Origin header');
   assert.equal(request.redirect,'manual');
   const url=new URL(request.url);
   if(url.pathname==='/api/oauth/token'){
     const body=new URLSearchParams(await request.text());
     assert.equal(body.get('client_id'),'jp-document-assistant');
     assert.equal(body.get('redirect_uri'),callbackUrl);
     assert.equal(body.get('grant_type'),'authorization_code');
     assert.equal(body.get('code'),'f'.repeat(64));
     state.codeVerifier=body.get('code_verifier');
     const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',
       new TextEncoder().encode(state.codeVerifier)));
     const b64=btoa(String.fromCharCode(...digest))
       .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
     assert.equal(b64,state.challenge);
     return Response.json({access_token:'e'.repeat(64),token_type:'Bearer',expires_in:180});
   }
   if(url.pathname==='/api/oauth/userinfo'){
     assert.equal(request.headers.get('Authorization'),'Bearer '+'e'.repeat(64));
     return Response.json({sub:state.hfUser,user_id:state.hfUser,
       household_id:state.household,role:state.hfRole,
       nickname:state.nickname,audience:state.audience});
   }
   throw Error('unexpected service path');
  }
 };
 const start=async({oldSession=false,origin=app}={})=>{
   const headers={Origin:origin};
   if(oldSession)headers.Cookie='__Host-da_session='+oldCookie;
   const response=await startHomeFlowSso(new Request(app+'/api/homeflow-sso/start',
     {method:'POST',headers}),env,new URL(app+'/api/homeflow-sso/start'));
   const body=await response.json();
   const callback=body.authorization_url?new URL(body.authorization_url):null;
   if(callback){
     state.challenge=callback.searchParams.get('code_challenge');
     assert.equal(callback.origin,home);
     assert.equal(callback.searchParams.get('client_id'),'jp-document-assistant');
     assert.equal(callback.searchParams.get('redirect_uri'),callbackUrl);
     assert.equal(callback.searchParams.get('code_challenge_method'),'S256');
   }
   return {response,body,authUrl:callback,
     state:callback?.searchParams.get('state'),
     cookie:response.headers.get('set-cookie')?.split(';')[0]};
 };
 const finish=async(flow,{cookie=flow.cookie,stateParam=flow.state,code='f'.repeat(64)}={})=>{
   const q=new URLSearchParams({state:stateParam||'',code});
   return callbackHomeFlowSso(new Request(callbackUrl+'?'+q,{
     method:'GET',headers:{Cookie:cookie||''}
   }),env,new URL(callbackUrl+'?'+q));
 };
 return {db,sql,env,state,start,finish};
}
test('SSO endpoints default closed and bad origins fail before D1 write',async()=>{
 const f=await setup();
 try{
  f.env.HOMEFLOW_SSO_ENABLED=undefined;
  const blocked=await f.start();
  assert.equal(blocked.response.status,503);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM homeflow_oauth_pending').get().n,0);
  f.env.HOMEFLOW_SSO_ENABLED='true';
  const spoof=await f.start({origin:'https://attacker.example.test'});
  assert.equal(spoof.response.status,403);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM homeflow_oauth_pending').get().n,0);
  delete f.env.HOMEFLOW_BRIDGE_SERVICE;
  assert.equal((await f.start()).response.status,503);
 }finally{f.sql.close();}
});
test('callback is bound to original browser and state is not consumed by a mismatch',async()=>{
 const f=await setup();
 try{
  const s=await f.start({oldSession:true});
  assert.equal(s.response.status,200);
  assert.match(s.cookie,/^__Host-da_homeflow_state=/);
  assert.match(s.response.headers.get('set-cookie'),/SameSite=Lax/);
  const failed=await f.finish(s,{cookie:'__Host-da_homeflow_state='+'0'.repeat(64)});
  assert.equal(failed.status,403);
  assert.equal(f.state.serviceCalls,0);
  assert.equal(f.sql.prepare('SELECT status FROM homeflow_oauth_pending').get().status,'pending');
  const success=await f.finish(s);
  assert.equal(success.status,303);
  assert.equal(f.state.serviceCalls,2);
  assert.equal(f.sql.prepare('SELECT status FROM homeflow_oauth_pending').get().status,'consumed');
  const replay=await f.finish(s);
  assert.equal(replay.status,403);
  assert.equal(f.state.serviceCalls,2);
 }finally{f.sql.close();}
});
test('HomeFlow owner cannot silently inherit the legacy account without dual proof',async()=>{
 const f=await setup();
 try{
  const flow=await f.start();
  const resp=await f.finish(flow);
  assert.equal(resp.status,403);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM homeflow_identity_links').get().n,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM users').get().n,1);
  assert.equal(f.sql.prepare('SELECT owner_id FROM documents').get().owner_id,'local-owner');
 }finally{f.sql.close();}
});
test('owner dual proof links ONLY existing user, preserves legacy document/Google grant',async()=>{
 const f=await setup();
 try{
  const flow=await f.start({oldSession:true});
  const resp=await f.finish(flow);
  assert.equal(resp.status,303);
  assert.equal(resp.headers.get('location'),app+'/?homeflow_sso=connected');
  const cookies=resp.headers.getSetCookie();
  assert.equal(cookies.length,2);
  assert.ok(cookies.some(s=>s.startsWith('__Host-da_session=')&&s.includes('HttpOnly')));
  assert.ok(cookies.some(s=>s.startsWith('__Host-da_homeflow_state=;')));
  const link=f.sql.prepare('SELECT * FROM homeflow_identity_links').get();
  assert.equal(link.homeflow_user_id,ownerId);
  assert.equal(link.homeflow_household_id,'primary');
  assert.equal(link.local_user_id,'local-owner');
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM users').get().n,1);
  assert.equal(f.sql.prepare('SELECT display_name FROM users').get().display_name,'小白');
  assert.equal(f.sql.prepare('SELECT owner_id FROM documents').get().owner_id,'local-owner');
  assert.equal(f.sql.prepare('SELECT refresh_cipher FROM google_oauth_grants').get().refresh_cipher,'old-encrypted-blob');
  assert.equal(f.sql.prepare('SELECT kind FROM audit_events').get().kind,'homeflow_owner_link_verified');
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM sessions').get().n,2);
 }finally{f.sql.close();}
});
test('member provisions into new EMPTY private space after owner link, no copied credentials',async()=>{
 const f=await setup();
 try{
  const owner=await f.start({oldSession:true});
  assert.equal((await f.finish(owner)).status,303);
  f.state.hfUser=memberId;
  f.state.hfRole='member';
  f.state.nickname='鸡毛';
  const member=await f.start();
  assert.equal((await f.finish(member)).status,303);
  const people=f.sql.prepare('SELECT id,role,display_name FROM users ORDER BY role').all();
  assert.equal(people.length,2);
  const husband=people.find(x=>x.role==='member');
  assert.equal(husband.display_name,'鸡毛');
  assert.notEqual(husband.id,'local-owner');
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM documents WHERE owner_id=?').get(husband.id).n,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM google_oauth_grants WHERE user_id=?').get(husband.id).n,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM password_credentials WHERE user_id=?').get(husband.id).n,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM documents').get().n,1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM google_oauth_grants').get().n,1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM homeflow_identity_links').get().n,2);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM audit_events').get().n,2);
  const relogin=await f.start();
  assert.equal((await f.finish(relogin)).status,303);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM users').get().n,2);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM homeflow_identity_links').get().n,2);
 }finally{f.sql.close();}
});
test('member first login before owner binding fails closed, preserving local records',async()=>{
 const f=await setup();
 try{
  f.state.hfUser=memberId;f.state.hfRole='member';f.state.nickname='鸡毛';
  const member=await f.start();
  assert.equal((await f.finish(member)).status,403);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM users').get().n,1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM homeflow_identity_links').get().n,0);
 }finally{f.sql.close();}
});
test('changed audience, HomeFlow household or role cannot take over prior local account',async()=>{
 const f=await setup();
 try{
  const owner=await f.start({oldSession:true});
  assert.equal((await f.finish(owner)).status,303);
  f.state.audience='other-app';
  assert.equal((await f.finish(await f.start())).status,403);
  f.state.audience='jp-document-assistant';
  f.state.household='unexpected-other-household';
  assert.equal((await f.finish(await f.start())).status,403);
  f.state.household='primary';
  f.state.hfRole='member';
  assert.equal((await f.finish(await f.start())).status,403);
  const link=f.sql.prepare('SELECT local_user_id FROM homeflow_identity_links WHERE homeflow_user_id=?').get(ownerId);
  assert.equal(link.local_user_id,'local-owner');
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM users').get().n,1);
 }finally{f.sql.close();}
});
test('owner logs out of legacy app during SSO: cannot use revoked owner proof',async()=>{
 const f=await setup();
 try{
  const flow=await f.start({oldSession:true});
  f.sql.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').run(now(),'legacy-session');
  const response=await f.finish(flow);
  assert.equal(response.status,403);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM homeflow_identity_links').get().n,0);
 }finally{f.sql.close();}
});
