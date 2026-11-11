import { json, bad } from './http.js';
import { randomToken,isoNow } from './security.js';
import { validateOfficeBytes } from '../web/src/document-text.js';
const first=(db,sql,...a)=>db.prepare(sql).bind(...a).first();
const run=(db,sql,...a)=>db.prepare(sql).bind(...a).run();
const batch=(db,rows)=>db.batch(rows.map(([sql,...a])=>db.prepare(sql).bind(...a)));
const MAX=8*1024*1024;
async function sha256(bytes){const d=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,'0')).join('');}
function fileSign(mime,b){
  if(mime==='image/jpeg')return b[0]===255&&b[1]===216&&b[2]===255;
  if(mime==='image/png')return [137,80,78,71,13,10,26,10].every((n,i)=>b[i]===n);
  if(mime==='image/webp')return new TextDecoder().decode(b.slice(0,4))==='RIFF'&&new TextDecoder().decode(b.slice(8,12))==='WEBP';
  if(mime==='application/pdf')return new TextDecoder().decode(b.slice(0,5))==='%PDF-';
  if(mime.startsWith('application/vnd.openxmlformats-officedocument.'))return b.length>=4&&
    b[0]===80&&b[1]===75&&b[2]===3&&b[3]===4;
  return false;
}
export async function restoreUpload(request,env,p,id){
  if(!env.DOCUMENTS)bad('R2 未绑定','NOT_CONFIGURED',503);
  const doc=await first(env.DB,"SELECT id FROM documents WHERE id=? AND owner_id=? AND lifecycle='active'",id,p.user_id);
  if(!doc)bad('文书不存在或无法上传','NOT_FOUND',404);
  const form=await request.formData(),file=form.get('file');
  const expected=String(form.get('sha256')||''),label=String(form.get('label')||'原件').slice(0,150).replace(/[\x00-\x1f]/g,'');
  if(!/^[a-f0-9]{64}$/.test(expected))bad('必须指定可信原件 SHA-256');
  if(!file||!file.size||file.size>MAX)bad('单个原件大小必须在 1～8MB 以内','FILE_TOO_LARGE',413);
  const officeTypes=['application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'];
  if(!['image/jpeg','image/png','image/webp','application/pdf',...officeTypes].includes(file.type))bad('原件类型不支持');
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(!fileSign(file.type,bytes)||await sha256(bytes)!==expected)bad('原件内容与备份校验值不一致','HASH_MISMATCH',422);
  if(officeTypes.includes(file.type)){
    try{await validateOfficeBytes(bytes,file.type);}
    catch{bad('Office 恢复文件结构无效或含不安全内容','INVALID_OFFICE',415);}
  }
  const old=await first(env.DB,`SELECT a.id,o.object_key,o.state object_state FROM attachments a
    LEFT JOIN storage_objects o ON o.id=a.object_id
    WHERE a.document_id=? AND a.sha256=? AND a.state='active'`,id,expected);
  if(old){
    if(old.object_state!=='ready'||!old.object_key)bad('原件正在删除或尚未就绪，不能覆盖','ORIGINAL_NOT_READY',409);
    // D1 metadata alone does not prove the physical R2 object exists. Only an
    // explicit user-provided backup with a verified digest can repair this key.
    if(await env.DOCUMENTS.head(old.object_key))return json({ok:true,already_restored:true,attachment_id:old.id});
    try{await env.DOCUMENTS.put(old.object_key,bytes,{httpMetadata:{contentType:file.type}});}
    catch{return json({ok:false,error:'R2_RESTORE_FAILED'},503);}
    return json({ok:true,restored_missing:true,attachment_id:old.id});
  }
  const attachmentCount=await first(env.DB,'SELECT COUNT(*) n FROM attachments WHERE document_id=?',id);
  if(Number(attachmentCount?.n||0)>=30)
    bad('每份文书最多30个附件，不能继续恢复新原件','ATTACHMENT_LIMIT',413);
  let obj=await first(env.DB,"SELECT id,object_key FROM storage_objects WHERE owner_id=? AND sha256=? AND mime=? AND quality_profile='backup-restore' AND state='ready'",p.user_id,expected,file.type);
  const now=isoNow();
  if(!obj){
    const oid=randomToken(16),key=`${p.user_id}/${randomToken(20)}`;
    await run(env.DB,'INSERT INTO storage_objects(id,owner_id,bucket,object_key,sha256,bytes,mime,quality_profile,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',oid,p.user_id,env.R2_BUCKET_NAME||'private',key,expected,bytes.length,file.type,'backup-restore','uploading',now,now);
    try{await env.DOCUMENTS.put(key,bytes,{httpMetadata:{contentType:file.type}});
      await run(env.DB,"UPDATE storage_objects SET state='ready',updated_at=? WHERE id=?",isoNow(),oid);
    }catch{await run(env.DB,"UPDATE storage_objects SET state='delete_failed',updated_at=? WHERE id=?",isoNow(),oid);bad('R2 恢复失败','RESTORE_UPLOAD_FAILED',503);}
    obj={id:oid,object_key:key};
  }
  // An owner-scoped, ready D1 row may outlive its physical R2 bytes.
  // A verified user backup must repair missing bytes before making a new link.
  if(obj && Number(attachmentCount?.n||0)<30 && !(await env.DOCUMENTS.head(obj.object_key))){
    try{await env.DOCUMENTS.put(obj.object_key,bytes,{httpMetadata:{contentType:file.type}});}
    catch{bad('原件 R2 丢失且补传失败；未建立附件引用','R2_REPAIR_FAILED',503);}
  }
  const aid=randomToken(16),sort=Number(form.get('sort_order')||0);
  await batch(env.DB,[
    ['INSERT INTO attachments(id,document_id,object_id,file_label,sort_order,sha256,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',aid,id,obj.id,label,Number.isInteger(sort)?sort:0,expected,now,now],
    ['UPDATE documents SET import_mode=?,updated_at=?,version=version+1 WHERE id=?','original',now,id]
  ]);
  return json({ok:true,attachment_id:aid},201);
}
export async function backupOriginal(env,p,id,aid){
  if(!env.DOCUMENTS)bad('R2 未绑定','NOT_CONFIGURED',503);
  const a=await first(env.DB,`SELECT o.object_key,o.mime FROM attachments a JOIN documents d ON d.id=a.document_id
    JOIN storage_objects o ON o.id=a.object_id
    WHERE a.id=? AND a.document_id=? AND d.owner_id=? AND d.lifecycle='active' AND a.state='active' AND o.state='ready'`,aid,id,p.user_id);
  if(!a)bad('原件不存在','NOT_FOUND',404);
  const r=await env.DOCUMENTS.get(a.object_key);
  if(!r)bad('原件已缺失','ORIGINAL_MISSING',404);
  return new Response(r.body,{headers:{'Content-Type':a.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'attachment'}});
}
