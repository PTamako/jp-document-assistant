import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseDocument} from 'yaml';
test('complete OpenAPI YAML parses strictly and defines no duplicated routes or keys',()=>{
 const content=fs.readFileSync(new URL('../openapi.yaml',import.meta.url),'utf8');
 const doc=parseDocument(content,{uniqueKeys:true,strict:true,prettyErrors:true});
 assert.deepEqual(doc.errors.map(e=>e.message),[],doc.errors.map(e=>e.message).join('\n'));
 const spec=doc.toJS();
 assert.equal(spec.openapi,'3.1.0');
 assert.equal(Object.keys(spec.paths).length,55);
 assert.ok(spec.paths['/api/calendar/{token}.ics'].get);
 assert.equal(spec.paths['/api/calendar/{token}.ics'].post,undefined);
 assert.ok(spec.paths['/api/auth/change-password'].post);
 const file=spec.paths['/api/documents/import/file'].post.requestBody.content['multipart/form-data'].schema.properties;
 assert.ok(file.source_type.enum.includes('google_drive'));
 const ocr=spec.paths['/api/documents/{documentId}/ocr'].post.requestBody.content['application/json'].schema.properties;
 assert.equal(ocr.retry_stale.type,'boolean');
 assert.equal(ocr.retry_empty.type,'boolean');
 const usage=spec.paths['/api/usage'].get.responses['200'].content['application/json'].schema.properties;
 assert.equal(usage.cloudflare_account_remaining.type,'null');
 const ids=Object.values(spec.paths).flatMap(route=>Object.entries(route)
  .filter(([method])=>['get','post','patch','put','delete'].includes(method)).map(([,op])=>op.operationId));
 assert.equal(ids.length,56);assert.equal(new Set(ids).size,56);
 for(const [path,method,operation] of [
  ['/api/auth/sessions','get','listOwnSessions'],
  ['/api/auth/sessions/revoke','post','revokeOwnSession'],
  ['/api/auth/sessions/revoke-others','post','revokeOtherOwnSessions'],
  ['/api/documents/{documentId}/reinterpret','post','reinterpretDocumentPreservingReview'],
  ['/api/documents/{documentId}/manual-income','post','createConfirmedManualSalaryIncome']
 ]){
  assert.equal(spec.paths[path]?.[method]?.operationId,operation);
 }
 const revoke=spec.paths['/api/auth/sessions/revoke'].post;
 assert.equal(revoke.parameters.find(p=>p.name==='X-CSRF-Token')?.required,true);
 assert.equal(revoke.requestBody.content['application/json'].schema.properties.session_id.pattern,'^[a-fA-F0-9]{32}$');
});
