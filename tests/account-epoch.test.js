import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createAccountEpoch} from '../web/src/account-epoch.js';

test('account epoch rejects old owner data even if it arrives after new user login',async()=>{
  const gate=createAccountEpoch();
  const a=gate.snapshot();
  assert.equal(gate.isCurrent(a),true);
  gate.invalidate();
  assert.equal(gate.isCurrent(a),false);
  assert.throws(()=>gate.assertCurrent(a),/会话已改变/);
  const b=gate.snapshot();
  gate.assertCurrent(b);
  gate.invalidate();
  assert.throws(()=>gate.assertCurrent(b),/会话已改变/);
});
test('private user logout/identity switch invalidates requests and purges memory-only data',()=>{
  const source=fs.readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
  assert.match(source,/accountEpoch\.assertCurrent\(epoch\)/);
  assert.match(source,/function clearPrivateWorkspace\(\)/);
  assert.match(source,/loadSerial\+\+/);
  assert.match(source,/usage\.value=null/);
  assert.match(source,/restoreArchive\.value=null/);
  assert.match(source,/restorePreview\.value=\[\]/);
  assert.match(source,/trashItems\.value=\[\]/);
  assert.match(source,/sessions\.value=\[\]/);
  assert.match(source,/detailCandidates\.value=\[\]/);
  assert.match(source,/clearGmailSession\(\)/);
  assert.match(source,/onBeforeUnmount\(\(\)=>\{clearPrivateWorkspace\(\)/);
});
