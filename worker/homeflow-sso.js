import {json,bad} from './http.js';
import {randomToken,hashString,hmacHex,safeEqual,parseCookie,cookieForSession,isoNow} from './security.js';

// Stage B/E: server-bound HomeFlow SSO bridge for THIS Worker only.
// No direct ID assignment from client fields, no shared passwords, no R2 writes.
// Deliberately off unless HOMEFLOW_SSO_ENABLED === 'true'; do not enable
// before four production backups, the identity-link migration and PWA audit.
const CLIENT_ID='jp-document-assistant';
const PENDING_MS=5*60*1000;
const SESSION_MS=15*60*1000;
const enc=new TextEncoder();
const dbFirst=(db,sql,...values)=>db.prepare(sql).bind(...values).first();
const dbRun=(db,sql,...values)=>db.prepare(sql).bind(...values).run();
const nowPlus=delta=>new Date(Date.now()+delta).toISOString();
const isUrlOrigin=value=>{
  try{const url=new URL(value);return url.protocol==='https:'&&
    url.origin===value&&!url.username&&!url.password&&!url.hash&&!url.search;}
  catch{return false;}
};
function enabled(env,url){
 return env.HOMEFLOW_SSO_ENABLED==='true' &&
   typeof env.HOMEFLOW_SSO_ENCRYPTION_KEY==='string' &&
   /^[a-f0-9]{64}$/i.test(env.HOMEFLOW_SSO_ENCRYPTION_KEY) &&
   typeof env.SESSION_HMAC_KEY==='string' && env.SESSION_HMAC_KEY.length>=32 &&
   isUrlOrigin(env.HOMEFLOW_OAUTH_ORIGIN) &&
   isUrlOrigin(env.DA_PUBLIC_ORIGIN) &&
   env.DA_PUBLIC_ORIGIN===url.origin &&
   typeof env.DB?.prepare==='function' &&
   typeof env.HOMEFLOW_BRIDGE_SERVICE?.fetch==='function';
}
function stateCookie(value,maxAge){
 return '__Host-da_homeflow_state='+value+
   '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age='+maxAge;
}
const clearState=()=>stateCookie('',0);
async function encryptionKey(env){
 const bytes=Uint8Array.from(env.HOMEFLOW_SSO_ENCRYPTION_KEY.match(/.{2}/g),x=>parseInt(x,16));
 return crypto.subtle.importKey('raw',bytes,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
const b64url=bytes=>btoa(String.fromCharCode(...bytes))
  .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const b64=bytes=>btoa(String.fromCharCode(...bytes));
const unb64=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
async function challenge(verifier){
 const bytes=await crypto.subtle.digest('SHA-256',enc.encode(verifier));
 return b64url(new Uint8Array(bytes));
}
async function sealVerifier(env,stateHash,value){
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const cipher=await crypto.subtle.encrypt({
   name:'AES-GCM',iv,additionalData:enc.encode('da-homeflow-sso:'+stateHash)
 },await encryptionKey(env),enc.encode(value));
 return {cipher:b64(new Uint8Array(cipher)),iv:b64(iv)};
}
async function openVerifier(env,stateHash,row){
 try{
  const bytes=await crypto.subtle.decrypt({
   name:'AES-GCM',iv:unb64(row.verifier_iv),
   additionalData:enc.encode('da-homeflow-sso:'+stateHash)
  },await encryptionKey(env),unb64(row.verifier_cipher));
  const value=new TextDecoder().decode(bytes);
  if(!/^[A-Za-z0-9._~-]{43,128}$/.test(value))throw Error('invalid verifier');
  return value;
 }catch{bad('登录流程已失效，请重新发起','SSO_INVALID_STATE',403);}
}
async function localSession(env,request){
 const cookie=parseCookie(request,'__Host-da_session');
 if(!/^[a-f0-9]{64}$/.test(cookie||''))return null;
 return dbFirst(env.DB,`SELECT s.id session_id,s.user_id,u.role,u.household_id
   FROM sessions s JOIN users u ON u.id=s.user_id
   WHERE s.secret_hash=? AND s.revoked_at IS NULL
   AND s.expires_at>? AND u.status='active'`,
   await hashString(cookie),isoNow());
}
const callbackUrl=env=>env.DA_PUBLIC_ORIGIN+'/api/homeflow-sso/callback';

export async function startHomeFlowSso(request,env,url){
 if(request.method!=='POST')return json({ok:false,code:'METHOD_NOT_ALLOWED'},405);
 if(!enabled(env,url))return json({ok:false,code:'SSO_DISABLED'},503);
 if(request.headers.get('origin')!==url.origin)
   return json({ok:false,code:'BAD_ORIGIN'},403);
 const local=await localSession(env,request);
 // Existing legacy owner can be linked only if an authenticated local owner
 // actually initiated THIS exact one-time flow. No nickname/email inference.
 if(local&&local.role!=='owner'&&local.role!=='member')
   return json({ok:false,code:'INVALID_LOCAL_SESSION'},403);
 const state=randomToken(32);
 const stateHash=await hashString(state);
 const verifier=randomToken(48);
 const nonce=randomToken(24);
 const sealed=await sealVerifier(env,stateHash,verifier);
 const created=isoNow(),expires=nowPlus(PENDING_MS);
 await dbRun(env.DB,`INSERT INTO homeflow_oauth_pending
   (state_hash,verifier_cipher,verifier_iv,nonce,origin,
    local_session_id,local_user_id,status,expires_at,created_at)
   VALUES(?,?,?,?,?,?,?,'pending',?,?)`,
   stateHash,sealed.cipher,sealed.iv,nonce,url.origin,
   local?.session_id||null,local?.user_id||null,expires,created);
 const auth=new URL('/authorize',env.HOMEFLOW_OAUTH_ORIGIN);
 auth.searchParams.set('response_type','code');
 auth.searchParams.set('client_id',CLIENT_ID);
 auth.searchParams.set('redirect_uri',callbackUrl(env));
 auth.searchParams.set('code_challenge',await challenge(verifier));
 auth.searchParams.set('code_challenge_method','S256');
 auth.searchParams.set('state',state);
 auth.searchParams.set('nonce',nonce);
 return json({ok:true,authorization_url:auth.toString(),expires_in:300},200,{
   'Set-Cookie':stateCookie(state,300)
 });
}

async function verifyHomeFlow(env,code,verifier){
 const tokenReq=new Request(new URL('/api/oauth/token',env.HOMEFLOW_OAUTH_ORIGIN),{
   method:'POST',redirect:'manual',
   headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},
   body:new URLSearchParams({
     grant_type:'authorization_code',client_id:CLIENT_ID,
     redirect_uri:callbackUrl(env),code,code_verifier:verifier
   }).toString()
 });
 let tokenRes;
 try{tokenRes=await env.HOMEFLOW_BRIDGE_SERVICE.fetch(tokenReq);}
 catch{return null;}
 if(!tokenRes?.ok || tokenRes.status!==200 ||
    tokenRes.headers.get('location'))return null;
 const token=await tokenRes.json().catch(()=>null);
 if(!token||token.token_type!=='Bearer'||
    typeof token.access_token!=='string'||
    !/^[a-f0-9]{64}$/.test(token.access_token)||
    Number(token.expires_in)>180||Number(token.expires_in)<=0)return null;
 const infoReq=new Request(new URL('/api/oauth/userinfo',env.HOMEFLOW_OAUTH_ORIGIN),{
   method:'GET',redirect:'manual',
   headers:{Authorization:'Bearer '+token.access_token,Accept:'application/json'}
 });
 let infoRes;
 try{infoRes=await env.HOMEFLOW_BRIDGE_SERVICE.fetch(infoReq);}
 catch{return null;}
 if(!infoRes?.ok||infoRes.status!==200||infoRes.headers.get('location'))return null;
 const info=await infoRes.json().catch(()=>null);
 if(!info||info.audience!==CLIENT_ID ||
    typeof info.user_id!=='string'||info.sub!==info.user_id||
    !/^[a-f0-9-]{32,64}$/i.test(info.user_id)||
    typeof info.household_id!=='string'||
    !/^[a-f0-9-]{32,64}$/i.test(info.household_id)||
    !['owner','member'].includes(info.role)||
    typeof info.nickname!=='string'||!info.nickname.trim()||
    info.nickname.length>80)return null;
 return {homeflowUserId:info.user_id,
   homeflowHouseholdId:info.household_id,
   role:info.role,nickname:info.nickname.trim().slice(0,50)};
}

async function resolveLocalIdentity(env,pending,hf){
 const db=env.DB;
 const link=await dbFirst(db,`SELECT l.homeflow_household_id,l.local_user_id,
   l.state,u.household_id,u.role,u.status
   FROM homeflow_identity_links l JOIN users u ON u.id=l.local_user_id
   WHERE l.homeflow_user_id=?`,hf.homeflowUserId);
 if(link){
   if(link.state!=='active'||link.homeflow_household_id!==hf.homeflowHouseholdId||
      link.status!=='active'||link.role!==hf.role)
     bad('该账号关联需要人工检查','SSO_LINK_CONFLICT',409);
   return {localUserId:link.local_user_id,householdId:link.household_id,created:false};
 }
 const now=isoNow();
 if(hf.role==='owner'){
   if(!pending.local_user_id||!pending.local_session_id)
     bad('首次关联管理员需要先登录原文书助手账号','SSO_OWNER_PROOF_REQUIRED',403);
   const legacy=await dbFirst(db,`SELECT u.id,u.household_id FROM users u
     JOIN sessions s ON s.user_id=u.id
     WHERE u.id=? AND s.id=? AND s.revoked_at IS NULL
       AND s.expires_at>? AND u.status='active' AND u.role='owner'`,
      pending.local_user_id,pending.local_session_id,now);
   if(!legacy)bad('原文书助手管理员会话已经失效','SSO_OWNER_PROOF_REQUIRED',403);
   await db.batch([
     db.prepare(`INSERT INTO homeflow_identity_links
       (homeflow_user_id,homeflow_household_id,local_user_id,verified_at)
       VALUES(?,?,?,?)`).bind(hf.homeflowUserId,hf.homeflowHouseholdId,legacy.id,now),
     db.prepare('UPDATE users SET display_name=?,updated_at=? WHERE id=?')
       .bind(hf.nickname,now,legacy.id),
     db.prepare(`INSERT INTO audit_events
       (id,actor_user_id,kind,entity_type,entity_id,created_at)
       VALUES(?,?,'homeflow_owner_link_verified','identity_link',?,?)`)
       .bind(randomToken(16),legacy.id,legacy.id,now)
   ]);
   return {localUserId:legacy.id,householdId:legacy.household_id,created:true};
 }
 // Member must start from an empty local space under the *linked owner*
 // household, never from the owner's existing local user or Google grants.
 const household=await dbFirst(db,`SELECT u.household_id FROM homeflow_identity_links l
   JOIN users u ON u.id=l.local_user_id
   WHERE l.homeflow_household_id=? AND l.state='active'
     AND u.role='owner' AND u.status='active' LIMIT 1`,hf.homeflowHouseholdId);
 if(!household)bad('请先使用管理员账号完成首次关联','SSO_OWNER_FIRST',403);
 const uid=randomToken(16);
 const alias='hf-'+(await hashString(hf.homeflowUserId)).slice(0,40)+'@login.invalid';
 await db.batch([
   db.prepare(`INSERT INTO users
     (id,household_id,email_norm,display_name,role,status,created_at,updated_at)
     VALUES(?,?,?,?,'member','active',?,?)`)
     .bind(uid,household.household_id,alias,hf.nickname,now,now),
   db.prepare(`INSERT INTO homeflow_identity_links
     (homeflow_user_id,homeflow_household_id,local_user_id,verified_at)
     VALUES(?,?,?,?)`).bind(hf.homeflowUserId,hf.homeflowHouseholdId,uid,now),
   db.prepare(`INSERT INTO audit_events
     (id,actor_user_id,kind,entity_type,entity_id,created_at)
     VALUES(?,?,'homeflow_member_provisioned','identity_link',?,?)`)
     .bind(randomToken(16),uid,uid,now)
 ]);
 return {localUserId:uid,householdId:household.household_id,created:true};
}
function invalidCallback(code='SSO_CALLBACK_INVALID',status=403){
 return json({ok:false,code},status,{'Referrer-Policy':'no-referrer'});
}
export async function callbackHomeFlowSso(request,env,url){
 if(request.method!=='GET')return json({ok:false,code:'METHOD_NOT_ALLOWED'},405);
 if(!enabled(env,url))return json({ok:false,code:'SSO_DISABLED'},503);
 const state=url.searchParams.get('state')||'';
 const cookie=parseCookie(request,'__Host-da_homeflow_state')||'';
 // SameSite=Lax binds the authorization result to the *same browser* that
 // started it. An iOS PWA/Safari context mismatch deliberately fails closed;
 // the later native-PWA handoff needs its own audited one-use mechanism.
 if(!/^[a-f0-9]{64}$/.test(state)||!safeEqual(state,cookie))
   return invalidCallback('SSO_BROWSER_CONTEXT_MISMATCH');
 const hash=await hashString(state);
 const pending=await dbFirst(env.DB,`SELECT * FROM homeflow_oauth_pending
   WHERE state_hash=? AND status='pending' AND expires_at>? AND origin=?`,
   hash,isoNow(),url.origin);
 if(!pending)return invalidCallback('SSO_INVALID_STATE');
 const locked=await dbRun(env.DB,`UPDATE homeflow_oauth_pending
   SET status='processing' WHERE state_hash=? AND status='pending' AND expires_at>?`,
   hash,isoNow());
 if(Number(locked?.meta?.changes)!==1)return invalidCallback('SSO_REPLAY');
 const fail=async reason=>{
   await dbRun(env.DB,`UPDATE homeflow_oauth_pending
     SET status='failed',completed_at=? WHERE state_hash=? AND status='processing'`,
     isoNow(),hash).catch(()=>null);
   return invalidCallback(reason);
 };
 const code=url.searchParams.get('code')||'';
 if(url.searchParams.has('error')||!/^[a-f0-9]{64}$/.test(code))
   return fail('SSO_NO_CODE');
 try{
   const verifier=await openVerifier(env,hash,pending);
   const hf=await verifyHomeFlow(env,code,verifier);
   if(!hf)return fail('SSO_UNVERIFIED_IDENTITY');
   const local=await resolveLocalIdentity(env,pending,hf);
   // Re-check and refresh the user-facing nickname. Keep the old local FK.
   if(!local.created)await dbRun(env.DB,
     'UPDATE users SET display_name=?,updated_at=? WHERE id=? AND status=? AND role=?',
     hf.nickname,isoNow(),local.localUserId,'active',hf.role);
   const cookieValue=randomToken(32),now=isoNow();
   const exp=nowPlus(SESSION_MS);
   await env.DB.batch([
     env.DB.prepare(`INSERT INTO sessions
       (id,user_id,secret_hash,expires_at,created_at)
       VALUES(?,?,?,?,?)`)
       .bind(randomToken(16),local.localUserId,await hashString(cookieValue),exp,now),
     env.DB.prepare(`UPDATE homeflow_oauth_pending SET status='consumed',completed_at=?
       WHERE state_hash=? AND status='processing'`).bind(now,hash)
   ]);
   const headers=new Headers({
     'Location':env.DA_PUBLIC_ORIGIN+'/?homeflow_sso=connected',
     'Cache-Control':'no-store','Referrer-Policy':'no-referrer'
   });
   headers.append('Set-Cookie',cookieForSession(cookieValue,SESSION_MS/1000));
   headers.append('Set-Cookie',clearState());
   return new Response(null,{status:303,headers});
 }catch{return fail('SSO_LINK_FAILED');}
}
