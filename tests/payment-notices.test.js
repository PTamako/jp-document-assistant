import test from 'node:test';
import assert from 'node:assert/strict';
import {parseJapaneseText} from '../worker/analysis.js';
import {isSalaryDepositNotice,isCardPurchaseNotice} from '../worker/payment-notices.js';
const f=(p,k)=>p.fields.find(x=>x.field_key===k);
const salary=[
 'いつもきらぼし銀行をご利用いただきありがとうございます。',
 '小岩支店の普通預金口座＊＊＊＊＊＊にお振込によるご入金がございました。',
 '入金日時 ：２０２６年１１月１０日　００時１３分２７秒',
 '入金内容 ：カ）サンプルカイシャ　キユウヨ',
 '詳細は入出金明細照会等でご確認ください。'
].join('\n');
const card=[
 'いつも三井住友カードをご利用いただきありがとうございます。',
 'Ｏｌｉｖｅ／クレジットについてカードの利用内容をお知らせします。',
 'ご利用内容',
 'ご利用日時：2026/11/08 13:58',
 'マクドナルドモバイルオーダー（買物）\t1,520円'
].join('\n');
test('full-width bank payroll deposit retains factual timestamp and sender without inventing a salary amount',()=>{
 assert.equal(isSalaryDepositNotice(salary),true);
 const parsed=parseJapaneseText(salary);
 assert.equal(parsed.category,'salary');
 assert.equal(parsed.summary_zh,'银行工资入账通知');
 assert.equal(f(parsed,'transaction_at')?.normalized_value,'2026-11-10 00:13:27');
 assert.match(f(parsed,'deposit_from')?.normalized_value||'',/キユウヨ/);
 assert.equal(f(parsed,'net_salary'),undefined);
 assert.equal(f(parsed,'amount_jpy'),undefined);
 assert.match(parsed.explanation_zh,/没有注明收入金额/);
 assert.match(parsed.explanation_zh,/手动填写/);
 assert.match(parsed.issues.join(' '),/不能自动猜测金额|金额/);
});
test('Olive purchase extracts merchant, datetime and 1,520 yen but no bank debit or invented deadline',()=>{
 assert.equal(isCardPurchaseNotice(card),true);
 const parsed=parseJapaneseText(card);
 assert.equal(parsed.category,'card_spend');
 assert.equal(parsed.summary_zh,'信用卡消费通知');
 assert.equal(f(parsed,'amount_jpy')?.normalized_value,'1520');
 assert.equal(f(parsed,'merchant')?.normalized_value,'マクドナルドモバイルオーダー');
 assert.equal(f(parsed,'transaction_at')?.normalized_value,'2026-11-08 13:58');
 assert.equal(f(parsed,'due_date'),undefined);
 assert.match(f(parsed,'amount_jpy')?.source_quote||'',/1,520円/);
 assert.match(parsed.explanation_zh,/1,520 日元/);
 assert.match(parsed.explanation_zh,/不是信用卡扣款日期/);
 assert.match(parsed.explanation_zh,/重复/);
});
test('full-width Olive amount still recognized and monthly bill / refund not treated as new purchases',()=>{
 const full=card.replace('1,520円','１，５２０円');
 assert.equal(f(parseJapaneseText(full),'amount_jpy')?.normalized_value,'1520');
 for(const text of [
   '三井住友カード ご請求額 15,000円 ご利用日時：2026/11/08 13:58',
   '三井住友カードのご利用内容\nご利用日時：2026/11/08 13:58\n返金処理 1,520円',
   '三井住友カードのご利用内容\nご利用日時：2026/11/08 13:58\n引落合計 1,520円',
   '三井住友カードのご利用内容\nご利用日時：2026/11/08 13:58\nカードチャージ 1,520円'
 ])assert.equal(isCardPurchaseNotice(text),false);
});
test('split-field SMBC Olive authorization extracts 151 JPY as reviewable expense',()=>{
 const raw=[
  '件名：ご利用のお知らせ【三井住友カード】',
  'お客様のカードご利用内容をお知らせいたします。',
  'ご利用カード：Ｏｌｉｖｅ／クレジット',
  '◇利用日：2026/05/28 19:06',
  '◇利用先：セブン－イレブン',
  '◇利用取引：買物',
  '◇利用金額：151円',
  '※カード利用の承認照会通知であり、ご請求を確定しません。'
 ].join('\n');
 assert.equal(isCardPurchaseNotice(raw),true);
 const parsed=parseJapaneseText(raw);
 assert.equal(parsed.category,'card_spend');
 assert.equal(f(parsed,'amount_jpy')?.normalized_value,'151');
 assert.equal(f(parsed,'merchant')?.normalized_value,'セブン-イレブン');
 assert.equal(f(parsed,'transaction_at')?.normalized_value,'2026-05-28 19:06');
 assert.equal(f(parsed,'amount_jpy')?.source_quote,'◇利用金額：151円');
 assert.equal(f(parsed,'merchant')?.source_quote,'◇利用先：セブン－イレブン');
 assert.equal(f(parsed,'due_date'),undefined);
 assert.equal(isCardPurchaseNotice(raw.replace('◇利用取引：買物','◇利用取引：返金')),false);
 assert.equal(isCardPurchaseNotice(raw+'\n◇利用金額：200円'),false);
});
test('receipt and salary matching do not reclassify card bill payment or Suica recharge',()=>{
 assert.equal(parseJapaneseText('口座引落予定日：2026年11月10日\n引落金額：20,000円').category,'bank');
 assert.equal(parseJapaneseText('Suicaポケット受取完了\n受取額：1,000円').category,'topup');
});

test('shop and transaction timestamp are extracted from a Japanese shopping order, not message arrival metadata',()=>{
 const text=[
  '購入明細',
  'ショップ名：カメラショップ渋谷',
  '購入日時：2026年11月8日（日） 14時23分',
  '合計金額：3,520円',
  'メール送信日時：2026年11月9日 08:00',
  '営業時間：10:00〜21:00'
 ].join('\n');
 const parsed=parseJapaneseText(text);
 assert.equal(parsed.category,'shopping');
 assert.equal(f(parsed,'merchant')?.normalized_value,'カメラショップ渋谷');
 assert.equal(f(parsed,'transaction_at')?.normalized_value,'2026-11-08 14:23');
 assert.equal(f(parsed,'merchant')?.source_quote,'ショップ名：カメラショップ渋谷');
 assert.equal(f(parsed,'due_date'),undefined);
 assert.equal(parseJapaneseText('購入明細\nメール送信日時：2026/11/09 08:00').fields.some(x=>x.field_key==='transaction_at'),false);
});
test('split-line OCR transaction clock and alternate store label retain the printed source',()=>{
 const text=[
  'カードのご利用内容をお知らせします。三井住友カード',
  '利用日時：2026/11/08',
  '利用時刻：19:06',
  '店舗名：セブン－イレブン',
  '利用金額：151円',
  '利用取引：買物'
 ].join('\n');
 assert.equal(isCardPurchaseNotice(text),true);
 const parsed=parseJapaneseText(text);
 assert.equal(parsed.category,'card_spend');
 assert.equal(f(parsed,'merchant')?.normalized_value,'セブン-イレブン');
 assert.equal(f(parsed,'transaction_at')?.normalized_value,'2026-11-08 19:06');
 assert.equal(f(parsed,'amount_jpy')?.normalized_value,'151');
});
