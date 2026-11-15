// iOS installed PWAs can open external OAuth in Safari without unloading
// the original home-screen WebView. Browser navigation is an external handoff,
// not an in-progress fetch: unlock the original PWA so its original session
// can complete the state-bound server exchange when it returns from Safari.
// No token or verifier is written here or passed to the external URL.
// Refuse an authorization response that silently changes OAuth client,
// callback origin, state or PKCE parameters. No callback secret crosses Safari.
export function validateHomeflowAuthorizationUrl(raw,expectedState,appOrigin){
 const fail=()=>{throw new Error('HomeFlow 授权地址校验失败')};
 if(typeof raw!=='string'||!/^https:\/\//.test(raw)||
  !/^[a-f0-9]{64}$/.test(expectedState||''))fail();
 let target,callback;
 try{
  target=new URL(raw);
  callback=new URL(target.searchParams.get('redirect_uri')||'');
 }catch{fail()}
 if(target.protocol!=='https:'||target.username||target.password||
  target.hash||target.pathname!=='/authorize'||target.searchParams.get('state')!==expectedState||
  target.searchParams.get('client_id')!=='jp-document-assistant'||
  target.searchParams.get('response_type')!=='code'||
  target.searchParams.get('code_challenge_method')!=='S256'||
  !/^[A-Za-z0-9_-]{43}$/.test(target.searchParams.get('code_challenge')||'')||
  !/^[a-f0-9]{48}$/.test(target.searchParams.get('nonce')||'')||
  target.searchParams.size!==7||
  callback.href!==appOrigin+'/api/homeflow-sso/callback')fail();
 return target;
}
export function handoffHomeflowBrowserAuthorization(location,authorizationUrl,busyRef){
 if(!location||typeof location.assign!=='function'||
  typeof authorizationUrl!=='string')throw new Error('HomeFlow 跳转目标无效');
 const dest=new URL(authorizationUrl);
 if(dest.protocol!=='https:'||dest.username||dest.password)
  throw new Error('HomeFlow 跳转目标必须为 HTTPS');
 location.assign(dest.href);
 // A persistent iPhone PWA does not emit pagehide after Safari opens.
 busyRef.value=false;
 return true;
}
