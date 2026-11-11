// The original stays in the iOS photo library; only this transient File is uploaded.
export async function compressImage(file) {
  if (!file.type.startsWith('image/')) return file;
  let bitmap;
  try { bitmap=await createImageBitmap(file); }
  catch { return file; } // Safari/HEIC unsupported decoding: original requires backend type check.
  try {
    const longest=Math.max(bitmap.width,bitmap.height);
    const ratio=Math.min(1,2600/longest);
    const width=Math.max(1,Math.round(bitmap.width*ratio));
    const height=Math.max(1,Math.round(bitmap.height*ratio));
    const canvas=document.createElement('canvas'); canvas.width=width;canvas.height=height;
    canvas.getContext('2d',{alpha:false}).drawImage(bitmap,0,0,width,height);
    const target=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',0.88));
    canvas.width=0;canvas.height=0;
    if(!target||target.size>=file.size||target.size<10000)return file;
    return new File([target],`${file.name.replace(/\.[^.]+$/,'')}.webp`,{type:target.type,lastModified:Date.now()});
  } finally { bitmap.close(); }
}
