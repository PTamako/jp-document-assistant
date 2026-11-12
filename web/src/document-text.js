// Office text-layer extraction. Runs only on user-selected files in memory; no remote calls.
const LIMIT=8*1024*1024, MAX_XML=8*1024*1024, MAX_TOTAL=24*1024*1024, MAX_TEXT=100000;
const decoder=new TextDecoder('utf-8',{fatal:true});
const crcTable=Array.from({length:256},(_,i)=>{let v=i;for(let n=0;n<8;n++)v=(v&1)?0xedb88320^(v>>>1):v>>>1;return v>>>0;});
function crc32(data){let c=0xffffffff;for(const b of data)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
function invalid(message){throw new Error(message);}
function entity(s){
 return String(s).replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/gi,(_,x)=>{
  const named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
  if(named[x.toLowerCase()])return named[x.toLowerCase()];
  const code=x.startsWith('#x')?parseInt(x.slice(2),16):Number(x.slice(1));
  return Number.isInteger(code)&&code>0&&code<0x110000&&!(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):'';
 });
}
function attribute(xml,key){return entity(new RegExp('(?:^|\\s)'+key+'\\s*=\\s*(["\\x27])(.*?)\\1','i').exec(xml)?.[2]||'');}
function centralEntries(bytes){
 const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 if(bytes.length<22||v.getUint32(0,true)!==0x04034b50)invalid('不是有效的 Office ZIP 文书');
 let end=-1;
 for(let k=bytes.length-22;k>=Math.max(0,bytes.length-65557);k--)if(v.getUint32(k,true)===0x06054b50){end=k;break;}
 if(end<0)invalid('Office ZIP 中央目录不存在');
 const count=v.getUint16(end+10,true),start=v.getUint32(end+16,true),size=v.getUint32(end+12,true);
 if(!count||count>240||v.getUint16(end+4,true)||v.getUint16(end+6,true)||count!==v.getUint16(end+8,true)||start+size>end)
  invalid('ZIP 数量、分卷或目录不安全');
 const map=new Map();let p=start,total=0;
 for(let i=0;i<count;i++){
  if(p+46>start+size||v.getUint32(p,true)!==0x02014b50)invalid('Office ZIP 目录损坏');
  const flags=v.getUint16(p+8,true),method=v.getUint16(p+10,true);
  const crc=v.getUint32(p+16,true),packed=v.getUint32(p+20,true),length=v.getUint32(p+24,true);
  const nl=v.getUint16(p+28,true),el=v.getUint16(p+30,true),cl=v.getUint16(p+32,true),local=v.getUint32(p+42,true);
  if(flags&1||flags&64||method!==0&&method!==8||length===0xffffffff||packed===0xffffffff)
   invalid('Office 文件加密或使用不支持的压缩方式');
  if(p+46+nl+el+cl>start+size)invalid('Office ZIP 路径损坏');
  let name;
  try{name=decoder.decode(bytes.subarray(p+46,p+46+nl));}catch{invalid('Office ZIP 路径编码无效');}
  if(name.length>220||name.startsWith('/')||name.includes('\\')||name.includes('\0')||
    name.split('/').some(x=>x==='.'||x==='..')||map.has(name))invalid('Office ZIP 路径不安全或重复');
  total+=length;
  if(total>MAX_TOTAL||length>MAX_XML&&/\.xml$/i.test(name))invalid('Office 文件解压后超出上限');
  if((packed===0&&length>0)||(packed>0&&length/packed>220))invalid('Office 压缩率异常');
  if(local+30>bytes.length||v.getUint32(local,true)!==0x04034b50)invalid('Office ZIP 文件头损坏');
  const ln=v.getUint16(local+26,true),le=v.getUint16(local+28,true);
  if(local+30+ln+le+packed>bytes.length||decoder.decode(bytes.subarray(local+30,local+30+ln))!==name||
    v.getUint16(local+8,true)!==method)invalid('Office ZIP 中央和本地条目不一致');
  map.set(name,{offset:local+30+ln+le,packed,length,method,crc});
  p+=46+nl+el+cl;
 }
 if(p!==start+size||[...map.keys()].some(n=>/\/vbaProject\.bin$/i.test(n)))invalid('Office ZIP 异常或含宏');
 return map;
}
async function inflateChecked(data,expected){
  if(typeof DecompressionStream!=='function')invalid('当前设备不支持 Office 解压，请复制文字导入');
  let reader;
  try{reader=new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();}
  catch{invalid('Office 解压格式不支持，请用手动文字导入');}
  let total=0;const chunks=[];
  try{
    for(;;){
      const next=await reader.read();if(next.done)break;
      total+=next.value.byteLength;
      if(total>expected||total>MAX_XML)invalid('Office 实际解压大小超过安全限制');
      chunks.push(next.value);
    }
  }catch(e){
    if(e?.message==='Office 实际解压大小超过安全限制')throw e;
    invalid('Office 压缩文件损坏，无法读取');
  }finally{try{await reader.cancel();}catch{}reader.releaseLock();}
  if(total!==expected)invalid('Office 解压结果与声明长度不一致');
  const out=new Uint8Array(total);let offset=0;
  for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.length;}
  return out;
}
async function xmlPart(bytes,map,name){
 const part=map.get(name);if(!part)return '';
 if(part.length>MAX_XML)invalid('Office XML 内容过大');
 let content=bytes.subarray(part.offset,part.offset+part.packed);
 if(part.method===8)content=await inflateChecked(content,part.length);
 if(content.length!==part.length||crc32(content)!==part.crc)invalid('Office ZIP 数据校验失败');
 let s;try{s=decoder.decode(content);}catch{invalid('Office XML 不是合法 UTF-8');}
 if(/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(s))invalid('Office XML 存在不安全声明');
 return s;
}
function docxText(xml){
 const output=[];
 for(const match of xml.matchAll(/<w:t(?:\s[^<>]*)?>([\s\S]*?)<\/w:t>|<w:(?:tab|br|cr)\b[^>]*\/?\s*>|<\/w:(?:p|tr|tc)\s*>/gi)){
  if(match[1]!==undefined)output.push(entity(match[1]));
  else output.push(/tab|tc/i.test(match[0])?'\t':'\n');
 }
 return output.join('').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
function inlineText(xml){return [...xml.matchAll(/<t(?:\s[^<>]*)?>([\s\S]*?)<\/t>/gi)].map(m=>entity(m[1])).join('');}
async function docx(bytes,map){
 const main=await xmlPart(bytes,map,'word/document.xml');
 if(!main)invalid('DOCX 缺少主文档');
 const pieces=[docxText(main)];
 for(const part of [...map.keys()].filter(n=>/^word\/(?:header\d+|footer\d+|footnotes|endnotes)\.xml$/i.test(n)).sort()){
  const text=docxText(await xmlPart(bytes,map,part));if(text)pieces.push('【'+part+'】\n'+text);
 }
 return {text:pieces.filter(Boolean).join('\n\n'),warning:'Word 已提取文字层，表格布局和图片可能不完整，须核对金额及日期',pages_read:null};
}
async function xlsx(bytes,map){
 if(!map.has('xl/workbook.xml'))invalid('XLSX 缺少工作簿');
 const sheets=[...map.keys()].filter(n=>/^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
 if(!sheets.length||sheets.length>30)invalid('XLSX 工作表数量不支持');
 const shared=[];
 const rawStrings=await xmlPart(bytes,map,'xl/sharedStrings.xml');
 for(const match of rawStrings.matchAll(/<si(?:\s[^<>]*)?>([\s\S]*?)<\/si>/gi)){
  if(shared.length>=20000)invalid('XLSX 字符串过多');
  shared.push(inlineText(match[1]));
 }
 const output=[];let formulas=false,styles=false,outputLength=0;
 const append=line=>{outputLength+=line.length+1;if(outputLength>MAX_TEXT)invalid('Excel 内容超过 10 万字符');output.push(line);};
 for(let i=0;i<sheets.length;i++){
  const xml=await xmlPart(bytes,map,sheets[i]);append('【工作表 '+(i+1)+' · '+sheets[i]+'】');
  let count=0;const rows=new Map();
  for(const m of xml.matchAll(/<c(?=\s|>)([^>]*)>([\s\S]*?)<\/c>/g)){
   if(++count>20000)invalid('Excel 单元格过多');
   const pos=attribute(m[1],'r'),type=attribute(m[1],'t');
   if(!/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(pos))continue;
   if(/<f(?:\s|>)/.test(m[2]))formulas=true;
   if(attribute(m[1],'s'))styles=true;
   let value='';
   if(type==='inlineStr')value=inlineText(m[2]);
   else{
    const raw=/<v(?:\s[^<>]*)?>([\s\S]*?)<\/v>/.exec(m[2])?.[1];
    if(raw===undefined)continue;
    if(type==='s'){const n=Number(raw);if(!Number.isSafeInteger(n)||n<0||n>=shared.length)invalid('XLSX 字符索引错误');value=shared[n];}
    else value=entity(raw);
   }
   if(!value)continue;
   value=String(value).trim();append(pos+': '+value);
   const row=Number(pos.match(/\d+$/)[0]);if(!rows.has(row))rows.set(row,[]);rows.get(row).push({pos,value});

  }
  for(const cells of rows.values())for(let k=0;k<cells.length-1;k++){
   const a=cells[k],b=cells[k+1];
   if(/納付|支払|請求|申請|締切|期限|金額|支給|控除/.test(a.value)&&/\d{4}年|[0-9]{4}[-/.]|^[0-9,]+$/.test(b.value))
    append('【'+a.pos+'→'+b.pos+'】'+a.value+'：'+b.value);
  }
 }
 const warnings=['Excel 只读取现有单元格值，不计算公式，也不推断日期格式'];
 if(formulas)warnings.push('公式显示为文件缓存值，可能过期');
 if(styles)warnings.push('日期与百分比可能显示为原始数值');
 return {text:output.join('\n'),warning:warnings.join('。'),pages_read:sheets.length};
}
// Production upload guard: validate OOXML structure before any R2 PUT.

async function pptx(bytes,map){
 if(!map.has('ppt/presentation.xml'))invalid('PPTX 缺少演示文稿');
 const slideNames=[...map.keys()].filter(x=>/^ppt\/slides\/slide[1-9]\d*\.xml$/.test(x))
  .sort((a,b)=>Number(a.match(/slide(\d+)/)[1])-Number(b.match(/slide(\d+)/)[1]));
 if(!slideNames.length||slideNames.length>60)invalid('PPTX 幻灯片数量不支持（最多60张）');
 const slides=[];const missing=[];let total=0;
 for(let i=0;i<slideNames.length;i++){
  const xml=await xmlPart(bytes,map,slideNames[i]);
  if(!/<p:sld(?:\s|>)/.test(xml))invalid('PPTX 幻灯片 XML 格式错误');
  // Image shapes cannot be OCRed here. Text only, never external image links.
  const content=xml.match(/<p:sp\b[\s\S]*?<\/p:sp>|<a:tbl\b[\s\S]*?<\/a:tbl>/g)||[];
  const chunks=content.length?content:[xml];
  const parts=[];
  for(const c of chunks){
   const lines=[...c.matchAll(/<a:t(?:\s[^<>]*)?>([\s\S]*?)<\/a:t>|<\/a:p\s*>/g)]
    .map(m=>m[1]!==undefined?entity(m[1]):'\n').join('');
   if(lines.trim())parts.push(lines.trim());
  }
  const text=parts.join('\n');
  if(!text)missing.push(i+1);
  else{
   const paragraph='【幻灯片 '+(i+1)+'】\n'+text;
   total+=paragraph.length;if(total>MAX_TEXT)invalid('PPTX 文字总量超过10万字符');
   slides.push(paragraph);
  }
 }
 return {text:slides.join('\n\n'),pages_read:slideNames.length,pages_without_text:missing,
  warning:missing.length?
   '第 '+missing.join('、')+' 张幻灯片没有可复制文字，图片中的内容仍需人工检查或单独 OCR；图片和嵌入媒体不会自动解析':
   'PPTX 已提取可复制的幻灯片文字；图片、动画和备注中的内容未经过 OCR'};
}

export async function validateOfficeBytes(bytes,mime){
 const docx='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
 const xlsx='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
 const pptx='application/vnd.openxmlformats-officedocument.presentationml.presentation';
 if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>LIMIT||![docx,xlsx,pptx].includes(mime))
   invalid('Office 文件大小或格式无效');
 const map=centralEntries(bytes);
 const main=mime===docx?'word/document.xml':mime===xlsx?'xl/workbook.xml':'ppt/presentation.xml';
 if(!map.has('[Content_Types].xml')||!map.has(main))invalid('Office 必需的 XML 部件缺失');
 const types=await xmlPart(bytes,map,'[Content_Types].xml');
 if(!/<Types(?:\s|\/?>)/.test(types))invalid('Office 内容类型声明无效');
 const mainXml=await xmlPart(bytes,map,main);
 if(mime===docx&&!/<w:document(?:\s|>)/.test(mainXml))invalid('Word 主文档无效');
 if(mime===xlsx&&!/<(?:\w+:)?workbook(?:\s|\/?>)/.test(mainXml))invalid('Excel 工作簿结构无效');
 if(mime===pptx){
   if(!/<p:presentation(?:\s|\/?>)/.test(mainXml))invalid('PPTX 演示文稿结构无效');
   if(![...map.keys()].some(n=>/^ppt\/slides\/slide[1-9]\d*\.xml$/.test(n)))
     invalid('PPTX 没有幻灯片');
 }
 return true;
}
export async function extractOfficeFile(file){
 if(!file||file.size<1||file.size>LIMIT)invalid('Office 文件必须小于 8 MB');
 const name=String(file.name||''),kind=/\.docx$/i.test(name)?'docx':/\.xlsx$/i.test(name)?'xlsx':/\.pptx$/i.test(name)?'pptx':'';
 if(!kind)invalid('仅支持无宏 DOCX / XLSX / PPTX');
 const bytes=new Uint8Array(await file.arrayBuffer()),map=centralEntries(bytes);
 if(!map.has('[Content_Types].xml'))invalid('Office 文件缺少内容类型声明');
 const result=kind==='docx'?await docx(bytes,map):kind==='xlsx'?await xlsx(bytes,map):await pptx(bytes,map);
 if(result.text.length>MAX_TEXT)invalid('文字超过 10 万字符');
 return {kind,title:name.replace(/\.[^.]+$/,''),source_type:'local_file',needs_manual:!result.text.trim(),...result};
}
export async function extractDocumentText(file,options={}){
 if(!file||file.size<1||file.size>LIMIT)invalid('文件必须小于 8 MB');
 const name=String(file.name||'').toLowerCase();
 if(name.endsWith('.docx')||name.endsWith('.xlsx')||name.endsWith('.pptx'))return extractOfficeFile(file);
 if(name.endsWith('.pdf')||file.type==='application/pdf'){
  const {extractPdfText}=await import('./pdf-text.js');return extractPdfText(file,{maxPages:30,maxChars:MAX_TEXT,...options});
 }
 invalid('仅支持 PDF、DOCX、XLSX、PPTX；邮件请走 .eml / .txt 入口');
}
