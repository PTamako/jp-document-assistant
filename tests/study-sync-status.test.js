import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { studySyncState } from '../web/src/study-sync-status.js';

for(const s of ['synced','linked_existing']){
  test('study link '+s+' displays as confirmed',()=>{
    assert.equal(studySyncState({integration_state:s}),'linked');
  });
}
test('study status keeps errors and in-flight operations distinct',()=>{
  assert.equal(studySyncState({integration_state:'failed'}),'failed');
  assert.equal(studySyncState({integration_state:'sending'}),'sending');
  assert.equal(studySyncState({integration_state:'pending'}),'pending');
  assert.equal(studySyncState({state:'synced'}),'pending');
  assert.equal(studySyncState(null),'pending');
});
test('both vocabulary and sentence cards use the server link status',()=>{
  const vue=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
  assert.equal((vue.match(/studySyncState\(item\)==='linked'/g)||[]).length,2);
  assert.equal((vue.match(/class="study-sync-tag"/g)||[]).length,2);
  assert.equal((vue.match(/v-if="!\['linked','sending'\]\.includes\(studySyncState\(item\)\)"/g)||[]).length,2);
  assert.match(vue,/openDoc\(docId,\{preserveTab:true,preserveScroll:true\}\)/);
});
