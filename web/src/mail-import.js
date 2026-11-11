// Explicit, user-selected local mail/plain-text ingestion. Nothing is uploaded
// until the user confirms import. No remote HTML assets, embedded scripts or
// attachments are executed, fetched or saved on the device.
const MAX_INPUT = 1024 * 1024;
const MAX_TEXT = 100000;
const MAX_PARTS = 32;
const MAX_DEPTH = 4;
const charsetAliases = {
  'x-sjis':'shift_jis','sjis':'shift_jis','shift-jis':'shift_jis',
  'windows-31j':'shift_jis','cp932':'shift_jis','iso2022jp':'iso-2022-jp',
  'latin1':'windows-1252',
};
function decode(bytes, charset='utf-8') {
  const cs=String(charset||'utf-8').trim().toLowerCase();
  try{return new TextDecoder(charsetAliases[cs]||cs,{fatal:true}).decode(bytes);}
  catch {throw new Error(`该文件的字符编码（${cs.slice(0,30)}）不支持或数据已损坏，请复制正文粘贴导入`);}
}
function rawLatin1(bytes){
  let out='';for(let i=0;i<bytes.length;i+=4096)out+=String.fromCharCode(...bytes.subarray(i,i+4096));
  return out;
}
function originalBytes(binary){const b=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)b[i]=binary.charCodeAt(i)&255;return b;}
function base64Bytes(value){
  const b64=value.replace(/\s+/g,'');
  if(!b64||b64.length>MAX_INPUT*2||!/^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(b64))throw new Error('邮件的 Base64 正文不完整或已损坏');
  return originalBytes(atob(b64));
}
function quotedBytes(binary){
  // Quoted-printable soft line breaks have no content; escaped bytes are raw octets.
  const input=binary.replace(/=\r?\n/g,'');const bytes=[];
  for(let i=0;i<input.length;i++){
    if(input[i]==='='&&/^[A-Fa-f0-9]{2}$/.test(input.slice(i+1,i+3))){bytes.push(parseInt(input.slice(i+1,i+3),16));i+=2;}
    else bytes.push(input.charCodeAt(i)&255);
  }
  return new Uint8Array(bytes);
}
function mimeHeaders(raw){
  const boundary=raw.search(/\r?\n\r?\n/);
  if(boundary<0)return {headers:new Map(),body:raw};
  const head=raw.slice(0,boundary),body=raw.slice(boundary).replace(/^\r?\n\r?\n/,'');
  if(head.length>12000)throw new Error('邮件头过长');
  const headers=new Map();
  for(const line of head.replace(/\r?\n[\t ]+/g,' ').split(/\r?\n/)){
    const idx=line.indexOf(':');if(idx<1)continue;
    const key=line.slice(0,idx).trim().toLowerCase();
    if(!headers.has(key))headers.set(key,line.slice(idx+1).trim());
  }
  return {headers,body};
}
function headerDecode(value){
  let raw=String(value||'');
  if(/[^\x00-\x7f]/.test(raw)){
    try{raw=decode(originalBytes(raw),'utf-8');}catch{/* RFC 2047 and non-UTF8 headers are processed below */}
  }
  return raw.replace(/=\?([^?\s]+)\?([bq])\?([^?]*)\?=/gi,(_m,charset,kind,payload)=>{
    try{
      const bytes=kind.toLowerCase()==='b'?base64Bytes(payload):quotedBytes(payload.replace(/_/g,' '));
      return decode(bytes,charset);
    }catch{return '[无法解码的邮件标题]';}
  }).replace(/[\x00-\x1f\x7f]/g,' ').slice(0,250);
}
function htmlEntities(text){
  return text.replace(/&#(x[0-9a-f]+|\d+);?/gi,(_m,n)=>{
    const cp=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):parseInt(n,10);
    return cp>0&&cp<=0x10ffff&&!(cp>=0xd800&&cp<=0xdfff)?String.fromCodePoint(cp):'�';
  }).replace(/&(?:nbsp|amp|lt|gt|quot|apos);/gi,m=>({
    '&nbsp;':' ','&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&yen;':'¥'
  })[m.toLowerCase()]||m);
}
function htmlText(html){
  // A best-effort text extraction only, not a browser HTML renderer. Never call
  // DOMParser/innerHTML, and never display or fetch resources from the message.
  return htmlEntities(html.replace(/<!--[\s\S]*?-->/g,'')
    .replace(/<(script|style|svg|iframe|object|head|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'')
    .replace(/<\s*(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table)\b[^>]*>/gi,'\n')
    .replace(/<[^>]*>/g,' ')).replace(/\r/g,'').replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
function unquote(param,name){
  const m=String(param||'').match(new RegExp('(?:^|;)\\s*'+name+'\\s*=\\s*(?:"([^"\\r\\n]*)"|([^;\\s]+))','i'));
  return m?(m[1]??m[2]):'';
}
function splitMultipart(binary,boundary){
  if(!boundary||boundary.length>100||/[\r\n]/.test(boundary))throw new Error('邮件 MIME 分段标识无效');
  const marker='--'+boundary;
  const lines=binary.split(/\r?\n/),parts=[];let active=null;
  for(const line of lines){
    if(line===marker||line===marker+'--'){
      if(active)parts.push(active.join('\r\n'));
      if(line===marker+'--')return parts;
      if(parts.length>=MAX_PARTS)throw new Error('邮件包含过多分段，请单独保存正文');
      active=[];
    }else if(active)active.push(line);
  }
  if(active)parts.push(active.join('\r\n'));
  if(!parts.length)throw new Error('邮件 MIME 分段不完整');
  if(parts.length>MAX_PARTS)throw new Error('邮件包含过多分段');
  return parts;
}
function decodePart(part,depth,stats){
  if(depth>MAX_DEPTH)throw new Error('邮件嵌套层级过深');
  stats.parts++;if(stats.parts>MAX_PARTS)throw new Error('邮件分段数超限');
  const {headers,body}=mimeHeaders(part),type=headers.get('content-type')||'text/plain';
  const disposition=headers.get('content-disposition')||'';
  if(/attachment\b/i.test(disposition)||/\bfilename\s*=/i.test(disposition)||/\bname\s*=/i.test(type)){stats.ignored++;return null;}
  if(/^multipart\//i.test(type)){
    const boundary=unquote(type,'boundary');
    const items=splitMultipart(body,boundary).map(x=>decodePart(x,depth+1,stats)).filter(Boolean);
    // Prefer text/plain over HTML; do not duplicate multipart/alternative bodies.
    const plain=items.find(x=>x.type==='text/plain'),html=items.find(x=>x.type==='text/html');
    if(/multipart\/alternative/i.test(type))return plain||html||null;
    const texts=items.filter(x=>x.type==='text/plain');
    return texts.length?{type:'text/plain',text:texts.map(x=>x.text).join('\n\n')}:html||null;
  }
  const kind=type.split(';',1)[0].trim().toLowerCase();
  if(!['text/plain','text/html'].includes(kind)){stats.ignored++;return null;}
  const transfer=(headers.get('content-transfer-encoding')||'7bit').trim().toLowerCase();
  let bytes;
  if(transfer==='base64')bytes=base64Bytes(body);
  else if(transfer==='quoted-printable')bytes=quotedBytes(body);
  else if(['7bit','8bit','binary',''].includes(transfer))bytes=originalBytes(body);
  else throw new Error('邮件传输编码暂不支持');
  const charset=unquote(type,'charset')||(kind==='text/plain'?'utf-8':'utf-8');
  const raw=decode(bytes,charset);
  return {type:kind,text:kind==='text/html'?htmlText(raw):raw.replace(/\r\n/g,'\n')};
}
export function extractEml(bytes){
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>MAX_INPUT)throw new Error('邮件文件必须在 1 MB 以内');
  const binary=rawLatin1(bytes),{headers}=mimeHeaders(binary);
  if(!headers.has('from')&&!headers.has('subject')&&!headers.has('mime-version'))throw new Error('缺少邮件头，请将正文保存为 TXT 导入');
  const result=decodePart(binary,0,{parts:0,ignored:0});
  if(!result?.text.trim())throw new Error('邮件没有可读取的纯文本正文；请复制正文，附件需另行导入');
  const title=headerDecode(headers.get('subject')||'邮件正文').trim()||'邮件正文';
  const from=headerDecode(headers.get('from')||'');
  const date=headerDecode(headers.get('date')||'');
  const text=[`件名：${title}`,from&&`差出人（未经验证）：${from}`,date&&`邮件日期（未经验证）：${date}`,
    '\n'+result.text.trim()].filter(Boolean).join('\n');
  if(text.length>MAX_TEXT)throw new Error('邮件正文超过10万字符，请拆分导入；不会静默丢弃后面的内容');
  return {title,text,source_type:'mail_forward',warning:'发件人和日期仅来自邮件原文，不能证明真实性。附件未自动导入，邮件内链接不应直接信任。'};
}
export async function readLocalText(file){
  if(!file||typeof file.arrayBuffer!=='function')throw new Error('请先选择文件');
  const name=String(file.name||'').slice(0,200);
  if(!/\.(?:eml|txt)$/i.test(name))throw new Error('目前只支持 .eml 和 .txt；其他文件可粘贴可复制文字');
  if(file.size<=0||file.size>MAX_INPUT)throw new Error('文字文件大小须在 1 MB 以内');
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(/\.eml$/i.test(name))return extractEml(bytes);
  let text;
  try{text=decode(bytes,'utf-8');}catch{
    // The user selected a local TXT; Japanese Win-31J is still common.
    try{text=decode(bytes,'shift_jis');}catch{throw new Error('无法读取文字编码，请转换为 UTF-8 或复制粘贴正文');}
  }
  if(!text.trim())throw new Error('文件中没有文字');
  if(text.length>MAX_TEXT)throw new Error('文本超过10万字符，请拆分导入；不会静默丢弃后面的内容');
  return {title:name.replace(/\.txt$/i,'').slice(0,200),text,source_type:'local_file',warning:'文字已在本次页面会话中读取，点击确认后才会提交到服务器。'};
}
