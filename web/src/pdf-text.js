// Lazy-loaded PDF.js: PDF parsing uses the *local* text layer, never an AI call.
// Browser worker URL is packaged as a version-matched same-origin Vite asset.
export async function extractPdfText(file,{maxPages=30,maxChars=100000,ocrPage=null,maxOcrPages=10,onProgress=null}={}){
  if(file.size>8*1024*1024||!file.size)throw Error('PDF 文件必须在 8MB 以内');
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(new TextDecoder().decode(bytes.subarray(0,5))!=='%PDF-')throw Error('PDF 文件签名无效');
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
  if(typeof window!=='undefined'){
    const worker=await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc=worker.default;
  }
  const task=pdfjs.getDocument({data:bytes,disableAutoFetch:true,disableStream:true,
    stopAtErrors:true,isEvalSupported:false,useSystemFonts:true,disableFontFace:true});
  let document;
  try{
    document=await task.promise;
    if(document.numPages>maxPages)throw Error(`PDF 超过 ${maxPages} 页，请先拆分文档再导入`);
    const pages=[],empty=[],ocrFailed=[];let ocrCount=0;
    for(let pageNumber=1;pageNumber<=document.numPages;pageNumber++){
      const page=await document.getPage(pageNumber);
      try{
        const content=await page.getTextContent();let result='',y=null;
        for(const item of content.items){
          if(typeof item.str!=='string')continue;
          const curY=item.transform?.[5];
          if(y!==null&&Number.isFinite(curY)&&Math.abs(y-curY)>3)result+='\n';
          result+=item.str;
          if(item.hasEOL)result+='\n';
          if(Number.isFinite(curY))y=curY;
          if(result.length+pages.reduce((n,s)=>n+s.length,0)>maxChars)throw Error('PDF 文字超过 10 万字符，请拆分导入');
        }
        result=result.trim();
        if(!result && typeof ocrPage==='function' && ocrCount<maxOcrPages){
          ocrCount++;
          try {
            onProgress?.(`扫描第 ${pageNumber}/${document.numPages} 页，正在本机识别日文…`);
            // Limit raster memory on iPhone: roughly 1800px width, <= 3 MP.
            const base=page.getViewport({scale:1});
            const scale=Math.min(2.5,1800/base.width,Math.sqrt(3000000/(base.width*base.height)));
            const viewport=page.getViewport({scale:Math.max(0.25,scale)});
            if(typeof window==='undefined'||!window.document)throw Error('仅浏览器支持扫描页渲染');
            const canvas=window.document.createElement('canvas');
            canvas.width=Math.round(viewport.width);canvas.height=Math.round(viewport.height);
            try{
              await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
              const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.92));
              if(!blob)throw Error('无法将扫描页转换成图片');
              result=String((await ocrPage(blob,pageNumber))?.text||'').trim();
            }finally{canvas.width=0;canvas.height=0;}
          }catch(e){ocrFailed.push({page:pageNumber,reason:String(e?.message||'识别失败').slice(0,120)});}
        }
        if(result)pages.push(`【PDF 第 ${pageNumber} 页】\n${result}`);
        else empty.push(pageNumber);
      }finally{page.cleanup();}
    }
    return {kind:'pdf',title:file.name.replace(/\.[^.]+$/,''),source_type:'local_file',
      text:pages.join('\n\n'),pages_read:document.numPages,needs_manual:pages.length===0,
      pages_without_text:empty,ocr_pages_attempted:ocrCount,ocr_failed:ocrFailed,
      warning:empty.length?`第 ${empty.join('、')} 页仍未识别出文字；请检查清晰度或手动补充。`:(ocrCount?'扫描页已使用本机 OCR，内容仍须逐项核对原件。':'已提取 PDF 文字层，金额、日期和版面应核对原件。')};
  }finally{
    try{if(document)await document.destroy();else await task.destroy();}catch{}
  }
}
