import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const app=read('web/src/App.vue');
const icon=read('web/src/UiIcon.vue');
const nav=read('web/src/TabIcon.vue');
const swipe=read('web/src/DocumentSwipeRow.vue');
const css=read('web/src/style.css');
test('one outlined icon family is used in bottom nav, top bar, details, lists, settings and swipe action',()=>{
 assert.match(app,/import UiIcon from '\.\/UiIcon\.vue'/);
 assert.match(nav,/import UiIcon from '\.\/UiIcon\.vue'/);
 assert.match(swipe,/import UiIcon from '\.\/UiIcon\.vue'/);
 assert.match(nav,/<UiIcon :name="name" :size="24" class="nav-icon"\/>/);
 for(const name of ['today','docs','links','mine','plus','filter','search','chevron-right','ellipsis','trash','arrow-left','x','wallet','book'])
  assert.ok(icon.includes("name==='"+name+"'"),'missing '+name);
 for(const pattern of [/name="plus" :size="23"/,/:name="categoryIcon\(d\.category\)"/,/:name="candidateIcon\(item\.candidate_kind\)"/,/name="chevron-right" :size="18"/,/name="arrow-left" :size="21"/])
  assert.match(app,pattern);
 assert.match(swipe,/<UiIcon name="trash"/);
 assert.match(swipe,/<UiIcon name="ellipsis"/);
 assert.match(icon,/stroke-width="1\.8"/);
});
test('main app avoids decorative glyphs that differ from the shared icon style',()=>{
 assert.doesNotMatch(app,/<div class="item-icon">[▤◇]/);
 assert.doesNotMatch(app,/<div class="welcome-mark">日<\/div>/);
 assert.doesNotMatch(app,/<span>›<\/span>/);
 assert.doesNotMatch(app,/PRIVATE FAMILY SPACE/);
 assert.doesNotMatch(app,/三个 App 的安全服务桥尚未建立/);
 assert.match(app,/核对提取结果后，再选择同步到目标 App/);
});
test('mobile styles keep good touch target sizes, dark mode and reduced motion',()=>{
 assert.match(css,/\.settings-line\{[^}]*min-height:55px/);
 assert.match(css,/\.bottom-nav\{[^}]*height:var\(--nav-h\)/);
 assert.match(css,/\.ui-icon\{display:block/);
 assert.match(css,/@media\(prefers-color-scheme:dark\)/);
 assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
 assert.match(css,/\.bottom-sheet\{background:var\(--panel\)/);
});
test('critical privacy and deletion guarantees remain visible in simplified copy',()=>{
 assert.match(app,/删除文书不会删除其他 App 已同步的记录/);
 assert.match(app,/删除可恢复，永久删除不可撤销/);
 assert.match(app,/保存前需确认/);
 assert.match(app,/原件仍保留在私有 R2/);
 assert.match(app,/Gmail 只读授权受 Google 限制/);
});
