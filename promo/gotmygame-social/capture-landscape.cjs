// Landscape / tablet captures for the physio's landscape phone and the doctor's tablet. Usage: node capture-landscape.cjs <outDir>
const {chromium}=require('playwright');const fs=require('fs');const out=process.argv[2]||'shots';fs.mkdirSync(out,{recursive:true});
const URL='http://localhost:4100';
const login=async(p,h)=>{await p.goto(URL);await p.waitForTimeout(2500);
  await p.getByText('Log in',{exact:true}).first().click();await p.waitForTimeout(900);
  const i=p.locator('input');await i.nth(0).fill(h+'@demo.sportarena.dev');await i.nth(1).fill('sportarena-demo');
  await p.getByText('Log in',{exact:true}).last().click();await p.waitForTimeout(3500)};
const hideBeta=p=>p.evaluate(()=>{for(const e of document.querySelectorAll('div'))if(e.children.length<=1&&/^BETA ·/.test(e.textContent||'')&&e.textContent.length<200){e.style.display='none';break}});
const shot=async(p,n)=>{await hideBeta(p);await p.waitForTimeout(300);await p.screenshot({path:`${out}/${n}.png`});console.log('ok',n)};
(async()=>{const b=await chromium.launch();
// physio scene: an athlete's phone held sideways (844x390 @3x)
let p=await (await b.newContext({viewport:{width:844,height:390},deviceScaleFactor:3})).newPage();await login(p,'aarav');
await p.getByText('Physio / doctor').first().click();await p.waitForTimeout(3000);await p.mouse.move(420,200);await p.mouse.wheel(0,250);await p.waitForTimeout(900);await shot(p,'health_l');
await p.mouse.wheel(0,-600);await p.waitForTimeout(500);await p.getByText('Find a pro',{exact:true}).first().click();await p.waitForTimeout(2800);await p.mouse.move(420,200);await p.mouse.wheel(0,300);await p.waitForTimeout(900);await shot(p,'health_pros_l');await p.close();
// doctor scene: the doctor workspace on a tablet (1024x768 @2x)
p=await (await b.newContext({viewport:{width:1024,height:768},deviceScaleFactor:2})).newPage();await login(p,'dr_rhea');
await p.getByText('Open workspace').first().click();await p.waitForTimeout(3000);await shot(p,'doctor_t');await p.close();
await b.close()})();
