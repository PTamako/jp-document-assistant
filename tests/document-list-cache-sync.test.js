import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { invalidateDocumentLists } from '../web/src/document-list-cache.js';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');

const seed=()=>({
 today:{items:[{id:'keep',title:'keep'},{id:'removed',title:'removed'}],next:5,loaded:true},
 docs:{items:[{id:'removed',title:'removed'},{id:'keep',title:'keep'}],next:5,loaded:true},
 links:{items:[{id:'candidate1',document_id:'removed'},{id:'candidate2',document_id:'keep'}],next:5,loaded:true}
});

test('deleting one document immediately removes all cached references (including integration candidate IDs)',()=>{
 const pages=seed();
 invalidateDocumentLists(pages,'removed');
 for(const tab of ['today','docs','links']){
  assert.equal(pages[tab].items.length,1,tab);
  assert.equal(pages[tab].loaded,false,tab);
  assert.equal(pages[tab].next,null,tab);
 }
 assert.deepEqual(pages.links.items.map(x=>x.id),['candidate2']);
 assert.deepEqual(pages.today.items.map(x=>x.id),['keep']);
});
test('restoring a document invalidates all tabs without discarding unrelated cached items',()=>{
 const pages=seed();
 invalidateDocumentLists(pages);
 for(const tab of ['today','docs','links']){
  assert.equal(pages[tab].loaded,false,tab);
  assert.equal(pages[tab].next,null,tab);
  assert.equal(pages[tab].items.length,2,tab);
 }
});
test('front-end document delete and restore both invalidate other tabs with no polling',()=>{
 const app=read('web/src/App.vue');
 const removeList=app.slice(app.indexOf('async function trashFromList'),app.indexOf('async function trashCurrent'));
 const removeDetail=app.slice(app.indexOf('async function trashCurrent'),app.indexOf('async function showRecycle'));
 const restore=app.slice(app.indexOf('async function restore(id)'),app.indexOf('const pendingDelete'));
 assert.match(removeList,/refreshDocumentViews\(target\.id\)/);
 assert.match(removeDetail,/refreshDocumentViews\(deletedId\)/);
 assert.match(restore,/refreshDocumentViews\(\)/);
 assert.match(app,/if\(pages\[tab\]&&!pages\[tab\]\.loaded\)await loadTab\(tab\)/);
 assert.doesNotMatch(removeList,/setInterval|setTimeout/);
});
test('backend only returns active documents to Today and Integrations',()=>{
 const src=read('worker/index.js');
 const today=src.slice(src.indexOf("if(method==='GET'&&path==='/api/today')"),src.indexOf("if(method==='GET'&&path==='/api/integrations')"));
 const integration=src.slice(src.indexOf("if(method==='GET'&&path==='/api/integrations')"),src.indexOf("if(method==='GET'&&path==='/api/recycle')"));
 assert.match(today,/d\.lifecycle='active'/);
 assert.match(integration,/d\.lifecycle='active'/);
});
