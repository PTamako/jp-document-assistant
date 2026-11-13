import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../web/src/local-translate.worker.js',import.meta.url),'utf8');
const instrumented=source.replace("import * as ort from 'onnxruntime-web';",'');
function runModel(fetchImplementation){
 const messages=[];
 const self={
  location:{origin:'https://example.test'},
  postMessage(message){messages.push(message);}
 };
 const context={self,TextDecoder,URL,AbortSignal,fetch:fetchImplementation,
  ort:{env:{wasm:{}},InferenceSession:{create:async()=>{throw Error('not expected')}},Tensor:class{}},
  caches:undefined
 };
 vm.runInNewContext(instrumented,context);
 return {messages,translate:()=>self.onmessage({data:{type:'translate',text:'ご利用ありがとうございます'}})};
}

test('failed model fetch reports network-specific diagnostic without document text',async()=>{
 const model=runModel(async()=>{throw new TypeError('Failed to fetch');});
 await model.translate();
 assert.equal(model.messages.at(-1).type,'error');
 assert.equal(model.messages.at(-1).code,'download');
 assert.match(model.messages.at(-1).message,/模型下载失败/);
 assert.doesNotMatch(JSON.stringify(model.messages),/ご利用ありがとうございます/);
});
test('incomplete ONNX or tokenizer bytes do not reach inference',async()=>{
 const model=runModel(async()=>({ok:true,status:200,arrayBuffer:async()=>new ArrayBuffer(40)}));
 await model.translate();
 assert.equal(model.messages.at(-1).code,'download');
 assert.match(model.messages.at(-1).message,/模型文件不完整/);
});
test('Safari without CacheStorage can still attempt translation download',async()=>{
 let calls=0;
 const model=runModel(async()=>{
  calls++;
  return {ok:true,status:200,arrayBuffer:async()=>new ArrayBuffer(600000)};
 });
 await model.translate();
 assert.equal(calls,2);
 assert.equal(model.messages.at(-1).code,'tokenizer');
 assert.match(model.messages.at(-1).message,/分词器/);
});
test('dedicated translator loads ONNX sessions sequentially and caps decoding',()=>{
 assert.doesNotMatch(source,/Promise\.all\(\[\s*fetchModel/);
 assert.match(source,/encoder=await ort\.InferenceSession\.create\(encoderBytes,options\)/);
 assert.match(source,/decoderSession=await ort\.InferenceSession\.create\(decoderBytes,options\)/);
 assert.match(source,/encoderBytes=null;/);
 assert.match(source,/decoderBytes=null;/);
 assert.match(source,/MAX_OUTPUT_TOKENS=64/);
 assert.match(source,/ort\.env\.wasm\.numThreads=1/);
});
