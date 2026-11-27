// Lazy-loaded PDF.js: PDF parsing uses the *local* text layer, never an AI call.
// Browser worker URL is packaged as a version-matched same-origin Vite asset.
// A model or worker startup error is not a problem with a particular PDF page.
// Stop repeating expensive model initialization across the remaining pages.
export function isOcrEngineFailure(reason){
  return /(?:本机日文模型推理或加载失败|OCR 工作线程|隔离 OCR 工作线程|PaddleOCR|ONNX|WASM|no available backend|unsafe-eval|Can't find variable: document|document is not defined|模型加载超时)/i.test(String(reason||''));
}
// Pin the resource directory to the installed PDF.js version. Keep all
// character maps and standard fonts on the same origin as the application.
function pdfResourceOptions(pdfjs){
  const browser=typeof window!=='undefined';
  const root=browser?new URL('/pdf-resources/'+pdfjs.version+'/',window.location.origin).href:
    process.cwd()+'/node_modules/pdfjs-dist/';
  return {cMapUrl:root+'cmaps/',cMapPacked:true,standardFontDataUrl:root+'standard_fonts/',
    wasmUrl:root+'wasm/',iccUrl:root+'iccs/',useWorkerFetch:browser};
}
export function isUsablePdfText(text){
  const s=String(text||'').replace(/\s/g,'');
  if(!s)return false;
  const broken=(s.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd\uE000-\uF8FF]/g)||[]).length;
  return broken===0||broken/s.length<0.05;
}
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
    ...pdfResourceOptions(pdfjs),stopAtErrors:true,isEvalSupported:false,useSystemFonts:true,disableFontFace:typeof window==='undefined'});
  let document;
  try{
    document=await task.promise;
    if(document.numPages>maxPages)throw Error(`PDF 超过 ${maxPages} 页，请先拆分文档再导入`);
    const pages=[],empty=[],ocrFailed=[],textFailed=[];let ocrCount=0,ocrStoppedReason='';
    for(let pageNumber=1;pageNumber<=document.numPages;pageNumber++){
      let page;
      try{page=await document.getPage(pageNumber);}catch(e){empty.push(pageNumber);textFailed.push(pageNumber);continue;}
      try{
        let result='',y=null;
        try{
        const content=await page.getTextContent();
        for(const item of content.items){
          if(typeof item.str!=='string')continue;
          const curY=item.transform?.[5];
          if(y!==null&&Number.isFinite(curY)&&Math.abs(y-curY)>3)result+='\n';
          result+=item.str;
          if(item.hasEOL)result+='\n';
          if(Number.isFinite(curY))y=curY;
          if(result.length+pages.reduce((n,s)=>n+s.length,0)>maxChars)throw Error('PDF 文字超过 10 万字符，请拆分导入');
        }
        }catch(e){
          if(String(e?.message||'').includes('PDF 文字超过'))throw e;
          textFailed.push(pageNumber);result='';
        }
        result=result.trim();
        if(result&&!isUsablePdfText(result)){textFailed.push(pageNumber);result='';}
        // A logo or page number alone is not a successful document extraction.
        const sparse=result.replace(/\s/g,'').length<24;
        const originalText=result;
        if(sparse && result && !textFailed.includes(pageNumber))textFailed.push(pageNumber);
        if((!result || sparse) && typeof ocrPage==='function' && ocrCount<maxOcrPages && !ocrStoppedReason){
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
              const context=canvas.getContext('2d',{alpha:false});
              if(!context)throw Error('浏览器不支持 PDF 页面绘制');
              context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
              await page.render({canvasContext:context,viewport}).promise;
              const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.92));
              if(!blob)throw Error('无法将扫描页转换成图片');
              const candidate=String((await ocrPage(blob,pageNumber))?.text||'').trim();
              if(isUsablePdfText(candidate)&&candidate.length>originalText.length)result=candidate;
            }finally{canvas.width=0;canvas.height=0;}
          }catch(e){
            const reason=String(e?.message||'识别失败').slice(0,180);
            ocrFailed.push({page:pageNumber,reason});
            if(isOcrEngineFailure(reason)){
              ocrStoppedReason=reason;
              onProgress?.('本机 OCR 引擎故障，已停止重复加载；可使用 OCR.space 备用识别。');
            }
          }
        }
        if(result.length+pages.reduce((n,s)=>n+s.length,0)>maxChars)throw Error('PDF 文字超过 10 万字符，请拆分导入');
        if(sparse && result===originalText && result)empty.push(pageNumber);
        if(result)pages.push(`【PDF 第 ${pageNumber} 页】\n${result}`);
        else empty.push(pageNumber);
      }finally{page.cleanup();}
    }
    return {kind:'pdf',title:file.name.replace(/\.[^.]+$/,''),source_type:'local_file',
      text:pages.join('\n\n'),pages_read:document.numPages,needs_manual:pages.length===0||empty.length===document.numPages,
      pages_without_text:empty,text_layer_failed_pages:textFailed,ocr_pages_attempted:ocrCount,ocr_failed:ocrFailed,
      warning:empty.length?
        (`第 ${empty.join('、')} 页文字识别不完整或未识别出文字。`+(textFailed.length?'部分 PDF 文字层读取异常或乱码。':'')+
         (ocrFailed.length?('失败原因：'+ocrFailed.slice(0,2).map(x=>`第${x.page}页 ${x.reason}`).join('；')+'。'+(ocrStoppedReason?'后续扫描页已暂停本机 OCR，避免重复失败。可使用 OCR.space 备用识别。':'')):'请核对原件或使用 OCR.space 备用识别。')):
         (ocrCount?'扫描页已使用本机 OCR，内容仍须逐项核对原件。':'已提取 PDF 文字层，金额、日期和版面应核对原件。')};
  }finally{
    try{if(document)await document.destroy();else await task.destroy();}catch{}
  }
}

/** Preview ONE scanned page as a bounded JPEG for an explicitly consented
 *  OCR.space request. Original PDF is never sent by this helper.
 *  Caller must not invoke a remote OCR service until the user approves. */
export async function renderPdfOcrPreview(file,{pageNumber=1,maxBytes=900*1024}={}){
  if(!file||!file.size||file.size>8*1024*1024)throw Error('PDF 必须在 8MB 以内');
  if(!Number.isSafeInteger(pageNumber)||pageNumber<1||pageNumber>30)throw Error('页码应在 1～30');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<100000||maxBytes>1024*1024)throw Error('图片大小限制无效');
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(new TextDecoder().decode(bytes.subarray(0,5))!=='%PDF-')throw Error('PDF 文件签名无效');
  if(typeof window==='undefined'||!window.document)throw Error('仅浏览器支持扫描页图片预览');
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const worker=await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc=worker.default;
  const task=pdfjs.getDocument({data:bytes,disableAutoFetch:true,disableStream:true,...pdfResourceOptions(pdfjs),stopAtErrors:false,isEvalSupported:false,useSystemFonts:true,disableFontFace:typeof window==='undefined'});
  let doc=null;
  try{
    doc=await task.promise;
    if(pageNumber>doc.numPages)throw Error('所选页码超出 PDF 页数');
    const page=await doc.getPage(pageNumber);
    try{
      const viewportBase=page.getViewport({scale:1}),canvas=window.document.createElement('canvas');
      try{
        const toBlob=quality=>new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('无法生成扫描页图片')),'image/jpeg',quality));
        for(const limit of [1600,1300,1050,850,650]){
          const scale=Math.min(2,limit/Math.max(viewportBase.width,viewportBase.height),
            Math.sqrt(2200000/(viewportBase.width*viewportBase.height)));
          const viewport=page.getViewport({scale:Math.max(0.2,scale)});
          canvas.width=Math.max(1,Math.round(viewport.width));
          canvas.height=Math.max(1,Math.round(viewport.height));
          const context=canvas.getContext('2d',{alpha:false});
          if(!context)throw Error('当前浏览器不支持 PDF 图片转换');
          context.fillStyle='#ffffff';context.fillRect(0,0,canvas.width,canvas.height);
          await page.render({canvasContext:context,viewport}).promise;
          for(const quality of [0.88,0.76,0.62]){
            const blob=await toBlob(quality);
            if(blob.size<=maxBytes)return {blob,pageNumber,pages_read:doc.numPages};
          }
        }
        throw Error('扫描页图片压缩后仍超过免费 OCR 的 1MB 限制');
      }finally{canvas.width=0;canvas.height=0;}
    }finally{page.cleanup();}
  }finally{try{if(doc)await doc.destroy();else await task.destroy();}catch{}}
}
