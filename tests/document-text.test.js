import test from 'node:test';
import assert from 'node:assert/strict';
import {fileOf as make} from './helpers/office-fixture.js';
import {extractOfficeFile,extractDocumentText,validateOfficeBytes} from '../web/src/document-text.js';
test('DOCX extracts Japanese dates, prices and XML entities without R2 or AI',async()=>{
 const word=await make('invoice.docx',[['word/document.xml',
 '<w:document><w:p><w:t>納付期限：2026年11月30日</w:t></w:p><w:tr><w:tc><w:t>請求金額</w:t></w:tc><w:tc><w:t>1,200円 &amp; 税</w:t></w:tc></w:tr></w:document>']]);
 const value=await extractDocumentText(word);
 assert.equal(value.kind,'docx');assert.equal(value.source_type,'local_file');
 assert.match(value.text,/納付期限：2026年11月30日/);
 assert.match(value.text,/請求金額/);assert.match(value.text,/1,200円 & 税/);
 assert.equal(value.needs_manual,false);
});
test('DOCX supports optional headers but does not decompress image entries',async()=>{
 const word=await make('manual.docx',[['word/document.xml','<w:document><w:t>取扱説明書</w:t></w:document>'],
 ['word/header1.xml','<w:hdr><w:t>製品番号 ABC</w:t></w:hdr>'],
 ['word/media/photo.png','PRIVATE PHOTO CONTENT']]);
 const value=await extractOfficeFile(word);
 assert.match(value.text,/製品番号 ABC/);
 assert.doesNotMatch(value.text,/PRIVATE PHOTO/);
});
test('XLSX preserves cell references, shared strings, formula warning, and reviewable label/value pairs',async()=>{
 const book=await make('bill.xlsx',[['xl/workbook.xml','<workbook/>'],
 ['xl/sharedStrings.xml','<sst><si><t>納付期限</t></si><si><t>請求金額</t></si></sst>'],
 ['xl/worksheets/sheet1.xml','<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>2026年11月30日</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><f>SUM(D1:D5)</f><v>1200</v></c></row></sheetData></worksheet>']]);
 const result=await extractOfficeFile(book);
 assert.match(result.text,/A1: 納付期限/);
 assert.match(result.text,/【A1→B1】納付期限：2026年11月30日/);
 assert.match(result.text,/【A2→B2】請求金額：1200/);
 assert.match(result.warning,/缓存值/);
});
test('rejects macro payload and forged central ZIP lengths before parsing',async()=>{
 const macro=await make('bad.docx',[['word/document.xml','<w:document/>'],
 ['word/vbaProject.bin',new Uint8Array([0,1,2])]]);
 await assert.rejects(()=>extractOfficeFile(macro),/含宏/);
 const valid=await make('forged.docx',[['word/document.xml','<w:document><w:t>Hello</w:t></w:document>']]);
 const b=new Uint8Array(await valid.arrayBuffer()),v=new DataView(b.buffer);
 let pos=b.findIndex((c,i)=>c===80&&b[i+1]===75&&b[i+2]===1&&b[i+3]===2);
 assert.ok(pos>0);v.setUint32(pos+24,0x10000000,true);
 await assert.rejects(()=>extractOfficeFile(new File([b],'forged.docx')),/解压后超出上限/);
});
test('rejects XML external entities and corrupt CRC instead of guessing text',async()=>{
 const evil=await make('xx.docx',[['word/document.xml','<!DOCTYPE x [<!ENTITY y SYSTEM "file:///etc/passwd">]><w:document><w:t>&y;</w:t></w:document>']]);
 await assert.rejects(()=>extractOfficeFile(evil),/不安全声明/);
 const good=await make('badcrc.docx',[['word/document.xml','<w:document><w:t>金額</w:t></w:document>']]);
 const bytes=new Uint8Array(await good.arrayBuffer()),token=new TextEncoder().encode('金額');
 const at=bytes.findIndex((c,i)=>c===token[0]&&bytes.subarray(i,i+token.length).every((v,j)=>v===token[j]));
 assert.ok(at>0);bytes[at]=0;
 await assert.rejects(()=>extractOfficeFile(new File([bytes],'badcrc.docx')),/校验失败/);
});
test('empty image-only DOCX reports needs_manual without fabricated OCR results',async()=>{
 const doc=await make('blank.docx',[['word/document.xml','<w:document><w:p/></w:document>']]);
 const output=await extractOfficeFile(doc);
 assert.equal(output.needs_manual,true);
 assert.equal(output.text,'');
});

test('real DEFLATE-compressed DOCX/XLSX text layers pass bounded parsing and upload validation',async()=>{
 const docx=await make('packed.docx',[['word/document.xml',
  '<w:document><w:p><w:t>ご請求金額：12,800円</w:t></w:p></w:document>']],true);
 const xlsx=await make('packed.xlsx',[['xl/workbook.xml','<workbook/>'],
  ['xl/worksheets/sheet1.xml','<worksheet><c r="A1" t="inlineStr"><is><t>納付期限</t></is></c></worksheet>']],true);
 const mime='application/vnd.openxmlformats-officedocument.';
 assert.equal(await validateOfficeBytes(new Uint8Array(await docx.arrayBuffer()),mime+'wordprocessingml.document'),true);
 assert.equal(await validateOfficeBytes(new Uint8Array(await xlsx.arrayBuffer()),mime+'spreadsheetml.sheet'),true);
 assert.match((await extractOfficeFile(docx)).text,/12,800円/);
 assert.match((await extractOfficeFile(xlsx)).text,/納付期限/);
});
test('declared small ZIP inflation cannot expand beyond bound or write fake OCR text',async()=>{
 const docx=await make('inflated.docx',[['word/document.xml',
  '<w:document><w:t>'+('納付期限'.repeat(3200))+'</w:t></w:document>']],true);
 const bytes=new Uint8Array(await docx.arrayBuffer()),view=new DataView(bytes.buffer);
 let central=-1;
 for(let i=0;i<bytes.length-4;i++)if(view.getUint32(i,true)===0x02014b50){
  const length=view.getUint16(i+28,true),name=new TextDecoder().decode(bytes.subarray(i+46,i+46+length));
  if(name==='word/document.xml'){central=i;break;}
 }
 assert.ok(central>0);
 view.setUint32(central+24,1024,true);
 await assert.rejects(()=>extractOfficeFile(new File([bytes],'inflated.docx')),/实际解压大小超过安全限制/);
 await assert.rejects(()=>validateOfficeBytes(bytes,'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),/实际解压大小超过安全限制/);
});
test('server validator rejects masquerading ZIP with unsafe OOXML and macro payload',async()=>{
 const names='application/vnd.openxmlformats-officedocument.';
 const bad=await make('bad.docx',[['word/document.xml',
  '<!DOCTYPE x [<!ENTITY y SYSTEM "file:///sensitive">]><w:document>&y;</w:document>']],true);
 await assert.rejects(async()=>validateOfficeBytes(new Uint8Array(await bad.arrayBuffer()),names+'wordprocessingml.document'),/不安全声明/);
 const macro=await make('macro.docx',[['word/document.xml','<w:document/>'],['word/vbaProject.bin','abc']],true);
 await assert.rejects(async()=>validateOfficeBytes(new Uint8Array(await macro.arrayBuffer()),names+'wordprocessingml.document'),/含宏/);
});


test('PPTX slide text extraction preserves per-slide evidence and warns about image-only slides',async()=>{
 const presentation=await make('rules.pptx',[
  ['ppt/presentation.xml','<p:presentation/>'],
  ['ppt/slides/slide1.xml','<p:sld><p:sp><a:p><a:r><a:t>申請期限：2026年11月30日</a:t></a:r></a:p></p:sp></p:sld>'],
  ['ppt/slides/slide2.xml','<p:sld><p:pic><a:blip r:embed="rId2"/></p:pic></p:sld>'],
  ['ppt/media/picture.jpg',new Uint8Array([255,216,255,224,0,1,2,3])]
 ],true);
 const parsed=await extractOfficeFile(presentation);
 assert.equal(parsed.kind,'pptx');
 assert.equal(parsed.pages_read,2);
 assert.deepEqual(parsed.pages_without_text,[2]);
 assert.match(parsed.text,/【幻灯片 1】/);
 assert.match(parsed.text,/申請期限：2026年11月30日/);
 assert.doesNotMatch(parsed.text,/picture.jpg/);
 assert.match(parsed.warning,/没有可复制文字/);
 const mime='application/vnd.openxmlformats-officedocument.presentationml.presentation';
 assert.equal(await validateOfficeBytes(new Uint8Array(await presentation.arrayBuffer()),mime),true);
});
test('PPTX rejects macro-enabled or corrupt presentation ZIP without fabricating text',async()=>{
 const mime='application/vnd.openxmlformats-officedocument.presentationml.presentation';
 const invalid=await make('bad.pptx',[['ppt/presentation.xml','<x:invalid/>'],
  ['ppt/slides/slide1.xml','<p:sld><p:sp><a:t>甲</a:t></p:sp></p:sld>']],true);
 await assert.rejects(async()=>validateOfficeBytes(new Uint8Array(await invalid.arrayBuffer()),mime),/演示文稿结构无效/);
 const empty=await make('empty.pptx',[['ppt/presentation.xml','<p:presentation/>']],true);
 await assert.rejects(()=>extractOfficeFile(empty),/幻灯片数量不支持/);
});
