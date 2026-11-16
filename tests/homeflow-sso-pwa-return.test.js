import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {handoffHomeflowBrowserAuthorization,validateHomeflowAuthorizationUrl} from '../web/src/homeflow-sso-pwa-return.js';

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


test('OAuth PWA validates PKCE, same-origin callback, state, client ID, nonce and rejects injected browser URL fields',()=>{
 const state='a'.repeat(64);
 const good=new URL('https://homeflow.example.test/authorize');
 const params={
  response_type:'code',
  client_id:'jp-document-assistant',
  redirect_uri:'https://app.example.test/api/homeflow-sso/callback',
  code_challenge:'A'.repeat(43),
  code_challenge_method:'S256',
  state,
  nonce:'b'.repeat(48)
 };
 for(const [k,v] of Object.entries(params))good.searchParams.set(k,v);
 assert.equal(validateHomeflowAuthorizationUrl(good.href,state,'https://app.example.test').href,good.href);
 for(const [field,wrong] of [
  ['client_id','attacker-client'],
  ['response_type','token'],
  ['redirect_uri','https://attacker.example/callback'],
  ['code_challenge_method','plain'],
  ['code_challenge','short'],
  ['state','c'.repeat(64)],
  ['nonce','invalid']]){
  const altered=new URL(good);
  altered.searchParams.set(field,wrong);
  assert.throws(()=>validateHomeflowAuthorizationUrl(altered.href,state,'https://app.example.test'),
   /授权地址校验失败/,field);
 }
 const extra=new URL(good);
 extra.searchParams.set('resume_secret','PWA-secret-cannot-ever-enter-external-url');
 assert.throws(()=>validateHomeflowAuthorizationUrl(extra.href,state,'https://app.example.test'),
  /授权地址校验失败/);
 const badHost=new URL(good);badHost.username='attacker';
 assert.throws(()=>validateHomeflowAuthorizationUrl(badHost.href,state,'https://app.example.test'),
  /授权地址校验失败/);
 const app=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
 assert.match(app,/validateHomeflowAuthorizationUrl\(data\.authorization_url,data\.state,/);
 assert.match(app,/window\.location\.origin\)/);
});
