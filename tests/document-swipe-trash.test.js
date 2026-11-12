import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const root=new URL('../',import.meta.url);
const read=path=>readFileSync(new URL(path,root),'utf8');
const app=read('web/src/App.vue');
const swipe=read('web/src/DocumentSwipeRow.vue');

test('document library has real left swipe gesture, not an invisible action',()=>{
  assert.match(swipe,/@touchstart\.passive="onTouchStart"/);
  assert.match(swipe,/@touchmove\.passive="onTouchMove"/);
  assert.match(swipe,/@touchend="onTouchEnd"/);
  assert.match(swipe,/if\(dx<0\)emit\('reveal',props\.id\)/);
  assert.match(swipe,/touch-action:pan-y/);
  assert.match(swipe,/aria-label="删除文书，移入回收站"/);
  assert.match(swipe,/@click\.stop="emit\('delete',id\)"/);
  assert.match(swipe,/class="document-swipe-trigger"/);
  assert.match(swipe,/@click\.capture="onContentClick"/);
  assert.match(swipe,/lastSwipeAt<500/);
  assert.match(app,/<DocumentSwipeRow v-for="d in pageData\.items"/);
  assert.match(app,/@delete="askTrashFromList\(d\)"/);
});
test('swiping only reveals the button; user must confirm before trash API is called',()=>{
  assert.match(app,/function askTrashFromList\(document\)\{/);
  assert.match(app,/sheet\.value='trashListConfirm'/);
  assert.match(app,/<template v-else-if="sheet==='trashListConfirm'">/);
  assert.match(app,/@click="trashFromList"/);
  assert.match(app,/async function trashFromList\(\)\{/);
  const ask=app.slice(app.indexOf('function askTrashFromList'),app.indexOf('async function trashFromList'));
  assert.doesNotMatch(ask,/api\(/);
  assert.match(app,/await api\(`\/api\/documents\/\$\{target\.id\}\/trash`,\{method:'POST',body:\{\}\}\)/);
  assert.match(app,/pages\.docs\.loaded=false;\s*await loadTab\('docs'\)/);
  assert.match(app,/原件仍保留在私有 R2/);
  assert.doesNotMatch(swipe,/permanent-delete|DELETE_FOREVER/);
});
