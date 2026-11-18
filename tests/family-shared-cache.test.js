import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {getDocumentAiCache} from '../worker/intelligence.js';
import {enqueueDocumentAi} from '../worker/ai-jobs.js';
import {handleDocumentTranslation} from '../worker/document-translation.js';

const japanese='お支払いのご案内です。';
const sha=createHash('sha256').update(japanese).digest('hex');
const receiver={id:'receiver',household_id:'family-1',visibility:'shared',lifecycle:'active',
  ai_provider:'cloudflare',extracted_text_ja:japanese};
const aiRow={provider:'cloudflare',source_sha:sha,model_id:'@cf/qwen/qwen3.8-27b',
  prompt_version:'document-v3-20261112-json',state:'success',
  result_json:JSON.stringify({summary_zh:'已保存的中文解析',explanation_zh:'家庭成员已完成解析，不必再次请求 AI'})};
class FamilyDb {
 constructor(){this.donor={id:'donor',household_id:'family-1',visibility:'shared',
   lifecycle:'active',ai_provider:'cloudflare',extracted_text_ja:japanese};
  this.translation={source_sha:sha,provider:'zhixue_gas',translation_zh:'已保存的中文译文'};
  this.calls=[];
 }
 prepare(sql){
  return {bind:(...args)=>({
    first:async()=>{
      this.calls.push({sql,args});
      if(sql.includes('FROM document_ai_analyses WHERE document_id=?'))return null;
      if(sql.includes('FROM document_ai_analyses a JOIN documents d')){
        const [household,id,source,provider,analysisProvider,sourceHash,model]=args;
        return this.donor.household_id===household&&this.donor.id!==id&&
          this.donor.extracted_text_ja===source&&this.donor.ai_provider===provider&&
          this.donor.visibility==='shared'&&this.donor.lifecycle==='active'&&
          aiRow.provider===analysisProvider&&aiRow.source_sha===sourceHash&&
          aiRow.model_id===model?aiRow:null;
      }
      if(sql.includes('FROM document_translations t')){
        const [household,id,sourceHash,provider,source]=args;
        return this.donor.household_id===household&&this.donor.id!==id&&
          this.donor.visibility==='shared'&&this.donor.lifecycle==='active'&&
          this.donor.extracted_text_ja===source&&
          this.translation.source_sha===sourceHash&&this.translation.provider===provider
          ?{translation_zh:this.translation.translation_zh}:null;
      }
      if(sql.includes('FROM document_translations'))return null;
      throw Error('unexpected query '+sql);
    },
    run:async()=>{throw Error('cache hit must not reserve quota or write');}
  })};
 }
}
const get=()=>new Request('https://app.test/api/documents/receiver/translation');
const post=()=>new Request('https://app.test/api/documents/receiver/translation',{
  method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({confirm_google_translation:true})
});
test('two explicitly shared records reuse AI success without enqueuing another inference',async()=>{
 const db=new FamilyDb();
 const cached=await getDocumentAiCache(db,receiver);
 assert.equal(cached.status,'success');
 assert.equal(cached.result.summary_zh,'已保存的中文解析');
 assert.deepEqual(await enqueueDocumentAi({DB:db},receiver),{ai_status:'cached'});
 assert.ok(db.calls.every(x=>!x.sql.includes('UPDATE')));
});
test('AI cache cannot cross household or visibility boundaries',async()=>{
 const db=new FamilyDb();
 assert.equal(await getDocumentAiCache(db,{...receiver,visibility:'private'}),null);
 assert.equal(await getDocumentAiCache(db,{...receiver,household_id:'other-family'}),null);
 db.donor.visibility='private';
 assert.equal(await getDocumentAiCache(db,receiver),null);
 db.donor.visibility='shared';db.donor.lifecycle='trashed';
 assert.equal(await getDocumentAiCache(db,receiver),null);
});
test('family-translated document supports repeated GET/POST without external calls or quota reservations',async()=>{
 const db=new FamilyDb();let calls=0;
 const env={DB:db,ZHIXUE_BRIDGE_SECRET:'would-not-be-used',
    ZHIXUE_BRIDGE_SERVICE:{fetch:()=>{calls++;throw Error('should not call external translator');}}};
 const first=await (await handleDocumentTranslation(get(),env,receiver)).json();
 const second=await (await handleDocumentTranslation(post(),env,receiver)).json();
 assert.equal(first.cached,true);
 assert.equal(second.cached,true);
 assert.equal(first.translation,'已保存的中文译文');
 assert.equal(calls,0);
 assert.equal(db.calls.filter(x=>/document_translation_daily_budget/.test(x.sql)).length,0);
});
test('private or revoked translations cannot be reused across records',async()=>{
 const db=new FamilyDb(),env={DB:db};
 assert.equal((await (await handleDocumentTranslation(get(),env,{...receiver,visibility:'private'})).json()).cached,false);
 db.donor.visibility='private';
 assert.equal((await (await handleDocumentTranslation(get(),env,receiver)).json()).cached,false);
 db.donor.visibility='shared';db.donor.household_id='other-family';
 assert.equal((await (await handleDocumentTranslation(get(),env,receiver)).json()).cached,false);
});
