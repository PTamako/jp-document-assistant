import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {splitJapaneseDocument,handleDocumentTranslation,documentTranslationBudgetUsage,MAX_GOOGLE_CALLS_PER_JST_DAY} from '../worker/document-translation.js';

class FakeDb{
 constructor(){this.cache=new Map();this.budget=new Map();this.docs=new Map();}
 prepare(sql){const db=this;return {bind(...args){return {
  async first(){
   if(sql.includes('FROM document_translations'))return db.cache.get(args[0])||null;
   if(sql.includes('FROM document_translation_daily_budget'))return db.budget.has(args[0])?{calls:db.budget.get(args[0])}:null;
   throw Error('unknown SQL read '+sql);
  },
  async run(){
   if(sql.includes('INSERT OR IGNORE INTO document_translation_daily_budget')){
    if(!db.budget.has(args[0]))db.budget.set(args[0],0);
    return {meta:{changes:1}};
   }
   if(sql.includes('UPDATE document_translation_daily_budget')){
    const [count,day,,limit]=args,prior=db.budget.get(day)||0;
    if(prior+count>limit)return {meta:{changes:0}};
    db.budget.set(day,prior+count);
    return {meta:{changes:1}};
   }
   if(sql.includes('INSERT INTO document_translations')){
    const [sha,translation,provider,created,updated,id,original]=args;
    if(db.docs.get(id)!==original)return {meta:{changes:0}};
    db.cache.set(id,{source_sha:sha,translation_zh:translation,provider,created_at:created,updated_at:updated});
    return {meta:{changes:1}};
   }
   throw Error('unknown SQL write '+sql);
  }
 };}};}
}
const secret='zhixue-bridge-secret-only-used-in-server-123';
const doc={id:'doc1',lifecycle:'active',extracted_text_ja:'お支払いのご案内です。'};
const get=(id='doc1')=>new Request('https://app.test/api/documents/'+id+'/translation');
const post=(body={confirm_google_translation:true})=>new Request('https://app.test/api/documents/doc1/translation',{
 method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const create=()=>{const db=new FakeDb();db.docs.set('doc1',doc.extracted_text_ja);
 const calls=[];
 const env={DB:db,ZHIXUE_BRIDGE_SECRET:secret,ZHIXUE_BRIDGE_SERVICE:{
  async fetch(request){
   const body=await request.text();
   const stamp=request.headers.get('X-DA-Timestamp');
   const signature=createHmac('sha256',secret).update(stamp+'\n'+body).digest('hex');
   assert.equal(request.headers.get('X-DA-Signature'),signature);
   const data=JSON.parse(body);calls.push(data);
   assert.equal(data.operation,'translate_chunk');
   assert.equal(data.source,'jp-document-assistant');
   assert.equal(data.source_language,'ja');
   assert.equal(data.target_language,'zh-CN');
   return new Response(JSON.stringify({ok:true,translation:'中文译文'}));
  }
 }};
 return {db,calls,env};
};
test('document splitter preserves the full source and caps each Google call',()=>{
 const input=('本日は晴れです。\n').repeat(320);
 const chunks=splitJapaneseDocument(input);
 assert.equal(chunks.join(''),input.trim());
 assert.ok(chunks.every(x=>x.length<=1150));
 assert.ok(chunks.length<=8);
 assert.throws(()=>splitJapaneseDocument('あ'.repeat(8001)),/超过 8000/);
 assert.throws(()=>splitJapaneseDocument(''),/原文为空/);
});
test('GET never contacts Google and exposes only fresh D1 private cache',async()=>{
 const {db,calls,env}=create();
 const first=await handleDocumentTranslation(get(),env,doc);
 assert.deepEqual(await first.json(),{ok:true,cached:false,translation:null,provider:null});
 assert.equal(calls.length,0);assert.equal(db.budget.size,0);
});
test('explicit per-document consent required, request body text never trusted',async()=>{
 const {calls,env}=create();
 const denied=await handleDocumentTranslation(post({}),env,doc);
 assert.equal(denied.status,409);
 assert.equal(calls.length,0);
 const response=await handleDocumentTranslation(post({confirm_google_translation:true,text:'secret override'}),env,doc);
 assert.equal(response.status,200);
 assert.equal(calls.length,1);
 assert.equal(calls[0].text,doc.extracted_text_ja);
});
test('successful Google machine translation cached and reused with no repeat call',async()=>{
 const {db,calls,env}=create();
 const one=await handleDocumentTranslation(post(),env,doc);
 const content=await one.json();
 assert.equal(content.translation,'中文译文');
 assert.equal(content.provider,'zhixue_gas');
 assert.equal(content.cached,false);
 const check=await handleDocumentTranslation(get(),env,doc);
 assert.equal((await check.json()).cached,true);
 const repeat=await handleDocumentTranslation(post(),env,doc);
 assert.equal((await repeat.json()).cached,true);
 assert.equal(calls.length,1);
 assert.equal([...db.budget.values()][0],1);
});
test('changing original source invalidates previously cached translation',async()=>{
 const {db,calls,env}=create();
 await handleDocumentTranslation(post(),env,doc);
 const edited={...doc,extracted_text_ja:'書類の内容が変更されました。'};
 db.docs.set(doc.id,edited.extracted_text_ja);
 const read=await handleDocumentTranslation(get(),env,edited);
 assert.equal((await read.json()).cached,false);
 await handleDocumentTranslation(post(),env,edited);
 assert.equal(calls.length,2);
});
test('provider unavailable never silently falls back to AI or third-party text services',async()=>{
 const {db,env}=create();
 env.ZHIXUE_BRIDGE_SERVICE.fetch=async()=>new Response(JSON.stringify({ok:false,error:'translation_unavailable'}),{status:503});
 const resp=await handleDocumentTranslation(post(),env,doc);
 assert.equal(resp.status,503);
 assert.equal((await resp.json()).code,'PROVIDER_UNAVAILABLE');
 assert.equal(db.cache.size,0);
});
test('hard daily budget stops new translations before any remote call',async()=>{
 const {db,calls,env}=create();
 const day=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
 db.budget.set(day,MAX_GOOGLE_CALLS_PER_JST_DAY);
 const response=await handleDocumentTranslation(post(),env,doc);
 assert.equal(response.status,429);
 assert.equal(calls.length,0);
});
test('stale text changed mid-request never writes or displays incorrect translation',async()=>{
 const {db,env}=create();
 env.ZHIXUE_BRIDGE_SERVICE.fetch=async()=>{
  db.docs.set(doc.id,'新しい内容');
  return new Response(JSON.stringify({ok:true,translation:'过时翻译'}));
 };
 const response=await handleDocumentTranslation(post(),env,doc);
 assert.equal(response.status,409);
 assert.equal(db.cache.size,0);
});

test('reopening a translated document after quota exhaustion reuses persistent cache for zero Google calls',async()=>{
 const {db,calls,env}=create();
 const first=await handleDocumentTranslation(post(),env,doc);
 assert.equal((await first.json()).cached,false);
 const day=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
 db.budget.set(day,MAX_GOOGLE_CALLS_PER_JST_DAY);
 // Two independent subsequent requests after a PWA restart: no in-memory
 // translation state is assumed, only the stored private D1 record.
 const reopened=await handleDocumentTranslation(get(),env,{...doc});
 assert.deepEqual(await reopened.json(),{
  ok:true,cached:true,translation:'中文译文',provider:'zhixue_gas'
 });
 const repeated=await handleDocumentTranslation(post(),env,{...doc});
 assert.equal((await repeated.json()).cached,true);
 assert.equal(calls.length,1,'Google should be called exactly once even at the daily limit');
 assert.equal(db.budget.get(day),MAX_GOOGLE_CALLS_PER_JST_DAY,'cached read does not consume quota');
});
test('JST daily quota endpoint reports the authoritative reserved budget, not Google account balance',async()=>{
 const {db}=create();
 const beforeMidnight=Date.parse('2026-11-13T14:59:59Z');
 const afterMidnight=Date.parse('2026-11-13T15:00:01Z');
 db.budget.set('2026-11-13',7);
 const before=await documentTranslationBudgetUsage(db,beforeMidnight);
 assert.deepEqual(before,{
  japan_day:'2026-11-13',calls:7,limit:80,remaining:73,
  count_type:'reserved_chunks',scope:'document_assistant_only'
 });
 const after=await documentTranslationBudgetUsage(db,afterMidnight);
 assert.equal(after.japan_day,'2026-11-14');
 assert.equal(after.calls,0);
 assert.equal(after.remaining,80);
});
