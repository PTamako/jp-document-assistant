import test from 'node:test';
import assert from 'node:assert/strict';
import {gmailPage,gmailSelected,gmailPayloadToDocument,gmailApi,gmailConnected,gmailForget} from '../web/src/gmail-import.js';
import {readFileSync} from 'node:fs';
const token='fake-token-for-readonly-tests';
const headers={Subject:'料金のお知らせ',From:'notice@example.invalid',Date:'Wed, 11 Nov 2026 12:30:00 +0900'};
const meta={headers:Object.entries(headers).map(([name,value])=>({name,value}))};
const b64=s=>Buffer.from(s).toString('base64url');

test('Gmail explicitly paginates five metadata items without requesting any unselected body',async()=>{
  const calls=[];
  const fetcher=async(url,options)=>{
    const u=new URL(url);calls.push(u);
    assert.equal(options.method,'GET');
    assert.equal(options.credentials,'omit');
    assert.equal(options.cache,'no-store');
    assert.equal(options.headers.Authorization,'Bearer '+token);
    if(u.pathname==='/gmail/v1/users/me/messages'){
      return {ok:true,json:async()=>({nextPageToken:'nextpage',
        messages:['abcdef000001','abcdef000002','abcdef000003','abcdef000004',
          'abcdef000005','abcdef000006'].map(id=>({id}))})};
    }
    return {ok:true,json:async()=>({payload:meta})};
  };
  const result=await gmailPage(token,'newer_than:30d','',fetcher);
  assert.equal(result.items.length,5);
  assert.equal(result.nextPageToken,'nextpage');
  assert.equal(calls.length,6); // 1 index + 5 metadata, zero raw/attachment GET
  assert.equal(calls[0].searchParams.get('maxResults'),'5');
  assert.equal(calls[0].searchParams.get('q'),'newer_than:30d');
  assert.equal(result.items[0].subject,'料金のお知らせ');
  assert.ok(calls.slice(1).every(u=>u.searchParams.get('format')==='metadata'));
});

test('Gmail reads only selected message text/plain and skips embedded HTML and attachments',async()=>{
  const payload={mimeType:'multipart/mixed',headers:meta.headers,parts:[
    {mimeType:'text/html',headers:[],body:{data:b64('<script>steal()</script><img src="https://track.invalid/pixel">未払い')}},
    {mimeType:'text/plain',headers:[{name:'Content-Type',value:'text/plain; charset=utf-8'}],
      body:{data:b64('納付期限：2026年11月30日')}},
    {mimeType:'image/png',filename:'track.png',body:{attachmentId:'unsafe-attachment-id'}}
  ]};
  let calls=0;
  const doc=await gmailSelected(token,'abcdef000001',async(url,opts)=>{
    calls++;assert.match(url,/format=full/);assert.doesNotMatch(url,/attachments/);
    assert.equal(opts.credentials,'omit');
    return {ok:true,json:async()=>({payload})};
  });
  assert.equal(calls,1);assert.equal(doc.source_type,'gmail');
  assert.match(doc.text,/納付期限：2026年11月30日/);
  assert.doesNotMatch(doc.text,/steal\(\)|track\.invalid|unsafe-attachment-id/);
});

test('Gmail HTML-only mail is turned into inert text without image fetching',()=>{
  const doc=gmailPayloadToDocument({mimeType:'text/html',headers:meta.headers,
    body:{data:b64('<script>alert(1)</script><img src="https://track.invalid/p">日付：11月30日')}});
  assert.match(doc.text,/日付：11月30日/);
  assert.doesNotMatch(doc.text,/alert|track\.invalid/);
});

test('Gmail invalid ID, URL, oversized payload, unauthorized requests fail closed',async()=>{
  await assert.rejects(()=>gmailSelected(token,'https://evil.invalid'),/ID 无效/);
  await assert.rejects(()=>gmailApi('https://evil.invalid/',token,async()=>{throw Error('no fetch');}),/地址无效/);
  await assert.rejects(()=>gmailApi('?maxResults=5',token,async()=>({status:403,ok:false})),/授权/);
  assert.throws(()=>gmailPayloadToDocument({mimeType:'text/plain',headers:meta.headers,
    body:{data:'A'.repeat(1400001)}}),/过大|编码/);
  gmailForget();assert.equal(gmailConnected(),false);
});


test('OAuth scope contract explicitly excludes previously granted scopes and browser persistent storage',()=>{
  const source=readFileSync(new URL('../web/src/gmail-import.js',import.meta.url),'utf8');
  assert.match(source,/scope:SCOPE,include_granted_scopes:false/);
  assert.match(source,/hasGrantedAllScopes\(reply,SCOPE\)/);
  assert.match(source,/error_callback:/);
  assert.doesNotMatch(source,/localStorage|indexedDB|sessionStorage|document\.cookie/);
  assert.match(source,/gmailForget\(\)/);
});

test('Gmail popup request is synchronous, and OAuth error/timeout always settle',()=>{
 const src=readFileSync(new URL('../web/src/gmail-import.js',import.meta.url),'utf8');
 const begin=src.indexOf('export function gmailAuthorize()');
 const end=src.indexOf('export async function gmailRevoke()',begin);
 assert.ok(begin>=0&&end>begin);
 const auth=src.slice(begin,end);
 assert.doesNotMatch(auth,/await preloadGmailIdentity/);
 assert.match(auth,/client\.requestAccessToken/);
 assert.match(auth,/error_callback:/);
 assert.match(auth,/setTimeout\(/);
 assert.match(auth,/clearTimeout\(/);
});
