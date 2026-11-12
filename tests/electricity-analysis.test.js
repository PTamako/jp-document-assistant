import test from 'node:test';
import assert from 'node:assert/strict';
import {parseJapaneseText} from '../worker/analysis.js';

const get=(analysis,key)=>analysis.fields.find(x=>x.field_key===key);
test('electricity bill separates metering charge, invoice total, use and card advance date',()=>{
 const raw=[
  '電気料金の検針期間',
  '2026/09/16 ~ 2026/10/15\t1,966円 (税込)',
  '56.00kWh',
  '今回のご請求金額合計：',
  '1,770円（税込)',
  'カード立替日 : 2026/10/28'
 ].join('\n');
 const p=parseJapaneseText(raw);
 assert.equal(p.category,'utility');
 assert.equal(p.summary_zh,'电费账单／用电量通知');
 assert.equal(get(p,'meter_period_start')?.normalized_value,'2026-09-16');
 assert.equal(get(p,'meter_period_end')?.normalized_value,'2026-10-15');
 assert.equal(get(p,'period_charge_jpy')?.normalized_value,'1966');
 assert.equal(get(p,'period_charge_jpy')?.value_type,'money');
 assert.equal(get(p,'amount_jpy')?.normalized_value,'1770');
 assert.equal(get(p,'usage_kwh')?.normalized_value,'56.00');
 assert.equal(get(p,'usage_kwh')?.value_type,'text');
 assert.equal(get(p,'card_advance_date')?.normalized_value,'2026-10-28');
 assert.equal(get(p,'due_date'),undefined);
 assert.equal(p.fields.filter(f=>f.field_key==='amount_jpy').length,1);
 assert.ok(p.fields.every(f=>f.review_state==='unreviewed'));
 assert.match(p.explanation_zh,/检针期间显示电费：1,966 日元/);
 assert.match(p.explanation_zh,/本次请款金额：1,770 日元/);
 assert.match(p.explanation_zh,/用电量：56.00 kWh/);
 assert.match(p.explanation_zh,/相差 196 日元/);
 assert.match(p.explanation_zh,/没有说明差额原因/);
 assert.match(p.explanation_zh,/不是缴费截止日/);
 assert.doesNotMatch(p.explanation_zh,/折扣原因已确定|付款成功/);
});
test('electricity invoice with same-line total keeps charge labels disambiguated',()=>{
 const p=parseJapaneseText('電気料金の検針期間\n2026/09/16 ～ 2026/10/15\t1,966円（税込）\n使用電力量 56.00 kWh\n今回のご請求金額合計：1,770円(税込)\nカード立替日：2026/10/28');
 assert.equal(get(p,'amount_jpy')?.normalized_value,'1770');
 assert.equal(get(p,'period_charge_jpy')?.normalized_value,'1966');
 assert.equal(get(p,'usage_kwh')?.normalized_value,'56.00');
 assert.equal(get(p,'card_advance_date')?.normalized_value,'2026-10-28');
 assert.equal(get(p,'due_date'),undefined);
});
test('meter dates and card advance do not synthesize payment deadline when invoice total absent',()=>{
 const p=parseJapaneseText('電気料金の検針期間\n2026/09/16 ~ 2026/10/15\t1,966円（税込）\n使用量：56.00kWh\nカード立替日 : 2026/10/28');
 assert.equal(get(p,'amount_jpy'),undefined);
 assert.equal(get(p,'period_charge_jpy')?.normalized_value,'1966');
 assert.equal(get(p,'due_date'),undefined);
 assert.match(p.explanation_zh,/没有明确缴费截止日/);
});
test('invalid or reversed meter range is never accepted as a legitimate period',()=>{
 const p=parseJapaneseText('電気料金の検針期間\n2026/10/15 ~ 2026/09/16\t1,966円\n今回のご請求金額合計：1,770円');
 assert.equal(get(p,'meter_period_start'),undefined);
 assert.equal(get(p,'meter_period_end'),undefined);
 assert.equal(get(p,'period_charge_jpy'),undefined);
 assert.equal(get(p,'amount_jpy')?.normalized_value,'1770');
});
