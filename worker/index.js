import { randomToken, hashString, hmacHex, safeEqual, newCredential, checkPassword, parseCookie, cookieForSession, clearingCookie, sameOrigin, normalizedEmail, validatePassword, isoNow } from './security.js';
import { parseJapaneseText,extractCampaignActionHints } from './analysis.js';
import { inferSbiInvestmentKind } from '../shared/sbi-investment.js';
import {isSalaryDepositNotice} from './payment-notices.js';
import { deliveryTaskSuggestion } from './delivery-task.js';
import { json, failure, readJson, bad, validString } from './http.js';
import { attachmentTrash, attachmentRestore, attachmentDelete, attachmentList } from './lifecycle.js';
import { planBackup, exportBackup, previewImport, confirmImport } from './backup.js';
import { restoreUpload, backupOriginal } from './restore.js';
import { commitCandidate,candidatePreview,getBridgeStatus,integrationStatus } from './bridge.js';
import {requestDocumentMemberApproval,documentMemberApprovalStatus} from './document-member-approval.js';
import {documentExecutionRoute} from './document-execution.js';
import {documentTaskSourceRoute} from './document-task-source.js';
import {listDocumentFinanceAccounts} from './document-finance-account.js';
import { ocrAttachment } from './ocr.js';
import { ocrSpaceAttachment } from './ocr-space.js';
import { handleGoogleGmail } from './google-oauth.js';
import { oauthCallback,handleBrowserGoogle } from './google-browser-oauth.js';
import {startHomeFlowSso,callbackHomeFlowSso,completeHomeFlowSso,homeflowSsoEnabled,verifyHomeFlowSession} from './homeflow-sso.js';
import {ocrSpaceImportPreview} from './ocr-space-preview.js';
import {workersAiImportPreview} from './ocr-import-preview.js';
import {analyzeDocumentAi,getDocumentAiCache} from './intelligence.js';
import {geminiQuotaUsage} from './gemini-budget.js';
import {enqueueDocumentAi,processDocumentAiJob,getDocumentAiJob,runDueDocumentAiJobs} from './ai-jobs.js';
import { calendarStatus,createCalendarSubscription,revokeCalendarSubscription,serveCalendar } from './calendar.js';
import { attachPage,cleanupOrphans } from './upload.js';
import { validateOfficeBytes } from '../web/src/document-text.js';
import {handleDocumentTranslation,documentTranslationBudgetUsage} from './document-translation.js';

// One production Worker. No R2 LIST, no browser-owned R2 credentials.
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LIST = 10;
const fieldsOf = ['due_date','event_date','amount_jpy','net_salary'];
const sensitiveCategories=new Set(['salary','tax','bank','card_spend','topup','insurance','medical','government','housing','travel','hotel']);
const sensitiveSource=/(?:マイナンバー|個人番号|在留カード|旅券|パスポート|運転免許証|保険証|口座番号|銀行口座|診療明細|給与明細)/;
function requiresPrivateDefault(category,sourceText=''){
  return sensitiveCategories.has(category)||sensitiveSource.test(String(sourceText));
}
const fullDate = /^(?:19|20)\d{2}-\d{2}-\d{2}$/;
const validCivilDate = value => fullDate.test(value) && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const dbRun = (db,sql,...args) => db.prepare(sql).bind(...args).run();
const dbFirst = (db,sql,...args) => db.prepare(sql).bind(...args).first();
const dbAll = async (db,sql,...args) => (await db.prepare(sql).bind(...args).all()).results || [];
const batch = (db,statements) => db.batch(statements.map(([sql,...args])=>db.prepare(sql).bind(...args)));
function protectedResponse(resp,request){
  if(!resp || resp.status===101)return resp;
  const h=new Headers(resp.headers);
  // Browser-restricted Google Picker API keys must receive the website origin
  // in the Referer header. Suppress paths/queries in cross-origin requests.
  // Keep all private API responses strict: never send an API URL as referrer.
  const isPrivateApi=new URL(request.url).pathname.startsWith('/api/');
  h.set('Referrer-Policy',isPrivateApi?'no-referrer':'strict-origin-when-cross-origin');
  h.set('X-Content-Type-Options','nosniff');
  h.set('X-Frame-Options','DENY');
  h.set('Permissions-Policy','camera=(self), microphone=(), geolocation=()');
  // OpenCV Embind dynamically creates functions. SDK Worker mode also needs
  // a nested same-origin worker for OffscreenCanvas (no `document` in workers).
  // Restrict both capabilities to generated OCR worker-entry assets only.
  const isOcrWorker=/^\/assets\/worker-entry-[A-Za-z0-9_-]+\.js$/.test(new URL(request.url).pathname);
  if(isOcrWorker)h.set('Content-Security-Policy',"default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; img-src 'self' blob: data:; connect-src 'self' https://cdn.jsdelivr.net https://paddle-model-ecology.bj.bcebos.com https://huggingface.co https://cas-bridge.xethub.hf.co https://cdn-lfs.hf.co; worker-src 'self'; object-src 'none'; base-uri 'none'");
  else if(!h.has('Content-Security-Policy'))h.set('Content-Security-Policy',"default-src 'self'; img-src 'self' blob: data:; script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com https://apis.google.com; worker-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://gmail.googleapis.com https://www.googleapis.com https://accounts.google.com https://oauth2.googleapis.com https://apis.google.com https://cdn.jsdelivr.net https://paddle-model-ecology.bj.bcebos.com https://huggingface.co https://cas-bridge.xethub.hf.co https://cdn-lfs.hf.co; font-src 'self'; object-src 'none'; frame-src 'self' blob: https://accounts.google.com https://docs.google.com https://drive.google.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  return new Response(resp.body,{status:resp.status,statusText:resp.statusText,headers:h});
}
function requireBinding(env,key){ if(!env[key]) bad(`尚未配置 ${key}，操作不可用`,'NOT_CONFIGURED',503); }
async function requireSession(request,env){
  requireBinding(env,'DB'); requireBinding(env,'SESSION_HMAC_KEY');
  const cookie=parseCookie(request,'__Host-da_session');
  if(!cookie || !/^[a-f0-9]{64}$/.test(cookie)) bad('请先登录','UNAUTHENTICATED',401);
  const hash=await hashString(cookie);
  const session=await dbFirst(env.DB,`SELECT s.id session_id,s.user_id,s.expires_at,
      s.auth_source,u.household_id,u.role,u.display_name,u.email_norm,u.status,
      hp.state_hash,hp.proof_cipher,hp.proof_iv,hp.expires_at AS proof_expires_at,
      hp.homeflow_user_id,l.homeflow_household_id,l.state AS homeflow_link_state,
      u.role AS homeflow_link_role,l.local_user_id AS link_local_user_id
    FROM sessions s JOIN users u ON u.id=s.user_id
    LEFT JOIN homeflow_session_proofs hp ON hp.session_id=s.id
    LEFT JOIN homeflow_identity_links l ON l.homeflow_user_id=hp.homeflow_user_id
    WHERE s.secret_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.status='active'`,hash,isoNow());
  if(!session)bad('登录已失效，请重新登录','UNAUTHENTICATED',401);
  if(session.auth_source==='homeflow'){
    // Neither an absent proof nor a failed HomeFlow call can fall back to
    // legacy login. Every private GET/write checks live HomeFlow authority.
    if(!session.homeflow_user_id||!session.proof_cipher||
      session.homeflow_link_state!=='active'||
      session.link_local_user_id!==session.user_id||
      session.homeflow_link_role!==session.role)
      bad('HomeFlow 登录已失效，请重新登录','UNAUTHENTICATED',401);
    const current=await verifyHomeFlowSession(env,{
      state_hash:session.state_hash,proof_cipher:session.proof_cipher,
      proof_iv:session.proof_iv,expires_at:session.proof_expires_at,
      homeflow_user_id:session.homeflow_user_id,
      homeflow_household_id:session.homeflow_household_id,
      role:session.role
    });
    if(!current || current.userId!==session.homeflow_user_id ||
      current.householdId!==session.homeflow_household_id ||
      current.role!==session.role)
      bad('HomeFlow 登录已失效，请重新登录','UNAUTHENTICATED',401);
    session.display_name=current.nickname;
  }else if(session.auth_source!=='legacy'){
    bad('无效的登录方式','UNAUTHENTICATED',401);
  }
  const csrf=await hmacHex(env.SESSION_HMAC_KEY,`csrf:${cookie}`);
  return {...session,csrf};
}
function requireMutation(request,principal){
  if(!sameOrigin(request)) bad('来源验证失败','BAD_ORIGIN',403);
  if(!safeEqual(request.headers.get('X-CSRF-Token')||'',principal.csrf)) bad('请求校验失败，请刷新重试','BAD_CSRF',403);
}
async function createSession(env,userId){
  const cookie=randomToken(32), now=isoNow(),expires=new Date(Date.now()+14*86400000).toISOString();
  await dbRun(env.DB,'INSERT INTO sessions(id,user_id,secret_hash,expires_at,created_at) VALUES(?,?,?,?,?)',randomToken(16),userId,await hashString(cookie),expires,now);
  return {cookie,csrf:await hmacHex(env.SESSION_HMAC_KEY,`csrf:${cookie}`),expires};
}
async function recordThrottle(env,identity,failed){
  const now=isoNow();
  if(!failed){await dbRun(env.DB,'DELETE FROM auth_throttle WHERE identity_hash=?',identity); return;}
  await dbRun(env.DB,`INSERT INTO auth_throttle(identity_hash,failures,blocked_until,updated_at) VALUES(?,1,NULL,?)
    ON CONFLICT(identity_hash) DO UPDATE SET failures=failures+1,
    blocked_until=CASE WHEN failures+1>=6 THEN ? ELSE blocked_until END,
    updated_at=excluded.updated_at`,identity,now,new Date(Date.now()+15*60000).toISOString());
}
async function handleAuth(request,env,url){
  requireBinding(env,'DB');requireBinding(env,'SESSION_HMAC_KEY');
  if(!sameOrigin(request))bad('来源验证失败','BAD_ORIGIN',403);
  const data=await readJson(request,12000), path=url.pathname, now=isoNow();
  if(path==='/api/auth/bootstrap'){
    requireBinding(env,'BOOTSTRAP_ADMIN_TOKEN');
    const count=await dbFirst(env.DB,'SELECT COUNT(*) count FROM households');
    if(Number(count?.count||0)>0)bad('家庭已初始化','ALREADY_INITIALIZED',409);
    if(!safeEqual(await hashString(String(data.setup_token||'')),await hashString(env.BOOTSTRAP_ADMIN_TOKEN)))bad('初始化凭证无效','INVALID_SETUP_TOKEN',403);
    const email=normalizedEmail(data.email);
    if(!email||!validatePassword(data.password))bad('需要有效邮箱和至少12位密码');
    const credentials=await newCredential(data.password),hid=randomToken(16),uid=randomToken(16);
    await batch(env.DB,[
      ['INSERT INTO households(id,name,created_at,updated_at) VALUES(?,?,?,?)',hid,'家庭',now,now],
      ['INSERT INTO users(id,household_id,email_norm,display_name,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',uid,hid,email,String(data.display_name||'').slice(0,50),'owner',now,now],
      ['INSERT INTO password_credentials(user_id,password_salt,password_hash,iterations,updated_at) VALUES(?,?,?,?,?)',uid,credentials.password_salt,credentials.password_hash,credentials.iterations,now]
    ]);
    const session=await createSession(env,uid);
    return json({ok:true,user:{id:uid,display_name:String(data.display_name||'').slice(0,50),role:'owner'},csrf_token:session.csrf},201,{'Set-Cookie':cookieForSession(session.cookie)});
  }
  if(path==='/api/auth/login'){
    const email=normalizedEmail(data.email);
    if(!email||typeof data.password!=='string')bad('邮箱或密码错误','INVALID_CREDENTIALS',401);
    const identity=await hashString(`login:${email}`);
    const throttle=await dbFirst(env.DB,'SELECT blocked_until FROM auth_throttle WHERE identity_hash=?',identity);
    if(throttle?.blocked_until && throttle.blocked_until>now)bad('尝试次数过多，请稍后再试','RATE_LIMITED',429);
    const user=await dbFirst(env.DB,`SELECT u.id,u.display_name,u.role,p.password_salt,p.password_hash,p.iterations
      FROM users u JOIN password_credentials p ON p.user_id=u.id WHERE u.email_norm=? AND u.status='active'`,email);
    if(!user || !(await checkPassword(data.password,user))){await recordThrottle(env,identity,true);bad('邮箱或密码错误','INVALID_CREDENTIALS',401);}
    await recordThrottle(env,identity,false);
    const session=await createSession(env,user.id);
    return json({ok:true,user:{id:user.id,display_name:user.display_name,role:user.role},csrf_token:session.csrf},200,{'Set-Cookie':cookieForSession(session.cookie)});
  }
  if(path==='/api/household/join'){
    const email=normalizedEmail(data.email);
    if(!email||!validatePassword(data.password)||typeof data.invite_token!=='string')bad('邀请码、邮箱或密码无效');
    const invite=await dbFirst(env.DB,`SELECT i.* FROM household_invites i WHERE i.token_hash=? AND i.accepted_at IS NULL AND i.expires_at>?`,await hashString(data.invite_token),now);
    if(!invite || invite.invitee_email_norm!==email)bad('邀请码无效或过期','INVALID_INVITE',403);
    const credentials=await newCredential(data.password),uid=randomToken(16);
    const count=await dbFirst(env.DB,`SELECT COUNT(*) count FROM users WHERE household_id=? AND status!='left'`,invite.household_id);
    if(count.count>=2)bad('家庭成员已满','HOUSEHOLD_FULL',409);
    // The first UPDATE wins the invite. Each following INSERT is gated on the
    // preceding statement's SQLite changes() value in the same D1 transaction.
    // A raced or already-consumed invite cannot create an extra user/session.
    let joined;
    try{joined=await batch(env.DB,[
      ['UPDATE household_invites SET accepted_at=? WHERE id=? AND accepted_at IS NULL AND expires_at>?',now,invite.id,now],
      [`INSERT INTO users(id,household_id,email_norm,display_name,role,created_at,updated_at)
        SELECT ?,?,?,?,?,?,? WHERE changes()=1`,uid,invite.household_id,email,String(data.display_name||'').slice(0,50),'member',now,now],
      [`INSERT INTO password_credentials(user_id,password_salt,password_hash,iterations,updated_at)
        SELECT ?,?,?,?,? WHERE changes()=1`,uid,credentials.password_salt,credentials.password_hash,credentials.iterations,now]
    ]);}catch{bad('邀请码使用失败或家庭已满','INVITE_CONFLICT',409);}
    if(joined.some(r=>r.meta?.changes!==1))bad('邀请码已被使用，请重新邀请','INVITE_CONFLICT',409);
    const session=await createSession(env,uid);
    return json({ok:true,user:{id:uid,role:'member'},csrf_token:session.csrf},201,{'Set-Cookie':cookieForSession(session.cookie)});
  }
  bad('接口不存在','NOT_FOUND',404);
}
async function visibleDocument(db,id,p,allowedLifecycle='active'){
  return dbFirst(db,`SELECT d.* FROM documents d WHERE d.id=? AND d.lifecycle=? AND
    (d.owner_id=? OR (d.household_id=? AND d.visibility='shared'))`,id,allowedLifecycle,p.user_id,p.household_id);
}
async function manageableDocument(db,id,p,lifecycle='active'){
  const doc=await dbFirst(db,`SELECT d.* FROM documents d WHERE d.id=? AND d.lifecycle=?
    AND (d.owner_id=? OR (d.household_id=? AND d.visibility='shared'))`,
    id,lifecycle,p.user_id,p.household_id);
  if(!doc)bad('文书不存在或没有操作权限','NOT_FOUND',404);
  return doc;
}
async function ownedDocument(db,id,p,lifecycle=null){
  const doc=await dbFirst(db,`SELECT * FROM documents WHERE id=? AND owner_id=? ${lifecycle?`AND lifecycle='${lifecycle}'`:''}`,id,p.user_id);
  if(!doc)bad('文书不存在或没有操作权限','NOT_FOUND',404);
  return doc;
}
function listShape(d){return {id:d.id,category:d.category,title:d.title,visibility:d.visibility,analysis_status:d.analysis_status,review_status:d.review_status,lifecycle:d.lifecycle,created_at:d.created_at,updated_at:d.updated_at,version:d.version,favorite:!!d.favorite,archived_at:d.archived_at||null,tags:JSON.parse(d.tags_json||'[]')};}
async function analyzeStored(env,doc,force=false){
  if(doc.analysis_status==='needs_review' && !force)return {cached:true};
  if(doc.import_mode==='analyze_only')bad('仅分析内容不长期保存');
  // This is the final guard across ALL callers, not just the source-text editor.
  // Never regenerate a candidate/idempotency key after any remote attempt.
  const emitted=await dbFirst(env.DB,`SELECT COUNT(*) count FROM integration_links
    WHERE candidate_id IN (SELECT id FROM action_candidates WHERE document_id=?)
      AND attempt_count>0`,doc.id);
  if(Number(emitted?.count||0)>0)
    bad('已尝试过跨应用联动，重新解析会更换候选幂等键；请保留已同步记录','INTEGRATION_HISTORY_LOCKED',409);
  if(!doc.extracted_text_ja)bad('尚无可处理的日文文字。图片 OCR 未接入，请先粘贴文字','OCR_NOT_READY',422);
  const oldCount=await dbFirst(env.DB,`SELECT COUNT(*) count FROM document_fields WHERE document_id=? AND review_state!='unreviewed'`,doc.id);
  if(oldCount?.count>0)bad('已存在人工审核字段，不能直接覆盖','REVIEW_LOCKED',409);
  const result=parseJapaneseText(doc.extracted_text_ja);
  const now=isoNow();
  const stmts=[
    ['DELETE FROM integration_links WHERE candidate_id IN (SELECT id FROM action_candidates WHERE document_id=?)',doc.id],
    ['DELETE FROM action_candidates WHERE document_id=?',doc.id],
    ['DELETE FROM document_fields WHERE document_id=?',doc.id],
    ['UPDATE documents SET category=?,summary_zh=?,explanation_zh=?,analysis_status=?,extraction_version=?,source_document_date=?,source_date_quote=?,updated_at=?,version=version+1 WHERE id=?',result.category,result.summary_zh,result.explanation_zh,result.analysis_status,'rules-v2',result.policyVersion.source_document_date,result.policyVersion.source_date_quote,now,doc.id]
  ];
  for(const f of result.fields){stmts.push(['INSERT INTO document_fields(id,document_id,field_key,normalized_value,value_type,original_currency,source_quote,review_state,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',randomToken(16),doc.id,f.field_key,f.normalized_value,f.value_type,f.original_currency||null,f.source_quote,f.review_state,now]);}
  const amount=result.fields.find(f=>f.field_key==='net_salary'||f.field_key==='amount_jpy');
  if(amount && !['bank','topup','travel','hotel','shopping','delivery','medical','policy','terms','manual','campaign'].includes(result.category)){
    const merchant=result.fields.find(f=>f.field_key==='merchant');
    const kind=result.category==='salary'?'income':inferSbiInvestmentKind(merchant?.normalized_value)?'transfer':'expense';
    const stamp=result.fields.find(f=>['transaction_at','transaction_date'].includes(f.field_key));
    const note=result.category==='card_spend'?'信用卡单笔消费通知，需核对卡片、交易状态及是否已记账':'必须人工确认实际到账/付款并防重';
    stmts.push(['INSERT INTO action_candidates(id,document_id,candidate_kind,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)',randomToken(16),doc.id,'finance',
      JSON.stringify({kind,amount_jpy:Number(amount.normalized_value),currency:'JPY',payment_confirmed:false,category:result.category,
        transaction_date:stamp?.normalized_value?.slice(0,10)||null,
        transaction_at:stamp?.value_type==='datetime'?stamp.normalized_value:null,
        payment_source_hint:result.category==='card_spend'&&/Olive/i.test(doc.extracted_text_ja.normalize('NFKC'))?'Olive':null,
        merchant:merchant?.normalized_value||null,note}),now,now]);
  }
  const due=result.fields.find(f=>f.field_key==='due_date'&&!f.source_quote?.startsWith('年份自动补全'));
  const deliveryTask=deliveryTaskSuggestion(result,doc.extracted_text_ja,{visibility:doc.visibility});
  if(deliveryTask){stmts.push(['INSERT INTO action_candidates(id,document_id,candidate_kind,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)',randomToken(16),doc.id,'homeflow_task',JSON.stringify(deliveryTask),now,now]);}
  else if(due){stmts.push(['INSERT INTO action_candidates(id,document_id,candidate_kind,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)',randomToken(16),doc.id,'homeflow_task',JSON.stringify({title:`确认：${doc.title.slice(0,40)}`,due_on:due.normalized_value,visibility:doc.visibility,requires_confirmation:true}),now,now]);}
  for(const v of result.vocabulary){stmts.push(['INSERT INTO action_candidates(id,document_id,candidate_kind,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)',randomToken(16),doc.id,'vocabulary',JSON.stringify({term:v.term,reading:v.reading,meaning_zh:v.meaning_zh,language:'ja',source:'rules-v1',requires_privacy_review:true}),now,now]);}
  await batch(env.DB,stmts);
  return {cached:false,result};
}
async function analyzeIfEnabled(env,doc,ctx){
  try{
    const result=await enqueueDocumentAi(env,doc);
    if(result.ai_status==='queued'&&ctx?.waitUntil)ctx.waitUntil(processDocumentAiJob(env,doc.id));
    return result;
  }catch{return {ai_status:'failed_safe'};}
}
function verifyDocumentAiChoice(provider,geminiConsent){
  // Backwards-compatible API: legacy clients without AI field remain rules-only.
  const selected=provider===null||provider===undefined?'none':provider;
  if(!['none','cloudflare','gemini'].includes(selected))bad('请为本份文书选择 AI 引擎或仅规则分析','INVALID_AI_PROVIDER',400);
  if(selected==='gemini'&&geminiConsent!==true)bad('请确认本份文书允许发送至 Gemini','AI_PRIVACY_CONFIRM_REQUIRED',400);
  return selected;
}
async function handleImportText(request,env,p,ctx){
  const data=await readJson(request);
  const provider=verifyDocumentAiChoice(data.ai_provider,data.gemini_consent);
  if(!validString(data?.text,100000)||!['text','mail_forward','gmail','google_drive','local_file'].includes(data.source_type)||!['analyze_only','summary'].includes(data.retention))bad('文字、来源或保存方式无效');
  if(data.visibility && !['private','shared'].includes(data.visibility))bad('可见范围无效');
  const raw=data.text.trim(),parsed=parseJapaneseText(raw);
  if(data.retention==='analyze_only')return json({ok:true,saved:false,analysis:parsed});
  const sha=await hashString(raw), now=isoNow();
  const previous=await dbFirst(env.DB,`SELECT id FROM documents WHERE owner_id=? AND content_sha256=? AND lifecycle='active'`,p.user_id,sha);
  if(previous)return json({ok:true,reused:true,document_id:previous.id});
  const id=randomToken(16),title=(String(data.title||'').trim()||raw.split(/\r?\n/)[0].slice(0,60)||'未命名文书').slice(0,200);
  // Default private even when shared is requested for sensitive documents.
  const sensitive=requiresPrivateDefault(parsed.category,raw);
  const visibility=(data.visibility==='shared'&&!sensitive)?'shared':'private';
  await batch(env.DB,[
    ['INSERT INTO documents(id,owner_id,household_id,visibility,category,title,extracted_text_ja,import_mode,content_sha256,analysis_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id,p.user_id,p.household_id,visibility,parsed.category,title,raw,'summary',sha,'draft',now,now],
    ['INSERT INTO document_sources(id,document_id,source_type,content_sha256,created_at) VALUES(?,?,?,?,?)',randomToken(16),id,data.source_type,sha,now],
    ['UPDATE documents SET ai_provider=?,ai_consent_at=? WHERE id=?',provider,provider==='gemini'?now:null,id]
  ]);
  const doc=await ownedDocument(env.DB,id,p);
  await analyzeStored(env,doc);
  const ai=await analyzeIfEnabled(env,await ownedDocument(env.DB,id,p,'active'),ctx);
  return json({ok:true,saved:true,reused:false,document_id:id,ai_status:ai.ai_status},201);
}
function fileSignature(mime,bytes){
  if(mime==='image/jpeg')return bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff;
  if(mime==='image/png')return bytes.slice(0,8).every((b,i)=>b===[137,80,78,71,13,10,26,10][i]);
  if(mime==='image/webp')return new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&new TextDecoder().decode(bytes.slice(8,12))==='WEBP';
  if(mime==='application/pdf')return new TextDecoder().decode(bytes.slice(0,5))==='%PDF-';
  if(mime==='application/vnd.openxmlformats-officedocument.wordprocessingml.document'||mime==='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'||mime==='application/vnd.openxmlformats-officedocument.presentationml.presentation'){
    if(bytes[0]!==80||bytes[1]!==75||bytes[2]!==3||bytes[3]!==4)return false;
    return true; // Validate ZIP directory, XML and CRC before R2 PUT.
  }
  return false;
}
async function handleFileImport(request,env,p,ctx){
  requireBinding(env,'DOCUMENTS');
  const len=Number(request.headers.get('Content-Length')||0);
  if(len>MAX_FILE_BYTES+10000)bad('文件超出 8MB 限制','FILE_TOO_LARGE',413);
  const form=await request.formData(),file=form.get('file');
  const provider=verifyDocumentAiChoice(form.get('ai_provider'),form.get('gemini_consent')==='true');
  if(!file||typeof file.arrayBuffer!=='function'||file.size<=0||file.size>MAX_FILE_BYTES)bad('请选择不超过 8MB 的文件');
  if(form.get('retention')!=='original')bad('文件上传仅支持明确选择保存原件，普通分析请粘贴可复制文字');
  const ext=String(file.name||'').toLowerCase();
  const docx='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const xlsx='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const pptx='application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const declared=String(file.type||'').toLowerCase();
  const mime=declared || (ext.endsWith('.docx')?docx:ext.endsWith('.xlsx')?xlsx:ext.endsWith('.pptx')?pptx:'');
  if(!['image/jpeg','image/png','image/webp','application/pdf',docx,xlsx,pptx].includes(mime))bad('仅支持 JPEG/PNG/WebP/PDF/DOCX/XLSX/PPTX');
  if((mime===docx&&!ext.endsWith('.docx'))||(mime===xlsx&&!ext.endsWith('.xlsx'))||(mime===pptx&&!ext.endsWith('.pptx')))bad('Office 文件名与格式不一致','INVALID_FILE',415);
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(!fileSignature(mime,bytes))bad('文件内容与声明类型不一致','INVALID_FILE',415);
  if(mime===docx||mime===xlsx||mime===pptx){
    try{await validateOfficeBytes(bytes,mime);}catch{bad('Office 文件结构无效、含宏或文件已损坏，请重新导出为标准 DOCX/XLSX/PPTX','INVALID_OFFICE',415);}
  }
  const declaredSource=String(form.get('source_type')||'');
  if(declaredSource&&!['google_drive','local_file','image'].includes(declaredSource))
    bad('上传原件来源标记无效','INVALID_SOURCE',400);
  const sourceKind=declaredSource==='google_drive'?'google_drive':mime.startsWith('image/')?'image':'local_file';
  const extractedValue=form.get('extracted_text');
  if(extractedValue!==null&&(typeof extractedValue!=='string'||extractedValue.length>100000))bad('提取文字无效','INVALID_TEXT',413);
  const extracted=typeof extractedValue==='string'?extractedValue.trim():'';
  const sha=await hashStringBytes(bytes),now=isoNow();
  const existingDoc=await dbFirst(env.DB,`SELECT id FROM documents WHERE owner_id=? AND content_sha256=? AND lifecycle='active'`,p.user_id,sha);
  if(existingDoc){
    // Explicit reupload provides SHA-verified bytes; D1 alone is not proof of R2 storage.
    const previous=await dbFirst(env.DB,`SELECT o.object_key,o.state FROM attachments a
      JOIN storage_objects o ON o.id=a.object_id
      WHERE a.document_id=? AND a.state='active' AND o.owner_id=?
        AND o.sha256=? AND o.mime=? ORDER BY a.sort_order LIMIT 1`,
      existingDoc.id,p.user_id,sha,mime);
    if(!previous||previous.state!=='ready')
      bad('文书已存在，但原件引用已删除或正在清理；请进入文书重新添加附件','ORIGINAL_RELINK_REQUIRED',409);
    try{
      if(!(await env.DOCUMENTS.head(previous.object_key)))
        await env.DOCUMENTS.put(previous.object_key,bytes,{httpMetadata:{contentType:mime}});
    }catch{bad('R2 原件缺失且补传失败，未确认重复文件成功','R2_REPAIR_FAILED',503);}
    return json({ok:true,reused:true,document_id:existingDoc.id});
  }
  const quality='web-upload-v1',existingObj=await dbFirst(env.DB,`SELECT * FROM storage_objects WHERE owner_id=? AND sha256=? AND mime=? AND quality_profile=? AND state='ready'`,p.user_id,sha,mime,quality);
  const id=randomToken(16),oid=existingObj?.id||randomToken(16),key=existingObj?.object_key||`${p.user_id}/${randomToken(20)}`;
  const label=String(file.name||'文书原件').replace(/[\x00-\x1f]/g,'').slice(0,150);
  if(existingObj){
    // A ready row can outlive its object after partial failure: repair exact key.
    try{
      if(!(await env.DOCUMENTS.head(key)))
        await env.DOCUMENTS.put(key,bytes,{httpMetadata:{contentType:mime}});
    }catch{bad('历史原件缺失且 R2 补传失败，未建立新文书引用','R2_REPAIR_FAILED',503);}
  }
  if(!existingObj){
    await dbRun(env.DB,'INSERT INTO storage_objects(id,owner_id,bucket,object_key,sha256,bytes,mime,quality_profile,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',oid,p.user_id,env.R2_BUCKET_NAME||'private',key,sha,bytes.length,mime,quality,'uploading',now,now);
    try{await env.DOCUMENTS.put(key,bytes,{httpMetadata:{contentType:mime}});await dbRun(env.DB,"UPDATE storage_objects SET state='ready',updated_at=? WHERE id=?",isoNow(),oid);}
    catch(err){await dbRun(env.DB,"UPDATE storage_objects SET state='delete_failed',updated_at=? WHERE id=?",isoNow(),oid);bad('文件存储失败，请稍后重试','UPLOAD_FAILED',503);}
  }
  try{await batch(env.DB,[
    ['INSERT INTO documents(id,owner_id,household_id,visibility,category,title,extracted_text_ja,import_mode,content_sha256,analysis_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id,p.user_id,p.household_id,'private','other',label,extracted||null,'original',sha,extracted?'draft':'needs_review',now,now],
    ['INSERT INTO document_sources(id,document_id,source_type,content_sha256,created_at) VALUES(?,?,?,?,?)',randomToken(16),id,sourceKind,sha,now],
    ['INSERT INTO attachments(id,document_id,object_id,file_label,sort_order,sha256,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',randomToken(16),id,oid,label,0,sha,now,now],
    ['UPDATE documents SET ai_provider=?,ai_consent_at=? WHERE id=?',provider,provider==='gemini'?now:null,id]
  ]);}catch{
    // If a transient D1 failure follows a successful PUT, storage_objects is retained for compensating cleanup.
    bad('已上传但保存索引失败，请联系管理员检查存储清理','METADATA_FAILED',503);
  }
  if(extracted)await analyzeStored(env,await ownedDocument(env.DB,id,p));
  const ai=extracted?await analyzeIfEnabled(env,await ownedDocument(env.DB,id,p,'active'),ctx):{ai_status:'awaiting_text'};
  return json({ok:true,saved:true,document_id:id,ai_status:ai.ai_status,text_layer_used:!!extracted,ocr_status:extracted?'text_extracted':'awaiting_text',
    message:extracted?'已使用文件文字层生成待核对字段':'没有可复制文字，需人工输入或手动 OCR'},201);
}
async function hashStringBytes(bytes){const digest=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');}
async function getDocDetail(db,doc){
  const fields=await dbAll(db,`SELECT id,field_key,raw_value,normalized_value,value_type,original_currency,source_quote,review_state,source_page FROM document_fields WHERE document_id=? ORDER BY field_key`,doc.id);
  const attachments=await dbAll(db,`SELECT a.id,a.file_label,a.page_no,a.state,o.mime FROM attachments a JOIN storage_objects o ON o.id=a.object_id WHERE a.document_id=? AND a.state='active' ORDER BY a.sort_order`,doc.id);
  return {...listShape(doc),ai_provider:doc.ai_provider||'none',ai_analysis:await getDocumentAiCache(db,doc),ai_job:await getDocumentAiJob(db,doc.id,doc),summary_zh:doc.summary_zh,explanation_zh:doc.explanation_zh,extracted_text_ja:doc.extracted_text_ja,import_mode:doc.import_mode,
     campaign_hints:doc.category==='campaign'?extractCampaignActionHints(doc.extracted_text_ja):[],
    source_document_date:doc.source_document_date||null,source_date_quote:doc.source_date_quote||null,
    official_current_verified_at:doc.official_current_verified_at||null,
    fields,attachments,confirmed_at:doc.confirmed_at};
}
async function handleList(env,p,url){
  const limit=Math.min(MAX_LIST,Math.max(1,Number(url.searchParams.get('limit')||5)||5));
  const offset=Math.max(0,Math.min(10000,Number(url.searchParams.get('offset')||0)||0));
  const filter=String(url.searchParams.get('category')||'').slice(0,30);
  const q=String(url.searchParams.get('q')||'').trim().slice(0,60);
  const visibility=url.searchParams.get('visibility')||'all';
  const archived=url.searchParams.get('archived')||'active';
  const favorite=url.searchParams.get('favorite')||'all';
  const month=url.searchParams.get('month')||'';
  let sql=`SELECT d.id,d.category,d.title,d.visibility,d.analysis_status, CASE WHEN NOT EXISTS(SELECT 1 FROM document_fields f WHERE f.document_id=d.id) THEN 'none'
WHEN NOT EXISTS(SELECT 1 FROM document_fields f WHERE f.document_id=d.id AND f.review_state='unreviewed') THEN 'reviewed'
WHEN EXISTS(SELECT 1 FROM document_fields f WHERE f.document_id=d.id AND f.review_state!='unreviewed') THEN 'partial'
ELSE 'unreviewed' END review_status,
d.lifecycle,d.created_at,d.updated_at,d.version,d.favorite,d.archived_at,d.tags_json
FROM documents d WHERE d.lifecycle='active' AND (d.owner_id=? OR (d.household_id=? AND d.visibility='shared'))`;
  const args=[p.user_id,p.household_id];
  if(filter){sql+=' AND d.category=?';args.push(filter);}
  if(visibility==='mine')sql+=' AND d.owner_id=?',args.push(p.user_id);
  if(visibility==='shared')sql+=" AND d.visibility='shared'";
  if(archived==='active')sql+=' AND d.archived_at IS NULL';
  if(archived==='archived')sql+=' AND d.archived_at IS NOT NULL';
  if(favorite==='yes')sql+=' AND d.favorite=1';
  if(/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))sql+=' AND substr(d.created_at,1,7)=?',args.push(month);
  if(q){sql+=` AND (d.title LIKE ? ESCAPE '\\' OR d.summary_zh LIKE ? ESCAPE '\\')`;const escaped=q.replace(/[\\%_]/g,'\\$&');args.push(`%${escaped}%`,`%${escaped}%`);}
  sql+=' ORDER BY d.created_at DESC,d.id DESC LIMIT ? OFFSET ?';args.push(limit+1,offset);
  const rows=await dbAll(env.DB,sql,...args);
  return json({items:rows.slice(0,limit).map(listShape),next_offset:rows.length>limit?offset+limit:null});
}
async function updateDoc(request,env,p,doc){
  // Shared documents are truly writable to either member. Only the original
  // owner can grant/revoke visibility, to avoid an editor silently exposing
  // the owner's private source or locking the owner out.
  const canManage=doc.owner_id===p.user_id ||
    (doc.household_id===p.household_id&&doc.visibility==='shared');
  if(!canManage)bad('文书不存在或没有操作权限','NOT_FOUND',404);
  const data=await readJson(request,10000);
  if(data.visibility!==undefined&&doc.owner_id!==p.user_id)
    bad('共享范围只能由原所有者修改','FORBIDDEN',403);
  if(data.category!==undefined&&doc.owner_id!==p.user_id&&
    requiresPrivateDefault(data.category,doc.extracted_text_ja))
    bad('涉及敏感分类的共享变更须由原所有者确认','SENSITIVE_CHANGE_OWNER_REQUIRED',403);
  const updates=[],values=[];
  for(const [key,max] of [['title',200],['category',40]]){
    if(data[key]!==undefined){if(!validString(data[key],max))bad(`${key} 无效`);updates.push(`${key}=?`);values.push(data[key].trim());}
  }
  if(data.favorite!==undefined){if(typeof data.favorite!=='boolean')bad('收藏值无效');updates.push('favorite=?');values.push(data.favorite?1:0);}
  if(data.archived!==undefined){if(typeof data.archived!=='boolean')bad('归档值无效');updates.push('archived_at=?');values.push(data.archived?isoNow():null);}
  if(data.tags!==undefined){if(!Array.isArray(data.tags)||data.tags.length>8||!data.tags.every(x=>typeof x==='string'&&x.length>0&&x.length<=32))bad('标签必须在 8 个以内且每项不超过 32 字');updates.push('tags_json=?');values.push(JSON.stringify([...new Set(data.tags)]));}
  if(data.visibility!==undefined){
    if(!['private','shared'].includes(data.visibility))bad('共享状态无效');
    if(data.visibility==='shared' && !data.confirm_sensitive_share)bad('共享前必须再次确认文件内容和隐私','SHARE_CONFIRM_REQUIRED',409);
    updates.push('visibility=?');values.push(data.visibility);
  }
  // A shared non-sensitive record must not remain shared merely because its
  // category is changed to medical, bank, salary or another sensitive type.
  // Re-sharing requires the explicit visibility='shared' confirmation path.
  if(data.category!==undefined && doc.visibility==='shared' && data.visibility===undefined &&
     requiresPrivateDefault(data.category,doc.extracted_text_ja)){
    updates.push('visibility=?');values.push('private');
  }
  if(!updates.length)bad('没有要修改的字段');
  if(!Number.isInteger(data.version)||data.version!==doc.version)bad('文书已被其他操作修改，请刷新','VERSION_CONFLICT',409);
  updates.push('updated_at=?','version=version+1');
  const at=isoNow();
  values.push(at,doc.id,p.user_id,p.household_id,doc.version);
  const output=await batch(env.DB,[
    [`UPDATE documents SET ${updates.join(',')}
      WHERE id=? AND (owner_id=? OR (household_id=? AND visibility='shared'))
      AND version=? AND lifecycle='active'`,...values],
    [`INSERT INTO audit_events(id,actor_user_id,kind,entity_type,entity_id,created_at)
      SELECT ?,?,?,'document',?,? WHERE changes()=1`,
      randomToken(16),p.user_id,'document_metadata_updated',doc.id,at]
  ]);
  if(output[0]?.meta?.changes!==1||output[1]?.meta?.changes!==1)
    bad('编辑冲突或已失去共享编辑权限','VERSION_CONFLICT',409);
  return json({ok:true});
}
async function updateField(request,env,p,fieldId){
  const field=await dbFirst(env.DB,`SELECT f.*,d.owner_id,d.household_id,d.visibility,d.lifecycle
    FROM document_fields f JOIN documents d ON d.id=f.document_id WHERE f.id=?`,fieldId);
  if(!field||field.lifecycle!=='active'||!(
    field.owner_id===p.user_id ||
    (field.household_id===p.household_id&&field.visibility==='shared')
  ))bad('字段不存在','NOT_FOUND',404);
  const data=await readJson(request,6000);
  if(!['confirmed','corrected','rejected'].includes(data.review_state))bad('审核状态无效');
  const normalized=String(data.normalized_value ?? field.normalized_value ?? '').trim();
  if(normalized.length>400)bad('值超出长度');
  if(fieldsOf.includes(field.field_key)&&data.review_state!=='rejected'){
    if(field.value_type==='money'&&!/^[1-9]\d{0,11}$/.test(normalized))bad('金额必须是正整数日元');
    if(field.value_type==='date'&&!validCivilDate(normalized))bad('请输入真实存在的日期');
  }
  let remoteLinks=[];
  if(normalized!==String(field.normalized_value??'') && fieldsOf.includes(field.field_key)){
    const target=['due_date','event_date'].includes(field.field_key)?'homeflow':'kakebo';
    remoteLinks=await dbAll(env.DB,`SELECT l.remote_id,l.target FROM integration_links l
      JOIN action_candidates c ON c.id=l.candidate_id
      WHERE c.document_id=? AND l.target=? AND l.state IN ('synced','linked_existing')`,field.document_id,target);
    if(remoteLinks.length && data.confirm_remote_unchanged!==true)
      bad('该字段已联动至其他 App；修改这里不会自动改动远端记录。请确认后再保存，并到目标 App 核对。','REMOTE_RECORD_UNCHANGED',409);
  }
  const now=isoNow();
  // The same SQL statement rechecks edit authority; do not trust a prior
  // document-detail read if visibility was revoked on another device.
  const output=await batch(env.DB,[
    [`UPDATE document_fields SET normalized_value=?,review_state=?,
      reviewed_by=?,updated_at=?
      WHERE id=? AND document_id=? AND EXISTS(
        SELECT 1 FROM documents d WHERE d.id=document_fields.document_id
        AND d.lifecycle='active'
        AND (d.owner_id=? OR (d.household_id=? AND d.visibility='shared')))`,
      normalized,data.review_state,p.user_id,now,fieldId,field.document_id,
      p.user_id,p.household_id],
    [`UPDATE documents SET updated_at=?,version=version+1
      WHERE id=? AND lifecycle='active' AND changes()=1`,now,field.document_id],
    [`INSERT INTO audit_events(id,actor_user_id,kind,entity_type,entity_id,created_at)
      SELECT ?,?,?,'document_field',?,? WHERE changes()=1`,
      randomToken(16),p.user_id,'field_reviewed',fieldId,now]
  ]);
  if(output.some(x=>x.meta?.changes!==1))
    bad('共享权限已经变化，请刷新','VERSION_CONFLICT',409);
  return json({ok:true,linked_records_unchanged:remoteLinks.length>0,linked_targets:[...new Set(remoteLinks.map(x=>x.target))]});
}
async function candidatesForDoc(env,p,id){
  const doc=await visibleDocument(env.DB,id,p);
  if(!doc)bad('文书不存在','NOT_FOUND',404);
  // Sharing a source document does NOT share the owner's private target
  // accounts, approval candidates, remote ledger IDs or sync history.
  // The collaborator may edit the shared document, but must create any
  // personal target intent from their OWN verified account after approval
  // workflow support is available. Avoid even loading these private rows.
  if(doc.owner_id!==p.user_id)
    return json({items:[],shared_document:true,integration_access:false});
  const rows=await dbAll(env.DB,`SELECT c.id,c.candidate_kind,c.payload_json,c.state,
    i.state integration_state,i.target,i.remote_id FROM action_candidates c
    LEFT JOIN integration_links i ON i.candidate_id=c.id WHERE c.document_id=? ORDER BY c.created_at ASC`,id);
  return json({items:rows.map(({payload_json,...x})=>({...x,payload:JSON.parse(payload_json)}))});
}
async function moveToTrash(env,p,id){
  const doc=await manageableDocument(env.DB,id,p,'active');
  const now=isoNow();
  const output=await batch(env.DB,[
    [`UPDATE documents SET lifecycle='trashed',trashed_at=?,trashed_by=?,
      updated_at=?,version=version+1
      WHERE id=? AND lifecycle='active' AND
      (owner_id=? OR (household_id=? AND visibility='shared'))`,
      now,p.user_id,now,id,p.user_id,p.household_id],
    [`INSERT INTO audit_events(id,actor_user_id,kind,entity_type,entity_id,created_at)
      SELECT ?,?,?,'document',?,? WHERE changes()=1`,
      randomToken(16),p.user_id,'document_trashed',id,now]
  ]);
  if(output.some(x=>x.meta?.changes!==1))
    bad('共享权限已经变化，请刷新','VERSION_CONFLICT',409);
  return json({ok:true,document_id:id,r2_deleted:false,message:'已移入回收站，R2 原件仍保留以供恢复'});
}
async function restoreDoc(env,p,id){
  const doc=await manageableDocument(env.DB,id,p,'trashed');
  const refs=await dbAll(env.DB,`SELECT a.id,o.object_key FROM attachments a JOIN storage_objects o ON a.object_id=o.id WHERE a.document_id=? AND a.state='active'`,id);
  let missing=[];
  for(const ref of refs){if(!env.DOCUMENTS||!(await env.DOCUMENTS.head(ref.object_key)))missing.push(ref.id);}
  const at=isoNow();
  const output=await batch(env.DB,[
    [`UPDATE documents SET lifecycle='active',trashed_at=NULL,
      trashed_by=NULL,updated_at=?,version=version+1
      WHERE id=? AND lifecycle='trashed' AND
      (owner_id=? OR (household_id=? AND visibility='shared'))`,
      at,id,p.user_id,p.household_id],
    [`INSERT INTO audit_events(id,actor_user_id,kind,entity_type,entity_id,created_at)
      SELECT ?,?,?,'document',?,? WHERE changes()=1`,
      randomToken(16),p.user_id,'document_restored',id,at]
  ]);
  if(output.some(x=>x.meta?.changes!==1))
    bad('共享权限已经变化，请刷新','VERSION_CONFLICT',409);
  return json({ok:true,document_id:id,missing_attachments:missing,
    warning:missing.length?'部分原件缺失，已恢复摘要和可用记录':null});
}
async function permanentlyDelete(env,p,id){
  let doc=await dbFirst(env.DB,'SELECT * FROM documents WHERE id=? AND owner_id=?',id,p.user_id);
  if(!doc){
    const tomb=await dbFirst(env.DB,"SELECT id FROM deletion_tombstones WHERE owner_id=? AND target_type='document' AND target_id=?",p.user_id,id);
    if(tomb)return json({ok:true,already_deleted:true});
    bad('文书不存在或无权删除','NOT_FOUND',404);
  }
  if(!['trashed','deletion_pending'].includes(doc.lifecycle))bad('请先将文书移入回收站','TRASH_FIRST',409);
  if(doc.lifecycle!=='deletion_pending')await dbRun(env.DB,"UPDATE documents SET lifecycle='deletion_pending',deletion_started_at=?,updated_at=? WHERE id=?",isoNow(),isoNow(),id);
  const attachments=await dbAll(env.DB,'SELECT object_id FROM attachments WHERE document_id=? AND object_id IS NOT NULL',id);
  const ids=[...new Set(attachments.map(x=>x.object_id))];
  const clearObjects=[];
  for(const oid of ids){
    const obj=await dbFirst(env.DB,'SELECT * FROM storage_objects WHERE id=? AND owner_id=?',oid,p.user_id);
    if(!obj)continue;
    const elsewhere=await dbFirst(env.DB,`SELECT COUNT(*) count FROM attachments a JOIN documents d ON d.id=a.document_id
      WHERE a.object_id=? AND a.document_id!=?`,oid,id);
    if(elsewhere.count>0)continue;
    requireBinding(env,'DOCUMENTS');
    const now=isoNow();
    const claim=await dbRun(env.DB,`UPDATE storage_objects SET state='deletion_pending',updated_at=?
      WHERE id=? AND owner_id=? AND state IN ('ready','deletion_pending','delete_failed')
        AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.object_id=? AND a.document_id!=?)`,now,oid,p.user_id,oid,id);
    if(claim.meta?.changes!==1)continue; // another reference won the race
    await dbRun(env.DB,`INSERT INTO deletion_jobs(id,object_id,requested_by,state,created_at,updated_at) VALUES(?,?,?,'pending',?,?)
      ON CONFLICT(object_id) DO UPDATE SET state='pending',updated_at=excluded.updated_at`,randomToken(16),oid,p.user_id,now,now);
    try{await env.DOCUMENTS.delete(obj.object_key);}
    catch{
      await batch(env.DB,[
        ["UPDATE storage_objects SET state='delete_failed',updated_at=? WHERE id=?",isoNow(),oid],
        ["UPDATE deletion_jobs SET state='failed',attempt_count=attempt_count+1,last_error_code='R2_DELETE_FAILED',updated_at=? WHERE object_id=?",isoNow(),oid]
      ]);
      return failure('DELETE_RETRY_NEEDED','R2 清理失败，记录保持待清理，请在回收站重试',503);
    }
    clearObjects.push(oid);
  }
  const now=isoNow();
  const statements=[
    ['DELETE FROM integration_links WHERE candidate_id IN (SELECT id FROM action_candidates WHERE document_id=?)',id],
    ['DELETE FROM action_candidates WHERE document_id=?',id],
    ['DELETE FROM document_fields WHERE document_id=?',id],
    ['DELETE FROM attachments WHERE document_id=?',id],
    ['DELETE FROM document_sources WHERE document_id=?',id],
    ['DELETE FROM document_events WHERE document_id=?',id],
    ['DELETE FROM documents WHERE id=? AND owner_id=?',id,p.user_id]
  ];
  for(const oid of clearObjects){
    statements.push(['DELETE FROM deletion_jobs WHERE object_id=?',oid],['DELETE FROM storage_objects WHERE id=?',oid]);
  }
  statements.push(['INSERT OR IGNORE INTO deletion_tombstones(id,owner_id,request_key,target_type,target_id,deleted_at) VALUES(?,?,?,?,?,?)',randomToken(16),p.user_id,`doc:${id}`,'document',id,now]);
  try{await batch(env.DB,statements);}catch{
    return failure('METADATA_CLEANUP_FAILED','原件已清理，但数据库清理尚未完成，请重试',503);
  }
  // Two simultaneous deletions may both have observed the other's reference.
  // After this document's D1 references are gone, perform a narrowly scoped
  // conditional orphan claim; no R2 LIST/HEAD or duplicate object copy.
  let compensated=0,pending=false;
  const survivors=ids.filter(oid=>!clearObjects.includes(oid));
  for(let i=0;i<survivors.length;i+=5){
    try{
      const result=await cleanupOrphans(env,p,{onlyIds:survivors.slice(i,i+5)});
      const outcome=await result.json();
      compensated+=Number(outcome.removed||0);
      if(!outcome.ok)pending=true;
    }catch{pending=true;}
  }
  return json({ok:true,document_id:id,r2_deleted_objects:clearObjects.length+compensated,
    r2_cleanup_pending:pending,warning:pending?'文书已删除，但原件清理存在待补偿项，请从设置中重试文件清理':null});
}
async function contentForAttachment(env,p,id,aid){
  const doc=await visibleDocument(env.DB,id,p);if(!doc)bad('文书不存在','NOT_FOUND',404);
  const a=await dbFirst(env.DB,`SELECT o.object_key,o.mime FROM attachments a JOIN storage_objects o ON a.object_id=o.id
    WHERE a.id=? AND a.document_id=? AND a.state='active' AND o.state='ready'`,aid,id);
  if(!a)bad('原件不存在','NOT_FOUND',404);
  requireBinding(env,'DOCUMENTS');
  const result=await env.DOCUMENTS.get(a.object_key);
  if(!result)bad('R2 原件已缺失','ORIGINAL_MISSING',404);
  return new Response(result.body,{headers:{'Content-Type':a.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Content-Disposition':'inline'}});
}
async function route(request,env,ctx){
  const url=new URL(request.url),path=url.pathname,method=request.method;
  if(!path.startsWith('/api/'))return env.ASSETS?.fetch(request) || new Response('Not found',{status:404});
  const calendarToken=method==='GET'?path.match(/^\/api\/calendar\/([a-f0-9]{64})\.ics$/):null;
  if(calendarToken)return serveCalendar(request,env,calendarToken[1]);
  if(method==='GET'&&path==='/api/health')return json({ok:true,service:'document-assistant',ai_ocr:env.ENABLE_EXPERIMENTAL_OCR==='true'&&!!env.AI?'experimental':'disabled',version:'0.1.0'});
  if(method==='GET'&&path==='/api/auth/status'){
    requireBinding(env,'DB');
    const state=await dbFirst(env.DB,'SELECT COUNT(*) count FROM households');
    return json({ok:true,initialized:Number(state?.count||0)>0});
  }
  if(method==='POST'&&['/api/auth/bootstrap','/api/auth/login','/api/household/join'].includes(path))return handleAuth(request,env,url);
  if(path==='/api/homeflow-sso/status' && request.method==='GET')
    return new Response(JSON.stringify({enabled:homeflowSsoEnabled(env,url)}),
      {headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  if(path==='/api/homeflow-sso/start')return startHomeFlowSso(request,env,url);
  if(path==='/api/homeflow-sso/callback')return callbackHomeFlowSso(request,env,url);
  if(path==='/api/homeflow-sso/complete')return completeHomeFlowSso(request,env,url);
  // The callback deliberately needs no browser cookie: one-time state binds it to the PWA user.
  if(method==='GET'&&path==='/api/google/oauth/callback')return oauthCallback(request,env,url);
  const internalDocument=path.match(/^\/api\/internal\/document-actions\/(execute|receipt|source-check)$/);
  if(internalDocument)return documentExecutionRoute(request,env,internalDocument[1]);
   const internalTask=path.match(/^\/api\/internal\/document-task\/(prepare|receipt)$/);
   if(internalTask)return documentTaskSourceRoute(request,env,internalTask[1]);
  const p=await requireSession(request,env);
  if(!['GET','HEAD'].includes(method))requireMutation(request,p);
  if(method==='GET'&&path==='/api/integrations/kakeibo/stable-accounts')
    return listDocumentFinanceAccounts(env,p);
  if(path.startsWith('/api/google/oauth/')||path.startsWith('/api/google/drive/'))return handleBrowserGoogle(request,env,p,url);
  if(path.startsWith('/api/google/gmail/'))return handleGoogleGmail(request,env,p,path,url);
  if(method==='GET'&&path==='/api/calendar/status')return calendarStatus(env,p);
  if(method==='POST'&&path==='/api/calendar/subscription')return createCalendarSubscription(request,env,p);
  if(method==='POST'&&path==='/api/calendar/revoke')return revokeCalendarSubscription(env,p);
  if(method==='GET'&&path==='/api/me')return json({user:{id:p.user_id,household_id:p.household_id,email:p.email_norm,role:p.role,display_name:p.display_name},csrf_token:p.csrf});
  if(method==='GET'&&path==='/api/auth/sessions'){
    const offset=Math.max(0,Math.min(100,Number(url.searchParams.get('offset')||0)||0));
    const rows=await dbAll(env.DB,`SELECT id,created_at,expires_at FROM sessions
      WHERE user_id=? AND revoked_at IS NULL AND expires_at>?
      ORDER BY created_at DESC,id DESC LIMIT 6 OFFSET ?`,p.user_id,isoNow(),offset);
    return json({items:rows.slice(0,5).map(row=>({...row,is_current:row.id===p.session_id})),
      next_offset:rows.length>5?offset+5:null});
  }
  if(method==='POST'&&path==='/api/auth/sessions/revoke'){
    const data=await readJson(request,1200);
    if(typeof data.session_id!=='string'||!/^[a-f0-9]{32}$/i.test(data.session_id))
      bad('登录会话 ID 无效','INVALID_SESSION_ID',400);
    if(data.session_id===p.session_id)
      bad('当前设备请使用退出登录操作','USE_LOGOUT',409);
    const changed=await dbRun(env.DB,`UPDATE sessions SET revoked_at=?
      WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?`,
      isoNow(),data.session_id,p.user_id,isoNow());
    if(changed.meta?.changes!==1)bad('会话不存在或已失效','NOT_FOUND',404);
    return json({ok:true});
  }
  if(method==='POST'&&path==='/api/auth/sessions/revoke-others'){
    const result=await dbRun(env.DB,`UPDATE sessions SET revoked_at=?
      WHERE user_id=? AND id!=? AND revoked_at IS NULL AND expires_at>?`,
      isoNow(),p.user_id,p.session_id,isoNow());
    return json({ok:true,revoked_count:result.meta?.changes||0});
  }
  if(method==='POST'&&path==='/api/auth/logout'){
    const cookie=parseCookie(request,'__Host-da_session');
    await dbRun(env.DB,'UPDATE sessions SET revoked_at=? WHERE secret_hash=?',isoNow(),await hashString(cookie));
    return json({ok:true},200,{'Set-Cookie':clearingCookie()});
  }
  if(method==='POST'&&path==='/api/auth/change-password'){
    const data=await readJson(request,6000);
    if(!validatePassword(data.new_password))bad('新密码必须是12～128位','INVALID_PASSWORD',400);
    if(typeof data.current_password!=='string')bad('请输入当前密码','INVALID_PASSWORD',400);
    const identity=await hashString('password-change:'+p.user_id);
    const throttle=await dbFirst(env.DB,'SELECT blocked_until FROM auth_throttle WHERE identity_hash=?',identity);
    if(throttle?.blocked_until&&throttle.blocked_until>isoNow())
      bad('密码核验次数过多，请稍后再试','RATE_LIMITED',429);
    const stored=await dbFirst(env.DB,'SELECT password_salt,password_hash,iterations FROM password_credentials WHERE user_id=?',p.user_id);
    if(!stored||!(await checkPassword(data.current_password,stored))){
      await recordThrottle(env,identity,true);
      bad('当前密码不正确','INVALID_CREDENTIALS',401);
    }
    if(await checkPassword(data.new_password,stored))bad('新密码不能与旧密码相同','PASSWORD_REUSED',409);
    const credentials=await newCredential(data.new_password),now=isoNow();
    await batch(env.DB,[
      ['UPDATE password_credentials SET password_salt=?,password_hash=?,iterations=?,updated_at=? WHERE user_id=?',
        credentials.password_salt,credentials.password_hash,credentials.iterations,now,p.user_id],
      ['UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL',now,p.user_id]
    ]);
    await recordThrottle(env,identity,false);
    return json({ok:true,reauth_required:true},200,{'Set-Cookie':clearingCookie()});
  }
  if(method==='POST'&&path==='/api/household/invites'){
    if(p.role!=='owner')bad('仅家庭管理员可以邀请','FORBIDDEN',403);
    const data=await readJson(request,5000),email=normalizedEmail(data.invitee_email);
    if(!email)bad('请输入有效邮箱');
    const members=await dbFirst(env.DB,"SELECT COUNT(*) count FROM users WHERE household_id=? AND status!='left'",p.household_id);
    if(members.count>=2)bad('家庭成员已满','HOUSEHOLD_FULL',409);
    const token=randomToken(24),now=isoNow();
    await dbRun(env.DB,'INSERT INTO household_invites(id,household_id,inviter_user_id,invitee_email_norm,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?)',randomToken(16),p.household_id,p.user_id,email,await hashString(token),new Date(Date.now()+48*3600000).toISOString(),now);
    // Invite delivered to owner manually; never log/send to third parties.
    return json({ok:true,invite_token:token,expires_in_hours:48},201);
  }
  if(method==='GET'&&path==='/api/integrations/status')return getBridgeStatus(env,p);
  if(method==='GET'&&path==='/api/connections'){
    const rows=await dbAll(env.DB,'SELECT id,provider,status,created_at,updated_at FROM external_connections WHERE user_id=?',p.user_id);
    return json({connections:rows,bridge_status:'not_configured'});
  }
  if(method==='POST'&&path==='/api/imports/plan'){
    const d=await readJson(request,10000);
    const fileSize=Number(d.file_size);
    if(!Number.isSafeInteger(fileSize)||fileSize<0)bad('文件大小无效');
    const mime=String(d.mime||'');
    const supported=['text/plain','image/jpeg','image/png','image/webp','application/pdf'].includes(mime);
    return json({accepted:supported&&fileSize<=MAX_FILE_BYTES,needs_ocr:mime.startsWith('image/')||mime==='application/pdf',estimated_upload_bytes:d.retention==='original'?fileSize:0,warnings:[...(supported?[]:['格式尚不支持']),...(fileSize>MAX_FILE_BYTES?['超过 8 MB']:[]),...(mime.startsWith('image/')||mime==='application/pdf'?['OCR 尚未通过实测，请使用可复制文字或人工输入']:[])]});
  }
  if(method==='POST'&&path==='/api/documents/import/text')return handleImportText(request,env,p,ctx);
  if(method==='POST'&&path==='/api/documents/import/file')return handleFileImport(request,env,p,ctx);
  if(method==='POST'&&path==='/api/ocr-space/preview')return ocrSpaceImportPreview(request,env,p);
  if(method==='POST'&&path==='/api/workers-ai-ocr/preview')return workersAiImportPreview(request,env,p);
  // OCR is opt-in, quota-limited and NEVER silently approves extracted values.

  if(method==='GET'&&path==='/api/documents')return handleList(env,p,url);
  if(method==='GET'&&path==='/api/today'){
    const limit=Math.min(10,Math.max(1,Number(url.searchParams.get('limit')||5)||5));
    const offset=Math.max(0,Math.min(10000,Number(url.searchParams.get('offset')||0)||0));
    const rows=await dbAll(env.DB,`SELECT d.id,d.title,d.category,d.analysis_status,d.visibility,d.created_at,
      CASE WHEN NOT EXISTS(SELECT 1 FROM document_fields f WHERE f.document_id=d.id) THEN 'none'
WHEN NOT EXISTS(SELECT 1 FROM document_fields f WHERE f.document_id=d.id AND f.review_state='unreviewed') THEN 'reviewed'
WHEN EXISTS(SELECT 1 FROM document_fields f WHERE f.document_id=d.id AND f.review_state!='unreviewed') THEN 'partial'
ELSE 'unreviewed' END review_status,
      (SELECT f.normalized_value FROM document_fields f WHERE f.document_id=d.id AND f.field_key='due_date' LIMIT 1) due_date,
      (SELECT f.normalized_value FROM document_fields f
        WHERE f.document_id=d.id AND f.field_key IN ('transaction_at','transaction_date')
          AND f.review_state IN ('confirmed','corrected')
        ORDER BY CASE f.field_key WHEN 'transaction_at' THEN 0 ELSE 1 END LIMIT 1) verified_transaction_at
      FROM documents d WHERE d.lifecycle='active' AND d.archived_at IS NULL AND (d.owner_id=? OR (d.household_id=? AND d.visibility='shared'))
      AND (d.analysis_status='needs_review' OR EXISTS(SELECT 1 FROM document_fields f WHERE f.document_id=d.id AND f.field_key='due_date'))
      ORDER BY CASE WHEN due_date IS NULL THEN 1 ELSE 0 END,due_date ASC,d.created_at DESC LIMIT ? OFFSET ?`,p.user_id,p.household_id,limit+1,offset);
    return json({items:rows.slice(0,limit),next_offset:rows.length>limit?offset+limit:null});
  }
  if(method==='GET'&&path==='/api/integrations'){
    const limit=5,offset=Math.max(0,Math.min(10000,Number(url.searchParams.get('offset')||0)||0));
    const rows=await dbAll(env.DB,`SELECT c.id,c.candidate_kind,c.state,c.payload_json,d.id document_id,d.title,
      i.state integration_state,i.remote_id FROM action_candidates c JOIN documents d ON d.id=c.document_id
      LEFT JOIN integration_links i ON i.candidate_id=c.id
      WHERE d.owner_id=? AND d.lifecycle='active' ORDER BY c.created_at DESC LIMIT ? OFFSET ?`,p.user_id,limit+1,offset);
    return json({items:rows.slice(0,limit).map(({payload_json,...x})=>({...x,payload:JSON.parse(payload_json)})),next_offset:rows.length>limit?offset+limit:null});
  }

  if(method==='GET'&&path==='/api/recycle'){
    const limit=Math.min(10,Math.max(1,Number(url.searchParams.get('limit')||5)||5));
    const offset=Math.max(0,Math.min(10000,Number(url.searchParams.get('offset')||0)||0));
    const month=url.searchParams.get('month')||'';
    const args=[p.user_id];let sql="SELECT id,title,category,trashed_at,lifecycle,created_at FROM documents WHERE owner_id=? AND lifecycle IN ('trashed','deletion_pending')";
    if(/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)){sql+=' AND substr(trashed_at,1,7)=?';args.push(month);}
    sql+=' ORDER BY trashed_at DESC,id DESC LIMIT ? OFFSET ?';args.push(limit+1,offset);
    const rows=await dbAll(env.DB,sql,...args);
    return json({items:rows.slice(0,limit),next_offset:rows.length>limit?offset+limit:null});
  }
  if(method==='GET'&&path==='/api/recycle/attachments'){
    const offset=Math.max(0,Math.min(10000,Number(url.searchParams.get('offset')||0)||0));
    const rows=await dbAll(env.DB,"SELECT a.id,a.document_id,a.file_label,a.trashed_at,a.state,d.title FROM attachments a JOIN documents d ON d.id=a.document_id WHERE d.owner_id=? AND a.state IN ('trashed','deletion_pending') ORDER BY a.trashed_at DESC LIMIT 6 OFFSET ?",p.user_id,offset);
    return json({items:rows.slice(0,5),next_offset:rows.length>5?offset+5:null});
  }
  if(method==='POST'&&path==='/api/recycle/empty'){
    const data=await readJson(request,5000);
    if(data.confirm!=='DELETE_FOREVER')bad('需要确认永久清空回收站','CONFIRM_REQUIRED',409);
    // Each request is deliberately bounded to protect the Worker subrequest
    // budget. The client repeats until has_more=false, without deleting live
    // documents or another user's items.
    const documents=await dbAll(env.DB,`SELECT id FROM documents WHERE owner_id=?
      AND lifecycle IN ('trashed','deletion_pending')
      ORDER BY trashed_at ASC,id ASC LIMIT 5`,p.user_id);
    const attachments=await dbAll(env.DB,`SELECT a.id,a.document_id FROM attachments a
      JOIN documents d ON d.id=a.document_id
      WHERE d.owner_id=? AND d.lifecycle='active'
        AND a.state IN ('trashed','deletion_pending')
      ORDER BY a.trashed_at ASC,a.id ASC LIMIT 5`,p.user_id);
    let processed_documents=0,processed_attachments=0;
    const failed=[];
    for(const document of documents){
      try{
        const result=await permanentlyDelete(env,p,document.id);
        if(result.ok)processed_documents++;
        else failed.push({type:'document',id:document.id});
      }catch{failed.push({type:'document',id:document.id});}
    }
    for(const attachment of attachments){
      try{
        const result=await attachmentDelete(env,p,attachment.document_id,attachment.id);
        if(result.ok)processed_attachments++;
        else failed.push({type:'attachment',id:attachment.id});
      }catch{failed.push({type:'attachment',id:attachment.id});}
    }
    // The remaining count also handles a batch of exactly five; the UI never
    // guesses that the bin is empty or hides an R2 clean-up failure.
    const [remainingDocs,remainingAttachments]=await Promise.all([
      dbFirst(env.DB,`SELECT COUNT(*) count FROM documents WHERE owner_id=?
        AND lifecycle IN ('trashed','deletion_pending')`,p.user_id),
      dbFirst(env.DB,`SELECT COUNT(*) count FROM attachments a
        JOIN documents d ON d.id=a.document_id
        WHERE d.owner_id=? AND d.lifecycle='active'
          AND a.state IN ('trashed','deletion_pending')`,p.user_id)
    ]);
    const remaining=Number(remainingDocs?.count||0)+Number(remainingAttachments?.count||0);
    return json({ok:failed.length===0,processed:processed_documents+processed_attachments,
      processed_documents,processed_attachments,failed,remaining,has_more:remaining>0});
  }
  if(method==='POST'&&path==='/api/backups/plan')return planBackup(request,env,p);
  if(method==='GET'&&path==='/api/backups/export')return exportBackup(env,p,url);
  if(method==='POST'&&path==='/api/backups/import-preview')return previewImport(request,env,p);
  if(method==='POST'&&path==='/api/backups/import-confirm')return confirmImport(request,env,p);
  if(method==='POST'&&path==='/api/storage/cleanup-orphans')return cleanupOrphans(env,p);
  if(method==='GET'&&path==='/api/usage'){
    const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const usage=await dbFirst(env.DB,'SELECT ai_calls,imported_files FROM usage_daily WHERE user_id=? AND local_day=?',p.user_id,day);
    const dayUtc=new Date().toISOString().slice(0,10);
    const summary=await dbFirst(env.DB,'SELECT calls,reserved FROM ocr_app_utc_daily WHERE day_utc=?',dayUtc);
    const rawLimit=Number(env.OCR_APP_UTC_DAILY_LIMIT??5);
    const appLimit=Number.isSafeInteger(rawLimit)?Math.min(5,Math.max(0,rawLimit)):0;
    const ocrSpaceUsage=await dbFirst(env.DB,'SELECT calls FROM ocr_space_utc_daily WHERE day_utc=?',dayUtc);
    const spaceN=Number(env.OCR_SPACE_APP_UTC_DAILY_LIMIT??20);
    const spaceLimit=Number.isSafeInteger(spaceN)?Math.max(0,Math.min(30,spaceN)):0;
    const aiUsage=await dbFirst(env.DB,'SELECT calls FROM ai_analysis_daily WHERE day_utc=?',dayUtc);
    const analysisLimitRaw=Number(env.AI_ANALYSIS_DAILY_LIMIT??2);
    const analysisLimit=Number.isSafeInteger(analysisLimitRaw)?Math.max(0,Math.min(5,analysisLimitRaw)):0;
    const [geminiUsage,translationUsage]=await Promise.all([geminiQuotaUsage(env.DB),documentTranslationBudgetUsage(env.DB).catch(()=>null)]);
    return json({local_today:usage||{ai_calls:0,imported_files:0},
      app_utc_day:{day_utc:dayUtc,calls:summary?.calls||0,reserved:summary?.reserved||0,limit:appLimit},
      document_ai_utc_day:{day_utc:dayUtc,calls:aiUsage?.calls||0,limit:analysisLimit},
      gemini_daily:geminiUsage,
      translation_jst_day:translationUsage,
      ocr_space_utc_day:{day_utc:dayUtc,calls:ocrSpaceUsage?.calls||0,limit:spaceLimit},
      cloudflare_account_remaining:null,cloudflare_account_remaining_status:'unknown',
      note:'文书助手内的用量，不含 Google 项目的其他 API 调用'});
  }
  const exportOriginal=path.match(/^\/api\/backups\/original\/([a-f0-9]{32})\/([a-f0-9]{32})$/i);
  if(method==='GET'&&exportOriginal)return backupOriginal(env,p,exportOriginal[1],exportOriginal[2]);
  const match=path.match(/^\/api\/documents\/([a-z0-9]+)(?:\/(.*))?$/i);
  if(match){
    const id=match[1],rest=match[2]||'';
    if(!rest){
      const doc=await visibleDocument(env.DB,id,p);
      if(!doc)bad('文书不存在','NOT_FOUND',404);
      if(method==='GET')return json({document:await getDocDetail(env.DB,doc)});
      if(method==='PATCH')return updateDoc(request,env,p,doc);
    }
    if(method==='POST'&&rest==='ocr')return ocrAttachment(request,env,p,id);
    if(method==='POST'&&rest==='ocr-space')return ocrSpaceAttachment(request,env,p,id);
    if(method==='POST'&&rest==='complete-deadline'){
      const doc=await ownedDocument(env.DB,id,p,'active');
      const body=await readJson(request,500);
      if(body.confirm_year!==true||!validCivilDate(String(body.due_date||'')))
        bad('必须亲自核对年份并填写真实日期','DATE_REVIEW_REQUIRED',409);
      const partial=await dbFirst(env.DB,"SELECT normalized_value,source_quote,review_state FROM document_fields WHERE document_id=? AND field_key='due_date_partial'",id);
      if(!partial||partial.review_state==='rejected')
        bad('没有有效的缺少年份截止日线索','NO_PARTIAL_DEADLINE',409);
      const partialMatch=/([0-9０-９]{1,2})\s*月\s*([0-9０-９]{1,2})\s*日|([0-9０-９]{1,2})\s*[\/／]\s*([0-9０-９]{1,2})/.exec(partial.normalized_value);
      const digits=x=>String(x).replace(/[０-９]/g,c=>String(c.charCodeAt(0)-65296));
      if(!partialMatch||Number(digits(partialMatch[1]||partialMatch[3]))!==Number(body.due_date.slice(5,7))||
        Number(digits(partialMatch[2]||partialMatch[4]))!==Number(body.due_date.slice(8,10)))
        bad('所选日期的月日必须与原文一致，年份必须人工确认','DATE_SOURCE_MISMATCH',422);
      const sourceWeek=/[（(]([日月火水木金土])[)）]/.exec(partial.normalized_value)?.[1];
      if(sourceWeek&&['日','月','火','水','木','金','土'][new Date(body.due_date+'T00:00:00Z').getUTCDay()]!==sourceWeek)
        bad('所选年份与原文星期不一致，请核对活动日期','DATE_WEEKDAY_MISMATCH',422);
      const already=await dbFirst(env.DB,"SELECT id,review_state,source_quote FROM document_fields WHERE document_id=? AND field_key='due_date'",id);
      // Auto-filled year remains a proposal. It can be replaced by an explicitly
      // confirmed year; real dates or already reviewed values cannot be reset.
      if(already&&(!already.source_quote?.startsWith('年份自动补全')||already.review_state!=='unreviewed'))
        bad('截止日期已核验或来自完整原文，不能使用年份补全操作','DATE_ALREADY_EXISTS',409);
      const now=isoNow(),fieldId=randomToken(16),candidateId=randomToken(16);
      const source='人工核实年份（原文只写月日）：'+String(partial.source_quote||partial.normalized_value).slice(0,160);
      // Never regenerate or replace any prior integration key. Remote tasks
      // are created only after a second, separate explicit confirmation.
      await batch(env.DB,[
       already?
        ['UPDATE document_fields SET normalized_value=?,source_quote=?,review_state=?,reviewed_by=?,updated_at=? WHERE id=? AND document_id=? AND review_state=? AND source_quote LIKE ?',
         body.due_date,source,'corrected',p.user_id,now,already.id,id,'unreviewed','年份自动补全%']:
        ['INSERT INTO document_fields(id,document_id,field_key,normalized_value,value_type,source_quote,review_state,reviewed_by,updated_at) SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM document_fields WHERE document_id=? AND field_key=?)',
         fieldId,id,'due_date',body.due_date,'date',source,'corrected',p.user_id,now,id,'due_date'],
       ['INSERT INTO action_candidates(id,document_id,candidate_kind,payload_json,created_at,updated_at) SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM action_candidates WHERE document_id=? AND candidate_kind=?)',
        candidateId,id,'homeflow_task',JSON.stringify({title:(doc.category==='campaign'?'活动截止提醒：':'确认：')+doc.title.slice(0,40),due_on:body.due_date,visibility:doc.visibility,requires_confirmation:true,date_field_key:'due_date'}),now,now,id,'homeflow_task']
      ]);
      return json({ok:true,deadline_year_user_confirmed:true,remote_sync:false});
    }
    if((method==='GET'||method==='POST')&&rest==='translation'){
      const doc=await visibleDocument(env.DB,id,p);
      if(!doc)bad('文书不存在或没有查看权限','NOT_FOUND',404);
      return handleDocumentTranslation(request,env,doc);
    }
    if(method==='POST'&&rest==='ai/analyze'){
      const doc=await ownedDocument(env.DB,id,p,'active');
      const body=await readJson(request,900);
      if(body.confirm!==true)bad('请确认对当前文书执行所选 AI 分析','AI_CONFIRM_REQUIRED',409);
      const result=await analyzeIfEnabled(env,doc,ctx);
      return json({ok:true,...result});
    }
    if(method==='PATCH'&&rest==='ai-provider'){
      const doc=await ownedDocument(env.DB,id,p,'active'),body=await readJson(request,1200);
      const provider=verifyDocumentAiChoice(body.ai_provider,body.gemini_consent);
      const now=isoNow();
      await dbRun(env.DB,'UPDATE documents SET ai_provider=?,ai_consent_at=?,updated_at=?,version=version+1 WHERE id=? AND owner_id=?',provider,provider==='gemini'?now:null,now,id,p.user_id);
      return json({ok:true,document_id:id,ai_provider:provider,ai_invoked:false});
    }
    if(method==='PATCH'&&rest==='source-text'){
      const d=await ownedDocument(env.DB,id,p,'active');
      const body=await readJson(request,110000);
      if(!validString(body.text,100000))bad('请输入可核验的日文文字');
      const confirmed=await dbFirst(env.DB,"SELECT COUNT(*) count FROM document_fields WHERE document_id=? AND review_state IN ('confirmed','corrected')",id);
      // Even a failed response may hide a successful remote write. Never regenerate
      // candidate IDs after the first integration attempt, or retries could create
      // a second ledger entry, task, or vocabulary item in the target app.
      const sent=await dbFirst(env.DB,`SELECT COUNT(*) count FROM integration_links
        WHERE candidate_id IN (SELECT id FROM action_candidates WHERE document_id=?)
          AND (attempt_count>0 OR state IN ('sending','synced','linked_existing','failed'))`,id);
      if(Number(sent?.count||0)>0)bad('存在已发出的跨应用联动，不能重建候选及幂等键；请在目标 App 修改记录，原文保持不变','INTEGRATION_HISTORY_LOCKED',409);
      if(confirmed.count>0&&!body.confirm_reset_review)bad('已有人工核对字段，覆盖原文将清除现有审核，请再次确认','REVIEW_RESET_REQUIRED',409);
      // Only user-visible local candidates may be regenerated. Keep the source
      // and its reviewed fields consistent by using a D1 batch transaction.
      const now=isoNow();
      // Replacing the entire source can turn a harmless shared item into a
      // salary/medical/identity document. Revoke sharing in the same D1 batch.
      const nextSource=body.text.trim();
      const nextType=parseJapaneseText(nextSource).category;
      const nextVisibility=requiresPrivateDefault(nextType,nextSource)?'private':d.visibility;
      await batch(env.DB,[
        ['DELETE FROM document_fields WHERE document_id=?',id],
        ["UPDATE documents SET extracted_text_ja=?,visibility=?,analysis_status='draft',updated_at=?,version=version+1 WHERE id=? AND owner_id=?",nextSource,nextVisibility,now,id,p.user_id]
      ]);
      const updated=await ownedDocument(env.DB,id,p,'active');
      const result=await analyzeStored(env,updated,true);
      return json({ok:true,analysis_status:result.result?.analysis_status||'needs_review',fields:result.result?.fields||[],privacy_auto_private:nextVisibility==='private'&&d.visibility==='shared',message:'文字已保存为待人工核对的分析结果'});
    }
    if(method==='POST'&&rest==='manual-income'){
      const doc=await ownedDocument(env.DB,id,p,'active');
      if(doc.category!=='salary'||!isSalaryDepositNotice(doc.extracted_text_ja||''))bad('仅支持在未注明金额的工资到账邮件中补录收入','NOT_SALARY_DEPOSIT',409);
      const body=await readJson(request,2000);
      if(body.confirm_bank_amount!==true)bad('请先确认金额已与银行入出金明细核对','MANUAL_AMOUNT_CONFIRMATION_REQUIRED',409);
      const amountText=String(body.amount_jpy??'').normalize('NFKC').replace(/[,，]/g,'').trim();
      if(!/^[1-9]\d{0,11}$/.test(amountText))bad('请输入大于零的整数日元金额','INVALID_AMOUNT',400);
      const existing=await dbFirst(env.DB,"SELECT id FROM document_fields WHERE document_id=? AND field_key='net_salary'",id);
      if(existing)bad('工资金额字段已存在，请从字段页面核对或修改','AMOUNT_ALREADY_EXISTS',409);
      const prior=await dbFirst(env.DB,"SELECT id FROM action_candidates WHERE document_id=? AND candidate_kind='finance'",id);
      if(prior)bad('已经存在财务联动候选，请先核对以免重复','CANDIDATE_EXISTS',409);
      const date=await dbFirst(env.DB,"SELECT normalized_value FROM document_fields WHERE document_id=? AND field_key IN ('transaction_at','transaction_date') ORDER BY CASE field_key WHEN 'transaction_at' THEN 0 ELSE 1 END LIMIT 1",id);
      const now=isoNow();
      const statementFields=[
        ['INSERT INTO document_fields(id,document_id,field_key,normalized_value,value_type,original_currency,source_quote,review_state,reviewed_by,updated_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM document_fields WHERE document_id=? AND field_key=?)',
          randomToken(16),id,'net_salary',amountText,'money','JPY','用户手动补录：原文未提供金额，请对照银行交易明细','corrected',p.user_id,now,id,'net_salary'],
        ['INSERT INTO action_candidates(id,document_id,candidate_kind,payload_json,created_at,updated_at) SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM action_candidates WHERE document_id=? AND candidate_kind=?)',
          randomToken(16),id,'finance',JSON.stringify({kind:'income',amount_jpy:Number(amountText),currency:'JPY',
            payment_confirmed:false,category:'salary',transaction_date:date?.normalized_value?.slice(0,10)||null,
            amount_provenance:'manual',note:'银行工资入账通知未列金额；金额为本人核对银行明细后手动填写，防止重复记账'}),now,now,id,'finance'],
        ["UPDATE documents SET visibility='private',updated_at=?,version=version+1 WHERE id=? AND owner_id=? AND lifecycle='active'",now,id,p.user_id]
      ];
      await batch(env.DB,statementFields);
      return json({ok:true,amount_provenance:'manual',remote_integrations_unchanged:true});
    }
    if(method==='POST'&&rest==='reinterpret'){
      const doc=await ownedDocument(env.DB,id,p,'active');
      if(!doc.extracted_text_ja)bad('这份文书尚无可解读的文字，请先导入文字','SOURCE_TEXT_REQUIRED',422);
      const parsed=parseJapaneseText(doc.extracted_text_ja);
      const existing=await dbAll(env.DB,'SELECT field_key,normalized_value,review_state,source_quote FROM document_fields WHERE document_id=?',id);
      const keys=new Set(existing.map(x=>x.field_key)),now=isoNow();
      // Add only previously missing fields: never overwrite approved/corrected/
      // rejected values, destroy candidates, or regenerate remote idempotency keys.
      const added=parsed.fields.filter(x=>!keys.has(x.field_key));
      const nextCategory=doc.category==='other'||(doc.category==='bank'&&parsed.category==='card_spend')?parsed.category:doc.category;
      const nextVisibility=requiresPrivateDefault(nextCategory,doc.extracted_text_ja)?'private':doc.visibility;
      const manualSalary=existing.find(x=>x.field_key==='net_salary'&&x.review_state==='corrected'&&parsed.category==='salary');
      const explanation=manualSalary?parsed.explanation_zh+'\n金额说明：已根据银行明细人工填写工资金额，原文未提供此数额，请在字段中核对。':parsed.explanation_zh;
      const statements=[['UPDATE documents SET summary_zh=?,explanation_zh=?,category=?,visibility=?,extraction_version=?,updated_at=?,version=version+1 WHERE id=? AND owner_id=? AND lifecycle=?',
        parsed.summary_zh,explanation,nextCategory,nextVisibility,'rules-v4-payments',now,id,p.user_id,'active']];
      for(const f of added)statements.push(['INSERT INTO document_fields(id,document_id,field_key,normalized_value,value_type,original_currency,source_quote,review_state,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        randomToken(16),id,f.field_key,f.normalized_value,f.value_type,f.original_currency||null,f.source_quote,f.review_state,now]);
      // Explicit re-interpretation of a legacy bank-labelled card purchase may
      // safely ADD a missing expense proposal, but never replace existing IDs.
      const cardAmount=parsed.category==='card_spend'?parsed.fields.find(x=>x.field_key==='amount_jpy'):null;
      const previousAmount=existing.find(x=>x.field_key==='amount_jpy');
      const usableAmount=cardAmount&&(!previousAmount||(previousAmount.review_state!=='rejected'&&previousAmount.normalized_value===cardAmount.normalized_value));
      if(usableAmount){
        const merchant=parsed.fields.find(x=>x.field_key==='merchant');
        const date=parsed.fields.find(x=>x.field_key==='transaction_at'||x.field_key==='transaction_date');
        statements.push([`INSERT INTO action_candidates(id,document_id,candidate_kind,payload_json,created_at,updated_at)
          SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM action_candidates WHERE document_id=? AND candidate_kind='finance')`,
          randomToken(16),id,'finance',JSON.stringify({kind:'expense',amount_jpy:Number(cardAmount.normalized_value),currency:'JPY',
            category:'card_spend',payment_confirmed:false,transaction_date:date?.normalized_value?.slice(0,10)||null,
            transaction_at:date?.value_type==='datetime'?date.normalized_value:null,
            payment_source_hint:/Olive/i.test(doc.extracted_text_ja.normalize('NFKC'))?'Olive':null,
            merchant:merchant?.normalized_value||null,
            note:'信用卡消费通知，核对金额、卡片、是否已入账，避免与月度账单重复记账'}),now,now,id]);
      }
      // Backfill one missing *future* delivery suggestion for an old imported mail.
      // Do not recreate existing linked task IDs or override a rejected/corrected date.
      const previousEvent=existing.find(x=>x.field_key==='event_date');
      const sourceEvent=parsed.fields.find(x=>x.field_key==='event_date');
      const canSuggest=!previousEvent||(previousEvent.review_state!=='rejected'&&previousEvent.normalized_value===sourceEvent?.normalized_value);
      const proposed=canSuggest?deliveryTaskSuggestion(parsed,doc.extracted_text_ja,{visibility:nextVisibility}):null;
      if(proposed)statements.push([`INSERT INTO action_candidates(id,document_id,candidate_kind,payload_json,created_at,updated_at)
        SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM action_candidates WHERE document_id=? AND candidate_kind='homeflow_task')`,
        randomToken(16),id,'homeflow_task',JSON.stringify(proposed),now,now,id]);
      else {
        // Backfill an older document's full, reviewable deadline exactly once.
        // An inferred year, rejected field or existing candidate stays untouched.
        const storedDue=existing.find(x=>x.field_key==='due_date');
        const due=storedDue||parsed.fields.find(x=>x.field_key==='due_date');
        if(due&&due.review_state!=='rejected'&&validCivilDate(String(due.normalized_value||''))&&
            !String(due.source_quote||'').startsWith('年份自动补全')){
          statements.push([`INSERT INTO action_candidates(id,document_id,candidate_kind,payload_json,created_at,updated_at)
            SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM action_candidates WHERE document_id=? AND candidate_kind='homeflow_task')`,
            randomToken(16),id,'homeflow_task',JSON.stringify({
              title:(nextCategory==='campaign'?'活动截止提醒：':'确认：')+doc.title.slice(0,40),
              due_on:due.normalized_value,visibility:nextVisibility,requires_confirmation:true,
              date_field_key:'due_date'
            }),now,now,id]);
        }
      }
      await batch(env.DB,statements);
      return json({ok:true,added_fields:added.length,preserved_fields:existing.length,
        privacy_auto_private:doc.visibility==='shared'&&nextVisibility==='private',
        remote_integrations_unchanged:true});
    }
    if(method==='POST'&&rest==='analyze'){
      const doc=await ownedDocument(env.DB,id,p,'active');
      const result=await analyzeStored(env,doc);
      return json({ok:true,...result});
    }
    if(method==='GET'&&rest==='fields'){
      const doc=await visibleDocument(env.DB,id,p);if(!doc)bad('文书不存在','NOT_FOUND',404);
      return json({items:await dbAll(env.DB,'SELECT id,field_key,normalized_value,value_type,source_quote,review_state FROM document_fields WHERE document_id=?',id)});
    }
    if(method==='GET'&&rest==='candidates')return candidatesForDoc(env,p,id);
    if(method==='POST'&&rest==='trash')return moveToTrash(env,p,id);
    if(method==='POST'&&rest==='restore')return restoreDoc(env,p,id);
    if(method==='POST'&&rest==='permanent-delete'){
      const d=await readJson(request,2000);if(d.confirm!=='DELETE_FOREVER')bad('需要二次确认','CONFIRM_REQUIRED',409);
      return permanentlyDelete(env,p,id);
    }
    if(method==='PATCH'&&rest==='attachments/order'){
      const d=await manageableDocument(env.DB,id,p,'active');
      const body=await readJson(request,4000),ids=body.attachment_ids;
      if(!Number.isSafeInteger(body.version)||body.version!==d.version)
        bad('文书已由其他操作修改，请刷新后重新排序','VERSION_CONFLICT',409);
      if(!Array.isArray(ids)||ids.length<2||ids.length>30||
          !ids.every(x=>typeof x==='string'&&/^[a-f0-9]{32}$/.test(x))||new Set(ids).size!==ids.length)
        bad('附件顺序列表无效');
      const existing=await dbAll(env.DB,"SELECT id FROM attachments WHERE document_id=? AND state='active' ORDER BY sort_order,id",id);
      if(ids.length!==existing.length||!existing.every(a=>ids.includes(a.id)))
        bad('附件列表已发生变化，请刷新后重新排序','ATTACHMENT_CONFLICT',409);
      const now=isoNow(),params=ids.map(()=>'?').join(',');
      // First statement acts as an atomic version+membership claim. D1 batch
      // makes the entire reorder all-or-nothing; changes() chains the write
      // gate so a lost CAS cannot reorder any of the attachments.
      const statements=[[
        `UPDATE documents SET version=version+1,updated_at=? WHERE id=? AND (owner_id=? OR (household_id=? AND visibility='shared'))
          AND version=? AND lifecycle='active'
          AND (SELECT COUNT(*) FROM attachments WHERE document_id=? AND state='active')=?
          AND NOT EXISTS(SELECT 1 FROM attachments WHERE document_id=? AND state='active' AND id NOT IN (${params}))`,
        now,id,p.user_id,p.household_id,d.version,id,ids.length,id,...ids
      ]];
      ids.forEach((aid,index)=>statements.push([
        `UPDATE attachments SET sort_order=?,updated_at=? WHERE id=? AND document_id=? AND state='active' AND changes()=1`,
        index,now,aid,id
      ]));
      statements.push([
        `INSERT INTO audit_events(id,actor_user_id,kind,entity_type,entity_id,created_at)
         SELECT ?,?,?,'document',?,? WHERE changes()=1`,
        randomToken(16),p.user_id,'attachment_order_updated',id,now
      ]);
      const output=await batch(env.DB,statements);
      if(output.some(v=>v.meta?.changes!==1))bad('附件列表已被其他设备修改，请刷新','ATTACHMENT_CONFLICT',409);
      return json({ok:true,version:d.version+1,attachment_ids:ids});
    }
    if(method==='POST'&&rest==='attachments')return attachPage(request,env,p,id);
    if(method==='GET'&&rest==='attachments/recycle')return attachmentList(env,p,id);
    if(method==='POST'&&rest==='attachments/restore-upload')return restoreUpload(request,env,p,id);
    const attAction=rest.match(/^attachments\/([a-z0-9]+)\/(trash|restore|permanent-delete)$/i);
    if(method==='POST'&&attAction){
      if(attAction[2]==='trash')return attachmentTrash(env,p,id,attAction[1]);
      if(attAction[2]==='restore')return attachmentRestore(env,p,id,attAction[1]);
      const confirmation=await readJson(request,1000);
      if(confirmation.confirm!=='DELETE_FOREVER')bad('必须二次确认永久删除','CONFIRM_REQUIRED',409);
      return attachmentDelete(env,p,id,attAction[1]);
    }
    const content=rest.match(/^attachments\/([a-z0-9]+)\/content$/i);
    if(method==='GET'&&content)return contentForAttachment(env,p,id,content[1]);
  }
  const field=path.match(/^\/api\/fields\/([a-z0-9]+)$/i);
  if(method==='PATCH'&&field)return updateField(request,env,p,field[1]);
  const candidate=path.match(/^\/api\/candidates\/([a-z0-9]+)\/(commit|preview|status|request-approval|approval)$/i);
  if(candidate){
    if(method==='POST'&&candidate[2]==='commit')return commitCandidate(request,env,p,candidate[1]);
    if(method==='GET'&&candidate[2]==='preview')return candidatePreview(request,env,p,candidate[1]);
    if(method==='GET'&&candidate[2]==='status')return integrationStatus(env,p,candidate[1]);
    if(method==='POST'&&candidate[2]==='request-approval')return requestDocumentMemberApproval(request,env,p,candidate[1]);
    if(method==='GET'&&candidate[2]==='approval')return documentMemberApprovalStatus(env,p,candidate[1]);
  }
  if(method==='POST'&&['/api/auth/start','/api/auth/complete'].includes(path))return failure('AUTH_MODE_NOT_ENABLED','邮件挑战登录暂未启用，请使用密码登录',501);
  return failure('NOT_IMPLEMENTED','当前阶段尚未实现此接口',501);
}
export default {
  async fetch(request,env,ctx){
    try{return protectedResponse(await route(request,env,ctx),request);}
    catch(err){
      if(err?.status)return failure(err.code||'ERROR',err.message,err.status);
      // Intentionally no PII/details in logs.
      return failure('INTERNAL_ERROR','服务暂时不可用',500);
    }
  },
  async scheduled(controller,env,ctx){
    ctx.waitUntil(runDueDocumentAiJobs(env));
  }
};
