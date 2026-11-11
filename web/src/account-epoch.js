// Volatile browser-session epoch; all in-flight private responses must match it.
// No localStorage/IndexedDB, cookies, event bus, network or persistent secrets.
export function createAccountEpoch(){
  let epoch=0;
  return {
    snapshot:()=>epoch,
    isCurrent:(token)=>token===epoch,
    invalidate:()=>++epoch,
    assertCurrent:(token)=>{
      if(token!==epoch)throw new Error('账号会话已改变，已丢弃旧页面的请求结果');
    }
  };
}
