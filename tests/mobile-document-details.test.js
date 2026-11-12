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
 assert.match(app,/\{\{explanationText\|\|/);
 assert.match(app,/\{\{current\.extracted_text_ja\}\}/);
 assert.match(app,/explain-actions/);
 assert.match(app,/explain-provider/);
 assert.match(css,/\.explanation-text:not\(\.expanded\)/);
 assert.match(css,/\.ocr-text-preview:not\(\.expanded\)/);
 assert.match(css,/\.explanation-text\.expanded,\.ocr-text-preview\.expanded/);
});
