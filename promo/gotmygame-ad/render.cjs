// Usage: node render.mjs <outDir> <startFrame> <endFrame> [scale] [fps]
const {chromium}=require('playwright');
const {pathToFileURL}=require('url');const path=require('path');const fs=require('fs');
const [out,a,b,scale='2',fps='30']=process.argv.slice(2);
fs.mkdirSync(out,{recursive:true});
(async()=>{
const br=await chromium.launch();
const pg=await br.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:+scale});
await pg.goto(pathToFileURL(path.resolve('ad.html')).href);
await pg.evaluate(()=>document.fonts.ready);
await pg.waitForFunction(()=>[...document.images].every(i=>i.complete));
for(let f=+a;f<+b;f++){
  await pg.evaluate(t=>window.render(t),f/+fps);
  await pg.screenshot({path:`${out}/f${String(f).padStart(5,'0')}.png`});
}
await br.close();
})();
