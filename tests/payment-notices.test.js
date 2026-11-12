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
test('receipt and salary matching do not reclassify card bill payment or Suica recharge',()=>{
 assert.equal(parseJapaneseText('口座引落予定日：2026年11月10日\n引落金額：20,000円').category,'bank');
 assert.equal(parseJapaneseText('Suicaポケット受取完了\n受取額：1,000円').category,'topup');
});
