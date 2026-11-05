// Photographs the international admissions screens (#799) from the real app at phone, tablet and desktop widths, light and dark, with real data created through the API.
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir /tmp/e2e-dist
//   E2E_DATABASE_URL=postgres://root@/sportarena_e2e?host=/var/run/postgresql UX_SHOTS=docs/ux node scripts/e2e/academy-international-ux.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const { chromium } = (() => { for (const n of [process.env.PLAYWRIGHT_PATH, 'playwright-core', 'playwright']) { if (!n) continue; try { return req(n); } catch {} } throw new Error('playwright is not installed'); })();
import pg from 'pg';


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
const PREFIX = 'international';
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
try {
  const owner = await reg('intl_owner', 'Priya Nair', ['organizer'], { dob: yearsAgo(40) }), admin2 = await reg('intl_admin', 'Alex Lee', ['coach'], { dob: yearsAgo(38) });
  const pro = await reg('intl_pro', 'Arjun Mehta', ['athlete'], { dob: yearsAgo(19) }), kid = await reg('intl_kid', 'Kabir Rao', ['athlete'], { dob: yearsAgo(14) }), third = await reg('intl_third', 'Lena Costa', ['athlete'], { dob: yearsAgo(20) });
  const parent = await reg('intl_parent', 'Meera Rao', ['athlete'], { dob: yearsAgo(42) });
  const org = await call('POST', '/organisations', { token: owner.token, body: { name: 'Riverside Tennis Academy', kind: 'academy', city: 'Barcelona' } });
  await call('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: admin2.handle, role: 'admin' } }); await call('POST', `/organisations/${org.id}/invite/respond`, { token: admin2.token, body: { accept: true } });
  await call('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['tennis'], currency: 'EUR', listed: true } });
  const prog = await call('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'tennis', title: 'Residential Elite Programme U18', capacity: 12, admission_mode: 'application', public: true } });
  await call('POST', `/academy/programmes/${prog.id}/versions`, { token: owner.token, body: { row_version: prog.row_version, billing_model: 'free', currency: 'EUR' } });
  // the guardian link for the young athlete
  const link = await call('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: kid.id, relationship: 'parent' } });
  await call('POST', `/youth/guardian-links/${link.id}/respond`, { token: kid.token, body: { accept: true } });
  await call('POST', `/youth/guardian-links/${link.id}/evidence`, { token: parent.token, body: { evidence: { reference: 'https://example.com/ref-123', label: 'Birth certificate' } } });
  const db = new pg.Pool({ connectionString: DB });
  await db.query("UPDATE guardian_links SET status='active', decided_at=now() WHERE id=$1", [link.id]).catch(() => {});
  await call('POST', `/youth/children/${kid.id}/consents`, { token: parent.token, body: { purpose: 'participation' } });
  const apply = async (u, athleteId) => { const e = await call('POST', `/academy/programmes/${prog.id}/applications`, { token: u.token, body: athleteId ? { athlete_id: athleteId } : {} }); const s = await call('POST', `/academy/applications/${e.id}/submit`, { token: u.token, body: { row_version: e.row_version, answers: {} } }); return call('POST', `/academy/applications/${e.id}/decision`, { token: owner.token, body: { row_version: s.row_version, decision: 'offer', reason: 'Strong trial' } }); };
  const appPro = await apply(pro), appKid = await apply(parent, kid.id).catch(() => null), appThird = await apply(third);
  await call('POST', `/organisations/${org.id}/academy/residences`, { token: owner.token, body: { name: 'North Hall', kind: 'residence_hall', capacity: 40, address: '12 Carrer Nord' } });
  await call('POST', `/organisations/${org.id}/academy/residences`, { token: owner.token, body: { name: 'Host family network', kind: 'host_family', capacity: 8 } });
  const res = (await call('GET', `/organisations/${org.id}/academy/residences`, { token: owner.token }));
  const TPL = { name: 'Spain residential entry', countries: ['IN', 'GB', 'BR'], note: 'Reviewed against the 2026 entry guidance', items: [
    { key: 'passport', kind: 'travel_document', label: 'Passport valid 6 months beyond arrival', mandatory: true, lead_days: 60 },
    { key: 'visa', kind: 'travel_document', label: 'Student visa or residence permit', mandatory: true, lead_days: 45 },
    { key: 'eligibility_check', kind: 'eligibility', label: 'Federation eligibility and transfer clearance', mandatory: true, lead_days: 40 },
    { key: 'school_place', kind: 'school', label: 'School place confirmed', mandatory: true, lead_days: 30 },
    { key: 'residence_place', kind: 'residence', label: 'Residence place confirmed', mandatory: true, lead_days: 30 },
    { key: 'arrival_transport', kind: 'transport', label: 'Airport transfer booked', mandatory: false, lead_days: 7 }] };
  await call('POST', `/organisations/${org.id}/academy/international/templates`, { token: owner.token, body: TPL });
  const start = (a, country, days, reviewer) => call('POST', `/academy/applications/${a.id}/international`, { token: owner.token, body: { origin_country: country, arrival_on: inDays(days), reviewer_id: reviewer, residence_id: res[0]?.id } });
  const kPro = await start(appPro, 'IN', 45, admin2.id), kKid = appKid ? await start(appKid, 'BR', 75, admin2.id) : null;
  const verify = async (k, key, extra = {}) => { const it = k.items.find((i) => i.key === key); await call('POST', `/academy/international/items/${it.id}/submit`, { token: (k === kKid ? parent : pro).token, body: {} }); return call('POST', `/academy/international/items/${it.id}/decision`, { token: owner.token, body: { decision: 'verify', ...extra } }); };
  await call('POST', `/academy/international/${kPro.id}/documents/passport`, { token: pro.token, body: { status: 'held', expires_on: inDays(1100), number: 'K7788123', evidence_ref: 'scan-passport-01' } });
  await call('POST', `/academy/international/${kPro.id}/documents/visa`, { token: pro.token, body: { status: 'submitted', expires_on: inDays(400) } });
  for (const key of ['passport', 'eligibility_check', 'school_place']) await verify(kPro, key);
  const c1 = await call('POST', `/academy/international/${kPro.id}/conditions`, { token: admin2.token, body: { text: 'Student visa granted before the place is confirmed', item_key: 'visa' } });
  await call('POST', `/academy/international/conditions/${c1.id}/decision`, { token: owner.token, body: { decision: 'approve' } });
  await call('POST', `/academy/international/${kPro.id}/conditions`, { token: admin2.token, body: { text: 'Residence deposit received' } });
  await call('POST', `/academy/international/${kPro.id}/tasks`, { token: owner.token, body: { title: 'Book airport pickup', due_on: inDays(30), owner_id: admin2.id } });
  await call('POST', `/academy/international/${kPro.id}/tasks`, { token: owner.token, body: { title: 'Open a student bank account', due_on: inDays(-3), owner_id: owner.id } });
  if (kKid) { await call('POST', `/academy/international/${kKid.id}/documents/passport`, { token: parent.token, body: { status: 'held', expires_on: inDays(900), number: 'P5544772' } }); const g = kKid.items.find((i) => i.kind === 'guardian_permission'); await call('POST', `/academy/international/items/${g.id}/submit`, { token: parent.token, body: {} }); }
  const bare = await call('POST', '/organisations', { token: owner.token, body: { name: 'Harbour Academy', kind: 'academy', city: 'Mumbai' } });

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
        while (todo.length && !window.__nav) { const n = todo.pop(); const v = n.memoizedProps?.value; if (v && typeof v.push === 'function' && typeof v.goTab === 'function' && v.tab === undefined) {
           window.__nav = v; break; } if (n.sibling) todo.push(n.sibling); if (n.child) todo.push(n.child); }
      }
      window.__nav.push(name, params);
    }, { name, params });
    await wait(p, 2200);
  };
  const desk = async (p, id = org.id) => { await navTo(p, 'Org', { id }); await click(p, 'Academy'); await click(p, 'International'); };
  const openCase = async (p, name = 'Arjun Mehta') => { await desk(p); await click(p, name); };
  const review = async (p, name) => { await navTo(p, 'Org', { id: org.id }); await click(p, 'Academy'); await click(p, 'Admissions'); await click(p, name); };
  const SIZES = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1280, height: 900 } };
  const shot = async (name, size, fn, { who = owner, dark = false, full = false, expect = [] } = {}) => {
    const page = await open(SIZES[size], who, dark);
    try {
      await fn(page);
      for (const text of expect) { if (!(await page.getByText(text).first().isVisible().catch(() => false))) throw new Error(`expected to see "${text}"`); }
      if (size === 'phone' && expect[0]) { await page.getByText(expect[0]).first().scrollIntoViewIfNeeded().catch(() => {}); await wait(page, 600); }
      await page.screenshot({ path: path.join(OUT, `${PREFIX}-${name}-${size}${dark ? '-dark' : ''}.png`), fullPage: false }); log(`PASS  ${name} ${size}${dark ? ' dark' : ''}`);
    } catch (e) { failures++; log(`FAIL  ${name} ${size}: ${e.message.split('\n')[0]}`); await page.screenshot({ path: `/tmp/intl-fail-${name}-${size}.png` }); }
    await page.context().close();
  };
  for (const size of ['phone', 'tablet', 'desktop']) {
    const full = size === 'phone';
    await shot('1-board', size, desk, { full, expect: ['Readiness by athlete', 'Arjun Mehta'] });
    await shot('2-case', size, (p) => openCase(p), { full, expect: ['Checklist', 'Offer conditions', 'Pre-arrival tasks'] });
    await shot('3-verify-sheet', size, async (p) => { await openCase(p); await click(p, 'Verify'); }, { expect: ['Evidence valid until'] });
    await shot('4-vault', size, async (p) => { await openCase(p); await click(p, 'Visa or residence permit'); }, { expect: ['Expiry date'] });
    await shot('5-templates', size, async (p) => { await desk(p); await click(p, 'Checklists'); }, { full, expect: ['Spain residential entry'] });
    await shot('6-template-sheet', size, async (p) => { await desk(p); await click(p, 'Checklists'); await click(p, 'Spain residential entry'); }, { expect: ['Checklist items'] });
    await shot('7-residences', size, async (p) => { await desk(p); await click(p, 'Residences'); }, { full, expect: ['North Hall'] });
    await shot('8-review-start', size, (p) => review(p, 'Lena Costa'), { full, expect: ['Start international checklist'] });
    await shot('9-review-open', size, (p) => review(p, 'Arjun Mehta'), { full, expect: ['Open checklist'] });
    await shot('10-start-sheet', size, async (p) => { await review(p, 'Lena Costa'); await click(p, 'Start international checklist'); }, { expect: ['Country of origin'] });
    await shot('11-family', size, (p) => navTo(p, 'AcademyFamily'), { who: pro, full, expect: ['Relocation checklist'] });
    await shot('12-family-guardian', size, (p) => navTo(p, 'AcademyFamily'), { who: parent, full, expect: ['Relocation checklist'] });
    await shot('13-empty', size, (p) => desk(p, bare.id), { expect: ['No international applicants yet'] });
  }
  await shot('2-case', 'tablet', (p) => openCase(p), { dark: true, expect: ['Checklist'] });
  await shot('11-family', 'phone', (p) => navTo(p, 'AcademyFamily'), { who: pro, dark: true, full: true });
  await browser.close();
} catch (e) { failures++; log('ERROR', e); }
api.kill(); web.close();
log(failures ? `${failures} failure(s)` : 'all international admissions screens photographed');
process.exit(failures ? 1 : 0);
