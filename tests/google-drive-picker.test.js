import test from 'node:test';
import assert from 'node:assert/strict';
import {drivePickerConfig,fetchPickedDriveFile,pickGoogleDriveFile} from '../web/src/google-drive-picker.js';

const credentials={VITE_GOOGLE_CLIENT_ID:'123-abcdef.apps.googleusercontent.com',
 VITE_GOOGLE_API_KEY:'AIzaabcdefghijklmnopqrstuvwxyz012345',
 VITE_GOOGLE_APP_ID:'12345678901'};
test('Google Drive Picker is disabled without configured OAuth origin and client credentials',async()=>{
 assert.equal(drivePickerConfig({}),null);
 assert.equal(drivePickerConfig({...credentials,VITE_GOOGLE_APP_ID:'bad-project'}),null);
 assert.equal(drivePickerConfig(credentials).appId,credentials.VITE_GOOGLE_APP_ID);
 await assert.rejects(()=>pickGoogleDriveFile(null),/尚未配置/);
});
test('Picker-selected Google Doc exports to TXT with ephemeral bearer token and no storage',async()=>{
 let calls=0;
 const file=await fetchPickedDriveFile({id:'fileId_for_doc_123',name:'在留申請書',
  mimeType:'application/vnd.google-apps.document'},'ephemeral-token',{
  fetcher:async(url,init)=>{
   calls++;assert.match(url,/\/export\?mimeType=text%2Fplain$/);
   assert.equal(init.headers.Authorization,'Bearer ephemeral-token');
   assert.equal(init.credentials,'omit');assert.equal(init.cache,'no-store');
   assert.equal(init.redirect,'error');
   return new Response(new TextEncoder().encode('申請期限：令和8年11月30日'),
    {headers:{'Content-Type':'text/plain'}});
  }
 });
 assert.equal(calls,1);assert.equal(file.name,'在留申請書.txt');
 assert.equal(file.type,'text/plain');
 assert.equal(await file.text(),'申請期限：令和8年11月30日');
});
test('Google Sheets and Slides export only selected file, with correct import MIME and extension',async()=>{
 const cases=[['spreadsheet','xlsx','spreadsheetml.sheet'],['presentation','pptx','presentationml.presentation']];
 for(const [type,ext,postfix] of cases){
  const result=await fetchPickedDriveFile({id:'selectedGoogleFile_12',name:'document',
    mimeType:`application/vnd.google-apps.${type}`},'ephemeral-token',{
    fetcher:async(url)=>{assert.match(url,/\/export\?mimeType=/);
      return new Response(new Uint8Array([80,75,3,4,1,2,3,4]))}
  });
  assert.ok(result.name.endsWith('.'+ext));assert.ok(result.type.endsWith(postfix));
 }
});
test('Google Drive binary download only reads the selected file and enforces 8 MiB limit',async()=>{
 let calls=0;
 const result=await fetchPickedDriveFile({id:'pickedFile_12345',name:'notice.pdf',
  mimeType:'application/pdf'},'token',{
  fetcher:async(url,init)=>{calls++;assert.match(url,/\/pickedFile_12345\?alt=media$/);
   assert.equal(init.headers.Authorization,'Bearer token');
   return new Response(new Uint8Array([37,80,68,70,45]));}
 });
 assert.equal(calls,1);assert.equal(result.type,'application/pdf');
 assert.equal(result.size,5);
 await assert.rejects(()=>fetchPickedDriveFile({id:'pickedFile_12345',name:'large.pdf',
  mimeType:'application/pdf'},'token',{fetcher:async()=>new Response('x',{
   headers:{'Content-Length':String(9*1024*1024)}})}),/超过 8MB/);
});
test('Google file ID injection, unrecognized formats and rejected account permission fail closed',async()=>{
 let calls=0;const fetcher=async()=>{calls++;return new Response('abc')};
 await assert.rejects(()=>fetchPickedDriveFile({id:'../other',name:'x.pdf',mimeType:'application/pdf'},'token',{fetcher}),/ID/);
 await assert.rejects(()=>fetchPickedDriveFile({id:'validFileName_123',name:'evil.sh',mimeType:'application/x-sh'},'token',{fetcher}),/暂不支持/);
 await assert.rejects(()=>fetchPickedDriveFile({id:'validFileName_123',name:'invoice.pdf',mimeType:'application/pdf'},'token',{
  fetcher:async()=>new Response('no access',{status:403})}),/没有授予/);
 assert.equal(calls,0);
});
