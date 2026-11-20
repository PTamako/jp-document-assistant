import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
const css=readFileSync(new URL('../web/src/style.css',import.meta.url),'utf8');

test('all date and month clear buttons sit inside a single full-width field',()=>{
  assert.match(css,/\.date-control\{\s*position:relative;display:block/);
  assert.match(css,/\.date-control \.date-clear\{\s*position:absolute;top:50%;right:4px/);
  assert.match(css,/padding:11px 56px 11px 13px/);
  assert.match(css,/width:44px;height:44px;min-width:44px;min-height:44px/);
  assert.doesNotMatch(css,/\.date-control\{\s*display:grid;grid-template-columns/);
  assert.match(source,/aria-label="清空交易日期"/);
  assert.match(source,/清空 Suica 实际到账日/);
  assert.match(source,/aria-label="清空账单月份"/);
});
test('cross-app confirmation scroll body and footer are separate, so memo remains editable',()=>{
  assert.match(source,/'candidate-sheet':sheet==='candidate'/);
  assert.match(source,/class="candidate-form-body"/);
  assert.match(source,/class="sheet-actions candidate-actions"/);
  assert.match(css,/\.bottom-sheet\.candidate-sheet\{\s*display:flex;flex-direction:column/);
  assert.match(css,/\.candidate-form-body\{[\s\S]*?overflow-y:auto/);
  assert.match(css,/\.candidate-sheet \.candidate-actions\{\s*flex:none;position:static/);
  assert.match(source,/v-model="candidateDraft.note"/);
});
test('Suica destination uses the same choice sheet as other financial fields',()=>{
  assert.match(source,/ledgerPrepaidTarget:\{title:'转入预付费账户'/);
  assert.match(source,/case 'ledgerPrepaidTarget':return candidateDraft.transfer_target/);
  assert.match(source,/case 'ledgerPrepaidTarget':candidateDraft.transfer_target=value/);
  assert.match(source,/openChoice\('ledgerPrepaidTarget'\)/);
  assert.doesNotMatch(source,/<select v-model="candidateDraft.transfer_target"/);
});
