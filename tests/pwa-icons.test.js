import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const root=new URL('../',import.meta.url);
const source=path=>readFileSync(new URL(path,root));
const text=path=>source(path).toString('utf8');

test('PWA icons are true PNG files with correct dimensions and safe-mask variant',()=>{
  const files=[
    ['web/public/icons/app-icon-192.png',192],
    ['web/public/icons/app-icon-512.png',512],
    ['web/public/icons/app-icon-maskable-512.png',512],
    ['web/public/icons/apple-touch-icon-180.png',180],
    ['web/public/icons/favicon-32.png',32]
  ];
  for(const [path,dim] of files){
    const png=source(path);
    assert.ok(png.length>100, path+' is empty');
    assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a',path+' is not PNG');
    assert.equal(png.readUInt32BE(16),dim,path+' width');
    assert.equal(png.readUInt32BE(20),dim,path+' height');
  }
  assert.match(text('web/public/icons/app-icon.svg'),/<svg /);
  assert.match(text('web/public/icons/app-icon-maskable.svg'),/scale\(\.8\)/);
});
test('all PWA manifest icon files resolve and iOS home-screen icon is linked',()=>{
  const manifest=JSON.parse(text('web/public/manifest.webmanifest'));
  assert.equal(manifest.display,'standalone');
  assert.deepEqual(manifest.icons.map(x=>[x.sizes,x.purpose]),[
    ['192x192','any'],['512x512','any'],['512x512','maskable']
  ]);
  for(const icon of manifest.icons){
    assert.equal(icon.type,'image/png');
    assert.ok(source('web/public'+icon.src).length>100);
  }
  const html=text('web/index.html');
  assert.match(html,/rel="apple-touch-icon" sizes="180x180" href="\/icons\/apple-touch-icon-180\.png"/);
  assert.match(html,/rel="icon" type="image\/svg\+xml" href="\/icons\/app-icon\.svg"/);
});
test('bottom navigation uses a consistent outlined SVG icon component',()=>{
  const app=text('web/src/App.vue');
  const icon=text('web/src/TabIcon.vue');
  const css=text('web/src/style.css');
  assert.match(app,/import TabIcon from '\.\/TabIcon\.vue'/);
  assert.match(app,/<TabIcon :name="tab\.id" \/>/);
  assert.match(app,/:aria-current="activeTab===tab\.id\?'page':undefined"/);
  assert.doesNotMatch(app,/\{\{tab\.icon\}\}|icon:'[◉▤◇☰]'/);
  const common=text('web/src/UiIcon.vue');
  assert.match(icon,/import UiIcon from '\.\/UiIcon\.vue'/);
  assert.match(icon,/<UiIcon :name="name" :size="24" class="nav-icon"\/>/);
  for(const name of ['today','docs','links','mine'])
    assert.ok(common.includes("name==='"+name+"'"), name+' icon missing');
  assert.match(common,/stroke-width="1\.8"/);
  assert.match(common,/aria-hidden="true"/);
  assert.match(css,/\.nav-icon\{[^}]*width:24px;height:24px/);
});
