import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createZip,readZip} from '../web/src/zip.js';
import {encryptZip,decryptZip,readBackup} from '../web/src/backup-client.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
test('AES-GCM encrypted small-batch ZIP supports verified round trip',async()=>{
 const raw=createZip([{name:'manifest.json',bytes:JSON.stringify({schema_version:'1.0',source_app:'jp-document-assistant',documents:[]})}]);
 const encoded=await encryptZip(raw,'long-safe-test-passphrase');
 assert.equal(encoded.type,'application/octet-stream');
 const decoded=await decryptZip(encoded,'long-safe-test-passphrase');
 const archive=await readZip(decoded);
 assert.ok(archive.has('manifest.json'));
 const bad=await decryptZip(encoded,'this-is-the-wrong-password').catch(e=>e.message);
 assert.match(bad,/密码错误/);
});
