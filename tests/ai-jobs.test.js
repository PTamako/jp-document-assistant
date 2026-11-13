import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {enqueueDocumentAi,getDocumentAiJob,processDocumentAiJob} from '../worker/ai-jobs.js';

function setup(){
 const sql=new DatabaseSync(':memory:');
 sql.exec("PRAGMA foreign_keys=ON; CREATE TABLE documents(id TEXT PRIMARY KEY, lifecycle TEXT DEFAULT 'active');");
 sql.exec(fs.readFileSync(new URL('../migrations/0012_document_ai_analysis.sql',import.meta.url),'utf8'));
 sql.exec(fs.readFileSync(new URL('../migrations/0018_document_ai_jobs.sql',import.meta.url),'utf8'));
 const db={prepare(query){return {bind(...args){const s=sql.prepare(query);
 return {first:async()=>s.get(...args)||null,run:async()=>({meta:{changes:s.run(...args).changes}}),all:async()=>({results:s.all(...args)})};}}}};
 sql.prepare("INSERT INTO documents(id,lifecycle) VALUES('doc1','active')").run();
 return {sql,env:{DB:db}};
}
const doc=(text='これは請求書です。',provider='gemini')=>({
 id:'doc1',extracted_text_ja:text,ai_provider:provider,ai_consent_at:'2026-11-13T00:00:00Z',category:'utility'
});
test('enqueue is nonblocking and deduplicates repeat taps',async()=>{
 const {env,sql}=setup();
 assert.equal((await enqueueDocumentAi(env,doc())).ai_status,'queued');
 assert.equal((await enqueueDocumentAi(env,doc())).ai_status,'in_progress');
 const job=await getDocumentAiJob(env.DB,'doc1');
 assert.equal(job.state,'queued');
 assert.equal(job.attempts,0);
 assert.equal(sql.prepare("SELECT COUNT(*) c FROM document_ai_jobs").get().c,1);
 sql.close();
});
test('edited source replaces stale queued work without losing document',async()=>{
 const {env,sql}=setup();
 await enqueueDocumentAi(env,doc());
 assert.equal((await enqueueDocumentAi(env,doc('これは別の通知です。'))).ai_status,'queued');
 assert.equal((await getDocumentAiJob(env.DB,'doc1')).state,'queued');
 const state=await processDocumentAiJob(env,'doc1');
 assert.equal(state.ai_status,'stale_or_deleted');
 assert.equal((await getDocumentAiJob(env.DB,'doc1')).state,'failed');
 assert.equal(sql.prepare("SELECT COUNT(*) c FROM documents").get().c,1);
 sql.close();
});
