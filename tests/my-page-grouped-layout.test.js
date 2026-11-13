import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const ui=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
const css=readFileSync(new URL('../web/src/style.css',import.meta.url),'utf8');
const start=ui.indexOf('<section v-else class="page-surface mine-page" key="mine">');
const end=ui.indexOf('</section>\n    </main>',start);
const mine=ui.slice(start,end);

test('My groups family, account and usage in that order with consistent grouped surfaces',()=>{
 assert.ok(start>=0&&end>start);
 const headings=['mine-family-heading','mine-account-heading','mine-usage-heading'];
 const positions=headings.map(s=>mine.indexOf('aria-labelledby="'+s+'"'));
 assert.ok(positions.every(i=>i>=0),JSON.stringify(positions));
 assert.ok(positions[0]<positions[1]&&positions[1]<positions[2]);
 assert.equal((mine.match(/class="mine-group-card"/g)||[]).length,2);
 assert.match(mine,/class="profile-card"/);
 assert.match(mine,/class="usage-dashboard"/);
 assert.match(css,/\.mine-group-card,\s*\.mine-page \.usage-dashboard\{/);
 assert.match(css,/\.mine-page \.usage-metric\{/);
});
test('redundant full-width refresh row is gone; one compact functional icon remains',()=>{
 assert.doesNotMatch(mine,/class="settings-line"[^>]*@click="loadUsage"/);
 assert.match(mine,/<button class="mine-usage-refresh" type="button" @click="loadUsage"/);
 assert.match(mine,/:disabled="usageRefreshing"/);
 assert.match(mine,/aria-label="刷新服务用量"/);
 assert.equal((mine.match(/@click="loadUsage"/g)||[]).length,1);
 assert.match(ui,/if\(tab==='mine'\)void loadUsage\(\)/);
});
test('all My features remain accessible in native grouped rows',()=>{
 for(const action of ["sheet='invite'","showRecycle","sheet='backup'","openCalendar",
                      "cleanupStorage","openSessions","sheet='changePassword'","logout"]){
  assert.ok(mine.includes('@click="'+action+'"'),action);
 }
 assert.match(mine,/v-if="user\.role==='owner'"/);
 assert.match(mine,/Google 全文翻译/);
 assert.match(mine,/Gemini 3\.6/);
 assert.match(mine,/Workers AI 解读/);
 assert.match(mine,/Workers AI OCR/);
 assert.match(mine,/OCR\.space/);
});
test('grouped settings remain mobile, dark-mode and transparency accessible',()=>{
 assert.match(css,/\.mine-section\{/);
 assert.match(css,/\.mine-group-card>\.settings-line\{/);
 assert.match(css,/\.mine-usage-refresh\{/);
 assert.match(css,/@media\(max-width:360px\)/);
 assert.match(css,/\.mine-group-card,\.mine-page \.usage-dashboard,\.mine-page \.profile-card/);
 assert.match(mine,/aria-labelledby="mine-usage-heading"/);
});
test('stale usage refreshes cannot overwrite more recent results or leak into next account',()=>{
 assert.match(ui,/let usageLoadSerial=0;/);
 assert.match(ui,/const serial=\+\+usageLoadSerial;/);
 assert.match(ui,/if\(serial===usageLoadSerial\)usage\.value=data/);
 assert.match(ui,/usageLoadSerial\+\+;usageRefreshing\.value=false/);
});
