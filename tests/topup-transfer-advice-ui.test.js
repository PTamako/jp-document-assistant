import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const app=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');

test('Suica top-up appears as a transfer recommendation without a finance write candidate',()=>{
 assert.match(app,/current\.value\?\.category!=='topup'/);
 assert.match(app,/v-if="topupAdvice"/);
 assert.match(app,/家計簿 · 资金转移建议/);
 assert.match(app,/扣款来源：[\s\S]*?待本人选择/);
 assert.match(app,/当前家計簿安全接口只支持收入／支出/);
 assert.match(app,/不会自动写入、不会重复记账/);
});
test('sensitive top-up amount stays hidden until explicit reveal',()=>{
 assert.match(app,/amountVisible\?topupAdvice\.amount:'••••••'/);
 assert.match(app,/amountVisible=!amountVisible/);
});
test('empty non-top-up detail shows meaningful fallback',()=>{
 assert.match(app,/暂无待办或财务建议/);
});
