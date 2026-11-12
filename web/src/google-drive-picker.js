const MAX_BYTES=8*1024*1024;
const SCOPE='https://www.googleapis.com/auth/drive.file';
const EXPORTS={
 'application/vnd.google-apps.document':{mime:'text/plain',ext:'.txt'},
 'application/vnd.google-apps.spreadsheet':{mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',ext:'.xlsx'},
 'application/vnd.google-apps.presentation':{mime:'application/vnd.openxmlformats-officedocument.presentationml.presentation',ext:'.pptx'}
};
const MIME_BY_EXT={
 '.txt':'text/plain','.eml':'message/rfc822','.pdf':'application/pdf',
 '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
 '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
 '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
 '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp'
};
const scripts=new Map();
// Keep a short-lived, scope-specific Drive access token in memory only.
// Google keeps the *consent grant* until the user revokes it; don't revoke it
// on every file selection. Clear the token when the app user switches/logs out.
let driveToken='',driveExpiresAt=0,driveGeneration=0;
export const driveAuthorizationReady=()=>!!driveToken&&Date.now()+30000<driveExpiresAt;
export function forgetDriveAuthorization(){
 driveGeneration++;driveToken='';driveExpiresAt=0;
}
export async function revokeDriveAuthorization(){
 const old=driveToken;forgetDriveAuthorization();
 if(!old)return true;
 if(typeof window==='undefined'||!window.google?.accounts?.oauth2?.revoke)return false;
 return new Promise((resolve,reject)=>{
  try{window.google.accounts.oauth2.revoke(old,r=>r?.successful===true||r?.error==='invalid_token'?resolve(true):reject(new Error('Google 远程撤销未成功')))}
  catch(e){reject(e)}
 });
}

const cleanName=name=>{
 const n=String(name||'').replace(/[\x00-\x1f\x7f\\/]/g,'_').trim().slice(0,180);
 return n&&n!=='.'&&n!=='..'?n:'Google-Drive-文书';
};
const withExt=(name,ext)=>name.toLowerCase().endsWith(ext)?name:name+ext;
function selectedMime(name,mime){
 const ext=Object.keys(MIME_BY_EXT).find(e=>name.toLowerCase().endsWith(e));
 if(ext)return MIME_BY_EXT[ext];
 if(Object.values(MIME_BY_EXT).includes(mime))return mime;
 throw new Error('暂不支持此 Google Drive 文件格式，请下载为 PDF、Office、图片、EML 或 TXT');
}
export function drivePickerConfig(env=import.meta.env){
 const clientId=String(env?.VITE_GOOGLE_CLIENT_ID||'').trim();
 const apiKey=String(env?.VITE_GOOGLE_API_KEY||'').trim();
 const appId=String(env?.VITE_GOOGLE_APP_ID||'').trim();
 if(!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)||
    !/^AIza[\w-]{20,}$/.test(apiKey)||!/^\d{6,}$/.test(appId))return null;
 return {clientId,apiKey,appId};
}
function scriptLoaded(src,ready){
 if(ready())return Promise.resolve();
 if(scripts.has(src))return scripts.get(src);
 const promise=new Promise((resolve,reject)=>{
   const script=document.createElement('script');script.src=src;script.async=true;
   script.referrerPolicy='strict-origin-when-cross-origin';
   const timeout=setTimeout(()=>{script.remove();reject(new Error('Google 授权组件加载超时'))},15000);
   script.onload=()=>{clearTimeout(timeout);ready()?resolve():reject(new Error('Google 授权组件未就绪'))};
   script.onerror=()=>{clearTimeout(timeout);reject(new Error('无法连接 Google 授权组件'))};
   document.head.append(script);
 }).catch(e=>{scripts.delete(src);throw e});
 scripts.set(src,promise);return promise;
}
async function ensurePicker(){
 await Promise.all([
  scriptLoaded('https://accounts.google.com/gsi/client',()=>!!window.google?.accounts?.oauth2?.initTokenClient),
  scriptLoaded('https://apis.google.com/js/api.js',()=>!!window.gapi?.load)
 ]);
 if(!window.google?.picker?.PickerBuilder)
  await new Promise((resolve,reject)=>window.gapi.load('picker',{
   callback:resolve,onerror:()=>reject(new Error('Google Picker 初始化失败')),
   timeout:15000,ontimeout:()=>reject(new Error('Google Picker 加载超时'))
  }));
}
async function boundedBody(response){
 if(!response.ok)throw new Error(response.status===403?
  '此 Google 账号没有授予所选文件的读取权限':`Google 文件读取失败 (${response.status})`);
 const size=Number(response.headers.get('Content-Length')||0);
 if(size>MAX_BYTES)throw new Error('所选文件超过 8MB，请拆分后导入');
 if(!response.body){
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(!bytes.length||bytes.length>MAX_BYTES)throw new Error('文件为空或超过 8MB');
  return bytes;
 }
 const reader=response.body.getReader(),chunks=[];let length=0;
 try{
  for(;;){const item=await reader.read();if(item.done)break;length+=item.value.byteLength;
   if(length>MAX_BYTES)throw new Error('所选文件超过 8MB，请拆分后导入');
   chunks.push(item.value);
  }
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 if(!length)throw new Error('Google 文件没有可读取的内容');
 const bytes=new Uint8Array(length);let offset=0;
 for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
 return bytes;
}
// Per-file download only: never query a Drive listing, export an entire folder or persist credentials.
export async function fetchPickedDriveFile(selected,token,{fetcher=fetch}={}){
 const id=String(selected?.id||''),name=cleanName(selected?.name);
 const sourceMime=String(selected?.mimeType||'');
 if(!/^[A-Za-z0-9_-]{8,256}$/.test(id))throw new Error('Google 文件 ID 无效');
 if(typeof token!=='string'||!token)throw new Error('需要重新授权读取 Google 文件');
 const exportType=EXPORTS[sourceMime];
 const outputName=exportType?withExt(name,exportType.ext):name;
 const mime=exportType?exportType.mime:selectedMime(outputName,sourceMime);
 const url=exportType?
  `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(mime)}`:
  `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`;
 const response=await fetcher(url,{method:'GET',headers:{Authorization:`Bearer ${token}`},
  cache:'no-store',redirect:'error',credentials:'omit'});
 return new File([await boundedBody(response)],outputName,{type:mime,lastModified:Date.now()});
}
// Warm up Google scripts after opening the import panel, not between the
// specific authorization button click and requestAccessToken() on iOS Safari.
export function googlePickerReady(){
 return typeof window!=='undefined' &&
  !!window.google?.accounts?.oauth2?.initTokenClient &&
  !!window.google?.picker?.PickerBuilder;
}
export async function prepareGoogleDrivePicker(config=drivePickerConfig()){
 if(!config)return false;
 await ensurePicker();
 return googlePickerReady();
}
export function pickGoogleDriveFile(config=drivePickerConfig()){
 if(!config)return Promise.reject(new Error('尚未配置 Google Drive 授权'));
 if(!googlePickerReady())return Promise.reject(new Error('Google 授权组件尚未准备好，请稍后重新点击选择文件'));
 const google=window.google,p=google.picker,session=driveGeneration;
 // No await before a first requestAccessToken: iOS needs the direct click.
 return new Promise((resolve,reject)=>{
  let token=null,finished=false,timeout=null;
  function deadline(ms,message){
   clearTimeout(timeout);
   timeout=setTimeout(()=>finish(null,new Error(message)),ms);
  }
  function finish(value,error){
   if(finished)return;
   finished=true;clearTimeout(timeout);
   token=null;
   // Do not revoke here: revoking would undo Google consent every time the
   // user picks a single file. Only a separate explicit revoke may do that.
   if(error)reject(error);else resolve(value);
  }
  function showPicker(granted){
   if(session!==driveGeneration)return finish(null,new Error('账号已切换，请重新选择 Google 文件'));
   token=granted;
   deadline(180000,'Google 文件选择等待超时，请重新打开选择器');
   try{
    const picker=new p.PickerBuilder().addView(p.ViewId.DOCS)
     .setOAuthToken(granted).setDeveloperKey(config.apiKey)
     .setAppId(config.appId).setOrigin(window.location.origin)
     .setCallback(async event=>{
      if(finished)return;
      if(event.action===p.Action.CANCEL)return finish(null,null);
      if(event.action===p.Action.ERROR)return finish(null,new Error('Google Picker 加载失败，请检查授权或改用 iPhone「文件」导入'));
      if(event.action!==p.Action.PICKED)return;
      try{
       const item=event.docs?.[0];
       if(!item)return finish(null,new Error('没有选中任何文件'));
       const file=await fetchPickedDriveFile(item,granted);
       if(session!==driveGeneration)return finish(null,new Error('账号已切换，文件已丢弃'));
       finish(file,null);
      }catch(e){
       // A revoked or expired token is discarded before the next user click.
       if(/Google.*(?:401|授权|读取失败)/.test(e?.message||''))forgetDriveAuthorization();
       finish(null,e);
      }
     }).build();
    picker.setVisible(true);
   }catch(e){finish(null,e)}
  }
  if(driveAuthorizationReady())return showPicker(driveToken);
  deadline(60000,'Google 授权未返回结果。主屏幕 PWA 可尝试从 iPhone「文件」选择 Google Drive 文件');
  try{
   const client=google.accounts.oauth2.initTokenClient({
    client_id:config.clientId,scope:SCOPE,include_granted_scopes:false,
    error_callback(error){
     const reason=error?.type==='popup_failed_to_open'?'授权弹窗被拦截':
      error?.type==='popup_closed'?'授权窗口已关闭':'Google 授权弹窗失败';
     finish(null,new Error(reason+'。可尝试 Safari 或通过 iPhone「文件」导入'));
    },
    callback(auth){
     if(finished)return;
     if(session!==driveGeneration)return finish(null,new Error('账号已切换，授权已取消'));
     if(auth?.error||!auth?.access_token)return finish(null,new Error('Google 授权未完成，请检查账号或 Google 同意页面设置'));
     if(!google.accounts.oauth2.hasGrantedAllScopes?.(auth,SCOPE))
      return finish(null,new Error('没有获得所需的 Google Drive 文件读取权限'));
     const seconds=Number(auth.expires_in);
     // If expiration is missing, use the token for only the current pick.
     if(Number.isFinite(seconds)&&seconds>60){
      driveToken=auth.access_token;driveExpiresAt=Date.now()+seconds*1000;
     }
     showPicker(auth.access_token);
    }
   });
   // Empty prompt preserves Google's previously granted consent.
   client.requestAccessToken({prompt:''});
  }catch(e){finish(null,new Error('无法打开 Google 授权窗口；可使用 iPhone「文件」导入：'+(e?.message||'未知错误')))}
 });
}
