// Only the document's own session failure can clear the private workspace.
// Google OAuth can independently return 401 for an expired Gmail grant;
// that must NOT log the household member out of HomeFlow.
export function documentIdentityExpired(status,code){
 return status===401&&(code==='UNAUTHENTICATED'||code==='HOMEFLOW_LOGIN_REQUIRED');
}
