// Dedicated, opt-in local Japanese → Simplified Chinese machine translation.
// No document text is ever uploaded: network requests download public model weights only.
// The ONNX weights are a 77.5M-parameter OPUS-MT Japanese-Chinese translation model.
// We run a single-threaded WASM model and terminate this worker after each request.
import * as ort from 'onnxruntime-web';

const MODEL_BASE='https://huggingface.co/ruozhi521/shiyin-mt-ja-zh-onnx/resolve/82c2cb0/';
const WASM_BASE='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
const MODEL_LIMIT=8000;
const MAX_SEGMENT_CHARS=145;
const MAX_OUTPUT_TOKENS=64;
const decoder=new TextDecoder();
const fail=message=>{throw Error(message);};

ort.env.wasm.numThreads=1;
ort.env.wasm.proxy=false;
ort.env.wasm.wasmPaths={
 wasm:WASM_BASE+'ort-wasm-simd-threaded.jsep.wasm',
 mjs:new URL('/ocr/ort-wasm-simd-threaded.jsep.mjs',self.location.origin).href
};

// A minimal SentencePiece Unigram reader, preserving original piece ids.
// Protobuf ModelProto.pieces is field 1; SentencePiece.piece/score/type are 1/2/3.
function readVarint(bytes,pos){
 let n=0,shift=0;
 while(true){
  if(pos.i>=bytes.length||shift>49)fail('分词器格式损坏');
  const b=bytes[pos.i++];
  n+=(b&127)*2**shift;
  if(!(b&128))return n;
  shift+=7;
 }
}
function skip(bytes,pos,wire){
 if(wire===0)readVarint(bytes,pos);
 else if(wire===1)pos.i+=8;
 else if(wire===5)pos.i+=4;
 else if(wire===2)pos.i+=readVarint(bytes,pos);
 else fail('不支持的分词器格式');
 if(pos.i>bytes.length)fail('分词器格式损坏');
}
function parsePiece(bytes){
 const pos={i:0};let text='',score=0,type=1;
 while(pos.i<bytes.length){
  const tag=readVarint(bytes,pos),field=tag>>3,wire=tag&7;
  if(field===1&&wire===2){
   const len=readVarint(bytes,pos);text=decoder.decode(bytes.slice(pos.i,pos.i+len));pos.i+=len;
  }else if(field===2&&wire===5){
   const view=new DataView(bytes.buffer,bytes.byteOffset+pos.i,4);
   score=view.getFloat32(0,true);pos.i+=4;
  }else if(field===3&&wire===0)type=readVarint(bytes,pos);
  else skip(bytes,pos,wire);
 }
 return {text,score,type};
}
function readSentencePiece(buf){
 const bytes=new Uint8Array(buf),pos={i:0},pieces=[];
 while(pos.i<bytes.length){
  const tag=readVarint(bytes,pos),field=tag>>3,wire=tag&7;
  if(field===1&&wire===2){
   const len=readVarint(bytes,pos);
   pieces.push(parsePiece(bytes.subarray(pos.i,pos.i+len)));pos.i+=len;
  }else skip(bytes,pos,wire);
 }
 if(pieces.length<1000)fail('分词器数据不完整');
 return pieces;
}
function makeTrie(pieces){
 const root=new Map();
 for(let id=0;id<pieces.length;id++){
  const item=pieces[id];
  if(!item.text||![1,4].includes(item.type))continue;
  let node=root;
  for(const char of item.text){
   if(!node.has(char))node.set(char,new Map());
   node=node.get(char);
  }
  node.value={id,score:item.score};
 }
 return root;
}
function tokenize(text,trie){
 const normalized='▁'+text.normalize('NFKC').trim().replace(/\s+/g,' ').replace(/ /g,'▁');
 const chars=Array.from(normalized),n=chars.length;
 const best=Array(n+1).fill(-Infinity),back=Array(n+1);
 best[0]=0;
 for(let i=0;i<n;i++){
  if(!Number.isFinite(best[i]))continue;
  let node=trie;
  for(let j=i;j<n&&j-i<32;j++){
   node=node.get(chars[j]);if(!node)break;
   if(node.value&&best[i]+node.value.score>best[j+1]){
    best[j+1]=best[i]+node.value.score;back[j+1]={prev:i,id:node.value.id};
   }
  }
  if(best[i]-20>best[i+1]){
   best[i+1]=best[i]-20;back[i+1]={prev:i,id:1};
  }
 }
 const ids=[];let at=n,steps=0;
 while(at>0&&steps++<n+1){
  const item=back[at];if(!item)fail('文字分词失败');
  ids.push(item.id);at=item.prev;
 }
 ids.reverse();ids.push(0); // OPUS-MT needs EOS even for short text.
 return ids;
}
function detokenize(tokens,pieces){
 return tokens.map(id=>pieces[id]?.text||'').filter(s=>s!=='</s>'&&s!=='<pad>'&&s!=='<unk>')
  .join('').replace(/▁/g,' ').trim();
}
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
const MIN_BYTES={'source.spm':500000,'target.spm':500000,'encoder_model.onnx':50000000,'decoder_model.onnx':50000000};
let phase='download',phaseFile='';
const progress=(value,message)=>self.postMessage({type:'progress',progress:value,message});
const setPhase=(value,file='')=>{phase=value;phaseFile=file;};
async function fetchModel(path){
 setPhase('download',path);
 const url=MODEL_BASE+path+'?download=true';
 let cache=null,response=null;
 // CacheStorage may be disabled by iOS storage policy: fetch directly in that case.
 try{
  if(typeof caches!=='undefined'){
   cache=await caches.open('jda-ja-zh-mt-v2');
   response=await cache.match(url);
  }
 }catch{cache=null;response=null;}
 if(response&&Number(response.headers.get('content-length'))>0&&
    Number(response.headers.get('content-length'))<MIN_BYTES[path]){
  try{await cache?.delete(url);}catch{}
  response=null;
 }
 if(!response){
  try{
   response=await fetch(url,{
    mode:'cors',credentials:'omit',redirect:'follow',
    signal:typeof AbortSignal.timeout==='function'?AbortSignal.timeout(240000):undefined
   });
  }catch(error){
   const code=error?.name==='TimeoutError'?'download_timeout':'download_network';
   throw new Error(code);
  }
  if(!response.ok)throw new Error('download_http_'+response.status);
  // Cache only public weights; user-provided text never goes into this cache.
  // Keep each download sequential to avoid an over-400MB temporary memory spike.
  if(cache){
   try{
    const cloned=response.clone();
    const write=cache.put(url,cloned).catch(()=>{});
    const buffer=await response.arrayBuffer();
    await write;
    if(buffer.byteLength<MIN_BYTES[path])throw new Error('download_incomplete');
    return buffer;
   }catch(e){
    if(e?.message==='download_incomplete')throw e;
    // If Safari refuses storage, still allow ordinary one-off translation.
    if(!response.bodyUsed)return await response.arrayBuffer();
    throw new Error('download_storage_or_memory');
   }
  }
 }
 const buffer=await response.arrayBuffer();
 if(buffer.byteLength<MIN_BYTES[path]){
  try{await cache?.delete(url);}catch{}
  throw new Error('download_incomplete');
 }
 return buffer;
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
  const tgt=await fetchModel('target.spm');
  setPhase('tokenizer');
  const sourcePieces=readSentencePiece(src),targetPieces=readSentencePiece(tgt);
  const trie=makeTrie(sourcePieces);
  progress(10,'本地分词器已就绪');
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
   const ids=tokenize(segments[index],trie);
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
   results.push(detokenize(generated,targetPieces));
   progress(78+Math.round((index+1)/segments.length*22),`正在翻译 ${index+1}/${segments.length} 段`);
  }
  return results.join('\n');
 }finally{
  await Promise.allSettled([encoder,decoderSession].filter(Boolean).map(session=>session.release()));
 }
}
const failureMessage=(phase,error)=>{
 const names={
  download:'模型文件下载',tokenizer:'日中分词器解析',
  encoder_init:'日文模型初始化',decoder_init:'中文模型初始化',inference:'本机逐段翻译'
 };
 const detail=String(error?.message||'').toLowerCase();
 if(phase==='download'){
  if(detail.includes('incomplete'))return '模型文件不完整，请重新点击翻译';
  if(detail.includes('timeout'))return '下载模型超时，请在 Wi-Fi 下重试';
  if(detail.includes('storage_or_memory'))return '本机存储或内存不足，无法读取模型';
  return '模型下载失败，请检查网络后重试';
 }
 const suffix=/memory|alloc|out of bounds|out of memory/.test(detail)?
  '设备可用内存不足':'模型与此设备的运行环境可能不兼容';
 return (names[phase]||'本机翻译')+'失败：'+(phase==='tokenizer'?'模型分词器格式不匹配':suffix);
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
