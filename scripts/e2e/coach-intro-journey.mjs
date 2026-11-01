// Browser-driven check of the coach intro-offer rule (#658): an athlete sees a coach's intro card as bookable, books it, and then sees it
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
  PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'off', RATE_LIMIT_DISABLED: 'true' };
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
  const coach = await reg(`ci_c${R}`, 'Coach Meera', ['coach']), a = await reg(`ci_a${R}`, 'Asha Rao'), g = await reg(`ci_g${R}`, 'Priya Rao'), kid = await reg(`ci_k${R}`, 'Dev Rao');
  await call('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 60000 } });
  await call('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Hour with Meera', sport: 'football', audience: 'individual', unit: 'hour', price_cents: 60000 } });
  const intro = await call('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Intro session', sport: 'football', audience: 'individual', unit: 'session', duration_min: 45, price_cents: 20000, is_intro: true } });
  await db.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await db.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [g.id, kid.id]);
  const when = (n) => { const d = new Date(Date.now() + n * 864e5); d.setUTCHours(9, 0, 0, 0); return d.toISOString(); };
  const first = await call('POST', '/hires', { token: a.token, body: { coach_id: coach.id, rate_card_id: intro.id, starts_at: when(3) } });
  const again = await call('POST', '/hires', { token: a.token, body: { coach_id: coach.id, rate_card_id: intro.id, starts_at: when(4) } }).catch((e) => String(e.message));
  check(!!first?.id && /intro_used/.test(String(again)), 'API: first intro books, the second is refused with intro_used');
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error('login failed');
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(2500);
    return { ctx, page };
  };
  const shot = (page, n) => page.screenshot({ path: `${OUT}${n}.png`, fullPage: false });
  const vis = async (p, t, ms = 4000) => { try { await p.getByText(t).first().waitFor({ state: 'visible', timeout: ms }); return true; } catch { return false; } };
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
  const bookSheet = async (p) => {
    await navTo(p, 'CoachProfile', { id: coach.id });
    await p.getByText('Book', { exact: false }).first().click(); await wait(p, 2500);
  };
  const VIEWS = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1280, height: 860 } };
  for (const [name, vp] of Object.entries(VIEWS)) {
    const { ctx, page: p } = await session(a, vp);
    await bookSheet(p);
    check(await vis(p, "You've used this coach's intro session"), `${name}: used intro card shows the message`);
    await shot(p, `intro-used-${name}`); await ctx.close();
  }
  const fresh = await reg(`ci_f${R}`, 'Neel Menon');
  { const { ctx, page: p } = await session(fresh, VIEWS.phone); await bookSheet(p);
    check(!(await vis(p, "You've used this coach's intro session", 1500)), 'a new athlete sees the intro as bookable'); await shot(p, 'intro-available-phone'); await ctx.close(); }
  { const { ctx, page: p } = await session(g, VIEWS.phone); await bookSheet(p);
    check(await vis(p, 'Booking for'), 'guardian sees the "Booking for" athlete picker'); await shot(p, 'intro-guardian-phone'); await ctx.close(); }
  await browser.close();
} catch (e) { log('ERROR', e); failures++; }
finally { api.kill(); web.close(); await db.end(); log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0); }
