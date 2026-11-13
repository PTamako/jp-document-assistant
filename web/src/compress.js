// Browser-only temporary image compression for private R2 uploads.
// The original remains in Photos/Files; no image bytes go to CacheStorage,
// localStorage, IndexedDB, the service worker, or any persistent phone storage.
// Preserve document text by refusing to trade legibility for a strict 300KB cap.
const TARGET_BYTES=300*1024;
const MAX_BYTES=900*1024;
const LONG_EDGES=[2600,2200,1900,1700];
const QUALITIES=[0.88,0.82];
const SUPPORTED=/^image\/(?:jpeg|png|webp)$/;

function optimizedFile(blob,source){
 const extension=blob.type==='image/webp'?'webp':'jpg';
 const stem=String(source.name||'document').replace(/\.[^.]+$/,'')||'document';
 return new File([blob],stem+'.'+extension,{type:blob.type,lastModified:Date.now()});
}
function toImageBlob(canvas,type,quality){
 return new Promise(resolve=>canvas.toBlob(blob=>resolve(blob),type,quality));
}

/** 300 KiB is a *target*, not an excuse to blur receipts.
 *  With detail-friendly quality >= .82 and long side >= 1700px:
 *  - return the first high-fidelity <=300 KiB image
 *  - otherwise retain the best-detail <=900 KiB version
 *  - PDF/other formats are returned untouched
 *  No object URL or persistent storage is used.
 */
export async function compressImage(file){
 if(!file||!SUPPORTED.test(file.type))return file;
 if(file.size<=TARGET_BYTES)return file;
 let bitmap;
 try{bitmap=await createImageBitmap(file);}
 catch{
  if(file.size<=MAX_BYTES)return file;
  throw new Error('无法在当前浏览器压缩图片，请改用 JPEG 或 PDF 原件');
 }
 let canvas=null;
 try{
  if(!bitmap?.width||!bitmap?.height)throw new Error('图片尺寸无效');
  canvas=document.createElement('canvas');
  const context=canvas.getContext('2d',{alpha:false});
  if(!context)throw new Error('当前浏览器无法压缩图片');
  const longest=Math.max(bitmap.width,bitmap.height);
  let lastDimension=0,backup=null;
  let mime='image/webp';
  for(const maxDimension of LONG_EDGES){
   const dimension=Math.min(longest,maxDimension);
   if(dimension===lastDimension)continue;
   lastDimension=dimension;
   const ratio=dimension/longest;
   canvas.width=Math.max(1,Math.round(bitmap.width*ratio));
   canvas.height=Math.max(1,Math.round(bitmap.height*ratio));
   context.fillStyle='#fff';
   context.fillRect(0,0,canvas.width,canvas.height);
   context.drawImage(bitmap,0,0,canvas.width,canvas.height);
   for(const quality of QUALITIES){
    let blob=await toImageBlob(canvas,mime,quality);
    // Older Safari versions can silently export PNG instead of WebP.
    if(mime==='image/webp'&&blob?.type!=='image/webp'){
     mime='image/jpeg';
     blob=await toImageBlob(canvas,mime,quality);
    }
    if(!blob||!['image/webp','image/jpeg'].includes(blob.type)||blob.size<100)
     continue;
    if(blob.size>=file.size)continue;
    if(blob.size<=TARGET_BYTES)return optimizedFile(blob,file);
    // Retain the first fallback: best resolution then highest quality.
    if(blob.size<=MAX_BYTES&&!backup)backup=blob;
   }
  }
  if(backup)return optimizedFile(backup,file);
  if(file.size<=MAX_BYTES)return file;
  // Do not destroy fine print by encoding at tiny dimensions/low quality.
  throw new Error('为保留票据文字清晰度，无法将图片压到 900KB；请拆分图片或以 PDF 原件导入');
 }finally{
  if(canvas){canvas.width=0;canvas.height=0;}
  bitmap.close?.();
 }
}
