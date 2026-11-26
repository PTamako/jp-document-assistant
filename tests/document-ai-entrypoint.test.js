import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const app=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
const css=readFileSync(new URL('../web/src/style.css',import.meta.url),'utf8');
const section=(start,end)=>{
 const i=app.indexOf(start),j=app.indexOf(end,i+start.length);
 assert.ok(i>=0&&j>i,`missing section boundary: ${start}`);
 return app.slice(i,j);
};
const explanation=section('<section v-if="detailTab===\'explain\'">','<section v-if="detailTab===\'finance\'">');
const fields=section('<section v-if="detailTab===\'finance\'">','<section v-if="detailTab===\'tasks\'">');
const original=section('<section v-if="detailTab===\'original\'">','\n    </div>\n  </div>\n\n  <div v-if="sheet"');

test('AI inference has one explicit entry on Chinese explanation, not in the OCR original',()=>{
 assert.equal((app.match(/@click="runAiForCurrent"/g)||[]).length,1);
 assert.match(explanation,/@click="runAiForCurrent"/);
 assert.match(explanation,/AI 解读/);
 assert.doesNotMatch(original,/AI 解读|showAiExplanation|runAiForCurrent/);
 assert.doesNotMatch(app,/function showAiExplanation/);
 assert.match(original,/翻译全文/);
 assert.match(original,/@click="editText"/);
});

test('an existing AI result or pending job does not offer another inference action',()=>{
 assert.match(explanation,/!aiResultReady\(current\)/);
 assert.match(explanation,/!isAiJobPending\(current\.ai_job\)/);
 assert.match(explanation,/重试 AI 解读/);
 assert.match(app,/async function runAiForCurrent\(\)/);
 assert.match(app,/\/ai\/analyze/);
});

test('rule-based re-extraction is named and displayed only on the field tab',()=>{
 assert.equal((app.match(/@click="refreshInterpretation"/g)||[]).length,1);
 assert.doesNotMatch(explanation,/重新解析|重新提取字段|@click="refreshInterpretation"/);
 assert.match(fields,/@click="refreshInterpretation"/);
 assert.match(fields,/重新提取字段/);
 assert.match(fields,/:disabled="busy\|\|!current\.extracted_text_ja"/);
 assert.match(app,/\x60\/api\/documents\/\$\{id\}\/reinterpret\x60/);
 assert.match(css,/\.field-toolbar\{display:flex;align-items:center;justify-content:space-between/);
 assert.match(fields,/class="field-toolbar"/);
 assert.match(fields,/<h3>提取字段<\/h3>/);
 assert.equal((fields.match(/class="field-icon-action/g)||[]).length,2);
 assert.match(fields,/@click="amountVisible=!amountVisible"/);
 assert.match(fields,/:aria-label="amountVisible\?'隐藏金额':'显示金额'"/);
 assert.match(fields,/aria-label="重新提取字段"/);
 assert.match(css,/width:44px;height:44px;min-width:44px;min-height:44px/);
});

// Regression: the slow Workers AI call must never start in an HTTP waitUntil.
test('Workers AI background jobs are claimed by the five-minute Cron and capped',()=>{
 const entry=readFileSync(new URL('../worker/index.js',import.meta.url),'utf8');
 const jobs=readFileSync(new URL('../worker/ai-jobs.js',import.meta.url),'utf8');
 const config=readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8');
 assert.match(entry,/result\.ai_status==='queued'&&doc\.ai_provider==='gemini'&&ctx\?\.waitUntil/);
 assert.match(jobs,/const WORKERS_AI_TIMEOUT_MS=100000/);
 assert.match(jobs,/boundedAnalysis\(env,doc,job\.provider\)/);
 assert.match(jobs,/failure_code:status/);
 assert.match(config,/"crons": \["\*\/5 \* \* \* \*"\]/);
});
