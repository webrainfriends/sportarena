// Usage: node render.cjs <fmt: reel|yt|feed> <outDir> <startFrame> <endFrame> [scale=2] [fps=30] [frameListCsv]
const {chromium}=require('playwright');const {pathToFileURL}=require('url');const path=require('path');const fs=require('fs');
const [fmt,out,a,b,scale='2',fps='30']=process.argv.slice(2);fs.mkdirSync(out,{recursive:true});
(async()=>{const br=await chromium.launch();
const dims={reel:[1080,1920],yt:[1920,1080],feed:[1080,1350]}[fmt];
const pg=await br.newPage({viewport:{width:dims[0],height:dims[1]},deviceScaleFactor:+scale});
pg.on('pageerror',e=>console.log('ERR',e.message));
await pg.goto(pathToFileURL(path.resolve('ad.html')).href+'?fmt='+fmt);
await pg.evaluate(()=>document.fonts.ready);await pg.waitForFunction(()=>[...document.images].every(i=>i.complete));
for(let f=+a;f<+b;f++){await pg.evaluate(t=>window.render(t),f/+fps);
  await pg.screenshot({path:`${out}/f${String(f).padStart(5,'0')}.jpg`,type:'jpeg',quality:95})}
await br.close()})();
