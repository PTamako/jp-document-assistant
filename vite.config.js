import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { readdirSync, statSync, unlinkSync, mkdirSync, copyFileSync, cpSync, createReadStream, readFileSync } from 'node:fs';
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
// Ship resources from the exact PDF.js package used by the app, rather
// than relying on an external CDN or embedding a private document.
function pdfResources(){
  const pkgRoot=resolve(process.cwd(),'node_modules/pdfjs-dist');
  const version=JSON.parse(readFileSync(resolve(pkgRoot,'package.json'),'utf8')).version;
  const prefix='/pdf-resources/'+version+'/';
  const folders=['cmaps','standard_fonts'];
  return {
    name:'pdf-resources',
    configureServer(server){
      server.middlewares.use((req,res,next)=>{
        const path=(req.url||'').split('?')[0];
        if(!path.startsWith(prefix))return next();
        const rel=path.slice(prefix.length);
        if(!/^(cmaps|standard_fonts)\/[A-Za-z0-9_.-]+$/.test(rel)||rel.endsWith('/..')||rel.endsWith('/.')){
          res.statusCode=404;return res.end();
        }
        const file=resolve(pkgRoot,rel);
        try{if(!statSync(file).isFile())throw Error('not a file');}
        catch{res.statusCode=404;return res.end();}
        res.setHeader('Content-Type','application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle(){
      const dest=resolve(process.cwd(),'dist/pdf-resources',version);
      for(const folder of folders)cpSync(resolve(pkgRoot,folder),resolve(dest,folder),{recursive:true});
      if(!statSync(resolve(dest,'cmaps/90ms-RKSJ-H.bcmap')).isFile())throw Error('Japanese PDF CMap missing');
    }
  };
}
export default defineConfig({
  plugins: [vue(),pdfResources(),externalizeOversizedOrtWasm()],
  root: 'web',
  publicDir: 'public',
  // Keep the dedicated OCR module Worker at a stable scoped URL pattern.
  // Only this entry is served with the OCR-specific CSP by the edge Worker.
  worker: {format:'es',rollupOptions:{output:{entryFileNames:'assets/worker-entry-[hash].js'}}},
  build: {outDir: '../dist',emptyOutDir:true, target:'es2022'},
  server: {proxy:{'/api':'http://127.0.0.1:8787'}}
});
