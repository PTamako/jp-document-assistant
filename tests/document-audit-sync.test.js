import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resetCandidateConfirmation} from '../web/src/candidate-draft.js';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');

test('opening a second document resets all user confirmations and assignee',()=>{
 const draft={title:'旧任务',visibility:'household',assignee:'other-member',
  bonus_points:80,privacy_confirmed:true,task_share_confirmed:true,
  redacted_term:'带个人信息的旧词',redacted_sentence:'旧句子'};
 resetCandidateConfirmation(draft,{title:'新任务',term:'確認',sentence:'確認します。'});
 assert.deepEqual(draft,{title:'新任务',visibility:'private',assignee:'',
  bonus_points:0,privacy_confirmed:false,task_share_confirmed:false,
  redacted_term:'確認',redacted_sentence:'確認します。'});
 resetCandidateConfirmation(draft,{title:'第三个任务'});
 assert.equal(draft.privacy_confirmed,false);
 assert.equal(draft.task_share_confirmed,false);
 assert.equal(draft.assignee,'');
 assert.equal(draft.redacted_term,'');
 assert.equal(draft.redacted_sentence,'');
});
test('the Vue candidate preview invokes reset before immutable retry restoration',()=>{
 const app=read('../web/src/App.vue');
 const resetAt=app.indexOf('resetCandidateConfirmation(candidateDraft,{');
 const retryAt=app.indexOf('Object.assign(candidateDraft,pendingCandidateRetry.value.body)');
 assert.ok(resetAt>0&&retryAt>resetAt);
 assert.match(app,/import \{resetCandidateConfirmation\} from '\.\/candidate-draft\.js'/);
 assert.doesNotMatch(app,/sharing requires explicit selection\.candidateDraft/);
});
test('member SBI transfers are neither submitted for approval nor posted via legacy bridge',()=>{
 const bridge=read('../worker/bridge.js');
 const approval=read('../worker/document-member-approval.js');
 const wrangler=read('../wrangler.jsonc');
 assert.match(bridge,/const memberPersonalTransfer=p\.role==='member'&&target==='kakebo'&&entryType==='transfer'/);
 assert.match(bridge,/const approvalRequired=p\.role!=='owner'&&target==='kakebo'&&!memberPersonalTransfer/);
 assert.match(bridge,/commitPersonalSbiCandidate\(request,env,p,item,verified\)/);
 assert.match(bridge,/available:personalReady\|\|/);
 assert.doesNotMatch(bridge,/PERSONAL_TRANSFER_EXECUTOR_REQUIRED/);
 assert.match(approval,/PERSONAL_TRANSFER_NO_APPROVAL/);
 assert.match(wrangler,/KAKEIBO_DOCUMENT_ACCOUNT_SERVICE/);
 assert.match(wrangler,/DOCUMENT_ACCOUNT_VERIFY_ENABLED/);
});
