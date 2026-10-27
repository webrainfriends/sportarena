// Renders ad-reel.html, or REEL_HTML=ad-reel-hands.html (1080x1920) frame by frame at 2x = 2160x3840. Usage: node render-reel.cjs <outDir> <startFrame> <endFrame> [scale=2] [fps=30]
const {chromium}=require('playwright');const {pathToFileURL}=require('url');const path=require('path');const fs=require('fs');
const [out,a,b,scale='2',fps='30']=process.argv.slice(2);fs.mkdirSync(out,{recursive:true});
(async()=>{const br=await chromium.launch();
const pg=await br.newPage({viewport:{width:1080,height:1920},deviceScaleFactor:+scale});
pg.on('pageerror',e=>console.log('ERR',e.message));
const html=process.env.REEL_HTML||'ad-reel.html';
if(fs.existsSync('people-hi/quads.json')){const q=fs.readFileSync('people-hi/quads.json','utf8');await pg.addInitScript(`window.QUADS=${q}`)}
await pg.goto(pathToFileURL(path.resolve(html)).href);
await pg.evaluate(()=>document.fonts.ready);await pg.waitForFunction(()=>[...document.images].every(i=>i.complete));
await pg.waitForTimeout(800);
for(let f=+a;f<+b;f++){await pg.evaluate(t=>window.render(t),f/+fps);
  await pg.screenshot({path:`${out}/f${String(f).padStart(5,'0')}.jpg`,type:'jpeg',quality:95})}
await br.close()})();
