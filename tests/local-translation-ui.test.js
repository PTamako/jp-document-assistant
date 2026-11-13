import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ui=fs.readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
const translator=fs.readFileSync(new URL('../web/src/local-translate.worker.js',import.meta.url),'utf8');
const edge=fs.readFileSync(new URL('../worker/index.js',import.meta.url),'utf8');

test('detail tabs are source-first with Chinese explanation second',()=>{
 const strip=ui.match(/v-for="t in \[([^\]]+)\]"/);
 assert.ok(strip,'expected mobile tab list');
 const names=[...strip[1].matchAll(/id:'([^']+)'/g)].map(x=>x[1]);
 assert.deepEqual(names,['original','explain','finance','tasks','study']);
 assert.match(ui,/detailTab=ref\('original'\)/);
});
test('local translation only starts after the source tab translate action',()=>{
 assert.match(ui,/new Worker\(new URL\('\.\/local-translate\.worker\.js',import\.meta\.url\)/);
 assert.match(ui,/@click="translateOriginal"/);
 assert.match(ui,/@click="stopTranslation\(\)"/);
 assert.match(ui,/translationVisible&&localTranslation/);
});
test('local model never uploads document text and caps input/decoding',()=>{
 assert.match(translator,/MODEL_LIMIT=8000/);
 assert.match(translator,/MAX_OUTPUT_TOKENS=64/);
 assert.match(translator,/ort\.env\.wasm\.numThreads=1/);
 assert.match(translator,/ruozhi521\/shiyin-mt-ja-zh-onnx/);
 assert.match(translator,/worker\.postMessage|self\.postMessage/);
 assert.doesNotMatch(translator,/generativelanguage\.googleapis\.com|api\.openai\.com|translation.googleapis.com/);
 assert.match(edge,/https:\/\/huggingface\.co/);
});
