import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyText,parseJapaneseText} from '../worker/analysis.js';
import {validatedPayload} from '../worker/bridge.js';

const billText=[
  '電気料金のお知らせ',
  '今回のご請求金額合計 1,987円（税込）',
  'ご利用請求書は添付のPDFにてご確認ください',
  'カード立替日 2026/11/25'
].join('\n');

test('utility invoice stays a utility when it also says card or billing',()=>{
  assert.equal(classifyText(billText),'utility');
  const parsed=parseJapaneseText(billText);
  assert.equal(parsed.category,'utility');
  assert.equal(parsed.fields.find(x=>x.field_key==='amount_jpy')?.normalized_value,'1987');
  assert.equal(parsed.fields.find(x=>x.field_key==='card_advance_date')?.normalized_value,'2026-11-25');
});

test('reviewed utility invoice can create a recurring bill draft without asserting payment',()=>{
  const item={payload_json:JSON.stringify({kind:'expense',amount_jpy:1987,merchant:'電気料金'})};
  const approved=new Map([['amount_jpy','1987']]);
  const planId='11111111-1111-4111-8111-111111111111';
  const output=validatedPayload('kakebo',item,approved,{
    date:'2026-11-19',variable_bill_plan_id:planId,
    variable_bill_period:'2026-11',payment_confirmed:false
  });
  assert.equal(output.operation,'variable_bill_draft');
  assert.equal(output.amount,1987);
  assert.equal(output.billDate,null);
  assert.equal(output.expenseDate,'2026-11-19');
  assert.equal(output.serviceStart,null);
  assert.equal(output.planId,planId);
  assert.equal(output.merchant,'電気料金');
});

test('direct expense still requires actual payment confirmation',()=>{
  const item={payload_json:JSON.stringify({kind:'expense',amount_jpy:1987,merchant:'電気料金'})};
  const approved=new Map([['amount_jpy','1987']]);
  assert.throws(()=>validatedPayload('kakebo',item,approved,{
    date:'2026-11-19',category:'水道光熱費',payment_source:'Olive',payment_confirmed:false
  }),/确认真实付款/);
});

test('unreviewed or mismatched amount cannot be sent as a utility draft',()=>{
  const item={payload_json:JSON.stringify({kind:'expense',amount_jpy:1987,merchant:'電気料金'})};
  assert.throws(()=>validatedPayload('kakebo',item,new Map(),{
    date:'2026-11-19',variable_bill_plan_id:'11111111-1111-4111-8111-111111111111',
    variable_bill_period:'2026-11'
  }),/必须先核对金额/);
});

test('Octopus bracketed multiline meter period is extracted separately from card advance',()=>{
 const source=[
  '電気料金のお知らせ',
  '[電気料金の検針期間]',
  ' 2026/10/16 ~ 2026/11/15 : 2,176円 (税込) 62.00kWh',
  '今回のご請求金額合計 1,987円（税込）',
  'カード立替日: 2026/11/27'
 ].join('\n');
 const parsed=parseJapaneseText(source);
 const find=k=>parsed.fields.find(x=>x.field_key===k)?.normalized_value;
 assert.equal(find('amount_jpy'),'1987');
 assert.equal(find('meter_period_start'),'2026-10-16');
 assert.equal(find('meter_period_end'),'2026-11-15');
 assert.equal(find('card_advance_date'),'2026-11-27');
});
