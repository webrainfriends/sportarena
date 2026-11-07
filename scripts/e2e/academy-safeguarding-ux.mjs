// Photographs the safeguarding case screens (#784) from the real app at phone, tablet and desktop widths, light and dark, with real data created through the API.
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir /tmp/e2e-dist
//   E2E_DATABASE_URL=postgres://postgres@/sportarena_e2e?host=/tmp UX_SHOTS=docs/ux node scripts/e2e/academy-safeguarding-ux.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const { chromium } = (() => { for (const n of [process.env.PLAYWRIGHT_PATH, 'playwright-core', 'playwright']) { if (!n) continue; try { return req(n); } catch {} } throw new Error('playwright is not installed'); })();
import pg from 'pg';
import { seedPickup } from './lib/pickup-fixture.mjs';
import { seedSafeguarding } from './lib/safeguarding-fixture.mjs';

const API_DIR = new URL('../../apps/api/', import.meta.url).pathname;
const DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sportarena_e2e';
const E = { DATABASE_URL: DB, SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'), PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'off' };
const OUT = process.env.UX_SHOTS ?? 'docs/ux'; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
execFileSync('node', ['src/migrate.js'], { cwd: API_DIR, env: { ...process.env, ...E }, stdio: 'inherit' });
const api = spawn('node', ['src/server.js'], { cwd: API_DIR, env: { ...process.env, ...E }, stdio: ['ignore', 'pipe', 'pipe'] });
api.stderr.on('data', (d) => process.env.V && log('[api!]', String(d).trim()));
for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:4000/api/v1/payments/methods')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
const DIST = process.env.E2E_DIST ?? '/tmp/e2e-dist';
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.webmanifest': 'application/json' };
const web = http.createServer((rq, res) => {
  if (rq.url.startsWith('/api') || rq.url.startsWith('/mcp')) {
    const p = http.request({ host: '127.0.0.1', port: 4000, path: rq.url, method: rq.method, headers: rq.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => { res.writeHead(502); res.end(); }); rq.pipe(p); return;
  }
  let f = path.join(DIST, decodeURIComponent(rq.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
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
const reg = async (h, name, roles, extra = {}) => { const r = await call('POST', '/auth/register', { body: { handle: `${h}_${stamp}`, display_name: name, email: `${h}_${stamp}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); return { ...r.user, token: r.token, handle: `${h}_${stamp}`, email: `${h}_${stamp}@example.com` }; };
const wait = (p, ms = 1500) => p.waitForTimeout(ms);
const click = async (p, text, opts = {}) => { await p.getByText(text, { exact: true, ...opts }).first().click({ timeout: 8000 }); await wait(p, 1500); };
let failures = 0;
try {
  const owner = await reg('sg_owner', 'Priya Nair', ['organizer', 'venue_manager']), coach = await reg('sg_coach', 'Alex Lee', ['coach']);
  const org = await call('POST', '/organisations', { token: owner.token, body: { name: 'Riverside Academy', kind: 'academy', city: 'Pune' } });
  await call('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: coach.handle, role: 'coach' } });
  await call('POST', `/organisations/${org.id}/invite/respond`, { token: coach.token, body: { accept: true } });
  const cohort = await call('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'U12 Football', coach_id: coach.id } });
  const db = new pg.Pool({ connectionString: DB });
  const pk = await seedPickup({ call, reg, org, owner, coach, cohort, db, apiDir: API_DIR, env: E, log });
  const fx = await seedSafeguarding({ call, reg, org, owner, coach, kids: pk.kids, log });
  const empty = await reg('sg_owner2', 'Tomas Ruiz', ['organizer']);
  const emptyOrg = await call('POST', '/organisations', { token: empty.token, body: { name: 'Costa Tennis Academy', kind: 'academy', city: 'Barcelona' } });

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const open = async (viewport, who, dark) => {
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
  const desk = (o2, chip = null) => async (p) => { await navTo(p, 'Org', { id: o2.id }); await click(p, 'Academy'); await click(p, 'Safety & pickup'); await click(p, 'Safeguarding cases'); if (chip) await click(p, chip); };
  const shot = async (name, size, fn, { who = owner, dark = false, full = false } = {}) => {
    const page = await open(SIZES[size], who, dark);
    try { await fn(page); await page.screenshot({ path: path.join(OUT, `safeguarding-${name}-${size}${dark ? '-dark' : ''}.png`), fullPage: full }); log(`PASS  ${name} ${size}${dark ? ' dark' : ''}`); }
    catch (e) { failures++; log(`FAIL  ${name} ${size}: ${e.message.split('\n')[0]}`); await page.screenshot({ path: `/tmp/sg-fail-${name}-${size}.png` }); }
    await page.context().close();
  };
  const openCase = (chip) => async (p) => { await desk(org, chip)(p); await p.getByText(/^SG-\d{4}-\d{4} ·/).first().click({ timeout: 8000 }); await wait(p, 1800); };
  for (const size of ['phone', 'tablet', 'desktop']) {
    const full = size === 'phone';
    await shot('1-officer-desk', size, desk(org), { who: fx.officer, full });
    await shot('2-case', size, openCase(), { who: fx.officer });
    await shot('3-officers', size, desk(org, 'Officers & escalation'), { full });
    await shot('4-suitability', size, desk(org, 'Staff suitability'), { full });
    await shot('5-policy', size, desk(org, 'Policy & reporting'), { full });
    await shot('6-raise-concern', size, async (p) => { await desk(org)(p); await click(p, 'Raise a concern'); }, { who: coach });
    await shot('7-restricted-staff', size, desk(org), { who: coach });
    await shot('8-guardian', size, async (p) => { await navTo(p, 'AcademyFamily'); await click(p, 'Wellbeing'); }, { who: pk.guardians[1], full });
    await shot('9-empty', size, desk(emptyOrg), { who: empty });
  }
  await shot('1-officer-desk', 'tablet', desk(org), { who: fx.officer, dark: true });
  await shot('2-case', 'phone', openCase(), { who: fx.officer, dark: true });
  await shot('8-guardian', 'phone', async (p) => { await navTo(p, 'AcademyFamily'); await click(p, 'Wellbeing'); }, { who: pk.guardians[1], dark: true, full: true });
  await shot('4-suitability', 'desktop', desk(org, 'Staff suitability'), { dark: true });
  await browser.close();
} catch (e) { failures++; log('ERROR', e); }
api.kill(); web.close();
log(failures ? `${failures} failure(s)` : 'all safeguarding screens photographed');
process.exit(failures ? 1 : 0);
