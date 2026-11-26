import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('production Cron stays at five minutes with preview disabled',()=>{
 const s=read('wrangler.jsonc');
 assert.match(s,/"crons":\s*\["\*\/5 \* \* \* \*"\]/);
 assert.match(s,/"preview_urls":\s*false/);
});
test('deletion reserves a valid lifecycle and checks all approval history before R2 deletion',()=>{
 const s=read('worker/index.js').split('async function permanentlyDelete')[1].split('async function ')[0];
 const claim=s.indexOf("const claimed=await dbRun");
 const r2=s.indexOf("env.DOCUMENTS.delete");
 assert.ok(claim>=0&&r2>claim);
 for(const table of ['document_member_sync_intents','document_member_execution_reservations','document_task_execution_reservations','document_study_execution_reservations'])assert.ok(s.slice(claim,r2).includes('NOT EXISTS (SELECT 1 FROM '+table));
 assert.ok(s.slice(claim,r2).includes("lifecycle IN ('trashed','deletion_pending')"));
 assert.ok(s.slice(claim,r2).includes('claimed.meta?.changes!==1'));
 const approval=read('worker/document-member-approval.js');
 assert.match(approval,/WHERE EXISTS \(SELECT 1 FROM documents d JOIN action_candidates c ON c\.document_id=d\.id\s+WHERE d\.id=\? AND d\.owner_id=\? AND d\.lifecycle='active' AND d\.version=\?/);
});
test('old AI tasks cannot finish a replacement job or mark another provider failed',()=>{
 const jobs=read('worker/ai-jobs.js');
 assert.match(jobs,/attempts=\? AND source_sha=\? AND provider=\? AND started_at=\?/);
 assert.match(jobs,/j\.state='running' AND j\.attempts=\? AND j\.started_at=\?/);
 const ai=read('worker/intelligence.js');
 assert.match(ai,/claimWhere="document_id=\? AND provider=\? AND source_sha=\? AND model_id=\? AND prompt_version=\? AND updated_at=\? AND state='pending'"/);
 assert.match(ai,/if\(saved\.meta\?\.changes!==1\)return \{ai_status:'stale_document'\}/);
});
test('derived suggestion failures cannot erase a successful inference',()=>{
 const s=read('worker/intelligence.js');
 assert.match(s,/try\{await addStudyCandidates\(env,doc,result\);\}catch\{derived_pending=true;\}/);
 assert.match(s,/try\{added_fields=await addGroundedFieldSuggestions\(env,doc,result\);\}catch\{derived_pending=true;\}/);
 assert.match(s,/return persistDerivedSuggestions\(env,doc,result,'success'\)/);
});
