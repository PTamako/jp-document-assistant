import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import app from '../worker/index.js';
import { inferSbiInvestmentKind } from '../shared/sbi-investment.js';
import {geminiQuotaSlots,GEMINI_MODEL} from '../worker/gemini-budget.js';
import {hmacHex} from '../worker/security.js';
import {createZip} from '../web/src/zip.js';
import {readBackup,restoreBatch} from '../web/src/backup-client.js';
import {readLocalText} from '../web/src/mail-import.js';

if (!globalThis.crypto) globalThis.crypto=webcrypto;
const root = new URL('../', import.meta.url);
function d1() {
  const sql=new DatabaseSync(':memory:');
  for (const migration of ['0001_init.sql','0002_indexes.sql','0003_password_auth.sql','0004_organize.sql','0005_single_household.sql','0006_document_version.sql','0007_ocr_attempts.sql','0008_bridge_fingerprint.sql','0009_calendar_subscriptions.sql','0010_ocr_utc_budget.sql','0011_document_ai_provider.sql','0012_document_ai_analysis.sql','0013_google_oauth_grants.sql','0014_google_browser_redirect.sql','0015_ocr_space_utc_budget.sql','0016_gemini_daily_budget.sql','0017_google_oauth_callback_error.sql','0018_document_ai_jobs.sql','0019_document_translation_cache.sql','0020_homeflow_identity_links.sql','0021_homeflow_sso_pending.sql','0022_homeflow_session_proofs.sql']){
    sql.exec(fs.readFileSync(new URL(`migrations/${migration}`,root),'utf8'));
  }
  const wrap = statement => ({
    bind(...params){return wrap(sql.prepare(statement).bind ? statement : statement)._bound(params);},
    _bound(params){return {
      first:async()=>sql.prepare(statement).get(...params)||null,
      all:async()=>({results:sql.prepare(statement).all(...params)}),
      run:async()=>({meta:{changes:sql.prepare(statement).run(...params).changes}}),
      _runSync:()=>sql.prepare(statement).run(...params)
    }}
  });
  return {sql,prepare(statement){return wrap(statement);},async batch(stmts){
    sql.exec('BEGIN IMMEDIATE');try{
      const out=stmts.map(x=>x._runSync());sql.exec('COMMIT');return out.map(x=>({meta:{changes:x.changes}}));
    }catch(e){sql.exec('ROLLBACK');throw e;}
  }};
}
function makeEnv(){
  const db=d1(), blobs=new Map(),r2={
    async put(key,data){blobs.set(key,new Uint8Array(data));},
    async get(key){const data=blobs.get(key);return data?{body:new Blob([data]).stream(),arrayBuffer:()=>new Blob([data]).arrayBuffer()}:null;},
    async head(key){return blobs.has(key)?{size:blobs.get(key).length}:null;},
    async delete(key){blobs.delete(key);}
  };
  return {DB:db,DOCUMENTS:r2,ASSETS:{fetch:()=>new Response('app')},SESSION_HMAC_KEY:'local-test-secret-with-enough-entropy-abcdef',BOOTSTRAP_ADMIN_TOKEN:'local-only-bootstrap-admin-123456',R2_BUCKET_NAME:'test-private',_blobs:blobs};
}
async function req(env,path,{method='GET',data,cookie,csrf,form,extraHeaders={}}={}){
  const headers={Origin:'https://app.example.test',...extraHeaders};
  if(cookie)headers.Cookie=cookie;
  if(csrf)headers['X-CSRF-Token']=csrf;
  let body;
  if(form){body=form;}else if(data!==undefined){headers['Content-Type']='application/json';body=JSON.stringify(data);}
  const pending=[];
  const response=await app.fetch(new Request(`https://app.example.test${path}`,{method,headers,body}),env,{waitUntil:promise=>pending.push(promise)});
  await Promise.all(pending); // Worker waitUntil is nonblocking in production; tests drain it deterministically.
  const type=response.headers.get('Content-Type')||'';
  return {response,data:type.includes('application/json')?await response.json():null};
}
async function boot(env){
  const r=await req(env,'/api/auth/bootstrap',{method:'POST',data:{setup_token:env.BOOTSTRAP_ADMIN_TOKEN,email:'a@example.com',password:'owner-long-secret123',display_name:'甲'}});
  assert.equal(r.response.status,201,JSON.stringify(r.data));
  return {cookie:r.response.headers.get('set-cookie').split(';')[0],csrf:r.data.csrf_token,user:r.data.user};
}
function auth(p){return {cookie:p.cookie,csrf:p.csrf};}

test('service usage reports translation reserved chunks separately without exposing global Google quota',async()=>{
 const env=makeEnv(),user=await boot(env);
 const day=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
 env.DB.sql.prepare('INSERT INTO document_translation_daily_budget(japan_day,calls) VALUES(?,?)').run(day,3);
 const usage=await req(env,'/api/usage',auth(user));
 assert.equal(usage.response.status,200);
 assert.deepEqual(usage.data.translation_jst_day,{
  japan_day:day,calls:3,limit:80,remaining:77,
  count_type:'reserved_chunks',scope:'document_assistant_only'
 });
 assert.ok(!('google_account_remaining' in usage.data));
});
test('other service usage remains available if translation statistics table is missing',async()=>{
 const env=makeEnv(),user=await boot(env);
 env.DB.sql.exec('DROP TABLE document_translation_daily_budget');
 const usage=await req(env,'/api/usage',auth(user));
 assert.equal(usage.response.status,200);
 assert.equal(usage.data.translation_jst_day,null);
 assert.equal(usage.data.app_utc_day.limit,5);
 assert.equal(usage.data.ocr_space_utc_day.limit,20);
});

test('Workers AI file/photo import preview needs consent and uses shared five-call budget without R2 writes',async()=>{
 const env=makeEnv(),owner=await boot(env);
 env.ENABLE_EXPERIMENTAL_OCR='true';
 env.OCR_CALLS_PER_USER_DAY='5';env.OCR_APP_UTC_DAILY_LIMIT='5';
 let aiCalls=0;
 env.AI={async run(model,input){
   aiCalls++;
   assert.equal(model,'@cf/moondream/moondream3.1-9B-A2B');
   assert.ok(input.image.startsWith('data:image/jpeg;base64,'));
   assert.equal(input.task,'query');
   return {answer:'区役所のお知らせ、期限は11月30日です。'};
 }};
 const raw=new Uint8Array(150);
 raw[0]=255;raw[1]=216;raw[148]=255;raw[149]=217;
 const makeForm=(consent=true)=>{
   const form=new FormData();
   form.append('file',new File([raw],'photo.jpg',{type:'image/jpeg'}));
   if(consent)form.append('confirm_workers_ai','true');
   return form;
 };
 const noAuth=await req(env,'/api/workers-ai-ocr/preview',{method:'POST',form:makeForm()});
 assert.equal(noAuth.response.status,401);
 const noCsrf=await req(env,'/api/workers-ai-ocr/preview',{method:'POST',
   cookie:owner.cookie,form:makeForm()});
 assert.equal(noCsrf.response.status,403);
 const noConsent=await req(env,'/api/workers-ai-ocr/preview',{
   method:'POST',...auth(owner),form:makeForm(false)});
 assert.equal(noConsent.response.status,409);
 assert.equal(aiCalls,0);
 for(let i=0;i<5;i++){
   const response=await req(env,'/api/workers-ai-ocr/preview',{
     method:'POST',...auth(owner),form:makeForm()});
   assert.equal(response.response.status,200,JSON.stringify(response.data));
   assert.equal(response.data.verified,false);
   assert.match(response.data.text,/区役所/);
 }
 const sixth=await req(env,'/api/workers-ai-ocr/preview',{
   method:'POST',...auth(owner),form:makeForm()});
 assert.equal(sixth.response.status,429,JSON.stringify(sixth.data));
 assert.equal(aiCalls,5);
 assert.equal(env._blobs.size,0);
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM storage_objects').get().n,0);
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM documents').get().n,0);
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM ocr_space_utc_daily').get().n,0);
 const usage=await req(env,'/api/usage',auth(owner));
 assert.equal(usage.data.app_utc_day.calls,5);
 assert.equal(usage.data.app_utc_day.reserved,0);
 assert.equal(usage.data.app_utc_day.limit,5);
 assert.equal(usage.data.ocr_space_utc_day.calls,0);
});

test('browser OAuth completes Gmail and Drive, even when Google omits optional token scope',async()=>{
 const env=makeEnv(),owner=await boot(env);
 env.GOOGLE_OAUTH_CLIENT_ID='12345-test.apps.googleusercontent.com';
 env.GOOGLE_OAUTH_CLIENT_SECRET='test-only-client-secret';
 env.GOOGLE_TOKEN_ENCRYPTION_KEY='a'.repeat(64);
 let calls=0;
 env.GOOGLE_OAUTH_FETCH=async(url,options)=>{
   calls++;
   // Cloudflare workerd rejects redirect:error before any network traffic.
   assert.equal(options.redirect,'manual');
   assert.equal(options.cache,'no-store');
   if(String(url)==='https://oauth2.googleapis.com/token'){
     const payload=new URLSearchParams(options.body);
     assert.equal(payload.get('client_id'),env.GOOGLE_OAUTH_CLIENT_ID);
     assert.equal(payload.get('client_secret'),env.GOOGLE_OAUTH_CLIENT_SECRET);
     assert.match(payload.get('code_verifier')||'',/^[a-f0-9]{128}$/);
     assert.equal(payload.get('grant_type'),'authorization_code');
     assert.equal(payload.get('redirect_uri'),'https://app.example.test/api/google/oauth/callback');
     return Response.json({access_token:'example-access-secret',refresh_token:'private-refresh-1234567',expires_in:3600,token_type:'Bearer'});
   }
   if(String(url).includes('/gmail/v1/users/me/profile'))
     return Response.json({emailAddress:'user@example.test'});
   if(String(url).includes('/drive/v3/about'))
     return Response.json({user:{emailAddress:'user@example.test'}});
   throw Error('unexpected fetch '+url);
 };
 for(const service of ['gmail','drive']){
   const started=await req(env,'/api/google/oauth/start',{method:'POST',...auth(owner),data:{service}});
   assert.equal(started.response.status,200,JSON.stringify(started.data));
   const authUrl=new URL(started.data.authorization_url);
   assert.equal(authUrl.origin,'https://accounts.google.com');
   assert.equal(authUrl.searchParams.get('scope'),service==='gmail'?'https://www.googleapis.com/auth/gmail.readonly':'https://www.googleapis.com/auth/drive.readonly');
   const state=authUrl.searchParams.get('state');
   assert.equal(authUrl.searchParams.get('code_challenge_method'),'S256');
   const callback=await req(env,'/api/google/oauth/callback?state='+encodeURIComponent(state)+'&code=valid-google-code-1234');
   assert.equal(callback.response.status,200);
   const html=await callback.response.text();
   assert.match(html,/Google 授权成功/);
   assert.doesNotMatch(html,/private-refresh-1234567|valid-google-code-1234/);
   const grant=env.DB.sql.prepare('SELECT service,status,refresh_cipher,refresh_iv FROM google_oauth_grants WHERE user_id=? AND service=?').get(owner.user.id,service);
   assert.equal(grant?.status,'connected');
   assert.notEqual(grant.refresh_cipher,'private-refresh-1234567');
   const status=await req(env,'/api/google/oauth/status?service='+service,auth(owner));
   assert.equal(status.data.connected,true);
   assert.equal(status.data.google_email,'user@example.test');
   assert.equal(status.data.progress,null);
 }
 assert.equal(calls,4);
});

test('Google OAuth rejects 3xx manually instead of following unsafe redirects',async()=>{
 const env=makeEnv(),owner=await boot(env);
 env.GOOGLE_OAUTH_CLIENT_ID='12345-test.apps.googleusercontent.com';
 env.GOOGLE_OAUTH_CLIENT_SECRET='test-only-client-secret';
 env.GOOGLE_TOKEN_ENCRYPTION_KEY='a'.repeat(64);
 let calls=0;
 env.GOOGLE_OAUTH_FETCH=async(url,options)=>{
   calls++;
   assert.equal(options.redirect,'manual');
   assert.equal(String(url),'https://oauth2.googleapis.com/token');
   return new Response(null,{status:302,headers:{Location:'https://example.test/unsafe'}});
 };
 const started=await req(env,'/api/google/oauth/start',{method:'POST',...auth(owner),data:{service:'gmail'}});
 const state=new URL(started.data.authorization_url).searchParams.get('state');
 const callback=await req(env,'/api/google/oauth/callback?state='+state+'&code=mock-test-authorization-code');
 const html=await callback.response.text();
 assert.match(html,/Google 授权服务返回异常跳转/);
 assert.equal(calls,1,'redirect must not be followed');
 const row=env.DB.sql.prepare('SELECT status,error_code FROM google_oauth_pending').get();
 assert.equal(row.status,'failed');
 assert.equal(row.error_code,'GOOGLE_UNEXPECTED_REDIRECT');
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM google_oauth_grants').get().n,0);
});

test('browser OAuth shows safe reason for invalid_client without leaking Google response',async()=>{
 const env=makeEnv(),owner=await boot(env);
 env.GOOGLE_OAUTH_CLIENT_ID='12345-test.apps.googleusercontent.com';
 env.GOOGLE_OAUTH_CLIENT_SECRET='test-only-client-secret';
 env.GOOGLE_TOKEN_ENCRYPTION_KEY='a'.repeat(64);
 env.GOOGLE_OAUTH_FETCH=async()=>Response.json({
   error:'invalid_client',error_description:'SENSITIVE_PROVIDER_DETAILS_SHOULD_NEVER_SHOW'
 },{status:401});
 const started=await req(env,'/api/google/oauth/start',{method:'POST',...auth(owner),data:{service:'drive'}});
 assert.equal(started.response.status,200);
 const state=new URL(started.data.authorization_url).searchParams.get('state');
 const callback=await req(env,'/api/google/oauth/callback?state='+state+'&code=valid-test-code');
 assert.equal(callback.response.status,200);
 const html=await callback.response.text();
 assert.match(html,/Google 客户端密钥无效/);
 assert.doesNotMatch(html,/SENSITIVE_PROVIDER_DETAILS|valid-test-code/);
 const row=env.DB.sql.prepare('SELECT status,error_code FROM google_oauth_pending').get();
 assert.equal(row.status,'failed');
 assert.equal(row.error_code,'GOOGLE_CLIENT_INVALID');
 const status=await req(env,'/api/google/oauth/status?service=drive&flow='+state,auth(owner));
 assert.equal(status.data.progress,'failed');
 assert.match(status.data.progress_error,/Google 客户端密钥无效/);
 const returned=await req(env,'/api/google/oauth/status?service=drive',auth(owner));
 assert.equal(returned.data.progress,'failed');
 assert.equal(returned.data.progress_error,status.data.progress_error);
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) AS n FROM google_oauth_grants').get().n,0);
});

test('OCR.space scanned PDF import preview is private, consent gated, page-only and quota limited',async()=>{
 const env=makeEnv(),owner=await boot(env);
 env.OCR_SPACE_API_KEY='test-key-not-real';
 env.OCR_SPACE_FREE_ONLY_CONFIRMED='true';
 env.OCR_SPACE_APP_UTC_DAILY_LIMIT='1';
 let external=0,posted;
 env.OCR_SPACE_FETCH=async(url,options)=>{
  external++;
  assert.equal(url,'https://api.ocr.space/parse/image');
  assert.equal(options.headers.apikey,env.OCR_SPACE_API_KEY);
  posted=options.body.get('file');
  assert.equal(posted.type,'image/jpeg');
  assert.equal(posted.name,'scanned-page.jpg');
  assert.equal(options.body.get('OCREngine'),'3');
  return Response.json({OCRExitCode:1,IsErroredOnProcessing:false,
   ParsedResults:[{FileParseExitCode:1,ParsedText:'区役所のお知らせを確認してください。'}]});
 };
 const jpegBytes=new Uint8Array(150);jpegBytes[0]=255;jpegBytes[1]=216;jpegBytes[148]=255;jpegBytes[149]=217;
 const jpg=new Blob([jpegBytes],{type:'image/jpeg'});
 const makeForm=(consented=true,file=jpg)=>{
  const f=new FormData();f.append('file',file,'page.jpg');
  if(consented){f.append('confirm_ocr_space','true');f.append('confirm_private_upload','true');}
  return f;
 };
 const anonymous=await req(env,'/api/ocr-space/preview',{method:'POST',form:makeForm(true)});
 assert.equal(anonymous.response.status,401);
 const missingConsent=await req(env,'/api/ocr-space/preview',{method:'POST',...auth(owner),form:makeForm(false)});
 assert.equal(missingConsent.response.status,409);
 assert.equal(external,0);
 const wrongFormat=await req(env,'/api/ocr-space/preview',{method:'POST',...auth(owner),
  form:makeForm(true,new Blob(['not a real PDF'],{type:'application/pdf'}))});
 assert.equal(wrongFormat.response.status,422);
 assert.equal(external,0);
 const response=await req(env,'/api/ocr-space/preview',{method:'POST',...auth(owner),form:makeForm(true)});
 assert.equal(response.response.status,200,JSON.stringify(response.data));
 assert.equal(response.data.uploaded_pages,1);
 assert.match(response.data.text,/区役所/);
 assert.equal(external,1);
 const again=await req(env,'/api/ocr-space/preview',{method:'POST',...auth(owner),form:makeForm(true)});
 assert.equal(again.response.status,429);
 assert.equal(external,1);
 assert.equal(env.DB.sql.prepare('SELECT calls FROM ocr_space_utc_daily').get().calls,1);
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM ocr_app_utc_daily').get().n,0);
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM storage_objects').get().n,0);
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM documents').get().n,0);
});

test('OCR.space 20/day is independent of Workers AI OCR 5/day and provider usage is visible',async()=>{
 const env=makeEnv(),owner=await boot(env);
 env.OCR_SPACE_API_KEY='free-test-only';
 env.OCR_SPACE_FREE_ONLY_CONFIRMED='true';
 env.OCR_SPACE_APP_UTC_DAILY_LIMIT='20';
 env.OCR_APP_UTC_DAILY_LIMIT='5';
 env.AI_ANALYSIS_DAILY_LIMIT='5';
 const utc=new Date().toISOString().slice(0,10);
 env.DB.sql.prepare('INSERT INTO ocr_app_utc_daily(day_utc,calls,reserved) VALUES(?,5,0)').run(utc);
 let external=0;
 env.OCR_SPACE_FETCH=async()=>{external++;return Response.json({
   OCRExitCode:1,IsErroredOnProcessing:false,
   ParsedResults:[{FileParseExitCode:1,ParsedText:'納付期限は11月30日です。'}]
 });};
 const bytes=new Uint8Array(128);bytes[0]=0xff;bytes[1]=0xd8;bytes[126]=0xff;bytes[127]=0xd9;
 const make=()=>{
   const data=new FormData();
   data.append('file',new File([bytes],'scanned-page.jpg',{type:'image/jpeg'}));
   data.append('confirm_ocr_space','true');
   data.append('confirm_private_upload','true');
   return data;
 };
 for(let i=0;i<2;i++){
   const res=await req(env,'/api/ocr-space/preview',{method:'POST',...auth(owner),form:make()});
   assert.equal(res.response.status,200,JSON.stringify(res.data));
 }
 assert.equal(external,2);
 assert.equal(env.DB.sql.prepare('SELECT calls FROM ocr_app_utc_daily WHERE day_utc=?').get(utc).calls,5);
 assert.equal(env.DB.sql.prepare('SELECT calls FROM ocr_space_utc_daily WHERE day_utc=?').get(utc).calls,2);
 const usage=await req(env,'/api/usage',auth(owner));
 assert.equal(usage.data.app_utc_day.calls,5);
 assert.equal(usage.data.app_utc_day.limit,5);
 assert.equal(usage.data.document_ai_utc_day.limit,5);
 assert.equal(usage.data.ocr_space_utc_day.calls,2);
 assert.equal(usage.data.ocr_space_utc_day.limit,20);
 env.DB.sql.prepare('UPDATE ocr_space_utc_daily SET calls=20 WHERE day_utc=?').run(utc);
 const blocked=await req(env,'/api/ocr-space/preview',{method:'POST',...auth(owner),form:make()});
 assert.equal(blocked.response.status,429,JSON.stringify(blocked.data));
 assert.equal(external,2,'overflow must not reach third-party');
});

test('selected Cloudflare AI analyzes a source once and caches grounded study candidates without cross-app writes',async()=>{
 const env=makeEnv(),u=await boot(env);
 const source='営業時間を確認してください。ご不明な点は窓口へご連絡ください。';
 let calls=0;
 env.ENABLE_DOCUMENT_AI='true';
 env.AI_ANALYSIS_DAILY_LIMIT='2';
 env.AI={run:async(model,opts)=>{
  calls++;
  assert.equal(model,'@cf/qwen/qwen3.8-27b');
  assert.ok(opts.messages.length);
  return {response:JSON.stringify({
   summary_zh:'这是一份营业时间说明，请自行核对。',
   explanation_zh:'建议先确认营业时间，有不明事项可联系窗口。',
   important_points_zh:['确认营业时间'],
   vocabulary:[{term:'営業時間',reading:'えいぎょうじかん',meaning_zh:'营业时间',source_quote:'営業時間'}],
   sentences:[{sentence:'営業時間を確認してください。',translation_zh:'请确认营业时间。',source_quote:'営業時間を確認してください。'}],
   homeflow_suggestions:[],finance_suggestions:[]
  })};
 }};
 const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(u),data:{
  source_type:'text',retention:'summary',text:source,ai_provider:'cloudflare'
 }});
 assert.equal(imported.response.status,201,JSON.stringify(imported.data));
 assert.equal(imported.data.ai_status,'queued');
 assert.equal(calls,1);
 const id=imported.data.document_id;
 const detail=await req(env,'/api/documents/'+id,auth(u));
 assert.equal(detail.data.document.ai_analysis.status,'success');
 assert.match(detail.data.document.ai_analysis.result.explanation_zh,/营业/);
 const candidates=await req(env,'/api/documents/'+id+'/candidates',auth(u));
 assert.equal(candidates.data.items.filter(x=>x.candidate_kind==='sentence').length,1);
 assert.equal(candidates.data.items.filter(x=>x.candidate_kind==='vocabulary').length,1);
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM integration_links').get().n,0);
 const cached=await req(env,'/api/documents/'+id+'/ai/analyze',{method:'POST',...auth(u),data:{confirm:true}});
 assert.equal(cached.data.ai_status,'cached');
 assert.equal(calls,1);
 assert.equal(env.DB.sql.prepare('SELECT calls FROM ai_analysis_daily').get().calls,1);
});

test('AI engine is chosen and consented per document, never globally or invoked on import',async()=>{
 const env=makeEnv(),u=await boot(env);
 const first=await req(env,'/api/documents/import/text',{method:'POST',...auth(u),data:{
   title:'句子',text:'今日は良い天気です。散歩に行きます。',source_type:'text',retention:'summary',ai_provider:'gemini',gemini_consent:true
 }});
 assert.equal(first.response.status,201,JSON.stringify(first.data));
 const second=await req(env,'/api/documents/import/text',{method:'POST',...auth(u),data:{
   title:'お知らせ',text:'お知らせの内容を確認してください。',source_type:'text',retention:'summary',ai_provider:'cloudflare'
 }});
 assert.equal(second.response.status,201,JSON.stringify(second.data));
 const doc=async id=>(await req(env,'/api/documents/'+id,auth(u))).data.document;
 assert.equal((await doc(first.data.document_id)).ai_provider,'gemini');
 assert.equal((await doc(second.data.document_id)).ai_provider,'cloudflare');
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM ocr_attempts').get().n,0);
 const denied=await req(env,'/api/documents/'+first.data.document_id+'/ai-provider',{
   method:'PATCH',...auth(u),data:{ai_provider:'gemini'}
 });
 assert.equal(denied.response.status,400);
 const changed=await req(env,'/api/documents/'+first.data.document_id+'/ai-provider',{
   method:'PATCH',...auth(u),data:{ai_provider:'none'}
 });
 assert.equal(changed.response.status,200,JSON.stringify(changed.data));
 assert.equal(changed.data.ai_invoked,false);
 assert.equal((await doc(first.data.document_id)).ai_provider,'none');
 assert.equal((await doc(second.data.document_id)).ai_provider,'cloudflare');
 const sensitive=await req(env,'/api/documents/import/text',{method:'POST',...auth(u),data:{
   title:'工资',text:'給与明細 差引支給額 120000円',source_type:'text',retention:'summary',ai_provider:'gemini',gemini_consent:true
 }});
 assert.equal(sensitive.response.status,201,JSON.stringify(sensitive.data));
 assert.equal((await doc(sensitive.data.document_id)).ai_provider,'gemini');
});

test('Japanese yearless deadline and action are real review fields, never a guessed HomeFlow due date',async()=>{
 const env=makeEnv(),user=await boot(env);
 const raw='11月30日までに申請書を提出してください。お手数ですが、内容をご確認ください。';
 const result=await req(env,'/api/documents/import/text',{method:'POST',...auth(user),data:{
  source_type:'text',retention:'summary',text:raw,ai_provider:'none'
 }});
 assert.equal(result.response.status,201,JSON.stringify(result.data));
 const id=result.data.document_id;
 const detail=(await req(env,'/api/documents/'+id,auth(user))).data.document;
 const field=k=>detail.fields.find(x=>x.field_key===k);
 assert.equal(field('due_date')?.normalized_value,new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Tokyo',year:'numeric'}).format(new Date())+'-11-30');
 assert.equal(field('due_date')?.review_state,'unreviewed');
 assert.match(field('due_date')?.source_quote||'',/年份自动补全/);
 assert.equal(field('due_date_partial')?.normalized_value,'11月30日');
 assert.match(field('required_action')?.normalized_value||'',/申請書を提出/);
 assert.match(field('review_action')?.normalized_value||'',/内容をご確認/);
 assert.equal(field('due_date_partial')?.review_state,'unreviewed');
 const candidates=(await req(env,'/api/documents/'+id+'/candidates',auth(user))).data.items;
 assert.equal(candidates.some(x=>x.candidate_kind==='homeflow_task'),false);
 // Updating the previously created record via its legacy parser must not
 // spend Gemini/Cloudflare quota or overwrite an earlier manual review.
 env.DB.sql.prepare("DELETE FROM document_fields WHERE document_id=? AND field_key IN ('due_date','due_date_partial','required_action','review_action')").run(id);
 const reinterpret=await req(env,'/api/documents/'+id+'/reinterpret',{method:'POST',...auth(user),data:{}});
 assert.equal(reinterpret.response.status,200,JSON.stringify(reinterpret.data));
 assert.equal(reinterpret.data.added_fields,4);
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM ai_analysis_daily').get().n,0);
});

test('yearless deadline becomes a dated HomeFlow proposal only after explicit and matching year confirmation',async()=>{
 const env=makeEnv(),user=await boot(env);
 const source='11月30日までに申請書を提出してください。';
 const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(user),data:{
  source_type:'text',retention:'summary',text:source
 }});
 const id=imported.data.document_id;
 const pre=(await req(env,'/api/documents/'+id,auth(user))).data.document;
 const provisional=pre.fields.find(f=>f.field_key==='due_date');
 assert.ok(provisional);
 assert.equal(provisional.review_state,'unreviewed');
 assert.match(provisional.source_quote,/年份自动补全/);
 const url='/api/documents/'+id+'/complete-deadline';
 const submit=(date,confirm_year)=>req(env,url,{method:'POST',...auth(user),data:{due_date:date,confirm_year}});
 assert.equal((await submit('2026-11-30',false)).response.status,409);
 assert.equal((await submit('2026-12-01',true)).response.status,422);
 assert.equal((await submit('2026-02-30',true)).response.status,409);
 const accepted=await submit('2026-11-30',true);
 assert.equal(accepted.response.status,200,JSON.stringify(accepted.data));
 assert.equal(accepted.data.remote_sync,false);
 assert.equal((await submit('2026-11-30',true)).response.status,409);
 const doc=(await req(env,'/api/documents/'+id,auth(user))).data.document;
 const due=doc.fields.find(f=>f.field_key==='due_date');
 assert.equal(due.normalized_value,'2026-11-30');
 assert.equal(due.review_state,'corrected');
 assert.match(due.source_quote,/人工核实年份/);
 const items=(await req(env,'/api/documents/'+id+'/candidates',auth(user))).data.items;
 assert.equal(items.filter(i=>i.candidate_kind==='homeflow_task').length,1);
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM integration_links').get().n,0);
});

test('yearless leap-day has no invented invalid current-year deadline',async()=>{
 const {parseJapaneseText}=await import('../worker/analysis.js');
 const nonLeap=parseJapaneseText('2月29日までに申請書を提出してください。',{referenceYear:2026});
 assert.equal(nonLeap.fields.some(f=>f.field_key==='due_date_partial'),true);
 assert.equal(nonLeap.fields.some(f=>f.field_key==='due_date'),false);
 const leap=parseJapaneseText('2月29日までに申請書を提出してください。',{referenceYear:2028});
 assert.equal(leap.fields.find(f=>f.field_key==='due_date')?.normalized_value,'2028-02-29');
 assert.equal(leap.fields.find(f=>f.field_key==='due_date')?.review_state,'unreviewed');
 const complete=parseJapaneseText('令和8年12月25日までに申請書を提出してください。',{referenceYear:2026});
 assert.equal(complete.fields.filter(f=>f.field_key==='due_date').length,1);
 assert.equal(complete.fields.find(f=>f.field_key==='due_date')?.normalized_value,'2026-12-25');
 assert.equal(complete.fields.some(f=>f.field_key==='due_date_partial'),false);
});

test('top-up email is private, exposes reviewed candidates, never generates a finance write candidate',async()=>{
 const env=makeEnv(),p=await boot(env);
 const email=[
  'Suicaポケット受取完了：モバイルSuica',
  'ポケット受取カードに設定したSuicaへの入金（チャージ）が完了しました。',
  '□サービス名', '楽天ペイSuicaチャージ', '□受取額', '1,000円',
  '□受取完了日時', '2026/11/08 13:04'
 ].join('\n');
 const imp=await req(env,'/api/documents/import/text',{method:'POST',...auth(p),data:{title:'Suicaチャージ完了',source_type:'mail_forward',retention:'summary',text:email,visibility:'shared'}});
 assert.equal(imp.response.status,201,JSON.stringify(imp.data));
 const doc=await req(env,'/api/documents/'+imp.data.document_id,auth(p));
 assert.equal(doc.data.document.category,'topup');
 assert.equal(doc.data.document.visibility,'private');
 assert.equal(doc.data.document.fields.find(f=>f.field_key==='amount_jpy').normalized_value,'1000');
 assert.equal(doc.data.document.fields.find(f=>f.field_key==='transaction_at').normalized_value,'2026-11-08 13:04');
 const candidates=await req(env,'/api/documents/'+imp.data.document_id+'/candidates',auth(p));
 assert.equal(candidates.response.status,200);
 assert.equal(candidates.data.items.some(c=>c.candidate_kind==='finance'),false);
 assert.equal(candidates.data.items.some(c=>c.candidate_kind==='homeflow_task'),false);
});

test('bootstrap is one-time, default private and text import needs review',async()=>{
  const env=makeEnv(),p=await boot(env);
  const second=await req(env,'/api/auth/bootstrap',{method:'POST',data:{setup_token:env.BOOTSTRAP_ADMIN_TOKEN,email:'x@example.com',password:'some-long-password'}});
  assert.equal(second.response.status,409);
  const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(p),data:{title:'缴费通知',retention:'summary',source_type:'text',visibility:'shared',text:'納付期限：令和8年11月30日（月）\n納付金額：12,340円\n税額 12340'}});
  assert.equal(imported.response.status,201,JSON.stringify(imported.data));
  const d=await req(env,`/api/documents/${imported.data.document_id}`,auth(p));
  assert.equal(d.data.document.visibility,'private');
  assert.equal(d.data.document.fields.find(x=>x.field_key==='due_date').normalized_value,'2026-11-30');
  assert.equal(d.data.document.fields.find(x=>x.field_key==='amount_jpy').normalized_value,'12340');
  assert.equal(d.data.document.analysis_status,'needs_review');
  const dup=await req(env,'/api/documents/import/text',{method:'POST',...auth(p),data:{retention:'summary',source_type:'text',text:'納付期限：令和8年11月30日（月）\n納付金額：12,340円\n税額 12340'}});
  assert.equal(dup.data.document_id,imported.data.document_id);
});

test('private documents are not exposed to invited user and shared only when confirmed',async()=>{
  const env=makeEnv(),a=await boot(env);
  const inv=await req(env,'/api/household/invites',{method:'POST',...auth(a),data:{invitee_email:'b@example.com'}});
  const joined=await req(env,'/api/household/join',{method:'POST',data:{invite_token:inv.data.invite_token,email:'b@example.com',password:'member-long-secret123',display_name:'乙'}});
  assert.equal(joined.response.status,201,JSON.stringify(joined.data));
  const b={cookie:joined.response.headers.get('set-cookie').split(';')[0],csrf:joined.data.csrf_token};
  const imp=await req(env,'/api/documents/import/text',{method:'POST',...auth(a),data:{retention:'summary',source_type:'text',text:'申請はこちら 11月30日'}});
  const id=imp.data.document_id;
  assert.equal((await req(env,`/api/documents/${id}`,auth(b))).response.status,404);
  const doc=(await req(env,`/api/documents/${id}`,auth(a))).data.document;
  const fail=await req(env,`/api/documents/${id}`,{method:'PATCH',...auth(a),data:{visibility:'shared',version:doc.version}});
  assert.equal(fail.response.status,409);
  const ok=await req(env,`/api/documents/${id}`,{method:'PATCH',...auth(a),data:{visibility:'shared',version:doc.version,confirm_sensitive_share:true}});
  assert.equal(ok.response.status,200);
  assert.equal((await req(env,`/api/documents/${id}`,auth(b))).response.status,200);
  const nonOwner=(await req(env,`/api/documents/${id}`,auth(b))).data.document;
  const forbiddenVisibility=await req(env,`/api/documents/${id}`,{
    method:'PATCH',...auth(b),data:{visibility:'private',version:nonOwner.version}
  });
  assert.equal(forbiddenVisibility.response.status,403,'original owner controls privacy');
  const updated=await req(env,`/api/documents/${id}`,{
    method:'PATCH',...auth(b),data:{title:'共享协作修改',version:nonOwner.version}
  });
  assert.equal(updated.response.status,200,JSON.stringify(updated.data));
  assert.equal((await req(env,`/api/documents/${id}`,auth(a))).data.document.title,'共享协作修改');
  assert.equal((await req(env,`/api/documents/${id}`,{
    method:'PATCH',...auth(b),data:{title:'旧版本覆盖',version:nonOwner.version}
  })).response.status,409,'a stale editor must never overwrite a newer version');
  const trash=await req(env,`/api/documents/${id}/trash`,{method:'POST',...auth(b),data:{}});
  assert.equal(trash.response.status,200,'shared collaborator may trash a shared document');
  assert.equal((await req(env,`/api/documents/${id}`,auth(a))).response.status,404);
  const restored=await req(env,`/api/documents/${id}/restore`,{method:'POST',...auth(b),data:{}});
  assert.equal(restored.response.status,200,'shared collaborator may restore shared document');
  assert.equal((await req(env,`/api/documents/${id}`,auth(a))).response.status,200);
  const events=env.DB.sql.prepare(`SELECT kind,actor_user_id FROM audit_events
    WHERE entity_id=? AND kind IN ('document_metadata_updated','document_trashed','document_restored')
    ORDER BY created_at,kind`).all(id);
  assert.equal(events.length,4,'owner sharing and three member edits are audited');
  const memberEvents=events.filter(x=>x.actor_user_id===joined.data.user.id);
  assert.deepEqual(memberEvents.map(x=>x.kind).sort(),
    ['document_metadata_updated','document_restored','document_trashed'],
    'each member change records the real actor instead of the document owner');
});

test('trash restores without deleting R2; permanent deletion removes R2 and private rows',async()=>{
  const env=makeEnv(),a=await boot(env);
  const bytes=new Uint8Array([0xff,0xd8,0xff,0xe0,1,2,3,4]);
  const f=new FormData();f.append('file',new File([bytes],'scan.jpg',{type:'image/jpeg'}));f.append('retention','original');
  const imp=await req(env,'/api/documents/import/file',{method:'POST',...auth(a),form:f});
  assert.equal(imp.response.status,201,JSON.stringify(imp.data));
  const id=imp.data.document_id;assert.equal(env._blobs.size,1);
  let t=await req(env,`/api/documents/${id}/trash`,{method:'POST',...auth(a),data:{}});
  assert.equal(t.response.status,200);assert.equal(env._blobs.size,1);
  assert.equal((await req(env,`/api/documents/${id}`,auth(a))).response.status,404);
  assert.equal((await req(env,`/api/documents/${id}/restore`,{method:'POST',...auth(a),data:{}})).response.status,200);
  assert.equal(env._blobs.size,1);
  await req(env,`/api/documents/${id}/trash`,{method:'POST',...auth(a),data:{}});
  const gone=await req(env,`/api/documents/${id}/permanent-delete`,{method:'POST',...auth(a),data:{confirm:'DELETE_FOREVER'}});
  assert.equal(gone.response.status,200,JSON.stringify(gone.data));
  assert.equal(env._blobs.size,0);
  assert.equal(Number(env.DB.sql.prepare('SELECT COUNT(*) n FROM documents').get().n),0);
});


test('recycle empty-all removes paginated trashed documents and detached attachments but keeps live documents',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const ids=[];
 for(let i=0;i<6;i++){
  const created=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),
   data:{retention:'summary',source_type:'text',text:'予約番号 '+(i+1)+'\n提出期限：2026-11-30'}});
  assert.equal(created.response.status,201,JSON.stringify(created.data));
  ids.push(created.data.document_id);
 }
 const image=new FormData();
 image.append('file',new File([new Uint8Array([255,216,255,224,7,6,5,4])],'keep.jpg',{type:'image/jpeg'}));
 image.append('retention','original');
 const live=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:image});
 assert.equal(live.response.status,201,JSON.stringify(live.data));
 const liveId=live.data.document_id;
 const attachment=(await req(env,'/api/documents/'+liveId,auth(owner))).data.document.attachments[0];
 assert.equal((await req(env,'/api/documents/'+liveId+'/attachments/'+attachment.id+'/trash',{
  method:'POST',...auth(owner),data:{}
 })).response.status,200);
 for(const id of ids)assert.equal((await req(env,'/api/documents/'+id+'/trash',{
  method:'POST',...auth(owner),data:{}
 })).response.status,200);
 assert.equal(env._blobs.size,1);
 const authMissing=await req(env,'/api/recycle/empty',{method:'POST',data:{confirm:'DELETE_FOREVER'}});
 assert.equal(authMissing.response.status,401);
 const csrfMissing=await req(env,'/api/recycle/empty',{
  method:'POST',cookie:owner.cookie,data:{confirm:'DELETE_FOREVER'}
 });
 assert.equal(csrfMissing.response.status,403);
 const notConfirmed=await req(env,'/api/recycle/empty',{
  method:'POST',...auth(owner),data:{confirm:'NOT_APPROVED'}
 });
 assert.equal(notConfirmed.response.status,409);
 assert.equal(env.DB.sql.prepare("SELECT COUNT(*) n FROM documents WHERE lifecycle='trashed'").get().n,6);
 const first=await req(env,'/api/recycle/empty',{
  method:'POST',...auth(owner),data:{confirm:'DELETE_FOREVER'}
 });
 assert.equal(first.response.status,200,JSON.stringify(first.data));
 assert.equal(first.data.processed_documents,5);
 assert.equal(first.data.processed_attachments,1);
 assert.equal(first.data.has_more,true);
 assert.equal(first.data.remaining,1);
 assert.equal(env._blobs.size,0);
 const second=await req(env,'/api/recycle/empty',{
  method:'POST',...auth(owner),data:{confirm:'DELETE_FOREVER'}
 });
 assert.equal(second.response.status,200,JSON.stringify(second.data));
 assert.equal(second.data.processed_documents,1);
 assert.equal(second.data.processed_attachments,0);
 assert.equal(second.data.remaining,0);
 assert.equal(second.data.has_more,false);
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM documents').get().n,1);
 assert.equal((await req(env,'/api/documents/'+liveId,auth(owner))).response.status,200);
 const recycle=await req(env,'/api/recycle',auth(owner));
 const attachments=await req(env,'/api/recycle/attachments',auth(owner));
 assert.deepEqual(recycle.data.items,[]);
 assert.deepEqual(attachments.data.items,[]);
 const again=await req(env,'/api/recycle/empty',{
  method:'POST',...auth(owner),data:{confirm:'DELETE_FOREVER'}
 });
 assert.equal(again.data.processed,0);
 assert.equal(again.data.has_more,false);
});
test('recycle empty-all records R2 failures and safely retries without discarding metadata',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const file=new FormData();
 file.append('file',new File([new Uint8Array([255,216,255,224,4,3,2,1])],'failed.jpg',{type:'image/jpeg'}));
 file.append('retention','original');
 const created=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:file});
 const id=created.data.document_id;
 assert.equal(created.response.status,201);
 await req(env,'/api/documents/'+id+'/trash',{method:'POST',...auth(owner),data:{}});
 const original=env.DOCUMENTS.delete.bind(env.DOCUMENTS);
 let broken=true;
 env.DOCUMENTS.delete=async key=>{if(broken)throw Error('simulated R2 failure');await original(key)};
 const failed=await req(env,'/api/recycle/empty',{method:'POST',...auth(owner),data:{confirm:'DELETE_FOREVER'}});
 assert.equal(failed.response.status,200);
 assert.equal(failed.data.ok,false);
 assert.equal(failed.data.processed,0);
 assert.deepEqual(failed.data.failed,[{type:'document',id}]);
 assert.equal(failed.data.remaining,1);
 assert.equal(failed.data.has_more,true);
 assert.equal(env._blobs.size,1);
 assert.equal(env.DB.sql.prepare('SELECT lifecycle FROM documents WHERE id=?').get(id).lifecycle,'deletion_pending');
 broken=false;
 const success=await req(env,'/api/recycle/empty',{method:'POST',...auth(owner),data:{confirm:'DELETE_FOREVER'}});
 assert.equal(success.data.ok,true);
 assert.equal(success.data.processed_documents,1);
 assert.equal(success.data.remaining,0);
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM documents').get().n,0);
 assert.equal(env._blobs.size,0);
});

test('CSRF rejects state mutation and target-app bridge fails closed',async()=>{
  const env=makeEnv(),p=await boot(env);
  const failed=await req(env,'/api/documents/import/text',{method:'POST',cookie:p.cookie,data:{retention:'summary',source_type:'text',text:'納付金額 1200円'}});
  assert.equal(failed.response.status,403);
  const imp=await req(env,'/api/documents/import/text',{method:'POST',...auth(p),data:{retention:'summary',source_type:'text',text:'ご請求金額：1,200円\n納付期限 令和8年11月30日'}});
  const id=imp.data.document_id;
  const cand=(await req(env,`/api/documents/${id}/candidates`,auth(p))).data.items;
  assert.ok(cand.length>0);
  const commit=await req(env,`/api/candidates/${cand[0].id}/commit`,{method:'POST',...auth(p),data:{}});
  assert.equal(commit.response.status,409);
  const confirmed=await req(env,`/api/candidates/${cand[0].id}/commit`,{method:'POST',...auth(p),data:{confirm:'CONFIRM_ACCOUNTING',payment_confirmed:true,date:'2026-11-12',category:'税金',payment_source:'銀行'}});
  assert.equal(confirmed.response.status,400); // Idempotency-Key required; no remote call
  assert.equal(Number(env.DB.sql.prepare('SELECT COUNT(*) n FROM integration_links').get().n),0);
});

test('explicit attachment trash / restore / permanent delete and R2 failure retry',async()=>{
  const env=makeEnv(),a=await boot(env);
  const f=new FormData();f.append('file',new File([new Uint8Array([255,216,255,224,9,8,7,6])],'file.jpg',{type:'image/jpeg'}));f.append('retention','original');
  const added=await req(env,'/api/documents/import/file',{method:'POST',...auth(a),form:f});
  const id=added.data.document_id;
  const detail=(await req(env,`/api/documents/${id}`,auth(a))).data.document;
  const aid=detail.attachments[0].id;
  const deny=await req(env,`/api/documents/${id}/attachments/${aid}/permanent-delete`,{method:'POST',...auth(a),data:{confirm:'DELETE_FOREVER'}});
  assert.equal(deny.response.status,409);
  assert.equal((await req(env,`/api/documents/${id}/attachments/${aid}/trash`,{method:'POST',...auth(a),data:{}})).response.status,200);
  assert.equal((await req(env,`/api/documents/${id}/attachments/${aid}/restore`,{method:'POST',...auth(a),data:{}})).response.status,200);
  await req(env,`/api/documents/${id}/attachments/${aid}/trash`,{method:'POST',...auth(a),data:{}});
  let firstTry=true;
  env.DOCUMENTS.delete=async k=>{if(firstTry){firstTry=false;throw Error('fake r2 failure')}env._blobs.delete(k)};
  const fail=await req(env,`/api/documents/${id}/attachments/${aid}/permanent-delete`,{method:'POST',...auth(a),data:{confirm:'DELETE_FOREVER'}});
  assert.equal(fail.response.status,503);
  assert.equal(env._blobs.size,1);
  const retry=await req(env,`/api/documents/${id}/attachments/${aid}/permanent-delete`,{method:'POST',...auth(a),data:{confirm:'DELETE_FOREVER'}});
  assert.equal(retry.response.status,200,JSON.stringify(retry.data));
  assert.equal(env._blobs.size,0);
  assert.equal((await req(env,`/api/documents/${id}`,auth(a))).data.document.attachments.length,0);
});

test('backup JSON roundtrip only restores metadata and does not send remote integrations',async()=>{
  const env=makeEnv(),a=await boot(env);
  const imp=await req(env,'/api/documents/import/text',{method:'POST',...auth(a),data:{retention:'summary',source_type:'text',text:'納付期限：令和8年11月30日\n納付金額：500円'}});
  assert.equal(imp.response.status,201);
  const exportDoc=(await req(env,'/api/backups/export?scope=all',auth(a))).data;
  assert.equal(exportDoc.documents.length,1);
  assert.equal(exportDoc.documents[0].fields.length,2);
  const preview=await req(env,'/api/backups/import-preview',{method:'POST',...auth(a),data:exportDoc});
  assert.equal(preview.data.preview[0].action,'skip_duplicate');
  const confirmed=await req(env,'/api/backups/import-confirm',{method:'POST',...auth(a),data:{...exportDoc,confirm:'RESTORE_METADATA'}});
  assert.equal(confirmed.data.restored.length,0);
  assert.equal(confirmed.data.remote_syncs_sent,0);
});


test('signed ledger integration requires reviewed fields, uses fixed key and safely retries lost responses',async()=>{
  const env=makeEnv(),user=await boot(env);
  const imp=await req(env,'/api/documents/import/text',{method:'POST',...auth(user),data:{
    retention:'summary',source_type:'text',text:'ご請求金額：1,200円\n納付期限：令和8年11月30日（月)'
  }});
  const id=imp.data.document_id;
  const detail=(await req(env,`/api/documents/${id}`,auth(user))).data.document;
  const money=detail.fields.find(x=>x.field_key==='amount_jpy');
  assert.ok(money);
  const candidates=(await req(env,`/api/documents/${id}/candidates`,auth(user))).data.items;
  const candidate=candidates.find(x=>x.candidate_kind==='finance');assert.ok(candidate);
  const key='attempt_12345678',body={confirm:'CONFIRM_ACCOUNTING',payment_confirmed:true,
    date:'2026-11-12',category:'税金',payment_source:'現金'};
  const options={method:'POST',...auth(user),data:body,extraHeaders:{'Idempotency-Key':key}};
  // Never forward unreviewed amount, even with a correct user confirmation.
  const unreviewed=await req(env,`/api/candidates/${candidate.id}/commit`,options);
  assert.equal(unreviewed.response.status,503); // No service configured; fails closed.
  assert.equal((await req(env,`/api/fields/${money.id}`,{
    method:'PATCH',...auth(user),data:{review_state:'confirmed',normalized_value:'1200'}
  })).response.status,200);
  const actor=env.DB.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
  env.BRIDGE_USER_MAP=JSON.stringify({[actor]:{kakebo:'kakebo-test-owner'}});
  env.KAKEBO_BRIDGE_SECRET='signed-test-secret-strong-enough-123456789';
  const targetWrites=new Map();let callCount=0;
  env.KAKEBO_BRIDGE_SERVICE={async fetch(request){
    const raw=await request.text(),ts=request.headers.get('X-DA-Timestamp');
    assert.equal(request.headers.get('X-DA-Signature'),await hmacHex(env.KAKEBO_BRIDGE_SECRET,`${ts}\n${raw}`));
    const msg=JSON.parse(raw);assert.equal(msg.actor_user_id,'kakebo-test-owner');
    assert.equal(msg.payload.amount,1200);
    assert.equal(msg.idempotency_key,`jda:kakebo:${candidate.id}`);
    callCount++;
    if(!targetWrites.has(msg.idempotency_key))targetWrites.set(msg.idempotency_key,'entry-001');
    if(callCount===1)throw Error('response lost after target already committed');
    return Response.json({ok:true,remote_id:targetWrites.get(msg.idempotency_key),reused:true});
  }};
  const first=await req(env,`/api/candidates/${candidate.id}/commit`,options);
  assert.equal(first.response.status,503);
  const blockedReset=await req(env,`/api/documents/${id}/source-text`,{
    method:'PATCH',...auth(user),data:{text:'ご請求金額：900円',confirm_reset_review:true}
  });
  assert.equal(blockedReset.response.status,409);
  assert.equal(blockedReset.data.code,'INTEGRATION_HISTORY_LOCKED');
  const changed=await req(env,`/api/candidates/${candidate.id}/commit`,{...options,
    data:{...body,date:'2026-11-13'}});
  assert.equal(changed.response.status,409,JSON.stringify(changed.data));
  assert.equal(changed.data.code,'RETRY_PAYLOAD_CHANGED');
  assert.equal(callCount,1);
  assert.equal(env.DB.sql.prepare('SELECT length(request_fingerprint) n FROM integration_links').get().n,64);
  const retry=await req(env,`/api/candidates/${candidate.id}/commit`,options);
  assert.equal(retry.response.status,200,JSON.stringify(retry.data));
  assert.equal(retry.data.remote_id,'entry-001');
  const again=await req(env,`/api/candidates/${candidate.id}/commit`,options);
  assert.equal(again.data.already_synced,true);
  assert.equal(callCount,2);
  assert.equal(targetWrites.size,1);
  const change=await req(env,`/api/fields/${money.id}`,{method:'PATCH',...auth(user),data:{review_state:'corrected',normalized_value:'1300'}});
  assert.equal(change.response.status,409);
  assert.equal(change.data.code,'REMOTE_RECORD_UNCHANGED');
  const confirmedChange=await req(env,`/api/fields/${money.id}`,{method:'PATCH',...auth(user),data:{review_state:'corrected',normalized_value:'1300',confirm_remote_unchanged:true}});
  assert.equal(confirmedChange.response.status,200);
  assert.equal(confirmedChange.data.linked_records_unchanged,true);
  assert.equal(callCount,2); // Never automatically re-post the updated amount.
});


test('known ledger target rejections show safe causes and unknown outcomes stay unknown',async()=>{
 const {classifyBridgeRejection}=await import('../worker/bridge.js');
 const cases=[
  [404,'bridge_disabled','TARGET_BRIDGE_DISABLED'],
  [401,'invalid_signature','TARGET_INVALID_SIGNATURE'],
  [403,'actor_not_allowed','TARGET_ACTOR_NOT_ALLOWED'],
  [400,'payment_source_missing','TARGET_PAYMENT_SOURCE_MISSING'],
  [409,'duplicate_candidate','TARGET_DUPLICATE_CANDIDATE']
 ];
 for(const [status,error,code] of cases){
  const d=classifyBridgeRejection('kakebo',status,{error});
  assert.equal(d.code,code);
  assert.ok(d.message.includes('家計簿'));
 }
 assert.equal(classifyBridgeRejection('kakebo',503,{error:'ledger_write_failed'}),null);
 assert.equal(classifyBridgeRejection('homeflow',404,{error:'bridge_disabled'}),null);
 assert.equal(classifyBridgeRejection('kakebo',403,{error:'private-secret'}).code,'TARGET_FORBIDDEN');
});
test('explicit ledger signature rejection is persisted without changing the replay identity',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
  retention:'summary',source_type:'text',text:'ご請求金額：1,200円\n納付期限：令和8年11月30日（月)'
 }});
 const doc=imported.data.document_id;
 const field=(await req(env,'/api/documents/'+doc,auth(owner))).data.document.fields.find(f=>f.field_key==='amount_jpy');
 await req(env,'/api/fields/'+field.id,{method:'PATCH',...auth(owner),data:{review_state:'confirmed',normalized_value:'1200'}});
 const candidate=(await req(env,'/api/documents/'+doc+'/candidates',auth(owner))).data.items.find(x=>x.candidate_kind==='finance');
 const actor=env.DB.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
 env.BRIDGE_USER_MAP=JSON.stringify({[actor]:{kakebo:'mapped-user'}});
 env.KAKEBO_BRIDGE_SECRET='some-long-secret-for-bridge-tests-123456';
 let called=0;
 env.KAKEBO_BRIDGE_SERVICE={async fetch(){called++;return Response.json({ok:false,error:'invalid_signature'},{status:401});}};
 const options={method:'POST',...auth(owner),data:{
  confirm:'CONFIRM_ACCOUNTING',payment_confirmed:true,date:'2026-11-12',category:'税金',payment_source:'現金'
 },extraHeaders:{'Idempotency-Key':'confirmed_save_12345'}};
 for(let n=0;n<2;n++){
  const result=await req(env,'/api/candidates/'+candidate.id+'/commit',options);
  assert.equal(result.response.status,401);
  assert.equal(result.data.code,'TARGET_INVALID_SIGNATURE');
  assert.equal(env.DB.sql.prepare('SELECT last_error_code FROM integration_links').get().last_error_code,'TARGET_INVALID_SIGNATURE');
 }
 assert.equal(called,2);
 assert.equal(Number(env.DB.sql.prepare('SELECT COUNT(*) AS n FROM integration_links').get().n),1);
});

test('changed failed financial mapping requires signed absence check and explicit owner consent',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
  retention:'summary',source_type:'text',text:'ご請求金額：1,200円\n納付期限：令和8年11月30日（月)'
 }});
 const docId=imported.data.document_id;
 const doc=(await req(env,'/api/documents/'+docId,auth(owner))).data.document;
 const amount=doc.fields.find(x=>x.field_key==='amount_jpy');
 await req(env,'/api/fields/'+amount.id,{method:'PATCH',...auth(owner),
  data:{review_state:'confirmed',normalized_value:'1200'}});
 const candidate=(await req(env,'/api/documents/'+docId+'/candidates',auth(owner))).data.items.find(x=>x.candidate_kind==='finance');
 const actor=env.DB.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
 env.BRIDGE_USER_MAP=JSON.stringify({[actor]:{kakebo:'ledger-owner'}});
 env.KAKEBO_BRIDGE_SECRET='fixture-strong-ledger-secret-123456789';
 const operations=[];
 env.KAKEBO_BRIDGE_SERVICE={async fetch(request){
  const data=JSON.parse(await request.text());
  const operation=data.payload.operation;
  operations.push(operation);
  assert.equal(request.headers.get('Idempotency-Key'),data.idempotency_key);
  if(operation==='lookup')return Response.json({ok:true,exists:false,remote_id:null});
  if(operations.filter(x=>x==='entry').length===1)throw Error('lost first reply');
  return Response.json({ok:true,remote_id:'ledger-entry-123'});
 }};
 const send=body=>req(env,'/api/candidates/'+candidate.id+'/commit',{method:'POST',...auth(owner),
  data:{confirm:'CONFIRM_ACCOUNTING',payment_confirmed:true,date:'2026-11-12',category:'税金',
   payment_source:'現金',...body},extraHeaders:{'Idempotency-Key':'safe-ledger-retry-123'}});
 const original=await send({});
 assert.equal(original.response.status,503);
 assert.equal(original.data.code,'BRIDGE_UNCONFIRMED');
 // Simulate an older settled failure; do not remap an in-flight request.
 env.DB.sql.prepare("UPDATE integration_links SET updated_at='2026-01-01T00:00:00.000Z'").run();
 const changed=await send({category:'饮食料品'});
 assert.equal(changed.response.status,409);
 assert.equal(changed.data.code,'RETRY_PAYLOAD_CHANGED');
 assert.deepEqual(operations,['entry']);
 const recovered=await send({category:'饮食料品',confirm_mapping_change:true});
 assert.equal(recovered.response.status,200,JSON.stringify(recovered.data));
 assert.equal(recovered.data.remote_id,'ledger-entry-123');
 assert.deepEqual(operations,['entry','lookup','entry']);
 const state=env.DB.sql.prepare('SELECT state,attempt_count,remote_id FROM integration_links').get();
 assert.equal(state.state,'synced');
 assert.equal(state.attempt_count,2);
 assert.equal(state.remote_id,'ledger-entry-123');
 assert.equal(Number(env.DB.sql.prepare('SELECT COUNT(*) AS n FROM integration_links').get().n),1);
});

test('recovery lookup finds an existing remote entry and never posts another transaction',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),
  data:{source_type:'text',retention:'summary',text:'ご請求金額：1,200円\n納付期限：令和8年11月30日（月)'}});
 const docId=imported.data.document_id;
 const amount=(await req(env,'/api/documents/'+docId,auth(owner))).data.document.fields.find(x=>x.field_key==='amount_jpy');
 await req(env,'/api/fields/'+amount.id,{method:'PATCH',...auth(owner),
  data:{review_state:'confirmed',normalized_value:'1200'}});
 const candidate=(await req(env,'/api/documents/'+docId+'/candidates',auth(owner))).data.items.find(x=>x.candidate_kind==='finance');
 const actor=env.DB.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
 env.BRIDGE_USER_MAP=JSON.stringify({[actor]:{kakebo:'ledger-owner'}});
 env.KAKEBO_BRIDGE_SECRET='fixture-strong-ledger-secret-123456789';
 let entryCalls=0,lookupCalls=0;
 env.KAKEBO_BRIDGE_SERVICE={async fetch(request){
  const operation=JSON.parse(await request.text()).payload.operation;
  if(operation==='lookup'){lookupCalls++;return Response.json({ok:true,exists:true,remote_id:'prior-entry-01'});}
  entryCalls++;
  throw Error('prior write completed but response lost');
 }};
 const send=opts=>req(env,'/api/candidates/'+candidate.id+'/commit',{method:'POST',...auth(owner),
  data:{confirm:'CONFIRM_ACCOUNTING',payment_confirmed:true,date:'2026-11-12',
   category:'税金',payment_source:'現金',...opts},extraHeaders:{'Idempotency-Key':'safe-ledger-retry-123'}});
 assert.equal((await send({})).response.status,503);
 env.DB.sql.prepare("UPDATE integration_links SET updated_at='2026-01-01T00:00:00.000Z'").run();
 const reconciled=await send({category:'饮食料品',confirm_mapping_change:true});
 assert.equal(reconciled.response.status,200,JSON.stringify(reconciled.data));
 assert.equal(reconciled.data.recovered_prior,true);
 assert.equal(reconciled.data.already_synced,true);
 assert.equal(entryCalls,1);
 assert.equal(lookupCalls,1);
 const state=env.DB.sql.prepare('SELECT state,attempt_count,remote_id FROM integration_links').get();
 assert.equal(state.state,'linked_existing');
 assert.equal(state.attempt_count,1);
 assert.equal(state.remote_id,'prior-entry-01');
});

test('invalid calendar dates are rejected during manual verification',async()=>{
  const env=makeEnv(),user=await boot(env);
  const imp=await req(env,'/api/documents/import/text',{method:'POST',...auth(user),data:{
    retention:'summary',source_type:'text',text:'納付期限：令和8年2月28日\n納付金額：1,200円'
  }});
  const doc=(await req(env,`/api/documents/${imp.data.document_id}`,auth(user))).data.document;
  const deadline=doc.fields.find(x=>x.field_key==='due_date');
  assert.ok(deadline);
  const invalid=await req(env,`/api/fields/${deadline.id}`,{method:'PATCH',...auth(user),data:{review_state:'corrected',normalized_value:'2026-02-30'}});
  assert.equal(invalid.response.status,400);
  const valid=await req(env,`/api/fields/${deadline.id}`,{method:'PATCH',...auth(user),data:{review_state:'confirmed',normalized_value:'2026-02-28'}});
  assert.equal(valid.response.status,200);
});

test('permanent document deletion preserves an R2 object still referenced elsewhere',async()=>{
  const env=makeEnv(),user=await boot(env);
  const add=()=>{const f=new FormData();f.append('file',new File([new Uint8Array([255,216,255,224,1,2,3,4])],'same.jpg',{type:'image/jpeg'}));f.append('retention','original');return f;};
  const first=await req(env,'/api/documents/import/file',{method:'POST',...auth(user),form:add()});
  assert.equal(first.response.status,201);
  const oldId=first.data.document_id;
  assert.equal((await req(env,`/api/documents/${oldId}/trash`,{method:'POST',...auth(user),data:{}})).response.status,200);
  const second=await req(env,'/api/documents/import/file',{method:'POST',...auth(user),form:add()});
  assert.equal(second.response.status,201);
  assert.notEqual(second.data.document_id,oldId);
  assert.equal(env._blobs.size,1);
  const removed=await req(env,`/api/documents/${oldId}/permanent-delete`,{method:'POST',...auth(user),data:{confirm:'DELETE_FOREVER'}});
  assert.equal(removed.response.status,200,JSON.stringify(removed.data));
  assert.equal(removed.data.r2_deleted_objects,0);
  assert.equal(env._blobs.size,1);
  const current=(await req(env,`/api/documents/${second.data.document_id}`,auth(user))).data.document;
  assert.equal(current.attachments.length,1);
  assert.equal((await req(env,`/api/documents/${second.data.document_id}/attachments/${current.attachments[0].id}/content`,auth(user))).response.status,200);
});


test('a second use of an invite cannot create a user, including racing join attempts',async()=>{
  const env=makeEnv(),owner=await boot(env);
  const invite=await req(env,'/api/household/invites',{method:'POST',...auth(owner),data:{invitee_email:'family@example.com'}});
  assert.equal(invite.response.status,201);
  const join=()=>req(env,'/api/household/join',{method:'POST',data:{invite_token:invite.data.invite_token,email:'family@example.com',password:'another-long-password',display_name:'家人'}});
  const [a,b]=await Promise.all([join(),join()]);
  assert.deepEqual([a.response.status,b.response.status].sort(),[201,409]);
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) count FROM users').get().count,2);
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) count FROM password_credentials').get().count,2);
});


test('ZIP + original R2 roundtrip restores missing originals without duplicating metadata',async()=>{
  const source=makeEnv(),owner=await boot(source);
  const bytes=new Uint8Array([255,216,255,224,10,20,30,40]);
  const form=new FormData();form.append('file',new File([bytes],'original.jpg',{type:'image/jpeg'}));form.append('retention','original');
  const imported=await req(source,'/api/documents/import/file',{method:'POST',...auth(owner),form});
  assert.equal(imported.response.status,201);
  const sourceId=imported.data.document_id;
  const archive=(await req(source,'/api/backups/export?scope=all',auth(owner))).data;
  const a=archive.documents[0].attachments[0];
  a.backup_path=`originals/${sourceId}/${a.id}.jpg`;
  archive.includes_originals=true;
  const original=await req(source,`/api/backups/original/${sourceId}/${a.id}`,auth(owner));
  assert.equal(original.response.status,200);
  const originalBytes=new Uint8Array(await original.response.arrayBuffer());
  const zip=createZip([{name:'manifest.json',bytes:JSON.stringify(archive)},{name:a.backup_path,bytes:originalBytes}]);
  const parsed=await readBackup(new File([zip],'family.zip',{type:'application/zip'}));
  assert.equal(parsed.data.documents.length,1);
  const target=makeEnv(),restoreOwner=await boot(target);
  const api=async (path,options={})=>{
    const isForm=options.body instanceof FormData;
    const r=await req(target,path,{method:options.method||'GET',...auth(restoreOwner),
      ...(isForm?{form:options.body}:{data:options.body})});
    if(!r.response.ok)throw Error(`${path}: ${JSON.stringify(r.data)}`);
    return r.data;
  };
  // Simulate a previous metadata-only restore. A later ZIP containing originals
  // must still upload those originals, not skip them as a duplicate document.
  const metadata=await api('/api/backups/import-confirm',{method:'POST',body:{...archive,confirm:'RESTORE_METADATA'}});
  assert.equal(metadata.restored.length,1);
  const first=await restoreBatch(api,parsed,true);
  assert.equal(first.metadata_restored,0);
  assert.equal(first.already_existed,1);
  assert.equal(first.originals_restored,1);
  assert.deepEqual(first.failures,[]);
  const docId=metadata.restored[0];
  const saved=(await api(`/api/documents/${docId}`)).document;
  assert.equal(saved.attachments.length,1);
  const savedId=saved.attachments[0].id;
  const read=await req(target,`/api/documents/${docId}/attachments/${savedId}/content`,auth(restoreOwner));
  assert.deepEqual(new Uint8Array(await read.response.arrayBuffer()),bytes);
  const again=await restoreBatch(api,parsed,true);
  assert.equal(again.originals_restored,0);
  assert.equal(again.already_restored_originals,1);
  assert.equal(target._blobs.size,1);
  // Simulate a lost physical R2 object while metadata remains. A verified user
  // backup must recover bytes instead of falsely reporting already-restored.
  const key=[...target._blobs.keys()][0];target._blobs.delete(key);
  const recovered=await restoreBatch(api,parsed,true);
  assert.equal(recovered.originals_restored,1);
  assert.equal(target._blobs.size,1);
  assert.deepEqual(target._blobs.get(key),bytes);
});


test('HomeFlow delegated assignee explicitly carries bonus and synced status survives bridge disconnect',async()=>{
  const env=makeEnv(),owner=await boot(env);
  const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
    retention:'summary',source_type:'text',text:'納付期限：令和8年11月30日'
  }});
  const id=imported.data.document_id;
  const doc=(await req(env,`/api/documents/${id}`,auth(owner))).data.document;
  const shared=await req(env,`/api/documents/${id}`,{method:'PATCH',...auth(owner),data:{visibility:'shared',version:doc.version,confirm_sensitive_share:true}});
  assert.equal(shared.response.status,200);
  const deadline=doc.fields.find(x=>x.field_key==='due_date');
  assert.equal((await req(env,`/api/fields/${deadline.id}`,{method:'PATCH',...auth(owner),data:{review_state:'confirmed',normalized_value:'2026-11-30'}})).response.status,200);
  const candidates=(await req(env,`/api/documents/${id}/candidates`,auth(owner))).data.items;
  const task=candidates.find(x=>x.candidate_kind==='homeflow_task');assert.ok(task);
  const actor=env.DB.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
  env.BRIDGE_USER_MAP=JSON.stringify({[actor]:{homeflow:'homeflow_owner_123'}});
  env.HOMEFLOW_BRIDGE_SECRET='homeflow-test-secret-with-enough-entropy-1234';
  let calls=0;
  env.HOMEFLOW_BRIDGE_SERVICE={async fetch(r){
    const raw=await r.text(),stamp=r.headers.get('X-DA-Timestamp');
    assert.equal(r.headers.get('X-DA-Signature'),await hmacHex(env.HOMEFLOW_BRIDGE_SECRET,`${stamp}\n${raw}`));
    const msg=JSON.parse(raw);
    assert.equal(msg.actor_user_id,'homeflow_owner_123');
    assert.equal(msg.payload.visibility,'household');
    assert.equal(msg.payload.assignee,'other_household_user');
    assert.equal(msg.payload.bonusPoints,2);
    assert.equal(msg.idempotency_key,`jda:homeflow:${task.id}`);
    calls++;
    return Response.json({ok:true,remote_id:'homeflow-task-id',reused:false});
  }};
  const preview=(await req(env,`/api/candidates/${task.id}/preview`,auth(owner))).data;
  assert.equal(preview.account_mapping_ready,true);
  const body={confirm:'CONFIRM_TASK',title:'确认缴费',visibility:'household',assignee:'other_household_user',bonus_points:2};
  const opts={method:'POST',...auth(owner),data:body,extraHeaders:{'Idempotency-Key':'homeflow_test_request_123'}};
  const sent=await req(env,`/api/candidates/${task.id}/commit`,opts);
  assert.equal(sent.response.status,200,JSON.stringify(sent.data));
  assert.equal(calls,1);
  delete env.HOMEFLOW_BRIDGE_SECRET;delete env.HOMEFLOW_BRIDGE_SERVICE;
  const repeat=await req(env,`/api/candidates/${task.id}/commit`,opts);
  assert.equal(repeat.data.already_synced,true);
  assert.equal(calls,1);
});

test('private document can create private or explicitly confirmed family HomeFlow task without exposing source',async()=>{
 for(const visibility of ['private','household']){
  const env=makeEnv(),owner=await boot(env);
  const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
   title:'私人银行文件（不要共享）',retention:'summary',source_type:'text',
   text:'納付期限：令和8年11月30日（月）\n銀行口座番号 1234567890123456'
  }});
  assert.equal(imported.response.status,201,JSON.stringify(imported.data));
  const id=imported.data.document_id;
  const doc=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
  assert.equal(doc.visibility,'private');
  const due=doc.fields.find(field=>field.field_key==='due_date');
  assert.ok(due);
  const reviewed=await req(env,'/api/fields/'+due.id,{method:'PATCH',...auth(owner),
   data:{review_state:'confirmed',normalized_value:'2026-11-30'}});
  assert.equal(reviewed.response.status,200,JSON.stringify(reviewed.data));
  const items=(await req(env,'/api/documents/'+id+'/candidates',auth(owner))).data.items;
  const task=items.find(item=>item.candidate_kind==='homeflow_task');
  assert.ok(task,'a reviewed deadline has a HomeFlow task candidate');
  const actor=env.DB.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
  env.BRIDGE_USER_MAP=JSON.stringify({[actor]:{homeflow:'homeflow_owner_123'}});
  env.HOMEFLOW_BRIDGE_SECRET='test-homeflow-private-family-secret-123456';
  const requests=[];
  env.HOMEFLOW_BRIDGE_SERVICE={async fetch(request){
   const msg=JSON.parse(await request.text());
   requests.push(msg);
   return Response.json({ok:true,remote_id:'homeflow-task-'+visibility});
  }};
  const data={confirm:'CONFIRM_TASK',title:'确认缴费',visibility};
  const send=updates=>req(env,'/api/candidates/'+task.id+'/commit',{method:'POST',...auth(owner),
   data:{...data,...updates},extraHeaders:{'Idempotency-Key':'homeflow-confirm-'+visibility+'-123'}});
  if(visibility==='household'){
   const unconfirmed=await send({});
   assert.equal(unconfirmed.response.status,409,JSON.stringify(unconfirmed.data));
   assert.equal(unconfirmed.data.code,'TASK_SHARE_CONFIRM_REQUIRED');
   assert.equal(requests.length,0,'no remote request before explicit family sharing consent');
  }
  const success=await send({task_share_confirmed:visibility==='household'});
  assert.equal(success.response.status,200,JSON.stringify(success.data));
  assert.equal(requests.length,1);
  assert.equal(requests[0].payload.visibility,visibility);
  assert.equal(requests[0].payload.title,'确认缴费');
  assert.equal(requests[0].payload.dueOn,'2026-11-30');
  assert.equal('task_share_confirmed' in requests[0].payload,false);
  assert.equal(JSON.stringify(requests[0].payload).includes('1234567890123456'),false);
  assert.equal(JSON.stringify(requests[0].payload).includes('私人银行文件'),false);
  const stillPrivate=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
  assert.equal(stillPrivate.visibility,'private');
  const retry=await send({task_share_confirmed:visibility==='household'});
  assert.equal(retry.data.already_synced,true);
  assert.equal(requests.length,1,'already synced task cannot duplicate');
 }
});

test('Pending endpoint preserves review or due-date filtering and excludes archived records',async()=>{
 const env=makeEnv(),owner=await boot(env);
 async function importDoc(title,text){
  const created=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),
   data:{title,text,source_type:'text',retention:'summary'}});
  assert.equal(created.response.status,201,JSON.stringify(created.data));
  return created.data.document_id;
 }
 const reviewed=await importDoc('需要核验','纳付金額：1200円');
 const due=await importDoc('到期文书','納付期限：令和8年11月30日（月）');
 const regular=await importDoc('普通文书','こんにちは。何もありません。');
 const archived=await importDoc('归档文书','納付期限：令和8年12月15日（火）');
 env.DB.sql.prepare("UPDATE documents SET analysis_status='ready' WHERE id IN (?,?)").run(due,regular);
 env.DB.sql.prepare("DELETE FROM document_fields WHERE document_id=?").run(regular);
 env.DB.sql.prepare("UPDATE documents SET archived_at='2026-11-13T01:00:00Z' WHERE id=?").run(archived);
 const result=await req(env,'/api/today?limit=10',auth(owner));
 assert.equal(result.response.status,200,JSON.stringify(result.data));
 const ids=result.data.items.map(d=>d.id);
 assert.ok(ids.includes(reviewed),'needs-review document remains Pending');
 assert.ok(ids.includes(due),'due-date document remains Pending');
 assert.ok(!ids.includes(regular),'unreviewed flag cleared and no due date does not qualify');
 assert.ok(!ids.includes(archived),'archived document is not Pending');
});
test('simultaneous permanent document deletions cannot abandon a shared R2 object',async()=>{
  const env=makeEnv(),owner=await boot(env);
  const form=()=>{const f=new FormData();f.append('file',new File([new Uint8Array([255,216,255,224,24,50,76])],'same.jpg',{type:'image/jpeg'}));f.append('retention','original');return f;};
  const one=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:form()});
  assert.equal(one.response.status,201);
  assert.equal((await req(env,`/api/documents/${one.data.document_id}/trash`,{method:'POST',...auth(owner),data:{}})).response.status,200);
  const two=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:form()});
  assert.equal(two.response.status,201);
  assert.equal(env._blobs.size,1);
  assert.equal((await req(env,`/api/documents/${two.data.document_id}/trash`,{method:'POST',...auth(owner),data:{}})).response.status,200);
  const [a,b]=await Promise.all([one,two].map(x=>req(env,`/api/documents/${x.data.document_id}/permanent-delete`,{method:'POST',...auth(owner),data:{confirm:'DELETE_FOREVER'}})));
  assert.deepEqual([a.response.status,b.response.status],[200,200],JSON.stringify([a.data,b.data]));
  assert.equal(env._blobs.size,0,'the final shared object must be physically deleted');
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM storage_objects').get().n,0);
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM deletion_jobs').get().n,0);
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM attachments').get().n,0);
});

test('simultaneous attachment deletions converge on one physical R2 cleanup',async()=>{
  const env=makeEnv(),owner=await boot(env);
  const form=()=>{const f=new FormData();f.append('file',new File([new Uint8Array([255,216,255,224,12,34,56])],'same.jpg',{type:'image/jpeg'}));f.append('retention','original');return f;};
  const first=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:form()});
  const docId=first.data.document_id;
  const second=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{source_type:'text',retention:'summary',text:'別の文書'} });
  assert.equal(second.response.status,201);
  const doc2=second.data.document_id;
  const added=await req(env,`/api/documents/${doc2}/attachments`,{method:'POST',...auth(owner),form:form()});
  assert.equal(added.response.status,201,JSON.stringify(added.data));
  const firstDoc=(await req(env,`/api/documents/${docId}`,auth(owner))).data.document;
  const id1=firstDoc.attachments[0].id,id2=added.data.attachment_id;
  for(const [doc,aid] of [[docId,id1],[doc2,id2]]){
    assert.equal((await req(env,`/api/documents/${doc}/attachments/${aid}/trash`,{method:'POST',...auth(owner),data:{}})).response.status,200);
  }
  const [a,b]=await Promise.all([[docId,id1],[doc2,id2]].map(([doc,aid])=>
    req(env,`/api/documents/${doc}/attachments/${aid}/permanent-delete`,{method:'POST',...auth(owner),data:{confirm:'DELETE_FOREVER'}})));
  assert.deepEqual([a.response.status,b.response.status],[200,200],JSON.stringify([a.data,b.data]));
  assert.equal(env._blobs.size,0);
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM storage_objects').get().n,0);
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM deletion_jobs').get().n,0);
});


test('user-selected EML is decoded in RAM, then explicitly imported as private text without R2 reads',async()=>{
  const env=makeEnv(),owner=await boot(env);
  const body=[
    'From: issuer@example.invalid','Subject: =?UTF-8?B?5pSv5omV44GE6YCa55/O?=',
    'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','',
    '納付期限：令和8年11月30日','ご請求金額：1,200円'
  ].join('\r\n');
  const file=new File([body],'mail.eml',{type:'message/rfc822'});
  const parsed=await readLocalText(file);
  assert.equal(parsed.source_type,'mail_forward');
  assert.equal(env._blobs.size,0); // File selection / parsing alone does no upload.
  const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
    title:parsed.title,text:parsed.text,source_type:parsed.source_type,retention:'summary'
  }});
  assert.equal(imported.response.status,201,JSON.stringify(imported.data));
  const detail=(await req(env,`/api/documents/${imported.data.document_id}`,auth(owner))).data.document;
  assert.equal(detail.visibility,'private');
  assert.ok(detail.fields.some(f=>f.field_key==='due_date'));
  assert.ok(detail.fields.some(f=>f.field_key==='amount_jpy'));
  assert.equal(env.DB.sql.prepare('SELECT source_type FROM document_sources LIMIT 1').get().source_type,'mail_forward');
  assert.equal(env._blobs.size,0);
});


test('owner reorders active attachment IDs with version CAS; no R2 operation',async()=>{
  const env=makeEnv(),owner=await boot(env);
  const form=bytes=>{const f=new FormData();f.append('file',new File([new Uint8Array([255,216,255,224,...bytes])],`page-${bytes[0]}.jpg`,{type:'image/jpeg'}));f.append('retention','original');return f;};
  const first=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:form([11,22])});
  const id=first.data.document_id;
  assert.equal((await req(env,`/api/documents/${id}/attachments`,{method:'POST',...auth(owner),form:form([33,44])})).response.status,201);
  const before=(await req(env,`/api/documents/${id}`,auth(owner))).data.document;
  assert.deepEqual(before.attachments.map(x=>x.mime),['image/jpeg','image/jpeg']);
  const ids=before.attachments.map(x=>x.id);
  assert.equal(ids.length,2);
  let r2Reads=0,r2Writes=0;
  const originals={...env.DOCUMENTS};
  env.DOCUMENTS.get=async(...args)=>{r2Reads++;return originals.get(...args)};
  env.DOCUMENTS.put=async(...args)=>{r2Writes++;return originals.put(...args)};
  const update=()=>req(env,`/api/documents/${id}/attachments/order`,{method:'PATCH',...auth(owner),data:{version:before.version,attachment_ids:[ids[1],ids[0]]}});
  const result=await update();
  assert.equal(result.response.status,200,JSON.stringify(result.data));
  const after=(await req(env,`/api/documents/${id}`,auth(owner))).data.document;
  assert.deepEqual(after.attachments.map(x=>x.id),[ids[1],ids[0]]);
  assert.equal(after.version,before.version+1);
  const repeat=await update();assert.equal(repeat.response.status,409);
  const invalid=await req(env,`/api/documents/${id}/attachments/order`,{method:'PATCH',...auth(owner),data:{version:after.version,attachment_ids:[ids[0],ids[0]]}});
  assert.equal(invalid.response.status,400);
  assert.equal(r2Reads,0);assert.equal(r2Writes,0);
});


test('DOCX text-layer analysis and optional R2 original respect user retention choice',async()=>{
  const {fileOf}=await import('./helpers/office-fixture.js');
  const {extractOfficeFile}=await import('../web/src/document-text.js');
  const file=await fileOf('notice.docx',[
    ['word/document.xml','<w:document><w:p><w:t>納付期限：2026年11月30日</w:t></w:p><w:p><w:t>ご請求金額：1200円</w:t></w:p></w:document>']
  ]);
  const parsed=await extractOfficeFile(file);
  const env=makeEnv(),owner=await boot(env);
  const summary=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
    title:file.name,text:parsed.text,source_type:'local_file',retention:'summary'
  }});
  assert.equal(summary.response.status,201,JSON.stringify(summary.data));
  assert.equal(env._blobs.size,0);
  const b=new FormData();b.append('file',file);b.append('retention','original');b.append('extracted_text',parsed.text);
  const saved=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:b});
  assert.equal(saved.response.status,201,JSON.stringify(saved.data));
  assert.equal(saved.data.text_layer_used,true);
  assert.equal(env._blobs.size,1);
  const doc=(await req(env,'/api/documents/'+saved.data.document_id,auth(owner))).data.document;
  assert.equal(doc.visibility,'private');
  assert.ok(doc.fields.some(x=>x.field_key==='due_date'));
  assert.ok(doc.fields.some(x=>x.field_key==='amount_jpy'));
  const fake=new File([new Uint8Array([80,75,3,4,0,0])],'fake.docx',
    {type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
  const bad=new FormData();bad.append('file',fake);bad.append('retention','original');
  const rejected=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:bad});
  assert.equal(rejected.response.status,415);
  assert.equal(env._blobs.size,1);
});

test('Office original with corrupt compressed XML is denied before any R2 put',async()=>{
 const {fileOf}=await import('./helpers/office-fixture.js');
 const env=makeEnv(),owner=await boot(env);
 const bad=await fileOf('corrupt.docx',[
  ['word/document.xml','<!DOCTYPE x [<!ENTITY s SYSTEM "file:///etc/passwd">]><w:document>&s;</w:document>']
 ],true);
 const f=new FormData();f.append('file',bad);f.append('retention','original');
 const result=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:f});
 assert.equal(result.response.status,415);
 assert.equal(env._blobs.size,0);
 assert.equal(Number(env.DB.sql.prepare('SELECT COUNT(*) AS n FROM storage_objects').get().n),0);
});

test('policy source date stays distinct from official verification through encrypted-free metadata backup',async()=>{
 const source=makeEnv(),owner=await boot(source);
 const text='発行日：令和8年11月11日（水）\n改正条例は令和8年12月1日（火）施行。\n対象外の条件に注意。';
 const imported=await req(source,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
  text,title:'条例確認',retention:'summary',source_type:'text'
 }});
 assert.equal(imported.response.status,201,JSON.stringify(imported.data));
 const detail=(await req(source,'/api/documents/'+imported.data.document_id,auth(owner))).data.document;
 assert.equal(detail.source_document_date,'2026-11-11');
 assert.match(detail.source_date_quote,/発行日/);
 assert.equal(detail.official_current_verified_at,null);
 assert.match(detail.explanation_zh,/官方现行有效性：尚未核验/);
 const exported=(await req(source,'/api/backups/export?scope=all',auth(owner))).data;
 assert.equal(exported.documents[0].document.source_document_date,'2026-11-11');
 exported.documents[0].document.official_current_verified_at='2099-01-01T00:00:00Z'; // Forged backup claim must be ignored.
 const target=makeEnv(),recipient=await boot(target);
 const restore=await req(target,'/api/backups/import-confirm',{method:'POST',...auth(recipient),
  data:{...exported,confirm:'RESTORE_METADATA'}});
 assert.equal(restore.response.status,200,JSON.stringify(restore.data));
 const restoredId=restore.data.restored[0];
 const verified=(await req(target,'/api/documents/'+restoredId,auth(recipient))).data.document;
 assert.equal(verified.source_document_date,'2026-11-11');
 assert.equal(verified.official_current_verified_at,null);
});


test('OCR same-image candidate cache prevents duplicate AI and R2 calls; no financial fields auto-approved',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const raw=new Uint8Array([255,216,255,224,12,9,18,48,71,45,55,90]);
 const f=new FormData();f.append('file',new File([raw],'private.jpg',{type:'image/jpeg'}));f.append('retention','original');
 const uploaded=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:f});
 assert.equal(uploaded.response.status,201,JSON.stringify(uploaded.data));
 const id=uploaded.data.document_id;
 const doc=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
 const aid=doc.attachments[0].id;
 env.ENABLE_EXPERIMENTAL_OCR='true';
 env.OCR_CALLS_PER_USER_DAY='2';
 let aiCalls=0,r2Reads=0;
 env.AI={async run(model,input){
   aiCalls++;assert.ok(input.image.startsWith('data:image/jpeg;base64,'));
   assert.equal(input.task,'query');assert.equal(input.reasoning,false);
   return {answer:'納付期限：令和8年11月30日\n請求金額：1,200円',metrics:{input_tokens:300,output_tokens:55}};
 }};
 env.DOCUMENTS.get=async key=>{
   r2Reads++;
   const stored=env._blobs.get(key);
   return stored?{arrayBuffer:async()=>stored.buffer.slice(stored.byteOffset,stored.byteOffset+stored.byteLength)}:null;
 };
 const body={method:'POST',...auth(owner),data:{confirm:true,attachment_id:aid}};
 const first=await req(env,'/api/documents/'+id+'/ocr',body);
 assert.equal(first.response.status,200,JSON.stringify(first.data));
 assert.equal(first.data.cached,false);
 assert.equal(first.data.verified,false);
 assert.equal(first.data.needs_human_review,true);
 assert.ok(first.data.usage.neurons_estimated>0);
 const second=await req(env,'/api/documents/'+id+'/ocr',body);
 assert.equal(second.response.status,200,JSON.stringify(second.data));
 assert.equal(second.data.cached,true);
 assert.equal(second.data.text,first.data.text);
 assert.equal(aiCalls,1);assert.equal(r2Reads,1);
 assert.equal(env.DB.sql.prepare("SELECT state FROM ocr_attempts").get().state,'success');
 assert.equal(env.DB.sql.prepare("SELECT ai_calls FROM usage_daily").get().ai_calls,1);
 const unchanged=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
 assert.equal(unchanged.extracted_text_ja,null);
 assert.equal(unchanged.fields.length,0);
 assert.equal((await req(env,'/api/documents/'+id+'/attachments/'+aid+'/trash',
  {method:'POST',...auth(owner),data:{}})).response.status,200);
 const gone=await req(env,'/api/documents/'+id+'/attachments/'+aid+'/permanent-delete',
  {method:'POST',...auth(owner),data:{confirm:'DELETE_FOREVER'}});
 assert.equal(gone.response.status,200,JSON.stringify(gone.data));
 assert.equal(env.DB.sql.prepare("SELECT COUNT(*) n FROM ocr_attempts").get().n,0);
});
test('empty OCR response is cached without fake text and cannot repeatedly consume AI quota',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const raw=new Uint8Array([255,216,255,224,10,20,30,40]);
 const f=new FormData();f.append('file',new File([raw],'small.jpg',{type:'image/jpeg'}));f.append('retention','original');
 const uploaded=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:f});
 const id=uploaded.data.document_id;
 const detail=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
 const aid=detail.attachments[0].id;
 env.ENABLE_EXPERIMENTAL_OCR='true';
 let calls=0,r2Reads=0;
 env.AI={async run(){calls++;return {success:true,result:{}};}};
 env.DOCUMENTS.get=async key=>{
  r2Reads++;const b=env._blobs.get(key);
  return {arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.length)};
 };
 const options={method:'POST',...auth(owner),data:{confirm:true,attachment_id:aid}};
 const first=await req(env,'/api/documents/'+id+'/ocr',options);
 assert.equal(first.response.status,422,JSON.stringify(first.data));
 assert.equal(first.data.code,'OCR_EMPTY');
 const repeated=await req(env,'/api/documents/'+id+'/ocr',options);
 assert.equal(repeated.response.status,422);
 assert.equal(repeated.data.code,'OCR_EMPTY_CACHED');
 assert.equal(calls,1);assert.equal(r2Reads,1);
 assert.equal(env.DB.sql.prepare("SELECT state,candidate_text_ja FROM ocr_attempts").get().candidate_text_ja,null);
 assert.equal(env.DB.sql.prepare("SELECT ai_calls FROM usage_daily").get().ai_calls,1);
});
test('wrong-owner OCR access cannot read R2 or model and empty quota never fetches original',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const f=new FormData();f.append('file',new File([new Uint8Array([255,216,255,224,17])],'x.jpg',{type:'image/jpeg'}));f.append('retention','original');
 const up=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:f});
 const id=up.data.document_id;
 const aid=(await req(env,'/api/documents/'+id,auth(owner))).data.document.attachments[0].id;
 const invited=await req(env,'/api/household/invites',{method:'POST',...auth(owner),data:{invitee_email:'b@example.invalid'}});
 const joined=await req(env,'/api/household/join',{method:'POST',data:{invite_token:invited.data.invite_token,email:'b@example.invalid',password:'member-long-secret123'}});
 const other={cookie:joined.response.headers.get('set-cookie').split(';')[0],csrf:joined.data.csrf_token};
 env.ENABLE_EXPERIMENTAL_OCR='true';env.OCR_CALLS_PER_USER_DAY='0';
 let reads=0,calls=0;
 env.AI={async run(){calls++;return {answer:'日本語テキスト'};}};
 env.DOCUMENTS.get=async()=>{reads++;throw Error('must not be read')};
 const badOwner=await req(env,'/api/documents/'+id+'/ocr',{method:'POST',...auth(other),data:{confirm:true,attachment_id:aid}});
 assert.equal(badOwner.response.status,404);
 const budget=await req(env,'/api/documents/'+id+'/ocr',{method:'POST',...auth(owner),data:{confirm:true,attachment_id:aid}});
 assert.equal(budget.response.status,503);
 assert.equal(budget.data.code,'OCR_BUDGET_DISABLED');
 assert.equal(reads,0);assert.equal(calls,0);
});


test('verified DOCX, XLSX and PPTX originals restore to D1/R2 only once per SHA',async()=>{
 const {fileOf}=await import('./helpers/office-fixture.js');
 const env=makeEnv(),owner=await boot(env);
 const doc=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
   source_type:'text',retention:'summary',title:'演示文稿备份恢复测试',text:'納付期限：2026年11月30日\n金額：1200円'
 }});
 assert.equal(doc.response.status,201);
 const id=doc.data.document_id;
 const files=[
  await fileOf('report.docx',[['word/document.xml','<w:document><w:p><w:t>日本語説明書</w:t></w:p></w:document>']],true),
  await fileOf('report.xlsx',[['xl/workbook.xml','<workbook/>'],['xl/worksheets/sheet1.xml','<worksheet><c r="A1" t="inlineStr"><is><t>納付期限</t></is></c></worksheet>']],true),
  await fileOf('report.pptx',[['ppt/presentation.xml','<p:presentation/>'],['ppt/slides/slide1.xml','<p:sld><p:sp><a:t>対象外の条件</a:t></p:sp></p:sld>']],true)
 ];
 for(const file of files){
  const bytes=new Uint8Array(await file.arrayBuffer());
  const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const form=()=>{const f=new FormData();f.append('file',file);f.append('sha256',sha);f.append('label',file.name);return f;};
  const first=await req(env,`/api/documents/${id}/attachments/restore-upload`,
    {method:'POST',...auth(owner),form:form()});
  assert.equal(first.response.status,201,JSON.stringify(first.data));
  const count=env._blobs.size;
  const replay=await req(env,`/api/documents/${id}/attachments/restore-upload`,
    {method:'POST',...auth(owner),form:form()});
  assert.equal(replay.response.status,200,JSON.stringify(replay.data));
  assert.equal(replay.data.already_restored,true);
  assert.equal(env._blobs.size,count);
 }
 assert.equal(env._blobs.size,3);
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM attachments').get().n,3);
});


test('R2 DELETE succeeds but document D1 cleanup fails: retry converges without orphan index',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const form=new FormData();
 form.append('file',new File([new Uint8Array([255,216,255,224,11,8,7,6])],'remove.jpg',{type:'image/jpeg'}));
 form.append('retention','original');
 const created=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form});
 const id=created.data.document_id;
 assert.equal(created.response.status,201);
 await req(env,'/api/documents/'+id+'/trash',{method:'POST',...auth(owner),data:{}});
 const priorBatch=env.DB.batch.bind(env.DB);
 let deletionCount=0,failOnce=true;
 const priorDelete=env.DOCUMENTS.delete.bind(env.DOCUMENTS);
 env.DOCUMENTS.delete=async key=>{deletionCount++;await priorDelete(key)};
 env.DB.batch=async statements=>{
  if(deletionCount>0&&failOnce){failOnce=false;throw Error('D1 unavailable AFTER R2 DELETE');}
  return priorBatch(statements);
 };
 const first=await req(env,'/api/documents/'+id+'/permanent-delete',{
  method:'POST',...auth(owner),data:{confirm:'DELETE_FOREVER'}
 });
 assert.equal(first.response.status,503,JSON.stringify(first.data));
 assert.equal(first.data.code,'METADATA_CLEANUP_FAILED');
 assert.equal(env._blobs.size,0);
 assert.equal(env.DB.sql.prepare("SELECT lifecycle FROM documents WHERE id=?").get(id).lifecycle,'deletion_pending');
 assert.equal(env.DB.sql.prepare("SELECT state FROM storage_objects").get().state,'deletion_pending');
 assert.equal(env.DB.sql.prepare("SELECT COUNT(*) n FROM deletion_jobs").get().n,1);
 const retry=await req(env,'/api/documents/'+id+'/permanent-delete',{
  method:'POST',...auth(owner),data:{confirm:'DELETE_FOREVER'}
 });
 assert.equal(retry.response.status,200,JSON.stringify(retry.data));
 assert.equal(env.DB.sql.prepare("SELECT COUNT(*) n FROM documents").get().n,0);
 assert.equal(env.DB.sql.prepare("SELECT COUNT(*) n FROM storage_objects").get().n,0);
 assert.equal(env.DB.sql.prepare("SELECT COUNT(*) n FROM deletion_jobs").get().n,0);
 assert.equal(env._blobs.size,0);
 assert.equal(deletionCount,2); // precise same-key DELETE is idempotent
});
test('R2 DELETE succeeds but attachment cleanup fails: retry physically and logically removes it',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const form=new FormData();
 form.append('file',new File([new Uint8Array([255,216,255,224,91,82,73,64])],'delete.jpg',{type:'image/jpeg'}));
 form.append('retention','original');
 const uploaded=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form});
 const id=uploaded.data.document_id;
 const doc=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
 const aid=doc.attachments[0].id;
 await req(env,'/api/documents/'+id+'/attachments/'+aid+'/trash',{
  method:'POST',...auth(owner),data:{}
 });
 const originalBatch=env.DB.batch.bind(env.DB);
 const originalDelete=env.DOCUMENTS.delete.bind(env.DOCUMENTS);
 let deleted=false,failing=true;
 env.DOCUMENTS.delete=async key=>{deleted=true;await originalDelete(key)};
 env.DB.batch=async statements=>{
  if(deleted&&failing){failing=false;throw Error('D1 commit failed');}
  return originalBatch(statements);
 };
 const first=await req(env,'/api/documents/'+id+'/attachments/'+aid+'/permanent-delete',{
  method:'POST',...auth(owner),data:{confirm:'DELETE_FOREVER'}
 });
 assert.equal(first.response.status,503);
 assert.equal(first.data.code,'METADATA_CLEANUP_FAILED');
 assert.equal(env._blobs.size,0);
 const retry=await req(env,'/api/documents/'+id+'/attachments/'+aid+'/permanent-delete',{
  method:'POST',...auth(owner),data:{confirm:'DELETE_FOREVER'}
 });
 assert.equal(retry.response.status,200,JSON.stringify(retry.data));
 assert.equal(env.DB.sql.prepare("SELECT COUNT(*) n FROM attachments").get().n,0);
 assert.equal(env.DB.sql.prepare("SELECT COUNT(*) n FROM storage_objects").get().n,0);
});


test('password change checks old password, revokes own sessions and preserves household member credentials',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const invite=await req(env,'/api/household/invites',{method:'POST',...auth(owner),data:{invitee_email:'b@example.com'}});
 const join=await req(env,'/api/household/join',{method:'POST',data:{invite_token:invite.data.invite_token,email:'b@example.com',password:'member-long-secret123'}});
 assert.equal(join.response.status,201);
 const memberCookie=join.response.headers.get('set-cookie').split(';')[0];
 const wrong=await req(env,'/api/auth/change-password',{method:'POST',...auth(owner),
   data:{current_password:'not-the-real-password',new_password:'new-secure-password-6789'}});
 assert.equal(wrong.response.status,401);
 const same=await req(env,'/api/auth/change-password',{method:'POST',...auth(owner),
   data:{current_password:'owner-long-secret123',new_password:'owner-long-secret123'}});
 assert.equal(same.response.status,409);
 const changed=await req(env,'/api/auth/change-password',{method:'POST',...auth(owner),
   data:{current_password:'owner-long-secret123',new_password:'new-secure-password-6789'}});
 assert.equal(changed.response.status,200,JSON.stringify(changed.data));
 assert.equal(changed.data.reauth_required,true);
 assert.match(changed.response.headers.get('set-cookie'),/Max-Age=0/);
 assert.equal((await req(env,'/api/me',auth(owner))).response.status,401);
 assert.equal((await req(env,'/api/me',{cookie:memberCookie})).response.status,200);
 const oldLogin=await req(env,'/api/auth/login',{method:'POST',
   data:{email:'a@example.com',password:'owner-long-secret123'}});
 assert.equal(oldLogin.response.status,401);
 const fresh=await req(env,'/api/auth/login',{method:'POST',
   data:{email:'a@example.com',password:'new-secure-password-6789'}});
 assert.equal(fresh.response.status,200,JSON.stringify(fresh.data));
});


test('atomic cross-app sender lock blocks double-click while first target request is in flight',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
  retention:'summary',source_type:'text',text:'ご請求金額：1,200円\n納付期限：令和8年11月30日（月)'
 }});
 const id=imported.data.document_id;
 const doc=(await req(env,`/api/documents/${id}`,auth(owner))).data.document;
 const amt=doc.fields.find(x=>x.field_key==='amount_jpy');
 assert.ok(amt);
 assert.equal((await req(env,`/api/fields/${amt.id}`,{method:'PATCH',...auth(owner),
   data:{review_state:'confirmed',normalized_value:'1200'}})).response.status,200);
 const candidate=(await req(env,`/api/documents/${id}/candidates`,auth(owner))).data.items.find(x=>x.candidate_kind==='finance');
 assert.ok(candidate);
 const actor=env.DB.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
 env.BRIDGE_USER_MAP=JSON.stringify({[actor]:{kakebo:'mapped-ledger-user'}});
 env.KAKEBO_BRIDGE_SECRET='concurrency-secret-with-enough-entropy-abc';
 let signal,release,calls=0;
 const started=new Promise(resolve=>signal=resolve);
 const gate=new Promise(resolve=>release=resolve);
 env.KAKEBO_BRIDGE_SERVICE={async fetch(){
  calls++;signal();await gate;return Response.json({ok:true,remote_id:'entry-999'});
 }};
 const url=`/api/candidates/${candidate.id}/commit`;
 const args={method:'POST',...auth(owner),data:{confirm:'CONFIRM_ACCOUNTING',
   payment_confirmed:true,date:'2026-11-12',category:'税金',payment_source:'現金'},
   extraHeaders:{'Idempotency-Key':'confirm-ledger-001'}};
 const first=req(env,url,args);
 await started;
 const simultaneous=await req(env,url,args);
 assert.equal(simultaneous.response.status,409);
 assert.equal(simultaneous.data.code,'SENDING');
 assert.equal(calls,1);
 release();
 assert.equal((await first).response.status,200);
 const repeat=await req(env,url,args);
 assert.equal(repeat.data.already_synced,true);
 assert.equal(calls,1);
 assert.equal(env.DB.sql.prepare('SELECT attempt_count n FROM integration_links').get().n,1);
});


test('UTC daily OCR budget is shared across both accounts and never claims Cloudflare account headroom',async()=>{
 const env=makeEnv(),owner=await boot(env);
 env.ENABLE_EXPERIMENTAL_OCR='true';
 env.OCR_CALLS_PER_USER_DAY='3';
 env.OCR_APP_UTC_DAILY_LIMIT='1';
 let calls=0,reads=0;
 env.AI={async run(){calls++;return {answer:'納付期限：2026年11月30日',metrics:{input_tokens:25,output_tokens:9}};}};
 const originalGet=env.DOCUMENTS.get.bind(env.DOCUMENTS);
 env.DOCUMENTS.get=async k=>{reads++;return originalGet(k);};
 async function add(user,byte){
  const form=new FormData();
  form.append('file',new File([new Uint8Array([255,216,255,224,byte,4,5,6])],'sample.jpg',{type:'image/jpeg'}));
  form.append('retention','original');
  const uploaded=await req(env,'/api/documents/import/file',{method:'POST',...auth(user),form});
  assert.equal(uploaded.response.status,201);
  const id=uploaded.data.document_id;
  const data=(await req(env,`/api/documents/${id}`,auth(user))).data.document;
  return {id,aid:data.attachments[0].id};
 }
 const first=await add(owner,1);
 const ok=await req(env,`/api/documents/${first.id}/ocr`,{method:'POST',...auth(owner),
  data:{confirm:true,attachment_id:first.aid}});
 assert.equal(ok.response.status,200,JSON.stringify(ok.data));
 const invited=await req(env,'/api/household/invites',{method:'POST',...auth(owner),data:{invitee_email:'partner@example.invalid'}});
 assert.equal(invited.response.status,201,JSON.stringify(invited.data));
 const join=await req(env,'/api/household/join',{method:'POST',data:{invite_token:invited.data.invite_token,email:'partner@example.invalid',password:'partner-secret-long-2026'}});
 assert.equal(join.response.status,201,JSON.stringify(join.data));
 const partner={cookie:join.response.headers.get('set-cookie').split(';')[0],csrf:join.data.csrf_token,user:join.data.user};
 const second=await add(partner,2);
 const fail=await req(env,`/api/documents/${second.id}/ocr`,{method:'POST',...auth(partner),
  data:{confirm:true,attachment_id:second.aid}});
 assert.equal(fail.response.status,429,JSON.stringify(fail.data));
 assert.equal(fail.data.code,'OCR_APP_UTC_LIMIT');
 assert.equal(calls,1);assert.equal(reads,1);
 const totals=env.DB.sql.prepare('SELECT calls,reserved FROM ocr_app_utc_daily').get();
 assert.equal(totals.calls,1);assert.equal(totals.reserved,0);
 const usage=await req(env,'/api/usage',auth(partner));
 assert.equal(usage.data.app_utc_day.calls,1);
 assert.equal(usage.data.app_utc_day.limit,1);
 assert.equal(usage.data.cloudflare_account_remaining,null);
});
test('stale OCR pending does not retry automatically and requires explicit second approval',async()=>{
 const {OCR_MODEL,OCR_PROMPT_VERSION}=await import('../worker/ocr.js');
 const env=makeEnv(),owner=await boot(env);
 const form=new FormData();
 form.append('file',new File([new Uint8Array([255,216,255,224,21,22,23,24])],'pending.jpg',{type:'image/jpeg'}));
 form.append('retention','original');
 const uploaded=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form});
 const id=uploaded.data.document_id;
 const doc=(await req(env,`/api/documents/${id}`,auth(owner))).data.document;
 const aid=doc.attachments[0].id;
 const object=env.DB.sql.prepare('SELECT object_id FROM attachments WHERE id=?').get(aid).object_id;
 const actor=env.DB.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
 const old=new Date(Date.now()-26*3600000).toISOString();
 env.DB.sql.prepare(`INSERT INTO ocr_attempts(id,owner_id,object_id,model_id,prompt_version,state,created_at,updated_at)
  VALUES(?,?,?,?,?,'pending',?,?)`).run('pending-rec-1',actor,object,OCR_MODEL,OCR_PROMPT_VERSION,old,old);
 env.ENABLE_EXPERIMENTAL_OCR='true';
 let called=0;
 env.AI={async run(){called++;return {answer:'申請期限：2026年11月30日'};}};
 const path=`/api/documents/${id}/ocr`;
 const base={method:'POST',...auth(owner),data:{confirm:true,attachment_id:aid}};
 const blocked=await req(env,path,base);
 assert.equal(blocked.response.status,409);
 assert.equal(blocked.data.code,'OCR_PENDING_STALE');
 assert.equal(called,0);
 const approved=await req(env,path,{...base,data:{...base.data,retry_stale:true}});
 assert.equal(approved.response.status,200,JSON.stringify(approved.data));
 assert.equal(called,1);
 const cache=env.DB.sql.prepare('SELECT state,attempt_count FROM ocr_attempts').get();
 assert.equal(cache.state,'success');assert.equal(cache.attempt_count,2);
 const totals=env.DB.sql.prepare('SELECT calls,reserved FROM ocr_app_utc_daily').get();
 assert.equal(totals.calls,1);assert.equal(totals.reserved,0);
});


test('Google Drive Picker source provenance is recorded only after explicit original upload',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const file=new File([new Uint8Array([255,216,255,224,77,88,99,100])],'notice.jpg',{type:'image/jpeg'});
 const form=new FormData();form.append('file',file);form.append('retention','original');form.append('source_type','google_drive');
 const imported=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form});
 assert.equal(imported.response.status,201,JSON.stringify(imported.data));
 const source=env.DB.sql.prepare('SELECT source_type FROM document_sources WHERE document_id=?').get(imported.data.document_id);
 assert.equal(source.source_type,'google_drive');
 const before=env._blobs.size;
 const badForm=new FormData();badForm.append('file',new File([new Uint8Array([255,216,255,224,51,52])],'bad.jpg',{type:'image/jpeg'}));
 badForm.append('retention','original');badForm.append('source_type','remote_url');
 const denied=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:badForm});
 assert.equal(denied.response.status,400);
 assert.equal(denied.data.code,'INVALID_SOURCE');
 assert.equal(env._blobs.size,before);
});


test('direct reanalysis cannot destroy remote attempts or regenerate idempotency keys',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const created=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
  retention:'summary',source_type:'text',
  text:'納付金額：1,200円\n納付期限：令和8年11月30日（月)'
 }});
 assert.equal(created.response.status,201);
 const id=created.data.document_id;
 let candidates=(await req(env,`/api/documents/${id}/candidates`,auth(owner))).data.items;
 assert.ok(candidates.length);
 const c=candidates[0],actor=env.DB.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
 const target=c.candidate_kind==='finance'?'kakebo':c.candidate_kind==='homeflow_task'?'homeflow':'zhixue';
 const linkId='link-lock-'+id;
 env.DB.sql.prepare(`INSERT INTO integration_links(id,candidate_id,target,idempotency_key,state,attempt_count,updated_at)
   VALUES(?,?,?,?,?,?,?)`).run(linkId,c.id,target,'jda:'+target+':'+c.id,'failed',1,new Date().toISOString());
 // Reproduce a future client forcing analysis instead of using the source-text editor.
 env.DB.sql.prepare('UPDATE documents SET analysis_status=? WHERE id=?').run('draft',id);
 const blocked=await req(env,`/api/documents/${id}/analyze`,{
  method:'POST',...auth(owner),data:{}
 });
 assert.equal(blocked.response.status,409,JSON.stringify(blocked.data));
 assert.equal(blocked.data.code,'INTEGRATION_HISTORY_LOCKED');
 candidates=(await req(env,`/api/documents/${id}/candidates`,auth(owner))).data.items;
 assert.ok(candidates.some(item=>item.id===c.id));
 const preserved=env.DB.sql.prepare('SELECT id,attempt_count FROM integration_links WHERE id=?').get(linkId);
 assert.equal(preserved.id,linkId);
 assert.equal(preserved.attempt_count,1);
});


test('signed Japanese sentence sync requires explicit privacy review and stays idempotent',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
  retention:'summary',source_type:'text',text:'ご請求金額：1200円\n納付期限：令和8年11月30日（月)'
 }});
 const docId=imported.data.document_id;
 const now=new Date().toISOString(),candidateId='sentences000000000000000000000000';
 env.DB.sql.prepare(`INSERT INTO action_candidates(id,document_id,candidate_kind,payload_json,created_at,updated_at)
   VALUES(?,?,?,?,?,?)`).run(candidateId,docId,'sentence',
   JSON.stringify({sentence:'期限までに支払います。',translation_zh:'在期限之前付款'}),now,now);
 const actor=env.DB.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
 env.BRIDGE_USER_MAP=JSON.stringify({[actor]:{zhixue:'single-study-owner'}});
 env.ZHIXUE_BRIDGE_SECRET='signed-study-secret-long-enough-to-test';
 let networkRequests=0,bodySent;
 env.ZHIXUE_BRIDGE_SERVICE={async fetch(r){networkRequests++;bodySent=await r.json();return Response.json({ok:true,remote_id:'ja:期限までに支払います。'})}};
 const preview=await req(env,`/api/candidates/${candidateId}/preview`,auth(owner));
 assert.equal(preview.response.status,200,JSON.stringify(preview.data));
 assert.equal(preview.data.available,true);
 const missingConsent=await req(env,`/api/candidates/${candidateId}/commit`,{
   method:'POST',...auth(owner),data:{confirm:'CONFIRM_STUDY',redacted_sentence:'期限までに支払います。'},
   extraHeaders:{'Idempotency-Key':'explicit-sentence-request'}
 });
 assert.equal(missingConsent.response.status,409,JSON.stringify(missingConsent.data));
 assert.equal(networkRequests,0);
 const commit=()=>req(env,`/api/candidates/${candidateId}/commit`,{
   method:'POST',...auth(owner),data:{confirm:'CONFIRM_STUDY',privacy_confirmed:true,
     redacted_sentence:'期限までに支払います。'},
   extraHeaders:{'Idempotency-Key':'explicit-sentence-request'}
 });
 const first=await commit();
 assert.equal(first.response.status,200,JSON.stringify(first.data));
 assert.equal(bodySent.payload.operation,'sentence');
 assert.equal(bodySent.payload.privacy_confirmed,true);
 assert.equal(bodySent.payload.skip_existing,true);
 const again=await commit();
 assert.equal(again.response.status,200,JSON.stringify(again.data));
 assert.equal(again.data.already_synced,true);
 assert.equal(networkRequests,1);
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM integration_links WHERE state=\'synced\'').get().n,1);
});

test('missing owner-scoped object is re-uploaded before reuse; failed repair creates no reference',async()=>{
  const env=makeEnv(),owner=await boot(env),bytes=new Uint8Array([255,216,255,224,41,42,43,44]);
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))]
    .map(x=>x.toString(16).padStart(2,'0')).join('');
  async function doc(text){
    const r=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),
      data:{retention:'summary',source_type:'text',text}});
    assert.equal(r.response.status,201,JSON.stringify(r.data));return r.data.document_id;
  }
  function backup(id){
    const form=new FormData();
    form.append('file',new File([bytes],'backup.jpg',{type:'image/jpeg'}));
    form.append('sha256',hash);
    return req(env,'/api/documents/'+id+'/attachments/restore-upload',{method:'POST',...auth(owner),form});
  }
  const a=await doc('保管用資料 A');
  assert.equal((await backup(a)).response.status,201);
  const key=[...env._blobs.keys()][0];env._blobs.delete(key);
  const b=await doc('保管用資料 B');
  const repaired=await backup(b);
  assert.equal(repaired.response.status,201,JSON.stringify(repaired.data));
  assert.deepEqual(env._blobs.get(key),bytes);
  env._blobs.delete(key);
  const c=await doc('保管用資料 C');
  const put=env.DOCUMENTS.put;
  env.DOCUMENTS.put=async()=>{throw Error('simulated R2 failure')};
  const failed=await backup(c);
  assert.equal(failed.response.status,503,JSON.stringify(failed.data));
  assert.equal(failed.data.code,'R2_REPAIR_FAILED');
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM attachments WHERE document_id=?').get(c).n,0);
  env.DOCUMENTS.put=put;
  assert.equal((await backup(c)).response.status,201);
  assert.deepEqual(env._blobs.get(key),bytes);
});

test('trashed document original is not downloadable through backup endpoint',async()=>{
  const env=makeEnv(),owner=await boot(env);
  const form=new FormData();
  form.append('file',new File([new Uint8Array([255,216,255,224,81,82,83,84])],
    'private.jpg',{type:'image/jpeg'}));
  form.append('retention','original');
  const r=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form});
  assert.equal(r.response.status,201);
  const id=r.data.document_id;
  const a=(await req(env,'/api/documents/'+id,auth(owner))).data.document.attachments[0];
  const path='/api/backups/original/'+id+'/'+a.id;
  assert.equal((await req(env,path,auth(owner))).response.status,200);
  assert.equal((await req(env,'/api/documents/'+id+'/trash',{method:'POST',...auth(owner),data:{}})).response.status,200);
  assert.equal((await req(env,path,auth(owner))).response.status,404);
});


test('Google Picker CSP allows only explicitly trusted Google origins',async()=>{
  const env=makeEnv();
  const page=await req(env,'/');
  assert.equal(page.response.status,200);
  const csp=page.response.headers.get('Content-Security-Policy');
  assert.ok(csp);
  assert.match(csp,/script-src 'self' 'wasm-unsafe-eval' https:\/\/accounts\.google\.com https:\/\/apis\.google\.com;/);
  assert.doesNotMatch(csp,/'unsafe-eval'/);
  assert.match(csp,/worker-src 'self'/);
  assert.match(csp,/connect-src 'self' https:\/\/gmail\.googleapis\.com https:\/\/www\.googleapis\.com https:\/\/accounts\.google\.com https:\/\/oauth2\.googleapis\.com https:\/\/apis\.google\.com https:\/\/cdn\.jsdelivr\.net https:\/\/paddle-model-ecology\.bj\.bcebos\.com https:\/\/huggingface\.co https:\/\/cas-bridge\.xethub\.hf\.co https:\/\/cdn-lfs\.hf\.co;/);
  assert.match(csp,/frame-src 'self' blob: https:\/\/accounts\.google\.com https:\/\/docs\.google\.com https:\/\/drive\.google\.com;/);
  assert.match(csp,/object-src 'none'/);
  assert.match(csp,/frame-ancestors 'none'/);
  assert.doesNotMatch(csp,/script-src[^;]*'unsafe-inline'|script-src[^;]*\*/);
  const unauthorized=await req(env,'/api/health');
  assert.equal(unauthorized.response.status,200);
  assert.equal(unauthorized.response.headers.get('Cache-Control'),'no-store');
});


test('sensitive insurance medical and identity imports stay private unless later explicitly shared',async()=>{
  const env=makeEnv(),owner=await boot(env);
  for(const value of ['保険証券：契約内容のご案内','処方箋：診療予約について','在留カード番号の確認']){
    const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
      retention:'summary',source_type:'text',visibility:'shared',text:value
    }});
    assert.equal(imported.response.status,201,JSON.stringify(imported.data));
    const id=imported.data.document_id;
    const detail=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
    assert.equal(detail.visibility,'private',value);
    const blocked=await req(env,'/api/documents/'+id,{method:'PATCH',...auth(owner),
      data:{visibility:'shared',version:detail.version}});
    assert.equal(blocked.response.status,409);
    const confirmed=await req(env,'/api/documents/'+id,{method:'PATCH',...auth(owner),
      data:{visibility:'shared',version:detail.version,confirm_sensitive_share:true}});
    assert.equal(confirmed.response.status,200);
    assert.equal((await req(env,'/api/documents/'+id,auth(owner))).data.document.visibility,'shared');
  }
});

test('replacing shared source with payroll and changing shared category revoke sharing atomically',async()=>{
  const env=makeEnv(),owner=await boot(env);
  async function imported(text){
    const r=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
      retention:'summary',source_type:'text',visibility:'shared',text
    }});
    assert.equal(r.response.status,201,JSON.stringify(r.data));
    return r.data.document_id;
  }
  const first=await imported('普通のお知らせ A');
  assert.equal((await req(env,'/api/documents/'+first,auth(owner))).data.document.visibility,'shared');
  const replaced=await req(env,'/api/documents/'+first+'/source-text',{method:'PATCH',...auth(owner),
    data:{text:'給与明細\n差引支給額：250,000円'}});
  assert.equal(replaced.response.status,200,JSON.stringify(replaced.data));
  assert.equal(replaced.data.privacy_auto_private,true);
  const payroll=(await req(env,'/api/documents/'+first,auth(owner))).data.document;
  assert.equal(payroll.visibility,'private');
  assert.equal(payroll.category,'salary');
  const second=await imported('普通のお知らせ B');
  const other=(await req(env,'/api/documents/'+second,auth(owner))).data.document;
  const tagged=await req(env,'/api/documents/'+second,{method:'PATCH',...auth(owner),
    data:{category:'medical',version:other.version}});
  assert.equal(tagged.response.status,200,JSON.stringify(tagged.data));
  assert.equal((await req(env,'/api/documents/'+second,auth(owner))).data.document.visibility,'private');
});


test('session management only lists and revokes the authenticated account',async()=>{
  const env=makeEnv(),a=await boot(env);
  const other=await req(env,'/api/auth/login',{method:'POST',data:{
    email:'a@example.com',password:'owner-long-secret123'
  }});
  assert.equal(other.response.status,200);
  const second={cookie:other.response.headers.get('set-cookie').split(';')[0],csrf:other.data.csrf_token};
  const listed=await req(env,'/api/auth/sessions',auth(a));
  assert.equal(listed.response.status,200);
  assert.equal(listed.data.items.length,2);
  assert.equal(listed.data.items.filter(x=>x.is_current).length,1);
  const current=listed.data.items.find(x=>x.is_current).id;
  const remote=listed.data.items.find(x=>!x.is_current).id;
  assert.ok(!listed.data.items.some(x=>x.secret_hash||x.cookie));
  const missingCsrf=await req(env,'/api/auth/sessions/revoke',{
    method:'POST',cookie:a.cookie,data:{session_id:remote}
  });
  assert.equal(missingCsrf.response.status,403);
  assert.equal((await req(env,'/api/auth/sessions/revoke',{
    method:'POST',...auth(a),data:{session_id:current}
  })).response.status,409);
  const invite=await req(env,'/api/household/invites',{
    method:'POST',...auth(a),data:{invitee_email:'session-b@example.invalid'}
  });
  assert.equal(invite.response.status,201);
  const joined=await req(env,'/api/household/join',{method:'POST',data:{
    invite_token:invite.data.invite_token,email:'session-b@example.invalid',
    password:'member-session-secret123'
  }});
  assert.equal(joined.response.status,201);
  const member={cookie:joined.response.headers.get('set-cookie').split(';')[0],csrf:joined.data.csrf_token};
  const memberSession=(await req(env,'/api/auth/sessions',auth(member))).data.items[0].id;
  const cross=await req(env,'/api/auth/sessions/revoke',{
    method:'POST',...auth(a),data:{session_id:memberSession}
  });
  assert.equal(cross.response.status,404);
  assert.equal((await req(env,'/api/me',auth(member))).response.status,200);
  assert.equal((await req(env,'/api/auth/sessions/revoke',{
    method:'POST',...auth(a),data:{session_id:remote}
  })).response.status,200);
  assert.equal((await req(env,'/api/me',auth(second))).response.status,401);
  assert.equal((await req(env,'/api/me',auth(a))).response.status,200);
  const relogged=await req(env,'/api/auth/login',{method:'POST',data:{
    email:'a@example.com',password:'owner-long-secret123'
  }});
  assert.equal(relogged.response.status,200);
  const otherAgain={cookie:relogged.response.headers.get('set-cookie').split(';')[0],csrf:relogged.data.csrf_token};
  const revoked=await req(env,'/api/auth/sessions/revoke-others',{method:'POST',...auth(a),data:{}});
  assert.equal(revoked.response.status,200);
  assert.equal(revoked.data.revoked_count,1);
  assert.equal((await req(env,'/api/me',auth(otherAgain))).response.status,401);
  assert.equal((await req(env,'/api/me',auth(a))).response.status,200);
  assert.equal((await req(env,'/api/me',auth(member))).response.status,200);
});


test('empty OCR requires 24h cooling and explicit budgeted retry',async()=>{
  const env=makeEnv(),owner=await boot(env);
  env.ENABLE_EXPERIMENTAL_OCR='true';
  env.OCR_CALLS_PER_USER_DAY='3';env.OCR_APP_UTC_DAILY_LIMIT='3';
  const f=new FormData();
  f.append('file',new File([new Uint8Array([255,216,255,224,19,22,23,24])],'sample.jpg',{type:'image/jpeg'}));
  f.append('retention','original');
  const saved=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form:f});
  assert.equal(saved.response.status,201,JSON.stringify(saved.data));
  const id=saved.data.document_id;
  const aid=(await req(env,'/api/documents/'+id,auth(owner))).data.document.attachments[0].id;
  let calls=0;
  env.AI={async run(){calls++;return calls===1?{result:{}}:{answer:'請求金額 200円',metrics:{input_tokens:40,output_tokens:15}};}};
  const trigger=async options=>req(env,'/api/documents/'+id+'/ocr',{
    method:'POST',...auth(owner),data:{confirm:true,attachment_id:aid,...options}
  });
  const empty=await trigger({});
  assert.equal(empty.response.status,422,JSON.stringify(empty.data));
  assert.equal(empty.data.code,'OCR_EMPTY');
  const immediate=await trigger({retry_empty:true});
  assert.equal(immediate.data.code,'OCR_EMPTY_CACHED');assert.equal(calls,1);
  env.DB.sql.prepare("UPDATE ocr_attempts SET updated_at='2026-01-01T00:00:00.000Z'").run();
  const noConsent=await trigger({});
  assert.equal(noConsent.data.code,'OCR_EMPTY_CACHED');assert.equal(calls,1);
  const retried=await trigger({retry_empty:true});
  assert.equal(retried.response.status,200,JSON.stringify(retried.data));
  assert.equal(retried.data.verified,false);
  assert.equal(retried.data.text,'請求金額 200円');
  assert.equal(calls,2);
  assert.equal(env.DB.sql.prepare('SELECT attempt_count n FROM ocr_attempts').get().n,2);
  assert.equal(env.DB.sql.prepare('SELECT calls FROM ocr_app_utc_daily').get().calls,2);
  const reuse=await trigger({});
  assert.equal(reuse.response.status,200);assert.equal(reuse.data.cached,true);assert.equal(calls,2);
});


test('reimport repairs missing R2 bytes before reporting reuse and never claims failed repair',async()=>{
  const env=makeEnv(),owner=await boot(env),bytes=new Uint8Array([255,216,255,224,44,55,66,77]);
  async function upload(){
    const form=new FormData();
    form.append('file',new File([bytes],'repeat.jpg',{type:'image/jpeg'}));
    form.append('retention','original');
    return req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form});
  }
  const first=await upload();
  assert.equal(first.response.status,201,JSON.stringify(first.data));
  const firstId=first.data.document_id,key=[...env._blobs.keys()][0];
  env._blobs.delete(key);
  const put=env.DOCUMENTS.put;
  env.DOCUMENTS.put=async()=>{throw Error('simulated R2 outage')};
  const failed=await upload();
  assert.equal(failed.response.status,503,JSON.stringify(failed.data));
  assert.equal(failed.data.code,'R2_REPAIR_FAILED');
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM documents').get().n,1);
  env.DOCUMENTS.put=put;
  const repaired=await upload();
  assert.equal(repaired.response.status,200,JSON.stringify(repaired.data));
  assert.equal(repaired.data.reused,true);assert.equal(repaired.data.document_id,firstId);
  assert.deepEqual(env._blobs.get(key),bytes);
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM documents').get().n,1);
});

test('existing unlinked ready D1 object repaired before new file import references it',async()=>{
  const env=makeEnv(),owner=await boot(env);
  const bytes=new Uint8Array([255,216,255,224,64,65,66,67]);
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))]
    .map(n=>n.toString(16).padStart(2,'0')).join('');
  const key=owner.user.id+'/orphan-test-repair';
  const sql='INSERT INTO storage_objects '+
    '(id,owner_id,bucket,object_key,sha256,bytes,mime,quality_profile,state,created_at,updated_at) '+
    'VALUES(?,?,?,?,?,?,?,?,?,?,?)';
  env.DB.sql.prepare(sql).run('d'.repeat(32),owner.user.id,'test-private',key,digest,
    bytes.length,'image/jpeg','web-upload-v1','ready',
    '2026-11-11T00:00:00.000Z','2026-11-11T00:00:00.000Z');
  assert.equal(env._blobs.has(key),false);
  const form=new FormData();
  form.append('file',new File([bytes],'orphan.jpg',{type:'image/jpeg'}));
  form.append('retention','original');
  const created=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form});
  assert.equal(created.response.status,201,JSON.stringify(created.data));
  const objectId=env.DB.sql.prepare('SELECT object_id FROM attachments WHERE document_id=?')
    .get(created.data.document_id).object_id;
  assert.equal(objectId,'d'.repeat(32));
  assert.deepEqual(env._blobs.get(key),bytes);
});


test('confirmed Gmail text import remains private and deduplicates without any inbox sync',async()=>{
  const env=makeEnv(),owner=await boot(env);
  const payload={method:'POST',...auth(owner),data:{
    title:'手动选择的邮件',source_type:'gmail',retention:'summary',
    text:'Gmail 账单通知\n口座番号：1234567\n支払期限 2026年11月30日',
    visibility:'shared'
  }};
  const first=await req(env,'/api/documents/import/text',payload);
  assert.equal(first.response.status,201,JSON.stringify(first.data));
  const doc=(await req(env,'/api/documents/'+first.data.document_id,auth(owner))).data.document;
  assert.equal(doc.visibility,'private');
  const repeated=await req(env,'/api/documents/import/text',payload);
  assert.equal(repeated.response.status,200,JSON.stringify(repeated.data));
  assert.equal(repeated.data.reused,true);
  assert.equal(repeated.data.document_id,first.data.document_id);
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM documents').get().n,1);
});


test('append attachment dedup repairs missing R2; failures never claim reused success',async()=>{
 const env=makeEnv(),p=await boot(env),bytes=new Uint8Array([255,216,255,224,33,34,35,36]);
 const t=await req(env,'/api/documents/import/text',{method:'POST',...auth(p),
   data:{retention:'summary',source_type:'text',text:'申請書 2026年12月1日'}});
 assert.equal(t.response.status,201);
 const id=t.data.document_id;
 const form=()=>{const f=new FormData();f.append('file',new File([bytes],'page.jpg',{type:'image/jpeg'}));f.append('retention','original');return f;};
 const first=await req(env,'/api/documents/'+id+'/attachments',{method:'POST',...auth(p),form:form()});
 assert.equal(first.response.status,201,JSON.stringify(first.data));
 const key=[...env._blobs.keys()][0],aid=first.data.attachment_id;
 env._blobs.delete(key);
 const savePut=env.DOCUMENTS.put;
 env.DOCUMENTS.put=async()=>{throw Error('injected R2 error')};
 const failed=await req(env,'/api/documents/'+id+'/attachments',{method:'POST',...auth(p),form:form()});
 assert.equal(failed.response.status,503,JSON.stringify(failed.data));assert.equal(failed.data.code,'R2_REPAIR_FAILED');
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM attachments WHERE document_id=?').get(id).n,1);
 env.DOCUMENTS.put=savePut;
 const result=await req(env,'/api/documents/'+id+'/attachments',{method:'POST',...auth(p),form:form()});
 assert.equal(result.response.status,200,JSON.stringify(result.data));
 assert.equal(result.data.reused,true);assert.equal(result.data.attachment_id,aid);
 assert.deepEqual(env._blobs.get(key),bytes);
});

test('append page reuses owner object only after safe repair; different owners cannot share objects',async()=>{
 const env=makeEnv(),p=await boot(env),bytes=new Uint8Array([255,216,255,224,51,52,53,54]);
 const doc=async(text,actor=p)=>{const r=await req(env,'/api/documents/import/text',{
   method:'POST',...auth(actor),data:{source_type:'text',retention:'summary',text}});assert.equal(r.response.status,201);return r.data.document_id;};
 const f=()=>{const form=new FormData();form.append('file',new File([bytes],'page.jpg',{type:'image/jpeg'}));form.append('retention','original');return form;};
 const a=await doc('お知らせ A');
 const first=await req(env,'/api/documents/'+a+'/attachments',{method:'POST',...auth(p),form:f()});
 assert.equal(first.response.status,201);
 const key=[...env._blobs.keys()][0];env._blobs.delete(key);
 const b=await doc('お知らせ B');
 const used=await req(env,'/api/documents/'+b+'/attachments',{method:'POST',...auth(p),form:f()});
 assert.equal(used.response.status,201,JSON.stringify(used.data));
 assert.deepEqual(env._blobs.get(key),bytes);
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM storage_objects').get().n,1);
 const invite=await req(env,'/api/household/invites',{method:'POST',...auth(p),data:{invitee_email:'other-owner@example.invalid'}});
 assert.equal(invite.response.status,201);
 const join=await req(env,'/api/household/join',{method:'POST',data:{email:'other-owner@example.invalid',invite_token:invite.data.invite_token,password:'other-owner-secret123'}});
 assert.equal(join.response.status,201,JSON.stringify(join.data));
 const other={cookie:join.response.headers.get('set-cookie').split(';')[0],csrf:join.data.csrf_token};
 const c=await doc('他人の私的な資料',other);
 const separately=await req(env,'/api/documents/'+c+'/attachments',{method:'POST',...auth(other),form:f()});
 assert.equal(separately.response.status,201,JSON.stringify(separately.data));
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM storage_objects').get().n,2);
 assert.equal(env._blobs.size,2);
});

test('re-interpretation only adds missing fields, preserves manual review and never writes linked apps',async()=>{
  const env=makeEnv(),owner=await boot(env);
  const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
    source_type:'text',retention:'summary',text:'口座引落予定日：2026年11月10日\\n引落金額：27,460円\\n内容：カード代金'
  }});
  assert.equal(imported.response.status,201,JSON.stringify(imported.data));
  const id=imported.data.document_id;
  const original=(await req(env,`/api/documents/${id}`,auth(owner))).data.document;
  const amount=original.fields.find(f=>f.field_key==='amount_jpy');
  assert.ok(amount);
  const verified=await req(env,`/api/fields/${amount.id}`,{method:'PATCH',...auth(owner),
    data:{review_state:'confirmed',normalized_value:'27460'}});
  assert.equal(verified.response.status,200,JSON.stringify(verified.data));
  // Simulate a document imported before support for event dates and rich explanation.
  env.DB.sql.prepare("DELETE FROM document_fields WHERE document_id=? AND field_key='event_date'").run(id);
  env.DB.sql.prepare("UPDATE documents SET category='other',explanation_zh='old' WHERE id=?").run(id);
  const refreshed=await req(env,`/api/documents/${id}/reinterpret`,{method:'POST',...auth(owner),data:{}});
  assert.equal(refreshed.response.status,200,JSON.stringify(refreshed.data));
  assert.equal(refreshed.data.added_fields,1);
  assert.equal(refreshed.data.remote_integrations_unchanged,true);
  const next=(await req(env,`/api/documents/${id}`,auth(owner))).data.document;
  assert.equal(next.category,'bank');
  assert.match(next.explanation_zh,/银行账户自动扣款/);
  assert.equal(next.fields.find(f=>f.field_key==='amount_jpy').id,amount.id);
  assert.equal(next.fields.find(f=>f.field_key==='amount_jpy').review_state,'confirmed');
  assert.equal(next.fields.find(f=>f.field_key==='event_date').normalized_value,'2026-11-10');
  assert.equal(next.fields.find(f=>f.field_key==='event_date').review_state,'unreviewed');
  assert.equal((await req(env,`/api/documents/${id}/reinterpret`,{method:'POST',...auth(owner),data:{}})).data.added_fields,0);
  assert.equal(Number(env.DB.sql.prepare('SELECT COUNT(*) n FROM integration_links').get().n),0);
});


test('electricity mail import previews only invoiced 1770 JPY, not 1966 metering charge or false due task',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const text=[
  '電気料金の検針期間','2026/09/16 ~ 2026/10/15\t1,966円 (税込)',
  '56.00kWh','今回のご請求金額合計：','1,770円（税込)',
  'カード立替日 : 2026/10/28'
 ].join('\n');
 const imported=await req(env,'/api/documents/import/text',{
   method:'POST',...auth(owner),data:{source_type:'text',retention:'summary',text}
 });
 assert.equal(imported.response.status,201,JSON.stringify(imported.data));
 const id=imported.data.document_id;
 const doc=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
 assert.equal(doc.category,'utility');
 assert.equal(doc.fields.find(x=>x.field_key==='amount_jpy')?.normalized_value,'1770');
 assert.equal(doc.fields.find(x=>x.field_key==='period_charge_jpy')?.normalized_value,'1966');
 assert.equal(doc.fields.find(x=>x.field_key==='card_advance_date')?.normalized_value,'2026-10-28');
 assert.equal(doc.fields.some(x=>x.field_key==='due_date'),false);
 const suggestions=(await req(env,'/api/documents/'+id+'/candidates',auth(owner))).data.items;
 assert.equal(suggestions.some(x=>x.candidate_kind==='homeflow_task'),false);
 const financial=suggestions.find(x=>x.candidate_kind==='finance');
 assert.equal(financial?.payload.amount_jpy,1770);
 assert.equal(Number(env.DB.sql.prepare('SELECT COUNT(*) n FROM integration_links').get().n),0);
 const amount=doc.fields.find(x=>x.field_key==='amount_jpy');
 const saved=await req(env,'/api/fields/'+amount.id,{method:'PATCH',...auth(owner),
   data:{normalized_value:'1770',review_state:'confirmed'}});
 assert.equal(saved.response.status,200);
 // Existing verified field id/state and bridge proposals survive explicit re-explanation.
 const updated=await req(env,'/api/documents/'+id+'/reinterpret',{method:'POST',...auth(owner),data:{}});
 assert.equal(updated.response.status,200);
 assert.equal(updated.data.remote_integrations_unchanged,true);
 const now=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
 assert.equal(now.fields.find(x=>x.field_key==='amount_jpy')?.review_state,'confirmed');
 assert.equal(now.fields.find(x=>x.field_key==='amount_jpy')?.id,amount.id);
 assert.equal(Number(env.DB.sql.prepare('SELECT COUNT(*) n FROM integration_links').get().n),0);
});


test('future delivery notice creates one HomeFlow suggestion; only confirmed delivery date authorizes bridge',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const original=['佐川急便 お届け予定日時','2099/10/12　AM8:00～12:00','※ご都合の良い日時をご指定ください。'].join('\n');
 const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
   source_type:'text',retention:'summary',text:original,title:'配達予定の通知'
 }});
 assert.equal(imported.response.status,201,JSON.stringify(imported.data));
 const docId=imported.data.document_id;
 const detail=(await req(env,'/api/documents/'+docId,auth(owner))).data.document;
 assert.equal(detail.category,'delivery');
 assert.equal(detail.fields.find(x=>x.field_key==='event_date')?.normalized_value,'2099-10-12');
 assert.equal(detail.fields.some(x=>x.field_key==='due_date'),false);
 const getCandidates=async()=>(await req(env,'/api/documents/'+docId+'/candidates',auth(owner))).data.items;
 const candidate=(await getCandidates()).find(x=>x.candidate_kind==='homeflow_task');
 assert.ok(candidate);
 assert.equal(candidate.payload.task_type,'delivery');
 assert.equal(candidate.payload.date_field_key,'event_date');
 assert.equal(candidate.payload.delivery_window,'08:00～12:00');
 assert.equal(candidate.payload.due_on,'2099-10-12');
 let calls=0;
 const actor=env.DB.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
 env.BRIDGE_USER_MAP=JSON.stringify({[actor]:{homeflow:'test_homeflow_owner'}});
 env.HOMEFLOW_BRIDGE_SECRET='integration-test-bridge-secret-abcdefgh';
 env.HOMEFLOW_BRIDGE_SERVICE={async fetch(r){
   const body=JSON.parse(await r.text());
   assert.equal(body.payload.dueOn,'2099-10-12');
   assert.match(body.payload.title,/08:00～12:00/);
   calls++;
   return Response.json({ok:true,remote_id:'delivery-task-created'});
 }};
 const opts={method:'POST',...auth(owner),data:{
   confirm:'CONFIRM_TASK',title:candidate.payload.title,visibility:'private'
 },extraHeaders:{'Idempotency-Key':'delivery_test_key_20991012'}};
 const denied=await req(env,'/api/candidates/'+candidate.id+'/commit',opts);
 assert.equal(denied.response.status,409);
 assert.equal(calls,0);
 const event=detail.fields.find(x=>x.field_key==='event_date');
 const approve=await req(env,'/api/fields/'+event.id,{method:'PATCH',...auth(owner),data:{review_state:'confirmed',normalized_value:'2099-10-12'}});
 assert.equal(approve.response.status,200,JSON.stringify(approve.data));
 const sent=await req(env,'/api/candidates/'+candidate.id+'/commit',opts);
 assert.equal(sent.response.status,200,JSON.stringify(sent.data));
 assert.equal(calls,1);
 const second=await req(env,'/api/candidates/'+candidate.id+'/commit',opts);
 assert.equal(second.data.already_synced,true);
 assert.equal(calls,1);
});
test('reinterpret backfills one future delivery suggestion and leaves prior candidate IDs unchanged',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const old=['お届け予定日時','2099/10/12　AM8:00～12:00','ご都合のよい日時をご指定ください'].join('\n');
 const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{source_type:'text',retention:'summary',text:old}});
 assert.equal(imported.response.status,201);
 const id=imported.data.document_id;
 // Pretend pre-fix parser stored the date field but no HomeFlow proposal.
 env.DB.sql.prepare("DELETE FROM action_candidates WHERE document_id=? AND candidate_kind='homeflow_task'").run(id);
 const first=await req(env,'/api/documents/'+id+'/reinterpret',{method:'POST',...auth(owner),data:{}});
 assert.equal(first.response.status,200,JSON.stringify(first.data));
 const firstCandidates=(await req(env,'/api/documents/'+id+'/candidates',auth(owner))).data.items;
 const reminders=firstCandidates.filter(x=>x.candidate_kind==='homeflow_task');
 assert.equal(reminders.length,1);
 const twice=await req(env,'/api/documents/'+id+'/reinterpret',{method:'POST',...auth(owner),data:{}});
 assert.equal(twice.response.status,200,JSON.stringify(twice.data));
 const second=(await req(env,'/api/documents/'+id+'/candidates',auth(owner))).data.items.filter(x=>x.candidate_kind==='homeflow_task');
 assert.equal(second.length,1);
 assert.equal(second[0].id,reminders[0].id);
});
test('past delivery mail cannot add a HomeFlow candidate even after reinterpreting',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const old='佐川急便 お届け予定日時\n2026/10/12（月） AM8:00～12:00';
 const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{source_type:'text',retention:'summary',text:old}});
 assert.equal(imported.response.status,201);
 const id=imported.data.document_id;
 for(let i=0;i<2;i++){
   if(i)assert.equal((await req(env,'/api/documents/'+id+'/reinterpret',{method:'POST',...auth(owner),data:{}})).response.status,200);
   const candidates=(await req(env,'/api/documents/'+id+'/candidates',auth(owner))).data.items;
   assert.equal(candidates.some(x=>x.candidate_kind==='homeflow_task'),false);
 }
});


test('bank salary credit without an amount supports confirmed manual net income and a single finance proposal',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const raw=[
 'いつもきらぼし銀行をご利用いただきありがとうございます。',
 '普通預金口座＊＊＊＊にお振込によるご入金がございました。',
 '入金日時 ：２０２６年１１月１０日　００時１３分２７秒',
 '入金内容 ：カ）サンプルカイシャ　キユウヨ'
 ].join('\n');
 const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{text:raw,source_type:'text',retention:'summary'}});
 assert.equal(imported.response.status,201,JSON.stringify(imported.data));
 const id=imported.data.document_id;
 const detail=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
 assert.equal(detail.category,'salary');
 assert.equal(detail.visibility,'private');
 assert.equal(detail.fields.find(x=>x.field_key==='transaction_at')?.normalized_value,'2026-11-10 00:13:27');
 assert.equal(detail.fields.some(x=>x.field_key==='net_salary'),false);
 const candidates=async()=>(await req(env,'/api/documents/'+id+'/candidates',auth(owner))).data.items;
 assert.equal((await candidates()).some(x=>x.candidate_kind==='finance'),false);
 const endpoint='/api/documents/'+id+'/manual-income';
 const withoutConsent=await req(env,endpoint,{method:'POST',...auth(owner),data:{amount_jpy:'245000'}});
 assert.equal(withoutConsent.response.status,409);
 const invalid=await req(env,endpoint,{method:'POST',...auth(owner),data:{amount_jpy:'0',confirm_bank_amount:true}});
 assert.equal(invalid.response.status,400);
 assert.equal((await candidates()).some(x=>x.candidate_kind==='finance'),false);
 const added=await req(env,endpoint,{method:'POST',...auth(owner),data:{amount_jpy:'245,000',confirm_bank_amount:true}});
 assert.equal(added.response.status,200,JSON.stringify(added.data));
 assert.equal(added.data.amount_provenance,'manual');
 const after=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
 const net=after.fields.find(x=>x.field_key==='net_salary');
 assert.equal(net.normalized_value,'245000');
 assert.equal(net.review_state,'corrected');
 assert.match(net.source_quote,/用户手动补录/);
 const finance=(await candidates()).filter(x=>x.candidate_kind==='finance');
 assert.equal(finance.length,1);
 assert.equal(finance[0].payload.kind,'income');
 assert.equal(finance[0].payload.amount_jpy,245000);
 assert.equal(finance[0].payload.transaction_date,'2026-11-10');
 assert.equal(finance[0].payload.amount_provenance,'manual');
 assert.equal((await req(env,endpoint,{method:'POST',...auth(owner),data:{amount_jpy:'250000',confirm_bank_amount:true}})).response.status,409);
 assert.equal((await req(env,'/api/documents/'+id+'/reinterpret',{method:'POST',...auth(owner),data:{}})).response.status,200);
 const revised=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
 assert.equal(revised.fields.find(x=>x.field_key==='net_salary')?.id,net.id);
 assert.match(revised.explanation_zh,/人工填写工资金额/);
 assert.equal((await candidates()).filter(x=>x.candidate_kind==='finance').length,1);
 assert.equal(Number(env.DB.sql.prepare('SELECT COUNT(*) n FROM integration_links').get().n),0);
});
test('Olive card purchase creates an expense review candidate that confirms 1520, not a debit task',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const raw=[
 'いつも三井住友カードをご利用いただきありがとうございます。',
 'Ｏｌｉｖｅ／クレジットについてカードの利用内容をお知らせします。',
 'ご利用日時：2026/11/08 13:58',
 'マクドナルドモバイルオーダー（買物）\t1,520円'
 ].join('\n');
 const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{text:raw,source_type:'text',retention:'summary'}});
 assert.equal(imported.response.status,201,JSON.stringify(imported.data));
 const id=imported.data.document_id;
 const doc=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
 assert.equal(doc.category,'card_spend');
 assert.equal(doc.visibility,'private');
 assert.equal(doc.fields.find(x=>x.field_key==='amount_jpy')?.normalized_value,'1520');
 assert.equal(doc.fields.find(x=>x.field_key==='merchant')?.normalized_value,'マクドナルドモバイルオーダー');
 const items=(await req(env,'/api/documents/'+id+'/candidates',auth(owner))).data.items;
 const finance=items.filter(x=>x.candidate_kind==='finance');
 assert.equal(finance.length,1);
 assert.equal(finance[0].payload.kind,'expense');
 assert.equal(finance[0].payload.transaction_date,'2026-11-08');
 assert.equal(finance[0].payload.amount_jpy,1520);
 assert.equal(items.some(x=>x.candidate_kind==='homeflow_task'),false);
 const actor=env.DB.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
 env.BRIDGE_USER_MAP=JSON.stringify({[actor]:{kakebo:'kakebo_owner_test'}});
 env.KAKEBO_BRIDGE_SECRET='test-kakebo-long-secret-abcdefghijk';
 let calls=0;
 env.KAKEBO_BRIDGE_SERVICE={async fetch(req){
   const sent=JSON.parse(await req.text());
   assert.equal(sent.payload.operation,'entry');
   assert.equal(sent.payload.type,'expense');
   assert.equal(sent.payload.amount,1520);
   assert.equal(sent.payload.date,'2026-11-08');
   assert.equal(sent.payload.paymentSource,'Olive');
   calls++;
   return Response.json({ok:true,remote_id:'kakebo-record-123'});
 }};
 const body={confirm:'CONFIRM_ACCOUNTING',payment_confirmed:true,date:'2026-11-08',category:'外食',payment_source:'Olive'};
 const send=opts=>req(env,'/api/candidates/'+finance[0].id+'/commit',{method:'POST',...auth(owner),data:body,extraHeaders:{'Idempotency-Key':'olive_card_purchase_20261108'}});
 const before=await send();
 assert.equal(before.response.status,409);
 assert.equal(calls,0);
 const field=doc.fields.find(x=>x.field_key==='amount_jpy');
 assert.equal((await req(env,'/api/fields/'+field.id,{method:'PATCH',...auth(owner),data:{normalized_value:'1520',review_state:'confirmed'}})).response.status,200);
 const sent=await send();
 assert.equal(sent.response.status,200,JSON.stringify(sent.data));
 assert.equal(calls,1);
 const again=await send();
 assert.equal(again.data.already_synced,true);
 assert.equal(calls,1);
});


test('previously confirmed split-line card mail backfills one finance candidate safely',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const raw=[
  '件名：ご利用のお知らせ【三井住友カード】',
  'お客様のカードご利用内容をお知らせいたします。',
  'ご利用カード：Ｏｌｉｖｅ／クレジット',
  '◇利用日：2026/05/28 19:06',
  '◇利用先：セブン－イレブン',
  '◇利用取引：買物',
  '◇利用金額：151円',
  '※カード利用の承認照会通知であり、ご請求を確定しません。'
 ].join('\n');
 const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),
  data:{text:raw,source_type:'text',retention:'summary'}});
 assert.equal(imported.response.status,201,JSON.stringify(imported.data));
 const id=imported.data.document_id;
 const getDoc=async()=>(await req(env,'/api/documents/'+id,auth(owner))).data.document;
 const candidates=async()=>(await req(env,'/api/documents/'+id+'/candidates',auth(owner))).data.items;
 const initial=await getDoc();
 assert.equal(initial.category,'card_spend');
 assert.equal((await candidates()).filter(x=>x.candidate_kind==='finance').length,1);
 const amount=initial.fields.find(x=>x.field_key==='amount_jpy');
 assert.equal(amount?.normalized_value,'151');
 assert.equal((await req(env,'/api/fields/'+amount.id,{method:'PATCH',...auth(owner),
  data:{normalized_value:'151',review_state:'confirmed'}})).response.status,200);
 // Simulate a previous version's bank classification. Keep its reviewed money field.
 env.DB.sql.prepare("DELETE FROM action_candidates WHERE document_id=? AND candidate_kind='finance'").run(id);
 env.DB.sql.prepare("DELETE FROM document_fields WHERE document_id=? AND field_key IN ('merchant','transaction_at')").run(id);
 env.DB.sql.prepare("UPDATE documents SET category='bank' WHERE id=?").run(id);
 assert.equal((await candidates()).filter(x=>x.candidate_kind==='finance').length,0);
 const reparse=()=>req(env,'/api/documents/'+id+'/reinterpret',{method:'POST',...auth(owner),data:{}});
 const first=await reparse();
 assert.equal(first.response.status,200,JSON.stringify(first.data));
 const updated=await getDoc();
 assert.equal(updated.category,'card_spend');
 assert.equal(updated.fields.find(x=>x.field_key==='amount_jpy')?.id,amount.id);
 assert.equal(updated.fields.find(x=>x.field_key==='amount_jpy')?.review_state,'confirmed');
 assert.equal(updated.fields.find(x=>x.field_key==='merchant')?.normalized_value,'セブン-イレブン');
 assert.equal(updated.fields.find(x=>x.field_key==='transaction_at')?.normalized_value,'2026-05-28 19:06');
 const finance=(await candidates()).filter(x=>x.candidate_kind==='finance');
 assert.equal(finance.length,1);
 assert.deepEqual([finance[0].payload.kind,finance[0].payload.amount_jpy,finance[0].payload.transaction_at,finance[0].payload.payment_source_hint],
  ['expense',151,'2026-05-28 19:06','Olive']);
 assert.equal((await candidates()).some(x=>x.candidate_kind==='homeflow_task'),false);
 assert.equal((await reparse()).response.status,200);
 assert.equal((await candidates()).filter(x=>x.candidate_kind==='finance')[0].id,finance[0].id);
 assert.equal(Number(env.DB.sql.prepare('SELECT COUNT(*) AS n FROM integration_links').get().n),0);
});

test('verified SMBC transaction date appears in Today without a false missing deadline',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const content=[
  '件名：ご利用のお知らせ【三井住友カード】',
  'お客様のカードご利用内容をお知らせいたします。',
  '◇利用日：2026/05/28 19:06',
  '◇利用先：セブン－イレブン',
  '◇利用取引：買物',
  '◇利用金額：151円'
 ].join('\n');
 const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),
  data:{text:content,source_type:'text',retention:'summary'}});
 assert.equal(imported.response.status,201);
 const document=(await req(env,'/api/documents/'+imported.data.document_id,auth(owner))).data.document;
 const timestamp=document.fields.find(f=>f.field_key==='transaction_at');
 assert.equal(timestamp.normalized_value,'2026-05-28 19:06');
 const confirm=await req(env,'/api/fields/'+timestamp.id,{method:'PATCH',...auth(owner),
  data:{normalized_value:'2026-05-28 19:06',review_state:'confirmed'}});
 assert.equal(confirm.response.status,200);
 const today=await req(env,'/api/today?limit=10',auth(owner));
 assert.equal(today.response.status,200);
 const item=today.data.items.find(d=>d.id===imported.data.document_id);
 assert.ok(item,'reviewable card authorization is listed on Today');
 assert.equal(item.category,'card_spend');
 assert.equal(item.verified_transaction_at,'2026-05-28 19:06');
 assert.equal(item.due_date,null);
});
test('ledger candidate preview fetches registered categories and payment sources via signed read-only request',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),
  data:{text:'いつも三井住友カードをご利用いただきありがとうございます。\nカードのご利用内容です\nご利用日時：2026/11/08 13:58\nマクドナルドモバイルオーダー（買物） 1,520円',
   source_type:'text',retention:'summary'}});
 assert.equal(imported.response.status,201);
 const id=imported.data.document_id;
 const candidate=(await req(env,'/api/documents/'+id+'/candidates',auth(owner))).data.items.find(x=>x.candidate_kind==='finance');
 assert.ok(candidate);
 const actor=env.DB.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
 env.BRIDGE_USER_MAP=JSON.stringify({[actor]:{kakebo:'allowed-owner'}});
 env.KAKEBO_BRIDGE_SECRET='signed-test-long-secret-for-ledger-options-123';
 let catalogCalls=0;
 env.KAKEBO_BRIDGE_SERVICE={async fetch(request){
  catalogCalls++;
  const raw=await request.text(),stamp=request.headers.get('X-DA-Timestamp');
  assert.equal(request.headers.get('X-DA-Signature'),await hmacHex(env.KAKEBO_BRIDGE_SECRET,stamp+'\n'+raw));
  const data=JSON.parse(raw);
  assert.equal(data.payload.operation,'options');
  assert.equal(data.payload.entryType,'expense');
  assert.equal(data.actor_user_id,'allowed-owner');
  return Response.json({ok:true,categories:[{value:'饮食料品',label:'飲食料品'}],
   payment_sources:[{value:'三井住友カード',label:'三井住友カード'}]});
 }};
 const preview=await req(env,'/api/candidates/'+candidate.id+'/preview',auth(owner));
 assert.equal(preview.response.status,200,JSON.stringify(preview.data));
 assert.equal(preview.data.available,true);
 assert.equal(preview.data.ledger_options.categories[0].value,'饮食料品');
 assert.equal(preview.data.ledger_options.categories[0].label,'飲食料品');
 assert.equal(preview.data.ledger_options.paymentSources[0].value,'三井住友カード');
 assert.equal(catalogCalls,1);
 assert.equal(Number(env.DB.sql.prepare('SELECT COUNT(*) AS n FROM integration_links').get().n),0);
});
test('ledger options diagnose unreachable, disabled and HTML target without revealing upstream text',async()=>{
 const {ledgerPickerOptions}=await import('../worker/bridge.js');
 const env={
  BRIDGE_USER_MAP:JSON.stringify({owner:{kakebo:'ledger-user'}}),
  KAKEBO_BRIDGE_SECRET:'fixture-bridge-secret-long-enough-for-test',
  KAKEBO_BRIDGE_SERVICE:{async fetch(){throw new TypeError('fetch failed [sensitive hostname]')}}
 };
 const unavailable=await ledgerPickerOptions(env,'owner','expense');
 assert.match(unavailable.error,/无法连接家計簿正式接口/);
 assert.doesNotMatch(unavailable.error,/sensitive|hostname|fixture/);
 env.KAKEBO_BRIDGE_SERVICE={async fetch(){return Response.json({ok:false,error:'bridge_disabled'},{status:404});}};
 const disabled=await ledgerPickerOptions(env,'owner','expense');
 assert.match(disabled.error,/未开启文书助手联动/);
 env.KAKEBO_BRIDGE_SERVICE={async fetch(){return new Response('<html>private origin</html>',{status:200,headers:{'content-type':'text/html'}});}};
 const badFormat=await ledgerPickerOptions(env,'owner','expense');
 assert.match(badFormat.error,/没有返回可用的数据格式/);
 assert.doesNotMatch(badFormat.error,/private origin/);
 env.KAKEBO_BRIDGE_SERVICE={async fetch(){return Response.json({ok:true,categories:[{label:'飲食料品',value:'饮食料品'}],payment_sources:[{label:'三井住友カード',value:'三井住友カード'}]});}};
 const success=await ledgerPickerOptions(env,'owner','expense');
 assert.equal(success.data.categories[0].value,'饮食料品');
 assert.equal(success.data.paymentSources[0].value,'三井住友カード');
});

test('approved merchant is passed as the ledger title in a signed card purchase payload',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const raw=[
  '件名：ご利用のお知らせ【三井住友カード】',
  'お客様のカードご利用内容をお知らせいたします。',
  'ご利用カード：Ｏｌｉｖｅ／クレジット',
  '◇利用日：2026/05/28 19:06',
  '◇利用先：セブン－イレブン',
  '◇利用取引：買物',
  '◇利用金額：151円'
 ].join('\n');
 const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),
  data:{text:raw,source_type:'text',retention:'summary'}});
 assert.equal(imported.response.status,201,JSON.stringify(imported.data));
 const doc=(await req(env,'/api/documents/'+imported.data.document_id,auth(owner))).data.document;
 const amount=doc.fields.find(f=>f.field_key==='amount_jpy');
 const stamp=doc.fields.find(f=>f.field_key==='transaction_at');
 assert.ok(amount);assert.ok(stamp);
 const confirm=await req(env,'/api/fields/'+amount.id,{method:'PATCH',...auth(owner),
  data:{normalized_value:'151',review_state:'confirmed'}});
 assert.equal(confirm.response.status,200);
 const confirmStamp=await req(env,'/api/fields/'+stamp.id,{method:'PATCH',...auth(owner),
  data:{normalized_value:'2026-05-28 19:06',review_state:'confirmed'}});
 assert.equal(confirmStamp.response.status,200);
 const candidate=(await req(env,'/api/documents/'+doc.id+'/candidates',auth(owner))).data.items.find(c=>c.candidate_kind==='finance');
 assert.ok(candidate);
 const actor=env.DB.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
 env.BRIDGE_USER_MAP=JSON.stringify({[actor]:{kakebo:'ledger-owner'}});
 env.KAKEBO_BRIDGE_SECRET='internal-bridge-test-secret-for-merchant-case';
 let sent=null;
 env.KAKEBO_BRIDGE_SERVICE={async fetch(request){
  sent=JSON.parse(await request.text());
  return Response.json({ok:true,remote_id:'fake-ledger-151'});
 }};
 const result=await req(env,'/api/candidates/'+candidate.id+'/commit',{method:'POST',...auth(owner),
  data:{confirm:'CONFIRM_ACCOUNTING',payment_confirmed:true,date:'2026-05-28',
    category:'饮食料品',payment_source:'三井住友カード',note:''},
  extraHeaders:{'Idempotency-Key':'merchant-test-151'}});
 assert.equal(result.response.status,200,JSON.stringify(result.data));
 assert.equal(sent.payload.merchant,'セブン-イレブン');
 assert.equal(sent.payload.note,'');
 assert.equal(sent.payload.date,'2026-05-28');
 assert.equal(sent.payload.time,'19:06');
 assert.equal(sent.payload.amount,151);
});


test('ledger preview passes merchant and recognized card and uses target rule suggestions',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const raw=[
 '件名：ご利用のお知らせ【三井住友カード】',
 'カードのご利用内容をお知らせいたします',
 'ご利用カード：Olive／クレジット',
 '◇利用日：2026/05/28 19:06',
 '◇利用先：セブン－イレブン',
 '◇利用取引：買物',
 '◇利用金額：151円'
 ].join('\n');
 const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),
  data:{text:raw,source_type:'text',retention:'summary'}});
 assert.equal(imported.response.status,201);
 const id=imported.data.document_id;
 const candidate=(await req(env,'/api/documents/'+id+'/candidates',auth(owner))).data.items.find(c=>c.candidate_kind==='finance');
 assert.ok(candidate);
 const actor=env.DB.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
 env.BRIDGE_USER_MAP=JSON.stringify({[actor]:{kakebo:'owner-1'}});
 env.KAKEBO_BRIDGE_SECRET='test-store-matching-secret-123456789';
 let received=null;
 env.KAKEBO_BRIDGE_SERVICE={async fetch(request){
  received=JSON.parse(await request.text());
  return Response.json({ok:true,
   categories:[{value:'饮食料品',label:'飲食料品'},{value:'日用品',label:'日用品'}],
   payment_sources:[{value:'三井住友カード',label:'三井住友カード'},{value:'セゾンカード',label:'セゾンカード'}],
   suggested:{category:'饮食料品',payment_source:'三井住友カード'}
  });
 }};
 const result=await req(env,'/api/candidates/'+candidate.id+'/preview',auth(owner));
 assert.equal(result.response.status,200,JSON.stringify(result.data));
 assert.equal(received.payload.operation,'options');
 assert.equal(received.payload.merchant,'セブン-イレブン');
 assert.equal(received.payload.recognizedPayment,'Olive');
 assert.equal(result.data.ledger_options.suggested.category,'饮食料品');
 assert.equal(result.data.ledger_options.suggested.payment_source,'三井住友カード');
 // Ignore an upstream hint not present in the selected user's real catalogue.
 env.KAKEBO_BRIDGE_SERVICE={async fetch(){return Response.json({ok:true,
  categories:[{value:'日用品',label:'日用品'}],
  payment_sources:[{value:'現金',label:'現金'}],
  suggested:{category:'any-forged-category',payment_source:'hidden-card'}
 });}};
 const second=await req(env,'/api/candidates/'+candidate.id+'/preview',auth(owner));
 assert.equal(second.data.ledger_options.suggested.category,'');
 assert.equal(second.data.ledger_options.suggested.payment_source,'');
});

test('Gmail code-model grants remain encrypted and user-bound; only selected messages are read',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const noConfig=await req(env,'/api/google/gmail/status',auth(owner));
 assert.equal(noConfig.response.status,200);
 assert.equal(noConfig.data.enabled,false);
 env.GOOGLE_OAUTH_CLIENT_ID='123-abc.apps.googleusercontent.com';
 env.GOOGLE_OAUTH_CLIENT_SECRET='unit-test-only-client-secret';
 env.GOOGLE_TOKEN_ENCRYPTION_KEY='cd'.repeat(32);
 const scope='https://www.googleapis.com/auth/gmail.readonly';
 let refreshCount=0,fullCount=0,metadataCount=0,listCount=0;
 env.GOOGLE_OAUTH_FETCH=async(url,options)=>{
   // Browser callback uses Cloudflare-compatible manual redirect; so must
   // Gmail's refresh, message listing and individual metadata/body reads.
   assert.equal(options.redirect,'manual');
   assert.equal(options.cache,'no-store');
   const u=new URL(url);
   if(u.origin==='https://oauth2.googleapis.com'&&u.pathname==='/token'){
     const form=new URLSearchParams(options.body);
     assert.equal(form.get('client_secret'),env.GOOGLE_OAUTH_CLIENT_SECRET);
     if(form.get('grant_type')==='authorization_code'){
       assert.equal(form.get('redirect_uri'),'https://app.example.test');
       assert.equal(form.get('code'),'test-google-code-123');
       return Response.json({access_token:'private-access-token',refresh_token:'private-refresh-token',
         scope,token_type:'Bearer',expires_in:3600});
     }
     assert.equal(form.get('grant_type'),'refresh_token');
     assert.equal(form.get('refresh_token'),'private-refresh-token');
     refreshCount++;
     return Response.json({access_token:'private-access-token',scope,expires_in:3600});
   }
   if(u.origin==='https://oauth2.googleapis.com'&&u.pathname==='/revoke')
     return new Response('',{status:200});
   if(u.pathname==='/gmail/v1/users/me/profile')
     return Response.json({emailAddress:'owner@gmail.example'});
   assert.equal(options.headers.Authorization,'Bearer private-access-token');
   if(u.pathname==='/gmail/v1/users/me/messages'){
     listCount++;assert.equal(u.searchParams.get('maxResults'),'5');
     return Response.json({messages:[{id:'googleMailA123'}]});
   }
   if(u.pathname==='/gmail/v1/users/me/messages/googleMailA123'){
     if(u.searchParams.get('format')==='metadata'){
       metadataCount++;
       return Response.json({payload:{headers:[{name:'Subject',value:'請求金額のご案内'},
         {name:'From',value:'notice@example.invalid'}, {name:'Date',value:'2026-11-12'}]}});
     }
     assert.equal(u.searchParams.get('format'),'full');fullCount++;
     return Response.json({payload:{mimeType:'text/plain',headers:[],body:{
       data:Buffer.from('支払い期限：11月30日').toString('base64url')}}});
   }
   throw Error('Unexpected Google endpoint '+u.pathname);
 };
 const pending=await req(env,'/api/google/gmail/status',auth(owner));
 assert.equal(pending.data.enabled,true);
 assert.equal(pending.data.connected,false);
 const badCsrf=await req(env,'/api/google/gmail/connect',{method:'POST',cookie:owner.cookie,data:{code:'test-google-code-123'}});
 assert.equal(badCsrf.response.status,403);
 const connected=await req(env,'/api/google/gmail/connect',{method:'POST',...auth(owner),data:{code:'test-google-code-123'}});
 assert.equal(connected.response.status,200,JSON.stringify(connected.data));
 assert.equal(connected.data.google_email,'owner@gmail.example');
 assert.doesNotMatch(JSON.stringify(connected.data),/private-refresh-token|private-access-token/);
 const record=env.DB.sql.prepare('SELECT * FROM google_oauth_grants WHERE user_id=?').get(owner.user.id);
 assert.equal(record.service,'gmail');
 assert.equal(record.google_email,'owner@gmail.example');
 assert.ok(record.refresh_iv);
 assert.doesNotMatch(record.refresh_cipher,/private-refresh-token/);
 const status=await req(env,'/api/google/gmail/status',auth(owner));
 assert.equal(status.data.connected,true);
 assert.equal(status.data.google_email,'owner@gmail.example');
 const list=await req(env,'/api/google/gmail/messages?q=newer_than%3A30d',auth(owner));
 assert.equal(list.response.status,200,JSON.stringify(list.data));
 assert.equal(list.data.items.length,1);
 assert.equal(list.data.items[0].subject,'請求金額のご案内');
 assert.equal(fullCount,0,'list must never read any mail body');
 assert.equal(listCount,1);
 assert.equal(metadataCount,1);
 const one=await req(env,'/api/google/gmail/messages/googleMailA123',auth(owner));
 assert.equal(one.response.status,200);
 assert.equal(one.data.payload.mimeType,'text/plain');
 assert.equal(fullCount,1,'only the selected mail body is fetched');
 assert.equal(refreshCount,2,'one short-lived access token per explicit user request');
 const revoke=await req(env,'/api/google/gmail/disconnect',{method:'POST',...auth(owner),data:{}});
 assert.equal(revoke.response.status,200);
 assert.equal(revoke.data.remotely_revoked,true);
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM google_oauth_grants').get().n,0);
 const after=await req(env,'/api/google/gmail/messages',auth(owner));
 assert.equal(after.response.status,409);
});

test('Gmail browser grant refreshes and searches with Cloudflare manual redirect (no reauthorization)',async()=>{
 const env=makeEnv(),owner=await boot(env);
 env.GOOGLE_OAUTH_CLIENT_ID='123-test.apps.googleusercontent.com';
 env.GOOGLE_OAUTH_CLIENT_SECRET='unit-test-secret';
 env.GOOGLE_TOKEN_ENCRYPTION_KEY='5a'.repeat(32);
 const scope='https://www.googleapis.com/auth/gmail.readonly';
 const seen=[];
 env.GOOGLE_OAUTH_FETCH=async(url,options)=>{
   const u=new URL(url);
   seen.push({path:u.pathname,method:options.method,redirect:options.redirect});
   assert.equal(options.redirect,'manual');
   assert.equal(options.cache,'no-store');
   if(u.hostname==='oauth2.googleapis.com'&&u.pathname==='/token'){
     const body=new URLSearchParams(options.body);
     if(body.get('grant_type')==='authorization_code')
       return Response.json({access_token:'test-access-token',refresh_token:'secret-refresh-token',scope});
     assert.equal(body.get('grant_type'),'refresh_token');
     assert.equal(body.get('refresh_token'),'secret-refresh-token');
     return Response.json({access_token:'test-new-access-token',scope});
   }
   if(u.pathname==='/gmail/v1/users/me/profile')
     return Response.json({emailAddress:'example@gmail.test'});
   if(u.pathname==='/gmail/v1/users/me/messages'){
     assert.equal(u.searchParams.get('q'),'newer_than:30d');
     assert.equal(u.searchParams.get('maxResults'),'5');
     return Response.json({messages:[{id:'testMsg123456'}]});
   }
   if(u.pathname==='/gmail/v1/users/me/messages/testMsg123456'){
     assert.equal(u.searchParams.get('format'),'metadata');
     return Response.json({payload:{headers:[{name:'Subject',value:'电子收据'},
       {name:'From',value:'sender@example.invalid'},{name:'Date',value:'2026-11-12'}]}});
   }
   throw Error('Unexpected fake Google path '+u.pathname);
 };
 const start=await req(env,'/api/google/oauth/start',{method:'POST',...auth(owner),data:{service:'gmail'}});
 assert.equal(start.response.status,200);
 const state=new URL(start.data.authorization_url).searchParams.get('state');
 const callback=await req(env,'/api/google/oauth/callback?state='+state+'&code=example-authorization-code-123456');
 assert.equal(callback.response.status,200);
 assert.match(await callback.response.text(),/Google 授权成功/);
 const listed=await req(env,'/api/google/gmail/messages?q=newer_than%3A30d',auth(owner));
 assert.equal(listed.response.status,200,JSON.stringify(listed.data));
 assert.equal(listed.data.items.length,1);
 assert.equal(listed.data.items[0].subject,'电子收据');
 const grant=env.DB.sql.prepare('SELECT status,refresh_cipher FROM google_oauth_grants WHERE user_id=? AND service=?')
   .get(owner.user.id,'gmail');
 assert.equal(grant.status,'connected');
 assert.doesNotMatch(grant.refresh_cipher,/secret-refresh-token/);
 assert.deepEqual(seen.map(x=>x.path),[
   '/token','/gmail/v1/users/me/profile','/token',
   '/gmail/v1/users/me/messages','/gmail/v1/users/me/messages/testMsg123456'
 ]);
});

test('Gmail rejects HTTP redirects in refresh without following Google token or deleting grant',async()=>{
 const env=makeEnv(),owner=await boot(env);
 env.GOOGLE_OAUTH_CLIENT_ID='123-test.apps.googleusercontent.com';
 env.GOOGLE_OAUTH_CLIENT_SECRET='unit-test-secret';
 env.GOOGLE_TOKEN_ENCRYPTION_KEY='5a'.repeat(32);
 let invoked=0;
 env.GOOGLE_OAUTH_FETCH=async(url,options)=>{
   assert.equal(options.redirect,'manual');
   invoked++;
   if(invoked===1)return Response.json({
     access_token:'a',refresh_token:'fake-refresh-123456789',
     scope:'https://www.googleapis.com/auth/gmail.readonly'});
   if(invoked===2)return Response.json({emailAddress:'example@gmail.test'});
   return new Response(null,{status:302,headers:{Location:'https://example.invalid/untrusted'}});
 };
 const start=await req(env,'/api/google/oauth/start',{method:'POST',...auth(owner),data:{service:'gmail'}});
 const state=new URL(start.data.authorization_url).searchParams.get('state');
 const callback=await req(env,'/api/google/oauth/callback?state='+state+'&code=valid-code-1234567');
 assert.match(await callback.response.text(),/Google 授权成功/);
 const out=await req(env,'/api/google/gmail/messages?q=newer_than%3A30d',auth(owner));
 assert.equal(out.response.status,502);
 assert.equal(out.data.code,'GOOGLE_UNEXPECTED_REDIRECT');
 assert.equal(invoked,3,'never follow redirects');
 assert.equal(env.DB.sql.prepare('SELECT status FROM google_oauth_grants').get().status,'connected');
});

test('Gemini quota failure persists an error code and explicit user retry succeeds without an automatic second call',async()=>{
 const env=makeEnv(),u=await boot(env);
 env.GEMINI_API_KEY='unit-test-placeholder';
 const existingFetch=globalThis.fetch;
 let calls=0;
 globalThis.fetch=async(url,options)=>{
  calls++;
  assert.match(String(url),/generativelanguage\.googleapis\.com/);
  const body=JSON.parse(options.body);
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel,'MEDIUM');
  assert.equal(body.generationConfig.maxOutputTokens,8192);
  if(calls===1)return new Response(JSON.stringify({error:{status:'RESOURCE_EXHAUSTED',message:'secret should not be shown'}}),{status:429,headers:{'Content-Type':'application/json'}});
  return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({
   summary_zh:'工资文书已经识别，请核对。',
   explanation_zh:'这是一份工资信息通知，应以实际银行入账金额为准。',
   important_points_zh:[],vocabulary:[],sentences:[],field_suggestions:[],finance_suggestions:[],homeflow_suggestions:[]
  })}]}}]}),{status:200,headers:{'Content-Type':'application/json'}});
 };
 try{
  const created=await req(env,'/api/documents/import/text',{method:'POST',...auth(u),data:{
   title:'测试工资',text:'給与明細 差引支給額 123456円',source_type:'text',retention:'summary',ai_provider:'gemini',gemini_consent:true
  }});
  assert.equal(created.response.status,201,JSON.stringify(created.data));
  assert.equal(created.data.ai_status,'queued');
  assert.equal(calls,1,'no automatic Gemini retry spending quota');
  const id=created.data.document_id;
  const failed=(await req(env,'/api/documents/'+id,auth(u))).data.document.ai_analysis;
  assert.equal(failed.status,'failed');
  assert.equal(failed.failure_code,'gemini_quota_or_rate_limited');
  assert.equal(failed.result,null);
  assert.doesNotMatch(JSON.stringify(failed),/secret should not be shown/);
  const retried=await req(env,'/api/documents/'+id+'/ai/analyze',{method:'POST',...auth(u),data:{confirm:true}});
  assert.equal(retried.data.ai_status,'queued');
  assert.equal(calls,2,'retry only happens on explicit user request');
  const passed=(await req(env,'/api/documents/'+id,auth(u))).data.document.ai_analysis;
  assert.equal(passed.status,'success');
  assert.equal(passed.failure_code,null);
  assert.match(passed.result.explanation_zh,/实际银行入账/);
 }finally{globalThis.fetch=existingFetch;}
});

test('a 20/20 Gemini 3.6 budget blocks imports before Google fetch and is visible in usage',async()=>{
 const env=makeEnv(),owner=await boot(env);
 env.GEMINI_API_KEY='test-key';
 const {dayPt,minuteUtc}=geminiQuotaSlots();
 env.DB.sql.prepare('INSERT INTO gemini_api_daily(model_id,day_pt,calls,minute_utc,minute_calls) VALUES(?,?,?,?,?)')
  .run(GEMINI_MODEL,dayPt,20,minuteUtc,0);
 const existingFetch=globalThis.fetch;
 let externalCalls=0;
 globalThis.fetch=async()=>{externalCalls++;throw Error('Google must not be called');};
 try{
  const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
   title:'工资',text:'給与明細 差引支給額 100000円',source_type:'text',retention:'summary',ai_provider:'gemini',gemini_consent:true
  }});
  assert.equal(imported.response.status,201,JSON.stringify(imported.data));
  assert.equal(imported.data.ai_status,'queued');
  assert.equal(externalCalls,0);
  const doc=(await req(env,'/api/documents/'+imported.data.document_id,auth(owner))).data.document;
  assert.equal(doc.ai_analysis.model,'gemini-3.6-flash');
  assert.equal(doc.ai_analysis.failure_code,'gemini_daily_limit');
  const usage=await req(env,'/api/usage',auth(owner));
  assert.equal(usage.response.status,200);
  assert.equal(usage.data.gemini_daily.model,'gemini-3.6-flash');
  assert.equal(usage.data.gemini_daily.calls,20);
  assert.equal(usage.data.gemini_daily.limit,20);
  assert.equal(usage.data.gemini_daily.remaining,0);
 }finally{globalThis.fetch=existingFetch;}
});

test('Gemini 503 waits for scheduled one-time recovery without consuming quota during cooldown',async()=>{
 const env=makeEnv(),owner=await boot(env);
 env.GEMINI_API_KEY='local-test-key';
 const previousFetch=globalThis.fetch;
 let googleCalls=0;
 globalThis.fetch=async()=>{
  googleCalls++;
  if(googleCalls===1)return new Response(JSON.stringify({error:{message:'upstream sensitive information must not be stored'}}),{status:503,headers:{'Content-Type':'application/json'}});
  return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({
   summary_zh:'活动信息已识别，需要核对',
   explanation_zh:'这是一个积分优惠活动，需要确认实际截止时间和参加条件。',
   important_points_zh:[],vocabulary:[],sentences:[],field_suggestions:[],finance_suggestions:[],homeflow_suggestions:[]
  })}]}}]}),{status:200,headers:{'Content-Type':'application/json'}});
 };
 try{
  const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
   title:'优惠券',text:'セブンプレミアム 5%OFF キャンペーン。内容をご確認ください。',source_type:'text',retention:'summary',ai_provider:'gemini',gemini_consent:true
  }});
  assert.equal(imported.response.status,201,JSON.stringify(imported.data));
  assert.equal(imported.data.ai_status,'queued');
  assert.equal(googleCalls,1);
  const id=imported.data.document_id;
  const failed=(await req(env,'/api/documents/'+id,auth(owner))).data.document.ai_analysis;
  assert.equal(failed.failure_code,'gemini_service_overloaded');
  assert.doesNotMatch(JSON.stringify(failed),/sensitive information/);
  const retry=await req(env,'/api/documents/'+id+'/ai/analyze',{method:'POST',...auth(owner),data:{confirm:true}});
  assert.equal(retry.data.ai_status,'in_progress');
  assert.equal(googleCalls,1,'no new Gemini call while in cooldown');
  const before=await req(env,'/api/usage',auth(owner));
  assert.equal(before.data.gemini_daily.calls,1,'rate limit counts only actual attempt');
  env.DB.sql.prepare('UPDATE document_ai_analyses SET updated_at=? WHERE document_id=?')
   .run(new Date(Date.now()-61000).toISOString(),id);
  env.DB.sql.prepare("UPDATE document_ai_jobs SET next_attempt_at=? WHERE document_id=?")
   .run(new Date(Date.now()-1000).toISOString(),id);
  const pending=[];
  await app.scheduled({},env,{waitUntil:promise=>pending.push(promise)});
  await Promise.all(pending);
  assert.equal((await req(env,'/api/documents/'+id,auth(owner))).data.document.ai_job.state,'done');
  assert.equal(googleCalls,2,'one scheduled recovery retry');
  const after=await req(env,'/api/usage',auth(owner));
  assert.equal(after.data.gemini_daily.calls,2);
 }finally{globalThis.fetch=previousFetch;}
});

test('campaign email rule re-analysis backfills missing deadline without using Gemini, and only explicit year confirmation creates a HomeFlow proposal',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const source=[
  '件名：【よりどり2点5%OFF】セブンプレミアムゴールドのお肉加工品がお得！',
  'セブンプレミアムゴールド肉類加工品。今なら対象商品がよりどり2点で5%OFF！11/15(日)までの期間限定！',
  '▼LINE ID連携で500円OFFクーポンプレゼント▼',
  'キャンペーン・お得情報メール'
 ].join('\n');
 const created=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
  title:'测试促销',text:source,source_type:'text',retention:'summary',ai_provider:'none'
 }});
 assert.equal(created.response.status,201,JSON.stringify(created.data));
 const id=created.data.document_id;
 // Simulate an existing saved email from the old importer with no campaign fields.
 env.DB.sql.prepare('DELETE FROM document_fields WHERE document_id=?').run(id);
 const originalFetch=globalThis.fetch;
 let googleCalls=0;
 globalThis.fetch=async()=>{googleCalls++;throw Error('Google must never be used for rule re-analysis');};
 try{
  const detailBefore=await req(env,'/api/documents/'+id,auth(owner));
  assert.equal(detailBefore.data.document.fields.length,0);
  assert.match(detailBefore.data.document.campaign_hints[0].description_zh,/500 日元优惠券/);
  const backfill=await req(env,'/api/documents/'+id+'/reinterpret',{method:'POST',...auth(owner),data:{}});
  assert.equal(backfill.response.status,200,JSON.stringify(backfill.data));
  assert.equal(backfill.data.added_fields,2);
  assert.equal(googleCalls,0);
  const after=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
  assert.equal(after.fields.find(f=>f.field_key==='due_date_partial')?.normalized_value,'11/15(日)');
  assert.equal(after.fields.find(f=>f.field_key==='due_date')?.normalized_value,'2026-11-15');
  assert.equal(after.fields.find(f=>f.field_key==='due_date')?.review_state,'unreviewed');
  assert.equal((await req(env,'/api/documents/'+id+'/candidates',auth(owner))).data.items.some(c=>c.candidate_kind==='homeflow_task'),false);
  const wrongWeek=await req(env,'/api/documents/'+id+'/complete-deadline',{method:'POST',...auth(owner),data:{due_date:'2027-11-15',confirm_year:true}});
  assert.equal(wrongWeek.response.status,422);
  const correct=await req(env,'/api/documents/'+id+'/complete-deadline',{method:'POST',...auth(owner),data:{due_date:'2026-11-15',confirm_year:true}});
  assert.equal(correct.response.status,200,JSON.stringify(correct.data));
  const afterConfirm=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
  assert.equal(afterConfirm.fields.find(f=>f.field_key==='due_date')?.review_state,'corrected');
  const candidates=(await req(env,'/api/documents/'+id+'/candidates',auth(owner))).data.items;
  const task=candidates.find(c=>c.candidate_kind==='homeflow_task');
  assert.ok(task);
  assert.equal(task.payload.due_on,'2026-11-15');
  assert.equal(task.payload.requires_confirmation,true);
  assert.match(task.payload.title,/活动截止提醒/);
  assert.equal(candidates.some(c=>c.candidate_kind==='finance'),false);
  const again=await req(env,'/api/documents/'+id+'/reinterpret',{method:'POST',...auth(owner),data:{}});
  assert.equal(again.response.status,200,JSON.stringify(again.data));
  const againCandidates=(await req(env,'/api/documents/'+id+'/candidates',auth(owner))).data.items;
  assert.equal(againCandidates.filter(c=>c.candidate_kind==='homeflow_task').length,1);
  assert.equal(againCandidates.find(c=>c.candidate_kind==='homeflow_task').id,task.id);
  assert.equal(googleCalls,0);
 }finally{globalThis.fetch=originalFetch;}
});

test('re-interpret backfills only missing fully dated HomeFlow proposals and never resurrects rejected deadlines',async()=>{
  const env=makeEnv(),owner=await boot(env);
  async function create(source){
    const r=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),data:{
      title:'本地截止日提醒',text:source,source_type:'text',retention:'summary',ai_provider:'none'
    }});
    assert.equal(r.response.status,201,JSON.stringify(r.data));
    return r.data.document_id;
  }
  const id=await create('必要書類の提出期限：2026年11月30日までに提出してください。');
  const original=(await req(env,'/api/documents/'+id+'/candidates',auth(owner))).data.items
    .find(x=>x.candidate_kind==='homeflow_task');
  assert.ok(original,'current import proposes a reviewable task for complete dates');
  // Legacy record: extracted fields exist but the task candidate was missing.
  env.DB.sql.prepare("DELETE FROM action_candidates WHERE document_id=? AND candidate_kind='homeflow_task'").run(id);
  const first=await req(env,'/api/documents/'+id+'/reinterpret',{method:'POST',...auth(owner),data:{}});
  assert.equal(first.response.status,200,JSON.stringify(first.data));
  const candidates=(await req(env,'/api/documents/'+id+'/candidates',auth(owner))).data.items.filter(x=>x.candidate_kind==='homeflow_task');
  assert.equal(candidates.length,1);
  assert.equal(candidates[0].payload.due_on,'2026-11-30');
  assert.equal(candidates[0].payload.requires_confirmation,true);
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM integration_links').get().n,0);
  const second=await req(env,'/api/documents/'+id+'/reinterpret',{method:'POST',...auth(owner),data:{}});
  assert.equal(second.response.status,200);
  const repeated=(await req(env,'/api/documents/'+id+'/candidates',auth(owner))).data.items.filter(x=>x.candidate_kind==='homeflow_task');
  assert.equal(repeated.length,1);
  assert.equal(repeated[0].id,candidates[0].id);
  const rejectedId=await create('申請書の提出期限：2026年12月10日までに提出してください。');
  env.DB.sql.prepare("DELETE FROM action_candidates WHERE document_id=? AND candidate_kind='homeflow_task'").run(rejectedId);
  env.DB.sql.prepare("UPDATE document_fields SET review_state='rejected' WHERE document_id=? AND field_key='due_date'").run(rejectedId);
  const again=await req(env,'/api/documents/'+rejectedId+'/reinterpret',{method:'POST',...auth(owner),data:{}});
  assert.equal(again.response.status,200);
  const rejected=(await req(env,'/api/documents/'+rejectedId+'/candidates',auth(owner))).data.items;
  assert.equal(rejected.filter(x=>x.candidate_kind==='homeflow_task').length,0);
});


test('SBI investment card notice is always a transfer, including pre-existing expense candidates',async()=>{
 assert.equal(inferSbiInvestmentKind('SBI証券投信積立サービス（翌月買付分）'),'monthly');
 assert.equal(inferSbiInvestmentKind('SBI証券 ポイント投資'),'purchase');
 assert.equal(inferSbiInvestmentKind('SBI証券 投信 買付'),'purchase');
 assert.equal(inferSbiInvestmentKind('SBI証券 保険料金'),'');
 assert.equal(inferSbiInvestmentKind('セブン-イレブン 日用品'),'');
 const env=makeEnv(),owner=await boot(env);
 const notice=[
  'いつも三井住友カードをご利用いただきありがとうございます。',
  'カードの利用内容をお知らせします。',
  'ご利用日時：2026/11/12 10:22',
  'SBI証券投信積立サービス（翌月買付分） 15,000円'
 ].join('\n');
 const imported=await req(env,'/api/documents/import/text',{method:'POST',...auth(owner),
  data:{retention:'summary',source_type:'text',text:notice}});
 assert.equal(imported.response.status,201,JSON.stringify(imported.data));
 const id=imported.data.document_id;
 const doc=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
 const amount=doc.fields.find(x=>x.field_key==='amount_jpy');
 assert.equal(amount.normalized_value,'15000');
 assert.equal((await req(env,'/api/fields/'+amount.id,{method:'PATCH',...auth(owner),
  data:{review_state:'confirmed',normalized_value:'15000'}})).response.status,200);
 const candidate=(await req(env,'/api/documents/'+id+'/candidates',auth(owner))).data.items
   .find(x=>x.candidate_kind==='finance');
 assert.ok(candidate,JSON.stringify(doc));
 assert.equal(candidate.payload.kind,'transfer');
 // Older persisted candidates already said "expense": new preview must still
 // protect them without destroying their idempotency key.
 env.DB.sql.prepare('UPDATE action_candidates SET payload_json=? WHERE id=?')
  .run(JSON.stringify({...candidate.payload,kind:'expense'}),candidate.id);
 const actor=env.DB.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
 env.BRIDGE_USER_MAP=JSON.stringify({[actor]:{kakebo:'approved-kakebo-user'}});
 env.KAKEBO_BRIDGE_SECRET='integration-secret-with-enough-entropy-1234';
 const sent=[];
 env.KAKEBO_BRIDGE_SERVICE={async fetch(request){
  const data=JSON.parse(await request.text());
  if(data.payload.operation==='options')return Response.json({ok:true,
    categories:[{value:'投資・資産移動',label:'资产转移'}],
    payment_sources:[{value:'三井住友カード',label:'三井住友カード'}],
    suggested:{category:'投資・資産移動',payment_source:'三井住友カード'}});
  sent.push(data);
  return Response.json({ok:true,remote_id:'ledger-sbi-001'});
 }};
 const preview=await req(env,'/api/candidates/'+candidate.id+'/preview',auth(owner));
 assert.equal(preview.response.status,200,JSON.stringify(preview.data));
 assert.equal(preview.data.entry_type,'transfer');
 assert.equal(preview.data.ledger_options.suggested.category,'投資・資産移動');
 const send=transfer_date=>req(env,'/api/candidates/'+candidate.id+'/commit',{
  method:'POST',...auth(owner),data:{confirm:'CONFIRM_ACCOUNTING',
    payment_confirmed:true,date:'2026-11-12',category:'投資・資産移動',
    payment_source:'三井住友カード',transfer_date},
  extraHeaders:{'Idempotency-Key':'sbi-approved-transfer-123'}});
 const missing=await send('');
 assert.equal(missing.response.status,422);
 assert.equal(missing.data.code,'TRANSFER_DATE_REQUIRED');
 assert.equal(sent.length,0);
 const done=await send('2026-12-15');
 assert.equal(done.response.status,200,JSON.stringify(done.data));
 assert.equal(sent.length,1);
 const payload=sent[0].payload;
 assert.deepEqual({
  type:payload.type,category:payload.category,transferTarget:payload.transferTarget,
  transferDate:payload.transferDate,sbiPurpose:payload.sbiPurpose,paymentSource:payload.paymentSource
 },{
  type:'transfer',category:'投資・資産移動',transferTarget:'sbi',
  transferDate:'2026-12-15',sbiPurpose:'monthly',paymentSource:'三井住友カード'
 });
 const repeated=await send('2026-12-15');
 assert.equal(repeated.data.already_synced,true);
 assert.equal(sent.length,1);
});


test('shared attachment editor can trash, restore and reorder; permanent deletion requires trash first',async()=>{
 const env=makeEnv(),a=await boot(env);
 const inv=await req(env,'/api/household/invites',{method:'POST',...auth(a),
   data:{invitee_email:'collaborator@example.invalid'}});
 const joined=await req(env,'/api/household/join',{method:'POST',data:{
   invite_token:inv.data.invite_token,email:'collaborator@example.invalid',
   password:'member-long-secret123',display_name:'家庭成员'}});
 assert.equal(joined.response.status,201);
 const b={cookie:joined.response.headers.get('set-cookie').split(';')[0],
   csrf:joined.data.csrf_token};
 const form=new FormData();
 form.append('file',new File([new Uint8Array([255,216,255,224,1,2,3,4])],
   'shared-page.jpg',{type:'image/jpeg'}));
 form.append('retention','original');
 const upload=await req(env,'/api/documents/import/file',{method:'POST',...auth(a),form});
 assert.equal(upload.response.status,201,JSON.stringify(upload.data));
 const id=upload.data.document_id;
 const before=(await req(env,'/api/documents/'+id,auth(a))).data.document;
 assert.equal(before.visibility,'private');
 assert.equal((await req(env,'/api/documents/'+id+'/attachments/'+before.attachments[0].id+
   '/trash',{method:'POST',...auth(b),data:{}})).response.status,404);
 const shared=await req(env,'/api/documents/'+id,{
   method:'PATCH',...auth(a),data:{visibility:'shared',version:before.version,
    confirm_sensitive_share:true}
 });
 assert.equal(shared.response.status,200);
 const aid=before.attachments[0].id;
 const saved=await req(env,'/api/documents/'+id+'/attachments/'+aid+'/trash',{
   method:'POST',...auth(b),data:{}
 });
 assert.equal(saved.response.status,200,JSON.stringify(saved.data));
 assert.equal(env._blobs.size,1,'a collaborator trash must retain original R2');
 const recycle=await req(env,'/api/documents/'+id+'/attachments/recycle',auth(b));
 assert.equal(recycle.response.status,200);
 assert.equal(recycle.data.items.length,1);
 const restored=await req(env,'/api/documents/'+id+'/attachments/'+aid+'/restore',{
   method:'POST',...auth(b),data:{}
 });
 assert.equal(restored.response.status,200,JSON.stringify(restored.data));
 const purge=await req(env,'/api/documents/'+id+'/attachments/'+aid+'/permanent-delete',{
   method:'POST',...auth(b),data:{confirm:'DELETE_FOREVER'}
 });
 assert.equal(purge.response.status,409);
 assert.equal(env._blobs.size,1);
 const one=env.DB.sql.prepare('SELECT * FROM attachments WHERE id=?').get(aid);
 const second='f'.repeat(32);
 env.DB.sql.prepare('INSERT INTO attachments (id,document_id,object_id,file_label,sort_order,sha256,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
  .run(second,id,one.object_id,'second-page.jpg',1,one.sha256,new Date().toISOString(),new Date().toISOString());
 const details=(await req(env,'/api/documents/'+id,auth(b))).data.document;
 const changed=await req(env,'/api/documents/'+id+'/attachments/order',{
   method:'PATCH',...auth(b),data:{version:details.version,
    attachment_ids:[second,aid]}
 });
 assert.equal(changed.response.status,200,JSON.stringify(changed.data));
 const ordered=env.DB.sql.prepare('SELECT id FROM attachments WHERE document_id=? ORDER BY sort_order')
  .all(id).map(v=>v.id);
 assert.deepEqual(ordered,[second,aid]);
 const audit=env.DB.sql.prepare('SELECT kind,actor_user_id FROM audit_events WHERE actor_user_id=? AND kind IN (\'attachment_trashed\',\'attachment_restored\',\'attachment_order_updated\')').all(joined.data.user.id);
 assert.deepEqual(audit.map(x=>x.kind).sort(),
   ['attachment_order_updated','attachment_restored','attachment_trashed']);
 assert.ok(audit.every(x=>x.actor_user_id===joined.data.user.id));
 // Once the owner revokes sharing, even a known attachment ID is opaque.
 const current=(await req(env,'/api/documents/'+id,auth(a))).data.document;
 assert.equal((await req(env,'/api/documents/'+id,{method:'PATCH',...auth(a),
   data:{version:current.version,visibility:'private'}})).response.status,200);
 assert.equal((await req(env,'/api/documents/'+id+'/attachments/'+aid+'/trash',{
   method:'POST',...auth(b),data:{}})).response.status,404);
 assert.equal(env._blobs.size,1);
});


test('shared editor permanently deletes an explicitly trashed attachment; R2 ownership and audit actor remain distinct',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const inv=await req(env,'/api/household/invites',{method:'POST',...auth(owner),
   data:{invitee_email:'attachment-member@example.invalid'}});
 const joined=await req(env,'/api/household/join',{method:'POST',data:{
   invite_token:inv.data.invite_token,email:'attachment-member@example.invalid',
   password:'strong-member-password-123',display_name:'成员'}});
 assert.equal(joined.response.status,201);
 const member={cookie:joined.response.headers.get('set-cookie').split(';')[0],
   csrf:joined.data.csrf_token};
 const form=new FormData();
 form.append('file',new File([new Uint8Array([255,216,255,224,5,6,7,8])],
  'shared-delete.jpg',{type:'image/jpeg'}));
 form.append('retention','original');
 const up=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form});
 assert.equal(up.response.status,201,JSON.stringify(up.data));
 const id=up.data.document_id;
 const before=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
 const aid=before.attachments[0].id;
 const deny=await req(env,'/api/documents/'+id+'/attachments/'+aid+'/trash',{
  method:'POST',...auth(member),data:{}});
 assert.equal(deny.response.status,404,'private document must remain opaque');
 const shared=await req(env,'/api/documents/'+id,{method:'PATCH',...auth(owner),
  data:{version:before.version,visibility:'shared',confirm_sensitive_share:true}});
 assert.equal(shared.response.status,200);
 // Reuse a single R2 object for two attachment references in the same document.
 // The first shared-editor delete must never destroy its sibling's bytes.
 const source=env.DB.sql.prepare('SELECT * FROM attachments WHERE id=?').get(aid);
 const sibling='e'.repeat(32);
 const now=new Date().toISOString();
 env.DB.sql.prepare(`INSERT INTO attachments
  (id,document_id,object_id,file_label,sort_order,sha256,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?)`).run(sibling,id,source.object_id,'second-copy.jpg',1,
   source.sha256,now,now);
 assert.equal(env._blobs.size,1);
 assert.equal((await req(env,'/api/documents/'+id+'/attachments/'+aid+'/trash',{
  method:'POST',...auth(member),data:{}})).response.status,200);
 const removed=await req(env,'/api/documents/'+id+'/attachments/'+aid+'/permanent-delete',{
  method:'POST',...auth(member),data:{confirm:'DELETE_FOREVER'}});
 assert.equal(removed.response.status,200,JSON.stringify(removed.data));
 assert.equal(env._blobs.size,1,'R2 must remain while sibling attachment still references it');
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM attachments WHERE id=?').get(aid).n,0);
 const tomb=env.DB.sql.prepare("SELECT owner_id FROM deletion_tombstones WHERE request_key=?")
  .get('att:'+aid);
 assert.equal(tomb.owner_id,owner.user.id,'tombstone belongs to original owner, not editor');
 const audit=env.DB.sql.prepare("SELECT actor_user_id FROM audit_events WHERE entity_id=? AND kind='attachment_permanently_deleted'").get(aid);
 assert.equal(audit.actor_user_id,joined.data.user.id,'audit records real executor');
 assert.equal((await req(env,'/api/documents/'+id+'/attachments/'+sibling+'/trash',{
  method:'POST',...auth(member),data:{}})).response.status,200);
 const last=await req(env,'/api/documents/'+id+'/attachments/'+sibling+'/permanent-delete',{
  method:'POST',...auth(member),data:{confirm:'DELETE_FOREVER'}});
 assert.equal(last.response.status,200,JSON.stringify(last.data));
 assert.equal(env._blobs.size,0,'last shared-editor delete cleans only now orphaned R2 object');
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM storage_objects').get().n,0);
 assert.equal(env.DB.sql.prepare("SELECT COUNT(*) n FROM audit_events WHERE actor_user_id=? AND kind='attachment_permanently_deleted'")
  .get(joined.data.user.id).n,2);
 assert.equal((await req(env,'/api/documents/'+id+'/attachments/'+sibling+'/permanent-delete',{
  method:'POST',...auth(member),data:{confirm:'DELETE_FOREVER'}})).response.status,404,
  'repeating the request cannot create an extra delete event');
});

test('revoking shared visibility removes collaborator permanent-delete rights immediately',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const inv=await req(env,'/api/household/invites',{method:'POST',...auth(owner),
  data:{invitee_email:'revoked-editor@example.invalid'}});
 const joined=await req(env,'/api/household/join',{method:'POST',data:{
  invite_token:inv.data.invite_token,email:'revoked-editor@example.invalid',
  password:'member-strong-password-123',display_name:'成员'}});
 const member={cookie:joined.response.headers.get('set-cookie').split(';')[0],
  csrf:joined.data.csrf_token};
 const form=new FormData();
 form.append('file',new File([new Uint8Array([255,216,255,224,8,7,6,5])],
  'revoked.jpg',{type:'image/jpeg'}));
 form.append('retention','original');
 const added=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form});
 const id=added.data.document_id;
 const initial=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
 const aid=initial.attachments[0].id;
 assert.equal((await req(env,'/api/documents/'+id,{method:'PATCH',...auth(owner),
  data:{version:initial.version,visibility:'shared',confirm_sensitive_share:true}})).response.status,200);
 assert.equal((await req(env,'/api/documents/'+id+'/attachments/'+aid+'/trash',{
  method:'POST',...auth(member),data:{}})).response.status,200);
 const visible=(await req(env,'/api/documents/'+id,auth(owner))).data.document;
 assert.equal((await req(env,'/api/documents/'+id,{method:'PATCH',...auth(owner),
  data:{version:visible.version,visibility:'private'}})).response.status,200);
 const unauthorized=await req(env,'/api/documents/'+id+'/attachments/'+aid+'/permanent-delete',{
  method:'POST',...auth(member),data:{confirm:'DELETE_FOREVER'}});
 assert.equal(unauthorized.response.status,404);
 assert.equal(env._blobs.size,1);
 assert.equal(env.DB.sql.prepare('SELECT state FROM attachments WHERE id=?').get(aid).state,'trashed');
 assert.equal(env.DB.sql.prepare("SELECT COUNT(*) n FROM audit_events WHERE actor_user_id=? AND kind='attachment_permanently_deleted'")
  .get(joined.data.user.id).n,0);
 const allowed=await req(env,'/api/documents/'+id+'/attachments/'+aid+'/permanent-delete',{
  method:'POST',...auth(owner),data:{confirm:'DELETE_FOREVER'}});
 assert.equal(allowed.response.status,200,JSON.stringify(allowed.data));
 assert.equal(env._blobs.size,0);
});


test('an already authorized shared-attachment purge finishes metadata cleanup if sharing changes during R2.delete',async()=>{
 const env=makeEnv(),owner=await boot(env);
 const inv=await req(env,'/api/household/invites',{method:'POST',...auth(owner),
  data:{invitee_email:'midflight@example.invalid'}});
 const joined=await req(env,'/api/household/join',{method:'POST',data:{
  invite_token:inv.data.invite_token,email:'midflight@example.invalid',
  password:'long-safe-password-123',display_name:'协作者'}});
 assert.equal(joined.response.status,201);
 const member={cookie:joined.response.headers.get('set-cookie').split(';')[0],
  csrf:joined.data.csrf_token};
 const form=new FormData();
 form.append('file',new File([new Uint8Array([255,216,255,224,1,3,3,7])],
  'midflight.jpg',{type:'image/jpeg'}));
 form.append('retention','original');
 const upload=await req(env,'/api/documents/import/file',{method:'POST',...auth(owner),form});
 assert.equal(upload.response.status,201);
 const docId=upload.data.document_id;
 const doc=(await req(env,'/api/documents/'+docId,auth(owner))).data.document;
 const aid=doc.attachments[0].id;
 assert.equal((await req(env,'/api/documents/'+docId,{
  method:'PATCH',...auth(owner),data:{version:doc.version,visibility:'shared',confirm_sensitive_share:true}
 })).response.status,200);
 assert.equal((await req(env,'/api/documents/'+docId+'/attachments/'+aid+'/trash',{
  method:'POST',...auth(member),data:{}})).response.status,200);
 let r2Calls=0;
 env.DOCUMENTS.delete=async key=>{
  r2Calls++;
  // Simulate a different device revoking access after the R2 claim. The
  // permanent deletion was authorized before physical removal started.
  env.DB.sql.prepare("UPDATE documents SET visibility='private' WHERE id=?").run(docId);
  env._blobs.delete(key);
 };
 const result=await req(env,'/api/documents/'+docId+'/attachments/'+aid+'/permanent-delete',{
  method:'POST',...auth(member),data:{confirm:'DELETE_FOREVER'}});
 assert.equal(result.response.status,200,JSON.stringify(result.data));
 assert.equal(r2Calls,1);
 assert.equal(env._blobs.size,0);
 assert.equal(env.DB.sql.prepare('SELECT COUNT(*) n FROM attachments WHERE id=?').get(aid).n,0,
  'do not retain a reference to already deleted R2 bytes');
 assert.equal(env.DB.sql.prepare("SELECT visibility FROM documents WHERE id=?").get(docId).visibility,'private');
 assert.equal(env.DB.sql.prepare('SELECT owner_id FROM deletion_tombstones WHERE request_key=?')
  .get('att:'+aid).owner_id,owner.user.id);
 assert.equal(env.DB.sql.prepare("SELECT actor_user_id FROM audit_events WHERE kind='attachment_permanently_deleted' AND entity_id=?")
  .get(aid).actor_user_id,joined.data.user.id);
 assert.equal((await req(env,'/api/documents/'+docId,auth(member))).response.status,404,
  'after revocation, no further private reads are granted');
});
