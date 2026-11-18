import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isUnsupportedBalanceMovement} from '../shared/balance-movement.js';
import {validatedPayload} from '../worker/bridge.js';

test('stored-value and points transfers cannot masquerade as household expenses',()=>{
 for(const text of ['Suica チャージ 1,000円','PayPay残高チャージ','nanaco ポイント交換',
  'WAONチャージ完了','楽天Edy チャージ','电子钱包充值','积分兑换储值卡']){
  assert.equal(isUnsupportedBalanceMovement(text),true,text);
 }
 for(const text of ['PayPay支払い スーパー','Suicaで乗車','楽天Edy決済','給与振込']){
  assert.equal(isUnsupportedBalanceMovement(text),false,text);
 }
});

test('asset movements fail closed BEFORE any Kakeibo bridge or HomeFlow approval submission',()=>{
 const body={payment_confirmed:true,date:'2026-11-18',category:'交通費',
  payment_source:'現金',note:''};
 const fields=new Map([['amount_jpy','1000']]);
 for(const merchant of ['Suica チャージ 1,000円','nanaco ポイント交換','PayPay 残高チャージ']){
  const item={candidate_kind:'finance',payload_json:JSON.stringify({
   kind:'expense',merchant,amount_jpy:1000})};
  assert.throws(()=>validatedPayload('kakebo',item,fields,body),
   e=>e?.code==='ASSET_MOVEMENT_REQUIRES_TRANSFER'&&e?.status===409,merchant);
 }
 const legitimate={candidate_kind:'finance',payload_json:JSON.stringify({
  kind:'expense',merchant:'スーパー',amount_jpy:1000})};
 assert.equal(validatedPayload('kakebo',legitimate,fields,body).type,'expense');
 const bridge=readFileSync(new URL('../worker/bridge.js',import.meta.url),'utf8');
 assert.match(bridge,/approval_action_enabled:!unsupportedMovement&&approvalActionEnabled/);
 assert.match(bridge,/available:!unsupportedMovement&&/);
});

test('HomeFlow account change clears private raw import, Google and sensitive auth drafts',()=>{
 const app=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
 const start=app.indexOf('function clearPrivateWorkspace(){');
 const end=app.indexOf('async function googleStatus(',start);
 assert.ok(start>0&&end>start);
 const clear=app.slice(start,end);
 for(const expected of [
  "textDraft.text=''",'fileDraft.value=null',"fileText.value=''",
  "localImportNote.value=''", "salaryAmountDraft.value=''",
  "editTextDraft.value=''", "passwordDraft.current_password=''",
  "passwordDraft.new_password=''", "auth.password=''",
  "auth.email=''",'clearGmailSession()','accountEpoch.invalidate()',
  'financeStableAccounts.value=[]',"driveQuery.value=''",
  'accountController.abort()']){
  assert.ok(clear.includes(expected),'missing account isolation reset: '+expected);
 }
});
