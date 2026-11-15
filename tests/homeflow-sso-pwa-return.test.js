import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {handoffHomeflowBrowserAuthorization} from '../web/src/homeflow-sso-pwa-return.js';

test('installed iPhone standalone PWA stays alive after Safari opens; original SSO pending completes without spinner lock',()=>{
 const busy={value:true},calls=[];
 const location={assign(url){calls.push(url);/* external Safari opens, original WebView does not unload */}};
 const dest='https://homeflow.example.test/authorize?client_id=jp-document-assistant&state=opaque-only';
 assert.equal(handoffHomeflowBrowserAuthorization(location,dest,busy),true);
 assert.deepEqual(calls,[dest]);
 assert.equal(busy.value,false,'original iOS PWA must allow same-session complete button');
 const app=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
 assert.match(app,/homeflowSsoPending\.value=true/);
 assert.match(app,/handoffHomeflowBrowserAuthorization\(window\.location,url\.href,homeflowSsoBusy\)/);
 assert.match(app,/if\(!p\)\{clearHomeflowSsoPending\(\)/);
 assert.match(app,/resume_secret:p\.resume_secret/);
 assert.match(app,/clearPrivateWorkspace\(\);\s*await boot\(\)/);
 assert.match(app,/onMounted\(async\(\)=>\{[\s\S]*?refreshHomeflowSsoAvailability\(\)/);
});
test('OAuth external navigation never accepts non-HTTPS or credentialed URLs and does not unlock on blocked navigation',()=>{
 const cases=['javascript:alert(1)','http://homeflow.example.test/authorize',
  'https://user:pw@homeflow.example.test/authorize'];
 for(const dest of cases){
  const busy={value:true},location={assign(){throw Error('must not be called')}};
  assert.throws(()=>handoffHomeflowBrowserAuthorization(location,dest,busy),/HTTPS/);
  assert.equal(busy.value,true);
 }
 const busy={value:true};
 assert.throws(()=>handoffHomeflowBrowserAuthorization({
  assign(){throw new Error('navigation forbidden')}
 },'https://homeflow.example.test/authorize',busy),/navigation forbidden/);
 assert.equal(busy.value,true,'error remains owned by caller catch');
});
test('SSO resume is private in original PWA sessionStorage and is cleared on logout; no OAuth secrets added to navigation URL',()=>{
 const app=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
 const nav=readFileSync(new URL('../web/src/homeflow-sso-pwa-return.js',import.meta.url),'utf8');
 assert.match(app,/sessionStorage\.setItem\(SSO_PENDING_KEY,JSON\.stringify\(/);
 assert.match(app,/sessionStorage\.removeItem\(SSO_PENDING_KEY\)/);
 assert.match(app,/async function logout\(\)\{[\s\S]*?clearHomeflowSsoPending\(\);clearPrivateWorkspace\(\)/);
 assert.doesNotMatch(nav,/localStorage|sessionStorage|document\.cookie|resume_secret|code_verifier|fetch\(/);
});
