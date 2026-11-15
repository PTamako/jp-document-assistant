// iOS standalone PWA may resume after another tab changes the HttpOnly cookie.
// Never reuse private in-memory documents, Gmail/Drive OAuth or R2 preview
// based only on the old Vue user ref.
export async function verifyDocumentPwaSessionOnResume(expectedUserId,request=fetch){
 if(typeof expectedUserId!=='string'||expectedUserId.length<1||
  expectedUserId.length>128)return false;
 try{
  const response=await request('/api/me',{method:'GET',
   credentials:'same-origin',cache:'no-store',redirect:'error'});
  if(!response.ok)return false;
  const data=await response.json();
  return data?.user?.id===expectedUserId;
 }catch{return false;}
}
