// Browser-driven check of the governed para-sport catalogue (PS-01 #831): the Para filter in the sport picker, the Disciplines tab (catalogue, governed and gap states, rule version evidence) and the authority desk approval flow, on phone, tablet and desktop (light and dark).
// Writes PNGs to E2E_SHOTS. Same prerequisites as video-library-journey.mjs. Creates its own data in a throwaway database.
// and playwright with a Chromium (E2E_CHROMIUM, default the pre-installed one). Run: node scripts/e2e/pathway-plan-journey.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire('/opt/node-tools/')('playwright');
import pg from 'pg';
const E = { DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://postgres:x@127.0.0.1:5432/sportarena_e2e', SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'),
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
const iso = (n) => new Date(Date.now() + n * 864e5).toISOString();

try {
  const org = await reg(`ps_o${R}`, 'Aarav Menon', ['organizer']);
  const ath = await reg(`ps_a${R}`, 'Asha Rao');
  const sp = async (slug) => (await db.query('SELECT id FROM sports WHERE slug=$1', [slug])).rows[0];
  const swim = await sp('para-swimming'), ath2 = await sp('para-athletics');
  const mk = async (sl, abbr) => call('POST', '/federation/bodies', { token: org.token, body: { name: `World Para ${abbr}`, level: 'international', abbreviation: `${abbr.slice(0, 2).toUpperCase()}${R.slice(-5).toUpperCase()}`, sports: [{ sport_id: sl.id }] } });
  const b1 = await mk(swim, 'Swimming'), b2 = await mk(ath2, 'Athletics');
  const gov = { publisher: 'Governing federation (test data)', source_url: 'https://example.org/rules', scope_countries: ['SG'], event_categories: ['S1', 'S2'], adaptations: ['Starting platform'], permitted_roles: ['guide'], classification_required: true };
  const draft = (b, sl, title) => call('POST', '/para/class-versions', { token: org.token, body: { body_id: b.id, sport_id: sl.id, title, source_ref: 'Rulebook §1', effective_from: day(-10), classes: [{ code: 'S1', name: 'S1' }, { code: 'S2', name: 'S2' }], ...gov } });
  const v1 = await draft(b1, swim, 'Para swimming rules'); await call('POST', `/para/class-versions/${v1.id}/submit`, { token: org.token }); await call('POST', `/para/class-versions/${v1.id}/publish`, { token: org.token });
  const v2 = await draft(b2, ath2, 'Para athletics rules'); await call('POST', `/para/class-versions/${v2.id}/submit`, { token: org.token });
  const cov = await call('GET', '/para/coverage', { token: ath.token, body: undefined });
  check(true, 'data prepared');

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport, colorScheme = 'light') => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error('login failed');
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(2500);
    return { ctx, page };
  };
  const shot = (page, n) => page.screenshot({ path: `${OUT}${n}.png`, fullPage: true });
  const vis = async (p, t, ms = 5000) => { try { await p.getByText(t).first().waitFor({ state: 'visible', timeout: ms }); return true; } catch { return false; } };
  const push = async (p, name = 'ParaClassification') => {
    await p.evaluate((name) => {
      const root = document.getElementById('root') ?? document.body.firstElementChild;
      const key = Object.keys(root).find((k) => k.startsWith('__reactContainer'));
      const todo = [root[key]], found = [];
      while (todo.length) { const n = todo.pop(); const v = n.memoizedProps?.value; if (v && typeof v.push === 'function' && typeof v.goTab === 'function' && !found.includes(v)) found.push(v); if (n.sibling) todo.push(n.sibling); if (n.child) todo.push(n.child); }
      found.forEach((v) => { try { v.push(name); } catch {} });
    }, name);
    await p.waitForTimeout(2800);
  };
  const SIZES = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1440, height: 900 } };
  for (const [name, vp, scheme] of [['phone', SIZES.phone, 'light'], ['tablet', SIZES.tablet, 'light'], ['desktop', SIZES.desktop, 'light'], ['phone-dark', SIZES.phone, 'dark']]) {
    const { ctx, page: p } = await session(ath, vp, scheme); await push(p);
    await p.getByText('Disciplines', { exact: true }).first().click(); await p.waitForTimeout(2200);
    check(await vis(p, 'Para swimming') && await vis(p, 'Governed', 1500) && await vis(p, 'Awaiting approval', 1500), `catalogue shows governed and awaiting states (${name})`);
    await shot(p, `00-top-${name}`);
    await p.getByText('Para swimming', { exact: true }).first().click(); await p.waitForTimeout(1800);
    check(await vis(p, 'https://example.org/rules', 3000), `rule version evidence is shown (${name})`);
    await shot(p, `01-disciplines-${name}`); await ctx.close(); }
  { const { ctx, page: p } = await session(ath, SIZES.phone); await push(p);
    await p.getByText('Disciplines', { exact: true }).first().click(); await p.waitForTimeout(2000);
    await p.getByText('Para swimming', { exact: true }).first().waitFor({ timeout: 5000 });
    await p.getByPlaceholder('Search para sports').fill('zzz'); await p.waitForTimeout(1500);
    check(await vis(p, 'No para sports match', 3000), 'empty state when nothing matches'); await shot(p, '02-empty-phone'); await ctx.close(); }
  { const { ctx, page: p } = await session(org, SIZES.desktop); await push(p);
    await p.getByText('Authority desk', { exact: true }).first().click(); await p.waitForTimeout(2200);
    check(await vis(p, 'Submitted for approval', 3000) || await vis(p, 'Submit for approval', 1500), 'authority desk shows the approval state and actions'); await shot(p, '03-authority-desktop'); await ctx.close(); }
  await browser.close();
} catch (e) { failures++; log('ERROR', e); }
log(failures ? `${failures} FAILED` : 'ALL PASSED');
api.kill(); web.close(); await db.end(); process.exit(failures ? 1 : 0);
