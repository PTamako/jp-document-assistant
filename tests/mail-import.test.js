import test from 'node:test';
import assert from 'node:assert/strict';
import { readLocalText, extractEml } from '../web/src/mail-import.js';
const encoder = new TextEncoder();
const eml = content=>encoder.encode(content.replace(/\n/g,'\r\n'));
const file = (text,name,type='text/plain')=>new File([text],name,{type});

test('plain UTF-8 TXT is parsed in memory; no network call or automatic save',async()=>{
  const result=await readLocalText(file('納付期限：令和8年11月30日\n請求金額：1200円','payment.txt'));
  assert.equal(result.title,'payment');
  assert.equal(result.source_type,'local_file');
  assert.match(result.text,/令和8年11月30日/);
});

test('MIME quoted-printable Japanese, folded encoded subject and attachment skipped',async()=>{
  const text='ご請求金額：1,200円\n納付期限：2026年11月30日';
  const qp=Array.from(encoder.encode(text)).map(b=>b<0x20&&b!==10?String.fromCharCode(b):b>=127||b===61?'='+b.toString(16).toUpperCase().padStart(2,'0'):String.fromCharCode(b)).join('').replace(/\n/g,'\r\n');
  const subject=Buffer.from('料金のお知らせ').toString('base64');
  const src=[
    'From: notice@example.test',
    `Subject: =?UTF-8?B?${subject}?=`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="secret123"',
    '',
    '--secret123',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '', qp,
    '--secret123',
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    'Content-Transfer-Encoding: base64',
    '', 'JVBERi0xLjU=',
    '--secret123--'
  ].join('\r\n');
  const r=extractEml(encoder.encode(src));
  assert.equal(r.title,'料金のお知らせ');
  assert.match(r.text,/ご請求金額：1,200円/);
  assert.match(r.text,/納付期限：2026年11月30日/);
  assert.doesNotMatch(r.text,/invoice\.pdf|JVBERi0/);
  assert.match(r.warning,/附件未自动导入/);
});

test('prefer plaintext over HTML, do not include scripts or remote tracking pixels',async()=>{
  const src=[
    'From: info@example.test','Subject: Mail','MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary=abc','','--abc',
    'Content-Type: text/html; charset=utf-8','',
    '<script>stealCookies()</script><img src="https://tracking.example/pixel">未払い',
    '--abc','Content-Type: text/plain; charset=utf-8','','確定通知。内容を確認してください。','--abc--'
  ].join('\r\n');
  const r=extractEml(encoder.encode(src));
  assert.match(r.text,/確定通知/);
  assert.doesNotMatch(r.text,/stealCookies|tracking\.example|未払い/);
});

test('HTML-only messages are converted to inert text, not rendered HTML',()=>{
  const raw=['From: example@test.invalid','Subject: &#65;','Content-Type: text/html; charset="utf-8"','','<head><style>display:none</style></head><p>納付期限 11月30日</p><iframe src="https://bad.invalid"></iframe><p>金額 &yen; 1200 &amp; 税</p>'].join('\r\n');
  const r=extractEml(encoder.encode(raw));
  assert.match(r.text,/納付期限 11月30日/);
  assert.doesNotMatch(r.text,/<iframe|bad\.invalid|display:none/);
});

test('unsupported file, huge input, corrupt encoding and attachment-only mail fail safely',async()=>{
  await assert.rejects(()=>readLocalText(file('hello','receipt.pdf')),/只支持/);
  await assert.rejects(()=>readLocalText(new File([new Uint8Array(1024*1024+1)],'huge.eml')),/1 MB/);
  assert.throws(()=>extractEml(eml('From: spam@example.test\nMIME-Version: 1.0\nContent-Type: application/pdf\n\nJVBERi0=')),/没有可读取/);
  await assert.rejects(()=>readLocalText(new File([new Uint8Array([0x81,0xff,0xfe])],'bad.txt')),/无法读取文字编码|字符编码/);
});
