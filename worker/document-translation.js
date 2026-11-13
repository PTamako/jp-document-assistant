// Reuse the existing private HMAC Service Binding to 知学, which already owns
// the free Google Apps Script LanguageApp secrets. No Google credentials or
// private text are put into browser bundles, R2, third-party fallbacks, or logs.
import {hashString,hmacHex,isoNow} from './security.js';
import {json,readJson,bad} from './http.js';

export const MAX_TRANSLATION_CHARS=8000;
export const MAX_CHUNK_CHARS=1150;
export const MAX_TRANSLATION_CHUNKS=8;
export const MAX_GOOGLE_CALLS_PER_JST_DAY=80;
const ENDPOINT='https://internal.invalid/api/bridge/document-assistant/translate';
const provider='zhixue_gas';
const jstDay=()=>new Date(Date.now()+9*60*60*1000).toISOString().slice(0,10);
const messageByRemoteError={
  bridge_disabled:'知学翻译联动未开启',
  bridge_not_configured:'知学翻译联动尚未配置',
  translator_not_configured:'知学尚未配置 Google Apps Script 翻译',
  translation_unavailable:'Google 免费翻译暂不可用，请稍后再试',
  expired_signature:'翻译联动请求已失效',
  invalid_signature:'翻译联动身份验证失败',
};
export function splitJapaneseDocument(text,max=MAX_CHUNK_CHARS){
 if(typeof text!=='string'||!text.trim()||text.length>MAX_TRANSLATION_CHARS)
  throw Object.assign(new Error('原文为空或超过 8000 字'),{code:'INVALID_TEXT',status:400});
 const chunks=[];
 let rest=text.replace(/\r\n?/g,'\n').trim();
 while(rest){
  if(rest.length<=max){chunks.push(rest);break;}
  // Preserve clause boundaries and paragraphs where possible without
  // truncating or silently dropping any characters.
  let cut=max;
  for(const mark of ['\n','。','！','？','；','、','，',' ','\t']){
   const i=rest.lastIndexOf(mark,max-1);
   if(i>=Math.floor(max*.92)){cut=i+1;break;}
  }
  chunks.push(rest.slice(0,cut));
  rest=rest.slice(cut);
 }
 if(chunks.length>MAX_TRANSLATION_CHUNKS)
  throw Object.assign(new Error('原文分段过多，请拆分文书后翻译'),{code:'TOO_MANY_CHUNKS',status:400});
 return chunks;
}
const status=(code,message,http)=>json({ok:false,code,message},http);
async function cachedTranslation(db,doc){
 const text=String(doc.extracted_text_ja||'').trim();
 if(!text)return null;
 const sourceSha=await hashString(text);
 const row=await db.prepare(`SELECT source_sha,translation_zh FROM document_translations
   WHERE document_id=?`).bind(doc.id).first();
 if(row?.source_sha===sourceSha&&typeof row.translation_zh==='string'&&row.translation_zh.trim())
  return {translation:row.translation_zh,sourceSha};
 return {translation:null,sourceSha};
}
async function fromZhixue(chunk,env){
 const service=env.ZHIXUE_BRIDGE_SERVICE,secret=env.ZHIXUE_BRIDGE_SECRET;
 if(typeof service?.fetch!=='function'||typeof secret!=='string'||secret.length<32)
  throw Object.assign(new Error('知学联动服务未配置'),{code:'NOT_CONFIGURED',status:503});
 const body={source:'jp-document-assistant',operation:'translate_chunk',
  source_language:'ja',target_language:'zh-CN',text:chunk};
 const raw=JSON.stringify(body),stamp=String(Date.now());
 const signature=await hmacHex(secret,stamp+'\n'+raw);
 let response;
 try{
  response=await service.fetch(new Request(ENDPOINT,{method:'POST',headers:{
   'Content-Type':'application/json; charset=utf-8',
   'X-DA-Timestamp':stamp,'X-DA-Signature':signature,
  },body:raw,signal:typeof AbortSignal.timeout==='function'?AbortSignal.timeout(16000):undefined}));
 }catch{
  throw Object.assign(new Error('知学翻译连接失败'),{code:'PROVIDER_NETWORK',status:503});
 }
 const data=await response.json().catch(()=>null);
 if(!response.ok||data?.ok!==true||typeof data.translation!=='string'||!data.translation.trim()){
  const remote=String(data?.error||'translation_unavailable');
  const code=remote==='translator_not_configured'?'NOT_CONFIGURED':'PROVIDER_UNAVAILABLE';
  throw Object.assign(new Error(messageByRemoteError[remote]||'Google 免费翻译暂不可用'),{
   code,status:503});
 }
 return data.translation.trim();
}
export async function handleDocumentTranslation(request,env,doc){
 if(!doc||doc.lifecycle!=='active')bad('文书不存在或没有操作权限','NOT_FOUND',404);
 const cached=await cachedTranslation(env.DB,doc);
 if(request.method==='GET'){
  return json({ok:true,cached:!!cached?.translation,translation:cached?.translation||null,
   provider:cached?.translation?provider:null});
 }
 if(request.method!=='POST')return status('METHOD_NOT_ALLOWED','请求方法不支持',405);
 const body=await readJson(request,400);
 // Explicit per-document Google consent cannot be inherited from AI consent.
 if(body?.confirm_google_translation!==true)
  return status('CONSENT_REQUIRED','请确认发送本份日文原文至 Google 免费翻译',409);
 if(cached?.translation)return json({ok:true,cached:true,translation:cached.translation,provider});
 const source=String(doc.extracted_text_ja||'').trim();
 const chunks=splitJapaneseDocument(source);
 if(typeof env.ZHIXUE_BRIDGE_SERVICE?.fetch!=='function'||!env.ZHIXUE_BRIDGE_SECRET)
  return status('NOT_CONFIGURED','知学翻译联动尚未配置',503);
 const day=jstDay();
 await env.DB.prepare(`INSERT OR IGNORE INTO document_translation_daily_budget(japan_day,calls)
   VALUES(?,0)`).bind(day).run();
 const reserved=await env.DB.prepare(`UPDATE document_translation_daily_budget
   SET calls=calls+? WHERE japan_day=? AND calls+?<=?`)
   .bind(chunks.length,day,chunks.length,MAX_GOOGLE_CALLS_PER_JST_DAY).run();
 if(reserved.meta?.changes!==1)
  return status('DAILY_BUDGET_EXHAUSTED','文书机翻今日免费调用预算已用完，明天再试',429);
 // Run at most two Google Script calls simultaneously. Long documents never
 // download ONNX/WASM to the iPhone and the Worker never buffers model weights.
 const translated=new Array(chunks.length);
 try{
  for(let i=0;i<chunks.length;i+=2){
   const segment=await Promise.all(chunks.slice(i,i+2).map(c=>fromZhixue(c,env)));
   for(let j=0;j<segment.length;j++)translated[i+j]=segment[j];
  }
 }catch(e){
  // Provider outages cannot commit partial translations to D1.
  // Never return raw provider exceptions, text, or secret-bearing URLs.
  return status(e?.code||'PROVIDER_UNAVAILABLE',
    ['NOT_CONFIGURED','PROVIDER_NETWORK','PROVIDER_UNAVAILABLE'].includes(e?.code)?
      e.message:'Google 免费翻译暂不可用',e?.status||503);
 }
 const result=translated.join('\n');
 // Do not resurrect deleted documents or commit stale text after manual edits.
 const saved=await env.DB.prepare(`INSERT INTO document_translations
   (document_id,source_sha,translation_zh,provider,created_at,updated_at)
   SELECT id,?,?,?, ?,? FROM documents
   WHERE id=? AND lifecycle='active' AND extracted_text_ja=?
   ON CONFLICT(document_id) DO UPDATE SET
   source_sha=excluded.source_sha,translation_zh=excluded.translation_zh,
   provider=excluded.provider,updated_at=excluded.updated_at`)
  .bind(cached.sourceSha,result,provider,isoNow(),isoNow(),doc.id,doc.extracted_text_ja).run();
 if(saved.meta?.changes!==1)
  return status('SOURCE_CHANGED','文书原文已更新，请重新点翻译',409);
 return json({ok:true,cached:false,translation:result,provider});
}
