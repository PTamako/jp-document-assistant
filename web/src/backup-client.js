// Client-side, on-demand, small-batch authenticated backups. Never use IndexedDB or Cache Storage.
import { createZip, readZip, verifySha256 } from './zip.js';
const enc=new TextEncoder(),dec=new TextDecoder();
const marker=enc.encode('JDA1');
export async function encryptZip(zipBlob,password){
  if(typeof password!=='string'||password.length<12)throw Error('备份密码至少12位');
  const salt=crypto.getRandomValues(new Uint8Array(16)),nonce=crypto.getRandomValues(new Uint8Array(12));
  const material=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveKey']);
  const key=await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:310000},material,{name:'AES-GCM',length:256},false,['encrypt']);
  const plain=await zipBlob.arrayBuffer();
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:marker},key,plain);
  return new Blob([marker,salt,nonce,ciphertext],{type:'application/octet-stream'});
}
export async function decryptZip(input,password){
  const bytes=new Uint8Array(await input.arrayBuffer());
  if(bytes.length<48||!marker.every((x,i)=>bytes[i]===x))throw Error('不是受支持的加密备份');
  if(typeof password!=='string'||password.length<12)throw Error('备份密码不正确');
  const salt=bytes.slice(4,20),nonce=bytes.slice(20,32),ciphertext=bytes.slice(32);
  const material=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveKey']);
  const key=await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:310000},material,{name:'AES-GCM',length:256},false,['decrypt']);
  try{return new Blob([await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce,additionalData:marker},key,ciphertext)],{type:'application/zip'});}
  catch{throw Error('密码错误、备份损坏或内容被篡改');}
}
const mimeExt={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','application/pdf':'pdf'};
function download(blob,name){
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.rel='noopener';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}
export async function exportBatch(api,{scope='all',month='',year='',offset=0,includes_originals=false,password=''}){
  const query=new URLSearchParams({scope,offset:String(offset)});
  if(month)query.set('month',month);if(year)query.set('year',year);
  const data=await api(`/api/backups/export?${query}`);
  if(!data.documents?.length)throw Error('当前范围没有需要备份的文书');
  const entries=[{name:'manifest.json',bytes:''}], originals=[];
  if(includes_originals){
    for(const entry of data.documents){
      for(const a of entry.attachments||[]){
        if(!a.download_path||!a.object_sha256)throw Error('某个原件缺失；请先核对文件状态');
        const response=await fetch(a.download_path,{credentials:'same-origin',cache:'no-store'});
        if(!response.ok)throw Error('原件下载失败，请缩小备份范围重试');
        const bytes=new Uint8Array(await response.arrayBuffer());
        if(bytes.length>8*1024*1024)throw Error('单附件超过8MB，暂不支持此分包');
        await verifySha256(bytes,a.object_sha256);
        const name=`originals/${entry.document.id}/${a.id}.${mimeExt[a.mime]||'bin'}`;
        originals.push({name,bytes});a.backup_path=name;
      }
    }
  }
  data.includes_originals=includes_originals;
  data.manifest_sha256_algorithm='SHA-256';
  delete data.originals_available_separately;
  entries[0].bytes=JSON.stringify(data,null,2);
  const zip=createZip([...entries,...originals]);
  const bytes=includes_originals?originals.length:0;
  const file=password?await encryptZip(zip,password):zip;
  const filename=`jp-document-assistant-${new Date().toISOString().slice(0,10)}-${offset}.${password?'jda':'zip'}`;
  download(file,filename);
  return {name:filename,document_count:data.documents.length,original_count:bytes,next_offset:data.next_offset,encrypted:!!password};
}
export async function readBackup(file,password=''){
  const archive=file.name?.toLowerCase().endsWith('.jda')?await decryptZip(file,password):file;
  const members=await readZip(archive),manifest=members.get('manifest.json');
  if(!manifest)throw Error('备份不完整');
  let data;try{data=JSON.parse(dec.decode(manifest));}catch{throw Error('备份清单格式不正确');}
  if(data.schema_version!=='1.0'||data.source_app!=='jp-document-assistant'||!Array.isArray(data.documents))throw Error('备份版本不支持');
  for(const entry of data.documents){
    for(const a of entry.attachments||[]){
      if(!a.backup_path)continue;
      const bytes=members.get(a.backup_path);
      if(!bytes)throw Error('原件分包缺失：'+a.file_label);
      await verifySha256(bytes,a.object_sha256);
    }
  }
  return {data,members};
}
export async function restoreBatch(api,backup,confirm){
  const {data,members}=backup;
  const preview=await api('/api/backups/import-preview',{method:'POST',body:data});
  if(!confirm)return {preview:preview.preview};
  const commit=await api('/api/backups/import-confirm',{method:'POST',body:{...data,confirm:'RESTORE_METADATA'}});
  const failures=[];let uploaded=0,already_restored_originals=0;
  for(const m of commit.index_map||[]){
    // A metadata-only restore may already exist. Restore its missing original
    // attachments as well: metadata dedupe must not suppress R2 restoration.
    const entry=data.documents[m.index];
    for(const a of entry.attachments||[]){
      if(!a.backup_path)continue;
      try{
        const bytes=members.get(a.backup_path);
        const form=new FormData();form.append('file',new File([bytes],a.file_label||'original',{type:a.mime}));
        form.append('sha256',a.object_sha256);form.append('label',a.file_label||'原件');form.append('sort_order',String(a.sort_order||0));
        const outcome=await api(`/api/documents/${m.id}/attachments/restore-upload`,{method:'POST',body:form,form:true});
        if(outcome.already_restored)already_restored_originals++;else uploaded++;
      }catch{failures.push({document_id:m.id,attachment_id:a.id});}
    }
  }
  return {metadata_restored:commit.restored.length,already_existed:commit.skipped.length,originals_restored:uploaded,already_restored_originals,failures};
}
