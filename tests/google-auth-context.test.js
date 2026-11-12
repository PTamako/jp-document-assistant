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
test('PWA shows Safari fallback instead of making a stuck Google popup request',()=>{
 const app=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
 const picker=readFileSync(new URL('../web/src/google-drive-picker.js',import.meta.url),'utf8');
 assert.match(app,/if\(iosStandalonePwa\)\{sheet\.value='safariGoogleGuide';return;\}/);
 assert.match(app,/复制文书助手网址/);
 assert.match(app,/在 Safari 地址栏/);
 assert.match(app,/drivePickerReadyUi/);
 assert.match(app,/primeGooglePicker\(\)/);
 assert.match(picker,/error_callback\(error\)/);
 assert.match(picker,/requestAccessToken\(\{prompt:'consent'\}\)/);
 assert.match(picker,/deadline\(60000/);
 assert.match(picker,/deadline\(180000/);
});
