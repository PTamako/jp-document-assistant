import test from 'node:test';
import assert from 'node:assert/strict';
import {parseJapaneseText,interpretCriticalClauses,extractCampaignActionHints} from '../worker/analysis.js';

const suicaEmail = [
  'Suicaポケット受取完了：モバイルSuica',
  'ポケット受取カードに設定したSuicaへの入金（チャージ）が完了しました。',
  '□サービス名', '楽天ペイSuicaチャージ',
  '□会社名', '楽天ペイメント',
  '□受取額', '1,000円',
  '□Suicaポケット依頼ID', 'SYNTHETIC-TEST-ID',
  '□受取完了日時', '2026/11/08 13:04'
].join('\n');


test('Suica pocket completion email extracts top-up amount and timestamp without inferring expense or sender account',()=>{
 const p=parseJapaneseText(suicaEmail);
 assert.equal(p.category,'topup');
 assert.equal(p.fields.find(f=>f.field_key==='amount_jpy')?.normalized_value,'1000');
 assert.equal(p.fields.find(f=>f.field_key==='transaction_at')?.normalized_value,'2026-11-08 13:04');
 assert.equal(p.fields.find(f=>f.field_key==='service_name')?.normalized_value,'楽天ペイSuicaチャージ');
 assert.equal(p.fields.find(f=>f.field_key==='amount_jpy')?.source_quote.includes('受取額'),true);
 assert.equal(p.fields.some(f=>/source_account|due_date/.test(f.field_key)),false);
 assert.match(p.summary_zh,/充值／余额转移/);
 assert.match(p.explanation_zh,/不是新增消费或收入|不是新增消费|资金转移/);
});

test('PayPay charge email has a completion timestamp but no invented payment source or due date',()=>{
 const p=parseJapaneseText('PayPayへのチャージが完了しました。\nチャージ金額：500円\nチャージ完了日時：2026-11-09 08:01');
 assert.equal(p.category,'topup');
 assert.equal(p.fields.find(f=>f.field_key==='amount_jpy')?.normalized_value,'500');
 assert.equal(p.fields.find(f=>f.field_key==='transaction_at')?.normalized_value,'2026-11-09 08:01');
 assert.equal(p.fields.some(f=>f.field_key==='due_date'),false);
});

test('using Suica to pay a merchant is not a stored-value top-up',()=>{
 const p=parseJapaneseText('モバイルSuicaでお買い物をしました。\nご利用金額：800円\n利用日時：2026/11/08 13:04');
 assert.notEqual(p.category,'topup');
 assert.equal(p.fields.some(f=>f.field_key==='transaction_at'),false);
});

test('policy interpretation cites actual Japanese evidence and keeps current-law verification null',()=>{
 const raw=[
 '発行日：令和8年11月11日（水）',
 '条例の施行は令和8年12月1日（火）',
 '申請書は令和8年11月30日（月）必着です。',
 '原則として市内居住者。例外は別紙をご確認ください。',
 '申請が必要です。'
 ].join('\n');
 const parsed=parseJapaneseText(raw);
 assert.equal(parsed.category,'policy');
 assert.equal(parsed.policyVersion.source_document_date,'2026-11-11');
 assert.equal(parsed.policyVersion.official_current_verified_at,null);
 assert.ok(parsed.clauses.some(c=>c.term==='必着'&&c.source_quote.includes('11月30日')));
 assert.ok(parsed.clauses.some(c=>c.term==='例外'));
 assert.match(parsed.explanation_zh,/资料必须在截止日前送达/);
 assert.doesNotMatch(parsed.explanation_zh,/日文证据|申請書|必着/);
 assert.match(parsed.explanation_zh,/官方现行有效性：尚未核验/);
 assert.match(parsed.explanation_zh,/2026-11-11/);
});
test('campaign exceptions and enrollment are attributed to source, not represented as confirmed eligibility',()=>{
 const raw='エントリーが必要です。\n対象外の商品があります。\n他クーポンとの併用不可です。\n上限に達し次第終了します。';
 const p=parseJapaneseText(raw);
 assert.equal(p.category,'campaign');
 assert.deepEqual(p.clauses.map(c=>c.term).filter(x=>['対象外','併用不可','エントリー'].includes(x)),['対象外','併用不可','エントリー']);
 assert.ok(p.clauses.every(c=>c.verified===false&&c.source_quote.length>0));
 assert.equal(p.policyVersion.official_current_verified_at,null);
 assert.equal(p.policyVersion.source_document_date,null);
 assert.match(p.explanation_zh,/文件发布日期：无法确定/);
 assert.doesNotMatch(p.explanation_zh,/日文证据|エントリー|併用不可/);
 assert.doesNotMatch(p.explanation_zh,/您一定符合|已确认有效/);
});
test('manual risk notes use exact original lines and never invent amounts or due dates',()=>{
 const p=parseJapaneseText('取扱説明書\n使用上の注意：水濡れ禁止。\n別途料金がかかる場合があります。');
 assert.equal(p.category,'manual');
 assert.ok(p.clauses.find(c=>c.term==='禁止').source_quote.includes('水濡れ禁止'));
 assert.ok(p.clauses.find(c=>c.term==='別途料金'));
 assert.equal(p.fields.length,0);
 assert.match(p.explanation_zh,/文书类别：使用说明/);
 assert.doesNotMatch(p.explanation_zh,/取扱説明書|使用上の注意|水濡れ禁止/);
});
test('interpretation is limited and cannot claim that a quoted condition was verified',()=>{
 const lines=Array.from({length:40},(_,i)=>i%2?'併用不可':'対象外').join('\n');
 const evidence=interpretCriticalClauses(lines,{limit:1});
 assert.equal(evidence.length,1);
 assert.equal(evidence[0].verified,false);
 assert.ok(evidence[0].source_quote.length>0);
});

test('ONIGO campaign extracts the explicitly dated 11/15(日) offer deadline without inventing a purchase',()=>{
 const text=[
 '件名：【よりどり2点5%OFF】セブンプレミアムゴールドのお肉加工品がお得！',
 '今なら対象商品がよりどり2点で5%OFF！11/15(日)までの期間限定！',
 '▼LINE ID連携で500円OFFクーポンプレゼント▼',
 'キャンペーン・お得情報メール'
 ].join('\n');
 const p=parseJapaneseText(text,{referenceYear:2026});
 assert.equal(p.category,'campaign');
 const partial=p.fields.find(f=>f.field_key==='due_date_partial');
 const due=p.fields.find(f=>f.field_key==='due_date');
 assert.equal(partial?.normalized_value,'11/15(日)');
 assert.match(partial?.source_quote||'',/11\/15\(日\)まで/);
 assert.equal(due?.normalized_value,'2026-11-15');
 assert.equal(due?.review_state,'unreviewed');
 assert.match(due?.source_quote||'',/年份自动补全/);
 assert.equal(p.fields.some(f=>['amount_jpy','net_salary'].includes(f.field_key)),false,'discount is not a transaction');
 const hints=extractCampaignActionHints(text);
 assert.equal(hints.length,1);
 assert.match(hints[0].description_zh,/500 日元优惠券/);
 assert.equal(hints[0].requires_confirmation,true);
});
test('campaign dates need a deadline hint and weekday must agree with assumed year',()=>{
 const noHint=parseJapaneseText('キャンペーンのお知らせ：商品番号 11/15 の紹介。',{referenceYear:2026});
 assert.equal(noHint.fields.some(f=>f.field_key==='due_date'),false);
 const wrongWeekday=parseJapaneseText('キャンペーン：11/15(土)までの期間限定！',{referenceYear:2026});
 assert.equal(wrongWeekday.fields.find(f=>f.field_key==='due_date_partial')?.normalized_value,'11/15(土)');
 assert.equal(wrongWeekday.fields.some(f=>f.field_key==='due_date'),false);
 const withoutCoupon=extractCampaignActionHints('LINE IDを連携できます。');
 assert.deepEqual(withoutCoupon,[]);
 const ordinary=parseJapaneseText('宅配予定：11/15(日)までにお届けします。',{referenceYear:2026});
 assert.equal(ordinary.fields.some(f=>f.field_key==='due_date_partial'),false);
});
