import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const app=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
const css=readFileSync(new URL('../web/src/style.css',import.meta.url),'utf8');
const candidate=app.slice(app.indexOf('<template v-else-if="sheet===\'candidate\'">'),
  app.indexOf('<template v-else-if="sheet===\'candidate\'">')+12000);

test('variable-bill month uses the same bounded picker layout as the day input',()=>{
  assert.match(candidate,/<label for="candidate-bill-period">账单所属月份/);
  assert.match(candidate,/<div class="date-control">\s*<input id="candidate-bill-period" type="month" v-model="candidateDraft\.variable_bill_period"/);
  assert.match(candidate,/aria-label="清空账单月份"/);
  assert.match(candidate,/@click="candidateDraft\.variable_bill_period=''"/);
  assert.doesNotMatch(candidate,/<label v-if="candidateDraft\.variable_bill_plan_id" class="form-label">/);
});

test('date and month controls stay within the iPhone sheet and preserve a separate clear hit target',()=>{
  assert.match(css,/\.bottom-sheet\{[^}]*overflow-x:hidden;overflow-y:auto/);
  assert.match(css,/\.date-control\{\s*position:relative;display:block/);
  assert.match(css,/\.date-control \.date-clear\{\s*position:absolute;top:50%;right:4px/);
  assert.match(css,/padding:11px 56px 11px 13px/);
  assert.match(css,/\.bottom-sheet\.candidate-sheet\{[\s\S]*?overflow:hidden/);
  assert.match(css,/\.candidate-form-body\{[\s\S]*?overflow-y:auto/);
  assert.match(css,/\.date-control>input\[type="date"\],\.date-control>input\[type="month"\]/);
  assert.match(css,/display:block;width:100%;min-width:0;max-width:100%/);
  assert.match(css,/\.date-control \.date-clear\{[\s\S]*?width:44px;height:44px;min-width:44px;min-height:44px/);
});

test('utility bill month is sourced from metering rather than card advance month',()=>{
  assert.match(candidate,/@change="chooseVariableBillPlan"/);
  assert.match(app,/const start=sourceValue\('meter_period_start'\)/);
  assert.match(app,/candidateDraft\.variable_bill_period=/);
  assert.match(candidate,/它不是账单发行日/);
});
