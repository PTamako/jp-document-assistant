// iOS installed PWAs can open external OAuth in Safari without unloading
// the original home-screen WebView. Browser navigation is an external handoff,
// not an in-progress fetch: unlock the original PWA so its original session
// can complete the state-bound server exchange when it returns from Safari.
// No token or verifier is written here or passed to the external URL.
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
