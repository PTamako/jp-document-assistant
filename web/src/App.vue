<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, nextTick } from 'vue';
import { compressImage } from './compress.js';
import { readLocalText } from './mail-import.js';
import { drivePickerConfig,pickGoogleDriveFile,prepareGoogleDrivePicker,googlePickerReady } from './google-drive-picker.js';
import { isIosStandalonePwa } from './google-auth-context.js';
import {gmailConfigured,gmailConnected,gmailForget,preloadGmailIdentity,gmailIdentityReady,gmailAuthorize,gmailList,gmailReadOne,gmailRevoke} from './gmail-import.js';
import { extractDocumentText } from './document-text.js';
import { exportBatch,readBackup,restoreBatch } from './backup-client.js';
import { createAccountEpoch } from './account-epoch.js';
import TabIcon from './TabIcon.vue';
import UiIcon from './UiIcon.vue';
import { invalidateDocumentLists } from './document-list-cache.js';
import DocumentSwipeRow from './DocumentSwipeRow.vue';

const user=ref(null),csrf=ref(''),authMode=ref('login'),auth=reactive({email:'',password:'',setup_token:'',invite_token:'',display_name:''});
const initialized=ref(null);
const busy=ref(false),error=ref(''),notice=ref(''),activeTab=ref('today');
const passwordDraft=reactive({current_password:'',new_password:'',confirm_password:''});
const calendarLink=ref(''),calendarStatusInfo=ref(null),calendarShowTitle=ref(false);
const tabs=[{id:'today',name:'今日'},{id:'docs',name:'文书'},{id:'links',name:'联动'},{id:'mine',name:'我的'}];
const pages=reactive({today:{items:[],next:0,loaded:false},docs:{items:[],next:0,loaded:false},links:{items:[],next:0,loaded:false}});
const loadingPage=ref(false),search=ref(''),category=ref('');
const cats={salary:'工资／奖金',bank:'银行／信用卡',topup:'电子钱包／充值',tax:'税务／缴纳',utility:'水电燃气',housing:'房屋租赁',campaign:'活动／优惠',policy:'法规／政策',manual:'使用说明',travel:'旅行交通',delivery:'配送订单',other:'其他'};
const categoryOptions=Object.entries(cats);
const categoryIcon=kind=>({salary:'wallet',bank:'wallet',topup:'wallet',tax:'file-text',utility:'file-text',housing:'file-text',campaign:'tag',policy:'shield',manual:'book',travel:'calendar',delivery:'archive'}[kind]||'file');
const candidateIcon=kind=>({finance:'wallet',homeflow_task:'today',vocabulary:'book',sentence:'book'}[kind]||'links');
const integrationLabel=state=>({synced:'已同步',linked_existing:'已关联',failed:'同步失败',pending:'待确认'}[state]||'待确认');
const current=ref(null),detailTab=ref('explain'),detailCandidates=ref([]),detailLoading=ref(false),amountVisible=ref(false);
const swipeOpenId=ref(''),swipeTrashTarget=ref(null);
const sheet=ref(''),textDraft=reactive({title:'',text:'',retention:'summary',source_type:'text'}),fileDraft=ref(null),fileInput=ref(null),localTextInput=ref(null),localImportNote=ref(''),inputMode=ref('text');
const fileText=ref(''),fileWarning=ref(''),fileRetention=ref('original'),fileSource=ref('local_file');
const drivePickerAvailable=!!drivePickerConfig();
const iosStandalonePwa=isIosStandalonePwa();
const mainSiteUrl=typeof window==='undefined'?'':window.location.origin+'/';
const drivePickerReadyUi=ref(false),drivePickerLoadingUi=ref(false);
const gmailAvailable=gmailConfigured(),gmailAuthorizedUi=ref(false),gmailIdentityReadyUi=ref(false),gmailIdentityLoadingUi=ref(false),gmailQuery=ref('newer_than:30d'),gmailItems=ref([]),gmailNext=ref(null),gmailBusy=ref(false);
let gmailGeneration=0;
const fieldDraft=reactive({id:'',value:'',state:'confirmed',confirmRemote:false}),trashItems=ref([]),usage=ref(null),inviteEmail=ref(''),inviteToken=ref('');
const originalUrl=ref(''),originalMime=ref(''); let loadSerial=0;
const accountEpoch=createAccountEpoch();
let accountController=new AbortController();
const archivedFilter=ref('active'),favoriteFilter=ref('all'),visibilityFilter=ref('all'),monthFilter=ref('');
const editTextDraft=ref(''),backupFile=ref(null),backupPass=ref(''),backupScope=ref('all'),backupMonth=ref(''),backupIncludeOriginals=ref(true),backupOffset=ref(0),restoreArchive=ref(null),restorePreview=ref([]),attachmentTrashItems=ref([]);
const extraFileInput=ref(null),backupInput=ref(null),recycleNext=ref(null),recycleOffset=ref(0);
const pendingAttachment=ref(null),ocrAttachmentPending=ref(null),ocrRetryStale=ref(false),ocrRetryEmpty=ref(false),candidateDraft=reactive({id:'',kind:'',confirm:'',date:'',category:'',payment_source:'',note:'',visibility:'private',title:'',assignee:'',bonus_points:0,privacy_confirmed:false,redacted_term:'',redacted_sentence:''});
const integrationConfigured=ref(false);
const sessions=ref([]),sessionsNext=ref(null);

const fieldLabel={due_date:'办理／缴费期限',event_date:'扣款／配送日期',amount_jpy:'金额（日元）',net_salary:'实发金额（日元）',transaction_at:'交易完成时间',service_name:'服务名称',meter_period_start:'检针期间开始',meter_period_end:'检针期间结束',period_charge_jpy:'期间电费（日元）',usage_kwh:'用电量（kWh）',card_advance_date:'信用卡垫付日期'};
const candidateLabel={finance:'家計簿财务预览',homeflow_task:'HomeFlow 待办',vocabulary:'知学生词',sentence:'知学句子'};
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
 textSource:{title:'文书来源',items:[{value:'text',label:'粘贴文本'},{value:'mail_forward',label:'苹果邮件复制 / 转发'},{value:'gmail',label:'Gmail 逐封选择'},{value:'google_drive',label:'Google Drive 复制'},{value:'local_file',label:'本地文档文本'}]},
 textRetention:{title:'保存方式',items:[{value:'summary',label:'保存文字和分析结果'},{value:'analyze_only',label:'仅分析，不保存'}]},
 fileRetention:{title:'保存方式',items:[{value:'analyze_only',label:'仅分析，不保存'},{value:'summary',label:'仅保存文字，不上传 R2'},{value:'original',label:'保存私有原件到 R2'}]},
 reviewState:{title:'审核操作',items:[{value:'confirmed',label:'确认无误'},{value:'corrected',label:'修正为此值'},{value:'rejected',label:'无法确认 / 废弃候选'}]},
 taskVisibility:{title:'任务可见范围',items:[{value:'private',label:'仅自己'},{value:'household',label:'家庭共享'}]}
};
const fileHasTextLayer=computed(()=>/\.(pdf|docx|xlsx|pptx)$/i.test(fileDraft.value?.name||''));
function choiceValue(field){
 switch(field){
  case 'category':return category.value;
  case 'visibility':return visibilityFilter.value;
  case 'archived':return archivedFilter.value;
  case 'favorite':return favoriteFilter.value;
  case 'textSource':return textDraft.source_type;
  case 'textRetention':return textDraft.retention;
  case 'fileRetention':return fileRetention.value;
  case 'reviewState':return fieldDraft.state;
  case 'taskVisibility':return candidateDraft.visibility;
  default:return '';
 }
}
function choiceItems(field){
 const items=choices[field]?.items||[];
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
  case 'textSource':textDraft.source_type=value;break;
  case 'textRetention':textDraft.retention=value;break;
  case 'fileRetention':fileRetention.value=value;break;
  case 'reviewState':fieldDraft.state=value;break;
  case 'taskVisibility':candidateDraft.visibility=value;break;
 }
 backChoice();
}
function closeNestedSheet(){
 if(sheet.value==='choicePicker')backChoice();
 else if(sheet.value==='importSources')sheet.value='import';
 else closeSheet();
}

const showDue=(v)=>v?String(v):'日期待确认';
const pageData=computed(()=>pages[activeTab.value]||{items:[],next:null,loaded:true});
function flash(message){notice.value=message;error.value='';}
function problem(err){error.value=err?.message || '操作失败'; notice.value='';}
async function api(path,{method='GET',body,form=false,signal,idempotencyKey}={}){
  const epoch=accountEpoch.snapshot();
  const headers={}; if(body&&!form)headers['Content-Type']='application/json';
  if(!['GET','HEAD'].includes(method)&&csrf.value)headers['X-CSRF-Token']=csrf.value;
  if(idempotencyKey)headers['Idempotency-Key']=idempotencyKey;
  const resp=await fetch(path,{method,headers,body:form?body:(body?JSON.stringify(body):undefined),credentials:'same-origin',cache:'no-store',signal:signal||accountController.signal});
  const contentType=resp.headers.get('Content-Type')||'';
  const data=contentType.includes('application/json')?await resp.json():null;
  accountEpoch.assertCurrent(epoch);
  if(!resp.ok)throw new Error(data?.message||`HTTP ${resp.status}`);
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
  usage.value=null;trashItems.value=[];attachmentTrashItems.value=[];
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
async function openGmailSheet(){
  if(iosStandalonePwa){sheet.value='safariGoogleGuide';return;}
  gmailBusy.value=false;gmailAuthorizedUi.value=gmailConnected();
  gmailItems.value=[];gmailNext.value=null;sheet.value='gmail';
  gmailIdentityReadyUi.value=gmailIdentityReady();
  if(gmailIdentityReadyUi.value)return;
  gmailIdentityLoadingUi.value=true;
  try{
    await preloadGmailIdentity();
    gmailIdentityReadyUi.value=gmailIdentityReady();
  }catch(e){if(sheet.value==='gmail')problem(e);}
  finally{gmailIdentityLoadingUi.value=false;}
}
async function connectGmail(){
  if(!gmailIdentityReadyUi.value)return problem(new Error('Google 登录组件尚未准备好，请等待加载完成'));
  gmailBusy.value=true;
  try{await gmailAuthorize();gmailAuthorizedUi.value=gmailConnected();flash('Gmail 已连接，只读授权保存在本次页面内存中');}
  catch(e){problem(e);}finally{gmailBusy.value=false;}
}
async function loadGmailMessages(append=false){
  if(!gmailConnected()){gmailAuthorizedUi.value=false;return problem(new Error('Gmail 授权已过期，请重新授权'));}
  const serial=++gmailGeneration;
  gmailBusy.value=true;
  try{
    const result=await gmailList(gmailQuery.value,append?gmailNext.value||'':'');
    if(serial!==gmailGeneration||!user.value)return;
    const old=append?gmailItems.value:[];
    const ids=new Set(old.map(x=>x.id));
    gmailItems.value=[...old,...result.items.filter(x=>!ids.has(x.id))];
    gmailNext.value=result.nextPageToken;
  }catch(e){if(serial===gmailGeneration)problem(e);}
  finally{if(serial===gmailGeneration)gmailBusy.value=false;}
}
async function selectGmailMessage(id){
  const serial=++gmailGeneration;gmailBusy.value=true;
  try{
    const doc=await gmailReadOne(id);
    if(serial!==gmailGeneration||!user.value)return;
    textDraft.title=doc.title;textDraft.text=doc.text;
    textDraft.source_type='gmail';textDraft.retention='summary';
    localImportNote.value=doc.warning;inputMode.value='text';
    gmailItems.value=[];gmailNext.value=null;sheet.value='import';
    flash('已读取选中邮件正文；请核对后决定是否保存');
  }catch(e){problem(e);}finally{gmailBusy.value=false;}
}
async function disconnectGmail(){
  gmailGeneration++;gmailItems.value=[];gmailNext.value=null;
  gmailBusy.value=true;
  try{await gmailRevoke();flash('已清除 Gmail Token 并请求 Google 撤销授权');}
  catch(e){problem(e);}finally{gmailAuthorizedUi.value=false;gmailBusy.value=false;}
}
function clearGmailSession(){
  gmailGeneration++;gmailBusy.value=false;gmailForget();gmailAuthorizedUi.value=false;
  gmailItems.value=[];gmailNext.value=null;
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
async function openDoc(id){
  swipeOpenId.value='';
  detailLoading.value=true;amountVisible.value=false;detailCandidates.value=[];detailTab.value='explain';
  try{
    const d=await api(`/api/documents/${id}`);current.value=d.document;
    const c=await api(`/api/documents/${id}/candidates`);detailCandidates.value=c.items||[];
  }catch(e){problem(e);}finally{detailLoading.value=false;}
}
function closeDetail(){revokeOriginal();current.value=null;amountVisible.value=false;}
function closeSheet(){choiceField.value='';choiceSearch.value='';choiceReturnSheet.value='';swipeTrashTarget.value=null;if(sheet.value==='gmail'){gmailGeneration++;gmailBusy.value=false;gmailItems.value=[];gmailNext.value=null;gmailQuery.value='newer_than:30d';}calendarLink.value='';passwordDraft.current_password='';passwordDraft.new_password='';passwordDraft.confirm_password='';sheet.value='';editTextDraft.value='';localImportNote.value='';fileDraft.value=null;fileSource.value='local_file';ocrAttachmentPending.value=null;ocrRetryStale.value=false;ocrRetryEmpty.value=false;fileText.value='';fileWarning.value='';fileRetention.value='original';textDraft.text='';textDraft.title='';textDraft.source_type='text';textDraft.retention='summary';inviteToken.value='';if(fileInput.value)fileInput.value.value='';if(localTextInput.value)localTextInput.value.value='';}
function primeGooglePicker(){
  if(!drivePickerAvailable||iosStandalonePwa||drivePickerReadyUi.value||drivePickerLoadingUi.value)return;
  drivePickerLoadingUi.value=true;
  void prepareGoogleDrivePicker().then(()=>{
    drivePickerReadyUi.value=googlePickerReady();
  }).catch(e=>{if(sheet.value==='import')problem(e);}).finally(()=>{drivePickerLoadingUi.value=false;});
}
function openImport(mode='text'){
  inputMode.value=mode;sheet.value='import';
  // User explicitly opened the import panel. Prepare external scripts now so
  // clicking the Google button does not await before the OAuth popup.
  primeGooglePicker();
}
async function refreshDocumentsAfterSafari(){
  closeSheet();
  activeTab.value='docs';
  pages.docs.loaded=false;
  await loadTab('docs');
}
async function copySafariSite(){
  try{await navigator.clipboard.writeText(mainSiteUrl);flash('网址已复制，请打开 Safari 地址栏粘贴访问');}
  catch{problem(new Error('无法自动复制，请长按页面显示的网址，在 Safari 地址栏打开'));}
}
async function selectFile(event){
  const file=event.target.files?.[0];if(!file)return;
  fileDraft.value=file;fileSource.value='local_file';sheet.value='import';inputMode.value='file';fileText.value='';fileWarning.value='';
  const hasTextLayer=/\.(?:pdf|docx|xlsx|pptx)$/i.test(file.name);
  fileRetention.value=hasTextLayer?'summary':'original';
  if(!hasTextLayer)return;
  const epoch=accountEpoch.snapshot();busy.value=true;
  try{
    const parsed=await extractDocumentText(file);
    if(!accountEpoch.isCurrent(epoch)||fileDraft.value!==file)return;
    fileText.value=parsed.text;fileWarning.value=parsed.warning;
  }catch(e){problem(e);fileWarning.value=e.message;}
  finally{busy.value=false;if(fileInput.value)fileInput.value.value='';}
}

async function importFromGoogleDrive(){
  if(iosStandalonePwa){sheet.value='safariGoogleGuide';return;}
  if(!drivePickerReadyUi.value){
    primeGooglePicker();
    return problem(new Error('Google Drive 授权组件正在加载，请稍后再次点击'));
  }
  const epoch=accountEpoch.snapshot();busy.value=true;error.value='';
  try{
    const file=await pickGoogleDriveFile();
    accountEpoch.assertCurrent(epoch);
    if(!file)return; // Canceling Google Picker does not request an R2 upload or import.
    if(/\.(?:eml|txt)$/i.test(file.name)){
      const parsed=await readLocalText(file);
      accountEpoch.assertCurrent(epoch);
      textDraft.title=parsed.title;textDraft.text=parsed.text;
      textDraft.source_type='google_drive';textDraft.retention='summary';
      localImportNote.value='已从所选 Google 文件提取文字；请核对后决定是否保存。';
      inputMode.value='text';
    }else{
      fileDraft.value=file;fileSource.value='google_drive';inputMode.value='file';
      fileText.value='';fileWarning.value='';
      const isTextLayer=/\.(?:pdf|docx|xlsx|pptx)$/i.test(file.name);
      fileRetention.value=isTextLayer?'summary':'original';
      if(isTextLayer){
        const parsed=await extractDocumentText(file);
        if(!accountEpoch.isCurrent(epoch)||fileDraft.value!==file)return;
        fileText.value=parsed.text;
        fileWarning.value=parsed.warning||'';
      }
    }
    sheet.value='import';
  }catch(e){problem(e)}
  finally{busy.value=false}
}

async function importLocalText(event){
  const file=event.target.files?.[0];if(!file)return;
  const epoch=accountEpoch.snapshot();busy.value=true;try{
    const result=await readLocalText(file);
    accountEpoch.assertCurrent(epoch);
    textDraft.text=result.text;textDraft.title=result.title;textDraft.source_type=result.source_type;
    inputMode.value='text';localImportNote.value=result.warning;sheet.value='import';
  }catch(e){problem(e);}finally{busy.value=false;if(localTextInput.value)localTextInput.value.value='';}
}
async function importDocument(){
  busy.value=true;error.value='';
  try{
    let result;
    if(inputMode.value==='text'){
      if(!textDraft.text.trim())throw new Error('请先粘贴或输入日文内容');
      result=await api('/api/documents/import/text',{method:'POST',body:{title:textDraft.title,text:textDraft.text,source_type:textDraft.source_type,retention:textDraft.retention}});
    }else{
      if(!fileDraft.value)throw new Error('请先选择 PDF、Word、Excel、PowerPoint 或照片');
      if(fileRetention.value!=='original'){
        if(!fileText.value.trim())throw new Error('没有文字层，请人工填写或明确选择保留原件');
        result=await api('/api/documents/import/text',{method:'POST',body:{title:fileDraft.value.name,text:fileText.value,
          source_type:fileSource.value,retention:fileRetention.value}});
      }else{
        const compressed=await compressImage(fileDraft.value);
        const form=new FormData();form.append('file',compressed,compressed.name);form.append('retention','original');form.append('source_type',fileSource.value);
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
function startField(field){fieldDraft.id=field.id;fieldDraft.value=field.normalized_value||'';fieldDraft.state=field.review_state==='unreviewed'?'confirmed':field.review_state;fieldDraft.confirmRemote=false;sheet.value='field';}
async function saveField(){busy.value=true;try{
  const result=await api(`/api/fields/${fieldDraft.id}`,{method:'PATCH',body:{normalized_value:fieldDraft.value,review_state:fieldDraft.state,confirm_remote_unchanged:fieldDraft.confirmRemote}});
  const id=current.value.id;sheet.value='';await openDoc(id);
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
async function showRecycle(){sheet.value='recycle';await refreshTrash();}
async function refreshTrash(reset=true){try{if(reset)recycleOffset.value=0;
  const d=await api(`/api/recycle?limit=5&offset=${recycleOffset.value}`);
  trashItems.value=reset?d.items:[...trashItems.value,...d.items];recycleNext.value=d.next_offset;
  const a=await api('/api/recycle/attachments');attachmentTrashItems.value=a.items;
}catch(e){problem(e);}}
async function loadMoreTrash(){if(recycleNext.value===null)return;recycleOffset.value=recycleNext.value;await refreshTrash(false);}
async function restoreAttachment(d,a){busy.value=true;try{await api(`/api/documents/${d}/attachments/${a}/restore`,{method:'POST',body:{}});await refreshTrash();flash('附件已恢复，没有重复上传 R2');}catch(e){problem(e);}finally{busy.value=false;}}
async function trashAttachment(a){if(!current.value)return;busy.value=true;try{
  await api(`/api/documents/${current.value.id}/attachments/${a.id}/trash`,{method:'POST',body:{}});
  const id=current.value.id;await openDoc(id);flash('附件已移入回收站，文字结果保留');
}catch(e){problem(e);}finally{busy.value=false;}}
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
async function refreshInterpretation(){
 if(!current.value||busy.value)return;
 const id=current.value.id;
 busy.value=true;
 try{
   const result=await api(`/api/documents/${id}/reinterpret`,{method:'POST',body:{}});
   refreshDocumentViews();
   await openDoc(id);
   flash(`中文讲解已更新；补充 ${result.added_fields} 个待核验字段，原有核验及跨应用联动保持不变`+
     (result.privacy_auto_private?'；敏感文书已自动设为仅自己':''));
 }catch(e){problem(e);}finally{busy.value=false;}
}
function editText(){editTextDraft.value=current.value?.extracted_text_ja||'';sheet.value='editText';}
async function saveSourceText(){busy.value=true;try{await api(`/api/documents/${current.value.id}/source-text`,{method:'PATCH',body:{text:editTextDraft.value,confirm_reset_review:true}});const id=current.value.id;sheet.value='';editTextDraft.value='';await openDoc(id);flash('文字已保存并重新生成待核验字段');}catch(e){problem(e);}finally{busy.value=false;}}
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
 candidateDraft.date=d.confirmed_fields?.due_date||new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});
 candidateDraft.category='';candidateDraft.payment_source='';candidateDraft.note='';candidateDraft.title=item.payload?.title||current.value.title;
 candidateDraft.visibility=current.value.visibility==='shared'?'household':'private';candidateDraft.assignee='';candidateDraft.bonus_points=0;candidateDraft.privacy_confirmed=false;
 candidateDraft.redacted_term=item.payload?.term||'';candidateDraft.redacted_sentence=item.payload?.redacted_sentence||'';
 sheet.value='candidate';integrationConfigured.value=d.available;
 }catch(e){problem(e);}}
async function commitApprovedCandidate(){busy.value=true;try{const id=candidateDraft.id;
 const body={...candidateDraft,payment_confirmed:candidateDraft.kind==='finance'};
 const d=await api(`/api/candidates/${id}/commit`,{method:'POST',body,idempotencyKey:`jda-${id}`});
 sheet.value='';await openDoc(current.value.id);flash(d.already_synced?'已存在对应的联动记录':'联动已获目标 App 确认');
 }catch(e){problem(e);}finally{busy.value=false;}}

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
const labelFor=(key)=>key==='amount_jpy'&&current.value?.category==='utility'?'本次请款金额（日元）':(fieldLabel[key]||key);
const displayValue=(f)=>f.value_type==='money'&&!amountVisible.value?'••••••':f.normalized_value||'待确认';
onMounted(async()=>{await boot();if(!user.value)await refreshInitStatus();});
onBeforeUnmount(()=>{clearPrivateWorkspace();fileDraft.value=null;});
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
        <button class="item-card" v-for="d in pageData.items" :key="d.id" @click="openDoc(d.id)"><div class="item-icon"><UiIcon :name="categoryIcon(d.category)" :size="22"/></div><div class="item-info"><div class="item-title">{{d.title}}</div><p>{{cats[d.category]||d.category}} · {{showDue(d.due_date)}}</p></div><span class="state-tag" :class="{'danger':d.due_date&&dueState(d.due_date)==='已逾期'}">{{todayReviewBadge(d)}}</span></button>
        <button v-if="pageData.next!==null" class="load-more" :disabled="loadingPage" @click="loadTab('today',true)">{{loadingPage?'加载中…':'加载更多'}}</button>
      </section>
      <section v-else-if="activeTab==='docs'" class="page-surface" key="docs">
        <div class="search-row"><input v-model="search" type="search" placeholder="搜索标题或中文摘要" @keyup.enter="searchDocs" /><button class="filter-button icon-label" aria-label="文书筛选" @click="sheet='filter'"><UiIcon name="filter" :size="17"/>筛选</button><button class="filter-button icon-label" @click="searchDocs"><UiIcon name="search" :size="17"/>查找</button></div>
        <div class="section-head"><h3>文书库</h3><span>{{category?cats[category]:'全部类型'}}</span></div>
        <p v-if="pageData.items.length" class="fine-print swipe-hint">左滑或点击右侧按钮，可移入回收站。</p>
        <div v-if="!pageData.items.length&&!loadingPage" class="empty">没有匹配的文书。</div>
        <DocumentSwipeRow v-for="d in pageData.items" :key="d.id" :id="d.id"
          :revealed="swipeOpenId===d.id" :disabled="busy"
          @reveal="swipeOpenId=d.id" @hide="swipeOpenId=''" @delete="askTrashFromList(d)">
          <button class="item-card" type="button" @click="openDoc(d.id)"><div class="item-icon"><UiIcon :name="categoryIcon(d.category)" :size="22"/></div><div class="item-info"><div class="item-title">{{d.title}}</div><p>{{d.favorite?'★ · ':''}}{{cats[d.category]||d.category}} · {{d.visibility==='shared'?'家庭共享':'仅自己'}}{{d.archived_at?' · 已归档':''}}</p></div><span class="state-tag">{{documentReviewLabel(d)}}</span></button>
        </DocumentSwipeRow>
        <button v-if="pageData.next!==null" class="load-more" :disabled="loadingPage" @click="loadTab('docs',true)">加载更多</button>
      </section>
      <section v-else-if="activeTab==='links'" class="page-surface" key="links">
        <div class="info-note">核对提取结果后，再选择同步到目标 App。</div>
        <div class="section-head"><h3>待确认的联动</h3><span>独立核验 · 幂等</span></div>
        <div v-if="!pageData.items.length&&!loadingPage" class="empty">文书识别后的财务、任务、学习建议会出现在这里。</div>
        <button class="item-card" v-for="item in pageData.items" :key="item.id" @click="openDoc(item.document_id)"><div class="item-icon"><UiIcon :name="candidateIcon(item.candidate_kind)" :size="22"/></div><div class="item-info"><div class="item-title">{{candidateLabel[item.candidate_kind]}}</div><p>{{item.title}} · {{integrationLabel(item.integration_state)}}</p></div><span class="state-tag">预览</span></button>
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
        <div class="info-note" v-if="usage">Cloudflare 全账号免费额度：<strong>未确认</strong>。本地统计 AI 调用 {{usage.local_today.ai_calls}} 次，不代表全账号剩余额度。</div>
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
      <h2>{{current.title}}</h2>
      <p class="detail-note">{{documentReviewLabel(current)}} · {{current.import_mode==='original'?'私有原件':'文字摘要'}}</p>
      <div class="segments detail-tabs"><button v-for="t in [{id:'explain',name:'讲解'},{id:'finance',name:'字段'},{id:'tasks',name:'待办'},{id:'study',name:'学习'},{id:'original',name:'原文'}]" :key="t.id" :class="{selected:detailTab===t.id}" @click="detailTab=t.id">{{t.name}}</button></div>
      <section v-if="detailTab==='explain'"><div v-if="['policy','government','terms','campaign'].includes(current.category)" class="content-card"><h3>原文版本与官方核验</h3><p>原文注明的日期：{{current.source_document_date||'未能确定（请核对原件）'}}</p><p v-if="current.source_date_quote" class="muted">来源：{{current.source_date_quote}}</p><p>当前官方有效性：{{current.official_current_verified_at||'尚未核验'}}</p><p class="fine-print">此处只记录上传文书的日期线索，不自动推断你符合政策或优惠资格。</p></div><div class="content-card"><h3>中文说明</h3><p class="multiline">{{current.explanation_zh||'当前仅保存原件。图像 OCR 尚未验证，建议使用粘贴文字导入。'}}</p><button class="secondary full icon-label" type="button" :disabled="busy||!current.extracted_text_ja" @click="refreshInterpretation"><UiIcon name="refresh-cw" :size="17"/>重新讲解并补充字段</button><p class="fine-print">只补充缺失字段，不覆盖已核验的数据，也不会修改其他 App 的记录。</p></div><p class="fine-print">仅解释上传版本；政策、法律与活动的现行有效性未经官方核实。</p></section>
      <section v-if="detailTab==='finance'"><div class="section-head"><h3>从原文提取的字段</h3><button class="text-button icon-label" @click="amountVisible=!amountVisible"><UiIcon :name="amountVisible?'eye-off':'eye'" :size="17"/>{{amountVisible?'隐藏金额':'显示金额'}}</button></div><div v-if="!current.fields?.length" class="empty">暂无字段。可使用文字导入进行规则提取。</div><button class="field-card" v-for="field in current.fields" :key="field.id" @click="startField(field)"><div><span class="muted">{{labelFor(field.field_key)}}</span><strong>{{displayValue(field)}}</strong><small>原文：{{field.source_quote||'未记录'}}</small></div><span class="state-tag">{{field.review_state==='unreviewed'?'待确认':'已核验'}}</span></button><div class="info-note">账单金额不是已支付。工资单金额也不是已到账；必须对照原件确认。</div></section>
      <section v-if="detailTab==='tasks'"><h3 class="section-title">待办与财务建议</h3>
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
        <div class="content-card" v-for="item in detailCandidates.filter(c=>['finance','homeflow_task'].includes(c.candidate_kind))" :key="item.id"><h3>{{candidateLabel[item.candidate_kind]}}</h3><p class="muted">{{item.candidate_kind==='finance'?'收支类型：'+item.payload.kind+'；金额须再次确认':'截止日：'+item.payload.due_on}}</p><button class="secondary small" @click="prepareCandidate(item)">查看预览 / 确认联动</button></div>
        <p v-if="!topupAdvice&&!detailCandidates.some(c=>['finance','homeflow_task'].includes(c.candidate_kind))" class="muted">暂无待办或财务建议。这不代表邮件识别失败；可在「字段」中核对已提取的信息。</p>
        <p v-else-if="!topupAdvice" class="fine-print">确认后才写入目标 App。</p>
      </section>
      <section v-if="detailTab==='study'"><h3 class="section-title">值得记住的日文词语</h3><div class="content-card" v-for="item in detailCandidates.filter(c=>c.candidate_kind==='vocabulary')" :key="item.id"><strong>{{item.payload.term}}</strong><p class="muted">{{item.payload.reading}} · {{item.payload.meaning_zh}}</p><button class="secondary small" @click="prepareCandidate(item)">脱敏并确认加入</button></div><div v-if="!detailCandidates.some(c=>c.candidate_kind==='vocabulary')" class="empty">尚未找到可复用词语。</div></section>
      <section v-if="detailTab==='original'"><div class="content-card"><h3>原文与原件</h3><p class="multiline" v-if="current.extracted_text_ja">{{current.extracted_text_ja}}</p><p v-else class="muted">原文尚未提取，可查看附件。</p><button class="secondary full" @click="editText">人工输入 / 修正 OCR 文字</button><button class="secondary full icon-label" @click="extraFileInput?.click()"><UiIcon name="plus" :size="18"/>添加扫描页或附件</button><input class="visually-hidden" ref="extraFileInput" type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" @change="appendFiles" /><div class="attachment-row" v-for="(a,i) in current.attachments" :key="a.id"><button class="secondary" @click="showOriginal(a)">查看 · {{a.file_label}}</button><button class="secondary small" :disabled="busy||i===0" :aria-label="`将${a.file_label}上移一页`" @click="moveAttachment(a,-1)"><UiIcon name="arrow-up" :size="16"/></button><button class="secondary small" :disabled="busy||i===current.attachments.length-1" :aria-label="`将${a.file_label}下移一页`" @click="moveAttachment(a,1)"><UiIcon name="arrow-down" :size="16"/></button><button class="secondary small" @click="runOcr(a)"><UiIcon name="scan" :size="16"/>识别文字</button><button class="secondary small danger-text" @click="trashAttachment(a)"><UiIcon name="trash" :size="16"/>移入回收站</button></div></div><p class="fine-print">原件仅在查看时加载。</p></section>
    </div>
  </div>

  <div v-if="sheet" class="sheet-overlay" @click.self="sheet==='original'?(revokeOriginal(),sheet=''):closeNestedSheet()">
    <section class="bottom-sheet" role="dialog" aria-modal="true" :aria-label="sheet">
      <div class="grabber"></div>
      <template v-if="sheet==='import'"><h2>扫描 / 导入文书</h2><div class="segments"><button :class="{selected:inputMode==='text'}" @click="inputMode='text'">粘贴文字</button><button :class="{selected:inputMode==='file'}" @click="inputMode='file'">文件 / 照片</button></div>
  <button class="secondary full import-source-toggle" type="button" @click="sheet='importSources'">选择导入来源（本地 / Gmail / Google Drive）<UiIcon name="chevron-right" :size="18"/></button><template v-if="inputMode==='text'"><label class="form-label">标题（可选）<input v-model="textDraft.title" maxlength="200" placeholder="例如：11 月电费通知" /></label><label class="form-label">日文内容<textarea v-model="textDraft.text" rows="7" maxlength="100000" placeholder="从苹果邮件复制正文，或粘贴可复制的 PDF／Google Drive 文字…"></textarea></label><p v-if="localImportNote" class="fine-print">{{localImportNote}}</p><div class="choice-form-field"><span class="choice-field-label">来源</span><button type="button" class="choice-field-control" @click="openChoice('textSource')"><span>{{choiceLabel('textSource')}}</span><UiIcon name="chevron-right" :size="18"/></button></div><div class="choice-form-field"><span class="choice-field-label">保存方式</span><button type="button" class="choice-field-control" @click="openChoice('textRetention')"><span>{{choiceLabel('textRetention')}}</span><UiIcon name="chevron-right" :size="18"/></button></div></template>
        <template v-else><div class="upload-box"><p>{{fileDraft?fileDraft.name:'选择 PDF、Word、Excel、PowerPoint 或照片'}}</p><button class="secondary" @click="fileInput?.click()">选取文件</button><input ref="fileInput" type="file" accept="image/jpeg,image/png,image/webp,image/*,.pdf,.docx,.xlsx,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation" class="visually-hidden" @change="selectFile" /></div><p v-if="fileWarning" class="fine-print">{{fileWarning}}</p><label v-if="/\.(pdf|docx|xlsx|pptx)$/i.test(fileDraft?.name||'')" class="form-label">文件文字层（可核对修改）<textarea v-model="fileText" rows="6" maxlength="100000" placeholder="扫描页请人工输入原文"></textarea></label><div class="choice-form-field"><span class="choice-field-label">保存方式</span><button type="button" class="choice-field-control" @click="openChoice('fileRetention')"><span>{{choiceLabel('fileRetention')}}</span><UiIcon name="chevron-right" :size="18"/></button></div><p class="fine-print">支持本地文字提取；图片按需压缩。</p></template>
        <div class="sheet-actions"><button class="secondary" @click="closeSheet">取消</button><button class="primary" :disabled="busy" @click="importDocument">{{busy?'处理中…':inputMode==='file'&&fileRetention==='original'?'确认保存原件':'开始处理'}}</button></div></template>
      <template v-else-if="sheet==='importSources'">
  <h2>选择导入来源</h2>
  <p class="fine-print">仅在你选取文件或邮件时读取；不会自动同步整个账号。Google Docs 原生格式需先导出 PDF 等再选取。</p>
  <label class="choice-picker-file">
    <UiIcon name="file" :size="20"/><span>iPhone「文件」/ 本地 PDF、Office、图片</span><UiIcon name="chevron-right" :size="18"/>
    <input type="file" class="visually-hidden" accept="image/jpeg,image/png,image/webp,image/*,.pdf,.docx,.xlsx,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation" @change="selectFile" />
  </label>
  <label class="choice-picker-file">
    <UiIcon name="file-text" :size="20"/><span>本地 .eml 邮件 / .txt 文本</span><UiIcon name="chevron-right" :size="18"/>
    <input type="file" class="visually-hidden" accept=".eml,.txt,message/rfc822,text/plain" @change="importLocalText" />
  </label>
  <button v-if="gmailAvailable" class="choice-picker-file" type="button" @click="openGmailSheet"><UiIcon name="mail" :size="20"/><span>{{iosStandalonePwa?'Gmail（在 Safari 授权）':'从 Gmail 选择邮件'}}</span><UiIcon name="chevron-right" :size="18"/></button>
  <button v-if="drivePickerAvailable" class="choice-picker-file" type="button" :disabled="!iosStandalonePwa&&!drivePickerReadyUi" @click="importFromGoogleDrive"><UiIcon name="file" :size="20"/><span>{{iosStandalonePwa?'Google Drive（在 Safari 授权）':drivePickerLoadingUi?'Google Drive 准备中…':'从 Google Drive 选择文件'}}</span><UiIcon name="chevron-right" :size="18"/></button>
  <div class="sheet-actions"><button class="secondary full" type="button" @click="sheet='import'">返回导入表单</button></div>
</template>
<template v-else-if="sheet==='safariGoogleGuide'">
        <h2>请在 Safari 中完成 Google 授权</h2>
        <p class="info-note">iPhone 主屏幕 PWA 可能拦截 Google 授权弹窗。</p>
        <p>请复制下方网址，在 <strong>Safari 地址栏</strong>打开文书助手并登录，点击右上角「＋」，再选择 Gmail 或 Google Drive。</p>
        <button class="primary full" type="button" @click="copySafariSite">复制文书助手网址</button>
        <a class="secondary full safari-link" :href="mainSiteUrl" target="_blank" rel="noopener noreferrer">尝试在浏览器中打开</a>
        <p class="fine-print safari-url">{{mainSiteUrl}}</p>
        <p class="fine-print">Safari 保存后，回到这里刷新文书库即可。</p>
        <button class="secondary full" type="button" :disabled="loadingPage" @click="refreshDocumentsAfterSafari">{{loadingPage?'正在刷新文书库…':'刷新文书库'}}</button>
        <div class="sheet-actions"><button class="secondary full" @click="closeSheet">返回</button></div>
      </template>
      <template v-else-if="sheet==='gmail'"><h2>Gmail · 只读选取</h2>
        <p class="fine-print">一次最多浏览五封邮件；选择后只读取正文，保存前需确认。</p>
        <button v-if="!gmailAuthorizedUi" class="primary full" :disabled="gmailBusy||gmailIdentityLoadingUi||!gmailIdentityReadyUi" @click="connectGmail">{{gmailIdentityLoadingUi?'正在准备 Google 登录…':'授权 Gmail 只读访问'}}</button><button v-if="!gmailAuthorizedUi&&!gmailIdentityLoadingUi&&!gmailIdentityReadyUi" class="text-button full" type="button" @click="openGmailSheet">重试加载 Google 登录组件</button>
        <template v-else>
          <label class="form-label">Gmail 搜索条件<input v-model.trim="gmailQuery" maxlength="180" placeholder="newer_than:30d" /></label>
          <button class="secondary full" :disabled="gmailBusy" @click="loadGmailMessages(false)">搜索邮件（每页五封）</button>
          <div v-if="!gmailItems.length" class="empty">尚未查询，或没有符合条件的邮件。</div>
          <div class="recycle-row" v-for="m in gmailItems" :key="m.id">
            <div class="item-info"><strong>{{m.subject}}</strong><small>{{m.from}}</small><small>{{m.date}}</small></div>
            <button class="secondary small" :disabled="gmailBusy" @click="selectGmailMessage(m.id)">选取正文</button>
          </div>
          <button v-if="gmailNext" class="text-button full" :disabled="gmailBusy" @click="loadGmailMessages(true)">继续查看五封</button>
          <button class="destructive full" :disabled="gmailBusy" @click="disconnectGmail">撤销 Gmail 授权</button>
        </template>
        <p class="fine-print">Gmail 只读授权受 Google 限制；Apple Mail 聚合邮箱无法直接读取。</p>
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
<template v-else-if="sheet==='field'"><h2>核对原文中的字段</h2><label class="form-label">确认值<input v-model="fieldDraft.value" /></label><div class="choice-form-field"><span class="choice-field-label">审核操作</span><button type="button" class="choice-field-control" @click="openChoice('reviewState')"><span>{{choiceLabel('reviewState')}}</span><UiIcon name="chevron-right" :size="18"/></button></div><label class="check-row"><input type="checkbox" v-model="fieldDraft.confirmRemote" /> 若该字段已经联动，我了解修改仅影响本 App；需要去目标 App 核对远端记录</label><div class="sheet-actions"><button class="secondary" @click="sheet=''">取消</button><button class="primary" :disabled="busy" @click="saveField">保存</button></div></template>
      <template v-else-if="sheet==='detailsMenu'"><h2>文书操作</h2><button class="settings-line" @click="sheet='shareConfirm'">{{current.visibility==='private'?'主动分享给家人':'改为仅自己'}} <UiIcon name="chevron-right" :size="18"/></button><button class="settings-line" @click="toggleDocument('favorite',!current.favorite)">{{current.favorite?'取消收藏':'收藏文书'}} <UiIcon name="chevron-right" :size="18"/></button><button class="settings-line" @click="toggleDocument('archived',!current.archived_at)">{{current.archived_at?'取消归档':'归档（停止首页提示）'}} <UiIcon name="chevron-right" :size="18"/></button><button class="settings-line danger-text" @click="askTrash">移入回收站 <UiIcon name="chevron-right" :size="18"/></button><div class="sheet-actions"><button class="secondary full" @click="sheet=''">取消</button></div></template>
      <template v-else-if="sheet==='shareConfirm'"><h2>确认家庭可见范围</h2><p>共享后第二位家庭成员可以读取标题、原文、字段和附件。工资、银行、税务资料可能含敏感信息。</p><div class="sheet-actions"><button class="secondary" @click="sheet=''">取消</button><button class="primary" :disabled="busy" @click="changeShare">{{current.visibility==='private'?'确认共享':'确认设为私人'}}</button></div></template>
      <template v-else-if="sheet==='trashListConfirm'">
        <h2>移入回收站？</h2>
        <p>「{{swipeTrashTarget?.title}}」将从文书库隐藏。原件仍保留在私有 R2，随时可从「我的 → 回收站」恢复；不会删除已同步到其他 App 的任务、账目或生词。</p>
        <div class="sheet-actions"><button class="secondary" :disabled="busy" @click="closeSheet">取消</button><button class="destructive" :disabled="busy" @click="trashFromList"><UiIcon name="trash" :size="16"/>移入回收站</button></div>
      </template>
      <template v-else-if="sheet==='trashConfirm'"><h2>移入回收站？</h2><p>文书将从普通列表隐藏。R2 原件仍占空间，但可随时恢复。永久删除需另行确认。</p><div class="sheet-actions"><button class="secondary" @click="sheet=''">取消</button><button class="destructive" :disabled="busy" @click="trashCurrent"><UiIcon name="trash" :size="16"/>移入回收站</button></div></template>
      <template v-else-if="sheet==='recycle'"><h2>回收站</h2><p class="muted">删除可恢复，永久删除不可撤销。</p><div v-if="!trashItems.length" class="empty">回收站为空。</div><div v-for="d in trashItems" :key="d.id" class="recycle-row"><div class="item-info"><strong>{{d.title}}</strong><small>{{d.trashed_at?d.trashed_at.slice(0,10):'清理待重试'}}</small></div><button class="secondary small" @click="restore(d.id)" :disabled="busy">恢复</button><button class="destructive small" @click="askPermanent(d.id)">永久删除</button></div><button v-if="recycleNext!==null" class="text-button full" @click="loadMoreTrash">查看更多文书</button><h3>附件回收站</h3><div class="recycle-row" v-for="a in attachmentTrashItems" :key="a.id"><div class="item-info"><strong>{{a.file_label}}</strong><small>{{a.title}}</small></div><button class="secondary small" @click="restoreAttachment(a.document_id,a.id)">恢复</button><button class="destructive small" @click="pendingAttachment=a;sheet='permanentAttachment'">清理</button></div><div class="sheet-actions"><button class="secondary full" @click="closeSheet">完成</button></div></template>
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
      <template v-else-if="sheet==='ocrConfirm'"><h2>确认本次图片识别</h2><p>仅将这张私有图片发送至 Cloudflare Workers AI。可能消耗与其他应用共用的免费额度，账户余额仍未确认；此功能默认关闭，只有管理员启用后可用。</p><p class="fine-print">相同图片会复用已完成的识别候选。结果不能作为账单付款、实际收入或政策现行有效性的证明；须对照原图核对。</p><label class="check-row"><input type="checkbox" v-model="ocrRetryStale" />上次任务卡住超过24小时时允许重新调用模型（可能再次消耗额度）</label><label class="check-row"><input type="checkbox" v-model="ocrRetryEmpty" />上次结果为空且已过24小时：再次识别一次（同样消耗免费预算）</label><div class="sheet-actions"><button class="secondary" @click="closeSheet">取消</button><button class="primary" :disabled="busy" @click="confirmRunOcr">确认尝试 OCR</button></div></template>
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
      <template v-else-if="sheet==='candidate'"><h2>确认跨 App 联动</h2><p class="fine-print">只有目标应用独立授权、服务端签名与账户映射配置完成才能写入。重复提交沿用同一幂等键。</p>
        <label v-if="candidateDraft.kind==='finance'" class="form-label">实际付款 / 到账日期<input v-model="candidateDraft.date" type="date" /></label>
        <label v-if="candidateDraft.kind==='finance'" class="form-label">目标账本分类<input v-model="candidateDraft.category" placeholder="例如：税金・社会保険" /></label>
        <label v-if="candidateDraft.kind==='finance'" class="form-label">目标账本支付方式 / 账户<input v-model="candidateDraft.payment_source" placeholder="填写目标 App 已存在的名称" /></label>
        <label v-if="candidateDraft.kind==='finance'" class="form-label">备注<input v-model="candidateDraft.note" /></label>
        <label v-if="candidateDraft.kind==='homeflow_task'" class="form-label">任务名称<input v-model="candidateDraft.title" maxlength="120" /></label>
        <div v-if="candidateDraft.kind==='homeflow_task'"><div class="choice-form-field"><span class="choice-field-label">任务可见范围</span><button type="button" class="choice-field-control" @click="openChoice('taskVisibility')"><span>{{choiceLabel('taskVisibility')}}</span><UiIcon name="chevron-right" :size="18"/></button></div></div>
        <label v-if="candidateDraft.kind==='homeflow_task' && candidateDraft.visibility==='household'" class="form-label">负责人 HomeFlow 用户 ID（可留空，默认双方）<input v-model="candidateDraft.assignee" maxlength="60" placeholder="仅填写家庭成员在 HomeFlow 的用户 ID" /></label>
        <label v-if="candidateDraft.kind==='homeflow_task' && candidateDraft.visibility==='household' && candidateDraft.assignee" class="form-label">指定对方时额外贡献积分（至少 1 分）<input v-model.number="candidateDraft.bonus_points" type="number" inputmode="numeric" min="0" max="10000" /><span class="fine-print">HomeFlow 现有规则要求指定其他成员时投入额外积分；请确认后再提交。余额不足时目标应用会拒绝，不会自动扣分。</span></label>
        <label v-if="candidateDraft.kind==='vocabulary'" class="form-label">确认脱敏后的日文词条<input v-model="candidateDraft.redacted_term" /></label>
        <label v-if="candidateDraft.kind==='sentence'" class="form-label">确认脱敏后的句子<input v-model="candidateDraft.redacted_sentence" /></label>
        <label v-if="['vocabulary','sentence'].includes(candidateDraft.kind)" class="check-row"><input type="checkbox" v-model="candidateDraft.privacy_confirmed" /> 已检查不含姓名、地址、账号及金额</label>
        <p v-if="!integrationConfigured" class="info-note">目标安全桥接尚未配置。你仍可预览，但现在提交会明确失败、不会修改另一个 App。</p>
        <div class="sheet-actions"><button class="secondary" @click="sheet=''">取消</button><button class="primary" :disabled="busy||!integrationConfigured" @click="commitApprovedCandidate">本人确认后同步</button></div></template>
      <template v-else-if="sheet==='original'"><h2>私人原件 · 按需加载</h2><img v-if="originalMime.startsWith('image/')" :src="originalUrl" alt="用户主动查看的文书原件" class="original-image" /><iframe v-else-if="originalMime==='application/pdf'" :src="originalUrl" title="文书 PDF 原件" class="original-pdf"></iframe><div class="sheet-actions"><button class="secondary full" @click="revokeOriginal();sheet=''">关闭并释放内存</button></div></template>
    </section>
  </div>
</div>
</template>
