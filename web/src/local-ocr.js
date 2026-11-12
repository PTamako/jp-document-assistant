// Optional browser-only Japanese OCR. Never uploads document pixels.
// Pin the SDK version; deployment must audit third-party runtime script and
// first-load model downloads before approving this path for private documents.
export const PADDLE_SDK_VERSION='0.4.2';
export const ORT_WASM_VERSION='1.31.1';
const ORT_WASM_BASE='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
// Only the WASM binary is remote. JS/OCR runtime remains same-origin and
// cannot upload any scanned document images to the CDN.
// Official PaddleOCR SDK/ONNX Runtime expects a WASM asset URL PREFIX,
 // not {wasm: url}. The previous object left the runtime unable to resolve
 // its required binaries on iOS Safari.
const wasmPaths=ORT_WASM_BASE;
let enginePromise;
export function normalizeOcrItems(results){
  const items=Array.isArray(results?.[0]?.items)?results[0].items:[];
  const good=items.filter(x=>typeof x.text==='string'&&x.text.trim())
    .slice(0,2000).map(x=>({text:x.text.trim(),score:typeof x.score==='number'?x.score:null}));
  return {text:good.map(x=>x.text).join('\n').slice(0,100000),
    line_count:good.length,low_confidence_lines:good.filter(x=>x.score!==null&&x.score<0.7).length};
}
export async function recognizeJapaneseImage(file,{loadSdk}={}){
  if(!file||file.size===0||file.size>8*1024*1024)throw Error('OCR 图片必须在 8MB 以内');
  if(!/^image\/(?:jpeg|png|webp)$/.test(file.type))throw Error('本地 OCR 仅接受 JPEG、PNG、WebP');
  if(!enginePromise){
    enginePromise=(async()=>{
      const loader=loadSdk||(()=>import('@paddleocr/paddleocr-js'));
      let sdk;
      try{sdk=await loader();}catch(e){throw Error('加载本机 PaddleOCR 运行代码失败：'+String(e?.message||e).slice(0,100));}
      const {PaddleOCR}=sdk;
      if(!PaddleOCR||typeof PaddleOCR.create!=='function')throw Error('PaddleOCR SDK 不可用');
      try{
        return await PaddleOCR.create({lang:'japan',ocrVersion:'PP-OCRv6',
          ortOptions:{backend:'wasm',numThreads:1,wasmPaths}});
      }catch(e){throw Error('加载日文模型或 ONNX WASM 失败（请检查网络、Safari 内存）：'+String(e?.message||e).slice(0,140));}
    })().catch(error=>{enginePromise=null;throw error;});
  }
  const engine=await enginePromise;
  let results;
  try{results=await engine.predict(file);}
  catch(e){throw Error('PaddleOCR 图片推理失败：'+String(e?.message||e).slice(0,140));}
  const parsed=normalizeOcrItems(results);
  if(!parsed.text)throw Error('未识别出可用文字；请换清晰图片或手动补充');
  return {...parsed,engine:'PaddleOCR PP-OCRv6 Small',needs_review:true};
}
