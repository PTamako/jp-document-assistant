import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const ui=read('web/src/App.vue'),worker=read('worker/index.js'),api=read('worker/document-translation.js');
test('detail tabs are source first and AI explanation second',()=>{
 const strip=ui.match(/v-for="t in \[([^\]]+)\]"/);
 assert.ok(strip);
 const ids=[...strip[1].matchAll(/id:'([^']+)'/g)].map(x=>x[1]);
 assert.deepEqual(ids,['original','explain','finance','tasks','study']);
 assert.match(ui,/detailTab=ref\('original'\)/);
});
test('translation is an explicit opt-in and cache check does not upload text',()=>{
 assert.match(ui,/@click="translateOriginal"/);
 assert.match(ui,/sheet==='translateConfirm'/);
 assert.match(ui,/v-model="translationConsent"/);
 assert.match(ui,/@click="confirmTranslateOriginal"/);
 assert.match(ui,/confirm_google_translation:true/);
 assert.match(ui,/api\('\/api\/documents\/\'+id\+'\/translation'\)/);
 assert.match(ui,/translationVisible&&localTranslation/);
 assert.match(ui,/Google 免费机翻/);
});
test('iPhone no longer loads heavy ONNX; signed service translation belongs to server',()=>{
 assert.doesNotMatch(ui,/new Worker\(new URL\('\.\/local-translate\.worker\.js'/);
 assert.doesNotMatch(ui,/localTranslationBlocked/);
 assert.match(worker,/handleDocumentTranslation\(request,env,doc\)/);
 assert.match(api,/ZHIXUE_BRIDGE_SERVICE/);
 assert.match(api,/ZHIXUE_BRIDGE_SECRET/);
 assert.match(api,/confirm_google_translation/);
 assert.doesNotMatch(api,/mymemory\.translated\.net|translate_a\/single|generativelanguage/);
});
