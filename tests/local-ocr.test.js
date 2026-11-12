import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizeOcrItems,recognizeJapaneseImage,disposeLocalOcr,PADDLE_SDK_VERSION,ORT_MODULE_PATH}
  from '../web/src/local-ocr.js';

const sample=()=>new Blob([new Uint8Array([255,216,255])],{type:'image/jpeg'});

test('Japanese OCR SDK is pinned and main PWA never evaluates PaddleOCR code',()=>{
  assert.equal(PADDLE_SDK_VERSION,'0.4.2');
  assert.equal(ORT_MODULE_PATH,'/ocr/ort-wasm-simd-threaded.jsep.mjs');
  const page=readFileSync(new URL('../web/src/local-ocr.js',import.meta.url),'utf8');
  const worker=readFileSync(new URL('../web/src/ocr-runtime.worker.js',import.meta.url),'utf8');
  assert.doesNotMatch(page,/import\(['"]@paddleocr\/paddleocr-js['"]\)/);
  assert.doesNotMatch(page,/PaddleOCR\.create/);
  assert.match(page,/new Worker\(new URL\('\.\/ocr-runtime\.worker\.js',import\.meta\.url\)/);
  assert.match(worker,/import \{PaddleOCR\} from '@paddleocr\/paddleocr-js'/);
  // The SDK's worker:false image pipeline needs document.createElement,
  // which does not exist in an isolated Worker (Safari: Can't find variable: document).
  assert.match(worker,/worker:true/);
  assert.doesNotMatch(worker,/PaddleOCR\.create\([^\n]*worker:false/);
  assert.match(worker,/PP-OCRv6/);
  assert.match(worker,/@1\.31\.1\/dist\//);
  assert.match(worker,/new URL\('\/ocr\/ort-wasm-simd-threaded\.jsep\.mjs'/);
});
test('recognition results from isolated worker stay unverified and preserve confidence',async()=>{
  const normalized=normalizeOcrItems([{items:[
    {text:'納付期限',score:0.93},{text:'11月30日',score:0.54},{text:'  ',score:0.98}
  ]}]);
  assert.equal(normalized.text,'納付期限\n11月30日');
  assert.equal(normalized.low_confidence_lines,1);
  let posted,terminated=false;
  const mocked={
    postMessage(data){
      posted=data;
      queueMicrotask(()=>this.onmessage({data:{
        id:data.id,ok:true,items:[{text:'ご確認ください',score:0.93}]
      }}));
    },
    terminate(){terminated=true;}
  };
  const result=await recognizeJapaneseImage(sample(),{createWorker:()=>mocked,timeoutMs:500});
  assert.equal(posted.action,'recognize');
  assert.equal(posted.file.type,'image/jpeg');
  assert.equal(result.text,'ご確認ください');
  assert.equal(result.needs_review,true);
  disposeLocalOcr();
  assert.equal(terminated,true);
});
test('worker failures terminate the instance and permit a later retry',async()=>{
  let terminated=false;
  const broken={
    postMessage(){queueMicrotask(()=>this.onerror({preventDefault(){}}));},
    terminate(){terminated=true;}
  };
  await assert.rejects(
    recognizeJapaneseImage(sample(),{createWorker:()=>broken,timeoutMs:500}),
    /隔离 OCR 工作线程加载失败/
  );
  assert.equal(terminated,true);
  const next={
    postMessage(data){queueMicrotask(()=>this.onmessage({data:{id:data.id,ok:true,items:[{text:'再試行',score:0.9}]}}));},
    terminate(){}
  };
  try{
    const result=await recognizeJapaneseImage(sample(),{createWorker:()=>next,timeoutMs:500});
    assert.equal(result.text,'再試行');
  }finally{disposeLocalOcr();}
});
test('unsupported source MIME is rejected without creating a Worker',async()=>{
  await assert.rejects(recognizeJapaneseImage(new Blob(['x'],{type:'text/plain'})),/仅接受 JPEG/);
});
