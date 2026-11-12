// A one-page JPEG for the explicitly authorized OCR.space fallback.
// Decode, strip metadata and compress entirely on the device. Never upload
// anything from this helper; the caller handles consent and the network request.
export async function renderImageOcrPreview(file,{maxBytes=900*1024,maxDimension=1900}={}){
  if(!file||!/^image\/(?:jpeg|png|webp)$/.test(file.type))
    throw new Error('备用 OCR 仅支持 JPEG、PNG、WebP 图片');
  if(!Number.isFinite(maxBytes)||maxBytes<100||!Number.isFinite(maxDimension)||maxDimension<200)
    throw new Error('备用 OCR 图片压缩参数无效');
  let decoded;
  try{
    decoded=await createImageBitmap(file);
  }catch{
    throw new Error('无法解码所选图片，请尝试另存为 JPEG 后重新导入');
  }
  try{
    if(!decoded.width||!decoded.height)throw new Error('图片尺寸无效');
    const canvas=document.createElement('canvas');
    const context=canvas.getContext('2d');
    if(!context)throw new Error('iPhone 当前无法使用图片压缩功能');
    const dimensionSteps=[maxDimension,1600,1300,1050,850];
    for(const limit of dimensionSteps){
      const ratio=Math.min(1,limit/Math.max(decoded.width,decoded.height));
      canvas.width=Math.max(1,Math.round(decoded.width*ratio));
      canvas.height=Math.max(1,Math.round(decoded.height*ratio));
      context.fillStyle='#fff';
      context.fillRect(0,0,canvas.width,canvas.height);
      context.drawImage(decoded,0,0,canvas.width,canvas.height);
      for(const quality of [0.9,0.78,0.65,0.5,0.35]){
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
        if(blob?.type==='image/jpeg'&&blob.size>=100&&blob.size<=maxBytes)
          return {blob,width:canvas.width,height:canvas.height};
      }
    }
    throw new Error('图片过于复杂，无法压缩到备用 OCR 的 900KB 限制');
  }finally{
    decoded.close?.();
  }
}
