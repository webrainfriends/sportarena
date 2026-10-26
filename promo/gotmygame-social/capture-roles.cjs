// Captures the feature screens that live behind other roles and the More wheel (tournament console, physio, doctor, learning, sponsors).
// Usage: node capture-roles.cjs <outDir>   (needs the API + serve.cjs running, demo users from `npm run seed`)
const {chromium}=require('playwright');const fs=require('fs');const out=process.argv[2]||'shots';fs.mkdirSync(out,{recursive:true});
const URL='http://localhost:4100';
const login=async(p,h)=>{await p.goto(URL);await p.waitForTimeout(2500);
  await p.getByText('Log in',{exact:true}).first().click();await p.waitForTimeout(900);
  const i=p.locator('input');await i.nth(0).fill(h+'@demo.sportarena.dev');await i.nth(1).fill('sportarena-demo');
  await p.getByText('Log in',{exact:true}).last().click();await p.waitForTimeout(3500)};
const hideBeta=p=>p.evaluate(()=>{for(const e of document.querySelectorAll('div'))if(e.children.length<=1&&/^BETA ·/.test(e.textContent||'')&&e.textContent.length<200){e.style.display='none';break}});
const shot=async(p,n)=>{await hideBeta(p);await p.waitForTimeout(300);await p.screenshot({path:`${out}/${n}.png`});console.log('ok',n)};
// turn the More wheel (arrow keys) until a module whose label matches `re` is centred, then open it
const wheelTo=async(p,re)=>{await p.getByText('More',{exact:true}).last().click();await p.waitForTimeout(1200);
  for(let k=0;k<30;k++){
    const c=await p.evaluate(()=>{const e=[...document.querySelectorAll('[aria-label]')].find(x=>/selected\. Tap to open/.test(x.getAttribute('aria-label')));return e?e.getAttribute('aria-label'):''});
    if(re.test(c)){await p.locator('[aria-label*="selected. Tap to open"]').first().click();await p.waitForTimeout(3000);return true}
    await p.keyboard.press('ArrowRight');await p.waitForTimeout(450)}
  return false};
const newPage=async b=>(await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:3})).newPage();
const run=async(n,f)=>{try{await f();}catch(e){console.log('FAIL',n,e.message.slice(0,100))}};
(async()=>{const b=await chromium.launch();
// learning: the athlete's Learn & study sport pathways
let p=await newPage(b);await login(p,'aarav');
await run('learn',async()=>{if(await wheelTo(p,/Learn/)){await shot(p,'learn')}else console.log('no Learn tile')});
await p.close();
// doctor workspace
p=await newPage(b);await login(p,'dr_rhea');
await run('doctor',async()=>{await p.getByText('Open workspace').first().click();await p.waitForTimeout(3000);await shot(p,'doctor')});
await p.close();
// physio practice
p=await newPage(b);await login(p,'physio_zane');
await run('physio',async()=>{await p.getByText('Physio / doctor').first().click();await p.waitForTimeout(3000);await shot(p,'physio')});
await p.close();
// sponsor home
p=await newPage(b);await login(p,'volt_drink');
await run('sponsor',async()=>{if(await wheelTo(p,/Workspace|Sponsor/)){await shot(p,'sponsor')}else console.log('no sponsor tile')});
await p.close();
// tournament organiser: events I run, then the event console
p=await newPage(b);await login(p,'kavya_events');
await run('tournaments',async()=>{await p.getByText('Schedule',{exact:true}).last().click();await p.waitForTimeout(1500);await p.getByText('Events & teams',{exact:true}).first().click();await p.waitForTimeout(2500);await shot(p,'tournaments')});
await run('event_console',async()=>{await p.getByText('Neon League Season 1').first().click();await p.waitForTimeout(3000);await shot(p,'event_console')});
await b.close()})();
