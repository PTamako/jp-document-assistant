<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, nextTick, watch } from 'vue';
import { compressImage } from './compress.js';
import { readLocalText } from './mail-import.js';
import { drivePickerConfig,pickGoogleDriveFile,prepareGoogleDrivePicker,googlePickerReady,driveAuthorizationReady,forgetDriveAuthorization,revokeDriveAuthorization } from './google-drive-picker.js';
import { isIosStandalonePwa } from './google-auth-context.js';
import {gmailConfigured,gmailConnected,gmailForget,preloadGmailIdentity,gmailIdentityReady,gmailAuthorize,gmailList,gmailReadOne,gmailRevoke,gmailPayloadToDocument} from './gmail-import.js';
import { extractDocumentText } from './document-text.js';
import { exportBatch,readBackup,restoreBatch } from './backup-client.js';
import { createAccountEpoch } from './account-epoch.js';
import TabIcon from './TabIcon.vue';
import UiIcon from './UiIcon.vue';
import { invalidateDocumentLists } from './document-list-cache.js';
import { chineseExplanation } from './chinese-explanation.js';
import { studySyncState } from './study-sync-status.js';
import DocumentSwipeRow from './DocumentSwipeRow.vue';

const user=ref(null),csrf=ref(''),authMode=ref('login'),auth=reactive({email:'',password:'',setup_token:'',invite_token:'',display_name:''});
const initialized=ref(null);
const busy=ref(false),error=ref(''),notice=ref(''),activeTab=ref('today');
const passwordDraft=reactive({current_password:'',new_password:'',confirm_password:''});
const calendarLink=ref(''),calendarStatusInfo=ref(null),calendarShowTitle=ref(false);
const tabs=[{id:'today',name:'今日'},{id:'docs',name:'文书'},{id:'links',name:'联动'},{id:'mine',name:'我的'}];
const pages=reactive({today:{items:[],next:0,loaded:false},docs:{items:[],next:0,loaded:false},links:{items:[],next:0,loaded:false}});
const loadingPage=ref(false),search=ref(''),category=ref('');
const cats={salary:'工资／奖金',card_spend:'信用卡消费',bank:'银行／信用卡',topup:'电子钱包／充值',tax:'税务／缴纳',utility:'水电燃气',housing:'房屋租赁',campaign:'活动／优惠',policy:'法规／政策',manual:'使用说明',travel:'旅行交通',delivery:'配送订单',other:'其他'};
const categoryOptions=Object.entries(cats);
const categoryIcon=kind=>({salary:'wallet',card_spend:'wallet',bank:'wallet',topup:'wallet',tax:'file-text',utility:'file-text',housing:'file-text',campaign:'tag',policy:'shield',manual:'book',travel:'calendar',delivery:'archive'}[kind]||'file');
const candidateIcon=kind=>({finance:'wallet',homeflow_task:'today',vocabulary:'book',sentence:'book'}[kind]||'links');
const integrationLabel=state=>({synced:'已同步',linked_existing:'已关联',failed:'同步失败',pending:'待确认'}[state]||'待确认');
const current=ref(null),detailTab=ref('explain'),detailCandidates=ref([]),detailLoading=ref(false),amountVisible=ref(false);
// Preserve exact retry fields in memory while the app stays open.
const pendingCandidateRetry=ref(null);
const ledgerOptions=ref({categories:[],paymentSources:[]}),ledgerOptionsError=ref(''),ledgerAttempted=ref(false),ledgerMappingChangeConfirmed=ref(false),candidateMerchant=ref('');
const aiAnalysis=computed(()=>current.value?.ai_analysis?.result||null);
const explanationExpanded=ref(false),ocrTextExpanded=ref(false);
const attachmentActionsTarget=ref(null);
const selectedAttachment=computed(()=>current.value?.attachments?.find(a=>a.id===attachmentActionsTarget.value?.id)||null);
const explanationText=computed(()=>chineseExplanation(aiAnalysis.value?.explanation_zh||current.value?.explanation_zh||''));
const explanationPreview=computed(()=>{
 const summary=String(aiAnalysis.value?.summary_zh||'').trim();
 // The full explanation stays accessible; use a concise overview when key points exist.
 return summary&&aiAnalysis.value?.important_points_zh?.length?chineseExplanation(summary):explanationText.value;
});
const campaignPendingDate=computed(()=>current.value?.category==='campaign'&&
 current.value?.fields?.some(f=>f.field_key==='due_date_partial'&&f.review_state!=='rejected')&&
 !detailCandidates.value.some(c=>c.candidate_kind==='homeflow_task'));
const aiStatusLabel={success:'AI 已分析',pending:'AI 处理中',failed:'AI 上次分析失败'};
const aiFailureLabels={
 gemini_quota_or_rate_limited:'Gemini 配额或请求频率受限',
 gemini_daily_limit:'Gemini 今日 20 次已用完（美西午夜重置）',
 gemini_minute_limit:'Gemini 每分钟最多 5 次，请稍后重试',
 gemini_budget_unavailable:'Gemini 次数暂无法核验，已停止调用',
 gemini_access_denied:'Gemini 密钥、权限或地区受限',
 gemini_model_unavailable:'Gemini 模型暂不可用',
 gemini_invalid_request:'Gemini 请求参数有误',
 gemini_service_unavailable:'Google 服务异常（5xx），请稍后再试',
 gemini_service_overloaded:'Google 服务器繁忙（503），请稍后再试',
 gemini_retry_cooldown:'Google 服务器繁忙，请稍后再试',
 gemini_request_failed:'Gemini 请求失败',
 gemini_network_error:'Gemini 网络连接失败',
 gemini_invalid_response:'Gemini 响应无法读取',
 gemini_output_truncated:'Gemini 输出被截断',
 gemini_content_blocked:'Gemini 内容审核未通过',
 gemini_empty_response:'Gemini 未返回可用文字',
 gemini_invalid_json:'Gemini 返回格式不完整',
 cloudflare_invalid_json:'Workers AI 返回格式不正确',
 cloudflare_output_truncated:'Workers AI 输出被截断',
 cloudflare_empty_response:'Workers AI 没有返回内容',
 cloudflare_output_blocked:'Workers AI 拒绝生成内容',
 cloudflare_timeout:'Workers AI 响应超时',
 cloudflare_rate_limited:'Workers AI 请求过于频繁',
 cloudflare_model_unavailable:'Workers AI 模型暂不可用',
 cloudflare_invalid_request:'Workers AI 请求参数出错',
 cloudflare_service_unavailable:'Workers AI 服务暂时不可用',
 provider_failed:'AI 分析失败'
};
const aiFailureMessage=computed(()=>current.value?.ai_analysis?.status==='failed'
 ?(aiFailureLabels[current.value.ai_analysis.failure_code]||'AI 分析失败'):'');
const swipeOpenId=ref(''),swipeTrashTarget=ref(null);
const sheet=ref(''),textDraft=reactive({title:'',text:'',retention:'summary',source_type:'text'}),fileDraft=ref(null),fileInput=ref(null),localTextInput=ref(null),localImportNote=ref(''),inputMode=ref('text');
const fileText=ref(''),fileWarning=ref(''),fileRetention=ref('original'),fileSource=ref('local_file'),ocrProgress=ref('');
// Consent is per selected file/page; never persisted in settings or retained after closing the import sheet.
const importOcrSpaceConsent=ref(false),importOcrSpacePage=ref(1),importPdfPages=ref(1),importOcrEngine=ref('local');
const drivePickerAvailable=!!drivePickerConfig();
const iosStandalonePwa=isIosStandalonePwa();
const mainSiteUrl=typeof window==='undefined'?'':window.location.origin+'/';
const drivePickerReadyUi=ref(false),drivePickerLoadingUi=ref(false);
const driveCloud=ref({enabled:false,connected:false,google_email:null});
const driveItems=ref([]),driveNext=ref(''),driveQuery=ref(''),driveBusy=ref(false);
const googlePending=ref({service:'',flow:''});
const gmailAvailable=gmailConfigured(),gmailAuthorizedUi=ref(false),gmailIdentityReadyUi=ref(false),gmailIdentityLoadingUi=ref(false),gmailQuery=ref(''),gmailLastQuery=ref(''),gmailSearched=ref(false),gmailItems=ref([]),gmailNext=ref(null),gmailBusy=ref(false);
const gmailPersistent=ref({enabled:false,connected:false,google_email:null,client_id:''});
let gmailGeneration=0;
const salaryAmountDraft=ref(''),salaryAmountConfirmed=ref(false);
const fieldDraft=reactive({id:'',value:'',state:'confirmed',confirmRemote:false}),trashItems=ref([]),usage=ref(null),inviteEmail=ref(''),inviteToken=ref('');
const originalUrl=ref(''),originalMime=ref(''); let loadSerial=0;
const accountEpoch=createAccountEpoch();
let accountController=new AbortController();
const archivedFilter=ref('active'),favoriteFilter=ref('all'),visibilityFilter=ref('all'),monthFilter=ref('');
const editTextDraft=ref(''),backupFile=ref(null),backupPass=ref(''),backupScope=ref('all'),backupMonth=ref(''),backupIncludeOriginals=ref(true),backupOffset=ref(0),restoreArchive=ref(null),restorePreview=ref([]),attachmentTrashItems=ref([]);
const extraFileInput=ref(null),backupInput=ref(null),recycleNext=ref(null),recycleOffset=ref(0),recycleEmptyProgress=ref(0);
const pendingAttachment=ref(null),ocrAttachmentPending=ref(null),ocrRetryStale=ref(false),ocrRetryEmpty=ref(false),ocrSpaceConsent=ref(false),candidateDraft=reactive({id:'',kind:'',confirm:'',date:'',category:'',payment_source:'',note:'',visibility:'private',title:'',assignee:'',bonus_points:0,privacy_confirmed:false,redacted_term:'',redacted_sentence:''});
const integrationConfigured=ref(false);
// Selection belongs to THIS import only; never stored as a global/device default.
const aiProvider=ref(''),geminiConsent=ref(false),docAiProvider=ref('none'),docGeminiConsent=ref(false);
const sessions=ref([]),sessionsNext=ref(null);

const missingYearDateDraft=ref(''),missingYearConfirmed=ref(false);
const fieldLabel={due_date_partial:'原文截止日（月日）',required_action:'必须办理的事项',review_action:'需要确认的内容',merchant:'消费商户',deposit_from:'工资转入方',transaction_date:'交易日期',due_date:'办理／缴费期限',event_date:'扣款／配送日期',amount_jpy:'金额（日元）',net_salary:'实发金额（日元）',transaction_at:'交易完成时间',service_name:'服务名称',meter_period_start:'检针期间开始',meter_period_end:'检针期间结束',period_charge_jpy:'期间电费（日元）',usage_kwh:'用电量（kWh）',card_advance_date:'信用卡垫付日期'};
const candidateLabel={finance:'家計簿 · 待确认记账',homeflow_task:'HomeFlow 待办',vocabulary:'知学生词',sentence:'知学句子'};
const canManualSalary=computed(()=>current.value?.category==='salary'&&!current.value?.fields?.some(f=>f.field_key==='net_salary')&&/(?:入金内容|振込(?:による)?ご入金|振込入金)/.test(String(current.value?.extracted_text_ja||'').normalize('NFKC')));
const topupAdvice=computed(()=>{
  if(current.value?.category!=='topup')return null;
  const fields=Array.isArray(current.value.fields)?current.value.fields:[];
  const field=key=>fields.find(f=>f.field_key===key&&f.review_state!=='rejected')||null;
  const amount=field('amount_jpy');
  const stamp=field('transaction_at');
  const service=field('service_name');
  const raw=String(current.value.extracted_text_ja||'');
  const destination=/Suica/i.test(raw)?'Suica':/PASMO/i.test(raw)?'PASMO':/PayPay/i.test(raw)?'PayPay':'待确认';
  const amountNumber=Number(amount?.normalized_value);
  return {
    amount:Number.isSafeInteger(amountNumber)&&amountNumber>0?amountNumber.toLocaleString('ja-JP')+'円':'待核验',
    time:stamp?.normalized_value||'待核验',
    service:service?.normalized_value||'未提取',
    destination,
    reviewed:amount?.review_state==='confirmed'||amount?.review_state==='corrected'
  };
});
function documentReviewLabel(d){
 const state=d?.review_status || (
  Array.isArray(d?.fields)&&d.fields.length ?
  (d.fields.every(f=>f.review_state!=='unreviewed')?'reviewed':
   d.fields.some(f=>f.review_state!=='unreviewed')?'partial':'unreviewed'):'none'
 );
 if(state==='reviewed')return '已核验';
 if(state==='partial')return '部分核验';
 return d?.analysis_status==='needs_review'?'待核验':'已保存';
}

const choiceField=ref(''),choiceReturnSheet=ref(''),choiceSearch=ref('');
const choices={
 category:{title:'文书类型',items:[{value:'',label:'全部类型'},...categoryOptions.map(([value,label])=>({value,label}))]},
 visibility:{title:'可见范围',items:[{value:'all',label:'全部'},{value:'mine',label:'我拥有的'},{value:'shared',label:'家庭共享'}]},
 archived:{title:'归档状态',items:[{value:'active',label:'未归档'},{value:'archived',label:'已归档'},{value:'all',label:'全部'}]},
 favorite:{title:'收藏',items:[{value:'all',label:'全部'},{value:'yes',label:'仅收藏'}]},
 aiProvider:{title:'本份文书 AI 引擎',items:[{value:'none',label:'仅规则'},{value:'cloudflare',label:'Cloudflare Workers AI'},{value:'gemini',label:'Gemini 3.6 Flash'}]},
 docAiProvider:{title:'当前文书 AI 引擎',items:[{value:'none',label:'仅规则'},{value:'cloudflare',label:'Cloudflare Workers AI'},{value:'gemini',label:'Gemini 3.6 Flash'}]},
 textSource:{title:'文书来源',items:[{value:'text',label:'粘贴文本'},{value:'mail_forward',label:'苹果邮件复制 / 转发'},{value:'gmail',label:'Gmail 逐封选择'},{value:'google_drive',label:'Google Drive 复制'},{value:'local_file',label:'本地文档文本'}]},
 textRetention:{title:'保存方式',items:[{value:'summary',label:'保存文字和分析结果'},{value:'analyze_only',label:'仅分析，不保存'}]},
 importOcrEngine:{title:'识别方式',items:[{value:'local',label:'本机 PaddleOCR'},{value:'workers_ai',label:'Workers AI 图片 OCR'},{value:'ocr_space',label:'OCR.space'}]},
 fileRetention:{title:'保存方式',items:[{value:'analyze_only',label:'仅分析，不保存'},{value:'summary',label:'仅保存文字，不上传 R2'},{value:'original',label:'保存私有原件到 R2'}]},
 reviewState:{title:'审核操作',items:[{value:'confirmed',label:'确认无误'},{value:'corrected',label:'修正为此值'},{value:'rejected',label:'无法确认 / 废弃候选'}]},
 ledgerCategory:{title:'家計簿分类',items:[]},
 ledgerPaymentSource:{title:'家計簿支付方式',items:[]},
 taskVisibility:{title:'任务可见范围',items:[{value:'private',label:'仅自己'},{value:'household',label:'家庭共享'}]}
};
const fileHasTextLayer=computed(()=>/\.(pdf|docx|xlsx|pptx)$/i.test(fileDraft.value?.name||''));
function choiceValue(field){
 switch(field){
  case 'category':return category.value;
  case 'visibility':return visibilityFilter.value;
  case 'archived':return archivedFilter.value;
  case 'favorite':return favoriteFilter.value;
  case 'aiProvider':return aiProvider.value;
  case 'docAiProvider':return docAiProvider.value;
  case 'textSource':return textDraft.source_type;
  case 'textRetention':return textDraft.retention;
  case 'importOcrEngine':return importOcrEngine.value;
  case 'fileRetention':return fileRetention.value;
  case 'reviewState':return fieldDraft.state;
  case 'taskVisibility':return candidateDraft.visibility;
  case 'ledgerCategory':return candidateDraft.category;
  case 'ledgerPaymentSource':return candidateDraft.payment_source;
  default:return '';
 }
}
function choiceItems(field){
 const items=field==='ledgerCategory'?ledgerOptions.value.categories:
  field==='ledgerPaymentSource'?ledgerOptions.value.paymentSources:(choices[field]?.items||[]);
 if(field==='fileRetention'&&!fileHasTextLayer.value)return items.filter(o=>o.value==='original');
 if(field==='taskVisibility'&&current.value?.visibility!=='shared')return items.filter(o=>o.value==='private');
 return items;
}
const pickerItems=computed(()=>choiceItems(choiceField.value));
const visiblePickerItems=computed(()=>{
 const q=choiceSearch.value.trim().toLocaleLowerCase();
 return q?pickerItems.value.filter(o=>o.label.toLocaleLowerCase().includes(q)):pickerItems.value;
});
function choiceLabel(field){return choiceItems(field).find(o=>o.value===choiceValue(field))?.label||'请选择';}
function openChoice(field){
 if(!choices[field]||busy.value)return;
 choiceField.value=field;choiceReturnSheet.value=sheet.value;choiceSearch.value='';sheet.value='choicePicker';
}
function backChoice(){
 sheet.value=choiceReturnSheet.value||'filter';choiceField.value='';choiceSearch.value='';choiceReturnSheet.value='';
}
function selectChoice(value){
 switch(choiceField.value){
  case 'category':category.value=value;break;
  case 'visibility':visibilityFilter.value=value;break;
  case 'archived':archivedFilter.value=value;break;
  case 'favorite':favoriteFilter.value=value;break;
  case 'aiProvider':aiProvider.value=value;geminiConsent.value=false;break;
  case 'docAiProvider':docAiProvider.value=value;docGeminiConsent.value=false;break;
  case 'textSource':textDraft.source_type=value;break;
  case 'textRetention':textDraft.retention=value;break;
  case 'importOcrEngine':importOcrEngine.value=value;importOcrSpaceConsent.value=false;break;
  case 'fileRetention':fileRetention.value=value;break;
  case 'reviewState':fieldDraft.state=value;break;
  case 'taskVisibility':candidateDraft.visibility=value;break;
  case 'ledgerCategory':candidateDraft.category=value;break;
  case 'ledgerPaymentSource':candidateDraft.payment_source=value;break;
 }
 backChoice();
}
function closeNestedSheet(){
 if(sheet.value==='choicePicker')backChoice();
 else if(sheet.value==='importSources')sheet.value='import';
 else closeSheet();
}

const showDue=(v)=>v?String(v):'截止日期待核验';
const showTodayDate=d=>d?.category==='card_spend'?
  (d.verified_transaction_at?'利用日：'+String(d.verified_transaction_at).slice(0,16)+' · 已核验':'利用日待核验'):
  showDue(d?.due_date);
const pageData=computed(()=>pages[activeTab.value]||{items:[],next:null,loaded:true});
// Non-blocking global banners disappear in three seconds. Actual confirmation
// dialogs never expire automatically: the user must choose Confirm/Cancel.
let noticeTimeout=null,errorTimeout=null;
watch(notice,value=>{
  if(noticeTimeout!==null)clearTimeout(noticeTimeout);
  noticeTimeout=value?setTimeout(()=>{notice.value='';noticeTimeout=null;},3000):null;
});
watch(error,value=>{
  if(errorTimeout!==null)clearTimeout(errorTimeout);
  errorTimeout=value?setTimeout(()=>{error.value='';errorTimeout=null;},3000):null;
});
// Keep transient notices brief; detailed diagnostic text is never displayed
// as a wall of text on mobile.
function shortMessage(value,limit=110){
 const message=String(value||'操作失败').replace(/\s+/g,' ').trim();
 return message.length>limit?message.slice(0,limit-1)+'…':message;
}
function flash(message){notice.value=shortMessage(message,90);error.value='';}
function problem(err){error.value=shortMessage(err?.message||err,140);notice.value='';}
async function api(path,{method='GET',body,form=false,signal,idempotencyKey}={}){
  const epoch=accountEpoch.snapshot();
  const headers={}; if(body&&!form)headers['Content-Type']='application/json';
  if(!['GET','HEAD'].includes(method)&&csrf.value)headers['X-CSRF-Token']=csrf.value;
  if(idempotencyKey)headers['Idempotency-Key']=idempotencyKey;
  const resp=await fetch(path,{method,headers,body:form?body:(body?JSON.stringify(body):undefined),credentials:'same-origin',cache:'no-store',signal:signal||accountController.signal});
  const contentType=resp.headers.get('Content-Type')||'';
  const data=contentType.includes('application/json')?await resp.json():null;
  accountEpoch.assertCurrent(epoch);
  if(!resp.ok){const err=new Error(data?.message||`HTTP ${resp.status}`);err.code=data?.code||'';err.status=resp.status;throw err;}
  return data;
}
function accountApi(snapshot){
  return (path,options)=>{
    accountEpoch.assertCurrent(snapshot);
    return api(path,options);
  };
}
function clearPrivateWorkspace(){
  accountEpoch.invalidate(); // Reject responses from the previous account.
  accountController.abort();accountController=new AbortController();
  loadSerial++;loadingPage.value=false;busy.value=false;detailLoading.value=false;
  swipeOpenId.value='';swipeTrashTarget.value=null;
  clearGmailSession();revokeOriginal();closeSheet();current.value=null;
  user.value=null;csrf.value='';amountVisible.value=false;detailCandidates.value=[];
  usage.value=null;trashItems.value=[];attachmentTrashItems.value=[];recycleEmptyProgress.value=0;
  ledgerOptions.value={categories:[],paymentSources:[]};ledgerOptionsError.value='';ledgerAttempted.value=false;ledgerMappingChangeConfirmed.value=false;candidateMerchant.value='';pendingCandidateRetry.value=null;
  sessions.value=[];sessionsNext.value=null;
  backupFile.value=null;backupPass.value='';backupOffset.value=0;
  backupScope.value='all';backupMonth.value='';restoreArchive.value=null;restorePreview.value=[];
  calendarLink.value='';calendarStatusInfo.value=null;calendarShowTitle.value=false;
  inviteEmail.value='';inviteToken.value='';pendingAttachment.value=null;
  fieldDraft.id='';fieldDraft.value='';fieldDraft.confirmRemote=false;
  for(const name of Object.keys(candidateDraft)){
    if(typeof candidateDraft[name]==='boolean')candidateDraft[name]=false;
    else if(typeof candidateDraft[name]==='number')candidateDraft[name]=0;
    else candidateDraft[name]='';
  }
  for(const page of Object.values(pages)){page.items=[];page.next=0;page.loaded=false;}
  if(backupInput.value)backupInput.value.value='';
  if(extraFileInput.value)extraFileInput.value.value='';
}
async function googleStatus(service){
  const params=new URLSearchParams({service});
  if(googlePending.value.service===service&&googlePending.value.flow)
    params.set('flow',googlePending.value.flow);
  const state=await api('/api/google/oauth/status?'+params);
  if(service==='gmail'){
    gmailPersistent.value=state;
    gmailAuthorizedUi.value=state.connected===true;
  }else{
    driveCloud.value=state;
  }
  if(googlePending.value.service===service&&
     ['done','failed','expired'].includes(state.progress)){
    if(state.progress==='done'&&state.connected)flash('Google '+(service==='gmail'?'Gmail':'Drive')+' 已连接');
    else if(state.progress==='failed')problem(new Error(state.progress_error||'Google 授权未完成，请重试'));
    googlePending.value={service:'',flow:''};
  }
  return state;
}
async function refreshGoogleOnReturn(){
  if(!user.value)return;
  const service=googlePending.value.service|| (sheet.value==='gmail'?'gmail':sheet.value==='drive'?'drive':'');
  if(!service)return;
  try{await googleStatus(service);}catch(e){problem(e)}
}
function onGoogleVisibility(){
  if(document.visibilityState==='visible')void refreshGoogleOnReturn();
}
async function startGoogleAuthorization(service){
  if(!user.value)return problem(new Error('请先登录文书助手'));
  if(service==='gmail')gmailBusy.value=true;
  else driveBusy.value=true;
  try{
    const result=await api('/api/google/oauth/start',{method:'POST',body:{service}});
    if(!result?.authorization_url?.startsWith('https://accounts.google.com/'))
      throw new Error('Google 授权地址无效');
    googlePending.value={service,flow:result.flow};
    // Navigate from the PWA into Google's first-party browser page, not an iframe.
    // Safari may not automatically switch back to a home-screen PWA.
    window.location.assign(result.authorization_url);
  }catch(e){problem(e);}
  finally{gmailBusy.value=false;driveBusy.value=false;}
}
async function openGmailSheet(){
  gmailBusy.value=false;gmailItems.value=[];gmailNext.value=null;sheet.value='gmail';
  try{await googleStatus('gmail');}catch(e){if(sheet.value==='gmail')problem(e)}
}
async function connectGmail(){await startGoogleAuthorization('gmail');}
async function openDriveSheet(){
  driveItems.value=[];driveNext.value='';driveBusy.value=false;sheet.value='drive';
  try{
    const status=await googleStatus('drive');
    if(status.connected&&sheet.value==='drive')await loadDriveFiles(false);
  }catch(e){if(sheet.value==='drive')problem(e)}
}
async function loadDriveFiles(append=false){
  if(!driveCloud.value.connected)return;
  driveBusy.value=true;
  try{
    const params=new URLSearchParams({q:driveQuery.value});
    if(append&&driveNext.value)params.set('pageToken',driveNext.value);
    const result=await api('/api/google/drive/files?'+params);
    if(sheet.value!=='drive')return;
    driveItems.value=append?[...driveItems.value,...result.items]:result.items;
    driveNext.value=result.nextPageToken||'';
  }catch(e){problem(e);}finally{driveBusy.value=false;}
}
async function chooseDriveFile(item){
  if(!driveCloud.value.connected||!item?.id)return;
  const epoch=accountEpoch.snapshot();driveBusy.value=true;busy.value=true;
  try{
    const response=await fetch('/api/google/drive/files/'+encodeURIComponent(item.id),
      {method:'GET',credentials:'same-origin',cache:'no-store'});
    if(!response.ok){
      const failure=await response.json().catch(()=>({}));
      throw new Error(failure.message||'Google 文件下载失败');
    }
    const name=decodeURIComponent(response.headers.get('X-Document-Name')||encodeURIComponent(item.name||'文书'));
    const mime=response.headers.get('Content-Type')||item.mimeType||'application/octet-stream';
    const file=new File([await response.blob()],name,{type:mime});
    accountEpoch.assertCurrent(epoch);
    if(file.size>8*1024*1024)throw new Error('文件超过 8MB');
    aiProvider.value='';geminiConsent.value=false;
    if(/\.(?:eml|txt)$/i.test(file.name)){
      const parsed=await readLocalText(file);
      accountEpoch.assertCurrent(epoch);
      textDraft.title=parsed.title;textDraft.text=parsed.text;
      textDraft.source_type='google_drive';textDraft.retention='summary';
      localImportNote.value='已提取文字，请核对后保存';
      inputMode.value='text';
    }else{
      fileDraft.value=file;fileSource.value='google_drive';inputMode.value='file';
      fileText.value='';fileWarning.value='';ocrProgress.value='';
      importOcrSpaceConsent.value=false;importOcrSpacePage.value=1;importPdfPages.value=1;
      fileRetention.value=/\.pdf$/i.test(file.name)||/^image\//.test(file.type)?'original':'summary';
      await parseSelectedFileWithOcr(file,epoch);
    }
    sheet.value='import';
  }catch(e){problem(e);}finally{driveBusy.value=false;busy.value=false}
}
async function disconnectGoogle(service){
  if(service==='gmail')gmailBusy.value=true;else driveBusy.value=true;
  try{
    await api('/api/google/oauth/disconnect',{method:'POST',body:{service}});
    if(service==='gmail'){
      gmailForget();gmailItems.value=[];gmailAuthorizedUi.value=false;
      gmailPersistent.value={enabled:true,connected:false,google_email:null};
    }else{
      driveCloud.value={enabled:true,connected:false,google_email:null};
      driveItems.value=[];driveNext.value='';
    }
    flash('已断开 '+(service==='gmail'?'Gmail':'Google Drive'));
  }catch(e){problem(e);}
  finally{gmailBusy.value=false;driveBusy.value=false;}
}
async function loadGmailMessages(append=false){
  if(!gmailPersistent.value.connected&&!gmailConnected()){
    gmailAuthorizedUi.value=false;return problem(new Error('Gmail 授权已过期，请重新授权'));
  }
  if(append&&!gmailNext.value)return;
  // Search via Gmail's server-side query; do not filter only the visible five.
  // Keep the applied query stable across all subsequent five-mail pages.
  const query=append?gmailLastQuery.value:gmailQuery.value.trim();
  const serial=++gmailGeneration;
  gmailBusy.value=true;
  if(!append){
    gmailLastQuery.value=query;
    gmailItems.value=[];gmailNext.value=null;gmailSearched.value=false;
  }
  try{
    const result=gmailPersistent.value.connected
      ?await api('/api/google/gmail/messages?q='+encodeURIComponent(query)+
        '&pageToken='+encodeURIComponent(append?gmailNext.value||'':''))
      :await gmailList(query,append?gmailNext.value||'':'');
    if(serial!==gmailGeneration||!user.value)return;
    const old=append?gmailItems.value:[];
    const ids=new Set(old.map(x=>x.id));
    gmailItems.value=[...old,...result.items.filter(x=>!ids.has(x.id))];
    gmailNext.value=result.nextPageToken;
    gmailSearched.value=true;
  }catch(e){if(serial===gmailGeneration)problem(e);}
  finally{if(serial===gmailGeneration)gmailBusy.value=false;}
}
async function selectGmailMessage(id){
  const serial=++gmailGeneration;gmailBusy.value=true;
  try{
    const doc=gmailPersistent.value.connected
      ?gmailPayloadToDocument((await api('/api/google/gmail/messages/'+encodeURIComponent(id))).payload)
      :await gmailReadOne(id);
    if(serial!==gmailGeneration||!user.value)return;
    aiProvider.value='';geminiConsent.value=false;
    textDraft.title=doc.title;textDraft.text=doc.text;
    textDraft.source_type='gmail';textDraft.retention='summary';
    localImportNote.value=doc.warning;inputMode.value='text';
    gmailItems.value=[];gmailNext.value=null;sheet.value='import';
    flash('已读取选中邮件正文；请核对后决定是否保存');
  }catch(e){problem(e);}finally{gmailBusy.value=false;}
}
async function disconnectGmail(){await disconnectGoogle('gmail');}
function clearGmailSession(){
  gmailGeneration++;gmailBusy.value=false;gmailForget();forgetDriveAuthorization();gmailAuthorizedUi.value=false;
  gmailPersistent.value={enabled:false,connected:false,google_email:null,client_id:''};
  driveCloud.value={enabled:false,connected:false,google_email:null};
  driveItems.value=[];driveNext.value='';googlePending.value={service:'',flow:''};
  gmailItems.value=[];gmailNext.value=null;gmailSearched.value=false;gmailLastQuery.value='';gmailQuery.value='';
}
async function boot(){
  try{
    const d=await api('/api/me');
    if(user.value?.id&&user.value.id!==d.user.id)clearPrivateWorkspace();
    user.value=d.user;csrf.value=d.csrf_token;await selectTab('today');
  }catch{clearPrivateWorkspace();}
}
async function refreshInitStatus(){
  try{
    const result=await api('/api/auth/status');
    initialized.value=result.initialized===true;
    if(!initialized.value)authMode.value='bootstrap';
  }catch{initialized.value=null;}
}
async function submitAuth(){
  clearGmailSession(); // Prevent a subsequent App account from inheriting prior Gmail OAuth state.
  busy.value=true;error.value='';
  try {
    const path={login:'/api/auth/login',bootstrap:'/api/auth/bootstrap',join:'/api/household/join'}[authMode.value];
    const d=await api(path,{method:'POST',body:{...auth}});
    clearPrivateWorkspace();
    csrf.value=d.csrf_token;auth.password='';auth.setup_token='';auth.invite_token='';
    await boot();flash('登录成功');
  } catch(e){problem(e);} finally {busy.value=false;}
}
async function openCalendar(){
 calendarLink.value='';sheet.value='calendar';
 try{
  const r=await api('/api/calendar/status');
  calendarStatusInfo.value=r;calendarShowTitle.value=!!r.include_titles;
 }catch(e){problem(e);}
}
async function createCalendar(){
 busy.value=true;
 try{
  const r=await api('/api/calendar/subscription',{method:'POST',
   body:{confirm:true,include_titles:calendarShowTitle.value}});
  calendarLink.value=r.url;calendarStatusInfo.value={active:true,include_titles:calendarShowTitle.value};
  flash('订阅链接已生成；旧链接立即失效，请妥善保管');
 }catch(e){problem(e);}finally{busy.value=false;}
}
async function revokeCalendar(){
 busy.value=true;
 try{
  await api('/api/calendar/revoke',{method:'POST'});
  calendarLink.value='';calendarStatusInfo.value={active:false,include_titles:false};
  flash('日历订阅链接已撤销');
 }catch(e){problem(e);}finally{busy.value=false;}
}
async function copyCalendarLink(){
 try{await navigator.clipboard.writeText(calendarLink.value);flash('私人订阅地址已复制');}
 catch{problem(new Error('复制失败，请长按地址框手动选择复制'));}
}
async function loadSessions(append=false){
  try{
    const offset=append?(sessionsNext.value||0):0;
    const r=await api('/api/auth/sessions?offset='+offset);
    sessions.value=append?[...sessions.value,...r.items]:r.items;
    sessionsNext.value=r.next_offset;
  }catch(e){problem(e);}
}
async function openSessions(){
  sessions.value=[];sessionsNext.value=null;sheet.value='sessions';
  await loadSessions();
}
async function revokeSession(id){
  busy.value=true;
  try{
    await api('/api/auth/sessions/revoke',{method:'POST',body:{session_id:id}});
    await loadSessions();flash('已撤销所选设备的登录会话');
  }catch(e){problem(e);}finally{busy.value=false;}
}
async function revokeOtherSessions(){
  busy.value=true;
  try{
    const r=await api('/api/auth/sessions/revoke-others',{method:'POST',body:{}});
    await loadSessions();flash('已撤销其他 '+r.revoked_count+' 个登录会话');
  }catch(e){problem(e);}finally{busy.value=false;}
}
async function changePassword(){
 if(passwordDraft.new_password.length<12||passwordDraft.new_password!==passwordDraft.confirm_password){
   problem(new Error('新密码必须至少12位，且两次输入一致'));return;
 }
 busy.value=true;
 try{
   await api('/api/auth/change-password',{method:'POST',
     body:{current_password:passwordDraft.current_password,new_password:passwordDraft.new_password}});
   clearPrivateWorkspace();auth.password='';
   flash('密码已更改，所有旧登录会话已注销。请使用新密码重新登录。');
 }catch(e){problem(e);}finally{busy.value=false;}
}
async function logout(){
  try{await api('/api/auth/logout',{method:'POST'});}catch{}
  clearPrivateWorkspace();auth.password='';
}
async function loadTab(tab,append=false){
  const page=pages[tab];if(!page)return;
  if(loadingPage.value&&append)return;
  const token=++loadSerial;loadingPage.value=true;
  try{
    const endpoint=tab==='today'?'/api/today':tab==='docs'?'/api/documents':'/api/integrations';
    const q=tab==='docs'?`&q=${encodeURIComponent(search.value)}&category=${encodeURIComponent(category.value)}&archived=${archivedFilter.value}&favorite=${favoriteFilter.value}&visibility=${visibilityFilter.value}&month=${monthFilter.value}`:'';
    const d=await api(`${endpoint}?limit=5&offset=${append?(page.next||0):0}${q}`);
    if(token!==loadSerial)return;
    page.items=append?[...page.items,...d.items]:d.items;
    page.next=d.next_offset;page.loaded=true;
  }catch(e){if(token===loadSerial)problem(e);}finally{if(token===loadSerial)loadingPage.value=false;}
}
function refreshDocumentViews(documentId=null){
 // Discard any in-flight response based on a pre-deletion snapshot.
 loadSerial++;
 loadingPage.value=false;
 invalidateDocumentLists(pages,documentId);
}
async function selectTab(tab){
  swipeOpenId.value='';
  activeTab.value=tab;
  if(pages[tab]&&!pages[tab].loaded)await loadTab(tab);
  if(tab==='mine'&&!usage.value)loadUsage();
}
async function searchDocs(){pages.docs.loaded=false;await loadTab('docs');closeSheet();}
async function loadUsage(){try{usage.value=await api('/api/usage');}catch(e){problem(e);}}
async function cleanupStorage(){busy.value=true;try{const result=await api('/api/storage/cleanup-orphans',{method:'POST',body:{}});flash(result.pending?'部分 R2 文件清理失败，请稍后手动重试':`已清理 ${result.removed} 个无引用原件；不扫描 R2 全桶`);}catch(e){problem(e);}finally{busy.value=false;}}
async function openDoc(id,{preserveTab=false,preserveScroll=false}={}){
  swipeOpenId.value='';
  const sameDocument=preserveTab&&current.value?.id===id;
  const tabBefore=detailTab.value;
  const scrollBefore=preserveScroll&&sameDocument
    ?document.querySelector('.detail-body')?.scrollTop:null;
  detailLoading.value=true;amountVisible.value=false;detailCandidates.value=[];
  if(!sameDocument){detailTab.value='explain';explanationExpanded.value=false;ocrTextExpanded.value=false;}
  try{
    const d=await api(`/api/documents/${id}`);current.value=d.document;
    const c=await api(`/api/documents/${id}/candidates`);detailCandidates.value=c.items||[];
    if(sameDocument)detailTab.value=tabBefore;
    if(scrollBefore!==null&&scrollBefore!==undefined){
      await nextTick();
      const container=document.querySelector('.detail-body');
      if(container)container.scrollTop=scrollBefore;
    }
  }catch(e){problem(e);}finally{detailLoading.value=false;}
}
function closeDetail(){revokeOriginal();current.value=null;amountVisible.value=false;explanationExpanded.value=false;ocrTextExpanded.value=false;attachmentActionsTarget.value=null;}
async function runAiForCurrent(){
 if(!current.value||busy.value||current.value.ai_provider==='none')return;
 const id=current.value.id;busy.value=true;
 try{
  const result=await api('/api/documents/'+id+'/ai/analyze',{method:'POST',body:{confirm:true}});
  await openDoc(id);
  const labels={success:'AI 已生成中文解读和学习建议',cached:'已使用缓存的 AI 分析',disabled:'AI 服务当前未启用（规则讲解仍可使用）',not_configured:'所选 AI 尚未完成安全配置',budget_exhausted:'Cloudflare AI 今日已达上限',budget_disabled:'AI 预算尚未开放',provider_failed:'AI 返回无效或服务暂不可用，原有数据不受影响',...Object.fromEntries(Object.entries(aiFailureLabels).filter(([k])=>k!=='provider_failed')),awaiting_text:'请先完成 OCR 或补充原文',privacy_blocked:'请确认发送至 Gemini',too_long:'原文过长，请拆分后重试',cooldown:'稍后重试',in_progress:'本份文书的 AI 请求正在执行'};
  flash(result.ai_status==='gemini_retry_cooldown'?`Google 服务器繁忙，约 ${result.retry_after_seconds||60} 秒后再试`:(labels[result.ai_status]||'AI 尚未产生新结果'));
 }catch(e){problem(e);}finally{busy.value=false;}
}
function openDocAiProvider(){if(!current.value)return;docAiProvider.value=current.value.ai_provider||'none';docGeminiConsent.value=false;sheet.value='docAiProvider';}
async function saveDocAiProvider(){
 if(!current.value||busy.value)return;
 if(docAiProvider.value==='gemini'&&!docGeminiConsent.value){problem(new Error('请确认发送至 Gemini'));return;}
 busy.value=true;const id=current.value.id;
 try{await api('/api/documents/'+id+'/ai-provider',{method:'PATCH',body:{ai_provider:docAiProvider.value,gemini_consent:docGeminiConsent.value}});
 closeSheet();await openDoc(id);flash('已保存 AI 选择');}catch(e){problem(e);}finally{busy.value=false;}
}
function closeSheet(){attachmentActionsTarget.value=null;importOcrEngine.value='local';importOcrSpaceConsent.value=false;importOcrSpacePage.value=1;importPdfPages.value=1;missingYearDateDraft.value='';missingYearConfirmed.value=false;ocrSpaceConsent.value=false;ocrProgress.value='';aiProvider.value='';geminiConsent.value=false;docGeminiConsent.value=false;choiceField.value='';choiceSearch.value='';choiceReturnSheet.value='';swipeTrashTarget.value=null;if(sheet.value==='gmail'){gmailGeneration++;gmailBusy.value=false;gmailItems.value=[];gmailNext.value=null;gmailSearched.value=false;gmailLastQuery.value='';}calendarLink.value='';passwordDraft.current_password='';passwordDraft.new_password='';passwordDraft.confirm_password='';sheet.value='';editTextDraft.value='';localImportNote.value='';fileDraft.value=null;fileSource.value='local_file';ocrAttachmentPending.value=null;ocrRetryStale.value=false;ocrRetryEmpty.value=false;fileText.value='';fileWarning.value='';fileRetention.value='original';textDraft.text='';textDraft.title='';textDraft.source_type='text';textDraft.retention='summary';inviteToken.value='';if(fileInput.value)fileInput.value.value='';if(localTextInput.value)localTextInput.value.value='';}
function openImport(mode='text'){
  inputMode.value=mode;sheet.value='import';
}
async function parseSelectedFileWithOcr(file,epoch){
  const unchanged=()=>accountEpoch.isCurrent(epoch)&&fileDraft.value===file;
  const isPdf=/\.pdf$/i.test(file.name)||file.type==='application/pdf';
  const isImage=/^image\/(?:jpeg|png|webp)$/.test(file.type);
  const ocr=async blob=>{
    const {recognizeJapaneseImage}=await import('./local-ocr.js');
    ocrProgress.value='识别中…';
    return recognizeJapaneseImage(blob);
  };
  let result;
  try{
    if(isPdf){
      result=await extractDocumentText(file,{ocrPage:ocr,maxOcrPages:10,onProgress:message=>{if(unchanged())ocrProgress.value=message;}});
    }else if(isImage){
      result=await ocr(file);
    }else{
      result=await extractDocumentText(file);
    }
    if(!unchanged())return;
    fileText.value=result.text||'';
    if(isPdf)importPdfPages.value=Math.max(1,Number(result.pages_read)||1);
    fileWarning.value=shortMessage(result.warning,120)||(
      isImage?'识别完成，请核对文字。':'');
    if(isPdf&&fileSource.value==='google_drive'){
      fileWarning.value='已读取（'+(result.pages_read||'?')+' 页）。'+fileWarning.value;
    }
    if(isPdf&&(result.ocr_pages_attempted||result.pages_without_text?.length)){
      // Keep scanned originals available for source verification.
      fileRetention.value='original';
    }
  }catch(e){
    if(unchanged()){
      fileWarning.value='识别失败：'+shortMessage(e?.message||'未知错误',100);
      if(isPdf||isImage)fileRetention.value='original';
    }
  }finally{if(unchanged())ocrProgress.value='';}
}
async function selectFile(event){
  const file=event.target.files?.[0];if(!file)return;
  fileDraft.value=file;fileSource.value='local_file';sheet.value='import';inputMode.value='file';
  fileText.value='';fileWarning.value='';ocrProgress.value='';importOcrEngine.value='local';importOcrSpaceConsent.value=false;importOcrSpacePage.value=1;importPdfPages.value=1;aiProvider.value='';geminiConsent.value=false;
  const supported=/\.(?:pdf|docx|xlsx|pptx)$/i.test(file.name)||/^image\/(?:jpeg|png|webp)$/.test(file.type);
  fileRetention.value=/(?:\.pdf$)/i.test(file.name)||/^image\//.test(file.type)?'original':'summary';
  if(!supported)return;
  const epoch=accountEpoch.snapshot();busy.value=true;
  try{await parseSelectedFileWithOcr(file,epoch);}
  finally{busy.value=false;if(fileInput.value)fileInput.value.value='';}
}

async function importLocalText(event){
  const file=event.target.files?.[0];if(!file)return;
  const epoch=accountEpoch.snapshot();busy.value=true;try{
    const result=await readLocalText(file);
    accountEpoch.assertCurrent(epoch);
    aiProvider.value='';geminiConsent.value=false;
    textDraft.text=result.text;textDraft.title=result.title;textDraft.source_type=result.source_type;
    inputMode.value='text';localImportNote.value=result.warning;sheet.value='import';
  }catch(e){problem(e);}finally{busy.value=false;if(localTextInput.value)localTextInput.value.value='';}
}
async function runImportOcrSpace(){
 if(!fileDraft.value||busy.value||!importOcrSpaceConsent.value)return;
 const selected=fileDraft.value,epoch=accountEpoch.snapshot();
 const isPdf=/\.pdf$/i.test(selected.name)||selected.type==='application/pdf';
 const isImage=/^image\/(?:jpeg|png|webp)$/.test(selected.type);
 if(!isPdf&&!isImage)return;
 const page=isPdf?Number(importOcrSpacePage.value):1;
 if(isPdf&&(!Number.isSafeInteger(page)||page<1||page>importPdfPages.value)){
   problem(new Error('请选择当前 PDF 中有效的页码'));return;
 }
 busy.value=true;
 try{
   ocrProgress.value=isPdf?'正在处理第 '+page+' 页…':'正在处理图片…';
   const rendered=isPdf
     ?await (await import('./pdf-text.js')).renderPdfOcrPreview(selected,{pageNumber:page,maxBytes:900*1024})
     :await (await import('./ocr-space-image.js')).renderImageOcrPreview(selected,{maxBytes:900*1024});
   accountEpoch.assertCurrent(epoch);
   if(fileDraft.value!==selected)return;
   ocrProgress.value='OCR.space 识别中…';
   const form=new FormData();
   form.append('file',rendered.blob,'scanned-page.jpg');
   form.append('confirm_ocr_space','true');
   form.append('confirm_private_upload','true');
   const answer=await api('/api/ocr-space/preview',{method:'POST',body:form,form:true});
   accountEpoch.assertCurrent(epoch);
   if(fileDraft.value!==selected)return;
   const candidate=String(answer.text||'').trim();
   if(!candidate)throw new Error('OCR.space 没有返回可用文字');
   fileText.value=fileText.value.trim()?fileText.value.trim()+'\n\n'+candidate:candidate;
   fileWarning.value='OCR.space 识别完成，请核对。';
   flash('识别完成，请核对。');
 }catch(e){problem(e);fileWarning.value='OCR.space 失败：'+shortMessage(e?.message||'未知错误',110);}
 finally{if(fileDraft.value===selected)ocrProgress.value='';busy.value=false;}
}
async function runImportWorkersAi(){
 if(!fileDraft.value||busy.value||!importOcrSpaceConsent.value)return;
 const selected=fileDraft.value,epoch=accountEpoch.snapshot();
 const isPdf=/\.pdf$/i.test(selected.name)||selected.type==='application/pdf';
 const isImage=/^image\/(?:jpeg|png|webp)$/.test(selected.type);
 if(!isPdf&&!isImage)return;
 const page=isPdf?Number(importOcrSpacePage.value):1;
 if(isPdf&&(!Number.isSafeInteger(page)||page<1||page>importPdfPages.value)){
   problem(new Error('请选择有效的 PDF 页码'));return;
 }
 busy.value=true;
 try{
   ocrProgress.value='正在处理图片…';
   const rendered=isPdf
     ?await (await import('./pdf-text.js')).renderPdfOcrPreview(selected,{pageNumber:page,maxBytes:900*1024})
     :await (await import('./ocr-space-image.js')).renderImageOcrPreview(selected,{maxBytes:900*1024});
   accountEpoch.assertCurrent(epoch);
   if(fileDraft.value!==selected)return;
   ocrProgress.value='Workers AI 识别中…';
   const form=new FormData();
   form.append('file',rendered.blob,'scanned-page.jpg');
   form.append('confirm_workers_ai','true');
   const answer=await api('/api/workers-ai-ocr/preview',{method:'POST',body:form,form:true});
   accountEpoch.assertCurrent(epoch);
   if(fileDraft.value!==selected)return;
   const text=String(answer.text||'').trim();
   if(!text)throw new Error('没有识别出可用文字');
   fileText.value=fileText.value.trim()?fileText.value.trim()+'\n\n'+text:text;
   fileWarning.value='Workers AI 识别完成，请核对。';
   flash('识别完成，请核对。');
 }catch(e){
   problem(e);
   if(fileDraft.value===selected)fileWarning.value='Workers AI 失败：'+shortMessage(e?.message||'未知错误',100);
 }finally{if(fileDraft.value===selected)ocrProgress.value='';busy.value=false;}
}
async function runSelectedImportOcr(){
 if(!fileDraft.value||busy.value)return;
 if(importOcrEngine.value==='ocr_space'||importOcrEngine.value==='workers_ai'){
   const name=importOcrEngine.value==='ocr_space'?'OCR.space':'Workers AI';
   if(!importOcrSpaceConsent.value){problem(new Error('请先同意发送至 '+name));return;}
   return importOcrEngine.value==='ocr_space'?runImportOcrSpace():runImportWorkersAi();
 }
 return retryLocalOcr();
}
async function retryLocalOcr(){
 if(!fileDraft.value||busy.value)return;
 const file=fileDraft.value,epoch=accountEpoch.snapshot();busy.value=true;
 try{await parseSelectedFileWithOcr(file,epoch);}
 finally{busy.value=false;}
}
async function importDocument(){
  if(!aiProvider.value){problem(new Error('请选择分析方式'));return;}
  if(aiProvider.value==='gemini'&&!geminiConsent.value){problem(new Error('请确认发送至 Gemini'));return;}
  busy.value=true;error.value='';
  try{
    let result;
    if(inputMode.value==='text'){
      if(!textDraft.text.trim())throw new Error('请先粘贴或输入日文内容');
      result=await api('/api/documents/import/text',{method:'POST',body:{title:textDraft.title,text:textDraft.text,source_type:textDraft.source_type,retention:textDraft.retention,ai_provider:aiProvider.value,gemini_consent:geminiConsent.value}});
    }else{
      if(!fileDraft.value)throw new Error('请先选择 PDF、Word、Excel、PowerPoint 或照片');
      if(fileRetention.value!=='original'){
        if(!fileText.value.trim())throw new Error('没有文字层，请人工填写或明确选择保留原件');
        result=await api('/api/documents/import/text',{method:'POST',body:{title:fileDraft.value.name,text:fileText.value,
          source_type:fileSource.value,retention:fileRetention.value,ai_provider:aiProvider.value,gemini_consent:geminiConsent.value}});
      }else{
        const compressed=await compressImage(fileDraft.value);
        const form=new FormData();form.append('file',compressed,compressed.name);form.append('retention','original');form.append('source_type',fileSource.value);form.append('ai_provider',aiProvider.value);form.append('gemini_consent',String(geminiConsent.value));
        if(fileText.value.trim())form.append('extracted_text',fileText.value);
        result=await api('/api/documents/import/file',{method:'POST',body:form,form:true});
      }
    }
    const id=result.document_id;
    const saved=result.saved!==false;
    flash(saved?(result.reused?'已关联此前导入的文书':inputMode.value==='file'?(fileRetention.value==='original'?'原件已保存到私有 R2，文字和日期仍须核对':'文字已导入，原件未上传 R2'):'文字已导入，字段待确认'):'规则预览已完成，内容未保存');
    if(!saved){notice.value+=(result.analysis?.explanation_zh?`：${result.analysis.explanation_zh}`:'');}
    closeSheet();
    if(saved){for(const p of Object.values(pages))p.loaded=false;await loadTab(activeTab.value==='mine'?'docs':activeTab.value);if(id)await openDoc(id);}
  }catch(e){problem(e);}finally{busy.value=false;}
}
async function saveManualSalary(){
 if(!current.value||busy.value)return;
 busy.value=true;
 try{
  await api(`/api/documents/${current.value.id}/manual-income`,{method:'POST',body:{
   amount_jpy:salaryAmountDraft.value,confirm_bank_amount:salaryAmountConfirmed.value
  }});
  const id=current.value.id;sheet.value='';salaryAmountDraft.value='';salaryAmountConfirmed.value=false;
  refreshDocumentViews();
  await openDoc(id);detailTab.value='tasks';
  flash('人工工资金额已保存；收入候选已生成，确认后才会同步家計簿');
 }catch(e){problem(e);}finally{busy.value=false;}
}
function startField(field){if(field.field_key==='due_date'&&field.review_state==='unreviewed'&&field.source_quote?.startsWith('年份自动补全')){openCompleteDeadline();return;}fieldDraft.id=field.id;fieldDraft.value=field.normalized_value||'';fieldDraft.state=field.review_state==='unreviewed'?'confirmed':field.review_state;fieldDraft.confirmRemote=false;sheet.value='field';}
async function saveField(){busy.value=true;try{
  const result=await api(`/api/fields/${fieldDraft.id}`,{method:'PATCH',body:{normalized_value:fieldDraft.value,review_state:fieldDraft.state,confirm_remote_unchanged:fieldDraft.confirmRemote}});
  const id=current.value.id;sheet.value='';await openDoc(id,{preserveTab:true,preserveScroll:true});
  refreshDocumentViews();
  if(pages[activeTab.value])await loadTab(activeTab.value);
  flash(result.linked_records_unchanged?'本地字段已修改；已同步的目标 App 记录不会自动改变，请前往目标 App 核对':'字段已保存');
}catch(e){problem(e);}finally{busy.value=false;}}
function askTrash(){sheet.value='trashConfirm';}
function askTrashFromList(document){
  if(busy.value || !document?.id)return;
  swipeOpenId.value='';
  swipeTrashTarget.value={id:document.id,title:document.title};
  sheet.value='trashListConfirm';
}
async function trashFromList(){
  const target=swipeTrashTarget.value;
  if(!target||busy.value)return;
  busy.value=true;
  try{
    await api(`/api/documents/${target.id}/trash`,{method:'POST',body:{}});
    closeSheet();
    refreshDocumentViews(target.id);
    if(pages[activeTab.value])await loadTab(activeTab.value);
    flash('文书已移入回收站，「今日」与「联动」已同步更新，可从回收站恢复');
  }catch(e){problem(e);}
  finally{busy.value=false;}
}
async function trashCurrent(){busy.value=true;try{
  await api(`/api/documents/${current.value.id}/trash`,{method:'POST',body:{}});
  const deletedId=current.value.id;
  closeSheet();closeDetail();
  refreshDocumentViews(deletedId);
  if(pages[activeTab.value])await loadTab(activeTab.value);
  flash('已移入回收站，「今日」与「联动」已同步更新，原件保留可恢复');
}catch(e){problem(e);}finally{busy.value=false;}}
async function showRecycle(){sheet.value='recycle';recycleEmptyProgress.value=0;await refreshTrash();}
function askEmptyRecycle(){
  if(busy.value||(!trashItems.value.length&&!attachmentTrashItems.value.length))return;
  recycleEmptyProgress.value=0;
  sheet.value='emptyRecycleConfirm';
}
async function emptyRecycle(){
  if(busy.value)return;
  const epoch=accountEpoch.snapshot();
  const send=accountApi(epoch);
  busy.value=true;
  let documents=0,attachments=0,remaining=0,completed=false;
  try{
    // Five documents and five deleted attachments per bounded Worker request.
    for(let batch=0;batch<100;batch++){
      const result=await send('/api/recycle/empty',{method:'POST',body:{confirm:'DELETE_FOREVER'}});
      accountEpoch.assertCurrent(epoch);
      documents+=Number(result.processed_documents||0);
      attachments+=Number(result.processed_attachments||0);
      recycleEmptyProgress.value=documents+attachments;
      remaining=Number(result.remaining||0);
      if(!result.ok||result.failed?.length)break;
      if(!result.has_more){completed=true;break;}
      if(!result.processed)break;
    }
    accountEpoch.assertCurrent(epoch);
    sheet.value='recycle';
    await refreshTrash();
    refreshDocumentViews();
    if(pages[activeTab.value])await loadTab(activeTab.value);
    if(completed)flash(`回收站已清空：文书 ${documents} 份、附件 ${attachments} 个`);
    else problem(new Error(`已清理 ${documents+attachments} 项，仍有 ${remaining} 项未完成；请检查并重试`));
  }catch(e){
    if(accountEpoch.isCurrent(epoch)){
      sheet.value='recycle';
      await refreshTrash();
      refreshDocumentViews();
      problem(new Error(`已清理 ${documents+attachments} 项，其余清理未完成：${e?.message||'请重试'}`));
    }
  }finally{
    if(accountEpoch.isCurrent(epoch))busy.value=false;
  }
}
async function refreshTrash(reset=true){try{if(reset)recycleOffset.value=0;
  const d=await api(`/api/recycle?limit=5&offset=${recycleOffset.value}`);
  trashItems.value=reset?d.items:[...trashItems.value,...d.items];recycleNext.value=d.next_offset;
  const a=await api('/api/recycle/attachments');attachmentTrashItems.value=a.items;
}catch(e){problem(e);}}
async function loadMoreTrash(){if(recycleNext.value===null)return;recycleOffset.value=recycleNext.value;await refreshTrash(false);}
async function restoreAttachment(d,a){busy.value=true;try{await api(`/api/documents/${d}/attachments/${a}/restore`,{method:'POST',body:{}});await refreshTrash();flash('附件已恢复，没有重复上传 R2');}catch(e){problem(e);}finally{busy.value=false;}}
async function trashAttachment(a){if(!current.value)return;busy.value=true;try{
  await api(`/api/documents/${current.value.id}/attachments/${a.id}/trash`,{method:'POST',body:{}});
  const id=current.value.id;await openDoc(id,{preserveTab:true,preserveScroll:true});flash('附件已移入回收站，文字结果保留');
}catch(e){problem(e);}finally{busy.value=false;}}

function openAttachmentActions(a){
 if(!current.value||busy.value||!a?.id)return;
 attachmentActionsTarget.value={id:a.id};
 sheet.value='attachmentActions';
}
async function moveAttachmentFromMenu(step){
 const attachment=selectedAttachment.value;
 sheet.value='';
 attachmentActionsTarget.value=null;
 if(attachment)await moveAttachment(attachment,step);
}
async function confirmAttachmentTrash(){
 const attachment=selectedAttachment.value;
 sheet.value='';
 attachmentActionsTarget.value=null;
 if(attachment&&!busy.value)await trashAttachment(attachment);
}
async function moveAttachment(attachment,step){
  if(!current.value||busy.value)return;
  const old=current.value.attachments||[],index=old.findIndex(x=>x.id===attachment.id);
  const next=index+step;if(index<0||next<0||next>=old.length)return;
  const reordered=[...old];[reordered[index],reordered[next]]=[reordered[next],reordered[index]];
  busy.value=true;
  try{
    const result=await api(`/api/documents/${current.value.id}/attachments/order`,{
      method:'PATCH',body:{version:current.value.version,attachment_ids:reordered.map(x=>x.id)}
    });
    // Keep original view open without reloading all document metadata or R2.
    current.value={...current.value,attachments:reordered,version:result.version};
    flash('附件顺序已更新，未重新读取图片');
  }catch(e){problem(e);}finally{busy.value=false;}
}
async function deleteAttachment(){if(!pendingAttachment.value)return;busy.value=true;try{
 const a=pendingAttachment.value;const result=await api(`/api/documents/${a.document_id}/attachments/${a.id}/permanent-delete`,{method:'POST',body:{confirm:'DELETE_FOREVER'}});
 pendingAttachment.value=null;sheet.value='recycle';await refreshTrash();flash(result.warning||'附件记录已清理，最后一个引用的 R2 原件同步删除');
}catch(e){problem(e);}finally{busy.value=false;}}
async function appendFiles(event){const files=Array.from(event.target.files||[]);if(!files.length||!current.value)return;
 busy.value=true;try{for(const f of files){const optimized=await compressImage(f);const form=new FormData();form.append('file',optimized,optimized.name);form.append('retention','original');await api(`/api/documents/${current.value.id}/attachments`,{method:'POST',body:form,form:true});}
 await openDoc(current.value.id);flash(`已添加 ${files.length} 页原件，尚待人工确认识别内容`);
 }catch(e){problem(e);}finally{busy.value=false;if(extraFileInput.value)extraFileInput.value.value='';}}
function openCompleteDeadline(){
 const proposed=current.value?.fields?.find(f=>f.field_key==='due_date'&&f.review_state==='unreviewed'&&f.source_quote?.startsWith('年份自动补全'));
 missingYearDateDraft.value=proposed?.normalized_value||'';
 missingYearConfirmed.value=false;sheet.value='confirmDeadline';
}
async function confirmCompleteDeadline(){
 if(!current.value||busy.value||!missingYearConfirmed.value||!missingYearDateDraft.value)return;
 busy.value=true;const id=current.value.id;
 try{
  await api('/api/documents/'+id+'/complete-deadline',{method:'POST',body:{due_date:missingYearDateDraft.value,confirm_year:true}});
  sheet.value='';missingYearDateDraft.value='';missingYearConfirmed.value=false;
  await openDoc(id,{preserveTab:true,preserveScroll:true});flash('已按你确认的年份保存截止日；HomeFlow 待办仍需再次确认后同步');
 }catch(e){problem(e);}finally{busy.value=false;}
}
async function refreshInterpretation(){
 if(!current.value||busy.value)return;
 const id=current.value.id;
 busy.value=true;
 try{
   const result=await api(`/api/documents/${id}/reinterpret`,{method:'POST',body:{}});
   refreshDocumentViews();
   await openDoc(id,{preserveTab:true,preserveScroll:true});
   flash(`规则解析已更新；补充 ${result.added_fields} 个待核验字段，原有核验及跨应用联动保持不变`+
     (result.privacy_auto_private?'；敏感文书已自动设为仅自己':''));
 }catch(e){problem(e);}finally{busy.value=false;}
}
function editText(){editTextDraft.value=current.value?.extracted_text_ja||'';sheet.value='editText';}
async function saveSourceText(){busy.value=true;try{await api(`/api/documents/${current.value.id}/source-text`,{method:'PATCH',body:{text:editTextDraft.value,confirm_reset_review:true}});const id=current.value.id;sheet.value='';editTextDraft.value='';await openDoc(id);flash('文字已保存并重新生成待核验字段');}catch(e){problem(e);}finally{busy.value=false;}}
function openOcrSpace(a){ocrAttachmentPending.value=a;ocrSpaceConsent.value=false;sheet.value='ocrSpaceConfirm';}
async function confirmOcrSpace(){
 if(!current.value||!ocrAttachmentPending.value||!ocrSpaceConsent.value)return;
 busy.value=true;
 try{
  const result=await api('/api/documents/'+current.value.id+'/ocr-space',{method:'POST',body:{attachment_id:ocrAttachmentPending.value.id,confirm_ocr_space:true,confirm_private_upload:true}});
  editTextDraft.value=result.text;
  ocrAttachmentPending.value=null;sheet.value='editText';
  flash(result.cached?'已使用以前的云端识别结果':'OCR.space 返回候选文字，请逐项核对后再保存');
 }catch(e){problem(e);}finally{busy.value=false;}
}
function runOcr(a){ocrAttachmentPending.value=a;ocrRetryStale.value=false;ocrRetryEmpty.value=false;sheet.value='ocrConfirm';}
async function confirmRunOcr(){
  if(!ocrAttachmentPending.value)return;
  busy.value=true;
  try{
    const d=await api(`/api/documents/${current.value.id}/ocr`,
      {method:'POST',body:{confirm:true,attachment_id:ocrAttachmentPending.value.id,
         retry_stale:ocrRetryStale.value,retry_empty:ocrRetryEmpty.value}});
    editTextDraft.value=d.text;ocrAttachmentPending.value=null;sheet.value='editText';
    flash(d.cached?'已复用以前的 OCR 候选，未再次请求 AI/R2':'OCR 未自动保存，请核对原件后手动保存');
  }catch(e){problem(e);}
  finally{busy.value=false;}
}
async function exportData(){
  const epoch=accountEpoch.snapshot(),controller=accountController;busy.value=true;
  try{
    const d=await exportBatch(accountApi(epoch),{
      scope:backupScope.value,month:backupScope.value==='month'?backupMonth.value:'',
      year:backupScope.value==='year'?backupMonth.value.slice(0,4):'',
      offset:backupOffset.value,includes_originals:backupIncludeOriginals.value,
      password:backupPass.value,signal:controller.signal,
      assertCurrent:()=>accountEpoch.assertCurrent(epoch)
    });
    accountEpoch.assertCurrent(epoch);
    backupOffset.value=d.next_offset??0;
    flash(`已生成 ${d.name}（${d.document_count} 份文书、${d.original_count} 个原件）`);
  }catch(e){if(accountEpoch.isCurrent(epoch))problem(e);}
  finally{if(accountEpoch.isCurrent(epoch))busy.value=false;}
}
async function selectBackup(event){
 const file=event.target.files?.[0];if(!file)return;
 const epoch=accountEpoch.snapshot();
 backupFile.value=file;busy.value=true;
 try{
   const archive=await readBackup(file,backupPass.value);
   accountEpoch.assertCurrent(epoch);
   const d=await restoreBatch(accountApi(epoch),archive,false);
   accountEpoch.assertCurrent(epoch);
   restoreArchive.value=archive;restorePreview.value=d.preview;sheet.value='restoreBackup';
 }catch(e){if(accountEpoch.isCurrent(epoch))problem(e);}
 finally{if(accountEpoch.isCurrent(epoch))busy.value=false;}
}
async function confirmRestore(){busy.value=true;try{const r=await restoreBatch(accountApi(accountEpoch.snapshot()),restoreArchive.value,true);sheet.value='';backupFile.value=null;restoreArchive.value=null;restorePreview.value=[];for(const page of Object.values(pages))page.loaded=false;flash(`已恢复 ${r.metadata_restored} 份资料、${r.originals_restored} 个原件；失败 ${r.failures.length} 件`);}catch(e){problem(e);}finally{busy.value=false;}}
async function toggleDocument(key,value){if(!current.value)return;busy.value=true;try{const id=current.value.id;await api(`/api/documents/${id}`,{method:'PATCH',body:{[key]:value,version:current.value.version}});sheet.value='';await openDoc(id);for(const page of Object.values(pages))page.loaded=false;flash('文书状态已更新');}catch(e){problem(e);}finally{busy.value=false;}}
async function prepareCandidate(item){try{const d=await api(`/api/candidates/${item.id}/preview`);
 candidateDraft.id=item.id;candidateDraft.kind=item.candidate_kind;candidateDraft.confirm=d.confirmation_phrase;
 const verifiedDate=d.confirmed_fields?.transaction_at||d.confirmed_fields?.transaction_date||d.confirmed_fields?.[item.payload?.date_field_key||'due_date'];
 candidateDraft.date=String(verifiedDate||item.payload?.transaction_date||'').slice(0,10);
 ledgerOptions.value=d.ledger_options||{categories:[],paymentSources:[]};
 ledgerOptionsError.value=d.ledger_options_error||'';
 ledgerAttempted.value=Number(d.integration?.attempt_count||0)>0&&d.integration?.state==='failed';ledgerMappingChangeConfirmed.value=false;
 // Suggestions are calculated by Kakebo against its real D1 merchant rules
 // and user-configured defaults. The user can always override either picker.
 candidateDraft.category=ledgerOptions.value.suggested?.category||'';
 candidateDraft.payment_source=ledgerOptions.value.suggested?.payment_source||'';
 // Explanatory warnings are not a real transaction memo. Leave the
 // accounting note blank for card purchase; the user can add their own.
 candidateDraft.note=current.value.category==='card_spend'?'':(item.payload?.note||'');
 candidateMerchant.value=item.candidate_kind==='finance'?(item.payload?.merchant||''):'';
 candidateDraft.title=item.payload?.title||current.value.title;
 if(pendingCandidateRetry.value?.id===item.id)Object.assign(candidateDraft,pendingCandidateRetry.value.body);
 candidateDraft.visibility=current.value.visibility==='shared'?'household':'private';candidateDraft.assignee='';candidateDraft.bonus_points=0;candidateDraft.privacy_confirmed=false;
 candidateDraft.redacted_term=item.payload?.term||'';candidateDraft.redacted_sentence=item.payload?.redacted_sentence||item.payload?.sentence||'';
 sheet.value='candidate';integrationConfigured.value=d.available&&(item.candidate_kind!=='finance'||(ledgerOptions.value.categories.length>0&&ledgerOptions.value.paymentSources.length>0));
 }catch(e){problem(e);}}
async function commitApprovedCandidate(){
 if(busy.value||!current.value)return;
 busy.value=true;
 const id=candidateDraft.id,docId=current.value.id;
 const body={...candidateDraft,payment_confirmed:candidateDraft.kind==='finance',confirm_mapping_change:ledgerAttempted.value&&ledgerMappingChangeConfirmed.value};
 if(body.kind==='finance'&&ledgerAttempted.value&&!ledgerMappingChangeConfirmed.value){
  problem(new Error('这笔消费有历史失败记录，请先勾选核对原记录后再提交'));
  busy.value=false;return;
 }
 if(body.kind==='finance'&&(!ledgerOptions.value.categories.some(x=>x.value===body.category)||
   !ledgerOptions.value.paymentSources.some(x=>x.value===body.payment_source))){problem(new Error('请从家計簿同步的分类和支付方式中选择'));busy.value=false;return;}
 let confirmed=false,feedback='';
 try{
  const d=await api(`/api/candidates/${id}/commit`,{method:'POST',body,idempotencyKey:`jda-${id}`});
  confirmed=true;pendingCandidateRetry.value=null;
  feedback=d.recovered_prior?'家計簿已有该候选的旧记账；未重复写入，请核对分类':d.already_synced?'已关联已有记录，不重复记账':'目标 App 已确认同步成功';
 }catch(e){
  // Validation problems remain editable. A completed remote attempt closes
  // this sheet while preserving its exact retry fields and failure state.
  const attempted=String(e?.code||'').startsWith('TARGET_')||
   ['BRIDGE_UNCONFIRMED','LINK_CONFLICT','SENDING','RETRY_PAYLOAD_CHANGED'].includes(e?.code);
  if(!attempted){problem(e);busy.value=false;return;}
  pendingCandidateRetry.value={id,body};
  feedback='同步未成功：'+(e?.message||'请核对目标 App');
 }
 sheet.value='';
 refreshDocumentViews();
 try{await openDoc(docId,{preserveTab:true,preserveScroll:true});}catch{}
 if(confirmed)flash(feedback);else problem(new Error(feedback));
 busy.value=false;
}

async function restore(id){busy.value=true;try{
  const d=await api(`/api/documents/${id}/restore`,{method:'POST',body:{}});
  await refreshTrash();
  refreshDocumentViews();
  if(pages[activeTab.value])await loadTab(activeTab.value);
  flash(d.warning||'文书已恢复，文书库、今日与联动将在打开时显示最新内容');
}catch(e){problem(e);}finally{busy.value=false;}}
const pendingDelete=ref(null);
function askPermanent(id){pendingDelete.value=id;sheet.value='permanent';}
async function permanentDelete(){busy.value=true;try{
  const result=await api(`/api/documents/${pendingDelete.value}/permanent-delete`,{method:'POST',body:{confirm:'DELETE_FOREVER'}});
  const deletedId=pendingDelete.value;
  pendingDelete.value=null;sheet.value='recycle';await refreshTrash();
  refreshDocumentViews(deletedId);
  flash(result.warning||'文书与无需再引用的 R2 原件已执行清理');
}catch(e){problem(e);}finally{busy.value=false;}}
async function issueInvite(){busy.value=true;try{
  const d=await api('/api/household/invites',{method:'POST',body:{invitee_email:inviteEmail.value}});inviteToken.value=d.invite_token;flash('邀请码仅供指定邮箱，48小时有效');
}catch(e){problem(e);}finally{busy.value=false;}}
async function showOriginal(a){
  if(!current.value)return;
  const epoch=accountEpoch.snapshot(),id=current.value.id;
  revokeOriginal();busy.value=true;
  try{
    const response=await fetch(`/api/documents/${id}/attachments/${a.id}/content`,{credentials:'same-origin',cache:'no-store',signal:accountController.signal});
    accountEpoch.assertCurrent(epoch);
    if(!response.ok)throw new Error('无法读取私人原件');
    const blob=await response.blob();
    accountEpoch.assertCurrent(epoch);
    originalMime.value=blob.type;originalUrl.value=URL.createObjectURL(blob);sheet.value='original';
  }catch(e){if(accountEpoch.isCurrent(epoch))problem(e);}finally{if(accountEpoch.isCurrent(epoch))busy.value=false;}
}
function revokeOriginal(){if(originalUrl.value)URL.revokeObjectURL(originalUrl.value);originalUrl.value='';}
async function changeShare(){
  const newVisibility=current.value.visibility==='private'?'shared':'private';
  busy.value=true;
  try{await api(`/api/documents/${current.value.id}`,{method:'PATCH',body:{visibility:newVisibility,version:current.value.version,confirm_sensitive_share:newVisibility==='shared'}});
    sheet.value='';await openDoc(current.value.id);flash(newVisibility==='shared'?'已主动设为家庭共享':'已设为私人文书');
  }catch(e){problem(e);}finally{busy.value=false;}
}
const dueState=(v)=>{if(!v)return '待确认';const today=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});return v<today?'已逾期':v===today?'今天到期':'近期';};
function todayReviewBadge(d){
  const due=dueState(d?.due_date);
  // A due-date emergency takes priority, but verified upcoming documents
  // must visibly say 已核验 rather than the generic 近期 badge.
  if(due==='已逾期'||due==='今天到期')return due;
  const reviewed=documentReviewLabel(d);
  return reviewed==='已核验'||reviewed==='部分核验'||reviewed==='待核验'?reviewed:due;
}
const labelFor=(key)=>current.value?.category==='campaign'&&key==='due_date'?'活动截止日期':current.value?.category==='campaign'&&key==='due_date_partial'?'原文活动期限（月日）':key==='amount_jpy'&&current.value?.category==='utility'?'本次请款金额（日元）':(fieldLabel[key]||key);
const displayValue=(f)=>f.value_type==='money'&&!amountVisible.value?'••••••':f.normalized_value||'待确认';
onMounted(async()=>{
  document.addEventListener('visibilitychange',onGoogleVisibility);
  window.addEventListener('pageshow',refreshGoogleOnReturn);
  await boot();if(!user.value)await refreshInitStatus();
});
onBeforeUnmount(()=>{document.removeEventListener('visibilitychange',onGoogleVisibility);window.removeEventListener('pageshow',refreshGoogleOnReturn);clearPrivateWorkspace();if(noticeTimeout!==null)clearTimeout(noticeTimeout);if(errorTimeout!==null)clearTimeout(errorTimeout);fileDraft.value=null;});
</script>

<template>
<div class="app-shell">
  <template v-if="!user">
    <div class="auth-shell">
      <div class="auth-symbol"><UiIcon name="file-text" :size="30"/></div>
      <p class="eyebrow">私人家庭空间</p>
      <h1>日本生活文书助手</h1>
      <p class="muted auth-intro">读懂日本生活文书，重要事项不错过。</p>
      <div class="auth-panel">
        <div class="segments"><button v-for="m in [{id:'login',name:'登录'},{id:'bootstrap',name:'首次设置'},{id:'join',name:'接受邀请'}]" :key="m.id" :class="{selected:authMode===m.id}" @click="authMode=m.id;error=''">{{m.name}}</button></div>
        <p v-if="initialized===false" class="fine-print">家庭尚未初始化。请使用「首次设置」，输入 Cloudflare 中完整的初始化令牌。设置完成后再使用「登录」。</p>
        <form @submit.prevent="submitAuth" class="stack">
          <label>邮箱<input v-model.trim="auth.email" type="email" required autocomplete="username" placeholder="you@example.com" /></label>
          <label>密码（至少 12 位）<input v-model="auth.password" type="password" required minlength="12" autocomplete="current-password" placeholder="个人独立密码" /></label>
          <label v-if="authMode!=='login'">显示名称<input v-model="auth.display_name" maxlength="50" placeholder="家庭昵称" /></label>
          <label v-if="authMode==='bootstrap'">初始化令牌<input v-model="auth.setup_token" type="password" required placeholder="Cloudflare Secret" /></label>
          <label v-if="authMode==='join'">家庭邀请码<input v-model="auth.invite_token" required placeholder="由家庭管理员提供" /></label>
          <button class="primary action-large" :disabled="busy" type="submit">{{busy?'处理中…':authMode==='login'?'登录':authMode==='join'?'加入家庭':'初始化私人空间'}}</button>
        </form>
      </div>
      <p class="fine-print">私人云端保存，敏感内容不留在设备缓存中。</p>
    </div>
  </template>
  <template v-else>
    <header class="topbar"><div><p class="eyebrow">日本生活文书助手</p><h1>{{tabs.find(t=>t.id===activeTab)?.name}}</h1></div><button class="round ghost top-add" aria-label="导入文书" @click="openImport()"><UiIcon name="plus" :size="23"/></button></header>
    <main class="main-content">
      <section v-if="activeTab==='today'" class="page-surface" key="today">
        <div class="welcome"><div><p class="eyebrow">今日概览</p><h2>重要事项，一目了然</h2><p class="muted">待核验文书与截止日期</p></div><div class="welcome-mark"><UiIcon name="today" :size="27"/></div></div>
        <div class="section-head"><h3>需要你关注</h3><span>{{pageData.items.length}} 件</span></div>
        <div v-if="!pageData.items.length&&!loadingPage" class="empty">还没有需要处理的文书。<button class="text-button" @click="openImport()">导入第一份</button></div>
        <button class="item-card today-list-card" v-for="d in pageData.items" :key="d.id" @click="openDoc(d.id)"><div class="item-icon"><UiIcon :name="categoryIcon(d.category)" :size="22"/></div><div class="item-info"><div class="item-title">{{d.title}}</div><p>{{cats[d.category]||d.category}} · {{showTodayDate(d)}}</p></div><span class="state-tag" :class="{'danger':d.due_date&&dueState(d.due_date)==='已逾期'}">{{todayReviewBadge(d)}}</span></button>
        <button v-if="pageData.next!==null" class="load-more" :disabled="loadingPage" @click="loadTab('today',true)">{{loadingPage?'加载中…':'加载更多'}}</button>
      </section>
      <section v-else-if="activeTab==='docs'" class="page-surface" key="docs">
        <div class="search-row"><input v-model="search" type="search" placeholder="搜索标题或中文摘要" @keyup.enter="searchDocs" /><button class="filter-button icon-label" aria-label="文书筛选" @click="sheet='filter'"><UiIcon name="filter" :size="17"/>筛选</button><button class="filter-button icon-label" @click="searchDocs"><UiIcon name="search" :size="17"/>查找</button></div>
        <div class="section-head"><h3>文书库</h3><span>{{category?cats[category]:'全部类型'}}</span></div>
        
        <div v-if="!pageData.items.length&&!loadingPage" class="empty">没有匹配的文书。</div>
        <DocumentSwipeRow v-for="d in pageData.items" :key="d.id" :id="d.id"
          :revealed="swipeOpenId===d.id" :disabled="busy"
          @reveal="swipeOpenId=d.id" @hide="swipeOpenId=''" @delete="askTrashFromList(d)">
          <button class="item-card document-list-card" type="button" @click="openDoc(d.id)"><div class="item-icon"><UiIcon :name="categoryIcon(d.category)" :size="22"/></div><div class="item-info"><div class="item-title">{{d.title}}</div><p>{{d.favorite?'★ · ':''}}{{cats[d.category]||d.category}} · {{d.visibility==='shared'?'家庭共享':'仅自己'}}{{d.archived_at?' · 已归档':''}}</p></div><span class="state-tag">{{documentReviewLabel(d)}}</span></button>
        </DocumentSwipeRow>
        <button v-if="pageData.next!==null" class="load-more" :disabled="loadingPage" @click="loadTab('docs',true)">加载更多</button>
      </section>
      <section v-else-if="activeTab==='links'" class="page-surface" key="links">
        <div class="info-note">核对提取结果后，再选择同步到目标 App。</div>
        <div class="section-head"><h3>待确认的联动</h3><span>独立核验 · 幂等</span></div>
        <div v-if="!pageData.items.length&&!loadingPage" class="empty">文书识别后的财务、任务、学习建议会出现在这里。</div>
        <button class="item-card link-list-card" v-for="item in pageData.items" :key="item.id" @click="openDoc(item.document_id)"><div class="item-icon"><UiIcon :name="candidateIcon(item.candidate_kind)" :size="22"/></div><div class="item-info"><div class="item-title">{{candidateLabel[item.candidate_kind]}}</div><p>{{item.title}} · {{integrationLabel(item.integration_state)}}</p></div><span class="state-tag">预览</span></button>
        <button v-if="pageData.next!==null" class="load-more" @click="loadTab('links',true)">加载更多</button>
      </section>
      <section v-else class="page-surface" key="mine">
        <div class="profile-card"><div class="avatar">{{(user.display_name||user.email||'我').slice(0,1).toUpperCase()}}</div><div><h3>{{user.display_name||'家庭成员'}}</h3><p class="muted">{{user.email}} · {{user.role==='owner'?'管理员':'家庭成员'}}</p></div></div>
        <div class="section-head"><h3>家庭与数据</h3></div>
        <button class="settings-line" v-if="user.role==='owner'" @click="sheet='invite'">邀请第二位家庭成员 <UiIcon name="chevron-right" :size="18"/></button>
        <button class="settings-line" @click="showRecycle">回收站 <UiIcon name="chevron-right" :size="18"/></button>
        <button class="settings-line" @click="sheet='backup'">备份与恢复 <UiIcon name="chevron-right" :size="18"/></button>
        <button class="settings-line" @click="openCalendar">日历订阅 <UiIcon name="chevron-right" :size="18"/></button>
        <button class="settings-line" @click="loadUsage">刷新服务用量 <UiIcon name="refresh-cw" :size="17"/></button>
        <button class="settings-line" :disabled="busy" @click="cleanupStorage">清理无引用原件 <UiIcon name="refresh-cw" :size="17"/></button>
        <div class="info-note" v-if="usage">Gemini 3.6 {{usage.gemini_daily?.calls??0}}/{{usage.gemini_daily?.limit??20}}（两人共用·美西日） · Workers AI 解读 {{usage.document_ai_utc_day?.calls??0}}/{{usage.document_ai_utc_day?.limit??0}} · Workers AI OCR {{usage.app_utc_day?.calls??0}}/{{usage.app_utc_day?.limit??0}} · OCR.space {{usage.ocr_space_utc_day?.calls??0}}/{{usage.ocr_space_utc_day?.limit??0}}</div>
        <button class="settings-line" @click="openSessions">登录设备与会话 <UiIcon name="chevron-right" :size="18"/></button>
        <button class="settings-line" @click="sheet='changePassword'">修改登录密码 <UiIcon name="chevron-right" :size="18"/></button>
        <button class="settings-line" @click="logout">退出当前账号 <UiIcon name="chevron-right" :size="18"/></button>
        <p class="fine-print">删除文书不会删除其他 App 已同步的记录。</p>
      </section>
    </main>
    <nav class="bottom-nav" aria-label="主要导航">
      <button v-for="tab in tabs" :key="tab.id" type="button" @click="selectTab(tab.id)" :class="{active:activeTab===tab.id}" :aria-current="activeTab===tab.id?'page':undefined">
        <span class="nav-symbol"><TabIcon :name="tab.id" /></span><span>{{tab.name}}</span>
      </button>
    </nav>
  </template>
  <div v-if="notice" class="status-toast" role="status"><span>{{notice}}</span><button @click="notice=''" aria-label="关闭提示"><UiIcon name="x" :size="19"/></button></div>
  <div v-if="error" class="status-toast error-toast" role="alert"><span>{{error}}</span><button @click="error=''" aria-label="关闭错误"><UiIcon name="x" :size="19"/></button></div>

  <div v-if="current" class="detail-surface" role="dialog" aria-modal="true" aria-label="文书详情">
    <div class="detail-top"><button class="round ghost" @click="closeDetail" aria-label="返回"><UiIcon name="arrow-left" :size="21"/></button><strong>文书详情</strong><button class="round ghost" @click="sheet='detailsMenu'" aria-label="更多操作"><UiIcon name="ellipsis" :size="22"/></button></div>
    <div class="detail-body">
      <p class="eyebrow">{{cats[current.category]||current.category}} · {{current.visibility==='shared'?'家庭共享':'仅自己'}}</p>
      <h2 class="document-detail-title" :title="current.title">{{current.title}}</h2>
      <p class="detail-note">{{documentReviewLabel(current)}} · {{current.import_mode==='original'?'私有原件':'文字摘要'}}</p>
      <p v-if="['card_spend','shopping'].includes(current.category)&&current.fields?.some(f=>['merchant','transaction_at','transaction_date'].includes(f.field_key)&&f.review_state!=='rejected')" class="muted">
        {{current.fields?.find(f=>f.field_key==='merchant'&&f.review_state!=='rejected')?.normalized_value||'商户待核验'}}
        <template v-if="current.fields?.some(f=>['transaction_at','transaction_date'].includes(f.field_key)&&f.review_state!=='rejected')"> · {{current.fields?.find(f=>f.field_key==='transaction_at'&&f.review_state!=='rejected')?.normalized_value||current.fields?.find(f=>f.field_key==='transaction_date'&&f.review_state!=='rejected')?.normalized_value}}</template>
      </p>
      <div class="detail-tabs-sticky"><div class="segments detail-tabs"><button v-for="t in [{id:'explain',name:'讲解'},{id:'finance',name:'字段'},{id:'tasks',name:'待办'},{id:'study',name:'学习'},{id:'original',name:'原文'}]" :key="t.id" :class="{selected:detailTab===t.id}" @click="detailTab=t.id">{{t.name}}</button></div></div>
      <section v-if="detailTab==='explain'">
        <div v-if="['policy','government','terms','campaign'].includes(current.category)" class="content-card policy-check-card">
          <h3>{{current.category==='campaign'?'活动期限':'文件时效'}}</h3><p class="detail-note" v-if="current.category==='campaign'">{{current.fields?.find(f=>f.field_key==='due_date'&&f.review_state!=='rejected')?.normalized_value||'截止日期待核对'}} · {{current.fields?.some(f=>f.field_key==='due_date'&&f.review_state==='unreviewed')?'年份待确认 · ':''}}优惠状态未验证</p><p v-else class="detail-note">{{current.source_document_date||'日期待核对'}} · {{current.official_current_verified_at?'已查验':'官方状态未核验'}}</p>
        </div>
        <div class="content-card explain-panel">
          <div class="explain-heading">
            <h3>中文讲解</h3>
            <button class="explain-provider" type="button" @click="openDocAiProvider" aria-label="选择这份文书的 AI 引擎">{{({cloudflare:'Workers AI',gemini:'Gemini 3.6 Flash',none:'仅规则'})[current.ai_provider]||'仅规则'}}<UiIcon name="chevron-right" :size="15"/></button>
          </div>
          <div class="explain-actions">
            <button v-if="current.ai_provider!=='none'" class="primary icon-label" type="button" :disabled="busy||!current.extracted_text_ja" @click="runAiForCurrent"><UiIcon name="sparkles" :size="17"/>AI 解读</button>
            <button class="secondary icon-label" type="button" :disabled="busy||!current.extracted_text_ja" @click="refreshInterpretation"><UiIcon name="refresh-cw" :size="16"/>重新解析</button>
          </div>
          <p v-if="aiFailureMessage" class="detail-note" role="status">{{aiFailureMessage}} · 下方为规则讲解</p>
          <p class="multiline explanation-text" :class="{expanded:explanationExpanded}">{{(explanationExpanded?explanationText:explanationPreview)||'还没有可讲解的文字，可在原文页补充。'}}</p>
          <button v-if="explanationText.length>150" class="text-button expand-copy" type="button" :aria-expanded="explanationExpanded" @click="explanationExpanded=!explanationExpanded">{{explanationExpanded?'收起讲解':'查看完整讲解'}}</button>
          <details v-if="aiAnalysis?.important_points_zh?.length" class="explain-points"><summary>重要事项（{{aiAnalysis.important_points_zh.length}}）</summary><p v-for="(line,index) in aiAnalysis.important_points_zh" :key="index">{{line}}</p></details>
        </div>
      </section>
      <section v-if="detailTab==='finance'"><div class="section-head"><h3>从原文提取的字段</h3><button class="text-button icon-label" @click="amountVisible=!amountVisible"><UiIcon :name="amountVisible?'eye-off':'eye'" :size="17"/>{{amountVisible?'隐藏金额':'显示金额'}}</button></div><div v-if="!current.fields?.length" class="empty">暂无字段。可点击「重新讲解」提取原文中的日期及办理事项。</div><button v-if="current.fields?.some(f=>f.field_key==='due_date_partial'&&f.review_state!=='rejected')&&(!current.fields?.some(f=>f.field_key==='due_date')||current.fields?.some(f=>f.field_key==='due_date'&&f.review_state==='unreviewed'&&f.source_quote?.startsWith('年份自动补全')))" class="secondary full" @click="openCompleteDeadline">确认／修改默认年份（之后可创建待办）</button><button v-if="canManualSalary" class="secondary full" @click="salaryAmountDraft='';salaryAmountConfirmed=false;sheet='manualSalary'">手动填写工资到账金额</button><button class="field-card" v-for="field in current.fields" :key="field.id" @click="startField(field)"><div><span class="muted">{{field.field_key==='due_date'&&field.source_quote?.startsWith('年份自动补全')?'截止日期（按今年自动补全·待确认）':labelFor(field.field_key)}}</span><strong>{{displayValue(field)}}</strong><small>{{field.source_quote?.startsWith('用户手动补录')?'来源':'原文'}}：{{field.source_quote||'未记录'}}</small></div><span class="state-tag">{{field.review_state==='unreviewed'?'待确认':'已核验'}}</span></button><div class="info-note">付款与到账请核对。</div></section>
      <section v-if="detailTab==='tasks'"><h3 class="section-title">待办与财务建议</h3><div v-if="canManualSalary" class="content-card"><p>已识别工资入账通知，但邮件没有金额。</p><button class="secondary full" @click="salaryAmountDraft='';salaryAmountConfirmed=false;sheet='manualSalary'">手动填写到账金额，生成家計簿收入建议</button></div>
        <div v-if="campaignPendingDate" class="content-card campaign-review-card">
          <h3>活动截止日期 · 待核对</h3>
          <p>原文：{{current.fields?.find(f=>f.field_key==='due_date_partial')?.normalized_value}}。确认年份后才会生成本地 HomeFlow 待办候选。</p>
          <button class="secondary small icon-label" type="button" @click="openCompleteDeadline"><UiIcon name="calendar" :size="16"/>确认活动年份</button>
        </div>
        <div v-if="current.category==='campaign'&&current.campaign_hints?.length" class="content-card campaign-review-card">
          <h3>可选优惠操作</h3>
          <p v-for="(hint,i) in current.campaign_hints" :key="i">{{hint.description_zh}}</p>
          <p class="detail-note">只是邮件中的优惠说明，不会自动领取或创建正式待办。</p>
        </div>
        <div v-if="topupAdvice" class="content-card">
          <h3>家計簿 · 资金转移建议</h3>
          <p class="muted">这是一笔电子钱包充值，不是消费或新增收入。</p>
          <p>充值金额：<strong>{{amountVisible?topupAdvice.amount:'••••••'}}</strong> <button class="text-button" @click="amountVisible=!amountVisible">{{amountVisible?'隐藏金额':'显示金额'}}</button></p>
          <p>完成时间：{{topupAdvice.time}}</p>
          <p>充值目标：{{topupAdvice.destination}}（请确认家計簿中已登记的充值卡）</p>
          <p>充值服务：{{topupAdvice.service}}</p>
          <p>扣款来源：<strong>待本人选择</strong>（不能从充值服务名称推断）</p>
          <p class="fine-print">当前家計簿安全接口只支持收入／支出，还不能接收资金转移。请先在家計簿手动选择「资产转移／充值」并核对是否已记账；此建议不会自动写入、不会重复记账。</p>
        </div>
        <div class="content-card" v-for="item in detailCandidates.filter(c=>['finance','homeflow_task'].includes(c.candidate_kind))" :key="item.id"><h3>{{candidateLabel[item.candidate_kind]}}</h3><p class="muted" v-if="item.candidate_kind==='finance'">{{item.payload.kind==='expense'?'支出':'收入'}} ¥{{Number(item.payload.amount_jpy).toLocaleString('ja-JP')}} · {{item.payload.merchant||'商户待确认'}} · {{item.payload.transaction_at||item.payload.transaction_date||'日期待确认'}}</p><p v-if="item.integration_state==='failed'" class="detail-note" role="status">上次同步未成功，未确认已记账。请核对后重试。</p><p class="muted" v-else>{{(item.payload.task_type==='delivery'?'预计配送：':'截止日：')+item.payload.due_on+(item.payload.delivery_window?' '+item.payload.delivery_window:'')}}</p><p v-if="item.payload.task_type==='delivery'" class="fine-print">{{item.payload.note}}；请先核验「字段」中的配送日期，再手动确认同步到 HomeFlow。</p><button class="secondary small" @click="prepareCandidate(item)">查看预览 / 确认联动</button></div>
        <p v-if="!topupAdvice&&!detailCandidates.some(c=>['finance','homeflow_task'].includes(c.candidate_kind))&&!aiAnalysis?.homeflow_suggestions?.length&&!current.campaign_hints?.length&&!campaignPendingDate" class="muted">暂无待办或财务建议。这不代表邮件识别失败；可在「字段」中核对已提取的信息。</p>
        <div v-if="aiAnalysis?.homeflow_suggestions?.length" class="content-card"><h3>AI · HomeFlow 待办建议</h3><p v-for="(item,i) in aiAnalysis.homeflow_suggestions" :key="i">{{item.description_zh}}（{{item.date||'日期待确认'}}）</p><p class="fine-print">这只是 AI 建议，尚未生成可同步任务。请以人工核验日期为准。</p></div>
        <div v-if="aiAnalysis?.finance_suggestions?.length" class="content-card"><h3>AI · 家計簿建议</h3><p v-for="(item,i) in aiAnalysis.finance_suggestions" :key="i">{{item.description_zh}}</p><p class="fine-print">此处没有新增账目；实际到账或消费必须经你确认。</p></div>
        
      </section>
      <section v-if="detailTab==='study'">
        <h3 class="section-title">从生活文书中学习日语</h3>
        <div class="content-card" v-for="item in detailCandidates.filter(c=>c.candidate_kind==='vocabulary')" :key="item.id">
          <div class="study-word-head">
            <strong>{{item.payload.term}}</strong>
            <span v-if="studySyncState(item)==='linked'" class="study-sync-tag">✓ 已加入知学</span>
            <span v-else-if="studySyncState(item)==='failed'" class="study-sync-tag error">同步失败</span>
            <span v-else-if="studySyncState(item)==='sending'" class="study-sync-tag neutral">同步中</span>
          </div>
          <p class="muted">{{item.payload.reading}} · {{item.payload.meaning_zh}}</p>
          <button v-if="!['linked','sending'].includes(studySyncState(item))" class="secondary small" @click="prepareCandidate(item)">{{studySyncState(item)==='failed'?'重试加入':'脱敏并确认加入'}}</button>
        </div>
        <div class="content-card" v-for="item in detailCandidates.filter(c=>c.candidate_kind==='sentence')" :key="item.id">
          <div class="study-word-head">
            <h3>实用句子</h3>
            <span v-if="studySyncState(item)==='linked'" class="study-sync-tag">✓ 已加入知学</span>
            <span v-else-if="studySyncState(item)==='failed'" class="study-sync-tag error">同步失败</span>
            <span v-else-if="studySyncState(item)==='sending'" class="study-sync-tag neutral">同步中</span>
          </div>
          <p>{{item.payload.sentence}}</p><p class="muted">{{item.payload.translation_zh}}</p>
          <button v-if="!['linked','sending'].includes(studySyncState(item))" class="secondary small" @click="prepareCandidate(item)">{{studySyncState(item)==='failed'?'重试加入':'脱敏并确认加入知学'}}</button>
          <p class="fine-print">通过授权账户的签名接口同步至知学生词本中的「文书例句」，不会自动覆盖已有词条。</p>
        </div>
        <div v-if="!detailCandidates.some(c=>['vocabulary','sentence'].includes(c.candidate_kind))" class="empty">尚未找到可复用的生词或句子。</div>
      </section>
      <section v-if="detailTab==='original'">
        <div class="content-card original-panel">
          <div class="original-section-heading">
            <h3>附件 <span class="muted">({{current.attachments?.length||0}})</span></h3>
            <button class="text-button icon-label" type="button" :disabled="busy" @click="extraFileInput?.click()"><UiIcon name="plus" :size="16"/>添加</button>
          </div>
          <input class="visually-hidden" ref="extraFileInput" type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" @change="appendFiles" />
          <div v-if="current.attachments?.length" class="attachment-files">
            <div class="attachment-file-row" v-for="a in current.attachments" :key="a.id">
              <button class="attachment-file-open" type="button" :disabled="busy" @click="showOriginal(a)">
                <UiIcon name="file" :size="18"/><span class="attachment-file-name" :title="a.file_label">{{a.file_label}}</span><span class="attachment-view-label">查看</span>
              </button>
              <button class="attachment-file-more" type="button" :disabled="busy" :aria-label="'更多附件操作：'+a.file_label" @click="openAttachmentActions(a)"><UiIcon name="ellipsis" :size="20"/></button>
            </div>
          </div>
          <div class="original-copy-section">
            <div class="original-section-heading"><h3>OCR 文字</h3><button class="text-button icon-label" type="button" @click="editText"><UiIcon name="edit" :size="16"/>编辑</button></div>
            <p v-if="current.extracted_text_ja" class="multiline ocr-text-preview" :class="{expanded:ocrTextExpanded}">{{current.extracted_text_ja}}</p>
            <p v-else class="muted">暂无文字。</p>
            <button v-if="current.extracted_text_ja?.length>130" class="text-button expand-copy" type="button" :aria-expanded="ocrTextExpanded" @click="ocrTextExpanded=!ocrTextExpanded">{{ocrTextExpanded?'收起原文':'展开全部文字'}}</button>
          </div>
        </div>
      </section>
    </div>
  </div>

  <div v-if="sheet" class="sheet-overlay" @click.self="sheet==='original'?(revokeOriginal(),sheet=''):closeNestedSheet()">
    <section class="bottom-sheet" :class="{'recycle-sheet':sheet==='recycle','confirmation-sheet':['emptyRecycleConfirm','permanent','permanentAttachment','trashConfirm'].includes(sheet)}" role="dialog" aria-modal="true" :aria-label="sheet">
      <div class="grabber"></div>
      <template v-if="sheet==='import'"><h2>扫描 / 导入文书</h2>
  <!-- Import source is common to both modes; keep it ABOVE the mode selector. -->
  <button class="secondary full import-source-toggle" type="button" @click="sheet='importSources'">选择导入来源（本地 / Gmail / Google Drive）<UiIcon name="chevron-right" :size="18"/></button>
  <div class="segments"><button :class="{selected:inputMode==='text'}" @click="inputMode='text'">粘贴文字</button><button :class="{selected:inputMode==='file'}" @click="inputMode='file'">文件 / 照片</button></div><template v-if="inputMode==='text'"><label class="form-label">标题（可选）<input v-model="textDraft.title" maxlength="200" placeholder="例如：11 月电费通知" /></label><label class="form-label">日文内容<textarea v-model="textDraft.text" rows="7" maxlength="100000" placeholder="从苹果邮件复制正文，或粘贴可复制的 PDF／Google Drive 文字…"></textarea></label><p v-if="localImportNote" class="fine-print">{{localImportNote}}</p><div class="choice-form-field"><span class="choice-field-label">来源</span><button type="button" class="choice-field-control" @click="openChoice('textSource')"><span>{{choiceLabel('textSource')}}</span><UiIcon name="chevron-right" :size="18"/></button></div><div class="choice-form-field"><span class="choice-field-label">保存方式</span><button type="button" class="choice-field-control" @click="openChoice('textRetention')"><span>{{choiceLabel('textRetention')}}</span><UiIcon name="chevron-right" :size="18"/></button></div></template>
        <template v-else><div class="upload-box"><p>{{fileDraft?fileDraft.name:'选择 PDF、Word、Excel、PowerPoint 或照片'}}</p><button class="secondary" @click="fileInput?.click()">选取文件</button><input ref="fileInput" type="file" accept="image/jpeg,image/png,image/webp,image/*,.pdf,.docx,.xlsx,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation" class="visually-hidden" @change="selectFile" /></div><p v-if="ocrProgress" class="fine-print" role="status">{{ocrProgress}}</p><p v-if="fileWarning" class="fine-print" role="status">{{fileWarning}}</p><template v-if="fileDraft && (fileDraft.type==='application/pdf'||/\.pdf$/i.test(fileDraft.name)||/^image\/(?:jpeg|png|webp)$/.test(fileDraft.type))"><div class="ocr-method-row"><button type="button" class="choice-field-control" @click="openChoice('importOcrEngine')"><span class="ocr-choice-text"><span class="ocr-method-label">识别方式</span><strong>{{choiceLabel('importOcrEngine')}}</strong></span><UiIcon name="chevron-right" :size="18"/></button><button type="button" class="secondary ocr-run-button" :disabled="busy" @click="runSelectedImportOcr"><UiIcon name="scan" :size="17"/>识别</button></div><div v-if="importOcrEngine==='ocr_space'||importOcrEngine==='workers_ai'" class="ocr-cloud-options"><label v-if="fileDraft.type==='application/pdf'||/\.pdf$/i.test(fileDraft.name)" class="ocr-page-control">第 <input type="number" min="1" :max="importPdfPages" step="1" v-model.number="importOcrSpacePage"/> 页（共 {{importPdfPages}} 页）</label><label class="check-row"><input type="checkbox" v-model="importOcrSpaceConsent"/>同意发送所选{{fileDraft.type==='application/pdf'||/\.pdf$/i.test(fileDraft.name)?'页':'图片'}}至 {{importOcrEngine==='ocr_space'?'OCR.space':'Workers AI'}}</label></div></template><label v-if="/\.(pdf|docx|xlsx|pptx|jpe?g|png|webp)$/i.test(fileDraft?.name||'')" class="form-label">提取的文字（请核对后保存）<textarea v-model="fileText" rows="6" maxlength="100000" placeholder="OCR 尚未提取到内容，可手动补充原文"></textarea></label><div class="choice-form-field"><span class="choice-field-label">保存方式</span><button type="button" class="choice-field-control" @click="openChoice('fileRetention')"><span>{{choiceLabel('fileRetention')}}</span><UiIcon name="chevron-right" :size="18"/></button></div><p class="fine-print">支持本地文字提取；图片按需压缩。</p></template>

        <div class="choice-form-field"><span class="choice-field-label">这份文书使用的 AI</span><button type="button" class="choice-field-control" @click="openChoice('aiProvider')"><span>{{choiceLabel('aiProvider')}}</span><UiIcon name="chevron-right" :size="18"/></button></div>
        <p class="fine-print">每份文书单独选择，不保存全局偏好。首次导入在服务已启用时尝试 AI 分析，同版本命中缓存不会重复调用。</p>
        <label v-if="aiProvider==='gemini'" class="check-row"><input type="checkbox" v-model="geminiConsent"/>同意将本份文书发送至 Gemini（可能产生费用）</label>
        <div class="sheet-actions"><button class="secondary" @click="closeSheet">取消</button><button class="primary" :disabled="busy" @click="importDocument">{{busy?'处理中…':inputMode==='file'&&fileRetention==='original'?'确认保存原件':'开始处理'}}</button></div></template>
      <template v-else-if="sheet==='confirmDeadline'"><h2>{{current?.category==='campaign'?'确认活动截止年份':'补全截止日期的年份'}}</h2><p class="fine-print">原文只有月日，系统暂按日本当年补全。请核对原文日期和星期；确认前不会创建 HomeFlow 待办。</p><label class="form-label">完整截止日期<input type="date" v-model="missingYearDateDraft"/></label><label class="check-row"><input type="checkbox" v-model="missingYearConfirmed"/>我已核对并确认年份，不是 AI 自动推断。</label><div class="sheet-actions"><button class="secondary" @click="closeSheet">取消</button><button class="primary" :disabled="busy||!missingYearConfirmed||!missingYearDateDraft" @click="confirmCompleteDeadline">保存待核对日期</button></div></template>
      <template v-else-if="sheet==='docAiProvider'"><h2>为当前文书选择 AI</h2><p class="fine-print">仅影响本份文书。</p><div class="choice-form-field"><span class="choice-field-label">分析引擎</span><button class="choice-field-control" type="button" @click="openChoice('docAiProvider')"><span>{{choiceLabel('docAiProvider')}}</span><UiIcon name="chevron-right" :size="18"/></button></div><label v-if="docAiProvider==='gemini'" class="check-row"><input type="checkbox" v-model="docGeminiConsent"/>同意将本份文书发送至 Gemini（可能产生费用）</label><div class="sheet-actions"><button class="secondary" @click="closeSheet">取消</button><button class="primary" :disabled="busy" @click="saveDocAiProvider">保存选择</button></div></template>
      <template v-else-if="sheet==='importSources'">
  <h2>选择导入来源</h2>
  <label class="choice-picker-file"><UiIcon name="file" :size="20"/><span>上传 PDF / 图片 / Office</span><UiIcon name="chevron-right" :size="18"/>
    <input type="file" class="visually-hidden" accept="image/*,.pdf,.docx,.xlsx,.pptx,application/pdf" @change="selectFile"/>
  </label>
  <label class="choice-picker-file"><UiIcon name="file-text" :size="20"/><span>上传邮件 / 文本文件</span><UiIcon name="chevron-right" :size="18"/>
    <input type="file" class="visually-hidden" accept=".eml,.txt,message/rfc822,text/plain" @change="importLocalText"/>
  </label>
  <button class="choice-picker-file" type="button" @click="openGmailSheet"><UiIcon name="mail" :size="20"/><span>Gmail</span><UiIcon name="chevron-right" :size="18"/></button>
  <button class="choice-picker-file" type="button" @click="openDriveSheet"><UiIcon name="file" :size="20"/><span>Google Drive</span><UiIcon name="chevron-right" :size="18"/></button>
  <div class="sheet-actions"><button class="secondary full" @click="sheet='import'">返回</button></div>
</template>
<template v-else-if="sheet==='drive'">
  <h2>Google Drive</h2>
  <p v-if="driveCloud.connected" class="fine-print">已连接 {{driveCloud.google_email}}</p>
  <template v-if="!driveCloud.connected">
    <button class="primary full" :disabled="driveBusy||!driveCloud.enabled" @click="startGoogleAuthorization('drive')">连接 Google Drive</button>
    <p v-if="!driveCloud.enabled" class="fine-print">Google 授权配置尚未完成</p><p v-else-if="driveCloud.progress_error" class="fine-print">{{driveCloud.progress_error}}</p>
  </template>
  <template v-else>
    <label class="form-label">搜索文件<input v-model.trim="driveQuery" maxlength="120" placeholder="文件名"/></label>
    <button class="secondary full" :disabled="driveBusy" @click="loadDriveFiles(false)">搜索</button>
    <div v-for="f in driveItems" :key="f.id" class="recycle-row">
      <div class="item-info"><strong>{{f.name}}</strong></div>
      <button class="secondary small" :disabled="driveBusy" @click="chooseDriveFile(f)">导入</button>
    </div>
    <div v-if="!driveItems.length" class="empty">暂无文件</div>
    <button v-if="driveNext" class="secondary full" :disabled="driveBusy" @click="loadDriveFiles(true)">加载更多</button>
    <button class="destructive full" :disabled="driveBusy" @click="disconnectGoogle('drive')">断开连接</button>
  </template>
  <div class="sheet-actions"><button class="secondary full" @click="closeSheet">关闭</button></div>
</template>
<template v-else-if="sheet==='gmail'">
  <h2>Gmail</h2>
  <p v-if="gmailPersistent.connected" class="fine-print">已连接 {{gmailPersistent.google_email}}</p>
  <template v-if="!gmailAuthorizedUi">
    <button class="primary full" :disabled="gmailBusy||!gmailPersistent.enabled" @click="connectGmail">连接 Gmail</button>
    <p v-if="!gmailPersistent.enabled" class="fine-print">Google 授权配置尚未完成</p><p v-else-if="gmailPersistent.progress_error" class="fine-print">{{gmailPersistent.progress_error}}</p>
  </template>
  <template v-else>
    <form class="search-row gmail-search-form" @submit.prevent="loadGmailMessages(false)">
      <input v-model.trim="gmailQuery" type="search" maxlength="180"
        aria-label="搜索 Gmail 邮件" placeholder="发件人、主题或关键词"
        enterkeyhint="search" autocomplete="off"/>
      <button type="submit" class="filter-button icon-label" :disabled="gmailBusy"><UiIcon name="search" :size="17"/>搜索</button>
    </form>
    <p v-if="gmailSearched" class="fine-print">已显示 {{gmailItems.length}} 封 · 每次 5 封</p>
    <div v-for="m in gmailItems" :key="m.id" class="recycle-row">
      <div class="item-info"><strong>{{m.subject}}</strong><small>{{m.from}}</small><small>{{m.date}}</small></div>
      <button class="secondary small" :disabled="gmailBusy" @click="selectGmailMessage(m.id)">导入</button>
    </div>
    <div v-if="gmailSearched&&!gmailItems.length" class="empty">没有匹配的邮件</div>
    <button v-if="gmailNext&&gmailQuery.trim()===gmailLastQuery" class="secondary full" :disabled="gmailBusy" @click="loadGmailMessages(true)">加载更多（5 封）</button>
    <button class="destructive full" :disabled="gmailBusy" @click="disconnectGmail">断开连接</button>
  </template>
  <div class="sheet-actions"><button class="secondary full" @click="closeSheet">关闭</button></div>
</template>
<template v-else-if="sheet==='filter'">
  <h2>筛选文书</h2>
  <p class="fine-print picker-helper">点击字段选择，返回后统一应用筛选。</p>
  <div class="choice-form-field"><span class="choice-field-label">文书类型</span><button type="button" class="choice-field-control" @click="openChoice('category')"><span>{{choiceLabel('category')}}</span><UiIcon name="chevron-right" :size="18"/></button></div>
  <div class="choice-form-field"><span class="choice-field-label">可见范围</span><button type="button" class="choice-field-control" @click="openChoice('visibility')"><span>{{choiceLabel('visibility')}}</span><UiIcon name="chevron-right" :size="18"/></button></div>
  <div class="choice-form-field"><span class="choice-field-label">归档状态</span><button type="button" class="choice-field-control" @click="openChoice('archived')"><span>{{choiceLabel('archived')}}</span><UiIcon name="chevron-right" :size="18"/></button></div>
  <div class="choice-form-field"><span class="choice-field-label">收藏</span><button type="button" class="choice-field-control" @click="openChoice('favorite')"><span>{{choiceLabel('favorite')}}</span><UiIcon name="chevron-right" :size="18"/></button></div>
  <label class="form-label compact-month">创建月份（可留空）<input type="month" v-model="monthFilter"/></label>
  <div class="sheet-actions"><button class="secondary" type="button" @click="closeSheet">取消</button><button class="primary" type="button" :disabled="loadingPage" @click="searchDocs">{{loadingPage?'筛选中…':'应用筛选'}}</button></div>
</template>
<template v-else-if="sheet==='choicePicker'">
  <h2>选择{{choices[choiceField]?.title||'选项'}}</h2>
  <label v-if="pickerItems.length>5" class="form-label picker-search-label">搜索选项
    <input type="search" v-model="choiceSearch" maxlength="60" placeholder="搜索名称" autocomplete="off"/>
  </label>
  <div class="choice-picker-list" role="listbox" :aria-label="choices[choiceField]?.title||'选项'">
    <button v-for="option in visiblePickerItems" :key="option.value||'all'" type="button" role="option"
      class="choice-picker-item" :aria-selected="choiceValue(choiceField)===option.value" :class="{chosen:choiceValue(choiceField)===option.value}" @click="selectChoice(option.value)">
      <span>{{option.label}}</span><span v-if="choiceValue(choiceField)===option.value" class="choice-picker-check" aria-hidden="true">✓</span>
    </button>
    <p v-if="!visiblePickerItems.length" class="empty">没有匹配的选项。</p>
  </div>
  <div class="sheet-actions"><button class="secondary full" type="button" @click="backChoice">返回上一层</button></div>
</template>
<template v-else-if="sheet==='manualSalary'"><h2>手动补录工资收入</h2><p class="fine-print">这封银行通知没有金额。请根据银行入出金明细填写，系统将明确标记「人工补录」，不会伪装为原文提取，也不会自动向家計簿记账。</p><label class="form-label">实际到账金额（日元）<input v-model.trim="salaryAmountDraft" type="text" inputmode="numeric" maxlength="16" placeholder="例如：250000" /></label><label class="check-row"><input type="checkbox" v-model="salaryAmountConfirmed" /> 我已经核对银行实际入账金额，并确认不会重复记账</label><div class="sheet-actions"><button class="secondary" @click="sheet=''">取消</button><button class="primary" :disabled="busy||!salaryAmountConfirmed||!salaryAmountDraft.trim()" @click="saveManualSalary">保存并生成收入建议</button></div></template>
<template v-else-if="sheet==='field'"><h2>核对原文中的字段</h2><label class="form-label">确认值<input v-model="fieldDraft.value" /></label><div class="choice-form-field"><span class="choice-field-label">审核操作</span><button type="button" class="choice-field-control" @click="openChoice('reviewState')"><span>{{choiceLabel('reviewState')}}</span><UiIcon name="chevron-right" :size="18"/></button></div><label class="check-row"><input type="checkbox" v-model="fieldDraft.confirmRemote" /> 若该字段已经联动，我了解修改仅影响本 App；需要去目标 App 核对远端记录</label><div class="sheet-actions"><button class="secondary" @click="sheet=''">取消</button><button class="primary" :disabled="busy" @click="saveField">保存</button></div></template>
      <template v-else-if="sheet==='attachmentActions'">
        <h2>附件操作</h2>
        <p class="attachment-menu-filename" :title="selectedAttachment?.file_label">{{selectedAttachment?.file_label}}</p>
        <button class="settings-line attachment-action-line" type="button" :disabled="busy||(current?.attachments?.[0]?.id===selectedAttachment?.id)" @click="moveAttachmentFromMenu(-1)"><UiIcon name="arrow-up" :size="18"/>上移</button>
        <button class="settings-line attachment-action-line" type="button" :disabled="busy||(current?.attachments?.[(current?.attachments?.length||1)-1]?.id===selectedAttachment?.id)" @click="moveAttachmentFromMenu(1)"><UiIcon name="arrow-down" :size="18"/>下移</button>
        <button v-if="['image/jpeg','image/png','image/webp'].includes(selectedAttachment?.mime)" class="settings-line attachment-action-line" type="button" :disabled="busy" @click="runOcr(selectedAttachment)"><UiIcon name="scan" :size="18"/>Workers AI 识别</button>
        <button class="settings-line attachment-action-line" type="button" :disabled="busy" @click="openOcrSpace(selectedAttachment)"><UiIcon name="scan" :size="18"/>OCR.space 识别</button>
        <button class="settings-line attachment-action-line danger-text" type="button" :disabled="busy" @click="sheet='attachmentTrashConfirm'"><UiIcon name="trash" :size="18"/>移入回收站</button>
        <div class="sheet-actions"><button class="secondary full" type="button" @click="closeSheet">关闭</button></div>
      </template>
      <template v-else-if="sheet==='attachmentTrashConfirm'">
        <h2>移入回收站？</h2>
        <p class="confirmation-help">附件可从回收站恢复，已提取的文字会保留。</p>
        <div class="sheet-actions"><button class="secondary" type="button" :disabled="busy" @click="sheet='attachmentActions'">取消</button><button class="destructive" type="button" :disabled="busy" @click="confirmAttachmentTrash"><UiIcon name="trash" :size="17"/>确认移入</button></div>
      </template>
      <template v-else-if="sheet==='detailsMenu'"><h2>文书操作</h2><button class="settings-line" @click="sheet='shareConfirm'">{{current.visibility==='private'?'主动分享给家人':'改为仅自己'}} <UiIcon name="chevron-right" :size="18"/></button><button class="settings-line" @click="toggleDocument('favorite',!current.favorite)">{{current.favorite?'取消收藏':'收藏文书'}} <UiIcon name="chevron-right" :size="18"/></button><button class="settings-line" @click="toggleDocument('archived',!current.archived_at)">{{current.archived_at?'取消归档':'归档（停止首页提示）'}} <UiIcon name="chevron-right" :size="18"/></button><button class="settings-line danger-text" @click="askTrash">移入回收站 <UiIcon name="chevron-right" :size="18"/></button><div class="sheet-actions"><button class="secondary full" @click="sheet=''">取消</button></div></template>
      <template v-else-if="sheet==='shareConfirm'"><h2>确认家庭可见范围</h2><p>共享后第二位家庭成员可以读取标题、原文、字段和附件。工资、银行、税务资料可能含敏感信息。</p><div class="sheet-actions"><button class="secondary" @click="sheet=''">取消</button><button class="primary" :disabled="busy" @click="changeShare">{{current.visibility==='private'?'确认共享':'确认设为私人'}}</button></div></template>
      <template v-else-if="sheet==='trashListConfirm'">
        <h2>移入回收站？</h2>
        <p class="trash-confirm-title" :title="swipeTrashTarget?.title">{{swipeTrashTarget?.title}}</p>
        <p class="confirmation-help">可恢复，已同步到其他 App 的内容不受影响。</p>
        <div class="sheet-actions"><button class="secondary" type="button" :disabled="busy" @click="closeSheet">取消</button><button class="destructive" type="button" :disabled="busy" @click="trashFromList"><UiIcon name="trash" :size="17"/>确认移入</button></div>
      </template>
      <template v-else-if="sheet==='trashConfirm'">
        <h2>移入回收站？</h2>
        <p class="confirmation-help">文书和原件可恢复，已同步内容不受影响。</p>
        <div class="sheet-actions"><button class="secondary" type="button" @click="sheet=''">取消</button><button class="destructive" type="button" :disabled="busy" @click="trashCurrent"><UiIcon name="trash" :size="17"/>确认移入</button></div>
      </template>
      <template v-else-if="sheet==='recycle'">
        <div class="recycle-header">
          <h2>回收站</h2>
          <button v-if="trashItems.length||attachmentTrashItems.length"
            class="recycle-clear-button" type="button" :disabled="busy" @click="askEmptyRecycle">
            <UiIcon name="trash" :size="16"/>全部清空
          </button>
        </div>
        <p class="recycle-explain">删除可恢复，永久删除不可撤销。</p>
        <div v-if="!trashItems.length&&!attachmentTrashItems.length" class="recycle-empty">
          <UiIcon name="trash" :size="22"/>
          <span>回收站为空</span>
        </div>
        <div v-if="trashItems.length" class="recycle-list">
          <div v-for="d in trashItems" :key="d.id" class="recycle-row">
            <strong class="recycle-title" :title="d.title">{{d.title}}</strong>
            <div class="recycle-row-bottom">
              <small class="recycle-date">{{d.trashed_at?d.trashed_at.slice(0,10):'清理待重试'}}</small>
              <div class="recycle-row-actions">
                <button class="recycle-action restore" type="button" :disabled="busy" @click="restore(d.id)">恢复</button>
                <button class="recycle-action permanent" type="button" :disabled="busy" @click="askPermanent(d.id)">永久删除</button>
              </div>
            </div>
          </div>
          <button v-if="recycleNext!==null" class="text-button full recycle-more" type="button"
            :disabled="busy" @click="loadMoreTrash">查看更多文书</button>
        </div>
        <h3 v-if="attachmentTrashItems.length" class="recycle-subheading">附件回收站</h3>
        <div v-if="attachmentTrashItems.length" class="recycle-list">
          <div v-for="a in attachmentTrashItems" :key="a.id" class="recycle-row">
            <strong class="recycle-title" :title="a.file_label">{{a.file_label}}</strong>
            <div class="recycle-row-bottom">
              <small class="recycle-date">{{a.title}}</small>
              <div class="recycle-row-actions">
                <button class="recycle-action restore" type="button" :disabled="busy" @click="restoreAttachment(a.document_id,a.id)">恢复</button>
                <button class="recycle-action permanent" type="button" :disabled="busy"
                  @click="pendingAttachment=a;sheet='permanentAttachment'">永久删除</button>
              </div>
            </div>
          </div>
        </div>
        <div class="sheet-actions recycle-footer">
          <button class="secondary full" type="button" @click="closeSheet">完成</button>
        </div>
      </template>
      <template v-else-if="sheet==='emptyRecycleConfirm'">
         <h2 class="danger-text">永久清空回收站？</h2>
         <p class="confirmation-help">将永久删除回收站中的全部文书及附件，并清理不再被引用的 R2 原件。不能恢复。不会删除正常使用的文书。</p>
         <p v-if="busy" class="muted" role="status">正在清理，已处理 {{recycleEmptyProgress}} 项…</p>
         <div class="sheet-actions">
           <button class="secondary" type="button" :disabled="busy" @click="sheet='recycle'">取消</button>
           <button class="destructive" type="button" :disabled="busy" @click="emptyRecycle"><UiIcon name="trash" :size="17"/>确认全部清空</button>
         </div>
       </template>
       <template v-else-if="sheet==='permanentAttachment'"><h2 class="danger-text">永久删除这个附件？</h2><p>对应 R2 对象在最后一个引用删除后物理清理；文书的文字内容保留。无法直接撤销。</p><div class="sheet-actions"><button class="secondary" @click="sheet='recycle'">取消</button><button class="destructive" @click="deleteAttachment" :disabled="busy">确认清理</button></div></template>
      <template v-else-if="sheet==='permanent'"><h2 class="danger-text">永久删除文书？</h2><p>将从 D1 清理私人内容，并在没有其他文书引用该原件时同步物理删除 R2 文件。不能撤销。</p><div class="sheet-actions"><button class="secondary" @click="sheet='recycle'">取消</button><button class="destructive" :disabled="busy" @click="permanentDelete">确认永久删除</button></div></template>
      <template v-else-if="sheet==='calendar'"><h2>私人日历订阅</h2>
        <p class="fine-print">仅包含已人工确认的截止日期。默认隐藏文书名称、金额和个人资料。订阅链接相当于密码，请勿转发或公开。</p>
        <p>{{calendarStatusInfo?.active?'订阅已创建；重新生成将使旧地址失效':'目前未创建订阅'}}</p>
        <label class="check-row"><input type="checkbox" v-model="calendarShowTitle" />允许外部日历显示文书标题（隐私风险）</label>
        <div v-if="calendarLink"><label class="form-label">仅显示一次的订阅 URL<input :value="calendarLink" readonly @focus="$event.target.select()" /></label>
          <button class="secondary full" @click="copyCalendarLink">复制订阅地址</button>
          <p class="fine-print">iPhone：设置 → App → 日历 → 日历账户 → 添加账户 → 其他 → 添加已订阅的日历。</p></div>
        <div class="sheet-actions"><button class="secondary" @click="closeSheet">关闭</button>
          <button class="secondary" v-if="calendarStatusInfo?.active" :disabled="busy" @click="revokeCalendar">撤销链接</button>
          <button class="primary" :disabled="busy" @click="createCalendar">{{calendarStatusInfo?.active?'重新生成':'创建订阅'}}</button></div>
      </template>
      <template v-else-if="sheet==='sessions'"><h2>登录设备与会话</h2>
        <p class="fine-print">仅显示自己的登录会话。</p>
        <div v-if="!sessions.length" class="empty">暂无有效登录会话。</div>
        <div class="recycle-row" v-for="s in sessions" :key="s.id">
          <div class="item-info"><strong>{{s.is_current?'当前设备':'其他登录会话'}}</strong>
            <small>登录：{{s.created_at.slice(0,16).replace('T',' ')}} UTC</small>
            <small>失效：{{s.expires_at.slice(0,16).replace('T',' ')}} UTC</small>
          </div>
          <button v-if="!s.is_current" class="destructive small" :disabled="busy" @click="revokeSession(s.id)">撤销</button>
        </div>
        <button class="text-button full" v-if="sessionsNext!==null" :disabled="busy" @click="loadSessions(true)">加载更多</button>
        <div class="sheet-actions"><button class="secondary" @click="closeSheet">关闭</button>
          <button class="destructive" :disabled="busy||sessions.every(s=>s.is_current)" @click="revokeOtherSessions">撤销全部其他设备</button></div>
      </template>
      <template v-else-if="sheet==='changePassword'"><h2>修改登录密码</h2>
        <p class="fine-print">更改后此账号在所有设备上的旧会话都将失效，必须使用新密码重新登录；不会影响家人账号。</p>
        <label class="form-label">当前密码<input v-model="passwordDraft.current_password" type="password" autocomplete="current-password" /></label>
        <label class="form-label">新密码（至少12位）<input v-model="passwordDraft.new_password" type="password" autocomplete="new-password" /></label>
        <label class="form-label">确认新密码<input v-model="passwordDraft.confirm_password" type="password" autocomplete="new-password" /></label>
        <div class="sheet-actions"><button class="secondary" @click="closeSheet">取消</button><button class="primary" :disabled="busy||!passwordDraft.current_password||passwordDraft.new_password.length<12||passwordDraft.new_password!==passwordDraft.confirm_password" @click="changePassword">修改并退出旧会话</button></div></template>
      <template v-else-if="sheet==='invite'"><h2>邀请家人</h2><p class="muted">仅指定邮箱可使用邀请。</p><label class="form-label">对方邮箱<input v-model="inviteEmail" type="email" placeholder="family@example.com" /></label><button class="primary full" @click="issueInvite" :disabled="busy">生成 48 小时邀请码</button><label v-if="inviteToken" class="form-label">仅复制给家人使用<input :value="inviteToken" readonly @focus="$event.target.select()" /></label><div class="sheet-actions"><button class="secondary full" @click="closeSheet">完成</button></div></template>
      <template v-else-if="sheet==='ocrSpaceConfirm'"><h2>OCR.space</h2><p class="fine-print">将此附件发送至第三方识别。</p><label class="check-row"><input type="checkbox" v-model="ocrSpaceConsent"/>同意发送</label><div class="sheet-actions"><button class="secondary" @click="closeSheet">取消</button><button class="primary" :disabled="busy||!ocrSpaceConsent" @click="confirmOcrSpace">识别</button></div></template>
      <template v-else-if="sheet==='ocrConfirm'"><h2>AI 图片识别</h2><p class="fine-print">发送图片至 Cloudflare AI，结果需核对。</p><label class="check-row"><input type="checkbox" v-model="ocrRetryStale"/>重试超时任务</label><label class="check-row"><input type="checkbox" v-model="ocrRetryEmpty"/>重试空结果</label><div class="sheet-actions"><button class="secondary" @click="closeSheet">取消</button><button class="primary" :disabled="busy" @click="confirmRunOcr">识别</button></div></template>
      <template v-else-if="sheet==='editText'"><h2>人工核对日文原文</h2><p class="fine-print">请对照原图确认。修改文字将重新生成全部候选字段，先前审核的字段会被重置，不会自动记账或创建任务。</p><textarea v-model="editTextDraft" rows="10" placeholder="请输入或粘贴日文内容"></textarea><div class="sheet-actions"><button class="secondary" @click="closeSheet">取消</button><button class="primary" :disabled="busy||!editTextDraft.trim()" @click="saveSourceText">保存并重新分析</button></div></template>
      <template v-else-if="sheet==='backup'"><h2>备份与恢复</h2><p class="fine-print">一次最多 5 份、ZIP 不超过 32 MB。请保存到你选择的 iCloud Drive/电脑，不在本 App 长期保存。仅 JSON 无法恢复永久删除后的原件。</p>
        <label class="form-label">备份范围<select v-model="backupScope" @change="backupOffset=0"><option value="all">我的全部文书（分包）</option><option value="month">某个月份</option><option value="year">某个年份</option></select></label>
        <label v-if="backupScope!=='all'" class="form-label">{{backupScope==='year'?'年份（如 2026）':'月份（如 2026-11）'}}<input v-model="backupMonth" :placeholder="backupScope==='year'?'2026':'2026-11'" /></label>
        <label class="check-row"><input type="checkbox" v-model="backupIncludeOriginals" /> 包含 R2 私有原件（需要按需下载）</label>
        <label class="form-label">可选备份加密密码（至少12位）<input v-model="backupPass" type="password" autocomplete="new-password" placeholder="留空则输出未加密 ZIP" /></label>
        <p v-if="!backupPass" class="info-note">未加密备份可能包含个人资料。建议使用长密码加密，密码丢失将无法解密。</p>
        <button class="primary full" :disabled="busy" @click="exportData">{{backupOffset?'导出下一包':'导出第一包'}}</button>
        <div class="section-head"><h3>从备份恢复</h3></div><button class="secondary full" @click="backupInput?.click()">选择 ZIP / 加密 JDA 文件</button><input ref="backupInput" type="file" accept=".zip,.jda,application/zip" class="visually-hidden" @change="selectBackup" />
        <div class="sheet-actions"><button class="secondary full" @click="closeSheet">完成</button></div></template>
      <template v-else-if="sheet==='restoreBackup'"><h2>确认恢复备份</h2><p>检查恢复内容。仅在点击确认后写入 D1 和私有 R2，不重发三个 App 的历史财务/任务/学习记录。</p><div v-for="(x,i) in restorePreview" :key="i" class="recycle-row"><div class="item-info"><strong>{{x.title}}</strong><small>{{x.action==='skip_duplicate'?'已存在 · 跳过':'恢复资料'}}{{x.has_original_reference?' · 原件按备份内容恢复':''}}</small></div></div><div class="sheet-actions"><button class="secondary" @click="sheet='backup'">取消</button><button class="primary" :disabled="busy" @click="confirmRestore">确认恢复</button></div></template>
      <template v-else-if="sheet==='candidate'"><h2>确认跨 App 联动</h2>
        <p v-if="candidateDraft.kind==='finance'&&candidateMerchant" class="muted">消费商户：{{candidateMerchant}}</p>
        <label v-if="candidateDraft.kind==='finance'" class="form-label">{{current?.category==='card_spend'?'交易日期':'实际付款 / 到账日期'}}<input v-model="candidateDraft.date" type="date" /></label>
        <div v-if="candidateDraft.kind==='finance'" class="choice-form-field"><span class="choice-field-label">家計簿分类</span><button type="button" class="choice-field-control" :disabled="!ledgerOptions.categories.length" @click="openChoice('ledgerCategory')"><span>{{choiceLabel('ledgerCategory')}}</span><UiIcon name="chevron-right" :size="18"/></button></div>
        <div v-if="candidateDraft.kind==='finance'" class="choice-form-field"><span class="choice-field-label">家計簿支付方式</span><button type="button" class="choice-field-control" :disabled="!ledgerOptions.paymentSources.length" @click="openChoice('ledgerPaymentSource')"><span>{{choiceLabel('ledgerPaymentSource')}}</span><UiIcon name="chevron-right" :size="18"/></button></div>
        <p v-if="candidateDraft.kind==='finance'&&ledgerOptionsError" class="fine-print" role="status">{{ledgerOptionsError}}</p>
        <label v-if="candidateDraft.kind==='finance'&&ledgerAttempted" class="check-row"><input type="checkbox" v-model="ledgerMappingChangeConfirmed"/>已尝试同步，同意核对旧记录并防止重复记账</label>
        <label v-if="candidateDraft.kind==='finance'" class="form-label">备注<input v-model="candidateDraft.note" /></label>
        <label v-if="candidateDraft.kind==='homeflow_task'" class="form-label">任务名称<input v-model="candidateDraft.title" maxlength="120" /></label><p v-if="candidateDraft.kind==='homeflow_task'" class="fine-print">请先在「字段」核验原文日期；同步后创建的是 HomeFlow 待办，不会把配送时间当作缴费期限。</p>
        <div v-if="candidateDraft.kind==='homeflow_task'"><div class="choice-form-field"><span class="choice-field-label">任务可见范围</span><button type="button" class="choice-field-control" @click="openChoice('taskVisibility')"><span>{{choiceLabel('taskVisibility')}}</span><UiIcon name="chevron-right" :size="18"/></button></div></div>
        <label v-if="candidateDraft.kind==='homeflow_task' && candidateDraft.visibility==='household'" class="form-label">负责人 HomeFlow 用户 ID（可留空，默认双方）<input v-model="candidateDraft.assignee" maxlength="60" placeholder="仅填写家庭成员在 HomeFlow 的用户 ID" /></label>
        <label v-if="candidateDraft.kind==='homeflow_task' && candidateDraft.visibility==='household' && candidateDraft.assignee" class="form-label">指定对方时额外贡献积分（至少 1 分）<input v-model.number="candidateDraft.bonus_points" type="number" inputmode="numeric" min="0" max="10000" /><span class="fine-print">HomeFlow 现有规则要求指定其他成员时投入额外积分；请确认后再提交。余额不足时目标应用会拒绝，不会自动扣分。</span></label>
        <label v-if="candidateDraft.kind==='vocabulary'" class="form-label">确认脱敏后的日文词条<input v-model="candidateDraft.redacted_term" /></label>
        <label v-if="candidateDraft.kind==='sentence'" class="form-label">确认脱敏后的句子<input v-model="candidateDraft.redacted_sentence" /></label>
        <label v-if="['vocabulary','sentence'].includes(candidateDraft.kind)" class="check-row"><input type="checkbox" v-model="candidateDraft.privacy_confirmed" /> 已检查不含姓名、地址、账号及金额</label>
        <p v-if="!integrationConfigured" class="info-note">{{ledgerOptionsError||'目标安全桥接暂不可用，未写入目标 App。'}}</p>
        <div class="sheet-actions"><button class="secondary" @click="sheet=''">取消</button><button class="primary" :disabled="busy||!integrationConfigured||(candidateDraft.kind==='finance'&&(!candidateDraft.date||!ledgerOptions.categories.some(x=>x.value===candidateDraft.category)||!ledgerOptions.paymentSources.some(x=>x.value===candidateDraft.payment_source)||(ledgerAttempted&&!ledgerMappingChangeConfirmed)))" @click="commitApprovedCandidate">{{ledgerAttempted&&candidateDraft.kind==='finance'?'核对后同步':'本人确认后同步'}}</button></div></template>
      <template v-else-if="sheet==='original'"><h2>私人原件 · 按需加载</h2><img v-if="originalMime.startsWith('image/')" :src="originalUrl" alt="用户主动查看的文书原件" class="original-image" /><iframe v-else-if="originalMime==='application/pdf'" :src="originalUrl" title="文书 PDF 原件" class="original-pdf"></iframe><div class="sheet-actions"><button class="secondary full" @click="revokeOriginal();sheet=''">关闭并释放内存</button></div></template>
    </section>
  </div>
</div>
</template>
