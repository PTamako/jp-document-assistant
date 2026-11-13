import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const ui=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
const css=readFileSync(new URL('../web/src/style.css',import.meta.url),'utf8');
const edge=readFileSync(new URL('../worker/index.js',import.meta.url),'utf8');
const translator=readFileSync(new URL('../worker/document-translation.js',import.meta.url),'utf8');

test('usage API reads real JST D1 translator budget under the existing authenticated route',()=>{
 const auth=edge.indexOf('const p=await requireSession(request,env)');
 const route=edge.indexOf("if(method==='GET'&&path==='/api/usage')");
 assert.ok(auth>=0&&route>auth);
 assert.match(edge,/documentTranslationBudgetUsage\(env\.DB\)/);
 assert.match(edge,/translation_jst_day:translationUsage/);
 assert.match(translator,/SELECT calls FROM document_translation_daily_budget WHERE japan_day=\?/);
 assert.match(translator,/count_type:'reserved_chunks'/);
 assert.match(translator,/scope:'document_assistant_only'/);
});
test('My services uses one compact dashboard, four metric tiles and Google quota meter',()=>{
 assert.match(ui,/class="usage-dashboard"/);
 assert.match(ui,/Google 全文翻译/);
 assert.match(ui,/usage\.translation_jst_day\?\.remaining/);
 assert.match(ui,/usage\.translation_jst_day\?\.calls/);
 assert.match(ui,/role="progressbar"/);
 assert.match(ui,/translationUsagePercent/);
 assert.equal((ui.match(/class="usage-metric"/g)||[]).length,4);
 for(const provider of ['Gemini 3.6','Workers AI 解读','Workers AI OCR','OCR.space'])
  assert.ok(ui.includes(provider));
 assert.doesNotMatch(ui,/<div class="info-note" v-if="usage">/);
});
test('quota values refresh when opening My after a translation, not only on first visit',()=>{
 assert.match(ui,/if\(tab==='mine'\)void loadUsage\(\)/);
 assert.match(ui,/async function loadUsage\(\).*?api\('\/api\/usage'\)/s);
});
test('glass quota tiles remain responsive, readable and accessible on iPhone',()=>{
 assert.match(css,/\.usage-dashboard\{/);
 assert.match(css,/backdrop-filter:var\(--glass-blur\)/);
 assert.match(css,/\.usage-metrics\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
 assert.match(css,/@media\(max-width:360px\)/);
 assert.match(css,/@media\(prefers-reduced-transparency:reduce\)/);
 assert.match(ui,/aria-valuenow="usage\.translation_jst_day\?\.calls\?\?0"/);
 assert.match(ui,/缓存命中不扣次/);
});
