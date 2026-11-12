import test from 'node:test';
import assert from 'node:assert/strict';
import { chineseExplanation } from '../web/src/chinese-explanation.js';
import { parseJapaneseText } from '../worker/analysis.js';

test('older saved explanation hides source evidence while retaining translated clauses and figures',()=>{
 const old=[
  '文书类别建议：法规／政策',
  '关键条款（逐条核对日文原文，未确认个人资格）：',
  '· 併用不可｜日文证据：「他のクーポンとの併用不可」｜中文：此优惠不能与指定优惠同时使用｜建议：核对具体不得叠加的券或活动',
  '原文版本／发布日期线索：2026-11-03（公布日：令和8年11月3日）',
  '官方现行有效性：尚未核验',
  '待核对截止日：2026-11-30｜原文：申請期限 令和8年11月30日'
 ].join('\n');
 const result=chineseExplanation(old);
 assert.match(result,/关键注意事项/);
 assert.match(result,/优惠不能与指定优惠同时使用/);
 assert.match(result,/文件发布日期线索：2026-11-03/);
 assert.match(result,/2026-11-30/);
 assert.doesNotMatch(result,/日文证据|｜原文：|原文版本|併用不可|公布日：令和/);
 assert.doesNotMatch(result,/[\u3040-\u30ff]/);
});
test('old bank, delivery and card explanation removes Japanese quote lines but keeps dates and values',()=>{
 const raw=[
  '文书类别建议：银行／信用卡',
  '这是什么：这是一份银行账户自动扣款相关通知。“口座引き落とし／口座振替”指从银行账户扣款，并不等于信用卡当天新增一笔消费。',
  '原文所列扣款金额：27,460 日元（尚须核对）。',
  '如果是“予定日”，仅为计划扣款日，不能据此断定扣款已成功。',
  '扣款内容／相关机构线索（日文原文）：引落先：カ）サンプル',
  '配送时间线索（日文原文）：2026/10/12（月） AM8:00～12:00',
  '消费商户：マクドナルドモバイルオーダー（日文原文：マクドナルドモバイルオーダー（買物） 1,520円）。',
  '金额线索：1520 日元｜原文：マクドナルドモバイルオーダー（買物） 1,520円'
 ].join('\n');
 const result=chineseExplanation(raw);
 assert.match(result,/27,460 日元/);
 assert.match(result,/08:00～12:00/);
 assert.match(result,/麦当劳移动点餐/);
 assert.match(result,/1520 日元/);
 assert.doesNotMatch(result,/日文原文|カ）|マクドナルド|口座引き落とし|予定日|｜原文：/);
});
test('new generated interpretations never repeat Japanese original excerpts',()=>{
 const cases=[
  '佐川急便 お荷物のお届けについて\nお届け予定日時\n2026/10/12（月） AM8:00～12:00',
  'いつも三井住友カードをご利用いただきありがとうございます。\nＯｌｉｖｅ／クレジットについてカードの利用内容をお知らせします。\nご利用日時：2026/11/08 13:58\nマクドナルドモバイルオーダー（買物） 1,520円',
  '納付期限：令和8年11月30日\n納付金額：12,340円\n対象外／併用不可',
  '電気料金の検針期間\n2026/09/16 ~ 2026/10/15 1,966円\n56.00kWh\n今回のご請求金額合計：\n1,770円\nカード立替日：2026/10/28',
  '給与明細\n差引支給額 230,000円',
  'お振込によるご入金がございました。\n入金日時 ：２０２６年１１月１０日　００時１３分２７秒\n入金内容 ：カ）サンプル　キユウヨ',
  'Suicaポケット受取完了：モバイルSuica\n受取額：1,000円\n受取完了日時：2026/11/08 13:04'
 ];
 for(const original of cases){
  const result=parseJapaneseText(original);
  assert.ok(result.explanation_zh.length>15);
  assert.doesNotMatch(result.explanation_zh, /｜原文：|日文证据|日文原文|可核对的日文依据/);
  assert.doesNotMatch(result.explanation_zh,/[\u3040-\u30ff]/);
  assert.ok(result.fields.every(f=>f.source_quote!==undefined));
 }
});
