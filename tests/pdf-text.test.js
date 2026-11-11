import test from 'node:test';
import assert from 'node:assert/strict';
import {extractPdfText} from '../web/src/pdf-text.js';

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
