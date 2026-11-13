import { randomToken, isoNow } from './security.js';
import { json, failure, bad } from './http.js';
import { cleanupOrphans } from './upload.js';
const first=(db,sql,...params)=>db.prepare(sql).bind(...params).first();
const run=(db,sql,...params)=>db.prepare(sql).bind(...params).run();
const all=async(db,sql,...params)=>(await db.prepare(sql).bind(...params).all()).results||[];
const batch=(db,rows)=>db.batch(rows.map(([sql,...params])=>db.prepare(sql).bind(...params)));

async function ownedAttachment(env,p,documentId,attachmentId){
  const row=await first(env.DB,`SELECT a.*,d.owner_id,d.household_id,d.visibility,d.lifecycle,
      o.object_key,o.state object_state,o.bytes
    FROM attachments a JOIN documents d ON d.id=a.document_id
    LEFT JOIN storage_objects o ON o.id=a.object_id
    WHERE a.id=? AND a.document_id=?
      AND (d.owner_id=? OR (d.household_id=? AND d.visibility='shared'))`,
    attachmentId,documentId,p.user_id,p.household_id);
  if(!row)bad('附件不存在或无权操作','NOT_FOUND',404);
  return row;
}
export async function attachmentTrash(env,p,documentId,attachmentId){
  const a=await ownedAttachment(env,p,documentId,attachmentId);
  if(a.lifecycle!=='active')bad('仅可操作未删除文书中的附件','INVALID_STATE',409);
  if(a.state==='trashed')return json({ok:true,already_trashed:true});
  if(a.state!=='active')bad('附件正在删除，请勿恢复','DELETE_PENDING',409);
  const stamp=isoNow();
  const result=await batch(env.DB,[
    [`UPDATE attachments SET state='trashed',trashed_at=?,updated_at=?
      WHERE id=? AND state='active' AND EXISTS (
        SELECT 1 FROM documents d WHERE d.id=attachments.document_id
        AND d.lifecycle='active'
        AND (d.owner_id=? OR (d.household_id=? AND d.visibility='shared')))`,
      stamp,stamp,a.id,p.user_id,p.household_id],
    [`INSERT INTO audit_events(id,actor_user_id,kind,entity_type,entity_id,created_at)
      SELECT ?,?,?,'attachment',?,? WHERE changes()=1`,
      randomToken(16),p.user_id,'attachment_trashed',a.id,stamp]
  ]);
  if(result.some(x=>x.meta?.changes!==1))
    bad('附件共享权限已变化，请刷新','VERSION_CONFLICT',409);
  return json({ok:true,r2_deleted:false,message:'附件已移入回收站；原件仍在私有 R2，可恢复'});
}
export async function attachmentRestore(env,p,documentId,attachmentId){
  const a=await ownedAttachment(env,p,documentId,attachmentId);
  if(a.lifecycle!=='active')bad('请先恢复所在文书','DOCUMENT_TRASHED',409);
  if(a.state==='active')return json({ok:true,already_restored:true});
  if(a.state!=='trashed')bad('删除过程中不可恢复','DELETE_PENDING',409);
  // We do not HEAD R2 on list or tab changes; explicit restoration may check once.
  if(a.object_key){
    if(!env.DOCUMENTS)bad('R2 尚未绑定','NOT_CONFIGURED',503);
    if(!(await env.DOCUMENTS.head(a.object_key)))return failure('ORIGINAL_MISSING','原件已经缺失，请使用备份重新导入',409);
  }
  const stamp=isoNow();
  const result=await batch(env.DB,[
    [`UPDATE attachments SET state='active',trashed_at=NULL,updated_at=?
      WHERE id=? AND state='trashed' AND EXISTS(
        SELECT 1 FROM documents d WHERE d.id=attachments.document_id
        AND d.lifecycle='active' AND
        (d.owner_id=? OR (d.household_id=? AND d.visibility='shared')))`,
      stamp,a.id,p.user_id,p.household_id],
    [`INSERT INTO audit_events(id,actor_user_id,kind,entity_type,entity_id,created_at)
      SELECT ?,?,?,'attachment',?,? WHERE changes()=1`,
      randomToken(16),p.user_id,'attachment_restored',a.id,stamp]
  ]);
  if(result.some(x=>x.meta?.changes!==1))
    bad('附件共享权限已变化，请刷新','VERSION_CONFLICT',409);
  return json({ok:true});
}
export async function attachmentDelete(env,p,documentId,attachmentId){
  const a=await ownedAttachment(env,p,documentId,attachmentId);
  // Original object cleanup still assumes the R2 owner; don't allow a
  // collaborator to run it until cross-owner object cleanup is transactional.
  if(a.owner_id!==p.user_id)bad('永久删除附件需要原所有者确认','ORIGINAL_OWNER_REQUIRED',403);
  if(a.state==='active')bad('请先将附件移入回收站','TRASH_FIRST',409);
  if(a.state!=='deletion_pending'){
    await run(env.DB,"UPDATE attachments SET state='deletion_pending',updated_at=? WHERE id=? AND state='trashed'",isoNow(),a.id);
  }
  const now=isoNow();
  let shouldDelete=false;
  if(a.object_id){
    // Count all other references, even trashed or deletion-pending. Never physically delete while any persists.
    const refs=await first(env.DB,'SELECT COUNT(*) count FROM attachments WHERE object_id=? AND id!=?',a.object_id,a.id);
    shouldDelete=Number(refs.count)===0;
  }
  if(shouldDelete&&a.object_key){
    if(!env.DOCUMENTS)bad('R2 尚未绑定','NOT_CONFIGURED',503);
    // A concurrent attachment/document delete may have changed the reference set.
    // Claim only if D1 still confirms we own the last remaining attachment.
    const claim=await run(env.DB,`UPDATE storage_objects SET state='deletion_pending',updated_at=?
      WHERE id=? AND owner_id=? AND state IN ('ready','delete_failed','deletion_pending')
        AND NOT EXISTS(SELECT 1 FROM attachments WHERE object_id=? AND id!=?)`,
        now,a.object_id,p.user_id,a.object_id,a.id);
    if(claim.meta?.changes!==1)shouldDelete=false;
    else{
      await run(env.DB,`INSERT INTO deletion_jobs(id,object_id,requested_by,state,created_at,updated_at)
        VALUES(?,?,?,'pending',?,?) ON CONFLICT(object_id) DO UPDATE SET state='pending',updated_at=excluded.updated_at`,
        randomToken(16),a.object_id,p.user_id,now,now);
      try{await env.DOCUMENTS.delete(a.object_key);}
      catch{
        await batch(env.DB,[
          ["UPDATE storage_objects SET state='delete_failed',updated_at=? WHERE id=?",isoNow(),a.object_id],
          ["UPDATE deletion_jobs SET state='failed',attempt_count=attempt_count+1,last_error_code='R2_DELETE_FAILED',updated_at=? WHERE object_id=?",isoNow(),a.object_id]
        ]);
        return failure('DELETE_RETRY_NEEDED','R2 删除失败，已记录待清理；可以再次点击永久删除',503);
      }
    }
  }

  const cleanup=[['DELETE FROM attachments WHERE id=? AND document_id=?',a.id,documentId]];
  if(shouldDelete&&a.object_id) cleanup.push(['DELETE FROM deletion_jobs WHERE object_id=?',a.object_id],['DELETE FROM storage_objects WHERE id=?',a.object_id]);
  cleanup.push(['INSERT OR IGNORE INTO deletion_tombstones(id,owner_id,request_key,target_type,target_id,deleted_at) VALUES(?,?,?,?,?,?)',randomToken(16),p.user_id,`att:${a.id}`,'attachment',a.id,now]);
  try{await batch(env.DB,cleanup);}
  catch{return failure('METADATA_CLEANUP_FAILED','R2 删除可能已完成，D1 清理失败，可重试',503);}
  // If two references were deleted concurrently, the last one to commit
  // claims the orphaned object and deletes the actual R2 key.
  let compensated=0,pending=false;
  if(!shouldDelete&&a.object_id){
    try{
      const outcome=await (await cleanupOrphans(env,p,{onlyIds:[a.object_id]})).json();
      compensated=Number(outcome.removed||0);
      pending=!!outcome.pending;
    }catch{pending=true;}
  }
  return json({ok:true,r2_deleted:shouldDelete||compensated>0,
    r2_cleanup_pending:pending,warning:pending?'原件清理仍有待补偿项，请在设置中重试文件清理':null});
}
export async function attachmentList(env,p,documentId){
  const d=await first(env.DB,`SELECT id FROM documents WHERE id=? AND lifecycle='active'
    AND (owner_id=? OR (household_id=? AND visibility='shared'))`,
    documentId,p.user_id,p.household_id);
  if(!d)bad('无权查看附件回收站','NOT_FOUND',404);
  const items=await all(env.DB,`SELECT a.id,a.file_label,a.state,a.trashed_at,o.bytes,o.mime
    FROM attachments a LEFT JOIN storage_objects o ON o.id=a.object_id
    WHERE a.document_id=? AND a.state IN ('trashed','deletion_pending')
    ORDER BY a.trashed_at DESC LIMIT 50`,documentId);
  return json({items});
}
