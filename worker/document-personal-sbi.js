// Member-only document-confirmed SBI capital movement. This does not claim a
// broker purchase, create lots or a bank/card account. A private, signed target
// journal is the only executor; the legacy owner-ledger bridge is never used.
import {randomToken,hashString,isoNow} from './security.js';
import {bad,readJson,json,failure} from './http.js';
import {inferSbiInvestmentKind} from '../shared/sbi-investment.js';
const id=/^[a-f0-9]{32}$/i,hex=/^[a-f0-9]{64}$/i;
const date=s=>typeof s==='string'&&/^20\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s)&&
 !Number.isNaN(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
async function mac(secret,domain,stamp,raw){
 const key=await crypto.subtle.importKey('raw',
  Uint8Array.from(secret.match(/.{2}/g),x=>parseInt(x,16)),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signed=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(domain+'\n'+stamp+'\n'+raw));
 return Array.from(new Uint8Array(signed),x=>x.toString(16).padStart(2,'0')).join('');
}
export function personalSbiReady(env,p){
 return p?.role==='member'&&p?.auth_source==='homeflow'&&
 !!p.homeflow_user_id&&!!p.homeflow_household_id&&
 env.HOMEFLOW_SSO_ENABLED==='true'&&hex.test(env.DOCUMENT_FINANCE_TARGET_SECRET||'')&&
 typeof env.KAKEIBO_DOCUMENT_FINANCE_SERVICE?.fetch==='function';
}
function fieldsFromCandidate(item,checked,body,p){
 const original=JSON.parse(item.payload_json||'{}');
 const amount=Number(checked.get('amount_jpy'));
 const merchant=String(checked.get('merchant')||original.merchant||'').trim();
 const purpose=inferSbiInvestmentKind(merchant);
 if(!['expense','transfer'].includes(original.kind)||!purpose||!merchant||merchant.length>100||
  !Number.isSafeInteger(amount)||amount<1||amount>10000000||amount!==original.amount_jpy)
  bad('必须先核对 SBI 资金移动的原始金额和用途，不能生成不完整资产记录',
   'PERSONAL_SBI_REVIEW_REQUIRED',409);
 if(body?.payment_confirmed!==true||body.confirm!=='CONFIRM_ACCOUNTING'||
  !date(body.date)||!date(body.transfer_date))
  bad('请明确核对资金交易日和 SBI 生效日','PERSONAL_SBI_DATE_REQUIRED',409);
 if(typeof body.note!=='string'||body.note.length>180)
  bad('备注长度无效','INVALID_NOTE',400);
 return {source:'jp-document-assistant',source_document_id:item.document_id,
  source_candidate_id:item.id,household_id:p.homeflow_household_id,
  owner_user_id:p.homeflow_user_id,idempotency_key:'jda:personal-sbi:'+item.id,
  date:body.date,effective_date:body.transfer_date,
  amount_jpy:amount,purpose,merchant,note:body.note.trim(),confirmed:true};
}
const get=(db,id)=>db.prepare('SELECT * FROM integration_links WHERE candidate_id=? AND target=\'kakebo\'').bind(id).first();
const run=(db,s,...p)=>db.prepare(s).bind(...p).run();
async function signedFetch(env,path,body){
 const raw=JSON.stringify(body),stamp=String(Date.now());
 const sig=await mac(env.DOCUMENT_FINANCE_TARGET_SECRET,
  path==='execute'?'jpda:personal-sbi-execute':'jpda:personal-sbi-receipt',stamp,raw);
 const response=await env.KAKEIBO_DOCUMENT_FINANCE_SERVICE.fetch(new Request(
  'https://kakeibo.internal/api/internal/document-personal-sbi/'+path,{
   method:'POST',redirect:'manual',headers:{'content-type':'application/json',
    'x-approval-client':'jp-document-assistant','x-approval-timestamp':stamp,
    'x-approval-signature':sig},body:raw}));
 if(response.headers.has('location'))return {ok:false,status:503};
 const text=await response.text();if(text.length>2200)return {ok:false,status:503};
 const value=JSON.parse(text);return {ok:response.ok,status:response.status,value};
}
export async function personalSbiReceiptStatus(env,p,idValue){
 if(!personalSbiReady(env,p)||!id.test(idValue))return null;
 try{
  const body={source:'jp-document-assistant',source_candidate_id:idValue,
   household_id:p.homeflow_household_id,owner_user_id:p.homeflow_user_id,
   idempotency_key:'jda:personal-sbi:'+idValue};
  const r=await signedFetch(env,'receipt',body);
  return r.ok&&r.value?.ok===true&&r.value?.applied===true&&
   r.value.source_candidate_id===idValue&&r.value.owner_user_id===p.homeflow_user_id&&
   r.value.household_id===p.homeflow_household_id&&
   ['active','trashed'].includes(r.value.state)?r.value:null;
 }catch{return null}
}
export async function commitPersonalSbiCandidate(request,env,p,item,checked){
 if(!personalSbiReady(env,p))return failure('PERSONAL_SBI_EXECUTOR_DISABLED',
  '本人 SBI 资产转移执行器暂不可用；未写入记账本',503);
 const body=await readJson(request,9000),candidateId=item.id;
 const supplied=request.headers.get('Idempotency-Key');
 if(!supplied||!/^[a-zA-Z0-9._:-]{8,120}$/.test(supplied))
  bad('需要固定的幂等请求号','IDEMPOTENCY_REQUIRED',400);
 const wire=fieldsFromCandidate(item,checked,body,p);
 const raw=JSON.stringify(wire),digest=await hashString(raw);
 const previous=await get(env.DB,candidateId);
 if(previous?.state==='synced'||previous?.state==='linked_existing')
  return json({ok:true,already_synced:true,target:'kakebo',remote_id:previous.remote_id});
 if(previous?.request_fingerprint&&previous.request_fingerprint!==digest)
  return failure('PERSONAL_SBI_RETRY_CHANGED',
   '上次请求尚未确认。请保留原金额、日期与备注重试，避免重复转移',409);
 if(previous?.attempt_count>0&&!previous.request_fingerprint)
  return failure('PERSONAL_SBI_LEGACY_UNVERIFIED','旧联动状态未核对，未再次写入',409);
 const key=wire.idempotency_key,now=isoNow(),old=new Date(Date.now()-120000).toISOString();
 if(!previous){
  await run(env.DB,'INSERT OR IGNORE INTO integration_links'+
   '(id,candidate_id,target,idempotency_key,state,request_fingerprint,updated_at) '+
   'VALUES(?,?,\'kakebo\',?,\'pending\',?,?)',randomToken(16),candidateId,key,digest,now);
 }
 const updated=await run(env.DB,'UPDATE integration_links SET state=\'sending\',updated_at=?,'+
  'attempt_count=attempt_count+1,request_fingerprint=COALESCE(request_fingerprint,?) '+
  'WHERE candidate_id=? AND target=\'kakebo\' AND idempotency_key=? '+
  'AND (request_fingerprint=? OR request_fingerprint IS NULL) '+
  'AND (state IN (\'pending\',\'failed\') OR (state=\'sending\' AND updated_at<=?))',
  now,digest,candidateId,key,digest,old);
 if(updated.meta?.changes!==1){
  const other=await get(env.DB,candidateId);
  if(other?.state==='synced')return json({ok:true,already_synced:true,remote_id:other.remote_id,target:'kakebo'});
  return failure('PERSONAL_SBI_SENDING','同一 SBI 资产转移正在核对，不会重复发送',409);
 }
 let res;
 try{res=await signedFetch(env,'execute',wire);}
 catch{res={ok:false,status:503};}
 const receipt=res.value;
 if(res.ok&&receipt?.ok===true&&receipt?.applied===true&&
  receipt.source_candidate_id===candidateId&&
  receipt.owner_user_id===p.homeflow_user_id&&
  receipt.household_id===p.homeflow_household_id&&
  receipt.remote_id==='personal-sbi:'+candidateId&&
  ['active','trashed'].includes(receipt.state)){
  const done=await run(env.DB,'UPDATE integration_links SET state=\'synced\','+
   'remote_id=?,synced_at=?,last_error_code=NULL,updated_at=? WHERE candidate_id=? '+
   'AND target=\'kakebo\' AND state=\'sending\' AND updated_at=? AND request_fingerprint=?',
   receipt.remote_id,isoNow(),isoNow(),candidateId,now,digest);
  return done.meta?.changes===1
   ?json({ok:true,target:'kakebo',remote_id:receipt.remote_id,personal_asset_transfer:true})
   :failure('PERSONAL_SBI_RECEIPT_LOCAL_UNKNOWN','目标已记账，本地回执尚未确认；请核对',503);
 }
 const definite=res.status>=400&&res.status<500;
 await run(env.DB,'UPDATE integration_links SET state=\'failed\',last_error_code=?,updated_at=? '+
  'WHERE candidate_id=? AND target=\'kakebo\' AND state=\'sending\' AND updated_at=? AND request_fingerprint=?',
  definite?'PERSONAL_SBI_REJECTED':'PERSONAL_SBI_UNCONFIRMED',isoNow(),candidateId,now,digest);
 return failure(definite?'PERSONAL_SBI_REJECTED':'PERSONAL_SBI_UNCONFIRMED',
  definite?'记账本拒绝该 SBI 转移；未入账':'结果未确认；请核对后用同一候选重试，不会再生成新记录',
  definite?409:503);
}
