import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {ocrSpaceAttachment} from '../worker/ocr-space.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const owner='owner',objectId='object-one',attachment='a'.repeat(32),docId='d'.repeat(32);
const source=new TextEncoder().encode('private synthetic fake image');
const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
const request=(extra={})=>new Request('https://test.example/api/documents/'+docId+'/ocr-space',{
 method:'POST',headers:{'Content-Type':'application/json'},
 body:JSON.stringify({attachment_id:attachment,confirm_ocr_space:true,confirm_private_upload:true,...extra})
});
function fixture({initial=null,limit=20,failCount=0,claimCollision=false}={}){
 let attempt=initial,used=0,remote=0;
 const DB={prepare(sql){return {bind(...a){return {
  async first(){
   if(sql.includes('JOIN attachments'))return {object_id:objectId,object_key:'private/mock',bytes:source.length,mime:'image/png',sha256:await digest(source)};
   if(sql.includes('FROM ocr_attempts'))return attempt?{...attempt}:null;
   throw Error('Unknown SQL first '+sql);
  },
  async run(){
   if(sql.includes('INSERT OR IGNORE INTO ocr_space_utc_daily'))return {meta:{changes:1}};
   if(sql.includes('UPDATE ocr_space_utc_daily SET calls=calls+1')){
    if(used>=limit)return {meta:{changes:0}};
    used++;return {meta:{changes:1}};
   }
   if(sql.includes('UPDATE ocr_space_utc_daily SET calls=MAX')){used=Math.max(0,used-1);return {meta:{changes:1}};}
   if(sql.includes('INSERT OR IGNORE INTO ocr_attempts')){
    if(attempt||claimCollision)return {meta:{changes:0}};
    attempt={id:a[0],owner_id:a[1],object_id:a[2],model_id:a[3],prompt_version:a[4],
      state:'pending',attempt_count:1,updated_at:a[6],candidate_text_ja:null};return {meta:{changes:1}};
   }
   if(sql.includes("SET state='pending',attempt_count=attempt_count+1")){
    if(claimCollision||!attempt||attempt.updated_at!==a[6]||attempt.attempt_count>=2)
      return {meta:{changes:0}};
    attempt={...attempt,state:'pending',attempt_count:attempt.attempt_count+1,
      candidate_text_ja:null,updated_at:a[0]};return {meta:{changes:1}};
   }
   if(sql.includes("UPDATE ocr_attempts SET state='success'")){
    attempt={...attempt,state:'success',candidate_text_ja:a[0],updated_at:a[1]};
    return {meta:{changes:1}};
   }
   if(sql.includes("UPDATE ocr_attempts SET state='failed'")){
    attempt={...attempt,state:'failed',updated_at:a[0]};return {meta:{changes:1}};
   }
   throw Error('Unknown SQL run '+sql);
  }
 };}}}};
 const env={DB,OCR_SPACE_API_KEY:'synthetic-test-only',OCR_SPACE_FREE_ONLY_CONFIRMED:'true',
  OCR_SPACE_APP_UTC_DAILY_LIMIT:String(limit),
  DOCUMENTS:{async get(){return {async arrayBuffer(){return source.slice().buffer}}}},
  OCR_SPACE_FETCH:async()=>{
   remote++;
   if(remote<=failCount)return Response.json({error:'unavailable'},{status:503});
   return Response.json({OCRExitCode:1,IsErroredOnProcessing:false,
    ParsedResults:[{FileParseExitCode:1,ParsedText:'東京都のお知らせ'}]});
  }};
 return {env,call:(x={})=>ocrSpaceAttachment(request(x),env,{user_id:owner},docId),
  get attempt(){return attempt;},setLastAt(value){attempt.updated_at=value;},
  get used(){return used;},get remote(){return remote;}};
}
test('transient provider failure permits one manual retry and then reuses success cache',async()=>{
 const f=fixture({failCount:1});
 assert.equal((await f.call()).status,503);
 assert.equal(f.attempt.state,'failed');assert.equal(f.used,1);assert.equal(f.remote,1);
 assert.equal((await f.call()).status,429,'cooldown prevents immediate repeat');
 assert.equal(f.remote,1);assert.equal(f.used,1);
 f.setLastAt(new Date(Date.now()-6*60*1000).toISOString());
 const retried=await f.call();
 assert.equal(retried.status,200);assert.equal((await retried.json()).cached,false);
 assert.equal(f.attempt.attempt_count,2);
 const cached=await f.call();assert.equal((await cached.json()).cached,true);
 assert.equal(f.used,2);assert.equal(f.remote,2);
});
test('only two OCR.space attempts per object even after more failures',async()=>{
 const f=fixture({failCount:4});
 assert.equal((await f.call()).status,503);
 f.setLastAt(new Date(Date.now()-6*60*1000).toISOString());
 assert.equal((await f.call()).status,503);
 f.setLastAt(new Date(Date.now()-6*60*1000).toISOString());
 const denied=await f.call();
 assert.equal(denied.status,409);
 assert.equal((await denied.json()).code,'OCR_SPACE_RETRY_LIMIT');
 assert.equal(f.remote,2);assert.equal(f.used,2);
});
test('stuck pending requests require a 24h expiry and renewed consent before retry',async()=>{
 const previous={id:'previous',state:'pending',attempt_count:1,updated_at:new Date(Date.now()-25*3600000).toISOString()};
 const f=fixture({initial:previous});
 assert.equal((await f.call()).status,409);
 assert.equal(f.remote,0);
 assert.equal((await f.call({retry_stale:true})).status,200);
 assert.equal(f.attempt.attempt_count,2);assert.equal(f.remote,1);
});
test('a failed CAS claim refunds the daily budget and never reads the private original',async()=>{
 const f=fixture({initial:{id:'prior',state:'failed',attempt_count:1,updated_at:new Date(Date.now()-6*60*1000).toISOString()},claimCollision:true});
 const result=await f.call();
 assert.equal(result.status,409);assert.equal(f.used,0);assert.equal(f.remote,0);
});
test('quota exhaustion does not consume a retry or contact OCR provider',async()=>{
 const f=fixture({limit:0});
 assert.equal((await f.call()).status,503);
 assert.equal(f.remote,0);
});
