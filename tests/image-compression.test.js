import test from 'node:test';
import assert from 'node:assert/strict';
import {compressImage} from '../web/src/compress.js';

function mockCanvas({imageBytes,formats={}}){
 const oldBitmap=globalThis.createImageBitmap,oldDocument=globalThis.document;
 let released=0,created=0,cleared=null,drawn=0,conversions=[];
 globalThis.createImageBitmap=async()=>({width:4032,height:3024,close(){released++}});
 globalThis.document={createElement(type){
  assert.equal(type,'canvas');created++;
  let w=0,h=0;
  const canvas={
   get width(){return w},set width(v){w=v},
   get height(){return h},set height(v){h=v},
   getContext(){return {set fillStyle(x){assert.equal(x,'#fff')},fillRect(){},drawImage(){drawn++}}},
   toBlob(callback,mime,quality){
    conversions.push({width:w,height:h,mime,quality});
    const actualMime=formats[mime]||mime;
    const size=imageBytes({width:w,height:h,quality,mime});
    callback(new Blob([new Uint8Array(size)],{type:actualMime}));
   }
  };
  cleared=()=>canvas.width===0&&canvas.height===0;
  return canvas;
 }};
 return {
  get released(){return released},get created(){return created},get drawn(){return drawn},
  get cleared(){return cleared?.()},get conversions(){return conversions},
  restore(){
   if(oldBitmap===undefined)delete globalThis.createImageBitmap;else globalThis.createImageBitmap=oldBitmap;
   if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
  }
 };
}
const file=(n=2*1024*1024,mime='image/jpeg',name='japanese-receipt.jpg')=>
 new File([new Uint8Array(n)],name,{type:mime});
test('small images and original PDF are not decoded, copied, cached or re-encoded',async()=>{
 const m=mockCanvas({imageBytes:()=>20000});
 try{
  const small=file(200*1024),pdf=file(4*1024*1024,'application/pdf','original.pdf');
  assert.equal(await compressImage(small),small);
  assert.equal(await compressImage(pdf),pdf);
  assert.equal(m.created,0);assert.equal(m.released,0);
 }finally{m.restore()}
});
test('ordinary photo reaches about 300 KiB as WebP before private R2 upload',async()=>{
 const m=mockCanvas({imageBytes:({width})=>width>=2600?1150*1024:width>=2200?700*1024:width>=1900?280*1024:190*1024});
 try{
  const out=await compressImage(file());
  assert.equal(out.type,'image/webp');
  assert.equal(out.name,'japanese-receipt.webp');
  assert.equal(out.size,280*1024);
  assert.equal(m.released,1);assert.equal(m.cleared,true);
  assert.ok(m.conversions.every(x=>x.quality>=0.82));
  assert.ok(m.conversions.every(x=>x.width>=1700));
 }finally{m.restore()}
});
test('detailed document prefers a readable <=900KB file rather than illegible 300KB',async()=>{
 const m=mockCanvas({imageBytes:({width})=>width>=2600?740*1024:width>=2200?630*1024:width>=1900?540*1024:490*1024});
 try{
  const original=file(3*1024*1024),out=await compressImage(original);
  assert.equal(out.size,740*1024);
  assert.ok(out.size<=900*1024);
  assert.ok(out.size>300*1024);
  assert.equal(m.released,1);assert.equal(m.cleared,true);
 }finally{m.restore()}
});
test('Safari WebP unsupported falls back to JPEG, preserving correct extension',async()=>{
 const m=mockCanvas({imageBytes:()=>290*1024,formats:{'image/webp':'image/png'}});
 try{
  const out=await compressImage(file());
  assert.equal(out.type,'image/jpeg');
  assert.ok(out.name.endsWith('.jpg'));
  assert.equal(out.size,290*1024);
  assert.ok(m.conversions.some(x=>x.mime==='image/jpeg'));
  assert.equal(m.released,1);
 }finally{m.restore()}
});
test('images too dense for quality-safe 900KB fail clearly and release canvas/RAM',async()=>{
 const m=mockCanvas({imageBytes:()=>1200*1024});
 try{
  await assert.rejects(compressImage(file()),/900KB/);
  assert.equal(m.released,1);assert.equal(m.cleared,true);
 }finally{m.restore()}
});
test('Safari decoding failure never silently uploads an oversized uncompressed photo',async()=>{
 const old=globalThis.createImageBitmap;
 globalThis.createImageBitmap=async()=>{throw Error('Safari decode failure')};
 try{
  await assert.rejects(compressImage(file()),/JPEG 或 PDF/);
  const unchanged=file(500*1024);
  assert.equal(await compressImage(unchanged),unchanged);
 }finally{
  if(old===undefined)delete globalThis.createImageBitmap;else globalThis.createImageBitmap=old;
 }
});
