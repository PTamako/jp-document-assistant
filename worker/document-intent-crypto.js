// The frozen source snapshot is encrypted with a dedicated server secret.
// Its identity, target and digest are authenticated, not trusted from storage.
const encoder=new TextEncoder();
const b64=bytes=>btoa(String.fromCharCode(...bytes));
const unb64=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
export function documentIntentKeyReady(env){
 return typeof env.DOCUMENT_INTENT_ENCRYPTION_KEY==='string'&&
  /^[a-f0-9]{64}$/i.test(env.DOCUMENT_INTENT_ENCRYPTION_KEY);
}
async function key(env){
 if(!documentIntentKeyReady(env))throw Error('intent key unavailable');
 return crypto.subtle.importKey('raw',Uint8Array.from(
  env.DOCUMENT_INTENT_ENCRYPTION_KEY.match(/.{2}/g),x=>parseInt(x,16)),
  {name:'AES-GCM'},false,['encrypt','decrypt']);
}
function aad(row){
 return encoder.encode(JSON.stringify(['document-intent-v1',row.candidate_id,
  row.document_id,row.local_user_id,row.homeflow_user_id,row.homeflow_household_id,
  row.target_app,row.candidate_kind,row.document_version,row.candidate_updated_at,
  row.payload_sha256]));
}
export async function sealDocumentIntent(env,row,plaintext){
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(row)},
  await key(env),encoder.encode(plaintext));
 return {payload_cipher:b64(new Uint8Array(cipher)),payload_iv:b64(iv)};
}
export async function openDocumentIntent(env,row){
 const iv=unb64(row.payload_iv);
 if(iv.length!==12)throw Error('invalid intent iv');
 const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad(row)},
  await key(env),unb64(row.payload_cipher));
 return new TextDecoder('utf-8',{fatal:true}).decode(plaintext);
}
