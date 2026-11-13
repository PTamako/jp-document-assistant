// Fail closed before constructing the >200MB ONNX translator worker.
// iOS WebKit can terminate an entire Safari/PWA page under WASM memory
// pressure, bypassing try/catch and all worker error handlers.
export function isMemoryConstrainedIosWebKit(navigatorValue=typeof navigator==='undefined'?null:navigator){
 if(!navigatorValue)return false;
 const userAgent=String(navigatorValue.userAgent||'');
 return /iPhone|iPad|iPod/i.test(userAgent)||
  (navigatorValue.platform==='MacIntel'&&Number(navigatorValue.maxTouchPoints||0)>1);
}
const OLD_MODEL_CACHES=Object.freeze(['jda-ja-zh-mt-v1','jda-ja-zh-mt-v2','jda-ja-zh-mt-v3']);
// These cache names contain *only public weights*, not documents or OCR data.
// Ignore Safari's private-mode CacheStorage errors. Never clear other caches.
export async function deleteOldLocalTranslationWeights(cacheStorage=typeof caches==='undefined'?null:caches){
 if(!cacheStorage||typeof cacheStorage.delete!=='function')return;
 await Promise.allSettled(OLD_MODEL_CACHES.map(name=>cacheStorage.delete(name)));
}
