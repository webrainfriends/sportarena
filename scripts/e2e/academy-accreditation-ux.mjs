// Photographs the academy accreditation screens (#806) from the real app at phone, tablet and desktop widths, light and dark, with real data created through the API.
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir /tmp/e2e-dist
//   E2E_DATABASE_URL=postgres://root@/sportarena_e2e?host=/var/run/postgresql UX_SHOTS=docs/ux node scripts/e2e/academy-accreditation-ux.mjs
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
const PREFIX = 'accreditation';
try {
  const owner = await reg('acc_owner', 'Priya Nair', ['organizer']), coach = await reg('acc_coach', 'Alex Lee', ['coach']), auditor = await reg('acc_auditor', 'Dev Rao', ['athlete']), inspector = await reg('acc_inspector', 'Carlos Mendes', ['coach']);
  const org = await call('POST', '/organisations', { token: owner.token, body: { name: 'Riverside Academy', kind: 'academy', city: 'Pune' } });
  for (const [u, role] of [[coach, 'coach'], [auditor, 'auditor']]) { await call('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }); await call('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }); }
  const db = new pg.Pool({ connectionString: DB });
  const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  // evidence that already exists in the compliance engine and credentials
  const req = (await db.query("INSERT INTO comp_requirements(scope_kind, scope_id, code, name, category, subject_kind, method, created_by) VALUES ('organisation',$1,'premises_safety','Premises safety certificate','licence','organisation','evidence',$2) RETURNING id", [org.id, owner.id])).rows[0];
  await db.query("INSERT INTO comp_records(requirement_id, requirement_version, subject_kind, subject_id, status, expires_on, submitted_by) VALUES ($1,1,'organisation',$2,'valid',$3,$4)", [req.id, org.id, inDays(200), owner.id]);
  await db.query("INSERT INTO credentials(user_id, organisation_id, kind, title, code, issued_by, expires_on) VALUES ($1,$2,'certificate','Level 3 coaching certificate',$3,$4,$5)", [coach.id, org.id, `acc_${stamp}`, owner.id, inDays(400)]);
  const fw = await call('POST', `/organisations/${org.id}/academy/accreditation-frameworks`, { token: owner.token, body: { name: 'Coaching Centre Accreditation', body_name: 'National Tennis Federation', kind: 'coaching_standard', level: 'Level 3', owner_id: coach.id, next_due_on: inDays(40), requirements: [{ title: 'Coach qualification certificates', evidence_kind: 'coach_credentials' }, { title: 'Premises safety certificate', evidence_kind: 'facility', comp_requirement_id: req.id }, { title: 'Safeguarding policy', evidence_kind: 'policy' }] } });
  await call('POST', `/organisations/${org.id}/academy/accreditation-frameworks`, { token: owner.token, body: { name: 'Safety and Safeguarding Standard', body_name: 'National Sports Council', kind: 'safeguarding', expires_on: inDays(-6), requirements: [{ title: 'Child protection policy', evidence_kind: 'policy' }] } });
  const au = await call('POST', `/academy/accreditation-frameworks/${fw.id}/audits`, { token: owner.token, body: { kind: 'on_site', scheduled_on: inDays(10), starts_at: '09:00', ends_at: '17:00', venue_name: 'Main campus', scope: ['coaches', 'premises', 'safeguarding'], inspector_id: inspector.id } });
  const f1 = await call('POST', `/academy/audits/${au.id}/findings`, { token: owner.token, body: { severity: 'high', title: 'Safeguarding policy is last year\'s version', detail: 'The 2025 policy is on file. The current year version signed by lead coaches is required.', actions: [{ title: 'Upload the signed 2026 policy', owner_id: coach.id, due_on: inDays(20) }, { title: 'Refresher for all coaching staff', due_on: inDays(20) }] } });
  await call('POST', `/academy/audits/${au.id}/findings`, { token: owner.token, body: { severity: 'medium', title: 'Emergency action plan not signed off', actions: [{ title: 'Obtain the safety officer signature', due_on: inDays(-2) }] } });
  await call('POST', `/academy/audits/${au.id}/decision`, { token: inspector.token, body: { decision: 'conditional_pass', score: 71, resubmit_by: inDays(30), summary: 'Close, but not yet.' } });
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
  const desk = async (p, id = org.id) => { await navTo(p, 'Org', { id }); await click(p, 'Academy'); await click(p, 'Accreditation'); };
  const openFw = async (p) => { await desk(p); await click(p, 'Frameworks'); await click(p, 'Coaching Centre Accreditation'); };
  const openAudit = async (p) => { await desk(p); await click(p, 'Audits'); await click(p, 'Coaching Centre Accreditation'); };
  const SIZES = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1280, height: 900 } };
  const checks = [];
  const shot = async (name, size, fn, { who = owner, dark = false, full = false, expect = [] } = {}) => {
    const page = await open(SIZES[size], who, dark);
    try {
      await fn(page);
      for (const text of expect) { if (!(await page.getByText(text).first().isVisible().catch(() => false))) throw new Error(`expected to see "${text}"`); }
      await page.screenshot({ path: path.join(OUT, `${PREFIX}-${name}-${size}${dark ? '-dark' : ''}.png`), fullPage: full }); log(`PASS  ${name} ${size}${dark ? ' dark' : ''}`);
    } catch (e) { failures++; log(`FAIL  ${name} ${size}: ${e.message.split('\n')[0]}`); await page.screenshot({ path: `/tmp/acc-fail-${name}-${size}.png` }); }
    await page.context().close();
  };
  for (const size of ['phone', 'tablet', 'desktop']) {
    const full = size === 'phone';
    await shot('1-overview', size, desk, { full, expect: ['Framework health', 'Upcoming audits'] });
    await shot('2-frameworks', size, async (p) => { await desk(p); await click(p, 'Frameworks'); }, { full, expect: ['Safety and Safeguarding Standard'] });
    await shot('3-evidence', size, async (p) => { await openFw(p); await click(p, 'Evidence'); }, { full, expect: ['Required evidence', 'Premises safety certificate'] });
    await shot('4-link-sheet', size, async (p) => { await openFw(p); await click(p, 'Evidence'); await click(p, 'Link evidence'); }, { expect: ['Search compliance records and credentials'] });
    await shot('5-configure', size, async (p) => { await desk(p); await click(p, 'Frameworks'); await click(p, 'Configure'); }, { expect: ['Accrediting body'] });
    await shot('6-audits', size, async (p) => { await desk(p); await click(p, 'Audits'); }, { full, expect: ['Coaching Centre Accreditation'] });
    await shot('7-findings', size, openAudit, { full, expect: ['F-001 · Safeguarding policy is last year\'s version'] });
    await shot('8-finding-sheet', size, async (p) => { await openAudit(p); await click(p, 'Record finding'); }, { expect: ['Severity'] });
    await shot('9-signoff', size, async (p) => { await openAudit(p); await click(p, 'Sign-off'); }, { full, expect: ['Inspector sign-off'] });
    await shot('10-decision-sheet', size, async (p) => { await openAudit(p); await click(p, 'Sign-off'); await click(p, 'Record decision'); }, { expect: ['Decision'] });
    await shot('11-history', size, async (p) => { await desk(p); await click(p, 'History'); }, { full, expect: ['Decision trail', 'Locked'] });
    await shot('12-empty', size, (p) => desk(p, bare.id), { expect: ['No frameworks yet'] });
    await shot('13-auditor', size, desk, { who: auditor, full, expect: ['Framework health'] });
    await shot('14-inspector', size, (p) => navTo(p, 'AcademyAudits'), { who: inspector, expect: ['Audits assigned to me'] });
  }
  await shot('1-overview', 'tablet', desk, { dark: true });
  await shot('7-findings', 'phone', openAudit, { dark: true, full: true });
  await browser.close();
} catch (e) { failures++; log('ERROR', e); }
api.kill(); web.close();
log(failures ? `${failures} failure(s)` : 'all accreditation screens photographed');
process.exit(failures ? 1 : 0);
