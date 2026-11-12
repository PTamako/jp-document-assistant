import test from 'node:test';
import assert from 'node:assert/strict';
import {parseJapaneseText} from '../worker/analysis.js';

const get=(result,key)=>result.fields.find(x=>x.field_key===key);

test('bank scheduled debit: amount and event date, no false actionable deadline',()=>{
 const original=[
  '三井住友銀行より、以下の口座引き落としについて事前にお知らせします。',
  '口座引落予定日：2026年11月10日',
  '◆明細１',
  '引落金額：27,460円',
  '内容：（カ）ジェーシービー',
  '（2026年11月06日19時49分現在）'
 ].join('\n');
 const p=parseJapaneseText(original);
 assert.equal(p.category,'bank');
 assert.equal(get(p,'amount_jpy')?.normalized_value,'27460');
 assert.equal(get(p,'event_date')?.normalized_value,'2026-11-10');
 assert.equal(get(p,'due_date'),undefined);
 assert.match(p.explanation_zh,/银行账户自动扣款/);
 assert.match(p.explanation_zh,/27,460 日元/);
 assert.match(p.explanation_zh,/计划扣款日/);
 assert.doesNotMatch(p.explanation_zh,/必须在2026-11-10前付款/);
});
test('stored-value Suica topup retains no expense inference and explains transfer',()=>{
 const raw=[
  'Suicaポケット受取完了：モバイルSuica',
  'ポケット受取カードに設定したSuicaへの入金（チャージ）が完了しました。',
  '□サービス名',
  '楽天ペイSuicaチャージ',
  '□受取額',
  '1,000円',
  '□受取完了日時',
  '2026/11/08 13:04'
 ].join('\n');
 const p=parseJapaneseText(raw);
 assert.equal(p.category,'topup');
 assert.equal(get(p,'amount_jpy')?.normalized_value,'1000');
 assert.equal(get(p,'transaction_at')?.normalized_value,'2026-11-08 13:04');
 assert.equal(get(p,'due_date'),undefined);
 assert.match(p.explanation_zh,/交通卡资金变化/);
 assert.match(p.explanation_zh,/账户间转移/);
 assert.doesNotMatch(p.explanation_zh,/存在未注明年份的日期/);
});
test('delivery date means scheduled arrival, not a payment deadline',()=>{
 const raw=[
  '佐川急便 お荷物のお届けについてお知らせします。',
  'お届け予定日時',
  '2026/10/12（月） AM8:00～12:00',
  'お客様からのご指定がない場合に限り、予定日よりも前にお伺いすることがあります。'
 ].join('\n');
 const p=parseJapaneseText(raw);
 assert.equal(p.category,'delivery');
 assert.equal(get(p,'event_date')?.normalized_value,'2026-10-12');
 assert.equal(get(p,'due_date'),undefined);
 assert.match(p.explanation_zh,/预计配送／送达日期/);
 assert.match(p.explanation_zh,/AM8:00/);
 assert.doesNotMatch(p.explanation_zh,/存在未注明年份的日期/);
});
test('real submission deadlines remain deadlines, not delivery events',()=>{
 const p=parseJapaneseText('納付期限：令和8年11月30日（月）\n納付金額：12,340円\n税額 12340');
 assert.equal(p.category,'tax');
 assert.equal(get(p,'due_date')?.normalized_value,'2026-11-30');
 assert.equal(get(p,'event_date'),undefined);
 assert.equal(get(p,'amount_jpy')?.normalized_value,'12340');
});
