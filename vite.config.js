import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { readdirSync, statSync, unlinkSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Cloudflare Workers Static Assets reject files >25 MiB. ORT's WASM
// binary is pinned and fetched from the official npm CDN on demand; never
// discard arbitrary assets or the smaller bundled JS OCR runtime.
function externalizeOversizedOrtWasm() {
  return {
    name:'externalize-oversized-ort-wasm',
    closeBundle(){
      const dir=resolve(process.cwd(),'dist/assets');
      // Keep version-matched ONNX .mjs module glue same-origin; Safari PWA
      // cannot dynamically import CDN module scripts under its script CSP.
      const moduleDir=resolve(process.cwd(),'dist/ocr');
      mkdirSync(moduleDir,{recursive:true});
      copyFileSync(resolve(process.cwd(),'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs'),
        resolve(moduleDir,'ort-wasm-simd-threaded.jsep.mjs'));
      const names=readdirSync(dir);
      for(const name of names){
        const path=resolve(dir,name);
        if(!/^ort-wasm-.*\.wasm$/.test(name))continue;
        if(statSync(path).size>25*1024*1024)unlinkSync(path);
      }
      for(const name of readdirSync(dir)){
        const path=resolve(dir,name);
        if(statSync(path).isFile()&&statSync(path).size>25*1024*1024)
          throw new Error('Cloudflare 25MiB single-asset limit: '+name);
      }
    }
  };
}
export default defineConfig({
  plugins: [vue(),externalizeOversizedOrtWasm()],
  root: 'web',
  publicDir: 'public',
  build: {outDir: '../dist',emptyOutDir:true, target:'es2022'},
  server: {proxy:{'/api':'http://127.0.0.1:8787'}}
});
