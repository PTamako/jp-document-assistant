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
 const data=validatedPayload('kakeibo',item,checked,{
  payment_confirmed:true,date:'2026-11-18',
  variable_bill_plan_id:planId,variable_bill_period:'2026-10'})
 assert.deepEqual(data,{
  operation:'variable_bill_draft',planId,periodMonth:'2026-10',
  amount:5500,billDate:'2026-11-18',merchant:'東京ガス',source_kind:'document_assistant'
 })
 assert.equal(data.paymentSource,undefined)
})
test('without an explicit plan the existing direct entry remains unchanged',()=>{
 const x=validatedPayload('kakeibo',item,checked,{
  payment_confirmed:true,date:'2026-11-18',
  category:'光熱費',payment_source:'AEON Card'})
 assert.equal(x.operation,'entry')
 assert.equal(x.amount,5500)
})
test('requires verified amount and explicit month before import',()=>{
 assert.throws(()=>validatedPayload('kakeibo',item,new Map([['amount_jpy','5300']]),{
  payment_confirmed:true,date:'2026-11-18',variable_bill_plan_id:planId,
  variable_bill_period:'2026-11'}),/金额/)
 assert.throws(()=>validatedPayload('kakeibo',item,checked,{
  payment_confirmed:true,date:'2026-11-18',
  variable_bill_plan_id:planId,variable_bill_period:'2026-00'}),/月份/)
})
test('candidate user interface distinctly displays a draft mode without direct posting',()=>{
 const ui=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8')
 assert.match(ui,/variable_bill_plan_id/)
 assert.match(ui,/仅同步到账单草稿/)
 assert.match(ui,/不会直接记账、扣款/)
})
