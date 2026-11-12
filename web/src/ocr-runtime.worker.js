// OCR SDK/OpenCV must never be evaluated in the main application CSP.
// This module Worker has a separate, path-scoped CSP at the Cloudflare edge.
// The images stay on this device; only model/runtime files are downloaded.
import {PaddleOCR} from '@paddleocr/paddleocr-js';

const ORT_WASM_BASE='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
const wasmPaths={
  wasm:ORT_WASM_BASE+'ort-wasm-simd-threaded.jsep.wasm',
  mjs:new URL('/ocr/ort-wasm-simd-threaded.jsep.mjs',self.location.origin).href
};
let enginePromise=null;
function getEngine(){
  if(!enginePromise){
    // The SDK's worker:false path calls document.createElement('canvas')
    // during input conversion. Workers do not expose document. Use the SDK's
    // official worker:true pipeline, which converts input via ImageBitmap and
    // reconstructs it with OffscreenCanvas in its own nested worker.
    // Both workers are same-origin and have path-restricted OCR CSP.
    enginePromise=PaddleOCR.create({lang:'japan',ocrVersion:'PP-OCRv6',worker:true,
      ortOptions:{backend:'wasm',numThreads:1,wasmPaths,proxy:false}})
      .catch(error=>{enginePromise=null;throw error;});
  }
  return enginePromise;
}
self.onmessage=async event=>{
  const message=event.data||{};
  if(message.action!=='recognize'||!Number.isSafeInteger(message.id))return;
  try{
    const file=message.file;
    if(!(file instanceof Blob)||file.size===0||file.size>8*1024*1024||
      !/^image\/(?:jpeg|png|webp)$/.test(file.type)){
      throw new Error('图片格式或大小无效');
    }
    const engine=await getEngine();
    const result=await engine.predict(file);
    const lines=Array.isArray(result?.[0]?.items)?result[0].items:[];
    self.postMessage({id:message.id,ok:true,items:lines.map(x=>({
      text:typeof x.text==='string'?x.text:'',
      score:typeof x.score==='number'?x.score:null
    }))});
  }catch(error){
    self.postMessage({id:message.id,ok:false,error:String(error?.message||error).slice(0,240)});
  }
};
