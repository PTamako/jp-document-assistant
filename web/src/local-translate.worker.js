// Dedicated, opt-in local Japanese → Simplified Chinese machine translation.
// No document text is ever uploaded: network requests download public model weights only.
// The ONNX weights are a 77.5M-parameter OPUS-MT Japanese-Chinese translation model.
// We run a single-threaded WASM model and terminate this worker after each request.
import * as ort from 'onnxruntime-web';
import {readSentencePiece,readMarianVocabulary,createMarianTokenizer,encodeMarian,decodeMarian} from './marian-tokenizer.js';

const MODEL_BASE='https://huggingface.co/ruozhi521/shiyin-mt-ja-zh-onnx/resolve/82c2cb0/';
const WASM_BASE='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
const MODEL_LIMIT=8000;
const MAX_SEGMENT_CHARS=145;
const MAX_OUTPUT_TOKENS=64;
const fail=message=>{throw Error(message);};

ort.env.wasm.numThreads=1;
ort.env.wasm.proxy=false;
ort.env.wasm.wasmPaths={
 wasm:WASM_BASE+'ort-wasm-simd-threaded.jsep.wasm',
 mjs:new URL('/ocr/ort-wasm-simd-threaded.jsep.mjs',self.location.origin).href
};

function splitText(text){
 const result=[];
 for(const para of text.split(/\n+/)){
  if(!para.trim())continue;
  const sentences=para.match(/[^。！？!？；;\n]+[。！？!？；;]?/g)||[para];
  let part='';
  for(const sentence of sentences){
   if(Array.from(part+sentence).length>MAX_SEGMENT_CHARS&&part){result.push(part.trim());part='';}
   let remaining=Array.from(sentence);
   while(remaining.length>MAX_SEGMENT_CHARS){
    result.push(remaining.splice(0,MAX_SEGMENT_CHARS).join('').trim());
   }
   part+=remaining.join('');
  }
  if(part.trim())result.push(part.trim());
 }
 return result;
}
function f16(value){
 const sign=(value&0x8000)?-1:1,exp=(value>>10)&31,mant=value&1023;
 return sign*(exp===0?mant*2**-24:exp===31?Infinity:(1+mant/1024)*2**(exp-15));
}
function nextId(tensor){
 const dims=tensor.dims||[];
 const width=dims[dims.length-1];
 if(!Number.isSafeInteger(width)||width<1000||width>100000)fail('翻译模型输出异常');
 const data=tensor.data,start=data.length-width;
 let best=-Infinity,bestId=0;
 for(let id=0;id<width;id++){
  const value=data[start+id];
  const val=tensor.type==='float16'&&data instanceof Uint16Array?f16(value):Number(value);
  if(val>best){best=val;bestId=id;}
 }
 return bestId;
}
// Diagnostics are deliberately phase-only: user document text never goes to an error logger.
const MIN_BYTES={'source.spm':500000,'target.spm':500000,'vocab.json':1000000,'encoder_model.onnx':50000000,'decoder_model.onnx':50000000};
let phase='download',phaseFile='';
const progress=(value,message)=>self.postMessage({type:'progress',progress:value,message});
const setPhase=(value,file='')=>{phase=value;phaseFile=file;};
async function fetchModel(path){
 setPhase('download',path);
 // Prefer the provider CDN to avoid Cloudflare requests when it works.
 // Xet redirects are sometimes blocked by iOS PWA CSP/CORS; then use a
 // fixed, authenticated same-origin streaming endpoint. Only file names
 // travel over this endpoint; document text never leaves the device.
 const direct=MODEL_BASE+path+'?download=true';
 const relay='/api/local-translation/models/'+path;
 let cache=null,buffer=null,failedCode='download_network';
 try{
  if(typeof caches!=='undefined')cache=await caches.open('jda-ja-zh-mt-v3');
 }catch{cache=null;}
 for(const url of [direct,relay]){
  let response=null,fromCache=false;
  if(cache){
   try{response=await cache.match(url);fromCache=!!response;}catch{/* storage disabled */}
  }
  if(!response){
   try{
    response=await fetch(url,{
     mode:'cors',credentials:url===relay?'same-origin':'omit',
     redirect:'follow',
     signal:typeof AbortSignal.timeout==='function'?AbortSignal.timeout(300000):undefined
    });
   }catch(error){
    failedCode=error?.name==='TimeoutError'?'download_timeout':'download_network';
    continue;
   }
  }
  if(!response.ok){
   failedCode=url===relay?'download_relay_http_'+response.status:'download_http_'+response.status;
   continue;
  }
  const n=Number(response.headers?.get?.('content-length')||0);
  if(n>0&&n<MIN_BYTES[path]){
   failedCode='download_incomplete';
   if(fromCache){try{await cache?.delete(url);}catch{}}
   continue;
  }
  try{
   // CacheStorage can duplicate a large transfer internally. Only attempt
   // it for model files within the browser's cache budget, never in parallel
   // with another model. If it fails, the downloaded model still works.
   const shouldCache=!fromCache&&!!cache;
   const pending=shouldCache?cache.put(url,response.clone()).catch(()=>{}):null;
   buffer=await response.arrayBuffer();
   if(pending)await pending;
   if(buffer.byteLength<MIN_BYTES[path]){
    failedCode='download_incomplete';
    try{await cache?.delete(url);}catch{}
    buffer=null;continue;
   }
   return buffer;
  }catch(e){
   failedCode='download_storage_or_memory';
   if(fromCache){try{await cache?.delete(url);}catch{}}
  }
 }
 throw new Error(failedCode);
}
async function main(text){
 const segments=splitText(text);
 if(!segments.length)fail('没有可翻译的日文内容');
 const results=[];
 let encoder=null,decoderSession=null;
 // The old implementation loaded both 100+MB ONNX buffers in parallel and
 // retained them while starting two WASM sessions; this is unsafe on iPhone.
 try{
  progress(0,'正在读取本地翻译模型（首次约 220 MB）');
  const src=await fetchModel('source.spm');
  progress(4,'正在读取模型专用词表');
  const vocabBytes=await fetchModel('vocab.json');
  setPhase('tokenizer_source');
  const sourceModel=readSentencePiece(src);
  setPhase('tokenizer_vocab');
  const vocab=readMarianVocabulary(vocabBytes);
  setPhase('tokenizer_mapping');
  const tokenizer=createMarianTokenizer(sourceModel,vocab);
  progress(10,'日中分词器和模型词表已就绪');
  progress(15,'正在下载日文模型（约 105 MB）');
  let encoderBytes=await fetchModel('encoder_model.onnx');
  setPhase('encoder_init');
  progress(40,'正在初始化日文模型');
  const options={executionProviders:['wasm'],graphOptimizationLevel:'all'};
  encoder=await ort.InferenceSession.create(encoderBytes,options);
  encoderBytes=null;
  progress(55,'日文模型已就绪，正在准备中文模型');
  progress(58,'正在下载中文模型（约 118 MB）');
  let decoderBytes=await fetchModel('decoder_model.onnx');
  setPhase('decoder_init');
  progress(73,'正在初始化中文模型');
  decoderSession=await ort.InferenceSession.create(decoderBytes,options);
  decoderBytes=null;
  progress(78,'开始逐段本地翻译');
  for(let index=0;index<segments.length;index++){
   setPhase('inference');
   const ids=encodeMarian(segments[index],tokenizer);
   const input=new ort.Tensor('int64',BigInt64Array.from(ids,BigInt),[1,ids.length]);
   const mask=new ort.Tensor('int64',BigInt64Array.from(ids,()=>1n),[1,ids.length]);
   const hidden=await encoder.run({input_ids:input,attention_mask:mask});
   const encoded=hidden[encoder.outputNames[0]];
   const generated=[];
   for(let i=0;i<MAX_OUTPUT_TOKENS;i++){
    const outputIds=[65000,...generated];
    const output=await decoderSession.run({
     input_ids:new ort.Tensor('int64',BigInt64Array.from(outputIds,BigInt),[1,outputIds.length]),
     encoder_hidden_states:encoded,encoder_attention_mask:mask
    });
    const chosen=nextId(output[decoderSession.outputNames[0]]);
    if(chosen===0)break;
    if(generated.length>8&&generated.slice(-8).every(n=>n===chosen))break;
    generated.push(chosen);
   }
   results.push(decodeMarian(generated,vocab));
   progress(78+Math.round((index+1)/segments.length*22),`正在翻译 ${index+1}/${segments.length} 段`);
  }
  return results.join('\n');
 }finally{
  await Promise.allSettled([encoder,decoderSession].filter(Boolean).map(session=>session.release()));
 }
}
const failureMessage=(phase,error)=>{
 const names={
  download:'模型文件下载',tokenizer_source:'日文分词器解析',tokenizer_vocab:'模型词表解析',tokenizer_mapping:'词表编号映射',
  encoder_init:'日文模型初始化',decoder_init:'中文模型初始化',inference:'本机逐段翻译'
 };
 const detail=String(error?.message||'').toLowerCase();
 if(phase==='download'){
  if(detail.includes('incomplete'))return '模型文件不完整，请重新点击翻译';
  if(detail.includes('timeout'))return '下载模型超时，请在 Wi-Fi 下重试';
  if(detail.includes('storage_or_memory'))return '本机存储或内存不足，无法读取模型';
  if(detail.includes('relay_http_401')||detail.includes('relay_http_403'))return '模型下载会话已过期，请重新登录文书助手';
  if(detail.includes('relay_http_502'))return '模型源站连接失败，稍后再试';
  return '模型下载失败，请检查网络后重试';
 }
 const suffix=/memory|alloc|out of bounds|out of memory/.test(detail)?
  '设备可用内存不足':'模型与此设备的运行环境可能不兼容';
 const code=String(error?.message||'');
 if(phase.startsWith('tokenizer_')){
  const known=/^(SPM_[A-Z_]+|VOCAB_[A-Z_]+|TOKENIZER_CONFIG)$/;
  return (names[phase]||'分词器')+'失败：'+
   (known.test(code)?code:'模型数据不匹配')+
   '（无需重新导入文书）';
 }
 return (names[phase]||'本机翻译')+'失败：'+suffix;
};
self.onmessage=async event=>{
 if(event.data?.type!=='translate')return;
 const {text}=event.data;
 if(typeof text!=='string'||!text.trim()||text.length>MODEL_LIMIT){
  self.postMessage({type:'error',message:'原文过长或为空（最多 8000 字）'});return;
 }
 try{
  const translation=await main(text);
  self.postMessage({type:'complete',translation});
 }catch(e){
  self.postMessage({type:'error',code:phase,modelFile:phaseFile,message:failureMessage(phase,e)});
 }
};
