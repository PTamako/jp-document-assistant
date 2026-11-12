import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=new URL('../web/index.html',import.meta.url);
const html=readFileSync(source,'utf8');
const attr=/Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
const directives=Object.fromEntries(String(attr||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>[x.split(' ')[0],x.split(' ').slice(1)]));
test('Google OAuth/Picker/Gmail CSP allows required providers but keeps a strict default',()=>{
 assert.ok(attr,'CSP must be set');
 assert.deepEqual(directives['default-src'],["'self'"]);
 assert.deepEqual(directives['object-src'],["'none'"]);
 assert.deepEqual(directives['base-uri'],["'none'"]);
 assert.deepEqual(directives['form-action'],["'self'"]);
 assert.ok(directives['script-src'].includes('https://accounts.google.com'));
 assert.ok(directives['script-src'].includes('https://apis.google.com'));
 assert.ok(directives['connect-src'].includes('https://gmail.googleapis.com'));
 assert.ok(directives['connect-src'].includes('https://www.googleapis.com'));
 assert.ok(directives['frame-src'].includes('https://docs.google.com'));
 assert.ok(directives['frame-src'].includes('https://accounts.google.com'));
 assert.ok(!directives['script-src'].includes("'unsafe-inline'"));
 assert.ok(!directives['script-src'].includes("'unsafe-eval'"));
 assert.ok(!directives['script-src'].includes('*'));
 assert.ok(!directives['connect-src'].includes('*'));
});

test('Google Picker website-limited API keys receive only the website origin, while private APIs remain no-referrer',async()=>{
 const meta=/name="referrer" content="([^"]+)"/.exec(html)?.[1];
 assert.equal(meta,'strict-origin-when-cross-origin');
 const {default:worker}=await import('../worker/index.js');
 const assetResponse=await worker.fetch(new Request('https://example.com/'),{
  ASSETS:{fetch:async()=>new Response('<html>ready</html>',{headers:{'Content-Type':'text/html'}})}
 });
 assert.equal(assetResponse.status,200);
 assert.equal(assetResponse.headers.get('Referrer-Policy'),'strict-origin-when-cross-origin');
 const privateResponse=await worker.fetch(new Request('https://example.com/api/health'),{});
 assert.equal(privateResponse.status,200);
 assert.equal(privateResponse.headers.get('Referrer-Policy'),'no-referrer');
});
