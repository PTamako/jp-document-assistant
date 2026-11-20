import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validatedPayload} from '../worker/bridge.js';

const financeItem={payload_json:JSON.stringify({
  kind:'expense',amount_jpy:1300,merchant:'テスト店舗',transaction_date:'2026-11-20'
})};
const reviewed=new Map([['amount_jpy','1300'],['merchant','テスト店舗']]);
const confirmed={category:'食費',payment_source:'現金',payment_confirmed:true};

test('finance handoff rejects invalid calendar dates, not only bad strings',()=>{
  for(const date of ['2026-02-29','2026-04-31','2026-13-01','2026-00-01','2026-11-31','2026-1-1']){
    assert.throws(()=>validatedPayload('kakebo',financeItem,reviewed,{...confirmed,date}),
      {code:'CONFIRM_REQUIRED'},date);
  }
});
test('finance handoff accepts actual leap days and regular dates',()=>{
  assert.equal(validatedPayload('kakebo',financeItem,reviewed,{...confirmed,date:'2024-02-29'}).date,'2024-02-29');
  assert.equal(validatedPayload('kakebo',financeItem,reviewed,{...confirmed,date:'2026-11-20'}).date,'2026-11-20');
});
test('recurring invoice draft also rejects impossible proposed ledger dates',()=>{
  assert.throws(()=>validatedPayload('kakebo',financeItem,reviewed,{
    variable_bill_plan_id:'12345678-1234-1234-1234-123456789abc',
    variable_bill_period:'2026-11',
    date:'2026-02-30'
  }),{code:'CONFIRM_REQUIRED'});
});
test('HomeFlow handoff rejects impossible reviewed task dates',()=>{
  const item={payload_json:JSON.stringify({task_type:'deadline',due_on:'2026-02-31',title:'テスト'})};
  assert.throws(()=>validatedPayload('homeflow',item,new Map([['due_date','2026-02-31']]),{
    visibility:'private'
  }),{code:'REVIEW_REQUIRED'});
});
test('production diagnostic configuration masks request query strings and forbids invocation logs',()=>{
  const cfg=readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8');
  assert.match(cfg,/"redact_query_string"\s*:\s*true/);
  assert.match(cfg,/"invocation_logs"\s*:\s*false/);
  assert.match(cfg,/"head_sampling_rate"\s*:\s*0\.01/);
  assert.match(cfg,/"preview_urls"\s*:\s*false/);
});
