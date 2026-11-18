import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validatedPayload} from '../worker/bridge.js';
import {resetCandidateConfirmation} from '../web/src/candidate-draft.js';

const item={
  payload_json:JSON.stringify({title:'配送通知',task_type:'deadline',due_on:'2026-12-20'}),
  visibility:'private',candidate_kind:'homeflow_task'
};
const reviewed=new Map([['due_date','2026-12-20']]);
const confirm={
  visibility:'household',task_share_confirmed:true,
  assignee:'other_family_member',title:'配送通知',
  bonus_points:0,reminder_only:true
};

test('reviewed document reminder-only sync is zero-point and may name spouse',()=>{
  const payload=validatedPayload('homeflow',item,reviewed,confirm);
  assert.deepEqual(payload,{
    operation:'task',title:'配送通知',dueOn:'2026-12-20',
    visibility:'household',assignee:'other_family_member',
    bonusPoints:0,remindEnabled:true,reminderOnly:true
  });
  assert.equal(validatedPayload('homeflow',item,reviewed,{
    ...confirm,reminder_only:false,bonus_points:5
  }).reminderOnly,false);
});

test('document reminder-only rejects points, silent mode, and malformed types',()=>{
  assert.throws(()=>validatedPayload('homeflow',item,reviewed,{
    ...confirm,bonus_points:5
  }));
  assert.throws(()=>validatedPayload('homeflow',item,reviewed,{
    ...confirm,remindEnabled:false
  }));
  assert.throws(()=>validatedPayload('homeflow',item,reviewed,{
    ...confirm,reminder_only:'yes'
  }));
  assert.throws(()=>validatedPayload('homeflow',item,reviewed,{
    ...confirm,task_share_confirmed:false
  }));
});

test('reminder setting is visible, disables funded bonus UI and resets on next candidate',()=>{
  const app=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
  assert.match(app,/v-model="candidateDraft\.reminder_only"/);
  assert.match(app,/!candidateDraft\.reminder_only&&candidateDraft\.visibility/);
  assert.match(app,/@change="candidateDraft\.bonus_points=0"/);
  const draft={reminder_only:true,bonus_points:3,assignee:'other'};
  resetCandidateConfirmation(draft,{title:'Next'});
  assert.equal(draft.reminder_only,false);
  assert.equal(draft.bonus_points,0);
  assert.equal(draft.assignee,'');
});
