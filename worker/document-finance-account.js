// Finance approvals must reference a stable account actually owned by the
// originating HomeFlow member. Never map a display name to an account ID.
import {bad,json} from './http.js';
const hex64=/^[0-9a-f]{64}$/i;
const hex32=/^[0-9a-f]{32}$/i;
async function mac(secret,stamp,raw){
  const key=await crypto.subtle.importKey('raw',
    Uint8Array.from(secret.match(/.{2}/g),x=>parseInt(x,16)),
    {name:'HMAC',hash:'SHA-256'},false,['sign']);
  const result=await crypto.subtle.sign('HMAC',key,
    new TextEncoder().encode('jpda:finance-account\n'+stamp+'\n'+raw));
  return Array.from(new Uint8Array(result),x=>x.toString(16).padStart(2,'0')).join('');
}
export async function verifiedDocumentFinanceAccount(env,principal,accountId,entryType,paymentSource){
  if(typeof accountId!=='string'||!hex32.test(accountId))
    bad('请选择家計簿已验证的稳定金融账户 ID，不能只填支付方式名称',
      'STABLE_ACCOUNT_REQUIRED',422);
  if(!['expense','income'].includes(entryType))
    bad('非现金金融业务必须使用独立的会计执行器',
      'FINANCE_TYPE_NOT_EXECUTABLE',409);
  if(principal?.auth_source!=='homeflow'||principal?.role!=='member'||
    !principal.homeflow_user_id||!principal.homeflow_household_id)
    bad('HomeFlow 成员身份验证失败','HOMEFLOW_MEMBER_REQUIRED',403);
  if(env.DOCUMENT_ACCOUNT_VERIFY_ENABLED!=='true'||
    !hex64.test(env.DOCUMENT_ACCOUNT_VERIFICATION_SECRET||'')||
    typeof env.KAKEIBO_DOCUMENT_ACCOUNT_SERVICE?.fetch!=='function')
    bad('稳定金融账户验证暂不可用，没有生成审批申请','ACCOUNT_PROOF_UNAVAILABLE',503);
  const data={account_id:accountId,household_id:principal.homeflow_household_id,
    requester_user_id:principal.homeflow_user_id,entry_type:entryType};
  const raw=JSON.stringify(data),stamp=String(Date.now());
  let response,proof;
  try{
    response=await env.KAKEIBO_DOCUMENT_ACCOUNT_SERVICE.fetch(new Request(
      'https://kakeibo.internal/api/internal/document-accounts/verify',{
        method:'POST',redirect:'manual',headers:{'content-type':'application/json',
          'accept':'application/json','x-approval-client':'jp-document-assistant',
          'x-approval-timestamp':stamp,
          'x-approval-signature':await mac(env.DOCUMENT_ACCOUNT_VERIFICATION_SECRET,stamp,raw)},
        body:raw
      }));
    if(response.status!==200||response.headers.has('location'))
      bad('家計簿未验证该账户，申请不会提交','ACCOUNT_NOT_VERIFIED',409);
    const answer=await response.text();
    if(answer.length>1200)throw Error('oversized account proof');
    proof=JSON.parse(answer);
  }catch(err){
    if(err?.code==='ACCOUNT_NOT_VERIFIED')throw err;
    bad('无法获取家計簿可信账户验证，请稍后重试','ACCOUNT_PROOF_UNAVAILABLE',503);
  }
  if(proof?.ok!==true||proof.verified!==true||proof.applied!==false||
    proof.account_id!==accountId||
    proof.owner_user_id!==principal.homeflow_user_id||
    proof.household_id!==principal.homeflow_household_id||
    proof.account_kind!=='cash'||proof.origin!=='member_created'||
    !Number.isSafeInteger(proof.account_version)||proof.account_version<1||
    typeof proof.label!=='string'||!proof.label||
    proof.label!==paymentSource)
    bad('金融账户归属、状态或显示名称已变化，请重新选择',
      'ACCOUNT_PROOF_MISMATCH',409);
  return {account_id:proof.account_id,account_version:proof.account_version,
    account_kind:proof.account_kind};
}

export async function listDocumentFinanceAccounts(env,p){
 if(p?.auth_source!=='homeflow'||p.role!=='member'||
   !p.homeflow_user_id||!p.homeflow_household_id)
  bad('请先使用 HomeFlow 成员身份登录','HOMEFLOW_MEMBER_REQUIRED',403);
 if(env.DOCUMENT_ACCOUNT_VERIFY_ENABLED!=='true'||
  !hex64.test(env.DOCUMENT_ACCOUNT_VERIFICATION_SECRET||'')||
  typeof env.KAKEIBO_DOCUMENT_ACCOUNT_SERVICE?.fetch!=='function')
  bad('家計簿账户选项不可用','ACCOUNT_PROOF_UNAVAILABLE',503);
 const wire={household_id:p.homeflow_household_id,
  requester_user_id:p.homeflow_user_id},stamp=String(Date.now()),raw=JSON.stringify(wire);
 let result;
 try{
  const res=await env.KAKEIBO_DOCUMENT_ACCOUNT_SERVICE.fetch(new Request(
   'https://kakeibo.internal/api/internal/document-accounts/list',{
    method:'POST',redirect:'manual',headers:{'content-type':'application/json',
    'x-approval-client':'jp-document-assistant','x-approval-timestamp':stamp,
    'x-approval-signature':await mac(env.DOCUMENT_ACCOUNT_VERIFICATION_SECRET,stamp,raw)},
    body:raw}));
  if(res.status!==200||res.headers.has('location'))
   bad('尚未验证本人金融账户','ACCOUNT_SELECTION_UNAVAILABLE',409);
  const rawResult=await res.text();
  if(rawResult.length>14000)throw Error('oversized response');
  result=JSON.parse(rawResult);
 }catch(err){
  if(err?.code==='ACCOUNT_SELECTION_UNAVAILABLE')throw err;
  bad('无法读取家計簿本人金融账户','ACCOUNT_PROOF_UNAVAILABLE',503);
 }
 const rows=result?.accounts;
 if(result?.ok!==true||result.verified!==true||result.applied!==false||
  !Array.isArray(rows)||rows.length>100||
  rows.some(a=>!a||!hex32.test(a.account_id||'')||
   typeof a.label!=='string'||!a.label||a.label.length>80||
   a.account_kind!=='cash'||!Number.isSafeInteger(a.account_version)||
   a.account_version<1)||
  new Set(rows.map(a=>a.account_id)).size!==rows.length)
  bad('家計簿账户身份验证结果异常','ACCOUNT_PROOF_MISMATCH',409);
 return json({ok:true,accounts:rows.map(a=>({
  account_id:a.account_id,label:a.label,account_version:a.account_version,
  account_kind:'cash'}))});
}
