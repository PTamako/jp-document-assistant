export function json(data, status=200, extra={}) {
  return new Response(JSON.stringify(data), { status, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra} });
}
export const failure = (code,message,status=400) => json({ok:false,code,message},status);
export async function readJson(request,max=130000) {
  const length=Number(request.headers.get('Content-Length')||0);
  if(length>max) throw Object.assign(new Error('请求体过大'),{status:413,code:'BODY_TOO_LARGE'});
  const raw=await request.text();
  if(raw.length>max) throw Object.assign(new Error('请求体过大'),{status:413,code:'BODY_TOO_LARGE'});
  try{return JSON.parse(raw);}catch{throw Object.assign(new Error('JSON 格式不正确'),{status:400,code:'INVALID_JSON'});}
}
export function validString(v,max=200){return typeof v==='string' && v.trim().length>0 && v.length<=max;}
export function bad(message,code='INVALID_INPUT',status=400){throw Object.assign(new Error(message),{code,status});}
