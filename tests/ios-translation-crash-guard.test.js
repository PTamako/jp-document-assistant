import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isMemoryConstrainedIosWebKit,deleteOldLocalTranslationWeights} from '../web/src/local-translation-support.js';

test('iPhone Safari and home-screen PWA must never start >200MB local ONNX translator',()=>{
 for(const ua of [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
  'Mozilla/5.0 (iPad; CPU OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
 ]){
  assert.equal(isMemoryConstrainedIosWebKit({userAgent:ua,platform:'iPhone',maxTouchPoints:5}),true);
 }
 assert.equal(isMemoryConstrainedIosWebKit({userAgent:'Mozilla/5.0 (Macintosh)',platform:'MacIntel',maxTouchPoints:5}),true);
});
test('normal laptop and Android retain opt-in local model control',()=>{
 assert.equal(isMemoryConstrainedIosWebKit({userAgent:'Mozilla/5.0 (Macintosh)',platform:'MacIntel',maxTouchPoints:0}),false);
 assert.equal(isMemoryConstrainedIosWebKit({userAgent:'Mozilla/5.0 (Linux; Android 15)',platform:'Linux armv8l',maxTouchPoints:5}),false);
 assert.equal(isMemoryConstrainedIosWebKit(null),false);
});
test('only public translation model caches are removed, never user document data',async()=>{
 const names=[];
 await deleteOldLocalTranslationWeights({async delete(name){names.push(name);return true;}});
 assert.deepEqual(names.sort(),['jda-ja-zh-mt-v1','jda-ja-zh-mt-v2','jda-ja-zh-mt-v3']);
 await assert.doesNotReject(deleteOldLocalTranslationWeights({async delete(){throw Error('Safari disabled CacheStorage')}}));
 await assert.doesNotReject(deleteOldLocalTranslationWeights(null));
});
test('on-device crash guard executes before Worker creation',()=>{
 const ui=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
 const start=ui.indexOf('function translateOriginal(){');
 const worker=ui.indexOf("new Worker(new URL('./local-translate.worker.js'",start);
 const guard=ui.indexOf('if(localTranslationBlocked){',start);
 assert.ok(start>=0&&guard>start&&worker>guard,'guard must run before creating Worker');
 assert.match(ui,/:disabled="translationBusy \|\| localTranslationBlocked"/);
 assert.match(ui,/onMounted\(async\(\)=>\{\s*if\(localTranslationBlocked\)void deleteOldLocalTranslationWeights\(\)/);
 assert.match(ui,/中文解释正常使用/);
});
