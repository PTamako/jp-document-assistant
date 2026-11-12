import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const app=read('web/src/App.vue');
const ai=read('worker/intelligence.js');
const backend=read('worker/index.js');

test('OCR and Gemini UI uses short, clear consent without long explanatory paragraphs',()=>{
 assert.match(app,/同意发送所选/);
 assert.match(app,/同意将本份文书发送至 Gemini（可能产生费用）/);
 assert.match(app,/@click="openChoice\('importOcrEngine'\)"/);
 assert.doesNotMatch(app,/本机 PaddleOCR 失败时可手动使用备用 OCR/);
 assert.doesNotMatch(app,/我确认这份文书不含个人或机密资料/);
 assert.doesNotMatch(app,/使用 iPhone「文件」/);
 assert.match(app,/function shortMessage\(value,limit=110\)/);
 assert.match(app,/shortMessage\(err\?\.message\|\|err,140\)/);
});

test('Gemini user-controlled choice does not check local free-only, PII or app quota',()=>{
 assert.match(ai,/if\(provider==='gemini'\)return env\.GEMINI_API_KEY\?'ready':'not_configured'/);
 assert.doesNotMatch(ai,/GEMINI_FREE_ONLY_CONFIRMED/);
 assert.doesNotMatch(backend,/SENSITIVE_GEMINI_BLOCKED/);
 assert.doesNotMatch(ai,/doc\.ai_consent_at\|\|sensitive/);
 assert.match(ai,/if\(provider==='cloudflare'\)\{/);
 assert.match(ai,/if\(provider==='gemini'&&!doc\.ai_consent_at\)/);
 assert.match(backend,/selected==='gemini'&&geminiConsent!==true/);
});
