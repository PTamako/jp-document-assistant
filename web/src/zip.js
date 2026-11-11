// Small, dependency-free, store-only ZIP. Strictly bounded batches prevent large iPhone RAM usage.
// It does not encrypt backups. Sensitive backups must be saved to a secure user-chosen location.
const enc = new TextEncoder(), dec = new TextDecoder();
const MAX_TOTAL=32*1024*1024,MAX_FILES=60;
const table=Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);return c>>>0;});
function crc32(data){let c=0xffffffff;for(const byte of data)c=table[(c^byte)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
function put16(v,o,x){v.setUint16(o,x,true);}
function put32(v,o,x){v.setUint32(o,x>>>0,true);}
function bytesOf(input){return input instanceof Uint8Array?input:enc.encode(String(input));}
export function createZip(files){
  if(!Array.isArray(files)||files.length<1||files.length>MAX_FILES)throw Error('ZIP 文件数量超出限制');
  let offset=0,total=0;const chunks=[],central=[];
  for(const file of files){
    const name=String(file.name||'');
    if(!/^[a-zA-Z0-9._/-]{1,180}$/.test(name)||name.includes('..')||name.startsWith('/'))throw Error('ZIP 文件名不安全');
    const data=bytesOf(file.bytes),label=enc.encode(name),crc=crc32(data);
    total+=data.length;
    if(total>MAX_TOTAL)throw Error('ZIP 备份包超过 32 MB，请分批');
    const header=new Uint8Array(30+label.length),h=new DataView(header.buffer);
    put32(h,0,0x04034b50);put16(h,4,20);put16(h,6,0);put16(h,8,0);put16(h,10,0);put16(h,12,0);
    put32(h,14,crc);put32(h,18,data.length);put32(h,22,data.length);put16(h,26,label.length);put16(h,28,0);
    header.set(label,30);
    const cent=new Uint8Array(46+label.length),c=new DataView(cent.buffer);
    put32(c,0,0x02014b50);put16(c,4,20);put16(c,6,20);put16(c,8,0);put16(c,10,0);put16(c,12,0);put16(c,14,0);
    put32(c,16,crc);put32(c,20,data.length);put32(c,24,data.length);put16(c,28,label.length);
    put16(c,30,0);put16(c,32,0);put16(c,34,0);put16(c,36,0);put32(c,38,0);put32(c,42,offset);cent.set(label,46);
    chunks.push(header,data);central.push(cent);offset+=header.length+data.length;
  }
  const directorySize=central.reduce((n,x)=>n+x.length,0);
  const end=new Uint8Array(22),e=new DataView(end.buffer);
  put32(e,0,0x06054b50);put16(e,4,0);put16(e,6,0);put16(e,8,files.length);put16(e,10,files.length);
  put32(e,12,directorySize);put32(e,16,offset);put16(e,20,0);
  return new Blob([...chunks,...central,end],{type:'application/zip'});
}
export async function readZip(file){
  if(file.size>MAX_TOTAL+40000)throw Error('备份 ZIP 超过 32 MB');
  const b=new Uint8Array(await file.arrayBuffer()),v=new DataView(b.buffer,b.byteOffset,b.byteLength),map=new Map();
  let at=0;
  while(at+4<=b.length&&v.getUint32(at,true)===0x04034b50){
    if(map.size>=MAX_FILES||at+30>b.length)throw Error('ZIP 文件数量过多或已损坏');
    const method=v.getUint16(at+8,true),size=v.getUint32(at+18,true),compSize=v.getUint32(at+22,true),nameLen=v.getUint16(at+26,true),extraLen=v.getUint16(at+28,true);
    if(method!==0||size!==compSize||size>MAX_TOTAL)throw Error('只支持应用导出的未压缩备份');
    const base=at+30,offset=base+nameLen+extraLen,end=offset+size;
    if(end>b.length||offset>MAX_TOTAL+40000)throw Error('ZIP 内容不完整');
    const name=dec.decode(b.slice(base,base+nameLen));
    if(!/^[a-zA-Z0-9._/-]{1,180}$/.test(name)||name.includes('..')||name.startsWith('/')||map.has(name))throw Error('ZIP 路径无效或重复');
    const data=b.slice(offset,end);
    if(crc32(data)!==v.getUint32(at+14,true))throw Error('ZIP 校验失败');
    map.set(name,data);at=end;
  }
  if(!map.has('manifest.json'))throw Error('找不到 manifest.json');
  return map;
}
export async function verifySha256(bytes,hash){
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  const got=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  if(got!==hash)throw Error('附件 SHA-256 校验失败');
  return true;
}
