import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyText,parseJapaneseText,medicalAppointmentTaskSuggestion} from '../worker/analysis.js';
import {validatedPayload} from '../worker/bridge.js';

const booking=[
  '件名：MySBCにてご予約を承りました',
  '差出人：SHONAN BEAUTY CLINIC <info@mc.sbc-med.com>',
  'メール日付：Sat, 21 Nov 2026 05:11:31 -0600',
  '湘南美容クリニック上野院でございます。',
  'ご予約のお申込みありがとうございます。',
  'こちらのメールをもちまして本予約とさせて頂きます。',
  '2026年12月05日(土)でご予約を承りました。',
  'ご来院時刻 10:30　終了予定時刻 12:00',
  'ご予約内容',
  'フォトダブル（ルメッカピーク）首1回 契約施術'
].join('\n');

test('MySBC confirmed appointment detects visit date and arrival time, not email or end time',()=>{
  const parsed=parseJapaneseText(booking);
  assert.equal(classifyText(booking),'medical');
  assert.equal(parsed.category,'medical');
  const event=parsed.fields.find(f=>f.field_key==='event_date');
  assert.equal(event?.normalized_value,'2026-12-05');
  assert.match(event?.source_quote||'',/ご予約を承りました/);
  assert.equal(event?.review_state,'unreviewed');
  assert.equal(parsed.fields.some(f=>f.field_key==='due_date'),false);
  const task=medicalAppointmentTaskSuggestion(parsed,booking,{today:'2026-11-22',visibility:'private'});
  assert.equal(task?.task_type,'medical_appointment');
  assert.equal(task?.date_field_key,'event_date');
  assert.equal(task?.due_on,'2026-12-05');
  assert.match(task?.title||'',/湘南美容クリニック上野院/);
  assert.match(task?.title||'',/10:30/);
  assert.doesNotMatch(task?.title||'',/12:00/);
  assert.equal(task?.requires_confirmation,true);
  assert.equal(task?.visibility,'private');
});

test('HomeFlow rejects unreviewed or mismatched appointment date and accepts reviewed private reminder',()=>{
  const parsed=parseJapaneseText(booking);
  const task=medicalAppointmentTaskSuggestion(parsed,booking,{today:'2026-11-22'});
  const item={candidate_kind:'homeflow_task',visibility:'private',payload_json:JSON.stringify(task)};
  const opts={visibility:'private',title:task.title,reminder_only:true,bonus_points:0};
  assert.throws(()=>validatedPayload('homeflow',item,new Map(),opts),/未经人工核验/);
  assert.throws(()=>validatedPayload('homeflow',item,new Map([['event_date','2026-12-06']]),opts),/未经人工核验/);
  const approved=new Map([['event_date','2026-12-05']]);
  assert.deepEqual(validatedPayload('homeflow',item,approved,opts),{
    operation:'task',title:task.title,dueOn:'2026-12-05',
    visibility:'private',assignee:null,bonusPoints:0,remindEnabled:true,reminderOnly:true
  });
  assert.throws(()=>validatedPayload('homeflow',item,approved,{...opts,visibility:'household'}),/需要确认共享/);
});

test('marketing, cancellation, mismatched weekday and past booking do not generate tasks',()=>{
  const promo='湘南美容クリニック お得なご案内：ご予約ください。2026年12月05日(土)限定';
  assert.equal(medicalAppointmentTaskSuggestion(parseJapaneseText(promo),promo,{today:'2026-11-22'}),null);
  const cancelled=booking+'\nご予約をキャンセルしました。';
  assert.equal(medicalAppointmentTaskSuggestion(parseJapaneseText(cancelled),cancelled,{today:'2026-11-22'}),null);
  const badWeekday=booking.replace('12月05日(土)','12月05日(日)');
  assert.equal(medicalAppointmentTaskSuggestion(parseJapaneseText(badWeekday),badWeekday,{today:'2026-11-22'}),null);
  assert.equal(medicalAppointmentTaskSuggestion(parseJapaneseText(booking),booking,{today:'2026-12-06'}),null);
});

test('an unrelated date in the email header does not become the appointment date',()=>{
  const noVisitDay='湘南美容クリニック上野院\nご予約を承りました\nメール日付：2026年11月21日';
  assert.equal(parseJapaneseText(noVisitDay).fields.some(f=>f.field_key==='event_date'),false);
  assert.equal(medicalAppointmentTaskSuggestion(parseJapaneseText(noVisitDay),noVisitDay,{today:'2026-11-22'}),null);
});
