import test from 'node:test';
import assert from 'node:assert/strict';
import {drivePickerConfig,fetchPickedDriveFile,pickGoogleDriveFile,googlePickerReady,driveAuthorizationReady,forgetDriveAuthorization} from '../web/src/google-drive-picker.js';

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

test('Drive popup request starts synchronously from a prepared click and reports popup block',async()=>{
 const original=globalThis.window;
 let popupCalled=0;
 globalThis.window={
  location:{origin:'https://jp-document-assistant.example.test'},
  google:{
   accounts:{oauth2:{
    initTokenClient(config){return {requestAccessToken(){popupCalled++;config.error_callback({type:'popup_failed_to_open'});}}},
    revoke(){}
   }},
   picker:{PickerBuilder:function(){}}
  }
 };
 try{
  assert.equal(googlePickerReady(),true);
  const promise=pickGoogleDriveFile(credentials);
  assert.equal(popupCalled,1,'Google requestAccessToken must run in the original click stack');
  await assert.rejects(promise,/授权弹窗被拦截|Safari/);
 }finally{
  if(original===undefined)delete globalThis.window;else globalThis.window=original;
 }
});
test('Drive missing Google library fails immediately instead of hanging in busy state',async()=>{
 const original=globalThis.window;
 globalThis.window={google:{}};
 try{
  assert.equal(googlePickerReady(),false);
  await assert.rejects(()=>pickGoogleDriveFile(credentials),/组件尚未准备好/);
 }finally{
  if(original===undefined)delete globalThis.window;else globalThis.window=original;
 }
});

test('a previously granted Drive token is reused for multiple picks without automatic revocation',async()=>{
 const original=globalThis.window;
 forgetDriveAuthorization();
 let granted=0,pickerBuilds=0,revoked=0,chosenToken='';
 const callback=(event)=>{};
 const picker={
  Action:{CANCEL:'cancel',PICKED:'picked',ERROR:'error'},
  ViewId:{DOCS:'docs'},
  PickerBuilder:function(){
   pickerBuilds++;
   let cb;
   const builder={
    addView(){return builder},
    setOAuthToken(value){chosenToken=value;return builder},
    setDeveloperKey(){return builder},
    setAppId(){return builder},
    setOrigin(){return builder},
    setCallback(fn){cb=fn;return builder},
    build(){return {setVisible(){cb({action:'cancel'})}};}
   };
   return builder;
  }
 };
 globalThis.window={
  location:{origin:'https://example.test'},
  google:{picker,accounts:{oauth2:{
   initTokenClient(conf){return {requestAccessToken(options){
    granted++;assert.equal(options.prompt,'');
    conf.callback({access_token:'token_not_shared_with_other_sessions',expires_in:3600});
   }}},
   hasGrantedAllScopes(){return true},
   revoke(){revoked++}
  }}}
 };
 try{
  assert.equal(driveAuthorizationReady(),false);
  assert.equal(await pickGoogleDriveFile(credentials),null);
  assert.equal(driveAuthorizationReady(),true);
  assert.equal(await pickGoogleDriveFile(credentials),null);
  assert.equal(granted,1,'cached access token should bypass the second Google popup');
  assert.equal(pickerBuilds,2);
  assert.equal(chosenToken,'token_not_shared_with_other_sessions');
  assert.equal(revoked,0,'file picker cancel/success must NOT revoke OAuth approval');
  forgetDriveAuthorization();
  assert.equal(driveAuthorizationReady(),false);
 }finally{
  forgetDriveAuthorization();
  if(original===undefined)delete globalThis.window;else globalThis.window=original;
 }
});
