// Browser-driven check of the coach series commercial layer (#657): block discount in the preview, pay once, manage a series.
// (header reused from coach-intro-journey.mjs) //: an athlete sees a coach's intro card as bookable, books it, and then sees it
// as used ("You've used this coach's intro session"); a guardian books for a child and the child's allowance is what counts.
// Same prerequisites as pathway-plan-journey.mjs (throwaway migrated Postgres in E2E_DATABASE_URL, a same-origin web build in E2E_DIST, playwright Chromium).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire('/opt/node-tools/')('playwright');
import pg from 'pg';
const E = { DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sportarena_e2e', SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'),
  PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'off', STRIPE_SECRET_KEY: 'sk_test_e2e', RATE_LIMIT_DISABLED: 'true' };
const OUT = (process.env.E2E_SHOTS ?? '/tmp/e2e-shots') + '/'; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const api = spawn('node', ['src/server.js'], { cwd: new URL('../../apps/api/', import.meta.url).pathname, env: { ...process.env, ...E }, stdio: ['ignore', 'pipe', 'pipe'] });
api.stdout.on('data', (d) => process.env.V && log('[api]', String(d).trim())); api.stderr.on('data', (d) => process.env.V && log('[api!]', String(d).trim()));
for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:4000/api/v1/payments/methods')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
const DIST = process.env.E2E_DIST ?? '/tmp/e2e-dist';
const web = http.createServer((req, res) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/mcp')) { const p = http.request({ host: '127.0.0.1', port: 4000, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); req.pipe(p); return; }
  let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  const ext = path.extname(f); res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.ico': 'image/x-icon' }[ext] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4100, r));
const B = 'http://localhost:4100/api/v1';
const call = async (method, p, { token, body } = {}) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p} ${r.status} ${JSON.stringify(j)}`); return j; };
const reg = async (h, name, roles = ['athlete']) => { const r = await call('POST', '/auth/register', { body: { handle: h, display_name: name, email: `${h}@example.com`, password: 'correct-horse-battery', roles } }); return { ...r.user, token: r.token, email: `${h}@example.com` }; };
const db = new pg.Pool({ connectionString: E.DATABASE_URL });
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const key = () => `e2e-${Math.random().toString(36).slice(2)}${Date.now()}`;
const wait = (p, ms = 1200) => p.waitForTimeout(ms);


const R = Date.now().toString(36);
try {
  const coach = await reg(`cs_c${R}`, 'Coach Meera', ['coach']), a = await reg(`cs_a${R}`, 'Asha Rao');
  await call('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 60000 } });
  const card = await call('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Weekly session', sport: 'football', audience: 'individual', unit: 'session', duration_min: 60, price_cents: 100000, block_discount_pct: 10, block_min_sessions: 4 } });
  const body = { coach_id: coach.id, sport: 'football', rate_card_id: card.id, start: '10:00', timezone: 'UTC', duration_min: 60, starts_on: day(5), weekdays: [1, 3], count: 6, pay_mode: 'once' };
  const pv = await call('POST', '/hires/series', { token: a.token, body: { ...body, preview: true } });
  const booked = await call('POST', '/hires/series', { token: a.token, body });
  check(pv.total_cents === booked.total_cents && pv.discount_cents === 60000, `API: preview total ${pv.total_cents} equals booked total ${booked.total_cents} (10% off 600000)`);
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.stack?.split('\n').slice(0, 4).join(' | ')));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error('login failed');
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(2500);
    return { ctx, page };
  };
  const shot = (page, n) => page.screenshot({ path: `${OUT}${n}.png`, fullPage: false });
  const vis = async (p, t, ms = 5000) => { try { await p.getByText(t).first().waitFor({ state: 'visible', timeout: ms }); return true; } catch { return false; } };
  const navTo = async (p, name, params = {}) => {
    await p.evaluate(({ name, params }) => {
      if (!window.__nav) {
        const root = document.getElementById('root') ?? document.body.firstElementChild;
        const key = Object.keys(root).find((k) => k.startsWith('__reactContainer'));
        const todo = [root[key]];
        while (todo.length && !window.__nav) { const n = todo.pop(); const v = n.memoizedProps?.value; if (v && typeof v.push === 'function' && typeof v.goTab === 'function') { window.__nav = v; break; } if (n.sibling) todo.push(n.sibling); if (n.child) todo.push(n.child); }
      }
      window.__nav.push(name, params);
    }, { name, params });
    await wait(p, 2200);
  };
  const reveal = (p, text) => p.evaluate((t) => { const el = [...document.querySelectorAll('div,span')].filter((e) => e.children.length === 0 && e.textContent.trim().startsWith(t)).pop(); el?.scrollIntoView({ block: 'center' }); }, text);
  const VIEWS = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1280, height: 860 } };
  for (const [name, vp] of Object.entries(VIEWS)) {
    // 1. the athlete's booking sheet with the block discount and pay-mode choice
    { const { ctx, page: p } = await session(a, vp);
      await navTo(p, 'CoachProfile', { id: coach.id });
      await p.getByText('Book', { exact: false }).first().click(); await wait(p, 2500);
      await p.getByText('Weekly session', { exact: false }).last().click().catch(() => {}); await wait(p, 1200);
      await p.getByText('Repeat weekly', { exact: false }).first().click(); await wait(p, 1200);
      await p.getByText('Mon', { exact: true }).first().click(); await p.getByText('Wed', { exact: true }).first().click(); await wait(p, 4000);
      check(await vis(p, 'Block discount'), `${name}: preview shows the block discount`);
      await reveal(p, 'How do you want to pay'); await wait(p, 600);
      await shot(p, `series-booking-${name}`); await ctx.close(); }
    // 2. managing the booked series
    { const { ctx, page: p } = await session(a, vp);
      await p.evaluate(() => { window.__nav = null; });
      await navTo(p, 'CoachProfile', { id: coach.id });
      await p.evaluate(() => window.__nav.goTab('Schedule', { section: 'coach' }));
      await wait(p, 1500); await p.getByText('Coaches', { exact: true }).first().click().catch(() => {}); await wait(p, 1200); await p.getByText('My coaching', { exact: false }).first().click().catch(() => {}); await wait(p, 2500);
      await wait(p, 2500);
      const opened = await p.getByText('Manage series').first().click({ timeout: 5000 }).then(() => true).catch(() => false);
      await wait(p, 2000);
      check(opened && await vis(p, 'Price before discount'), `${name}: manage series sheet opens with the discount breakdown`);
      await shot(p, `series-manage-${name}`);
      await reveal(p, 'Pause series'); await wait(p, 400);
      await p.getByText('Pause series', { exact: true }).first().click().catch(() => {}); await wait(p, 1200);
      await p.getByText('Pause series', { exact: true }).last().click().catch(() => {}); await wait(p, 2500);
      check(await vis(p, 'On hold'), `${name}: pausing shows the series on hold`);
      await p.evaluate(() => { const el = [...document.querySelectorAll('div,span')].find((e) => e.children.length === 0 && e.textContent.trim() === 'On hold'); el?.scrollIntoView({ block: 'center' }); }); await wait(p, 500);
      await shot(p, `series-paused-${name}`);
      await reveal(p, 'Resume series'); await wait(p, 400); await shot(p, `series-resume-${name}`);
      await ctx.close(); }
  }
  // 3. the coach sets the discount on the rate card
  { const { ctx, page: p } = await session(coach, VIEWS.phone);
    await navTo(p, 'CoachRates');
    await p.getByText('Edit', { exact: true }).first().click({ timeout: 5000 }).catch(() => {}); await wait(p, 1500); await reveal(p, 'Block discount'); await wait(p, 500);
    await shot(p, 'series-ratecard-phone'); await ctx.close(); }
  await browser.close();
} catch (e) { failures++; log('ERROR', e.stack ?? e.message); }
log(failures ? `${failures} FAILED` : 'ALL PASS'); api.kill(); web.close(); await db.end(); process.exit(failures ? 1 : 0);
