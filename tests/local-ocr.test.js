import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOcrItems,recognizeJapaneseImage,PADDLE_SDK_VERSION} from '../web/src/local-ocr.js';
test('Paddle model version is pinned and Japanese text stays unverified',async()=>{
 assert.equal(PADDLE_SDK_VERSION,'0.4.2');
 const normalized=normalizeOcrItems([{items:[
  {text:'納付期限',score:0.93},{text:'11月30日',score:0.54},{text:'  ',score:0.98}
 ]}]);
 assert.equal(normalized.text,'納付期限\n11月30日');
 assert.equal(normalized.low_confidence_lines,1);
 let options;
 const fake={PaddleOCR:{create:async o=>{options=o;return {predict:async()=>[{items:[{text:'ご確認ください',score:0.93}]}]};}}};
 const result=await recognizeJapaneseImage(new Blob([new Uint8Array([255,216,255])],{type:'image/jpeg'}),{loadSdk:async()=>fake});
 assert.equal(options.lang,'japan');
 assert.equal(options.ocrVersion,'PP-OCRv6');
 assert.match(options.ortOptions.wasmPaths.wasm,/@1\.31\.1\/dist\//);
 assert.match(options.ortOptions.wasmPaths.mjs,/\/ocr\/ort-wasm-simd-threaded\.jsep\.mjs$/);
 assert.doesNotMatch(options.ortOptions.wasmPaths.mjs,/cdn\.jsdelivr/);
 assert.equal(result.needs_review,true);
});
