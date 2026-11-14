import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,createHmac} from 'node:crypto';
import {verifiedDocumentFinanceAccount} from '../worker/document-finance-account.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const member='22222222-2222-4222-8222-222222222222',id='a'.repeat(32);
const principal={auth_source:'homeflow',role:'member',
  homeflow_user_id:member,homeflow_household_id:'primary'};
function setup(){
  let calls=0,bogus=null;
  const env={DOCUMENT_ACCOUNT_VERIFY_ENABLED:'true',
    DOCUMENT_ACCOUNT_VERIFICATION_SECRET:'b'.repeat(64),
    KAKEIBO_DOCUMENT_ACCOUNT_SERVICE:{async fetch(request){
      calls++;
      assert.equal(request.headers.get('origin'),null);
      assert.equal(request.headers.get('cookie'),null);
      assert.equal(request.headers.get('authorization'),null);
      assert.equal(request.redirect,'manual');
      const raw=await request.text(),stamp=request.headers.get('x-approval-timestamp');
      const signature=createHmac('sha256',Buffer.from('b'.repeat(64),'hex'))
        .update('jpda:finance-account\n'+stamp+'\n'+raw).digest('hex');
      assert.equal(request.headers.get('x-approval-signature'),signature);
      assert.equal(request.headers.get('x-approval-client'),'jp-document-assistant');
      assert.deepEqual(JSON.parse(raw),{account_id:id,household_id:'primary',
        requester_user_id:member,entry_type:'expense'});
      return Response.json({ok:true,verified:true,applied:false,account_id:id,
        owner_user_id:member,household_id:'primary',account_kind:'cash',
        account_version:1,label:'现金',origin:'member_created',...bogus});
    }}
  };
  return {env,getCalls:()=>calls,change:v=>{bogus=v}};
}
test('document finance binds signed stable account/version to original member without sending raw content',async()=>{
 const f=setup();
 const proof=await verifiedDocumentFinanceAccount(f.env,principal,id,'expense','现金');
 assert.deepEqual(proof,{account_id:id,account_version:1,account_kind:'cash'});
 assert.equal(f.getCalls(),1);
 f.change({owner_user_id:'other'});
 await assert.rejects(verifiedDocumentFinanceAccount(f.env,principal,id,'expense','现金'),
   x=>x.code==='ACCOUNT_PROOF_MISMATCH');
 f.change({account_version:0});
 await assert.rejects(verifiedDocumentFinanceAccount(f.env,principal,id,'expense','现金'),
   x=>x.code==='ACCOUNT_PROOF_MISMATCH');
 f.change({account_kind:'credit_card'});
 await assert.rejects(verifiedDocumentFinanceAccount(f.env,principal,id,'expense','现金'),
   x=>x.code==='ACCOUNT_PROOF_MISMATCH');
});
test('document finance never guesses from same-name or non-executable type',async()=>{
 const f=setup();
 await assert.rejects(verifiedDocumentFinanceAccount(f.env,principal,'','expense','现金'),
   x=>x.code==='STABLE_ACCOUNT_REQUIRED');
 await assert.rejects(verifiedDocumentFinanceAccount(f.env,principal,id,'transfer','现金'),
   x=>x.code==='FINANCE_TYPE_NOT_EXECUTABLE');
 await assert.rejects(verifiedDocumentFinanceAccount(f.env,{...principal,role:'owner'},id,'expense','现金'),
   x=>x.code==='HOMEFLOW_MEMBER_REQUIRED');
 await assert.rejects(verifiedDocumentFinanceAccount(f.env,principal,id,'expense','信用卡'),
   x=>x.code==='ACCOUNT_PROOF_MISMATCH');
 assert.equal(f.getCalls(),1);
 f.env.DOCUMENT_ACCOUNT_VERIFY_ENABLED='false';
 await assert.rejects(verifiedDocumentFinanceAccount(f.env,principal,id,'expense','现金'),
   x=>x.code==='ACCOUNT_PROOF_UNAVAILABLE');
});

test('signed stable account list keeps duplicate labels distinct and rejects owner access',async()=>{
 const {listDocumentFinanceAccounts}=await import('../worker/document-finance-account.js');
 const p={auth_source:'homeflow',role:'member',homeflow_user_id:member,
  homeflow_household_id:'primary'};
 const env={DOCUMENT_ACCOUNT_VERIFY_ENABLED:'true',
  DOCUMENT_ACCOUNT_VERIFICATION_SECRET:'b'.repeat(64),
  KAKEIBO_DOCUMENT_ACCOUNT_SERVICE:{async fetch(req){
   assert.equal(req.headers.get('origin'),null);
   const raw=await req.text(),stamp=req.headers.get('x-approval-timestamp');
   assert.equal(req.headers.get('x-approval-signature'),
    createHmac('sha256',Buffer.from('b'.repeat(64),'hex'))
     .update('jpda:finance-account\n'+stamp+'\n'+raw).digest('hex'));
   assert.deepEqual(JSON.parse(raw),{household_id:'primary',requester_user_id:member});
   return Response.json({ok:true,verified:true,applied:false,accounts:[
    {account_id:'a'.repeat(32),label:'现金',account_kind:'cash',account_version:1},
    {account_id:'d'.repeat(32),label:'现金',account_kind:'cash',account_version:2}]});
  }}
 };
 const res=await listDocumentFinanceAccounts(env,p);
 assert.equal(res.status,200);
 const rows=(await res.json()).accounts;
 assert.equal(rows.length,2);
 assert.equal(rows[0].label,rows[1].label);
 assert.notEqual(rows[0].account_id,rows[1].account_id);
 await assert.rejects(listDocumentFinanceAccounts(env,{...p,role:'owner'}),
  e=>e.code==='HOMEFLOW_MEMBER_REQUIRED');
});
