import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {renderImageOcrPreview} from '../web/src/ocr-space-image.js';

test('image OCR fallback rejects non-images before reading private bytes',async()=>{
 await assert.rejects(renderImageOcrPreview(new Blob(['hello'],{type:'text/plain'})),/仅支持/);
});
test('image OCR fallback removes metadata by creating a fresh bounded JPEG',async()=>{
 const oldBitmap=globalThis.createImageBitmap,oldDocument=globalThis.document;
 const requested=[];
 globalThis.createImageBitmap=async()=>({width:4032,height:3024,close(){requested.push('closed')}});
 globalThis.document={createElement:()=>({
   width:0,height:0,
   getContext(){return {fillRect(){},drawImage(){requested.push('drawn')},set fillStyle(_) {}};},
   toBlob(callback,mime,quality){
     requested.push({mime,quality,width:this.width,height:this.height});
     callback(new Blob([new Uint8Array(320_000)],{type:'image/jpeg'}));
   }
 })};
 try{
   const image=new Blob(['exif metadata'],{type:'image/png'});
   const out=await renderImageOcrPreview(image);
   assert.equal(out.blob.type,'image/jpeg');
   assert.equal(out.blob.size,320_000);
   assert.ok(out.width<=1900&&out.height<=1900);
   assert.ok(requested.includes('drawn')&&requested.includes('closed'));
   assert.equal(requested.find(x=>typeof x==='object').mime,'image/jpeg');
 }finally{
   if(oldBitmap===undefined)delete globalThis.createImageBitmap;else globalThis.createImageBitmap=oldBitmap;
   if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
 }
});
test('saved image attachments show both Workers AI and OCR.space controls',()=>{
 const app=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
 assert.match(app,/@click="runOcr\(a\)"/);
 assert.match(app,/\['image\/jpeg','image\/png','image\/webp'\]\.includes\(a\.mime\)/);
 assert.match(app,/Workers AI 图片识别/);
 assert.match(app,/@click="openOcrSpace\(a\)"/);
 assert.match(app,/sheet==='ocrConfirm'/);
});
test('JPEG PNG and WebP import controls include explicit-consent OCR.space fallback',()=>{
 const app=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
 assert.match(app,/renderImageOcrPreview\(selected,\{maxBytes:900\*1024\}\)/);
 assert.match(app,/importOcrSpaceConsent/);
 assert.match(app,/image\\\/\(\?:jpeg\|png\|webp\)/);
 assert.match(app,/ocr-space\/preview/);
 // OCR.space must be a provider option, not a separate oversized card/action.
 assert.match(app,/importOcrEngine:\{title:'识别方式'/);
 assert.match(app,/value:'local',label:'本机 PaddleOCR'/);
 assert.match(app,/value:'ocr_space',label:'OCR.space'/);
 assert.match(app,/@click="openChoice\('importOcrEngine'\)"/);
 assert.match(app,/@click="runSelectedImportOcr"/);
 assert.match(app,/importOcrEngine==='ocr_space'/);
 assert.match(app,/同意发送所选/);
 assert.doesNotMatch(app,/<h3>OCR\.space<\/h3>/);
 assert.doesNotMatch(app,/>OCR\.space 识别<\/button>/);
 assert.doesNotMatch(app,/>重新运行本机日文 OCR<\/button>/);
 const css=readFileSync(new URL('../web/src/style.css',import.meta.url),'utf8');
 assert.match(css,/\.ocr-method-row\{/);
 assert.match(css,/\.ocr-cloud-options\{/);
});
