// Browser-driven check of para classification (#488): empty state, the athlete's class and cases, a case in progress, the classifier desk and the governing body's desk, on a phone, tablet and desktop (light and dark).
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
  const org = await reg(`pj_o${R}`, 'Aarav Menon', ['organizer']);
  const asha = await reg(`pj_a${R}`, 'Asha Rao'), ravi = await reg(`pj_r${R}`, 'Ravi Kumar'), cl = await reg(`pj_c${R}`, 'Dr. Meera Iyer'), cl2 = await reg(`pj_d${R}`, 'Sam Okafor'), blank = await reg(`pj_n${R}`, 'New Athlete');
  const sport = (await db.query("SELECT id FROM sports WHERE slug='athletics'")).rows[0];
  const body = await call('POST', '/federation/bodies', { token: org.token, body: { name: 'Para Athletics Federation', level: 'national', abbreviation: `P${R.slice(-5).toUpperCase()}`, country: 'SG', sports: [{ sport_id: sport.id }] } });
  const v0 = await call('POST', '/para/class-versions', { token: org.token, body: { body_id: body.id, sport_id: sport.id, title: 'Athletics classification rules 2026', source_ref: 'Governing rulebook, section 4', effective_from: day(-60), panel_size: 1, review_rule: 'review_required', review_months: 24, appeal_days: 14, classes: [{ code: 'T11', name: 'Track, vision class 11' }, { code: 'T12', name: 'Track, vision class 12' }, { code: 'T13', name: 'Track, vision class 13' }] } });
  await call('POST', `/para/class-versions/${v0.id}/publish`, { token: org.token });
  const k1 = await call('POST', '/para/classifiers', { token: org.token, body: { body_id: body.id, user_id: cl.id, sport_id: sport.id, grade: 'International', issued_on: day(-30), expires_on: day(400) } });
  await call('POST', '/para/classifiers', { token: org.token, body: { body_id: body.id, user_id: cl2.id, sport_id: sport.id, grade: 'National', issued_on: day(-30), expires_on: day(90) } });
  const adv = (id, token, to, extra = {}) => call('POST', `/para/cases/${id}/advance`, { token, body: { to, ...extra } });
  // Asha: decided T12, review in 24 months
  const c1 = await call('POST', '/para/cases', { token: asha.token, body: { body_id: body.id, sport_id: sport.id, note: 'Available weekday mornings' } });
  await call('POST', `/para/cases/${c1.id}/panel`, { token: org.token, body: { members: [{ classifier_id: k1.id, role: 'lead' }] } });
  await adv(c1.id, org.token, 'evidence_review'); await adv(c1.id, org.token, 'assessment_scheduled', { appointment_on: iso(-5) }); await adv(c1.id, cl.token, 'assessment_completed'); await adv(c1.id, cl.token, 'panel_review');
  await call('POST', `/para/cases/${c1.id}/decision`, { token: cl.token, body: { class_code: 'T12', status: 'confirmed' } });
  await call('POST', `/para/cases/${c1.id}/outcome`, { token: cl.token, body: {} });
  // Ravi: case at assessment scheduled with a panel, plus evidence
  const c2 = await call('POST', '/para/cases', { token: ravi.token, body: { body_id: body.id, sport_id: sport.id, requested_context: 'international' } });
  await call('POST', `/para/cases/${c2.id}/panel`, { token: org.token, body: { members: [{ classifier_id: k1.id, role: 'lead' }] } });
  await adv(c2.id, org.token, 'evidence_review'); await adv(c2.id, org.token, 'assessment_scheduled', { appointment_on: iso(6) });
  await call('POST', `/para/cases/${c2.id}/evidence`, { token: ravi.token, body: { label: 'Prior federation letter', reference: 'https://example.org/register/entry' } });
  // a lodged review on Asha's decision
  const out = (await call('GET', '/me/para-classification', { token: asha.token })).outcomes[0];
  check(out?.class_code === 'T12', 'the athlete has a confirmed class (API)');

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport, colorScheme = 'light') => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error('login failed');
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(2500);
    return { ctx, page };
  };
  const shot = (page, n) => page.screenshot({ path: `${OUT}${n}.png`, fullPage: false });
  const vis = async (p, t, ms = 5000) => { try { await p.getByText(t).first().waitFor({ state: 'visible', timeout: ms }); return true; } catch { return false; } };
  // reach the navigator the way the other journeys do (React fibers), collecting every nav context: the innermost one drives the real navigator
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

  // 1. a brand-new athlete: the honest empty state
  { const { ctx, page: p } = await session(blank, SIZES.phone); await push(p);
    check(await vis(p, 'No classification yet') && await vis(p, 'not a medical diagnosis', 1500), 'empty state explains what will appear and carries the disclaimer'); await shot(p, '01-empty-phone'); await ctx.close(); }
  // 2. the athlete with a decision: phone, tablet, desktop, dark
  for (const [name, vp, scheme] of [['phone', SIZES.phone, 'light'], ['tablet', SIZES.tablet, 'light'], ['desktop', SIZES.desktop, 'light'], ['desktop-dark', SIZES.desktop, 'dark']]) {
    const { ctx, page: p } = await session(asha, vp, scheme); await push(p);
    check(await vis(p, 'T12') && await vis(p, 'Para Athletics Federation', 1500), `athlete sees class and authority (${name})`);
    await shot(p, `02-athlete-${name}`); await ctx.close(); }
  // 3. a case in progress with the case sheet open
  { const { ctx, page: p } = await session(ravi, SIZES.phone); await push(p);
    check(await vis(p, 'Assessment scheduled'), 'case progress is written out'); await shot(p, '03-case-phone');
    await p.getByText('Assessment scheduled').first().click(); await p.waitForTimeout(1800); check(await vis(p, 'Assessment panel', 3000), 'the case opens with the panel and private evidence list'); await shot(p, '04-case-detail-phone'); await ctx.close(); }
  // 4. classifier desk
  for (const [name, vp] of [['phone', SIZES.phone], ['tablet', SIZES.tablet]]) {
    const { ctx, page: p } = await session(cl, vp); await push(p);
    await p.getByText('Classifier desk', { exact: true }).first().click(); await p.waitForTimeout(1800);
    check(await vis(p, 'My credentials'), `classifier desk (${name})`); await shot(p, `05-classifier-${name}`); await ctx.close(); }
  // 5. the governing body's desk
  for (const [name, vp] of [['desktop', SIZES.desktop], ['phone', SIZES.phone]]) {
    const { ctx, page: p } = await session(org, vp); await push(p);
    await p.getByText('Authority desk', { exact: true }).first().click(); await p.waitForTimeout(2200);
    check(await vis(p, 'Case queue') && await vis(p, 'Classification rules'), `authority desk (${name})`); await shot(p, `06-authority-${name}`); await ctx.close(); }
  await browser.close();
} catch (e) { failures++; log('ERROR', e); }
log(failures ? `${failures} FAILED` : 'ALL PASSED');
api.kill(); web.close(); await db.end(); process.exit(failures ? 1 : 0);
