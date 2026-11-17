import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,createHmac} from 'node:crypto';
import {commitPersonalSbiCandidate,personalSbiReady,personalSbiReceiptStatus}
 from '../worker/document-personal-sbi.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const doc='a'.repeat(32),candidate='b'.repeat(32),secret='c'.repeat(64);
const p={role:'member',auth_source:'homeflow',user_id:'local-user',
 homeflow_user_id:'22222222-2222-4222-8222-222222222222',
 homeflow_household_id:'primary'};
const item={id:candidate,document_id:doc,
 payload_json:JSON.stringify({kind:'transfer',amount_jpy:15000,merchant:'SBI証券 投信積立サービス'})};
const fields=new Map([['amount_jpy','15000'],['merchant','SBI証券 投信積立サービス']]);
function setup(){
 let entry=null,seen=0;
 const env={HOMEFLOW_SSO_ENABLED:'true',DOCUMENT_FINANCE_TARGET_SECRET:secret,
  DB:{prepare(sql){return {bind(...args){return {
   async first(){return entry},
   async run(){
    if(sql.startsWith('INSERT OR IGNORE INTO integration_links')){
     if(!entry)entry={id:args[0],candidate_id:args[1],target:'kakebo',idempotency_key:args[2],
      state:'pending',request_fingerprint:args[3],attempt_count:0};return {meta:{changes:1}};
    }
    if(sql.includes("SET state='sending'")){
     if(!entry||!['pending','failed'].includes(entry.state))return {meta:{changes:0}};
     entry.state='sending';entry.request_fingerprint=args[1];entry.attempt_count++;return {meta:{changes:1}};
    }
    if(sql.includes("SET state='synced'")){
     entry.state='synced';entry.remote_id=args[0];return {meta:{changes:1}};
    }
    if(sql.includes("SET state='failed'")){
     entry.state='failed';return {meta:{changes:1}};
    }
    throw Error('unexpected SQL '+sql);
   }
  }}}}},
  KAKEIBO_DOCUMENT_FINANCE_SERVICE:{async fetch(request){
   seen++;
   assert.equal(request.headers.get('cookie'),null);
   assert.equal(request.headers.get('origin'),null);
   const wire=await request.text(),stamp=request.headers.get('x-approval-timestamp');
   const domain=request.url.endsWith('/receipt')?'jpda:personal-sbi-receipt':'jpda:personal-sbi-execute';
   const expected=createHmac('sha256',Buffer.from(secret,'hex'))
    .update(domain+'\n'+stamp+'\n'+wire).digest('hex');
   assert.equal(request.headers.get('x-approval-signature'),expected);
   const b=JSON.parse(wire);
   assert.equal(b.owner_user_id,p.homeflow_user_id);
   if(domain==='jpda:personal-sbi-execute'){
    assert.equal(b.amount_jpy,15000);
    assert.equal(b.purpose,'monthly');
   }
   assert.equal(b.payment_source,undefined);
   return Response.json({ok:true,applied:true,owner_user_id:p.homeflow_user_id,
    household_id:p.homeflow_household_id,source_candidate_id:candidate,
    remote_id:'personal-sbi:'+candidate,state:'active'});
  }}
 };
 return {env,seen:()=>seen,entry:()=>entry};
}
function request(data={}){
 return new Request('https://docs.example/api/candidates/'+candidate+'/commit',
  {method:'POST',headers:{'content-type':'application/json','Idempotency-Key':'jda-'+candidate},
   body:JSON.stringify({confirm:'CONFIRM_ACCOUNTING',payment_confirmed:true,
     date:'2026-11-17',transfer_date:'2026-11-17',note:'',...data})});
}
test('SBI member transfer posts once under verified owner without bank/card or HomeFlow approval',async()=>{
 const t=setup();
 assert.equal(personalSbiReady(t.env,p),true);
 const res=await commitPersonalSbiCandidate(request(),t.env,p,item,fields);
 assert.equal(res.status,200);
 assert.equal((await res.json()).personal_asset_transfer,true);
 assert.equal(t.entry().state,'synced');
 assert.equal(t.seen(),1);
 const replay=await commitPersonalSbiCandidate(request(),t.env,p,item,fields);
 assert.equal((await replay.json()).already_synced,true);
 assert.equal(t.seen(),1);
 assert.equal((await personalSbiReceiptStatus(t.env,p,candidate)).state,'active');
});
test('member SBI transfer refuses unreviewed amount, forged user and changed source',async()=>{
 const t=setup();
 await assert.rejects(commitPersonalSbiCandidate(request(),t.env,p,item,new Map()),
  err=>err.code==='PERSONAL_SBI_REVIEW_REQUIRED');
 const blocked=await commitPersonalSbiCandidate(request(),t.env,{...p,role:'owner'},item,fields);
 assert.equal(blocked.status,503);
 await assert.rejects(commitPersonalSbiCandidate(request({transfer_date:'2030-20-99'}),t.env,p,item,fields),
  err=>err.code==='PERSONAL_SBI_DATE_REQUIRED');
 assert.equal(t.seen(),0);
});
