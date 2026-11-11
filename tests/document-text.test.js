import test from 'node:test';
import assert from 'node:assert/strict';
import {fileOf as make} from './helpers/office-fixture.js';
import {extractOfficeFile,extractDocumentText} from '../web/src/document-text.js';
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
