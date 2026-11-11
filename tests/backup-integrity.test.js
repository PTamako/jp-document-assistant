import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {createZip} from '../web/src/zip.js';
import {encryptZip,decryptZip,readBackup} from '../web/src/backup-client.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;

const passphrase='separate-secure-backup-passphrase';
const bytes=new Uint8Array([255,216,255,224,12,34,56,78]);
const sha=createHash('sha256').update(bytes).digest('hex');
const manifest=(original,version='1.0')=>({
  schema_version:version,source_app:'jp-document-assistant',documents:[{
    document:{id:'a'.repeat(32),title:'非公开日本文件',category:'other'},
    fields:[],candidates:[],
    attachments:[{id:'b'.repeat(32),file_label:'原件.jpg',
      object_sha256:sha,backup_path:original}]
  }]
});
const path='originals/'+('a'.repeat(32))+'/'+('b'.repeat(32))+'.jpg';
const zip=(entry,original=bytes)=>createZip([
  {name:'manifest.json',bytes:JSON.stringify(manifest(entry))},
  ...(original?[{name:entry,bytes:original}]:[])
]);

test('AES-GCM backup encryption/decryption roundtrip; wrong key, ciphertext tamper and invalid header fail closed',async()=>{
  const encrypted=await encryptZip(zip(path),passphrase);
  const restored=await decryptZip(encrypted,passphrase);
  const parsed=await readBackup(new File([restored],'verified.zip'));
  assert.equal(parsed.data.documents.length,1);
  assert.deepEqual(parsed.members.get(path),bytes);
  await assert.rejects(()=>decryptZip(encrypted,'different-backup-passphrase'),/密码错误|篡改|损坏/);
  const altered=new Uint8Array(await encrypted.arrayBuffer());
  altered[altered.length-4]^=0x80;
  await assert.rejects(()=>decryptZip(new Blob([altered]),passphrase),/密码错误|篡改|损坏/);
  await assert.rejects(()=>decryptZip(new Blob([new Uint8Array([1,2,3])]),passphrase),/不支持|受支持/);
  const direct=await readBackup(new File([encrypted],'family.jda'),passphrase);
  assert.equal(direct.data.documents.length,1);
});

test('missing original, modified original and unsupported backup version never silently restore',async()=>{
  await assert.rejects(()=>readBackup(new File([zip(path,null)],'missing.zip')),
    /原件分包缺失/);
  const modified=new Uint8Array(bytes);modified[7]^=1;
  await assert.rejects(()=>readBackup(new File([zip(path,modified)],'modified.zip')),
    /SHA-256|完整性|校验|哈希|hash|损坏/i);
  const badVersion=createZip([{name:'manifest.json',bytes:JSON.stringify(manifest(path,'9.9'))},
    {name:path,bytes}]);
  await assert.rejects(()=>readBackup(new File([badVersion],'unrecognized.zip')),
    /备份版本不支持/);
});
