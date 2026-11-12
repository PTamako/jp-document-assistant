import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAiAnalysis,geminiGenerationConfig,classifyGeminiHttpError,extractGeminiResponseText} from '../worker/intelligence.js';
test('AI output only generates source-grounded Chinese explanations, words and sentences',()=>{
 const source='営業時間を確認してください。納付期限は明日ではありません。';
 const raw=JSON.stringify({summary_zh:'营业时间说明，需要人工确认',
  explanation_zh:'这是一份普通说明，不代表已经支付或需要办理。',important_points_zh:['请核对营业时间'],
  vocabulary:[{term:'営業時間',reading:'えいぎょうじかん',meaning_zh:'营业时间',source_quote:'営業時間'},
              {term:'不存在',reading:'',meaning_zh:'凭空捏造',source_quote:'不存在'}],
  sentences:[{sentence:'営業時間を確認してください。',source_quote:'営業時間を確認してください。',translation_zh:'请确认营业时间。'},
             {sentence:'捏造的例句',source_quote:'捏造的例句',translation_zh:'无效'}],
  homeflow_suggestions:[{description_zh:'提醒检查',date:'2026-11-30',source_quote:'虚假的原文'}],
  finance_suggestions:[]});
 const result=normalizeAiAnalysis(raw,source);
 assert.ok(result);
 assert.equal(result.vocabulary.length,1);
 assert.equal(result.sentences.length,1);
 assert.equal(result.homeflow_suggestions.length,0);
 assert.match(result.notice,/人工|确认|候选/);
});
test('unparseable AI output is not treated as success',()=>{
 assert.equal(normalizeAiAnalysis('无效输出','原文'),null);
 assert.equal(normalizeAiAnalysis('{}','原文'),null);
});

test('AI field suggestions must be literal source phrases, never fabricated dates or money',()=>{
 const source='11月30日までに申請書を提出してください。お手数ですが、内容をご確認ください。';
 const result=normalizeAiAnalysis(JSON.stringify({
  summary_zh:'请在截止日期前提交申请',
  explanation_zh:'原文未注明年份，因此必须人工确认是哪一年的11月30日。',
  field_suggestions:[
   {field_key:'due_date_partial',normalized_value:'11月30日',source_quote:'11月30日までに申請書を提出してください。'},
   {field_key:'required_action',normalized_value:'申請書を提出してください',source_quote:'11月30日までに申請書を提出してください。'},
   {field_key:'review_action',normalized_value:'内容をご確認ください',source_quote:'お手数ですが、内容をご確認ください。'},
   {field_key:'due_date',normalized_value:'2026-11-30',source_quote:'11月30日までに申請書を提出してください。'},
   {field_key:'amount_jpy',normalized_value:'10000',source_quote:'11月30日までに申請書を提出してください。'},
   {field_key:'required_action',normalized_value:'存在しない指示',source_quote:'11月30日までに申請書を提出してください。'}
  ],
  vocabulary:[],sentences:[],important_points_zh:[],homeflow_suggestions:[],finance_suggestions:[]
 }),source);
 assert.deepEqual(result.field_suggestions.map(x=>x.field_key),
   ['due_date_partial','required_action','review_action']);
 assert.ok(result.field_suggestions.every(x=>x.review_state==='unreviewed'));
});

test('Gemini uses explicit MEDIUM with enough total thinking/output tokens, without legacy sampling knobs',()=>{
 const cfg=geminiGenerationConfig();
 assert.deepEqual(cfg,{responseMimeType:'application/json',thinkingConfig:{thinkingLevel:'MEDIUM'},maxOutputTokens:8192});
 assert.equal('temperature' in cfg,false);
 assert.equal('thinkingBudget' in cfg.thinkingConfig,false);
});
test('Gemini status codes are categorized safely without exposing provider response bodies',()=>{
 assert.equal(classifyGeminiHttpError(429),'gemini_quota_or_rate_limited');
 assert.equal(classifyGeminiHttpError(403),'gemini_access_denied');
 assert.equal(classifyGeminiHttpError(400),'gemini_invalid_request');
 assert.equal(classifyGeminiHttpError(404),'gemini_model_unavailable');
 assert.equal(classifyGeminiHttpError(503),'gemini_service_unavailable');
});
test('Gemini distinguishes truncated, blocked, missing and good JSON text',()=>{
 assert.throws(()=>extractGeminiResponseText({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[]}}]}),/gemini_output_truncated/);
 assert.throws(()=>extractGeminiResponseText({promptFeedback:{blockReason:'SAFETY'}}),/gemini_content_blocked/);
 assert.throws(()=>extractGeminiResponseText({candidates:[{finishReason:'STOP',content:{parts:[]}}]}),/gemini_empty_response/);
 assert.equal(extractGeminiResponseText({candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'private thoughts'},{text:'{"summary_zh":"已分析"}'}]}}]}),'{"summary_zh":"已分析"}');
});
