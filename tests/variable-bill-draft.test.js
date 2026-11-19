import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {validatedPayload} from '../worker/bridge.js'
const item={
 payload_json:JSON.stringify({kind:'expense',amount_jpy:5500,merchant:'東京ガス'})
}
const checked=new Map([['amount_jpy','5500'],['merchant','東京ガス']])
const planId='11111111-1111-4111-8111-111111111111'
test('verified document bill creates draft payload, never direct entry',()=>{
 const data=validatedPayload('kakebo',item,checked,{
  payment_confirmed:true,date:'2026-11-18',
  variable_bill_plan_id:planId,variable_bill_period:'2026-10'})
 assert.deepEqual(data,{
  operation:'variable_bill_draft',planId,periodMonth:'2026-10',
  amount:5500,billDate:null,expenseDate:'2026-11-18',serviceStart:null,serviceEnd:null,merchant:'東京ガス',source_kind:'document_assistant'
 })
 assert.equal(data.paymentSource,undefined)
})
test('without an explicit plan the existing direct entry remains unchanged',()=>{
 const x=validatedPayload('kakebo',item,checked,{
  payment_confirmed:true,date:'2026-11-18',
  category:'光熱費',payment_source:'AEON Card'})
 assert.equal(x.operation,'entry')
 assert.equal(x.amount,5500)
})
test('requires verified amount and explicit month before import',()=>{
 assert.throws(()=>validatedPayload('kakebo',item,new Map([['amount_jpy','5300']]),{
  payment_confirmed:true,date:'2026-11-18',variable_bill_plan_id:planId,
  variable_bill_period:'2026-11'}),/金额/)
 assert.throws(()=>validatedPayload('kakebo',item,checked,{
  payment_confirmed:true,date:'2026-11-18',
  variable_bill_plan_id:planId,variable_bill_period:'2026-00'}),/月份/)
})
test('candidate user interface distinctly displays a draft mode without direct posting',()=>{
 const ui=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8')
 assert.match(ui,/variable_bill_plan_id/)
 assert.match(ui,/仅同步到账单草稿/)
 assert.match(ui,/不会直接记账、扣款/)
})

test('verified metering dates travel to the recurring draft without claiming invoice issue',()=>{
 const dates=new Map([...checked,['meter_period_start','2026-10-16'],
  ['meter_period_end','2026-11-15'],['card_advance_date','2026-11-27']]);
 const payload=validatedPayload('kakebo',item,dates,{
  date:'2026-11-27',variable_bill_plan_id:planId,variable_bill_period:'2026-10'
 });
 assert.equal(payload.expenseDate,'2026-11-27');
 assert.equal(payload.billDate,null);
 assert.equal(payload.serviceStart,'2026-10-16');
 assert.equal(payload.serviceEnd,'2026-11-15');
});
