import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const app=read('../web/src/App.vue');
const preview=read('../worker/bridge.js');
const route=read('../worker/index.js');
const intent=read('../worker/document-member-approval.js');

test('document collaborator can request review only as the verified SSO member, never directly commit',()=>{
 assert.match(preview,/approvalActionEnabled=approvalRequired&&p.auth_source==='homeflow'/);
 assert.match(preview,/approval_submitted:preparedApproval\?\.status==='submitted'/);
 assert.match(preview,/approval_prepared:preparedApproval\?\.status==='prepared'/);
 assert.match(preview,/if\(p.role!=='owner'\)[\s\S]*?APPROVAL_REQUIRED/);
 assert.match(route,/if\(method==='POST'&&candidate\[2\]==='request-approval'\)return requestDocumentMemberApproval/);
 assert.match(route,/if\(method==='GET'&&candidate\[2\]==='approval'\)return documentMemberApprovalStatus/);
 assert.match(intent,/checkedMember\(p\)/);
 assert.match(intent,/p.auth_source!=='homeflow'/);
 assert.match(intent,/documentMemberApprovalReady\(env\)/);
 assert.match(intent,/typeof env.HOMEFLOW_BRIDGE_SERVICE\?\.fetch==='function'/);
 assert.doesNotMatch(intent,/KAKEBO_BRIDGE_SERVICE|ZHIXUE_BRIDGE_SERVICE|\/api\/bridge\/document-assistant/);
});

test('member PWA differentiates submitting a review from owner direct target sync',()=>{
 assert.match(app,/candidateApprovalReady\.value=d.approval_action_enabled===true/);
 assert.match(app,/candidateApprovalSubmitted\.value=d.approval_submitted===true/);
 assert.match(app,/candidateApprovalPrepared\.value=d.approval_prepared===true/);
 assert.match(app,/const path=memberApproval\?'request-approval':'commit'/);
 assert.match(app,/if\(d.approval_submitted!==true\|\|d.applied!==false\|\|d.target_changed!==false\)/);
 assert.match(app,/已提交 HomeFlow 待审批，尚未同步到目标应用/);
 assert.match(app,/candidateApprovalRequired\?\(candidateApprovalSubmitted\?'已提交待审批'/);
 assert.match(app,/:disabled="candidateActionDisabled\|\|candidateApprovalSubmitted"/);
 assert.match(app,/已提交 HomeFlow 审批，尚未同步目标应用/);
 assert.match(app,/candidateApprovalReady\.value=false;candidateApprovalSubmitted\.value=false;candidateApprovalPrepared\.value=false/);
});

test('network uncertainty retries original private snapshot without quietly changing fields or target',()=>{
 assert.match(intent,/resume_existing===true/);
 assert.match(intent,/original\.document_version!==item\.document_version/);
 assert.match(intent,/original\.candidate_updated_at!==item\.updated_at/);
 assert.match(intent,/await hashString\(snapshot\)!==digest/);
 assert.match(intent,/INSERT INTO document_member_sync_intents/);
 assert.match(intent,/ON CONFLICT\(candidate_id\) DO NOTHING/);
 assert.match(intent,/APPROVAL_INTENT_CONFLICT/);
 assert.match(intent,/data.applied!==false\|\|data.target_changed!==false/);
 assert.match(app,/resume_existing:true/);
 assert.match(app,/candidateApprovalRequired&&candidateApprovalPrepared/);
 assert.match(app,/重试原申请/);
 assert.match(app,/if\(!stillCurrent\(\)\)return/);
});
