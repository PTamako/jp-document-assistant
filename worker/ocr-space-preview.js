import {json,failure,bad} from './http.js';
import {parseOcrSpaceResult} from './ocr-space.js';

// Private documents are never uploaded to R2 by this route. Users explicitly
// authorize ONE already-rasterized page before the browser sends it here.
// Both this endpoint and attachment OCR share the same UTC application quota.
export async function ocrSpaceImportPreview(request,env,p){
  if(!env.OCR_SPACE_API_KEY||env.OCR_SPACE_FREE_ONLY_CONFIRMED!=='true')
    return failure('OCR_SPACE_NOT_CONFIGURED','OCR.space 免费密钥尚未配置；没有发送文件',503);
  const sizeHeader=Number(request.headers.get('content-length')||0);
  if(sizeHeader>1150000)return failure('OCR_PREVIEW_TOO_LARGE','单页图片和表单超过免费额度，请降低扫描图片大小',413);
  if(!/^multipart\/form-data;/i.test(request.headers.get('content-type')||''))
    bad('需要上传单张扫描页图片','INVALID_PREVIEW_TYPE',415);
  let form;
  try{form=await request.formData();}catch{bad('无法读取扫描页图片','INVALID_PREVIEW',400);}
  if(form.get('confirm_ocr_space')!=='true'||form.get('confirm_private_upload')!=='true')
    bad('需要明确确认第三方上传；不会自动调用 OCR.space','OCR_CONSENT_REQUIRED',409);
  const file=form.get('file');
  if(!(file instanceof Blob)||file.size<100||file.size>900*1024||file.type!=='image/jpeg')
    return failure('OCR_PREVIEW_FILE_INVALID','仅接受最大 900KB 的 JPEG 扫描页（PDF 请先在本机转换所选页）',422);
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(bytes.length!==file.size||bytes[0]!==0xff||bytes[1]!==0xd8||bytes[bytes.length-2]!==0xff||bytes[bytes.length-1]!==0xd9)
    return failure('OCR_PREVIEW_FILE_INVALID','上传的扫描图片格式不正确，未调用第三方',422);
  const day=new Date().toISOString().slice(0,10);
  const n=Number(env.OCR_APP_UTC_DAILY_LIMIT??1);
  const limit=Number.isSafeInteger(n)?Math.max(0,Math.min(3,n)):0;
  if(!limit)return failure('OCR_BUDGET_DISABLED','本应用暂未开放第三方 OCR 请求额度',503);
  await env.DB.prepare('INSERT OR IGNORE INTO ocr_app_utc_daily(day_utc) VALUES(?)').bind(day).run();
  const claim=await env.DB.prepare(
    'UPDATE ocr_app_utc_daily SET calls=calls+1 WHERE day_utc=? AND calls+reserved<?'
  ).bind(day,limit).run();
  if(claim.meta?.changes!==1)
    return failure('OCR_BUDGET_EXHAUSTED','今天的云端 OCR 次数已用完，请明天再试或人工填写文字',429);
  // No original document, decoded page image, or key is written to D1/R2/logs.
  try{
    const body=new FormData();
    body.append('file',new Blob([bytes],{type:'image/jpeg'}),'scanned-page.jpg');
    body.append('OCREngine','3');
    body.append('language','auto');
    body.append('scale','true');
    const fetcher=env.OCR_SPACE_FETCH||fetch;
    const res=await fetcher('https://api.ocr.space/parse/image',{
      method:'POST',headers:{apikey:env.OCR_SPACE_API_KEY},body,
      signal:AbortSignal.timeout(25000)
    });
    if(!res.ok)return failure('OCR_PROVIDER_HTTP_ERROR','OCR.space 服务暂时不可用，请稍后再试',503);
    const data=await res.json();
    const text=parseOcrSpaceResult(data);
    if(!text)return failure('OCR_PREVIEW_EMPTY','OCR.space 没有识别出有效日文，请核对扫描页清晰度',422);
    return json({ok:true,text,verified:false,provider:'OCR.space Engine 3',uploaded_pages:1,
      warning:'第三方识别结果仅是候选；请核对原文后再保存，未写入文书或其他 App'});
  }catch{
    return failure('OCR_PROVIDER_FAILED','OCR.space 本次调用失败，已保留原文件和手工输入内容',503);
  }
}
