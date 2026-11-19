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
 assert.match(css,/\.field-action-row\{display:flex;align-items:center;justify-content:flex-end/);
 assert.match(fields,/class="field-action-row"/);
 assert.match(fields,/@click="amountVisible=!amountVisible"/);
});
