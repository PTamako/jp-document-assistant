// Lazy-loaded PDF.js: PDF parsing uses the *local* text layer, never an AI call.
// Browser worker URL is packaged as a version-matched same-origin Vite asset.
export async function extractPdfText(file,{maxPages=30,maxChars=100000}={}){
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
    const pages=[],empty=[];
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
        if(result)pages.push(`【PDF 第 ${pageNumber} 页】\n${result}`);
        else empty.push(pageNumber);
      }finally{page.cleanup();}
    }
    return {kind:'pdf',title:file.name.replace(/\.[^.]+$/,''),source_type:'local_file',
      text:pages.join('\n\n'),pages_read:document.numPages,needs_manual:pages.length===0,
      pages_without_text:empty,
      warning:empty.length?`第 ${empty.join('、')} 页没有可复制文字，可能是扫描页；请人工补充或单独选择 OCR，系统不会猜测缺失内容`:'已提取 PDF 文字层（非 OCR）。金额、日期和版面应核对原件'};
  }finally{
    try{if(document)await document.destroy();else await task.destroy();}catch{}
  }
}
