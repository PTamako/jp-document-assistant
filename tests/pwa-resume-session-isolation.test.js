import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {verifyDocumentPwaSessionOnResume} from '../web/src/pwa-session-resume.js'
const ok=id=>({ok:true,async json(){return {user:{id}}}})
test('iPhone PWA foreground revalidates HttpOnly current account with uncached same-origin GET',async()=>{
 let options
 const valid=await verifyDocumentPwaSessionOnResume('owner-id',async(url,o)=>{
  assert.equal(url,'/api/me');options=o;return ok('owner-id')
 })
 assert.equal(valid,true)
 assert.deepEqual(options,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error'})
})
test('switched, revoked, offline and invalid PWA identity always hide previous private document workspace',async()=>{
 assert.equal(await verifyDocumentPwaSessionOnResume('owner-id',async()=>ok('member-id')),false)
 assert.equal(await verifyDocumentPwaSessionOnResume('owner-id',async()=>({ok:false})),false)
 assert.equal(await verifyDocumentPwaSessionOnResume('owner-id',async()=>{throw Error('offline')}),false)
 assert.equal(await verifyDocumentPwaSessionOnResume('',async()=>ok('owner-id')),false)
})
test('PWA foreground privacy veil precedes OAuth, docs, Gmail, Drive and R2 memory display',()=>{
 const app=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8')
 const sso=readFileSync(new URL('../web/src/homeflow-sso-pwa-return.js',import.meta.url),'utf8')
 const config=readFileSync(new URL('../vite.config.js',import.meta.url),'utf8')
 assert.match(app,/resumeChecking\.value=true;[\s\S]*?verifyDocumentPwaSessionOnResume\(userId\)/)
 assert.match(app,/if\(!stillSame\)\{[\s\S]*?clearPrivateWorkspace\(\)/)
 assert.match(app,/<template v-if="resumeChecking">/)
 assert.match(app,/accountEpoch\.invalidate\(\)/)
 assert.match(app,/accountController\.abort\(\)/)
 assert.match(app,/clearGmailSession\(\)/)
 assert.match(app,/cache:'no-store'/)
 assert.match(app,/validateHomeflowAuthorizationUrl\(data\.authorization_url,data\.state,/)
 assert.doesNotMatch(config,/VitePWA|workbox|runtimeCaching/)
 assert.match(sso,/target\.searchParams\.get\('code_challenge_method'\)!=='S256'/)
})
