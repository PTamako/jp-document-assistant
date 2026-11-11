import { json, bad, readJson } from './http.js';
import { randomToken, isoNow } from './security.js';
const first=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const run=(db,sql,...args)=>db.prepare(sql).bind(...args).run();
const all=async(db,sql,...args)=>(await db.prepare(sql).bind(...args).all()).results||[];
const batch=(db,rows)=>db.batch(rows.map(([sql,...args])=>db.prepare(sql).bind(...args)));
const maxDocs=5;
function scopeQuery(p,input){
  const scope=input.scope||'all';
  if(!['all','month','year','selection'].includes(scope))bad('备份范围不支持');
  let sql=`SELECT d.* FROM documents d WHERE d.owner_id=? AND d.lifecycle!='deletion_pending'`;
  const args=[p.user_id];
  if(scope==='month'){
    if(!/^20\d\d-(?:0[1-9]|1[0-2])$/.test(String(input.month)))bad('请选择 YYYY-MM');
    sql+=' AND substr(d.created_at,1,7)=?';args.push(input.month);
  }else if(scope==='year'){
    if(!/^20\d\d$/.test(String(input.year)))bad('请选择 YYYY');
    sql+=' AND substr(d.created_at,1,4)=?';args.push(input.year);
  }else if(scope==='selection'){
    if(!Array.isArray(input.ids)||input.ids.length===0||input.ids.length>20||!input.ids.every(x=>/^[a-f0-9]{32}$/.test(x)))bad('选择的文书无效');
    sql+=` AND d.id IN (${input.ids.map(()=>'?').join(',')})`;args.push(...input.ids);
  }
  return {sql,args,scope};
}
export async function planBackup(request,env,p){
  const d=await readJson(request,8000), {sql,args,scope}=scopeQuery(p,d);
  const docs=await all(env.DB,`${sql} ORDER BY d.created_at DESC LIMIT 101`,...args);
  const count=docs.length>100?null:docs.length;
  const sizes=await all(env.DB,`SELECT a.document_id,o.id,o.bytes,o.state FROM attachments a JOIN storage_objects o ON a.object_id=o.id
    JOIN documents d ON d.id=a.document_id WHERE d.owner_id=? AND d.lifecycle!='deletion_pending' AND a.state='active'`,p.user_id);
  const docIds=new Set(docs.map(x=>x.id));
  const objectIds=new Set(), bytes=()=>sizes.reduce((sum,o)=>{
    if(!docIds.has(o.document_id)||objectIds.has(o.id))return sum;
    objectIds.add(o.id);return sum+Number(o.bytes||0);
  },0);
  const originalBytes=d.includes_originals?bytes():0;
  const id=randomToken(16);
  await run(env.DB,'INSERT INTO backup_runs(id,user_id,scope,includes_originals,status,item_count,created_at) VALUES(?,?,?,?,?,?,?)',id,p.user_id,scope,d.includes_originals?1:0,'planned',count||0,isoNow());
  return json({backup_id:id,scope,document_count:count,document_count_known:count!==null,include_originals:!!d.includes_originals,original_bytes_estimate:originalBytes,originals_note:'原件不包含在 JSON 中；可通过备份清单逐个授权下载。大文件请分批保存。',max_documents_per_export:maxDocs});
}
function stripSecrets(doc){
  const {id,visibility,category,subtype,title,summary_zh,explanation_zh,extracted_text_ja,
    source_document_date,source_date_quote,official_current_verified_at,import_mode,analysis_status,lifecycle,archived_at,content_sha256,created_at,updated_at,version}=doc;
  return {id,visibility,category,subtype,title,summary_zh,explanation_zh,extracted_text_ja,
    source_document_date,source_date_quote,official_current_verified_at,import_mode,analysis_status,lifecycle,archived_at,content_sha256,created_at,updated_at,version};
}
export async function exportBackup(env,p,url){
  const scope=url.searchParams.get('scope')||'all';
  const q={scope,month:url.searchParams.get('month'),year:url.searchParams.get('year'),ids:url.searchParams.getAll('id')};
  const {sql,args}=scopeQuery(p,q),offset=Number(url.searchParams.get('offset')||0);
  if(!Number.isSafeInteger(offset)||offset<0||offset>10000)bad('分页位置无效');
  const rows=await all(env.DB,`${sql} ORDER BY d.created_at DESC,d.id DESC LIMIT ? OFFSET ?`,...args,maxDocs+1,offset);
  const documents=[];
  for(const doc of rows.slice(0,maxDocs)){
    const fields=await all(env.DB,`SELECT field_key,raw_value,normalized_value,value_type,original_currency,source_quote,source_page,review_state
      FROM document_fields WHERE document_id=?`,doc.id);
    const candidates=await all(env.DB,'SELECT candidate_kind,payload_json,state FROM action_candidates WHERE document_id=?',doc.id);
    const attachments=await all(env.DB,`SELECT a.id,a.file_label,a.page_no,a.sort_order,a.sha256,o.bytes,o.mime,o.sha256 object_sha256,o.state
      FROM attachments a LEFT JOIN storage_objects o ON o.id=a.object_id
      WHERE a.document_id=? AND a.state='active' ORDER BY a.sort_order`,doc.id);
    documents.push({document:stripSecrets(doc),fields,candidates:candidates.map(c=>({kind:c.candidate_kind,payload:JSON.parse(c.payload_json),state:c.state})),attachments:attachments.map(a=>({...a,download_path:a.state==='ready'?`/api/backups/original/${doc.id}/${a.id}`:null}))});
  }
  return json({schema_version:'1.0',exported_at:isoNow(),source_app:'jp-document-assistant',includes_originals:false,originals_available_separately:true,documents,next_offset:rows.length>maxDocs?offset+maxDocs:null,warnings:['该 JSON 可能含个人资料，请保存在安全位置','原件必须单独主动下载；只有 JSON 无法恢复已永久删除的照片','恢复不会重发三个 App 的财务、任务与学习记录']});
}
function validateDocumentBackup(entry){
  if(!entry||typeof entry!=='object'||!entry.document||typeof entry.document!=='object')bad('备份条目格式不正确');
  const d=entry.document;
  if(typeof d.title!=='string'||d.title.length>200||typeof d.category!=='string'||d.category.length>40)bad('备份文书字段无效');
  if(d.extracted_text_ja!==null&&d.extracted_text_ja!==undefined&&(typeof d.extracted_text_ja!=='string'||d.extracted_text_ja.length>100000))bad('备份原文超出限制');
  if(d.source_document_date!=null&&!(typeof d.source_document_date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d.source_document_date)))
    bad('备份文书发布日期格式无效');
  if(d.source_date_quote!=null&&(typeof d.source_date_quote!=='string'||d.source_date_quote.length>220))
    bad('备份发布日期证据过长');
  if(!Array.isArray(entry.fields)||entry.fields.length>200||!Array.isArray(entry.candidates)||entry.candidates.length>100)bad('备份字段或候选数过多');
  for(const f of entry.fields){
    if(typeof f.field_key!=='string'||f.field_key.length>100||!['text','money','date','datetime','boolean','json'].includes(f.value_type))bad('字段类型无效');
  }
  for(const c of entry.candidates){if(!['finance','homeflow_task','vocabulary','sentence'].includes(c.kind)||typeof c.payload!=='object'||c.payload===null||JSON.stringify(c.payload).length>4000)bad('备份候选无效');}
  return d;
}
function validateBackup(data){
  if(data.schema_version!=='1.0'||data.source_app!=='jp-document-assistant')bad('备份版本不受支持','UNSUPPORTED_BACKUP',422);
  if(!Array.isArray(data.documents)||data.documents.length===0||data.documents.length>maxDocs)bad('每次最多恢复五份文书');
  for(const entry of data.documents)validateDocumentBackup(entry);
}
export async function previewImport(request,env,p){
  const d=await readJson(request,900000);
  validateBackup(d);
  const results=[];
  for(const item of d.documents){
    const doc=item.document;
    const existing=doc.content_sha256?await first(env.DB,'SELECT id FROM documents WHERE owner_id=? AND content_sha256=? AND lifecycle!=\'deletion_pending\'',p.user_id,doc.content_sha256):null;
    results.push({title:doc.title.slice(0,40),action:existing?'skip_duplicate':'restore_metadata',can_restore_original:false,has_original_reference:(item.attachments||[]).length>0});
  }
  return json({ok:true,preview:results,note:'本步骤不写 D1、R2；恢复后只可查看文字和结构化数据。原件需单独上传并验证 SHA-256。'});
}
export async function confirmImport(request,env,p){
  const d=await readJson(request,900000);
  if(d.confirm!=='RESTORE_METADATA')bad('需要明确确认仅恢复数据','CONFIRM_REQUIRED',409);
  validateBackup(d);
  const now=isoNow(), restored=[],skipped=[],index_map=[];
  for(const [position,item] of d.documents.entries()){
    const old=item.document,sha=old.content_sha256;
    if(sha){const dup=await first(env.DB,"SELECT id FROM documents WHERE owner_id=? AND content_sha256=? AND lifecycle!='deletion_pending'",p.user_id,sha);if(dup){skipped.push(dup.id);index_map.push({index:position,id:dup.id,skipped:true});continue;}}
    const id=randomToken(16),visibility='private';
    const statements=[['INSERT INTO documents(id,owner_id,household_id,visibility,category,title,summary_zh,explanation_zh,extracted_text_ja,source_document_date,source_date_quote,official_current_verified_at,import_mode,analysis_status,created_at,updated_at,content_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id,p.user_id,p.household_id,visibility,old.category,old.title,old.summary_zh||null,old.explanation_zh||null,old.extracted_text_ja||null,old.source_document_date||null,old.source_date_quote||null,null,'summary','needs_review',now,now,sha||null]];
    for(const f of item.fields){
      statements.push(['INSERT INTO document_fields(id,document_id,field_key,raw_value,normalized_value,value_type,original_currency,source_quote,source_page,review_state,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',randomToken(16),id,f.field_key,String(f.raw_value||'').slice(0,500),String(f.normalized_value||'').slice(0,500),f.value_type,String(f.original_currency||'').slice(0,20)||null,String(f.source_quote||'').slice(0,500),Number.isInteger(f.source_page)?f.source_page:null,'unreviewed',now]);
    }
    for(const c of item.candidates){
      statements.push(['INSERT INTO action_candidates(id,document_id,candidate_kind,payload_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',randomToken(16),id,c.kind,JSON.stringify(c.payload),'suggested',now,now]);
    }
    await batch(env.DB,statements);
    restored.push(id);index_map.push({index:position,id,skipped:false});
  }
  return json({ok:true,restored,skipped,index_map,originals_restored:0,needs_original_reupload:true,remote_syncs_sent:0});
}
