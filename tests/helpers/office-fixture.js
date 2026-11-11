import {deflateRawSync} from 'node:zlib';
const enc=new TextEncoder();
export const ct='<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>';
const table=Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(b){let c=0xffffffff;for(const x of b)c=table[(c^x)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
export function zipEntries(entries,compressed=false){
 const chunks=[],dir=[];let offset=0;
 for(const [name,value] of entries){
  const b=value instanceof Uint8Array?value:enc.encode(String(value));
  const n=enc.encode(name),data=compressed?deflateRawSync(b):b,crc=crc32(b);
  const head=new Uint8Array(30+n.length),hv=new DataView(head.buffer);
  hv.setUint32(0,0x04034b50,true);hv.setUint16(4,20,true);hv.setUint16(8,compressed?8:0,true);
  hv.setUint32(14,crc,true);hv.setUint32(18,data.length,true);hv.setUint32(22,b.length,true);hv.setUint16(26,n.length,true);head.set(n,30);
  const central=new Uint8Array(46+n.length),cv=new DataView(central.buffer);
  cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(10,compressed?8:0,true);
  cv.setUint32(16,crc,true);cv.setUint32(20,data.length,true);cv.setUint32(24,b.length,true);cv.setUint16(28,n.length,true);
  cv.setUint32(42,offset,true);central.set(n,46);
  chunks.push(head,data);dir.push(central);offset+=head.length+data.length;
 }
 const sz=dir.reduce((n,c)=>n+c.length,0),end=new Uint8Array(22),ev=new DataView(end.buffer);
 ev.setUint32(0,0x06054b50,true);ev.setUint16(8,entries.length,true);ev.setUint16(10,entries.length,true);
 ev.setUint32(12,sz,true);ev.setUint32(16,offset,true);
 return new Blob([...chunks,...dir,end],{type:'application/zip'});
}
export async function fileOf(name,parts,compressed=false){
 const zip=zipEntries([['[Content_Types].xml',ct],...parts],compressed);
 const type=name.endsWith('.docx')?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':name.endsWith('.pptx')?'application/vnd.openxmlformats-officedocument.presentationml.presentation':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
 return new File([await zip.arrayBuffer()],name,{type});
}
