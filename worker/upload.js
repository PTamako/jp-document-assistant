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
  const doc=await first(env.DB,"SELECT id FROM documents WHERE id=? AND owner_id=? AND lifecycle='active'",id,p.user_id);
  if(!doc)bad('文书不存在','NOT_FOUND',404);
  const form=await request.formData(),file=form.get('file');
  if(form.get('retention')!=='original')bad('明确选择保留原件后方可上传');
  if(!file||typeof file.arrayBuffer!=='function'||file.size<1||file.size>limit)bad('请选择不超过8MB的图片或 PDF');
  const mime=String(file.type||'').toLowerCase();
  if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(mime))bad('此格式暂不支持','UNSUPPORTED_MEDIA',415);
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(!validSignature(mime,bytes))bad('文件签名与类型不匹配','INVALID_MEDIA',415);
  const digest=await sha(bytes),label=String(file.name||'文书页').replace(/[\x00-\x1f]/g,'').slice(0,150);
  const prior=await first(env.DB,`SELECT a.id FROM attachments a JOIN storage_objects o ON o.id=a.object_id
    WHERE a.document_id=? AND o.sha256=? AND a.state='active'`,id,digest);
  if(prior)return json({ok:true,reused:true,attachment_id:prior.id});
  const quality='web-upload-v1';
  let obj=await first(env.DB,"SELECT id,object_key FROM storage_objects WHERE owner_id=? AND sha256=? AND mime=? AND quality_profile=? AND state='ready'",p.user_id,digest,mime,quality);
  const now=isoNow();
  if(!obj){
    const oid=randomToken(16),key=`${p.user_id}/${randomToken(20)}`;
    try{await run(env.DB,'INSERT INTO storage_objects(id,owner_id,bucket,object_key,sha256,bytes,mime,quality_profile,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',oid,p.user_id,env.R2_BUCKET_NAME||'private',key,digest,bytes.length,mime,quality,'uploading',now,now);}
    catch{bad('该文件正在另一个上传过程中；请稍后重试','UPLOAD_CONFLICT',409);}
    try{await env.DOCUMENTS.put(key,bytes,{httpMetadata:{contentType:mime}});
      await run(env.DB,"UPDATE storage_objects SET state='ready',updated_at=? WHERE id=?",isoNow(),oid);
    }catch{return failure('UPLOAD_PARTIAL','上传未完成，已记录存储对象供人工清理/重试',503);}
    obj={id:oid,object_key:key};
  }
  const count=await first(env.DB,'SELECT COUNT(*) n FROM attachments WHERE document_id=?',id);
  if(count.n>=30)bad('每份文书最多30个附件','ATTACHMENT_LIMIT',413);
  const aid=randomToken(16);
  try{await batch(env.DB,[
    ['INSERT INTO attachments(id,document_id,object_id,file_label,page_no,sort_order,sha256,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',aid,id,obj.id,label,count.n+1,count.n,digest,now,now],
    ['UPDATE documents SET import_mode=?,updated_at=?,version=version+1 WHERE id=?','original',now,id]
  ]);}catch{return failure('METADATA_FAILED','文件可能已存到 R2，附件索引保存失败；请重试',503);}
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
