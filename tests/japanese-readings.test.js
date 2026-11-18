import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolveJapaneseReading,isValidJapaneseReading} from '../shared/japanese-readings.js';
import {normalizeAiAnalysis} from '../worker/intelligence.js';
import {validatedPayload} from '../worker/bridge.js';
import {resetCandidateConfirmation} from '../web/src/candidate-draft.js';

test('reviewed compound words override legacy and new AI hallucinations',()=>{
 assert.deepEqual(resolveJapaneseReading('賦課金','ふかけいん'),
   {reading:'ふかきん',verified:true,source:'reviewed-glossary'});
 assert.equal(resolveJapaneseReading('燃料費調整額','ねんりょうひちょうせいひ').reading,'ねんりょうひちょうせいがく');
 assert.equal(resolveJapaneseReading('営業時間','えいぎょうしかん').reading,'えいぎょうじかん');
 assert.equal(resolveJapaneseReading('チャージ','ちゃーじ').verified,true);
 assert.equal(resolveJapaneseReading('チャージ','').reading,'ちゃーじ');
});
test('unknown kanji readings are NOT certified and invalid kana is not propagated',()=>{
 assert.deepEqual(resolveJapaneseReading('専門用語','せんもんようご'),
   {reading:'せんもんようご',verified:false,source:'ai-unverified'});
 assert.deepEqual(resolveJapaneseReading('専門用語','unknown'),
   {reading:'',verified:false,source:'ai-unverified'});
 assert.equal(isValidJapaneseReading('セんモん'),true);
 assert.equal(isValidJapaneseReading('ふかけいん3'),false);
});
test('AI normalizer corrects frequent utility readings and flags other candidates',()=>{
 const source='賦課金と専門用語の説明です。';
 const raw=JSON.stringify({
  summary_zh:'生活费用说明需要核对',
  explanation_zh:'这是一份需要核实的费用通知，不应推断为已经付款。',
  vocabulary:[
   {term:'賦課金',reading:'ふかけいん',meaning_zh:'附加费',source_quote:'賦課金'},
   {term:'専門用語',reading:'せんもんようご',meaning_zh:'专业术语',source_quote:'専門用語'}],
  sentences:[]
 });
 const result=normalizeAiAnalysis(raw,source);
 assert.equal(result.vocabulary[0].reading,'ふかきん');
 assert.equal(result.vocabulary[0].reading_verified,true);
 assert.equal(result.vocabulary[1].reading_verified,false);
});
const item=(term,reading)=>({candidate_kind:'vocabulary',
 payload_json:JSON.stringify({term,reading,meaning_zh:'示例解释'})});
test('study bridge fixes old stored AI reading before signing a sync',()=>{
 const payload=validatedPayload('zhixue',item('賦課金','ふかけいん'),new Map(),
  {privacy_confirmed:true,redacted_term:'賦課金',reading:'ふかけいん'});
 assert.equal(payload.reading,'ふかきん');
 assert.equal(payload.term,'賦課金');
});
test('unknown words require explicit correction and per-candidate acknowledgement',()=>{
 const source=item('専門用語','せんもんようご');
 assert.throws(()=>validatedPayload('zhixue',source,new Map(),
  {privacy_confirmed:true,redacted_term:'専門用語',reading:'せんもんようご'}));
 const approved=validatedPayload('zhixue',source,new Map(),
  {privacy_confirmed:true,redacted_term:'専門用語',reading:'せんもんようご',reading_confirmed:true});
 assert.equal(approved.reading,'せんもんようご');
 assert.throws(()=>validatedPayload('zhixue',source,new Map(),
  {privacy_confirmed:true,redacted_term:'専門用語',reading:'senmon',reading_confirmed:true}));
});
test('confirmation state resets when opening another candidate',()=>{
 const draft={reading:'あやまり',reading_confirmed:true,privacy_confirmed:true};
 resetCandidateConfirmation(draft,{term:'次の単語'});
 assert.equal(draft.reading,'');
 assert.equal(draft.reading_confirmed,false);
 assert.equal(draft.privacy_confirmed,false);
});
test('mobile flow shows corrected historical values and includes a reading confirmation',()=>{
 const vue=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
 assert.match(vue,/resolveJapaneseReading\(item\.payload\.term,item\.payload\.reading\)/);
 assert.match(vue,/v-model="candidateDraft\.reading"/);
 assert.match(vue,/v-model="candidateDraft\.reading_confirmed"/);
});
