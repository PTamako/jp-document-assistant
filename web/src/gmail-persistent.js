// Google Identity Services authorization-code popup. The code is delivered
// directly to the same-origin Cloudflare Worker; it never persists in PWA storage.
// Access + refresh tokens remain server-side, encrypted at rest.
const SCOPE='https://www.googleapis.com/auth/gmail.readonly';

export function gmailAuthorizePersistent({clientId,exchangeCode,google=typeof window==='undefined'?null:window.google}){
 if(!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(String(clientId||'')))
   return Promise.reject(new Error('Google OAuth 客户端尚未准备好'));
 if(typeof exchangeCode!=='function')
   return Promise.reject(new Error('Gmail 安全授权接口不可用'));
 if(!google?.accounts?.oauth2?.initCodeClient)
   return Promise.reject(new Error('Google 授权组件未准备好，请稍后重试'));
 return new Promise((resolve,reject)=>{
   let settled=false;
   const timer=setTimeout(()=>finish(new Error('Google Gmail 授权等待超时，请重新点击连接')),60000);
   function finish(error,result){
     if(settled)return;
     settled=true;clearTimeout(timer);
     if(error)reject(error);else resolve(result);
   }
   try{
     const client=google.accounts.oauth2.initCodeClient({
       client_id:clientId,scope:SCOPE,ux_mode:'popup',
       include_granted_scopes:false,
       error_callback:e=>{
         const reason=e?.type==='popup_failed_to_open'?'Google 授权窗口被 PWA 阻止':
           e?.type==='popup_closed'?'已关闭 Google 授权窗口':'Google 授权窗口无法使用';
         finish(new Error(reason+'。iOS 可能限制 Google 官方登录；无需关闭设备的隐私保护。'));
       },
       callback:response=>{
         if(settled)return;
         if(response?.error||typeof response?.code!=='string'||!response.code)
           return finish(new Error('Google Gmail 授权没有返回有效的授权码'));
         Promise.resolve().then(()=>exchangeCode(response.code)).then(result=>{
           if(!result?.connected)return finish(new Error('Gmail 长期连接未完成'));
           finish(null,result);
         }).catch(finish);
       }
     });
     // Must run in the original click callback, before any await.
     client.requestCode();
   }catch{
     finish(new Error('当前 PWA 无法打开 Google 官方授权窗口'));
   }
 });
}
