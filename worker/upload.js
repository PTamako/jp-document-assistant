// Bounded, explicit multi-page imports. One owner-scoped R2 object per unique content hash.
import { json,bad,failure } from './http.js';
import { randomToken,isoNow } from './security.js';
const first=(db,s,...a)=>db.prepare(s).bind(...a).first();
const run=(db,s,...a)=>db.prepare(s).bind(...a).run();
const batch=(db,rows)=>db.batch(rows.map(([s,...a])=>db.prepare(s).bind(...a)));
const limit=8*1024*1024;
async function sha(bytes){const d=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,'0')).join('');}
export function validSignature(m,b){
  if(m==='image/jpeg')return b.length>3&&b[0]===255&&b[1]===216&&b[2]===255;
  if(m==='image/png')return [137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v);
  if(m==='image/webp')return new TextDecoder().decode(b.slice(0,4))==='RIFF'&&new TextDecoder().decode(b.slice(8,12))==='WEBP';
  if(m==='application/pdf')return new TextDecoder().decode(b.slice(0,5))==='%PDF-';
  return false;
}
export async function attachPage(request,env,p,id){
  if(!env.DOCUMENTS)bad('私有 R2 未配置','NOT_CONFIGURED',503);
  if(Number(request.headers.get('Content-Length')||0)>limit+10000)bad('上传大小超过单文件 8MB','FILE_TOO_LARGE',413);
  const doc=await first(env.DB,
    "SELECT id,owner_id,household_id,visibility,version FROM documents "+
    "WHERE id=? AND lifecycle='active' AND "+
    "(owner_id=? OR (household_id=? AND visibility='shared'))",
    id,p.user_id,p.household_id);
  if(!doc)bad('文书不存在','NOT_FOUND',404);
  const collaborator=doc.owner_id!==p.user_id;
  const form=await request.formData(),file=form.get('file');
  if(form.get('retention')!=='original')bad('明确选择保留原件后方可上传');
  if(!file||typeof file.arrayBuffer!=='function'||file.size<1||file.size>limit)bad('请选择不超过8MB的图片或 PDF');
  const mime=String(file.type||'').toLowerCase();
  if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(mime))bad('此格式暂不支持','UNSUPPORTED_MEDIA',415);
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(!validSignature(mime,bytes))bad('文件签名与类型不匹配','INVALID_MEDIA',415);
  const digest=await sha(bytes),label=String(file.name||'文书页').replace(/[\x00-\x1f]/g,'').slice(0,150);
  const prior=await first(env.DB,`SELECT a.id,o.object_key,o.state object_state FROM attachments a
    JOIN storage_objects o ON o.id=a.object_id
    WHERE a.document_id=? AND o.sha256=? AND a.state='active'`,id,digest);
  if(prior){
    if(prior.object_state!=='ready')bad('原件正在清理或尚未就绪，请先核对该文书','ORIGINAL_NOT_READY',409);
    // Explicit user upload carries verified bytes. A D1 ready row is not
    // proof that R2 still holds the object; repair before claiming reuse.
    try{
      if(!(await env.DOCUMENTS.head(prior.object_key)))
        await env.DOCUMENTS.put(prior.object_key,bytes,{httpMetadata:{contentType:mime}});
    }catch{bad('R2 原件缺失或补传失败，未确认附件复用成功','R2_REPAIR_FAILED',503);}
    return json({ok:true,reused:true,attachment_id:prior.id});
  }
  // Shared editors must not query the original owner's private/global SHA
  // dedup bucket. They can only reuse an attachment within THIS document.
  const quality=collaborator?'web-shared-doc:'+doc.id:'web-upload-v1';
  let obj=await first(env.DB,"SELECT id,object_key FROM storage_objects WHERE owner_id=? AND sha256=? AND mime=? AND quality_profile=? AND state='ready'",
    doc.owner_id,digest,mime,quality);
  const now=isoNow();
  if(obj){
    try{
      if(!(await env.DOCUMENTS.head(obj.object_key)))
        await env.DOCUMENTS.put(obj.object_key,bytes,{httpMetadata:{contentType:mime}});
    }catch{bad('旧扫描页原件丢失且补传失败，未创建新附件','R2_REPAIR_FAILED',503);}
  }
  if(!obj){
    const oid=randomToken(16),key=`${doc.owner_id}/${randomToken(20)}`;
    // Ownership is the ORIGINAL document owner, never the acting editor.
    try{await run(env.DB,'INSERT INTO storage_objects(id,owner_id,bucket,object_key,sha256,bytes,mime,quality_profile,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      oid,doc.owner_id,env.R2_BUCKET_NAME||'private',key,digest,bytes.length,mime,quality,'uploading',now,now);}
    catch{bad('该文件正在另一个上传过程中；请稍后重试','UPLOAD_CONFLICT',409);}
    try{await env.DOCUMENTS.put(key,bytes,{httpMetadata:{contentType:mime}});
      await run(env.DB,"UPDATE storage_objects SET state='ready',updated_at=? WHERE id=?",isoNow(),oid);
    }catch{return failure('UPLOAD_PARTIAL','上传未完成，已记录存储对象供人工清理/重试',503);}
    obj={id:oid,object_key:key};
  }
  const count=await first(env.DB,'SELECT COUNT(*) n FROM attachments WHERE document_id=?',id);
  if(count.n>=30)bad('每份文书最多30个附件','ATTACHMENT_LIMIT',413);
  const aid=randomToken(16);
  try{
    const changed=await batch(env.DB,[
      ["UPDATE documents SET import_mode=?,updated_at=?,version=version+1 "+
        "WHERE id=? AND version=? AND lifecycle='active' "+
        "AND (owner_id=? OR (household_id=? AND visibility='shared')) "+
        "AND (SELECT COUNT(*) FROM attachments WHERE document_id=?)<30",
        'original',now,id,doc.version,p.user_id,p.household_id,id],
      ["INSERT INTO attachments(id,document_id,object_id,file_label,page_no,"+
        "sort_order,sha256,created_at,updated_at) "+
        "SELECT ?,?,?,?,?,?,?,?,? WHERE changes()=1",
        aid,id,obj.id,label,count.n+1,count.n,digest,now,now],
      ["INSERT INTO audit_events(id,actor_user_id,kind,entity_type,entity_id,created_at) "+
        "SELECT ?,?,'attachment_uploaded','attachment',?,? WHERE changes()=1",
        randomToken(16),p.user_id,aid,now]
    ]);
    if(changed.some(x=>x.meta?.changes!==1))
      return failure('SHARE_OR_VERSION_CHANGED',
       '共享权限或附件列表已变化；原件可能等待补偿清理，请刷新核对',409);
  }catch{return failure('METADATA_FAILED','附件索引未能确认保存；可能有待补偿 R2 对象，请重试',503);}
  return json({ok:true,attachment_id:aid,reused:false,ocr_status:'not_verified'},201);
}
// Explicit small-batch compensation. Never R2 LIST/HEAD, never a new Cron or Worker.
// Handles abandoned uploads and genuinely unreferenced ready objects from two
// simultaneous deletions. Each claim is one conditional SQLite UPDATE, blocking
// newly attached references through the existing D1 owner/state trigger.
export async function cleanupOrphans(env,p,{onlyIds=null}={}){
  if(!env.DOCUMENTS)bad('私有 R2 未配置','NOT_CONFIGURED',503);
  const ids=Array.isArray(onlyIds)?[...new Set(onlyIds.filter(x=>/^[a-f0-9]{32}$/i.test(x)))].slice(0,5):null;
  const staleAt=new Date(Date.now()-10*60000).toISOString();
  let rows=[];
  if(ids){
    if(ids.length)rows=(await env.DB.prepare(`SELECT o.id,o.object_key FROM storage_objects o WHERE o.owner_id=?
      AND o.id IN (${ids.map(()=>'?').join(',')}) AND o.state IN ('ready','uploading','delete_failed','deletion_pending')
      AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.object_id=o.id) LIMIT 5`).bind(p.user_id,...ids).all()).results||[];
  }else{
    rows=(await env.DB.prepare(`SELECT o.id,o.object_key FROM storage_objects o WHERE o.owner_id=?
      AND o.state IN ('ready','uploading','delete_failed','deletion_pending') AND o.updated_at<?
      AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.object_id=o.id)
      ORDER BY o.updated_at LIMIT 5`).bind(p.user_id,staleAt).all()).results||[];
  }
  const failures=[];let removed=0;
  for(const o of rows){
    const now=isoNow();
    try{
      const claim=await run(env.DB,`UPDATE storage_objects SET state='deletion_pending',updated_at=?
        WHERE id=? AND owner_id=? AND (state IN ('ready','uploading','delete_failed')
          OR (state='deletion_pending' AND updated_at<?))
        AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.object_id=storage_objects.id)`,now,o.id,p.user_id,staleAt);
      if(claim.meta?.changes!==1)continue;
      await run(env.DB,`INSERT INTO deletion_jobs(id,object_id,requested_by,state,created_at,updated_at)
        VALUES(?,?,?,'pending',?,?) ON CONFLICT(object_id)
        DO UPDATE SET state='pending',updated_at=excluded.updated_at`,randomToken(16),o.id,p.user_id,now,now);
      await env.DOCUMENTS.delete(o.object_key);
      await batch(env.DB,[
        ['DELETE FROM deletion_jobs WHERE object_id=?',o.id],
        ['DELETE FROM storage_objects WHERE id=? AND owner_id=? AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.object_id=storage_objects.id)',o.id,p.user_id]
      ]);
      removed++;
    }catch{
      try{await batch(env.DB,[
        ["UPDATE storage_objects SET state='delete_failed',updated_at=? WHERE id=? AND owner_id=?",isoNow(),o.id,p.user_id],
        ["UPDATE deletion_jobs SET state='failed',attempt_count=attempt_count+1,last_error_code='COMPENSATION_FAILED',updated_at=? WHERE object_id=?",isoNow(),o.id]
      ]);}catch{}
      failures.push(o.id);
    }
  }
  return json({ok:failures.length===0,removed,failures,pending:failures.length>0,
    note:'仅对 D1 已确认没有附件引用的对象执行精确 R2.delete；不会扫描 R2 全桶'});
}
