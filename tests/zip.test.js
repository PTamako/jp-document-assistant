import test from 'node:test';
import assert from 'node:assert/strict';
import { createZip, readZip, verifySha256 } from '../web/src/zip.js';
import { createHash,webcrypto } from 'node:crypto';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
test('ZIP store/parse and sha256 integrity',async()=>{
  const raw=new TextEncoder().encode('日本語のテスト: 請求額 12,000円');
  const blob=createZip([{name:'manifest.json',bytes:'{"schema_version":"1.0"}'},{name:'originals/0/photo.png',bytes:raw}]);
  const map=await readZip(blob);
  assert.equal(map.size,2);
  assert.deepEqual(map.get('originals/0/photo.png'),raw);
  await verifySha256(raw,createHash('sha256').update(raw).digest('hex'));
  await assert.rejects(verifySha256(raw,'0'.repeat(64)));
});
test('ZIP rejects dangerous names and corrupted data',async()=>{
  assert.throws(()=>createZip([{name:'../hello.txt',bytes:'test'}]));
  const b=createZip([{name:'manifest.json',bytes:'{"a":1}'}]);
  const bytes=new Uint8Array(await b.arrayBuffer());bytes[40]^=1;
  await assert.rejects(()=>readZip(new Blob([bytes])));
});
