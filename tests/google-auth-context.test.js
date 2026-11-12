import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isIosStandalonePwa} from '../web/src/google-auth-context.js';

test('iPhone home-screen PWA is detected, Safari tab and Android are not',()=>{
 const context=(userAgent,standalone=false,displayStandalone=false)=>({
  navigator:{userAgent,standalone},
  matchMedia:()=>({matches:displayStandalone})
 });
 assert.equal(isIosStandalonePwa(context('iPhone OS 27 Safari',true)),true);
 assert.equal(isIosStandalonePwa(context('iPhone OS 27 Safari',false,true)),true);
 assert.equal(isIosStandalonePwa(context('iPhone OS 27 Safari',false,false)),false);
 assert.equal(isIosStandalonePwa(context('Android Chrome',true,true)),false);
 assert.equal(isIosStandalonePwa(null),false);
});
test('iOS installed PWA offers Google import guidance while retaining explicit online retry',()=>{
 const app=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
 const picker=readFileSync(new URL('../web/src/google-drive-picker.js',import.meta.url),'utf8');
 assert.match(app,/<label v-if="iosStandalonePwa" class="choice-picker-file">/);
 assert.match(app,/从 Google Drive 选文件（使用 iPhone「文件」）/);
 assert.match(app,/<button v-if="drivePickerAvailable&&!iosStandalonePwa"/);
 assert.match(app,/@click="importFromGoogleDrive"/);
 assert.match(app,/Google 原生格式或在线选择遇到问题？/);
 assert.match(app,/仍尝试在 PWA 在线选择（可能失败）/);
 assert.match(app,/跨网站 Cookie/);
 assert.match(app,/不必关闭系统的跨网站追踪保护/);
 assert.doesNotMatch(app,/drivePickerAvailable\|\|iosStandalonePwa/);
 assert.match(app,/复制文书助手网址/);
 assert.match(app,/在 Safari 地址栏/);
 assert.match(app,/drivePickerReadyUi/);
 assert.match(app,/primeGooglePicker\(\)/);
 assert.match(picker,/error_callback\(error\)/);
 assert.match(picker,/client\.requestAccessToken\(\{prompt:''\}\)/);
 assert.doesNotMatch(picker,/requestAccessToken\(\{prompt:'consent'/);
 assert.match(picker,/deadline\(60000/);
 assert.match(picker,/deadline\(180000/);
});

test('installed iOS PWA can use the native Files provider, with Safari as fallback for Google OAuth',()=>{
 const app=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
 const css=readFileSync(new URL('../web/src/style.css',import.meta.url),'utf8');
 assert.match(app,/iPhone「文件」（含已启用的 Google Drive）/);
 assert.match(app,/Google Docs 等原生格式可先在 Google Drive App 中导出 PDF 或 Office 格式/);
 assert.match(app,/class="choice-picker-file"/);
 assert.match(app,/从 iPhone「文件」选择文书/);
 assert.match(app,/Google Docs／表格／幻灯片等原生格式/);
 assert.match(app,/sheet==='importSources'/);
 assert.match(app,/@change="selectFile"/);
 assert.match(app,/async function refreshDocumentsAfterSafari\(\)/);
 assert.match(app,/pages\.docs\.loaded=false;\s*await loadTab\('docs'\)/);
 assert.match(app,/刷新文书库/);
 assert.match(css,/\.choice-picker-file/);
 // OAuth tokens are never persisted to native file providers or local storage.
 assert.doesNotMatch(app,/localStorage\.setItem\(['"]google/i);
});
