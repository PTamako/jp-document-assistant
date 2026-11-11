import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const root=new URL('../',import.meta.url);
const read=p=>readFileSync(new URL(p,root),'utf8');
const wrangler=JSON.parse(read('wrangler.jsonc').replace(/^\s*\/\/.*$/gm,''));
const ci=read('.github/workflows/ci.yml');
const worker=read('worker/index.js');
const security=read('worker/security.js');

test('approved production Wrangler only targets dedicated D1/R2 and excludes all previews, cron and new billable resources',()=>{
 assert.equal(wrangler.name,'jp-document-assistant');
 assert.equal(wrangler.main,'worker/index.js');
 assert.equal(wrangler.assets?.directory,'./dist');
 assert.equal(wrangler.assets?.binding,'ASSETS');
 assert.equal(wrangler.d1_databases?.length,1);
 assert.equal(wrangler.d1_databases[0].binding,'DB');
 assert.equal(wrangler.d1_databases[0].database_name,'jp-document-assistant');
 assert.equal(wrangler.d1_databases[0].database_id,'22a671c0-3f6c-4707-adf1-b24ac95330c6');
 assert.equal(wrangler.r2_buckets?.length,1);
 assert.equal(wrangler.r2_buckets[0].binding,'DOCUMENTS');
 assert.equal(wrangler.r2_buckets[0].bucket_name,'jp-document-assistant-private');
 assert.deepEqual(wrangler.services,[
  {binding:'HOMEFLOW_BRIDGE_SERVICE',service:'homeflow'},
  {binding:'ZHIXUE_BRIDGE_SERVICE',service:'it-study-platform'}
 ]);
 assert.doesNotMatch(JSON.stringify(wrangler),/JPDA_BRIDGE_ALLOWED_USER|JPDA_BRIDGE_STUDY_ACTOR_ID|BRIDGE_USER_MAP/);
 assert.equal(wrangler.vars?.R2_BUCKET_NAME,'jp-document-assistant-private');
 assert.equal(wrangler.ai?.binding,'AI');
 assert.equal(wrangler.vars?.ENABLE_EXPERIMENTAL_OCR,'true');
 assert.equal(wrangler.vars?.OCR_CALLS_PER_USER_DAY,'1');
 assert.equal(wrangler.vars?.OCR_APP_UTC_DAILY_LIMIT,'1');
 assert.equal(wrangler.workers_dev,true); // Approved ONLY for the one live Worker. No preview.
 assert.equal(wrangler.preview_urls,false);
 assert.equal(wrangler.observability?.enabled,false);
 for(const unwanted of ['kv_namespaces','queues','durable_objects','triggers','dispatch_namespaces','unsafe','containers','workflows','routes','route'])
   assert.equal(wrangler[unwanted],undefined,'unexpected billable/preview/routing setting '+unwanted);
});

test('CI cannot deploy, read production secrets, run remote database migration or create preview resources',()=>{
 assert.match(ci,/permissions:\s*\n\s+contents: read/);
 assert.doesNotMatch(ci,/^\s*(?:-\s*)?(?:uses:|run:).*wrangler\s+(?:deploy|publish|d1\s+migrations\s+apply)/mi);
 assert.doesNotMatch(ci,/CLOUDFLARE_API_TOKEN|CF_API_TOKEN|WRANGLER_SEND_METRICS|--remote|workflow_dispatch|preview_urls:\s*true/);
 assert.match(ci,/npm test/);
 assert.match(ci,/npm run build/);
});

test('private auth/API responses have strict session cookies, CSRF, no-store, and no external R2 URL',()=>{
 assert.match(security,/__Host-da_session/);
 assert.match(security,/Secure; HttpOnly; SameSite=Strict/);
 assert.match(worker,/if\(!\['GET','HEAD'\]\.includes\(method\)\)requireMutation\(request,p\)/);
 assert.match(worker,/function requireSession\(/);
 assert.match(worker,/function visibleDocument\(/);
 assert.match(read('worker/http.js'),/Cache-Control':'no-store'/);
 assert.doesNotMatch(worker,/\\.list\(/);
 assert.doesNotMatch(worker,/env\.DOCUMENTS\.createSignedUrl/);
});

test('Cloudflare PBKDF2 is within supported 100k iteration bound and frontend guides initialization',()=>{
 const security=read('worker/security.js');
 assert.match(security,/const ITERATIONS = 100000;/);
 assert.doesNotMatch(security,/const ITERATIONS = 150000;/);
 const ui=read('web/src/App.vue');
 assert.match(ui,/refreshInitStatus/);
 assert.match(ui,/\/api\/auth\/status/);
 assert.match(ui,/if\(!initialized\.value\)authMode\.value='bootstrap'/);
 const backend=read('worker/index.js');
 assert.match(backend,/path==='\/api\/auth\/status'/);
});
