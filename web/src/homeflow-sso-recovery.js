// Five-minute, one-use HomeFlow OAuth resume proof for the installed iOS PWA.
// Safari can destroy the original WebView and its sessionStorage during the
// external authorization handoff. IndexedDB belongs to the installed app
// origin (not Safari), survives that restart, and is wiped on completion/logout.
// This is NOT a HomeFlow access token or a durable login credential.
const DB_NAME='da-homeflow-sso-temporary';
const DB_VERSION=1;
const STORE_NAME='authorization';
const RECORD_KEY='current';
const MAX_LIFETIME_MS=300000;
export function validHomeflowSsoPending(value,now=Date.now()){
 return value!==null && typeof value==='object' &&
  /^[a-f0-9]{64}$/.test(value.state||'') &&
  /^[a-f0-9]{64}$/.test(value.resume_secret||'') &&
  Number.isFinite(value.until) && value.until>now &&
  value.until<=now+MAX_LIFETIME_MS;
}

function transaction(action,payload,provider=globalThis.indexedDB){
 return new Promise((resolve,reject)=>{
  if(!provider||typeof provider.open!=='function')
   return reject(new Error('设备不支持临时授权凭证恢复'));
  let request;
  try{request=provider.open(DB_NAME,DB_VERSION);}catch(error){reject(error);return;}
  request.onupgradeneeded=()=>{
   if(!request.result.objectStoreNames.contains(STORE_NAME))
    request.result.createObjectStore(STORE_NAME);
  };
  request.onerror=()=>reject(request.error||new Error('无法打开授权存储'));
  request.onblocked=()=>reject(new Error('授权存储暂时被占用'));
  request.onsuccess=()=>{
   const db=request.result;
   let tx,operation,value;
   try{
    tx=db.transaction(STORE_NAME,action==='get'?'readonly':'readwrite');
    const store=tx.objectStore(STORE_NAME);
    operation=action==='get'?store.get(RECORD_KEY):
     action==='put'?store.put(payload,RECORD_KEY):store.delete(RECORD_KEY);
   }catch(error){db.close();reject(error);return;}
   operation.onsuccess=()=>{value=operation.result;};
   tx.oncomplete=()=>{db.close();resolve(value);};
   tx.onerror=()=>{db.close();reject(tx.error||new Error('授权存储失败'));};
   tx.onabort=()=>{db.close();reject(tx.error||new Error('授权存储已取消'));};
  };
 });
}
export async function persistHomeflowSsoRecovery(pending,store=null){
 if(!validHomeflowSsoPending(pending))
  throw new Error('HomeFlow 授权请求已过期');
 if(store)return store.put(pending);
 return transaction('put',pending);
}
export async function restoreHomeflowSsoRecovery(store=null){
 let pending=store?await store.get():await transaction('get');
 if(validHomeflowSsoPending(pending))return pending;
 if(pending)await clearHomeflowSsoRecovery(store);
 return null;
}
export async function clearHomeflowSsoRecovery(store=null){
 if(store)return store.delete();
 return transaction('delete');
}
