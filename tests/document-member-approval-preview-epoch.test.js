import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createAccountEpoch} from '../web/src/account-epoch.js';

const vue=fs.readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
const from=vue.indexOf('async function prepareCandidate(item){');
const to=vue.indexOf('async function checkCandidateApprovalStatus(){',from);
assert.ok(from>=0&&to>from,'real preview handler must be located');
const source=vue.slice(from,to);
const a={id:'a'.repeat(32),candidate_kind:'finance',
 payload:{kind:'expense',merchant:'旧商家',note:'old',transaction_date:'2026-11-14'}};
const b={id:'b'.repeat(32),candidate_kind:'vocabulary',
 payload:{term:'新单词',reading:'',meaning_zh:'new'}};
const sample=id=>({approval_required:true,approval_action_enabled:true,
 approval_submitted:false,approval_prepared:false,approval_id:'',
 approval_status:'not_submitted',confirmation_phrase:'CONFIRM_STUDY',
 entry_type:'expense',confirmed_fields:{},ledger_options:{categories:[],paymentSources:[]},
 ledger_options_error:'',homeflow_members_error:'',homeflow_members:[],available:false});
function queue(){
 const pending=[];
 const gate=createAccountEpoch();
 const ref=value=>({value});
 const state={
  accountEpoch:gate,
  detailCandidates:ref([a,b]),current:ref({id:'docA',category:'manual',title:'Document A',visibility:'private'}),
  sheet:ref(''),busy:ref(false),
  candidateApprovalRequired:ref(false),candidateApprovalReady:ref(false),
  candidateApprovalSubmitted:ref(false),candidateApprovalPrepared:ref(false),
  candidateApprovalId:ref(''),candidateApprovalStatus:ref('not_submitted'),
  candidateApprovalChecked:ref(false),
  candidateDraft:{},ledgerOptions:ref({}),ledgerOptionsError:ref(''),
  homeflowMembersError:ref(''),homeflowMemberChoices:ref([]),
  ledgerAttempted:ref(false),ledgerMappingChangeConfirmed:ref(false),
  candidateMerchant:ref(''),pendingCandidateRetry:ref(null),
  integrationConfigured:ref(false),
  problems:[],
  problem(e){state.problems.push(String(e?.message||e))},
  api(path){return new Promise((resolve,reject)=>{pending.push({path,resolve,reject})})},
 }
 const ctx=vm.createContext(state);
 vm.runInContext('let detailOpenSerial=0;let candidatePreviewSerial=0;\n'+
   source+'\nthis.prepare=prepareCandidate;this.openNewDocument=()=>{detailOpenSerial++}',ctx);
 return {ctx,state,pending,gate};
}
test('the old candidate preview cannot override a newer candidate review sheet',async()=>{
 const x=queue();
 const previous=x.ctx.prepare(a),current=x.ctx.prepare(b);
 assert.equal(x.pending.length,2);
 x.pending[1].resolve(sample(b.id));
 await current;
 assert.equal(x.state.candidateDraft.id,b.id);
 assert.equal(x.state.sheet.value,'candidate');
 x.pending[0].resolve(sample(a.id));
 await previous;
 assert.equal(x.state.candidateDraft.id,b.id);
 assert.equal(x.state.sheet.value,'candidate');
 assert.deepEqual(x.state.problems,[]);
});
test('a delayed document approval preview cannot reopen a previous document or detached sheet',async()=>{
 const x=queue();
 const old=x.ctx.prepare(a);
 x.ctx.openNewDocument();
 x.state.current.value={id:'docB',category:'manual',title:'Other',visibility:'private'};
 x.state.detailCandidates.value=[b];
 x.pending[0].resolve(sample(a.id));
 await old;
 assert.equal(x.state.sheet.value,'');
 assert.equal(x.state.candidateDraft.id,undefined);
 assert.deepEqual(x.state.problems,[]);
});
test('logout invalidates a pending approval preview and suppresses previous-account failures',async()=>{
 const x=queue();
 const old=x.ctx.prepare(a);
 x.gate.invalidate();
 x.state.current.value=null;
 x.state.detailCandidates.value=[];
 x.pending[0].reject(Error('private preview failed on previous account'));
 await old;
 assert.equal(x.state.sheet.value,'');
 assert.deepEqual(x.state.problems,[]);
});
test('stale approval preview is guarded after network read before mutating private form state',()=>{
 assert.match(source,/const account=accountEpoch.snapshot\(\),documentId=current.value.id/);
 assert.match(source,/detailSerial=detailOpenSerial,previewSerial=\+\+candidatePreviewSerial/);
 assert.match(source,/accountEpoch.isCurrent\(account\)/);
 assert.match(source,/detailOpenSerial===detailSerial&&candidatePreviewSerial===previewSerial/);
 assert.match(source,/current.value\?\.id===documentId&&sheet.value===initialSheet/);
 assert.match(source,/if\(!stillCurrent\(\)\)return/);
 assert.match(source,/catch\(e\)\{if\(stillCurrent\(\)\)problem\(e\)/);
 assert.match(vue,/function clearPrivateWorkspace\(\)\{\s*detailOpenSerial\+\+;\s*candidatePreviewSerial\+\+;/);
});
