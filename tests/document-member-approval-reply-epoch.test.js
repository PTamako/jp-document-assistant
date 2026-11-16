import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createAccountEpoch} from '../web/src/account-epoch.js';

const src=fs.readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
const extract=(first,last)=>{
 const a=src.indexOf(first),b=src.indexOf(last,a+first.length);
 assert.ok(a>=0&&b>a,'real approval method missing: '+first);
 return src.slice(a,b);
};
const statusCode=extract('async function checkCandidateApprovalStatus(){',
 'async function verifyLedgerStatus(item){');
const commitCode=extract('async function commitApprovedCandidate(){',
 'async function restore(id){');
const candidate='a'.repeat(32);
const ref=value=>({value});
function setup(){
 const gate=createAccountEpoch(),requests=[],flashes=[],errors=[];
 const state={
  accountEpoch:gate, busy:ref(false),
  current:ref({id:'doc-A',category:'manual',title:'A',visibility:'private'}),
  sheet:ref('candidate'),candidateDraft:{
   id:candidate,kind:'vocabulary',confirm:'CONFIRM_STUDY',
   redacted_term:'',redacted_sentence:''
  },
  candidateApprovalRequired:ref(true),candidateApprovalReady:ref(true),
  candidateApprovalSubmitted:ref(true),candidateApprovalPrepared:ref(false),
  candidateApprovalChecked:ref(false),candidateApprovalStatus:ref('pending'),
  candidateApprovalId:ref(''),
  pendingCandidateRetry:ref(null),
  ledgerAttempted:ref(false),ledgerMappingChangeConfirmed:ref(false),
  ledgerOptions:ref({categories:[],paymentSources:[]}),
  flash(text){flashes.push(text)},problem(e){errors.push(String(e?.message||e))},
  refreshDocumentViews(){requests.push({kind:'refresh-views'})},
  openDoc:async id=>{requests.push({kind:'refresh-doc',id})},
  api:(path,options)=>new Promise((resolve,reject)=>{
   requests.push({kind:'api',path,options,resolve,reject});
  })
 };
 const context=vm.createContext(state);
 vm.runInContext('let detailOpenSerial=3;\n'+statusCode+'\n'+commitCode+
  '\nthis.checkStatus=checkCandidateApprovalStatus;'+
  'this.submit=commitApprovedCandidate;'+
  'this.changeDocument=(id)=>{detailOpenSerial++;current.value={id};};',context);
 return {state,context,requests,gate,flashes,errors};
}
test('closed approval sheet: delayed status is ignored and button lock is released',async()=>{
 const {state,context,requests,errors}=setup();
 const task=context.checkStatus();
 assert.equal(state.busy.value,true);
 assert.equal(requests.length,1);
 state.sheet.value='';
 requests[0].resolve({approval_status:'approved',approval_submitted:true,
  approval_checked:true,applied:false,target_changed:false});
 await task;
 assert.equal(state.candidateApprovalStatus.value,'pending');
 assert.equal(state.candidateApprovalChecked.value,false);
 assert.equal(state.busy.value,false,'same-account cancelled request must unlock UI');
 assert.deepEqual(errors,[]);
});
test('document switch during approval submission cannot reopen old document or mark it as submitted',async()=>{
 const {state,context,requests,flashes,errors}=setup();
 const task=context.submit();
 assert.equal(requests.length,1);
 assert.equal(requests[0].path,'/api/candidates/'+candidate+'/request-approval');
 context.changeDocument('doc-B');
 state.sheet.value='candidate';
 requests[0].resolve({approval_submitted:true,approval_status:'approved',
  approval_id:'33333333-3333-4333-8333-333333333333',
  applied:false,target_changed:false});
 await task;
 assert.equal(state.candidateApprovalStatus.value,'pending');
 assert.equal(state.candidateApprovalId.value,'');
 assert.equal(state.busy.value,false);
 assert.equal(requests.length,1,'must not refresh the previous document after switching');
 assert.deepEqual(flashes,[]);assert.deepEqual(errors,[]);
});
test('logout during approval submission cannot leak response or clear a new account lock',async()=>{
 const {state,context,requests,gate,flashes,errors}=setup();
 const task=context.submit();
 assert.equal(requests.length,1);
 gate.invalidate();state.current.value={id:'new-user-doc'};state.busy.value=false;
 requests[0].reject(Error('late former-user approval failure'));
 await task;
 assert.equal(state.candidateApprovalStatus.value,'pending');
 assert.equal(state.busy.value,false);
 assert.deepEqual(flashes,[]);assert.deepEqual(errors,[]);
});
test('current member approved request still reports only HomeFlow pending and refreshes current document',async()=>{
 const {state,context,requests,flashes}=setup();
 const task=context.submit();
 requests[0].resolve({
  approval_submitted:true,approval_status:'pending',
  approval_id:'33333333-3333-4333-8333-333333333333',
  applied:false,target_changed:false
 });
 await task;
 assert.equal(state.candidateApprovalSubmitted.value,true);
 assert.equal(state.candidateApprovalStatus.value,'pending');
 assert.equal(state.sheet.value,'');
 assert.equal(state.busy.value,false);
 assert.equal(requests.filter(x=>x.kind==='refresh-doc').length,1);
 assert.match(flashes[0],/待审批，尚未同步到目标应用/);
});
test('same user switching or closing the sheet is checked before approval state mutation',()=>{
 assert.match(commitCode,/detailSerial=detailOpenSerial/);
 assert.match(commitCode,/detailOpenSerial===detailSerial&&current.value\?\.id===docId/);
 assert.match(commitCode,/candidateDraft.id===id&&sheet.value==='candidate'/);
 assert.match(commitCode,/if\(!stillCurrent\(\)\)\{release\(\);return;\}/);
 assert.match(commitCode,/const refresh=openDoc\(docId\),refreshSerial=detailOpenSerial/);
 assert.match(statusCode,/if\(accountEpoch.isCurrent\(account\)\)busy.value=false/);
});
