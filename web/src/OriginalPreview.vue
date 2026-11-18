<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';

const props=defineProps({
  file:{type:Object,default:null},
  mime:{type:String,default:''},
  url:{type:String,default:''},
  filename:{type:String,default:'原件'}
});
defineEmits(['close']);

const isPdf=props.mime==='application/pdf';
const isImage=['image/jpeg','image/png','image/webp'].includes(props.mime);
const pageNumber=ref(1),pageCount=ref(0),pageUrl=ref(''),loading=ref(false),previewError=ref('');
let pdfTask=null,pdfDocument=null,closed=false,renderSerial=0;

function releasePage(){
  if(pageUrl.value)URL.revokeObjectURL(pageUrl.value);
  pageUrl.value='';
}

async function renderPage(number){
  if(closed||!pdfDocument||number<1||number>pdfDocument.numPages)return;
  const serial=++renderSerial;
  loading.value=true;previewError.value='';
  let canvas=null,pdfPage=null;
  try{
    pdfPage=await pdfDocument.getPage(number);
    if(closed||serial!==renderSerial)return;
    const base=pdfPage.getViewport({scale:1});
    // Bound decoded pixels on iPhones; render the requested page only.
    const scale=Math.max(0.25,Math.min(2.5,1800/base.width,Math.sqrt(3000000/(base.width*base.height))));
    const viewport=pdfPage.getViewport({scale});
    canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(viewport.width));
    canvas.height=Math.max(1,Math.round(viewport.height));
    const context=canvas.getContext('2d',{alpha:false});
    if(!context)throw new Error('此设备无法绘制 PDF 页面');
    context.fillStyle='#fff';
    context.fillRect(0,0,canvas.width,canvas.height);
    await pdfPage.render({canvasContext:context,viewport}).promise;
    const image=await new Promise((resolve,reject)=>
      canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('PDF 页面转换失败')),'image/jpeg',0.94));
    if(closed||serial!==renderSerial)return;
    const nextUrl=URL.createObjectURL(image);
    releasePage();
    pageUrl.value=nextUrl;
    pageNumber.value=number;
  }catch(e){
    if(!closed&&serial===renderSerial)previewError.value='无法显示这一页：'+(e?.message||'渲染失败');
  }finally{
    if(canvas){canvas.width=0;canvas.height=0;}
    try{pdfPage?.cleanup();}catch{}
    if(!closed&&serial===renderSerial)loading.value=false;
  }
}

async function initializePdf(){
  loading.value=true;
  try{
    if(!props.file?.size)throw new Error('附件内容为空');
    const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const worker=await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc=worker.default;
    const bytes=new Uint8Array(await props.file.arrayBuffer());
    if(closed)return;
    if(new TextDecoder().decode(bytes.subarray(0,5))!=='%PDF-')throw new Error('文件不是有效的 PDF');
    pdfTask=pdfjs.getDocument({
      data:bytes,disableAutoFetch:true,disableStream:true,
      stopAtErrors:true,isEvalSupported:false,useSystemFonts:true,disableFontFace:true
    });
    const opened=await pdfTask.promise;
    if(closed){await opened.destroy();return;}
    pdfDocument=opened;
    pageCount.value=opened.numPages;
    await renderPage(1);
  }catch(e){
    if(!closed)previewError.value='PDF 预览失败：'+(e?.message||'无法读取文件');
  }finally{
    if(!closed)loading.value=false;
  }
}

onMounted(()=>{
  if(isPdf)void initializePdf();
  else if(!isImage)previewError.value='暂不支持此附件格式预览，可保存原件后用其他应用打开。';
});
onBeforeUnmount(()=>{
  closed=true;renderSerial++;
  releasePage();
  // PDF.js owns the decoded pages and worker task; never retain them when closed.
  const resource=pdfDocument||pdfTask;
  if(resource)void resource.destroy().catch(()=>{});
});
</script>

<template>
  <h2>私人原件 · 按需加载</h2>
  <template v-if="isPdf">
    <p v-if="loading&&!pageUrl" class="preview-note" role="status">正在本机渲染 PDF 首页…</p>
    <div v-if="pageUrl" class="preview-pdf-page">
      <img :src="pageUrl" :alt="`PDF 第 ${pageNumber} 页`" @error="previewError='页面图片显示失败，请保存原件查看'" />
    </div>
    <p v-if="pageCount>1" class="preview-pages">
      <button type="button" class="secondary small" :disabled="loading||pageNumber<=1" @click="renderPage(pageNumber-1)">上一页</button>
      <span>第 {{pageNumber}} / {{pageCount}} 页</span>
      <button type="button" class="secondary small" :disabled="loading||pageNumber>=pageCount" @click="renderPage(pageNumber+1)">下一页</button>
    </p>
    <p v-if="loading&&pageUrl" class="preview-note" role="status">正在渲染页面…</p>
  </template>
  <img v-else-if="isImage" :src="url" :alt="filename" class="original-image" @error="previewError='图片显示失败，请保存原件查看'" />
  <p v-if="previewError" class="preview-error" role="alert">{{previewError}}</p>
  <a v-if="url" class="preview-download" :href="url" :download="filename||'原件'">保存原件</a>
  <div class="sheet-actions">
    <button type="button" class="secondary full" @click="$emit('close')">关闭并释放内存</button>
  </div>
</template>

<style scoped>
.preview-pdf-page{width:100%;max-height:65dvh;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:12px}
.preview-pdf-page img{display:block;width:100%;height:auto}
.preview-pages{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:12px 0 4px;color:var(--ink);font-size:14px}
.preview-pages button{flex:0 0 auto}
.preview-note{padding:24px 12px;text-align:center;color:var(--secondary);font-size:14px}
.preview-error{padding:12px;border:1px solid var(--line);border-radius:12px;color:var(--danger);background:var(--panel);font-size:14px;overflow-wrap:anywhere}
.preview-download{display:block;text-align:center;min-height:44px;padding:11px;color:var(--blue);font-weight:650;text-decoration:none}
</style>
