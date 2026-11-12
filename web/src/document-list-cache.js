// Invalidate only local list caches; never poll, sync an OAuth token,
// upload a file or modify linked data in other apps.
// The three document-backed tabs have different id fields:
// Today & Library: item.id; Integrations: item.document_id.
export function invalidateDocumentLists(pages,documentId=null){
 const id=documentId==null?null:String(documentId);
 for(const name of ['today','docs','links']){
  const page=pages?.[name];
  if(!page)continue;
  if(id!==null)page.items=(page.items||[]).filter(item=>
   String(item?.document_id??item?.id)!==id && String(item?.id)!==id
  );
  // Force a fresh server query on the NEXT tab visit. Meanwhile the removed
  // record disappears immediately, even if the user visits a cached tab.
  page.loaded=false;
  page.next=null;
 }
}
