import {json,bad} from './http.js';

// Code-model OAuth only. Google refresh tokens live encrypted in the existing
// private D1; never in the PWA, logs, HTML, R2, or API responses.
const SERVICE='gmail';
const SCOPE='https://www.googleapis.com/auth/gmail.readonly';
const GMAIL='https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_ENDPOINT='https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT='https://oauth2.googleapis.com/revoke';

const dbFirst=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const dbRun=(db,sql,...args)=>db.prepare(sql).bind(...args).run();
const now=()=>new Date().toISOString();
const safeId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{5,128}$/.test(v);
const safeHeader=v=>String(v||'').replace(/[\r\n\x00-\x1f]/g,' ').slice(0,250);
function enabled(env){
  return /^[\w.-]+\.apps\.googleusercontent\.com$/.test(String(env.GOOGLE_OAUTH_CLIENT_ID||''))&&
    !!String(env.GOOGLE_OAUTH_CLIENT_SECRET||'')&&
    /^[a-fA-F0-9]{64}$/.test(String(env.GOOGLE_TOKEN_ENCRYPTION_KEY||''));
}
const loadGrant=(env,p)=>dbFirst(env.DB,
  "SELECT service,google_email,scope,refresh_cipher,refresh_iv,status,created_at FROM google_oauth_grants WHERE user_id=? AND service=?",
  p.user_id,SERVICE);
const encodeBytes=bytes=>btoa(String.fromCharCode(...bytes));
const decodeBytes=value=>Uint8Array.from(atob(value),x=>x.charCodeAt(0));
async function key(env){
  const hex=String(env.GOOGLE_TOKEN_ENCRYPTION_KEY||'');
  if(!/^[0-9a-fA-F]{64}$/.test(hex))bad('Google 令牌加密密钥尚未配置','GOOGLE_NOT_CONFIGURED',503);
  const material=Uint8Array.from(hex.match(/.{2}/g),v=>parseInt(v,16));
  return crypto.subtle.importKey('raw',material,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
async function seal(env,value,userId){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const aad=new TextEncoder().encode('jpda-google-gmail:'+userId);
  const ciphertext=await crypto.subtle.encrypt(
    {name:'AES-GCM',iv,additionalData:aad},await key(env),new TextEncoder().encode(value));
  return {refresh_cipher:encodeBytes(new Uint8Array(ciphertext)),refresh_iv:encodeBytes(iv)};
}
async function openSeal(env,grant,userId){
  try{
    const aad=new TextEncoder().encode('jpda-google-gmail:'+userId);
    const bytes=await crypto.subtle.decrypt(
      {name:'AES-GCM',iv:decodeBytes(grant.refresh_iv),additionalData:aad},
      await key(env),decodeBytes(grant.refresh_cipher));
    return new TextDecoder().decode(bytes);
  }catch{bad('Google 授权密钥无法解密，请联系管理员；不会清除原记录','GOOGLE_DECRYPT_FAILED',503)}
}
async function googleFetch(env,url,options){
  const fetcher=env.GOOGLE_OAUTH_FETCH||fetch;
  return fetcher(url,{...options,cache:'no-store',redirect:'error'});
}
async function tokenRequest(env,params){
  const r=await googleFetch(env,TOKEN_ENDPOINT,{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},
    body:new URLSearchParams(params).toString()});
  const value=await r.json().catch(()=>null);
  if(!r.ok||!value||typeof value!=='object'){
    const error=String(value?.error||'');
    if(error==='invalid_grant')bad('Google 授权已过期或已被撤销，需要重新连接','GOOGLE_REAUTH_REQUIRED',401);
    bad('Google 授权服务器暂不可用','GOOGLE_TOKEN_ERROR',502);
  }
  return value;
}
async function gmailGet(env,accessToken,path){
  const u=new URL(GMAIL+path);
  if(u.origin!=='https://gmail.googleapis.com'||!u.pathname.startsWith(GMAIL+'/')&&u.pathname!==GMAIL)
    bad('Gmail API 请求地址无效','INVALID_PATH',400);
  const response=await googleFetch(env,u.toString(),{method:'GET',
    headers:{Authorization:'Bearer '+accessToken,Accept:'application/json'}});
  if(response.status===401||response.status===403)
    bad('Google Gmail 访问被拒绝，请重新检查连接授权','GOOGLE_GMAIL_DENIED',403);
  if(!response.ok)bad('Gmail 当前不可读取','GOOGLE_GMAIL_UNAVAILABLE',502);
  const content=await response.json().catch(()=>null);
  if(!content||typeof content!=='object')bad('Gmail 响应格式错误','GOOGLE_BAD_RESPONSE',502);
  return content;
}
async function accessToken(env,p){
  const grant=await loadGrant(env,p);
  if(!grant||grant.status!=='connected')bad('请先连接 Gmail','GOOGLE_GMAIL_NOT_CONNECTED',409);
  const refresh=await openSeal(env,grant,p.user_id);
  try{
    const token=await tokenRequest(env,{
      client_id:String(env.GOOGLE_OAUTH_CLIENT_ID),
      client_secret:String(env.GOOGLE_OAUTH_CLIENT_SECRET),
      grant_type:'refresh_token',refresh_token:refresh
    });
    if(!token.access_token||!String(token.scope||SCOPE).split(' ').includes(SCOPE))
      bad('Google 返回的授权范围不包含 Gmail 只读权限','GOOGLE_SCOPE_MISSING',403);
    return token.access_token;
  }catch(e){
    if(e?.code==='GOOGLE_REAUTH_REQUIRED'){
      await dbRun(env.DB,"UPDATE google_oauth_grants SET status='reauth_required',updated_at=? WHERE user_id=? AND service=?",
        now(),p.user_id,SERVICE);
    }
    throw e;
  }
}
export async function handleGoogleGmail(request,env,p,path,url){
  if(path==='/api/google/gmail/status'&&request.method==='GET'){
    if(!enabled(env))return json({enabled:false,connected:false,reason:'Google 长期授权需要管理员配置 OAuth 客户端密钥和令牌加密密钥'});
    const grant=await loadGrant(env,p);
    return json({enabled:true,client_id:String(env.GOOGLE_OAUTH_CLIENT_ID),
      connected:grant?.status==='connected',
      needs_reauthorization:grant?.status==='reauth_required',
      google_email:grant?.status==='connected'?grant.google_email:null});
  }
  if(!enabled(env))bad('Google 长期授权尚未配置完成','GOOGLE_NOT_CONFIGURED',503);
  if(path==='/api/google/gmail/connect'&&request.method==='POST'){
    const data=await request.json().catch(()=>null);
    const code=data?.code;
    if(typeof code!=='string'||code.length<12||code.length>4096||!/^[A-Za-z0-9_./-]+$/.test(code))
      bad('Google 授权码无效','GOOGLE_BAD_CODE',400);
    // GIS popup code model requires redirect_uri to equal the PWA origin,
    // not an arbitrary user-supplied URI.
    const tokens=await tokenRequest(env,{
      client_id:String(env.GOOGLE_OAUTH_CLIENT_ID),
      client_secret:String(env.GOOGLE_OAUTH_CLIENT_SECRET),
      code,grant_type:'authorization_code',redirect_uri:url.origin
    });
    if(!tokens.access_token||!String(tokens.scope||'').split(' ').includes(SCOPE))
      bad('未获得 Gmail 只读权限；不会保存 Google 授权','GOOGLE_SCOPE_MISSING',403);
    const profile=await gmailGet(env,tokens.access_token,'/profile');
    const email=String(profile.emailAddress||'').trim().toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>250)
      bad('无法验证 Google Gmail 账户','GOOGLE_IDENTITY_MISSING',422);
    const existing=await loadGrant(env,p);
    if(typeof tokens.refresh_token!=='string'||tokens.refresh_token.length<12){
      // A repeated consent often returns only an access token. Never bind
      // another Google identity to the prior account's refresh token.
      if(existing?.status==='connected'&&existing.google_email===email)
        return json({ok:true,connected:true,google_email:email,reused:true});
      bad('Google 未返回长期刷新令牌，请在 Google 账号中撤销旧授权后重新连接','GOOGLE_REFRESH_TOKEN_MISSING',409);
    }
    const sealed=await seal(env,tokens.refresh_token,p.user_id);
    const ts=now();
    await dbRun(env.DB,
      "INSERT INTO google_oauth_grants(user_id,service,google_email,scope,refresh_cipher,refresh_iv,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,service) DO UPDATE SET google_email=excluded.google_email,scope=excluded.scope,refresh_cipher=excluded.refresh_cipher,refresh_iv=excluded.refresh_iv,status='connected',updated_at=excluded.updated_at",
      p.user_id,SERVICE,email,SCOPE,sealed.refresh_cipher,sealed.refresh_iv,'connected',ts,ts);
    return json({ok:true,connected:true,google_email:email});
  }
  if(path==='/api/google/gmail/disconnect'&&request.method==='POST'){
    const grant=await loadGrant(env,p);
    await dbRun(env.DB,"DELETE FROM google_oauth_grants WHERE user_id=? AND service=?",p.user_id,SERVICE);
    let remotelyRevoked=false;
    if(grant){
      try{
        const refresh=await openSeal(env,grant,p.user_id);
        const r=await googleFetch(env,REVOKE_ENDPOINT,{method:'POST',
          headers:{'Content-Type':'application/x-www-form-urlencoded'},
          body:new URLSearchParams({token:refresh}).toString()});
        remotelyRevoked=r.ok;
      }catch{ /* Local disconnect remains authoritative; never re-save a token. */ }
    }
    return json({ok:true,connected:false,remotely_revoked:remotelyRevoked});
  }
  if(path==='/api/google/gmail/messages'&&request.method==='GET'){
    const q=String(url.searchParams.get('q')||'').trim();
    const pageToken=String(url.searchParams.get('pageToken')||'').trim();
    if(q.length>180||pageToken.length>1000)bad('搜索或分页条件超出限制','GOOGLE_BAD_QUERY',400);
    const token=await accessToken(env,p);
    const params=new URLSearchParams({maxResults:'5',q});
    if(pageToken)params.set('pageToken',pageToken);
    const list=await gmailGet(env,token,'/messages?'+params.toString());
    const ids=(Array.isArray(list.messages)?list.messages:[]).slice(0,5)
      .map(m=>m?.id).filter(safeId);
    const items=await Promise.all(ids.map(async id=>{
      const x=await gmailGet(env,token,'/messages/'+encodeURIComponent(id)+
        '?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date&fields=id%2Cpayload(headers)');
      const headers=x.payload?.headers;
      const find=name=>safeHeader(Array.isArray(headers)?
        headers.find(h=>String(h?.name||'').toLowerCase()===name)?.value:'');
      return {id,subject:find('subject')||'（无标题）',from:find('from'),date:find('date')};
    }));
    return json({items,nextPageToken:typeof list.nextPageToken==='string'&&
      list.nextPageToken.length<1000?list.nextPageToken:null});
  }
  const picked=request.method==='GET'?/^\/api\/google\/gmail\/messages\/([A-Za-z0-9_-]{5,128})$/.exec(path):null;
  if(picked){
    const token=await accessToken(env,p);
    const mail=await gmailGet(env,token,'/messages/'+encodeURIComponent(picked[1])+'?format=full&fields=id%2Cpayload');
    return json({payload:mail.payload||null});
  }
  bad('Gmail 接口不存在','NOT_FOUND',404);
}