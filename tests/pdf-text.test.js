import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {extractPdfText,isOcrEngineFailure,isUsablePdfText} from '../web/src/pdf-text.js';

// Synthetic non-personal PDF with a genuine selectable text layer. No production OCR.
function tinyPdf(lines){
 const content=lines.map((s,i)=>`BT /F1 12 Tf 40 ${740-i*30} Td (${s.replace(/[()\\]/g,'\\$&')}) Tj ET`).join('\n');
 const objs=[
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
 ];
 let pdf='%PDF-1.4\n',offset=[0];
 for(let i=0;i<objs.length;i++){offset.push(pdf.length);pdf+=`${i+1} 0 obj\n${objs[i]}\nendobj\n`;}
 const xref=pdf.length;
 pdf+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`;
 for(let i=1;i<=objs.length;i++)pdf+=`${String(offset[i]).padStart(10,'0')} 00000 n \n`;
 pdf+=`trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 return new File([pdf],'evidence.pdf',{type:'application/pdf'});
}
test('PDF.js reads selectable text without any model call',async t=>{
 try{await import('pdfjs-dist/legacy/build/pdf.mjs');}catch{t.skip('pdfjs-dist is installed by GitHub CI, unavailable in this local sandbox');return;}
 const pdf=tinyPdf(['Payment deadline 2026-11-30','Amount 1200 JPY']);
 const parsed=await extractPdfText(pdf);
 assert.equal(parsed.pages_read,1);
 assert.equal(parsed.needs_manual,false);
 assert.match(parsed.text,/Payment deadline 2026-11-30/);
 assert.match(parsed.text,/Amount 1200 JPY/);
});
test('image-only PDF has no fabricated OCR result, and invalid file fails closed',async t=>{
 await assert.rejects(()=>extractPdfText(new File(['not pdf'],'bad.pdf')),/PDF 文件签名无效/);
 try{await import('pdfjs-dist/legacy/build/pdf.mjs');}catch{t.skip('pdfjs-dist is installed by GitHub CI');return;}
 const parsed=await extractPdfText(tinyPdf([]));
 assert.equal(parsed.needs_manual,true);
 assert.deepEqual(parsed.pages_without_text,[1]);
 assert.equal(parsed.text,'');
});

// Seven scanned pages should not trigger seven failed model initialization attempts.
test('engine errors stop repeated scanned-PDF retries without treating page errors as engine errors',()=>{
 for(const reason of [
   '本机日文模型推理或加载失败：Can\'t find variable: document',
   '加载日文模型或 ONNX WASM 失败：no available backend found',
   '隔离 OCR 工作线程加载失败',
   'PaddleOCR 图片推理失败'
 ]) assert.equal(isOcrEngineFailure(reason),true,reason);
 assert.equal(isOcrEngineFailure('第2页图片过暗，无可用文字'),false);
 const source=readFileSync(new URL('../web/src/pdf-text.js',import.meta.url),'utf8');
 assert.match(source,/&& !ocrStoppedReason/);
 assert.match(source,/if\(isOcrEngineFailure\(reason\)\)/);
 assert.match(source,/后续扫描页已暂停本机 OCR/);
});

test('garbled and empty text layers are not treated as successful',()=>{
 assert.equal(isUsablePdfText('東京ガス 3,200円'),true);
 assert.equal(isUsablePdfText(''),false);
 assert.equal(isUsablePdfText('\uFFFD\uFFFD\uFFFD'),false);
 assert.equal(isUsablePdfText('\uE001\uE002\uE003'),false);
});

// Synthetic Shift-JIS CID font, deliberately missing ToUnicode, matching the
// encoding style of Japanese utility bills. No real customer data.
function japanesePdf(){
 const content='BT /F1 12 Tf 40 740 Td <938C8B9E834B8358> Tj ET';
 const objs=[
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  '<< /Length '+content.length+' >>\nstream\n'+content+'\nendstream',
  '<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5 /Encoding /90ms-RKSJ-H /DescendantFonts [6 0 R] >>',
  '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /HeiseiKakuGo-W5 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor 7 0 R /DW 1000 /CIDToGIDMap /Identity >>',
  '<< /Type /FontDescriptor /FontName /HeiseiKakuGo-W5 /Flags 4 /FontBBox [-100 -250 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>'
 ];
 let pdf='%PDF-1.4\n',offset=[0];
 for(let i=0;i<objs.length;i++){offset.push(pdf.length);pdf+=(i+1)+' 0 obj\n'+objs[i]+'\nendobj\n';}
 const xref=pdf.length;
 pdf+='xref\n0 '+(objs.length+1)+'\n0000000000 65535 f \n';
 for(let i=1;i<=objs.length;i++)pdf+=String(offset[i]).padStart(10,'0')+' 00000 n \n';
 pdf+='trailer\n<< /Size '+(objs.length+1)+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';
 return new File([pdf],'synthetic-japanese.pdf',{type:'application/pdf'});
}
test('PDF.js decodes 90ms-RKSJ-H without ToUnicode and without OCR',async t=>{
 try{await import('pdfjs-dist/legacy/build/pdf.mjs');}catch{t.skip('pdfjs-dist unavailable');return;}
 const parsed=await extractPdfText(japanesePdf());
 assert.match(parsed.text,/東京ガス/);
 assert.equal(parsed.needs_manual,false);
 assert.equal(parsed.ocr_pages_attempted,0);
 assert.deepEqual(parsed.pages_without_text,[]);
});

// Synthetic PDF independently generated; no actual utility bill or personal data.
// RC4, empty user password, escaped Japanese font name, literal CP932 strings,
// separate BT/ET font selection and text drawing, no embedded font/ToUnicode.
test('SVF-style RC4 Japanese document extracts full text locally',async()=>{
 const file=new File([Buffer.from('JVBERi0xLjQKJcK1wrYKCjEgMCBvYmoKPDwvVHlwZS9DYXRhbG9nL1BhZ2VzIDIgMCBSPj4KZW5kb2JqCgoyIDAgb2JqCjw8L1R5cGUvUGFnZXMvQ291bnQgMS9LaWRzWzMgMCBSXT4+CmVuZG9iagoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCA1OTUgODQyXS9SZXNvdXJjZXM8PC9Gb250PDwvRjQgNSAwIFI+Pj4+L0NvbnRlbnRzIDQgMCBSPj4KZW5kb2JqCgo0IDAgb2JqCjw8L0xlbmd0aCAxMDQvRmlsdGVyL0ZsYXRlRGVjb2RlPj4Kc3RyZWFtCvZU8OFwVMsG6wnuqSaNp2ZijwCrF/QO+KQk34KKWjwB3ZYPjff7H9oMQ8L7LQlS6UnLepU/qzMUHgosQT8iU4j9nMN+UPjY6JmKGnd8ZnYkyWkI389vG1qAcB6MKUxfKzFC4kVus5AlCmVuZHN0cmVhbQplbmRvYmoKCjUgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTAvQmFzZUZvbnQvIzgybCM4MnIjODNTIzgzViM4M2IjODNOL05hbWUvIzgybCM4MnIjODNTIzgzViM4M2IjODNOL0VuY29kaW5nLzkwbXMtUktTSi1IL0Rlc2NlbmRhbnRGb250c1s2IDAgUl0+PgplbmRvYmoKCjYgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvQ0lERm9udFR5cGUyL0Jhc2VGb250LyM4MmwjODJyIzgzUyM4M1YjODNiIzgzTi9DSURTeXN0ZW1JbmZvPDwvUmVnaXN0cnk8Q0NBOTVBNEY2OD4vT3JkZXJpbmc8QzdBQzQ1NEM2M0U1Pi9TdXBwbGVtZW50IDI+Pi9Gb250RGVzY3JpcHRvciA3IDAgUi9EVyAxMDAwPj4KZW5kb2JqCgo3IDAgb2JqCjw8L1R5cGUvRm9udERlc2NyaXB0b3IvRm9udE5hbWUvIzgybCM4MnIjODNTIzgzViM4M2IjODNOL0ZsYWdzIDQvRm9udEJCb3hbMCAtMTM3IDEwMDAgODU5XS9JdGFsaWNBbmdsZSAwL0FzY2VudCA4NTkvRGVzY2VudCAtMTM3L0NhcEhlaWdodCA3NzAvU3RlbVYgOTIvWEhlaWdodCA1NDM+PgplbmRvYmoKCnhyZWYKMCA4CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNiAwMDAwMCBuIAowMDAwMDAwMDYyIDAwMDAwIG4gCjAwMDAwMDAxMTQgMDAwMDAgbiAKMDAwMDAwMDIyNyAwMDAwMCBuIAowMDAwMDAwNDAwIDAwMDAwIG4gCjAwMDAwMDA1NTMgMDAwMDAgbiAKMDAwMDAwMDc0MyAwMDAwMCBuIAoKdHJhaWxlcgo8PC9TaXplIDgvUm9vdCAxIDAgUi9JRFs8QzI5M0MyODEzN0MyQkE0NUMzODM2NjY3N0ZDMjk1MTU+PEU4ODIzNTdFMDdDQTY2NzYzRjlFNjc1REI4NUE2ODM3Pl0vRW5jcnlwdDw8L0ZpbHRlci9TdGFuZGFyZC9SIDMvViAyL0xlbmd0aCAxMjgvUCAtMzg4NC9FbmNyeXB0TWV0YWRhdGEgdHJ1ZS9PPDk1NUFFRDExNjhCRTc0N0E5NDI5QjFGQzI1MDQ0OTREMjY3QkRGM0NDQTM4QTk3ODk3OTg4OTYzQjJFMjhFNjg+L1U8QTM5MkVBODdCRkUzM0YxMTUzQjQxNzJGNzUzMDZDQ0MyOEJGNEU1RTRFNzU4QTQxNjQwMDRFNTZGRkZBMDEwOD4+Pj4+CnN0YXJ0eHJlZgo5MjUKJSVFT0YK','base64')],'synthetic-svf.pdf',{type:'application/pdf'});
 const parsed=await extractPdfText(file);
 assert.match(parsed.text,/検針日/);
 assert.match(parsed.text,/東京ガス\s*1234円/);
 assert.equal(parsed.needs_manual,false);
 assert.deepEqual(parsed.pages_without_text,[]);
});
