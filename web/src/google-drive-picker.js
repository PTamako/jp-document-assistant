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
// Google Identity Services and Picker scripts are loaded ONLY when the user taps import.
// OAuth token is kept in a local closure, revoked after cancel/error/download, never persisted.
export async function pickGoogleDriveFile(config=drivePickerConfig()){
 if(!config)throw new Error('尚未配置 Google Drive 授权，请先下载到「文件」App 再导入');
 await ensurePicker();
 const google=window.google,p=google.picker;
 return new Promise((resolve,reject)=>{
  let token=null,finished=false;
  function finish(value,error){
   if(finished)return;finished=true;
   if(token)google.accounts.oauth2.revoke(token,()=>{});
   token=null;
   if(error)reject(error);else resolve(value);
  }
  const client=google.accounts.oauth2.initTokenClient({
   client_id:config.clientId,scope:SCOPE,include_granted_scopes:false,
   callback(auth){
    if(auth?.error||!auth?.access_token)return finish(null,new Error('Google 授权失败或已取消'));
    token=auth.access_token;
    try{
     const picker=new p.PickerBuilder().addView(p.ViewId.DOCS)
      .setOAuthToken(token).setDeveloperKey(config.apiKey)
      .setAppId(config.appId).setOrigin(window.location.origin)
      .setCallback(async event=>{
       if(event.action===p.Action.CANCEL)return finish(null,null);
       if(event.action!==p.Action.PICKED)return;
       try{
        const item=event.docs?.[0];
        if(!item)return finish(null,new Error('没有选中任何文件'));
        finish(await fetchPickedDriveFile(item,token),null);
       }catch(e){finish(null,e)}
      }).build();
     picker.setVisible(true);
    }catch(e){finish(null,e)}
   }
  });
  try{client.requestAccessToken({prompt:'consent'})}catch(e){finish(null,e)}
 });
}
