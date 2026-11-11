// Only user-initiated Gmail read-only imports. No refresh tokens, storage or sync.
import {extractEml} from './mail-import.js';
const API='https://gmail.googleapis.com/gmail/v1/users/me/messages';
const GIS='https://accounts.google.com/gsi/client';
const SCOPE='https://www.googleapis.com/auth/gmail.readonly';
let token='',expires=0,version=0,loader=null;
export const gmailConfigured=()=>!!String(import.meta.env.VITE_GOOGLE_CLIENT_ID||'').trim();
export const gmailConnected=()=>!!token&&Date.now()+30000<expires;
export function gmailForget(){version++;token='';expires=0;}
export function preloadGmailIdentity(){
  if(!gmailConfigured())return Promise.reject(new Error('尚未配置 Gmail OAuth Web Client ID'));
  if(typeof document==='undefined'||typeof window==='undefined')
    return Promise.reject(new Error('Gmail 授权只能从浏览器操作'));
  if(window.google?.accounts?.oauth2?.initTokenClient)return Promise.resolve();
  if(loader)return loader;
  loader=new Promise((resolve,reject)=>{
    const el=document.createElement('script');el.src=GIS;el.async=true;
    el.onload=()=>window.google?.accounts?.oauth2?.initTokenClient?resolve():reject(new Error('Google 授权组件不可用'));
    el.onerror=()=>reject(new Error('Google 授权组件加载失败'));
    document.head.appendChild(el);
  }).catch(err=>{loader=null;throw err;});
  return loader;
}
export async function gmailAuthorize(){
  await preloadGmailIdentity();
  const initial=version;
  return new Promise((resolve,reject)=>{
    const client=window.google.accounts.oauth2.initTokenClient({
      client_id:import.meta.env.VITE_GOOGLE_CLIENT_ID,
      scope:SCOPE,
      callback:reply=>{
        if(version!==initial)return reject(new Error('已切换用户，会话授权被取消'));
        if(reply?.error||!reply?.access_token)return reject(new Error('Gmail 只读授权未完成'));
        token=reply.access_token;
        expires=Date.now()+Math.max(0,Number(reply.expires_in)||0)*1000;
        if(!gmailConnected()){gmailForget();return reject(new Error('Gmail 授权无效或已过期'));}
        resolve({authorized:true});
      }
    });
    try{client.requestAccessToken({prompt:'consent'});}catch{reject(new Error('浏览器阻止了 Gmail 授权弹窗，请在 Safari 中重试'));}
  });
}
export async function gmailRevoke(){
  const current=token;gmailForget();
  if(!current)return true;
  if(!window.google?.accounts?.oauth2?.revoke)throw new Error('已清空本机授权；请到 Google 账号安全设置撤销远端权限');
  return new Promise((resolve,reject)=>{
    try{window.google.accounts.oauth2.revoke(current,result=>{if(result?.successful===true||result?.error==='invalid_token')resolve(true);else reject(new Error('Google 远程撤销未成功；已清除本机 Token，请在 Google 账号设置中确认权限'));});}
    catch{reject(new Error('本机 Token 已清除，但远端撤销未确认，请到 Google 账号安全设置检查'));}
  });
}
export async function gmailApi(path,accessToken,fetcher=fetch){
  if(typeof accessToken!=='string'||accessToken.length<12||accessToken.length>8192)
    throw new Error('Gmail 授权无效');
  if(typeof path!=='string'||/^[a-z]+:\/\//i.test(path))throw new Error('Gmail API 地址无效');
  const url=new URL(path.startsWith('?')?API+path:API+'/'+path);
  if(url.origin!=='https://gmail.googleapis.com'||!url.pathname.startsWith('/gmail/v1/users/me/messages'))
    throw new Error('Gmail API 地址无效');
  const res=await fetcher(url.toString(),{method:'GET',credentials:'omit',cache:'no-store',
    redirect:'error',headers:{Authorization:'Bearer '+accessToken,Accept:'application/json'}});
  if(res.status===401||res.status===403)throw new Error('Gmail 授权已过期或访问被拒绝');
  if(!res.ok)throw new Error('Gmail 只读请求失败：HTTP '+res.status);
  const data=await res.json();
  if(!data||typeof data!=='object')throw new Error('Gmail 响应数据无效');
  return data;
}
const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{5,128}$/.test(id);
const header=(headers,name)=>String(Array.isArray(headers)?headers.find(h=>String(h?.name||'').toLowerCase()===name)?.value||'':'')
  .replace(/[\r\n\x00-\x1f]/g,' ').slice(0,250);
export async function gmailPage(accessToken,query='',pageToken='',fetcher=fetch){
  const q=String(query||'').trim();
  if(q.length>180)throw new Error('Gmail 搜索条件不能超过180个字符');
  if(pageToken&&(typeof pageToken!=='string'||pageToken.length>1000))
    throw new Error('分页标识无效');
  const params=new URLSearchParams({maxResults:'5',q});
  if(pageToken)params.set('pageToken',pageToken);
  const index=await gmailApi('?'+params.toString(),accessToken,fetcher);
  const ids=(Array.isArray(index.messages)?index.messages:[]).slice(0,5).map(m=>m?.id).filter(validId);
  const items=await Promise.all(ids.map(async id=>{
    const d=await gmailApi(encodeURIComponent(id)+'?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date&fields=id%2Cpayload(headers)',accessToken,fetcher);
    return {id,subject:header(d.payload?.headers,'subject')||'（无标题）',
      from:header(d.payload?.headers,'from'),date:header(d.payload?.headers,'date')};
  }));
  return {items,nextPageToken:typeof index.nextPageToken==='string'&&index.nextPageToken.length<1000?index.nextPageToken:null};
}
function mimeDataPart(part,depth=0){
  if(depth>4||!part||typeof part!=='object')return [];
  if(part.filename||part.body?.attachmentId)return [];
  const kind=String(part.mimeType||'').toLowerCase();
  if(['text/plain','text/html'].includes(kind)&&typeof part.body?.data==='string')
    return [{kind,data:part.body.data,charset:
      (/charset\s*=\s*["']?([a-zA-Z0-9._-]+)/i.exec(header(part.headers,'content-type'))||[])[1]||'utf-8'}];
  if(!Array.isArray(part.parts))return [];
  return part.parts.slice(0,32).flatMap(child=>mimeDataPart(child,depth+1));
}
export function gmailPayloadToDocument(payload){
  const headers=payload?.headers;
  const candidates=mimeDataPart(payload);
  const body=candidates.find(p=>p.kind==='text/plain')||candidates.find(p=>p.kind==='text/html');
  if(!body)throw new Error('邮件没有可复制的文字正文，附件未下载，请复制文本手动导入');
  const data=body.data;
  if(!data||data.length>1400000||!/^[A-Za-z0-9_-]+={0,2}$/.test(data))
    throw new Error('邮件正文为空、过大或编码损坏');
  const base64=data.replace(/-/g,'+').replace(/_/g,'/');
  const padded=base64.padEnd(Math.ceil(base64.length/4)*4,'=');
  // Wrap Gmail body in a synthetic inert RFC822 envelope and reuse safe MIME
  // parser. Never request attachmentId or load HTML images/resources.
  const source=['From: '+header(headers,'from'),'Subject: '+header(headers,'subject'),
    'Date: '+header(headers,'date'),'MIME-Version: 1.0',
    'Content-Type: '+body.kind+'; charset="'+body.charset+'"',
    'Content-Transfer-Encoding: base64','',''+padded].join('\r\n');
  const doc=extractEml(new TextEncoder().encode(source));
  return {...doc,source_type:'gmail',
    warning:'只读取你选择邮件的文字正文；附件和追踪图片未读取。发件人/日期未经验证，保存前请人工核对。'};
}
export async function gmailSelected(accessToken,id,fetcher=fetch){
  if(!validId(id))throw new Error('所选 Gmail 邮件 ID 无效');
  const d=await gmailApi(encodeURIComponent(id)+'?format=full&fields=id%2Cpayload',accessToken,fetcher);
  return gmailPayloadToDocument(d.payload);
}
function live(){
  if(!gmailConnected()){gmailForget();throw new Error('Gmail 授权已失效，请重新授权');}
  return {token,version};
}
export async function gmailList(query,pageToken=''){
  const saved=live(),result=await gmailPage(saved.token,query,pageToken);
  if(version!==saved.version)throw new Error('切换账号后已丢弃 Gmail 读取结果');
  return result;
}
export async function gmailReadOne(id){
  const saved=live(),result=await gmailSelected(saved.token,id);
  if(version!==saved.version)throw new Error('切换账号后已丢弃 Gmail 读取结果');
  return result;
}
