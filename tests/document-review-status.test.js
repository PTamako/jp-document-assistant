import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const backend=read('worker/index.js'),ui=read('web/src/App.vue');
test('server list and Today derive review status from actual field review_state',()=>{
 const list=backend.slice(backend.indexOf('async function handleList('),backend.indexOf('async function updateDoc('));
 const today=backend.slice(backend.indexOf("if(method==='GET'&&path==='/api/today')"),backend.indexOf("if(method==='GET'&&path==='/api/integrations')"));
 for(const query of [list,today]){
  assert.match(query,/NOT EXISTS\(SELECT 1 FROM document_fields f WHERE f\.document_id=d\.id AND f\.review_state='unreviewed'\) THEN 'reviewed'/);
  assert.match(query,/EXISTS\(SELECT 1 FROM document_fields f WHERE f\.document_id=d\.id AND f\.review_state!='unreviewed'\) THEN 'partial'/);
  assert.match(query,/NOT EXISTS\(SELECT 1 FROM document_fields f WHERE f\.document_id=d\.id\) THEN 'none'/);
 }
 assert.match(backend,/review_status:d\.review_status/);
});
test('UI reflects verified, partially verified and unreviewed states',()=>{
 assert.match(ui,/function documentReviewLabel\(d\)/);
 assert.match(ui,/if\(state==='reviewed'\)return '已核验'/);
 assert.match(ui,/if\(state==='partial'\)return '部分核验'/);
 assert.match(ui,/\{\{documentReviewLabel\(d\)\}\}/);
 assert.match(ui,/\{\{documentReviewLabel\(current\)\}\}/);
});
test('saving a reviewed field invalidates Today and Documents list caches',()=>{
 const section=ui.slice(ui.indexOf('async function saveField()'),ui.indexOf('function askTrash()'));
 assert.match(section,/refreshDocumentViews\(\)/);
 assert.match(section,/if\(pages\[activeTab\.value\]\)await loadTab\(activeTab\.value\)/);
});
