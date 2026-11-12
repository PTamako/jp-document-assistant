import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {GEMINI_MODEL,GEMINI_DAY_LIMIT,GEMINI_MINUTE_LIMIT,geminiQuotaSlots,geminiQuotaUsage,reserveGeminiRequest} from '../worker/gemini-budget.js';

function fixture(){
 const sql=new DatabaseSync(':memory:');
 sql.exec(fs.readFileSync(new URL('../migrations/0016_gemini_daily_budget.sql',import.meta.url),'utf8'));
 const db={prepare(query){return {bind(...args){return {
   first:async()=>sql.prepare(query).get(...args)||null,
   run:async()=>({meta:{changes:sql.prepare(query).run(...args).changes}})
  }}}}};
 return {sql,db};
}
test('Gemini 3.6 Flash uses the screenshot limits as a shared, model-specific cap',()=>{
 assert.equal(GEMINI_MODEL,'gemini-3.6-flash');
 assert.equal(GEMINI_DAY_LIMIT,20);
 assert.equal(GEMINI_MINUTE_LIMIT,5);
});
test('Pacific reset stays correct across standard time and daylight saving transitions',()=>{
 assert.equal(geminiQuotaSlots(new Date('2026-11-13T07:59:59Z')).dayPt,'2026-11-12');
 assert.equal(geminiQuotaSlots(new Date('2026-11-13T08:00:00Z')).dayPt,'2026-11-13');
 assert.equal(geminiQuotaSlots(new Date('2026-03-08T07:59:59Z')).dayPt,'2026-03-07');
 assert.equal(geminiQuotaSlots(new Date('2026-03-08T08:00:00Z')).dayPt,'2026-03-08');
 assert.equal(geminiQuotaSlots(new Date('2026-07-01T07:00:00Z')).dayPt,'2026-07-01');
});
test('20 attempts/day and 5 attempts/minute are enforced atomically for both family members',async()=>{
 const {db,sql}=fixture();
 const current=new Date('2026-11-12T18:00:00Z');
 assert.deepEqual((await geminiQuotaUsage(db,current)).calls,0);
 const five=await Promise.all(Array.from({length:5},()=>reserveGeminiRequest(db,current)));
 assert.equal(five.every(x=>x.allowed),true);
 const denied=await reserveGeminiRequest(db,current);
 assert.deepEqual(denied,{allowed:false,code:'gemini_minute_limit'});
 assert.equal((await geminiQuotaUsage(db,current)).calls,5);
 for(let min=1;min<=3;min++){
  const at=new Date(current.getTime()+min*60000);
  const results=await Promise.all(Array.from({length:5},()=>reserveGeminiRequest(db,at)));
  assert.equal(results.every(x=>x.allowed),true);
 }
 const full=await geminiQuotaUsage(db,new Date(current.getTime()+3*60000));
 assert.equal(full.calls,20);
 assert.equal(full.remaining,0);
 assert.equal((await reserveGeminiRequest(db,new Date(current.getTime()+4*60000))).code,'gemini_daily_limit');
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM gemini_api_daily').get().n,1,'no duplicated counter per household user');
 assert.equal(sql.prepare('SELECT calls FROM gemini_api_daily').get().calls,20);
 const reset=new Date('2026-11-13T08:00:00Z');
 assert.equal((await geminiQuotaUsage(db,reset)).calls,0);
 assert.deepEqual(await reserveGeminiRequest(db,reset),{allowed:true});
 assert.equal((await geminiQuotaUsage(db,reset)).calls,1);
 sql.close();
});
test('existing Gemini 3.5 usage must not count toward 3.6 and missing schema fails closed',async()=>{
 const {db,sql}=fixture();
 const at=new Date('2026-11-12T18:10:00Z');
 sql.prepare("INSERT INTO gemini_api_daily(model_id,day_pt,calls,minute_utc,minute_calls) VALUES(?,?,?,?,?)")
  .run('gemini-3.5-flash','2026-11-12',20,'2026-11-12T18:09',5);
 assert.equal((await geminiQuotaUsage(db,at)).calls,0);
 assert.deepEqual(await reserveGeminiRequest(db,at),{allowed:true});
 sql.exec('DROP TABLE gemini_api_daily');
 await assert.rejects(reserveGeminiRequest(db,at),/no such table/);
});
