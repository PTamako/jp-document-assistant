import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
const start=source.indexOf('async function openDoc(');
const end=source.indexOf('async function runAiForCurrent()',start);
assert.ok(start>=0&&end>start,'document detail refresh implementation found');
const functions=source.slice(start,end);

function harness(fetcher=async path=>path.endsWith('/candidates')?{items:[{id:'candidate'}]}:{document:{id:path.split('/').at(-1),title:'updated'}}){
 const cell=value=>({value});
 const scroll={scrollTop:184};
 const problems=[];
 const state={
  current:cell({id:'doc-1',title:'before'}),detailTab:cell('original'),
  detailCandidates:cell([{id:'prior'}]),detailLoading:cell(false),
  amountVisible:cell(true),explanationExpanded:cell(true),ocrTextExpanded:cell(true),
  attachmentActionsTarget:cell({id:'attachment'}),
  swipeOpenId:cell(''), translationStopped:0,
  document:{querySelector:selector=>selector==='.detail-body'?scroll:null},
  invalidateStaleTranslation:()=>{},
  api:fetcher,nextTick:async()=>{},stopTranslation:()=>{state.translationStopped++;},
  revokeOriginal:()=>{},problem:error=>problems.push(error)
 };
 const context=vm.createContext(state);
 vm.runInContext('let detailOpenSerial=0;\n'+functions+'\nglobalThis.openDoc=openDoc;globalThis.closeDetail=closeDetail;',context);
 return {state,scroll,problems,openDoc:context.openDoc,closeDetail:context.closeDetail};
}
function deferred(){
 let resolve,reject;
 const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});
 return {promise,resolve,reject};
}

test('all five tabs stay selected after same-document refresh, including editing/review updates',async()=>{
 const h=harness();
 for(const tab of ['original','explain','finance','tasks','study']){
  h.state.current.value={id:'doc-1'};
  h.state.detailTab.value=tab;
  h.state.detailCandidates.value=[{id:'old'}];
  h.scroll.scrollTop=tab==='finance'?440:188;
  await h.openDoc('doc-1');
  assert.equal(h.state.detailTab.value,tab,tab);
  assert.equal(h.state.current.value.id,'doc-1');
  assert.equal(h.state.detailCandidates.value[0].id,'candidate');
  assert.equal(h.scroll.scrollTop,tab==='finance'?440:188);
  assert.equal(h.state.translationStopped,0);
 }
});
test('opening a different document starts at original and resets document-only state',async()=>{
 const h=harness();
 h.state.detailTab.value='finance';
 await h.openDoc('doc-2');
 assert.equal(h.state.current.value.id,'doc-2');
 assert.equal(h.state.detailTab.value,'original');
 assert.equal(h.state.translationStopped,1);
 assert.equal(h.state.amountVisible.value,false);
 assert.equal(h.state.ocrTextExpanded.value,false);
 assert.equal(h.state.explanationExpanded.value,false);
});
test('tab selected while same-document API is in flight is never overwritten',async()=>{
 const response=deferred();
 const h=harness(async path=>path.endsWith('/candidates')?{items:[]}:response.promise);
 h.state.detailTab.value='finance';
 h.scroll.scrollTop=300;
 const request=h.openDoc('doc-1');
 h.state.detailTab.value='study';
 h.scroll.scrollTop=42;
 response.resolve({document:{id:'doc-1',title:'refreshed'}});
 await request;
 assert.equal(h.state.detailTab.value,'study');
 assert.equal(h.scroll.scrollTop,42);
});
test('out-of-order requests cannot replace a newer document detail',async()=>{
 const older=deferred();
 const h=harness(async path=>{
  if(path==='/api/documents/doc-1')return older.promise;
  return path.endsWith('/candidates')?{items:[]}:{document:{id:'doc-2'}};
 });
 const pOld=h.openDoc('doc-1');
 const pNew=h.openDoc('doc-2');
 await pNew;
 older.resolve({document:{id:'doc-1'}});
 await pOld;
 assert.equal(h.state.current.value.id,'doc-2');
 assert.equal(h.state.detailTab.value,'original');
});
test('closing detail invalidates in-flight refresh and cannot reopen it',async()=>{
 const pending=deferred();
 const h=harness(async path=>path.endsWith('/candidates')?{items:[]}:pending.promise);
 h.state.detailTab.value='explain';
 const inFlight=h.openDoc('doc-1');
 h.closeDetail();
 pending.resolve({document:{id:'doc-1'}});
 await inFlight;
 assert.equal(h.state.current.value,null);
 assert.equal(h.state.detailTab.value,'original');
 assert.equal(h.state.detailLoading.value,false);
});
test('all save and linked-action refreshes route through the same-document preserving function',()=>{
 const callsites=[...source.matchAll(/openDoc\(([^\n;]*)\)/g)].map(m=>m[0]);
 assert.ok(callsites.length>=15);
 assert.doesNotMatch(source,/openDoc\([^\n]+preserveTab:false/);
 assert.match(source,/async function saveDocAiProvider\(\)[\s\S]*?await openDoc\(id\)/);
 assert.match(source,/async function saveField\(\)[\s\S]*?await openDoc\(id\)/);
 assert.match(source,/async function saveSourceText\(\)[\s\S]*?await openDoc\(id\)/);
 assert.match(source,/async function toggleDocument\(key,value\)[\s\S]*?await openDoc\(id\)/);
 assert.match(source,/async function changeShare\(\)[\s\S]*?await openDoc\(current\.value\.id\)/);
 assert.match(source,/function clearPrivateWorkspace\(\)\{\s*detailOpenSerial\+\+/);
});
