import test from 'node:test';
import assert from 'node:assert/strict';
import {parseJapaneseText} from '../worker/analysis.js';
import {deliveryWindow,deliveryTaskSuggestion} from '../worker/delivery-task.js';

const make=(date,ending='')=>[
 '佐川急便 お荷物のお届けについてお知らせします。',
 '■お届け予定日時',
 date+'　AM8:00～12:00',
 '※お客様からのご指定がない場合に限り、お届け予定日よりも前にお伺いすることがあります。',
 '※ご都合の良い日時を以下よりご指定ください。',
 ending
].join('\n');

test('source-backed delivery window reads AM8 to noon without mistaking noon for midnight',()=>{
 assert.equal(deliveryWindow(make('2026/11/18（水）')),'08:00～12:00');
 assert.equal(deliveryWindow('お届け予定日時\n2099/01/01 PM1:00～4:00'),'13:00～16:00');
 assert.equal(deliveryWindow('お届け予定日時\n2099/01/01 13:00～16:00'),'13:00～16:00');
 assert.equal(deliveryWindow('ご利用予定日\n2099/01/01 13:00～16:00'),null);
});
test('future scheduled deliveries generate a reviewable HomeFlow task proposal',()=>{
 const raw=make('2026/11/18（水）'),p=parseJapaneseText(raw);
 const task=deliveryTaskSuggestion(p,raw,{today:'2026-11-12',visibility:'private'});
 assert.equal(p.category,'delivery');
 assert.equal(p.fields.find(f=>f.field_key==='event_date')?.normalized_value,'2026-11-18');
 assert.equal(p.fields.some(f=>f.field_key==='due_date'),false);
 assert.equal(task?.task_type,'delivery');
 assert.equal(task?.date_field_key,'event_date');
 assert.equal(task?.due_on,'2026-11-18');
 assert.equal(task?.delivery_window,'08:00～12:00');
 assert.equal(task?.visibility,'private');
 assert.match(task?.title||'',/佐川急便.*08:00～12:00/);
 assert.match(task?.note||'',/提前配送/);
 assert.equal(task?.requires_confirmation,true);
});
test('old, cancelled and delivered notices never generate fresh delivery tasks',()=>{
 const old=make('2026/10/12（月）');
 assert.equal(deliveryTaskSuggestion(parseJapaneseText(old),old,{today:'2026-11-12'}),null);
 const current=make('2026/11/18（水）');
 for(const extra of ['配達完了','配送キャンセル','お届け済み']){
  const text=current+'\n'+extra;
  assert.equal(deliveryTaskSuggestion(parseJapaneseText(text),text,{today:'2026-11-12'}),null);
 }
});
test('electricity invoice and bank debit event dates are never delivery tasks',()=>{
 const bank='口座引落予定日：2099年10月10日\n引落金額：500円';
 const energy='電気料金の検針期間\n2099/09/16 ~ 2099/10/15\t1,966円\nカード立替日：2099/10/28';
 for(const text of [bank,energy]){
  const parsed=parseJapaneseText(text);
  assert.equal(deliveryTaskSuggestion(parsed,text,{today:'2026-11-12'}),null);
 }
});
