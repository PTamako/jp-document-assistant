import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const app=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
const css=readFileSync(new URL('../web/src/style.css',import.meta.url),'utf8');

test('OCR-derived titles are bounded in library cards and detail view',()=>{
 assert.match(app,/class="item-card document-list-card"/);
 assert.match(app,/class="document-detail-title" :title="current.title"/);
 assert.match(css,/\.item-card \.item-title\{[^}]*-webkit-line-clamp:2/);
 assert.match(css,/\.detail-body \.document-detail-title\{[^}]*-webkit-line-clamp:2/);
 assert.match(css,/\.item-card \.item-info p\{[^}]*text-overflow:ellipsis/);
});

test('attachment list shows only view and the menu while keeping all existing operations',()=>{
 const original=app.slice(app.indexOf('<section v-if="detailTab===\'original\'">'),app.indexOf('\n    </div>\n  </div>\n\n  <div v-if="sheet"',app.indexOf('<section v-if="detailTab===\'original\'">')));
 assert.match(original,/attachment-file-row/);
 assert.match(original,/@click="showOriginal\(a\)"/);
 assert.match(original,/@click="openAttachmentActions\(a\)"/);
 assert.doesNotMatch(original,/class="attachment-row"/);
 assert.doesNotMatch(original,/@click="runOcr\(a\)"/);
 const menu=app.slice(app.indexOf('<template v-else-if="sheet===\'attachmentActions\'">'),app.indexOf('<template v-else-if="sheet===\'attachmentTrashConfirm\'">'));
 for(const action of ['moveAttachmentFromMenu(-1)','moveAttachmentFromMenu(1)','runOcr(selectedAttachment)','openOcrSpace(selectedAttachment)'])
  assert.ok(menu.includes(action),action);
 assert.match(app,/sheet==='attachmentTrashConfirm'/);
 assert.match(app,/confirmAttachmentTrash/);
 assert.match(css,/\.attachment-file-name\{[^}]*text-overflow:ellipsis/);
});

test('recycle confirmations are brief and action buttons never split into two lines',()=>{
 assert.doesNotMatch(app,/原件仍保留在私有 R2，随时可从「我的 → 回收站」恢复/);
 assert.match(app,/可恢复，已同步到其他 App 的内容不受影响/);
 assert.match(css,/\.sheet-actions>button\{[^}]*white-space:nowrap/);
 assert.match(css,/\.trash-confirm-title\{[^}]*-webkit-line-clamp:2/);
});

test('Chinese explanation and OCR originals stay available through explicit expand controls',()=>{
 assert.match(app,/explanationExpanded=!explanationExpanded/);
 assert.match(app,/ocrTextExpanded=!ocrTextExpanded/);
 assert.match(app,/explanationExpanded\?explanationText:explanationPreview/);
 assert.match(app,/\{\{current\.extracted_text_ja\}\}/);
 assert.match(app,/explain-actions/);
 assert.match(app,/explain-provider/);
 assert.match(css,/\.explanation-text:not\(\.expanded\)/);
 assert.match(css,/\.ocr-text-preview:not\(\.expanded\)/);
 assert.match(css,/\.explanation-text\.expanded,\.ocr-text-preview\.expanded/);
});

test('document tabs remain sticky below the in-sheet header and AI uses an actual sparkle SVG',()=>{
 assert.match(app,/class="detail-tabs-sticky"/);
 assert.match(css,/\.detail-tabs-sticky\{[^}]*position:sticky;top:0/);
 const icons=readFileSync(new URL('../web/src/UiIcon.vue',import.meta.url),'utf8');
 assert.match(icons,/name==='sparkles'/);
 assert.match(app,/<UiIcon name="sparkles"/);
 assert.match(app,/explanationExpanded\?explanationText:explanationPreview/);
});
test('campaign offer and date are shown as review-only suggestions without a contradictory empty message',()=>{
 assert.match(app,/campaignPendingDate/);
 assert.match(app,/current\.campaign_hints/);
 assert.match(app,/确认活动年份/);
 assert.match(app,/只是邮件中的优惠说明，不会自动领取或创建正式待办/);
 assert.match(app,/!aiAnalysis\?\.homeflow_suggestions\?\.length/);
});

test('recycle sheet keeps titles full width and buttons in a compact second row',()=>{
 const recycle=app.slice(app.indexOf('<template v-else-if="sheet===\x27recycle\x27">'),app.indexOf('<template v-else-if="sheet===\x27emptyRecycleConfirm\x27">'));
 assert.match(recycle,/class="recycle-header"/);
 assert.match(recycle,/class="recycle-clear-button"/);
 assert.match(recycle,/class="recycle-title"/);
 assert.match(recycle,/class="recycle-row-bottom"/);
 assert.match(recycle,/class="recycle-row-actions"/);
 assert.match(recycle,/class="recycle-action restore"/);
 assert.match(recycle,/class="recycle-action permanent"/);
 assert.match(recycle,/v-if="attachmentTrashItems.length" class="recycle-subheading"/);
 assert.match(recycle,/!trashItems.length&&!attachmentTrashItems.length/);
 assert.match(css,/\.recycle-row\{[^}]*flex-direction:column/);
 assert.match(css,/\.recycle-title\{[^}]*-webkit-line-clamp:2/);
 assert.match(css,/\.recycle-row-actions\{[^}]*flex:0 0 auto/);
 assert.match(css,/\.recycle-footer\{margin:10px 0 0/);
});
