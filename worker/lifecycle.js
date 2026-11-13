import { randomToken, isoNow } from './security.js';
import { json, failure, bad } from './http.js';
import { cleanupOrphans } from './upload.js';
const first=(db,sql,...params)=>db.prepare(sql).bind(...params).first();
const run=(db,sql,...params)=>db.prepare(sql).bind(...params).run();
const all=async(db,sql,...params)=>(await db.prepare(sql).bind(...params).all()).results||[];
const batch=(db,rows)=>db.batch(rows.map(([sql,...params])=>db.prepare(sql).bind(...params)));

async function ownedAttachment(env,p,documentId,attachmentId){
  const row=await first(env.DB,`SELECT a.*,d.owner_id,d.household_id,d.visibility,d.lifecycle,
      o.object_key,o.owner_id AS storage_owner_id,o.state object_state,o.bytes
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
  // Shared editors may request the same operation as the owner. Physical R2
  // ownership remains the original document owner, never the acting editor.
  // This invariant is also enforced at INSERT/UPDATE of attachment references.
  if(a.object_id&&a.storage_owner_id!==a.owner_id)
    bad('附件原件归属异常，已停止删除','OBJECT_OWNER_MISMATCH',409);
  if(a.state==='active')bad('请先将附件移入回收站','TRASH_FIRST',409);
  if(a.state!=='deletion_pending'){
    const marked=await run(env.DB,`UPDATE attachments SET state='deletion_pending',updated_at=?
      WHERE id=? AND document_id=? AND state='trashed' AND EXISTS(
        SELECT 1 FROM documents d WHERE d.id=attachments.document_id AND
        (d.owner_id=? OR (d.household_id=? AND d.visibility='shared')))`,
      isoNow(),a.id,documentId,p.user_id,p.household_id);
    if(marked.meta?.changes!==1)bad('附件权限或状态已变化，请刷新','VERSION_CONFLICT',409);
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
    // Claim the exact original owner's object, but only while this editor
    // still has access to the shared document. No cross-user R2 list/delete.
    const claim=await run(env.DB,`UPDATE storage_objects SET state='deletion_pending',updated_at=?
      WHERE id=? AND owner_id=? AND state IN ('ready','delete_failed','deletion_pending')
        AND NOT EXISTS(SELECT 1 FROM attachments WHERE object_id=? AND id!=?)
        AND EXISTS (SELECT 1 FROM attachments a JOIN documents d ON d.id=a.document_id
          WHERE a.id=? AND a.document_id=? AND a.object_id=storage_objects.id
            AND (d.owner_id=? OR (d.household_id=? AND d.visibility='shared')))`,
        now,a.object_id,a.owner_id,a.object_id,a.id,
        a.id,documentId,p.user_id,p.household_id);
    if(claim.meta?.changes!==1)
      return failure('DELETE_RETRY_NEEDED','附件权限或原件状态已变化，请刷新后重试',409);
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

  // Authorization was acquired when the attachment entered deletion_pending,
  // and re-checked at the R2 deletion claim. Do NOT block metadata cleanup
  // if the owner revokes sharing *after* R2.delete succeeds: that would leave
  // a still-referenced attachment pointing at already deleted bytes.
  // An initial call made after revocation still fails in ownedAttachment().
  const cleanup=[[`DELETE FROM attachments WHERE id=? AND document_id=?
    AND state='deletion_pending'`,
    a.id,documentId],
    [`INSERT INTO audit_events(id,actor_user_id,kind,entity_type,entity_id,created_at)
      SELECT ?,?,'attachment_permanently_deleted','attachment',?,? WHERE changes()=1`,
      randomToken(16),p.user_id,a.id,now]];
  if(shouldDelete&&a.object_id) cleanup.push(
    ['DELETE FROM deletion_jobs WHERE object_id=?',a.object_id],
    ['DELETE FROM storage_objects WHERE id=? AND owner_id=? AND NOT EXISTS(SELECT 1 FROM attachments WHERE object_id=storage_objects.id)',a.object_id,a.owner_id]);
  cleanup.push(['INSERT OR IGNORE INTO deletion_tombstones(id,owner_id,request_key,target_type,target_id,deleted_at) VALUES(?,?,?,?,?,?)',
    randomToken(16),a.owner_id,`att:${a.id}`,'attachment',a.id,now]);
  try{
    const result=await batch(env.DB,cleanup);
    if(result[0]?.meta?.changes!==1||result[1]?.meta?.changes!==1)
      return failure('METADATA_CLEANUP_FAILED','附件状态已改变，请刷新后检查清理结果',409);
  }catch{return failure('METADATA_CLEANUP_FAILED','R2 删除可能已完成，D1 清理失败，可重试',503);}
  // If two references were deleted concurrently, the last one to commit
  // claims the orphaned object and deletes the actual R2 key.
  let compensated=0,pending=false;
  if(!shouldDelete&&a.object_id){
    try{
      // Only the exact newly orphaned object belonging to the original
      // owner is eligible; audit attribution stays with p.user_id above.
      const outcome=await (await cleanupOrphans(env,{user_id:a.owner_id},
        {onlyIds:[a.object_id]})).json();
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
