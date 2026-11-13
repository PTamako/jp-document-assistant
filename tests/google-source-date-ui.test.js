import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=(path)=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const app=read('web/src/App.vue');
const css=read('web/src/style.css');
const icon=read('web/src/UiIcon.vue');
const drive=app.slice(app.indexOf('<template v-else-if="sheet===\'drive\'">'),app.indexOf('<template v-else-if="sheet===\'gmail\'">'));
const gmail=app.slice(app.indexOf('<template v-else-if="sheet===\'gmail\'">'),app.indexOf('<template v-else-if="sheet===\'filter\'">'));

test('Drive and Gmail sheets use compact source rows, not recycler cards or full-width import buttons',()=>{
  for(const block of [drive,gmail]){
    assert.match(block,/class="google-source-header"/);
    assert.match(block,/class="google-source-list"/);
    assert.match(block,/class="google-source-row"/);
    assert.match(block,/class="google-import-action"/);
    assert.doesNotMatch(block,/class="recycle-row"/);
    assert.doesNotMatch(block,/>断开连接<\/button>/);
    assert.doesNotMatch(block,/class="sheet-actions"/);
  }
  assert.match(css,/\.google-source-row\{[^}]*grid-template-columns:36px minmax\(0,1fr\) auto/);
  assert.match(css,/\.google-source-row-info strong\{[^}]*-webkit-line-clamp:2/);
  assert.match(css,/\.google-source-header\{[^}]*grid-template-columns:44px minmax\(0,1fr\) 44px/);
});

test('disconnect lives only in top right, accessible and retains existing disconnect behavior',()=>{
  assert.match(drive,/aria-label="断开 Google Drive 连接"[^>]*@click="disconnectGoogle\('drive'\)"/);
  assert.match(gmail,/aria-label="断开 Gmail 连接"[^>]*@click="disconnectGmail"/);
  assert.match(drive,/aria-label="关闭 Google Drive"[^>]*@click="closeSheet"/);
  assert.match(gmail,/aria-label="关闭 Gmail"[^>]*@click="closeSheet"/);
  assert.match(icon,/name==='unlink'/);
  assert.match(app,/'google-source-sheet':\['drive','gmail'\]\.includes\(sheet\)/);
});

test('Drive search sits in a single horizontal form and Gmail still supports five-at-a-time paging',()=>{
  assert.match(drive,/<form class="google-search-form" @submit\.prevent="loadDriveFiles\(false\)">/);
  assert.match(drive,/type="search" maxlength="120"/);
  assert.match(css,/\.google-search-form\{[^}]*display:flex/);
  assert.match(css,/\.google-search-form input\[type="search"\]\{[^}]*flex:1 1 0;[^}]*min-width:0/);
  assert.match(gmail,/@submit\.prevent="loadGmailMessages\(false\)"/);
  assert.match(gmail,/gmailQuery\.trim\(\)===gmailLastQuery/);
  assert.match(gmail,/>加载更多（5 封）<\/button>/);
});

test('every native date and month control is responsive and independently clearable',()=>{
  assert.equal((app.match(/class="date-control"/g)||[]).length,4);
  for(const [field,aria] of [
    ['missingYearDateDraft','清空完整截止日期'],
    ['monthFilter','清空创建月份'],
    ['candidateDraft.date','清空交易日期'],
    ['candidateDraft.transfer_date','清空 SBI 资金生效日']
  ]){
    assert.ok(app.includes('v-model="'+field+'"'),'missing date model '+field);
    assert.ok(app.includes('aria-label="'+aria+'"'),'missing clear action '+field);
    assert.ok(app.includes('@click="'+field+'=\'\'"'),'clear action must reset model '+field);
  }
  assert.match(css,/input\[type="date"\],input\[type="month"\],input\[type="datetime-local"\]\{[^}]*min-width:0;max-width:100%/);
  assert.match(css,/\.date-control>input\[type="date"\]/);
  assert.match(css,/\.date-control \.date-clear\{[^}]*44px/);
  assert.match(css,/\.date-control\{[^}]*width:100%;min-width:0/);
});

test('date controls do not duplicate the Vue confirm-deadline conditional during rebases',()=>{
  assert.equal((app.match(/<template v-else-if="sheet==='confirmDeadline'">/g)||[]).length,1);
  assert.equal((app.match(/class="date-clear"/g)||[]).length,4);
});
