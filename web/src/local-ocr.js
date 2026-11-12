// Browser-only Japanese OCR: the main PWA never imports the SDK, OpenCV
// or ONNX Runtime. Their dynamic JS runs solely in the isolated OCR Worker.
export const PADDLE_SDK_VERSION='0.4.2';
export const ORT_WASM_VERSION='1.31.1';
export const ORT_MODULE_PATH='/ocr/ort-wasm-simd-threaded.jsep.mjs';

let runtimeWorker=null;
let nextRequestId=0;
const pending=new Map();
const FIRST_LOAD_TIMEOUT_MS=120000;

export function normalizeOcrItems(results){
  const items=Array.isArray(results?.[0]?.items)?results[0].items:[];
  const good=items.filter(x=>typeof x.text==='string'&&x.text.trim())
    .slice(0,2000).map(x=>({text:x.text.trim(),score:typeof x.score==='number'?x.score:null}));
  return {text:good.map(x=>x.text).join('\n').slice(0,100000),
    line_count:good.length,low_confidence_lines:good.filter(x=>x.score!==null&&x.score<0.7).length};
}

export function disposeLocalOcr(reason='本机 OCR 已停止'){
  const running=runtimeWorker;
  runtimeWorker=null;
  try{running?.terminate();}catch{}
  for(const entry of pending.values()){
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pending.clear();
}

function ensureWorker(makeWorker){
  if(runtimeWorker)return runtimeWorker;
  const factory=makeWorker||(()=>new Worker(new URL('./ocr-runtime.worker.js',import.meta.url),{
    type:'module',name:'jp-document-local-ocr'
  }));
  try{runtimeWorker=factory();}
  catch(e){throw new Error('无法启动隔离的 OCR 工作线程：'+String(e?.message||e).slice(0,130));}
  runtimeWorker.onmessage=event=>{
    const message=event.data||{};
    const entry=pending.get(message.id);
    if(!entry)return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if(message.ok===true)entry.resolve(message.items);
    else entry.reject(new Error('本机日文模型推理或加载失败：'+String(message.error||'未知错误').slice(0,200)));
  };
  runtimeWorker.onerror=event=>{
    event.preventDefault?.();
    disposeLocalOcr('隔离 OCR 工作线程加载失败（请检查模型网络、CSP 和浏览器支持）');
  };
  runtimeWorker.onmessageerror=()=>disposeLocalOcr('OCR 工作线程返回的数据无法读取');
  return runtimeWorker;
}

export async function recognizeJapaneseImage(file,{createWorker,timeoutMs=FIRST_LOAD_TIMEOUT_MS}={}){
  if(!file||file.size===0||file.size>8*1024*1024)throw Error('OCR 图片必须在 8MB 以内');
  if(!/^image\/(?:jpeg|png|webp)$/.test(file.type))throw Error('本地 OCR 仅接受 JPEG、PNG、WebP');
  const active=ensureWorker(createWorker);
  const id=++nextRequestId;
  const items=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>disposeLocalOcr('本机 OCR 模型加载超时；可使用 OCR.space 备用入口'),timeoutMs);
    pending.set(id,{resolve,reject,timer});
    try{active.postMessage({action:'recognize',id,file});}
    catch(e){
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error('无法向本机 OCR 工作线程传递图片：'+String(e?.message||e).slice(0,120)));
    }
  });
  const parsed=normalizeOcrItems([{items}]);
  if(!parsed.text)throw Error('未识别出可用文字；请换清晰图片或使用 OCR.space 备用入口');
  return {...parsed,engine:'PaddleOCR PP-OCRv6 Small (isolated worker)',needs_review:true};
}
