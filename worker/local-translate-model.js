// Public model weights only. No document text ever passes through this endpoint.
// The fixed-model relay avoids iOS PWA CORS/CSP blocks on Hugging Face Xet
// redirects. Large responses are streamed, not buffered into Worker memory.
const MODEL_REVISION='82c2cb0';
const MODEL_ORIGIN='https://huggingface.co/ruozhi521/shiyin-mt-ja-zh-onnx/resolve/'+MODEL_REVISION+'/';
const ALLOWED_MODEL_FILES=Object.freeze({
  'source.spm':{min:500000,max:3000000},
  'target.spm':{min:500000,max:3000000},
  'encoder_model.onnx':{min:50000000,max:160000000},
  'decoder_model.onnx':{min:50000000,max:160000000}
});
const fail=(code,status)=>new Response(JSON.stringify({ok:false,code}),{
  status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}
});
export async function serveLocalTranslationModel(request,filename){
  if(request.method!=='GET')return fail('METHOD_NOT_ALLOWED',405);
  // No caller-provided URL, revision, domain, or arbitrary filename.
  if(!Object.hasOwn(ALLOWED_MODEL_FILES,filename))return fail('MODEL_NOT_FOUND',404);
  let upstream;
  try{
    upstream=await fetch(MODEL_ORIGIN+filename+'?download=true',{
      method:'GET',redirect:'follow',
      headers:{Accept:'application/octet-stream'},
      signal:typeof AbortSignal.timeout==='function'?AbortSignal.timeout(600000):undefined
    });
  }catch{
    return fail('MODEL_HOST_UNREACHABLE',502);
  }
  if(!upstream.ok||!upstream.body){
    try{await upstream.body?.cancel();}catch{}
    return fail('MODEL_HOST_ERROR',502);
  }
  const length=Number(upstream.headers.get('content-length'));
  const bounds=ALLOWED_MODEL_FILES[filename];
  if(Number.isFinite(length)&&length>0&&(length<bounds.min||length>bounds.max)){
    try{await upstream.body.cancel();}catch{}
    return fail('MODEL_SIZE_INVALID',502);
  }
  // Never use .arrayBuffer()/.blob() on 100MB+ weights; Workers have 128MB RAM.
  const headers=new Headers({
    'Content-Type':'application/octet-stream',
    'Cache-Control':'private, max-age=86400',
    'X-Content-Type-Options':'nosniff',
    'Cross-Origin-Resource-Policy':'same-origin'
  });
  if(Number.isSafeInteger(length)&&length>0)headers.set('Content-Length',String(length));
  return new Response(upstream.body,{status:200,headers});
}
