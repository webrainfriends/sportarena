// Photographs the wellbeing & development screens (#795) from the real app at phone, tablet and desktop widths, light and dark, with real data created through the API.
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir /tmp/e2e-dist
//   E2E_DATABASE_URL=postgres://root@/sportarena_e2e?host=/var/run/postgresql UX_SHOTS=docs/ux node scripts/e2e/academy-pickup-ux.mjs
// Retakes every screenshot of the academy Process card / PDF guide (apps/api/src/guides/academy-process.js) from the real app, on phone and
// desktop, and records which screen files they came from (apps/api/assets/guides/academy/manifest.json). Run after any change to an
// organisation / academy / venue / coach / tax screen:   npm run guide:shots
// Needs a throwaway Postgres (E2E_DATABASE_URL, migrated here, never dropped), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir /tmp/e2e-dist     (E2E_DIST)
// and playwright-core with a Chromium (E2E_CHROMIUM, default the pre-installed one). All data is created through the public API.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const { chromium } = (() => { for (const n of [process.env.PLAYWRIGHT_PATH, 'playwright-core', 'playwright']) { if (!n) continue; try { return req(n); } catch {} } throw new Error('playwright is not installed'); })();
import pg from 'pg';
import { seedWellbeing } from './lib/wellbeing-fixture.mjs';


const API_DIR = new URL('../../apps/api/', import.meta.url).pathname;
const DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sportarena_e2e';
const E = { DATABASE_URL: DB, SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'), PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'off', RATE_LIMIT_DISABLED: 'true' };
const OUT = process.env.UX_SHOTS ?? 'docs/ux'; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
execFileSync('node', ['src/migrate.js'], { cwd: API_DIR, env: { ...process.env, ...E }, stdio: 'inherit' });
const api = spawn('node', ['src/server.js'], { cwd: API_DIR, env: { ...process.env, ...E }, stdio: ['ignore', 'pipe', 'pipe'] });
api.stderr.on('data', (d) => process.env.V && log('[api!]', String(d).trim()));
for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:4000/api/v1/payments/methods')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
const DIST = process.env.E2E_DIST ?? '/tmp/e2e-dist';
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.webmanifest': 'application/json' };
const web = http.createServer((req, res) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/mcp')) {
    const p = http.request({ host: '127.0.0.1', port: 4000, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(p); return;
  }
  let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4100, r));

const call = async (method, p, { token, body } = {}) => {
  const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) { log(`  ! ${method} ${p} -> ${r.status} ${t.slice(0, 160)}`); return null; }
  return j;
};
const stamp = Date.now().toString(36);
const reg = async (h, name, roles, extra = {}) => { const r = await call('POST', '/auth/register', { body: { handle: `${h}_${stamp}`, display_name: name, email: `${h}_${stamp}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); return { ...r.user, token: r.token, email: `${h}_${stamp}@example.com` }; };
const wait = (p, ms = 1500) => p.waitForTimeout(ms);
const click = async (p, text, opts = {}) => { await p.getByText(text, { exact: true, ...opts }).first().click({ timeout: 8000 }); await wait(p, 1500); };
let failures = 0;
try {
  // ------------------------------------------------------------------ a real academy created through the API
  const owner = await reg('wb_owner', 'Priya Nair', ['organizer', 'venue_manager']);
  const org = await call('POST', '/organisations', { token: owner.token, body: { name: 'Riverside Academy', kind: 'academy', city: 'Pune' } });
  const owner2 = await reg('wb_owner2', 'Tomas Ruiz', ['organizer']);
  const empty = await call('POST', '/organisations', { token: owner2.token, body: { name: 'Costa Tennis Academy', kind: 'academy', city: 'Barcelona' } });
  const db = new pg.Pool({ connectionString: DB });
  const fx = await seedWellbeing({ call, reg, org, owner, db, apiDir: API_DIR, env: E, log });

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const open = async (viewport, who = owner, dark = false) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 }); const page = await ctx.newPage();
    if (dark) await ctx.addInitScript(() => { try { localStorage.setItem('theme', 'dark'); } catch {} });
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post('http://localhost:4100/api/v1/auth/login', { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } });
    if (!r.ok()) throw new Error(`login ${r.status()}`);
    await page.goto('http://localhost:4100/'); await wait(page, 2500);
    return page;
  };
  const navTo = async (p, name, params = {}) => {
    await p.evaluate(({ name, params }) => {
      if (!window.__nav) {
        const root = document.getElementById('root') ?? document.body.firstElementChild, key = Object.keys(root).find((k) => k.startsWith('__reactContainer')), todo = [root[key]];
        while (todo.length && !window.__nav) { const n = todo.pop(); const v = n.memoizedProps?.value; if (v && typeof v.push === 'function' && typeof v.goTab === 'function' && v.tab === undefined) { window.__nav = v; break; } if (n.sibling) todo.push(n.sibling); if (n.child) todo.push(n.child); }
      }
      window.__nav.push(name, params);
    }, { name, params });
    await wait(p, 2200);
  };
  const SIZES = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1280, height: 900 } };
  const inDesk = (o2, tab) => async (p) => { await navTo(p, 'Org', { id: o2.id }); await click(p, 'Academy'); await click(p, 'Wellbeing'); if (tab) { await p.getByText(tab, { exact: true }).last().click({ timeout: 8000 }); await wait(p, 1500); } };
  const shot = async (name, size, fn, { who = owner, dark = false, full = false } = {}) => {
    const page = await open(SIZES[size], who, dark);
    try { await fn(page); await page.screenshot({ path: path.join(OUT, `wellbeing-${name}-${size}${dark ? '-dark' : ''}.png`), fullPage: full }); log(`PASS  ${name} ${size}${dark ? ' dark' : ''}`); }
    catch (e) { failures++; log(`FAIL  ${name} ${size}: ${e.message.split('\n')[0]}`); await page.screenshot({ path: `/tmp/wb-fail-${name}-${size}.png` }); }
    await page.context().close();
  };
  const family = (person) => async (p) => { await navTo(p, 'AcademyFamily'); await click(p, 'Wellbeing'); if (person) await click(p, person); };
  for (const size of ['phone', 'tablet', 'desktop']) {
    const full = size === 'phone';
    await shot('1-director-overview', size, inDesk(org), { full });
    await shot('2-people', size, inDesk(org, 'People'), { full });
    await shot('3-athlete-record', size, async (p) => { await inDesk(org, 'People')(p); await p.getByText(/Kabir Malhotra/).first().click(); await wait(p, 1500); }, { who: fx.mentor });
    await shot('4-checkins', size, inDesk(org, 'Check-ins'), { who: fx.mentor, full });
    await shot('5-record-checkin', size, async (p) => { await inDesk(org, 'Check-ins')(p); await click(p, 'To record'); await p.getByText(/Lucia Ferrer/).first().click(); await wait(p, 1000); await p.getByText('Record the check-in', { exact: true }).first().click(); await wait(p, 1200); }, { who: fx.mentor });
    await shot('6-tracks', size, inDesk(org, 'Tracks'), { full });
    await shot('7-track-detail', size, async (p) => { await inDesk(org, 'Tracks')(p); await p.getByText('Leadership foundations', { exact: true }).first().click(); await wait(p, 1500); });
    await shot('8-goals', size, inDesk(org, 'Goals'), { who: fx.mentor, full });
    await shot('9-specialists', size, inDesk(org, 'Specialists'), { who: fx.mentor });
    await shot('10-guardian', size, family('Lucia Ferrer'), { who: fx.parents[1], full });
    await shot('11-choices', size, async (p) => { await family('Lucia Ferrer')(p); await click(p, 'Change'); }, { who: fx.parents[1] });
    await shot('12-adult-athlete', size, family(), { who: fx.adults[0], full });
    await shot('13-empty-director', size, inDesk(empty), { who: owner2 });
  }
  await shot('1-director-overview', 'tablet', inDesk(org), { dark: true });
  await shot('10-guardian', 'phone', family('Lucia Ferrer'), { who: fx.parents[1], dark: true, full: true });
  await shot('14-young-person', 'phone', family(), { who: fx.youth[0], full: true });
  await browser.close();
} catch (e) { failures++; log('ERROR', e); }
api.kill(); web.close();
log(failures ? `${failures} failure(s)` : 'all wellbeing screens photographed');
process.exit(failures ? 1 : 0);
