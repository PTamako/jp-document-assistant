import {json,bad,readJson} from './http.js';

// Google web-server authorization flow: PWA -> Google browser -> public callback.
// CSRF state is random and hashed in D1, bound to the authenticated local user.
// Neither browser receives a refresh token; callback doesn't need Safari cookies.
const BASE='https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN='https://oauth2.googleapis.com/token';
const SCOPES={
 gmail:'https://www.googleapis.com/auth/gmail.readonly',
 drive:'https://www.googleapis.com/auth/drive.readonly'
};
const GOOGLE_ERRORS=Object.freeze({
 GOOGLE_DENIED:'Google 没有授予权限，请重新尝试',
 GOOGLE_CODE_MISSING:'Google 未返回授权码',
 GOOGLE_CLIENT_INVALID:'Google 客户端密钥无效，请检查 Cloudflare 配置',
 GOOGLE_INVALID_GRANT:'授权码已失效，请重新连接',
 GOOGLE_TOKEN_REQUEST:'Google 授权请求参数有误',
 GOOGLE_TOKEN_NETWORK:'无法连接 Google 授权服务',
 GOOGLE_TOKEN_FAILED:'Google 令牌交换失败',
 GOOGLE_SCOPE_MISSING:'Google 没有授予所需权限',
 GOOGLE_PROFILE_DENIED:'Google 拒绝访问账号信息，请检查 API 是否启用',
 GOOGLE_PROFILE_FAILED:'读取 Google 账号信息失败，请检查 API 是否启用',
 GOOGLE_EMAIL_UNVERIFIED:'Google 没有返回有效账号邮箱',
 GOOGLE_REFRESH_MISSING:'Google 未返回长期授权，请重新连接',
 GOOGLE_STORAGE_FAILED:'保存授权失败，请检查数据库',
 GOOGLE_NOT_CONFIGURED:'服务器 Google 密钥未配置完整',
 GOOGLE_CALLBACK_FAILED:'Google 回调处理失败'
});
const failureCode=error=>Object.hasOwn(GOOGLE_ERRORS,error?.code)?error.code:null;
const MAX_BYTES=8*1024*1024;
const MAX_FILE_COUNT=10;
const dbFirst=(db,sql,...p)=>db.prepare(sql).bind(...p).first();
const dbRun=(db,sql,...p)=>db.prepare(sql).bind(...p).run();
const utc=()=>new Date().toISOString();
const enc=new TextEncoder();
const validService=s=>Object.hasOwn(SCOPES,s);
const validId=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{8,256}$/.test(s);
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const random=()=>hex(crypto.getRandomValues(new Uint8Array(32)));
const b64=bytes=>btoa(String.fromCharCode(...bytes));
const unb64=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const digest=async value=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value))));
function configured(env){
 return /^[\w.-]+\.apps\.googleusercontent\.com$/.test(String(env.GOOGLE_OAUTH_CLIENT_ID||''))&&
   !!String(env.GOOGLE_OAUTH_CLIENT_SECRET||'')&&
   /^[0-9a-f]{64}$/i.test(String(env.GOOGLE_TOKEN_ENCRYPTION_KEY||''));
}
async function cipherKey(env){
 const raw=Uint8Array.from(env.GOOGLE_TOKEN_ENCRYPTION_KEY.match(/.{2}/g),x=>parseInt(x,16));
 return crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
async function encrypt(env,service,uid,secret){
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const aad=enc.encode('jpda-google-'+service+':'+uid);
 const bytes=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},
   await cipherKey(env),enc.encode(secret));
 return {body:b64(new Uint8Array(bytes)),iv:b64(iv)};
}
async function decrypt(env,service,uid,grant){
 try{
   const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(grant.refresh_iv),
     additionalData:enc.encode('jpda-google-'+service+':'+uid)},await cipherKey(env),unb64(grant.refresh_cipher));
   return new TextDecoder().decode(bytes);
 }catch{bad('Google 授权密钥不可解密，请管理员检查配置','GOOGLE_KEY_UNAVAILABLE',503)}
}
async function googleFetch(env,url,init){
 return (env.GOOGLE_OAUTH_FETCH||fetch)(url,{...init,cache:'no-store',redirect:'error'});
}
async function tokenRequest(env,payload){
 let response;
 try{
   response=await googleFetch(env,TOKEN,{method:'POST',
     headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},
     body:new URLSearchParams(payload).toString()});
 }catch{bad('无法连接 Google 授权服务','GOOGLE_TOKEN_NETWORK',502)}
 const data=await response.json().catch(()=>null);
 if(!response.ok||!data?.access_token){
   if(['invalid_client','unauthorized_client'].includes(data?.error))
     bad('Google 客户端密钥无效','GOOGLE_CLIENT_INVALID',502);
   if(data?.error==='invalid_grant')
     bad('Google 授权码无效或已过期','GOOGLE_INVALID_GRANT',401);
   if(data?.error==='invalid_request'||data?.error==='redirect_uri_mismatch')
     bad('Google 授权参数不匹配','GOOGLE_TOKEN_REQUEST',502);
   bad('Google 授权交换失败','GOOGLE_TOKEN_FAILED',502);
 }
 return data;
}
async function grantFor(env,uid,service){
 return dbFirst(env.DB,'SELECT * FROM google_oauth_grants WHERE user_id=? AND service=?',uid,service);
}
async function getAccess(env,uid,service){
 const row=await grantFor(env,uid,service);
 if(!row||row.status!=='connected')bad('请先连接 Google '+service,'GOOGLE_NOT_CONNECTED',409);
 const refresh=await decrypt(env,service,uid,row);
 try{
   const token=await tokenRequest(env,{
     client_id:env.GOOGLE_OAUTH_CLIENT_ID,client_secret:env.GOOGLE_OAUTH_CLIENT_SECRET,
     grant_type:'refresh_token',refresh_token:refresh
   });
   if(token.scope&&!token.scope.split(' ').includes(SCOPES[service]))
     bad('Google 返回的访问权限不足','GOOGLE_SCOPE_MISSING',403);
   return token.access_token;
 }catch(error){
   if(error?.code==='GOOGLE_INVALID_GRANT')
     await dbRun(env.DB,"UPDATE google_oauth_grants SET status='reauth_required',updated_at=? WHERE user_id=? AND service=?",
       utc(),uid,service);
   throw error;
 }
}
async function googleJSON(env,url,token){
 let res;
 try{
   res=await googleFetch(env,url,{method:'GET',
     headers:{Authorization:'Bearer '+token,Accept:'application/json'}});
 }catch{bad('无法访问 Google API','GOOGLE_PROFILE_FAILED',502)}
 if([401,403].includes(res.status))
   bad('Google API 拒绝访问，请检查是否已启用 Gmail API 和 Drive API','GOOGLE_PROFILE_DENIED',403);
 if(!res.ok)bad('Google API 请求失败','GOOGLE_PROFILE_FAILED',502);
 return res.json().catch(()=>bad('Google 返回格式不正确','GOOGLE_PROFILE_FAILED',502));
}
const callbackUri=origin=>origin+'/api/google/oauth/callback';
function finishedPage(origin,success,reason=''){
 const title=success?'Google 授权成功':'Google 授权未完成';
 const description=success?'返回文书助手即可使用。':
   GOOGLE_ERRORS[reason]||'请返回文书助手重试。';
 // No state, OAuth code, identity, token or secret is rendered in HTML.
 const html='<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+title+'</title></head>'+
   '<body style="font-family:system-ui;max-width:440px;margin:12vh auto;padding:24px;text-align:center">'+
   '<h2>'+title+'</h2><p>'+description+'</p><p><a href="'+origin+'/" style="display:block;padding:14px;border:1px solid;border-radius:12px">返回文书助手</a></p></body></html>';
 return new Response(html,{status:200,headers:{
   'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
   'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
   'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
 }});
}
export async function oauthCallback(request,env,url){
 const origin=url.origin;
 const state=url.searchParams.get('state')||'';
 if(!/^[0-9a-f]{64}$/.test(state))return finishedPage(origin,false);
 const stateHash=await digest(state);
 const row=await dbFirst(env.DB,
   'SELECT * FROM google_oauth_pending WHERE state_hash=?',stateHash);
 if(!row||row.status!=='pending'||row.expires_at<utc())return finishedPage(origin,false);
 const taken=await dbRun(env.DB,
   "UPDATE google_oauth_pending SET status='processing' WHERE state_hash=? AND status='pending' AND expires_at>?",
   stateHash,utc());
 if(taken.meta?.changes!==1)return finishedPage(origin,false);
 const code=url.searchParams.get('code');
 if(url.searchParams.has('error')||typeof code!=='string'||code.length<8||code.length>4096){
   const errorCode=url.searchParams.has('error')?'GOOGLE_DENIED':'GOOGLE_CODE_MISSING';
   await dbRun(env.DB,"UPDATE google_oauth_pending SET status='failed',error_code=? WHERE state_hash=?",errorCode,stateHash);
   return finishedPage(origin,false,errorCode);
 }
 let stage='token';
 try{
   if(!configured(env))bad('Google OAuth 后端未配置','GOOGLE_NOT_CONFIGURED',503);
   const tokens=await tokenRequest(env,{
     client_id:env.GOOGLE_OAUTH_CLIENT_ID,client_secret:env.GOOGLE_OAUTH_CLIENT_SECRET,
     redirect_uri:callbackUri(origin),grant_type:'authorization_code',code,
     code_verifier:row.pkce_verifier
   });
   // Google's OAuth token response can omit scope. Check it when present;
   // always verify actual API access using the granted bearer token.
   if(tokens.scope&&!String(tokens.scope).split(' ').includes(SCOPES[row.service]))
     bad('Google 所授权限不完整','GOOGLE_SCOPE_MISSING',403);
   stage='profile';
   const profile=row.service==='gmail'
     ?await googleJSON(env,'https://gmail.googleapis.com/gmail/v1/users/me/profile',tokens.access_token)
     :await googleJSON(env,'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',tokens.access_token);
   const email=String(row.service==='gmail'?profile.emailAddress:profile.user?.emailAddress||'')
     .toLowerCase().trim();
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>250)
     bad('无法验证 Google 账号','GOOGLE_EMAIL_UNVERIFIED',422);
   stage='grant';
   const old=await grantFor(env,row.user_id,row.service);
   const refresh=typeof tokens.refresh_token==='string'&&tokens.refresh_token.length>12
     ?tokens.refresh_token:null;
   if(!refresh&&!(old?.status==='connected'&&old.google_email===email))
     bad('Google 未提供长期凭据，请重新授权','GOOGLE_REFRESH_MISSING',409);
   let stored=refresh?await encrypt(env,row.service,row.user_id,refresh):
     {body:old.refresh_cipher,iv:old.refresh_iv};
   const time=utc();
   await dbRun(env.DB,
     "INSERT INTO google_oauth_grants(user_id,service,google_email,scope,refresh_cipher,refresh_iv,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,service) DO UPDATE SET google_email=excluded.google_email,scope=excluded.scope,refresh_cipher=excluded.refresh_cipher,refresh_iv=excluded.refresh_iv,status='connected',updated_at=excluded.updated_at",
     row.user_id,row.service,email,SCOPES[row.service],stored.body,stored.iv,'connected',time,time);
   await dbRun(env.DB,"UPDATE google_oauth_pending SET status='done',error_code=NULL WHERE state_hash=?",stateHash);
   return finishedPage(origin,true);
 }catch(error){
   // Never render/log/store Google error_description, authorization code,
   // tokens, client secrets, user email or raw exception strings.
   const errorCode=failureCode(error)||
     (stage==='grant'?'GOOGLE_STORAGE_FAILED':
       stage==='profile'?'GOOGLE_PROFILE_FAILED':'GOOGLE_TOKEN_FAILED');
   await dbRun(env.DB,"UPDATE google_oauth_pending SET status='failed',error_code=? WHERE state_hash=?",errorCode,stateHash);
   return finishedPage(origin,false,errorCode);
 }
}
export async function handleBrowserGoogle(request,env,p,url){
 const path=url.pathname,method=request.method;
 if(path==='/api/google/oauth/status'&&method==='GET'){
   const service=url.searchParams.get('service');
   if(!validService(service))bad('不支持的 Google 服务','GOOGLE_INVALID_SERVICE',400);
   if(!configured(env))return json({enabled:false,connected:false,service});
   const grant=await grantFor(env,p.user_id,service);
   const flow=url.searchParams.get('flow');
   let progress=null,progressError=null;
   if(flow&&/^[0-9a-f]{64}$/.test(flow)){
     const r=await dbFirst(env.DB,
       "SELECT status,error_code,expires_at FROM google_oauth_pending WHERE state_hash=? AND user_id=? AND service=?",
       await digest(flow),p.user_id,service);
     progress=r?(r.status==='pending'&&r.expires_at<utc()?'expired':r.status):null;
     progressError=r?.status==='failed'?GOOGLE_ERRORS[r.error_code]||'Google 授权未完成':null;
   }else if(!grant||grant.status!=='connected'){
     // PWA and Safari don't necessarily share their session state. A short-lived
     // per-account status allows the standalone PWA to show the callback result.
     const recent=await dbFirst(env.DB,
       "SELECT status,error_code,expires_at,created_at FROM google_oauth_pending WHERE user_id=? AND service=? ORDER BY created_at DESC LIMIT 1",
       p.user_id,service);
     if(recent&&Date.parse(recent.created_at)>Date.now()-15*60*1000){
       progress=recent.status==='pending'&&recent.expires_at<utc()?'expired':recent.status;
       progressError=recent.status==='failed'?GOOGLE_ERRORS[recent.error_code]||'Google 授权未完成':null;
     }
   }
   return json({enabled:true,connected:grant?.status==='connected',
     needs_reauthorization:grant?.status==='reauth_required',
     google_email:grant?.status==='connected'?grant.google_email:null,
     service,progress,progress_error:progressError});
 }
 if(!configured(env))bad('Google 长期授权尚未配置完成','GOOGLE_NOT_CONFIGURED',503);
 if(path==='/api/google/oauth/start'&&method==='POST'){
   const data=await readJson(request,1000);
   if(!validService(data?.service))bad('Google 服务无效','GOOGLE_INVALID_SERVICE',400);
   const service=data.service,state=random(),verifier=random()+random();
   const challenge=b64(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(verifier))))
     .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
   const date=new Date(Date.now()+10*60*1000).toISOString();
   // Do not keep a history of pending authorization attempts.
   await dbRun(env.DB,
     "DELETE FROM google_oauth_pending WHERE user_id=? AND (service=? OR expires_at<?)",
     p.user_id,service,utc());
   await dbRun(env.DB,
     "INSERT INTO google_oauth_pending(state_hash,user_id,service,pkce_verifier,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?)",
     await digest(state),p.user_id,service,verifier,'pending',date,utc());
   const params=new URLSearchParams({
     client_id:env.GOOGLE_OAUTH_CLIENT_ID,
     response_type:'code',redirect_uri:callbackUri(url.origin),
     scope:SCOPES[service],access_type:'offline',prompt:'consent',
     state,code_challenge:challenge,code_challenge_method:'S256'
   });
   return json({ok:true,service,flow:state,authorization_url:BASE+'?'+params.toString()});
 }
 if(path==='/api/google/oauth/disconnect'&&method==='POST'){
   const data=await readJson(request,1000);
   if(!validService(data?.service))bad('Google 服务无效','GOOGLE_INVALID_SERVICE',400);
   await dbRun(env.DB,'DELETE FROM google_oauth_grants WHERE user_id=? AND service=?',p.user_id,data.service);
   await dbRun(env.DB,'DELETE FROM google_oauth_pending WHERE user_id=? AND service=?',p.user_id,data.service);
   return json({ok:true,connected:false});
 }
 if(path==='/api/google/drive/files'&&method==='GET'){
   const token=await getAccess(env,p.user_id,'drive');
   const query=(url.searchParams.get('q')||'').trim().slice(0,120);
   const pageToken=url.searchParams.get('pageToken')||'';
   if(pageToken.length>1024)bad('分页标识无效','DRIVE_BAD_PAGE',400);
   const filter="trashed = false and mimeType != 'application/vnd.google-apps.folder'";
   const q=query?filter+" and name contains '"+query.replace(/\\/g,'\\\\').replace(/'/g,"\\'")+"'":filter;
   const params=new URLSearchParams({q,pageSize:String(MAX_FILE_COUNT),
     fields:'nextPageToken,files(id,name,mimeType,size,modifiedTime)',orderBy:'modifiedTime desc'});
   if(pageToken)params.set('pageToken',pageToken);
   const data=await googleJSON(env,'https://www.googleapis.com/drive/v3/files?'+params,token);
   return json({items:(Array.isArray(data.files)?data.files:[]).slice(0,MAX_FILE_COUNT)
     .map(f=>({id:f.id,name:String(f.name||'').slice(0,180),mimeType:f.mimeType,size:Number(f.size||0)}))
     .filter(f=>validId(f.id)),nextPageToken:typeof data.nextPageToken==='string'?data.nextPageToken:null});
 }
 const picked=method==='GET'?/^\/api\/google\/drive\/files\/([A-Za-z0-9_-]{8,256})$/.exec(path):null;
 if(picked){
   const token=await getAccess(env,p.user_id,'drive'),id=encodeURIComponent(picked[1]);
   const meta=await googleJSON(env,'https://www.googleapis.com/drive/v3/files/'+id+
     '?fields=id,name,mimeType,size,trashed',token);
   if(meta.trashed||!validId(meta.id)||meta.id!==picked[1])bad('文件不可读取','DRIVE_MISSING_FILE',404);
   const mime=String(meta.mimeType||'');
   const exports={
     'application/vnd.google-apps.document':['text/plain','.txt'],
     'application/vnd.google-apps.spreadsheet':['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.xlsx'],
     'application/vnd.google-apps.presentation':['application/vnd.openxmlformats-officedocument.presentationml.presentation','.pptx']
   };
   const allowed=new Set(['application/pdf','image/jpeg','image/png','image/webp','text/plain','message/rfc822',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'application/vnd.openxmlformats-officedocument.presentationml.presentation']);
   if(!exports[mime]&&!allowed.has(mime))bad('此文件格式暂不支持导入','DRIVE_UNSUPPORTED',415);
   if(Number(meta.size)>MAX_BYTES)bad('Google Drive 文件超过 8MB','DRIVE_TOO_LARGE',413);
   const finalMime=exports[mime]?.[0]||mime;
   const extension=exports[mime]?.[1]||'';
   const filename=String(meta.name||'Google-Drive').replace(/[\x00-\x1f\x7f\\\/"]/g,'_').slice(0,175);
   const name=extension&&!filename.toLowerCase().endsWith(extension)?filename+extension:filename;
   const source=exports[mime]
     ?'https://www.googleapis.com/drive/v3/files/'+id+'/export?mimeType='+encodeURIComponent(finalMime)
     :'https://www.googleapis.com/drive/v3/files/'+id+'?alt=media';
   const res=await googleFetch(env,source,{method:'GET',headers:{Authorization:'Bearer '+token}});
   if(!res.ok)bad('文件下载失败','DRIVE_DOWNLOAD_FAILED',502);
   if(Number(res.headers.get('Content-Length')||0)>MAX_BYTES)bad('文件超过 8MB','DRIVE_TOO_LARGE',413);
   let chunks=[],bytes=0;
   if(!res.body)bad('文件为空','DRIVE_EMPTY',422);
   const reader=res.body.getReader();
   try{
     while(true){
       const part=await reader.read();if(part.done)break;
       bytes+=part.value.byteLength;
       if(bytes>MAX_BYTES)bad('文件超过 8MB','DRIVE_TOO_LARGE',413);
       chunks.push(part.value);
     }
   }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   if(!bytes)bad('文件为空','DRIVE_EMPTY',422);
   const out=new Uint8Array(bytes);let offset=0;
   for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.byteLength;}
   return new Response(out,{headers:{
     'Content-Type':finalMime,'Content-Disposition':'attachment; filename="document"',
     'X-Document-Name':encodeURIComponent(name),
     'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'
   }});
 }
 bad('Google 接口不存在','NOT_FOUND',404);
}
