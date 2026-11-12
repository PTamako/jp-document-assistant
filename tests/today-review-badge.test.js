import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const s=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
test('Today badge displays verified state for upcoming document, preserving due alerts',()=>{
 assert.match(s,/function todayReviewBadge\(d\)/);
 assert.match(s,/if\(due==='已逾期'\|\|due==='今天到期'\)return due/);
 assert.match(s,/const reviewed=documentReviewLabel\(d\)/);
 assert.match(s,/return reviewed==='已核验'\|\|reviewed==='部分核验'\|\|reviewed==='待核验'\?reviewed:due/);
 assert.match(s,/\{\{todayReviewBadge\(d\)\}\}/);
});
