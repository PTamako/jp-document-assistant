import test from 'node:test';
import assert from 'node:assert/strict';
import {serveLocalTranslationModel} from '../worker/local-translate-model.js';

const makeRequest=(method='GET')=>new Request('https://app.example.test/api/local-translation/models/source.spm',{method});
test('model relay uses pinned fixed public origin and streams bytes without buffering',async()=>{
 const prev=globalThis.fetch;
 let upstreamUrl='';
 let readCount=0;
 globalThis.fetch=async url=>{
  upstreamUrl=String(url);
  const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1,2,3]));controller.close();}});
  return new Response(stream,{headers:{'Content-Length':'1300000'}});
 };
 try{
  const response=await serveLocalTranslationModel(makeRequest(),'source.spm');
  assert.equal(response.status,200);
  assert.match(upstreamUrl,/^https:\/\/huggingface\.co\/ruozhi521\/shiyin-mt-ja-zh-onnx\/resolve\/82c2cb0\/source\.spm\?download=true$/);
  assert.equal(response.headers.get('Content-Type'),'application/octet-stream');
  assert.equal(response.headers.get('Cross-Origin-Resource-Policy'),'same-origin');
  assert.deepEqual(Array.from(new Uint8Array(await response.arrayBuffer())),[1,2,3]);
  assert.equal(readCount,0);
 }finally{globalThis.fetch=prev;}
});
test('model relay refuses unsupported filenames without network requests',async()=>{
 const prev=globalThis.fetch;globalThis.fetch=()=>{throw Error('should not fetch');};
 try{
  for(const path of ['../../private','unlisted.bin','model.json','source.spm?other']){
   const response=await serveLocalTranslationModel(makeRequest(),path);
   assert.equal(response.status,404);
  }
  const denied=await serveLocalTranslationModel(makeRequest('POST'),'encoder_model.onnx');
  assert.equal(denied.status,405);
 }finally{globalThis.fetch=prev;}
});
test('model relay refuses unexpected upstream HTTP or file size and never returns secrets',async()=>{
 const prev=globalThis.fetch;
 try{
  globalThis.fetch=async()=>new Response('not found',{status:404});
  const error=await serveLocalTranslationModel(makeRequest(),'source.spm');
  assert.equal(error.status,502);
  assert.deepEqual(await error.json(),{ok:false,code:'MODEL_HOST_ERROR'});
  globalThis.fetch=async()=>new Response('tiny',{headers:{'Content-Length':'4'}});
  const invalid=await serveLocalTranslationModel(makeRequest(),'source.spm');
  assert.equal(invalid.status,502);
  assert.deepEqual(await invalid.json(),{ok:false,code:'MODEL_SIZE_INVALID'});
  globalThis.fetch=async()=>{throw TypeError('upstream url token credentials');};
  const network=await serveLocalTranslationModel(makeRequest(),'source.spm');
  assert.equal(network.status,502);
  assert.deepEqual(await network.json(),{ok:false,code:'MODEL_HOST_UNREACHABLE'});
 }finally{globalThis.fetch=prev;}
});
