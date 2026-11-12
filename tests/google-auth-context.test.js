import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isIosStandalonePwa} from '../web/src/google-auth-context.js';
const app=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');

test('iOS standalone detection remains available without requiring Google iframe',()=>{
 const c=(userAgent,standalone)=>({navigator:{userAgent,standalone}});
 assert.equal(isIosStandalonePwa(c('iPhone OS 27 Safari',true)),true);
 assert.equal(isIosStandalonePwa(c('iPhone OS 27 Safari',false)),false);
});

test('Gmail and Drive use browser OAuth then refresh state on return to PWA',()=>{
 assert.match(app,/startGoogleAuthorization\(service\)/);
 assert.match(app,/window\.location\.assign\(result\.authorization_url\)/);
 assert.match(app,/api\/google\/oauth\/start/);
 assert.match(app,/api\/google\/oauth\/status/);
 assert.match(app,/visibilitychange/);
 assert.match(app,/pageshow/);
 assert.match(app,/async function openDriveSheet\(\)/);
 assert.match(app,/async function openGmailSheet\(\)/);
 assert.match(app,/async function chooseDriveFile\(item\)/);
 assert.doesNotMatch(app,/safariGoogleGuide|从 iPhone「文件」选择文书|Google Picker 会在嵌入式窗口/);
});
