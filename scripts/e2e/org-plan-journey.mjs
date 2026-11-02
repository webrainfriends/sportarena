// Browser-driven check of plan enforcement for organisations (umbrella organisation, academies, teams, staff seats) and the platform review of new
// organisations, on phone, tablet and desktop. All data is created through the public API; nothing is seeded.
// Needs: a throwaway Postgres database (E2E_DATABASE_URL, migrated, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright with a Chromium (E2E_CHROMIUM). Run: node scripts/e2e/org-plan-journey.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import pg from 'pg';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.E2E_PLAYWRIGHT ?? 'playwright');
const E = { DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sportarena_e2e', SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'),
  PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'on', PLATFORM_ADMIN_EMAILS: 'rraja.edge@gmail.com,rrajas1978@icloud.com', RATE_LIMIT_DISABLED: 'true' };
const OUT = (process.env.E2E_SHOTS ?? '/tmp/e2e-shots') + '/'; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const api = spawn('node', ['src/server.js'], { cwd: new URL('../../apps/api/', import.meta.url).pathname, env: { ...process.env, ...E }, stdio: ['ignore', 'pipe', 'pipe'] });
api.stdout.on('data', (d) => process.env.V && log('[api]', String(d).trim())); api.stderr.on('data', (d) => process.env.V && log('[api!]', String(d).trim()));
for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:4000/api/v1/payments/methods')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
const DIST = process.env.E2E_DIST ?? '/tmp/e2e-dist';
const web = http.createServer((req, res) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/mcp')) { const p = http.request({ host: '127.0.0.1', port: 4000, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); req.pipe(p); return; }
  let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  const ext = path.extname(f); res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf' }[ext] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4100, r));
const B = 'http://localhost:4100/api/v1';
const call = async (method, p, { token, body, expect } = {}) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (expect ? r.status !== expect : r.status >= 300) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j)}`); return { status: r.status, ...j }; };
const reg = async (h, name, email = `${h}@example.com`) => { const r = await call('POST', '/auth/register', { body: { handle: h, display_name: name, email, password: 'correct-horse-battery', roles: ['organizer'] } }); return { token: r.token, id: r.user.id, handle: h, email }; };
const db = new pg.Pool({ connectionString: E.DATABASE_URL });
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const wait = (p, ms = 1200) => p.waitForTimeout(ms);
try {
  const admin = await reg('plan_admin', 'Platform Admin', 'rraja.edge@gmail.com'); await db.query("UPDATE users SET roles='{athlete,admin,platform_admin}' WHERE id=$1", [admin.id]);
  const owner = await reg('plan_owner', 'Priya Nair');
  const org = (await call('POST', '/organisations', { token: owner.token, body: { name: 'Harbour Sports Group', kind: 'company', city: 'Pune' } }));
  check(org.approval_status === 'pending', 'a new organisation is pending platform review');
  const blocked = await call('POST', '/teams', { token: owner.token, expect: 409, body: { name: 'Harbour U12', sport: 'football', organisation_id: org.id } });
  check(blocked.error?.code === 'pending_approval', 'nothing but the profile is open while it is pending');
  // the platform admin defines a plan with limits and approves the organisation
  await call('POST', '/admin/commercial/products', { token: admin.token, body: { key: 'org_umbrella', name: 'Umbrella', family: 'other' } });
  await call('POST', '/admin/commercial/plans', { token: admin.token, body: { product_key: 'org_umbrella', key: 'umbrella_pro', name: 'Umbrella Pro', eligible_actors: ['organisation'] } });
  const v = await call('POST', '/admin/commercial/plans/umbrella_pro/versions', { token: admin.token, body: { billing_interval: 'monthly', effective_from: '2026-01-01', amount_minor: 249900, entitlements: [{ key: 'academies', limit_value: 2 }, { key: 'teams', limit_value: 4 }, { key: 'staff_seats', limit_value: 5 }] } });
  await call('POST', `/admin/commercial/versions/${v.id}/publish`, { token: admin.token });
  await call('POST', `/admin/commercial/organisations/${org.id}/decision`, { token: admin.token, body: { decision: 'approve' } });
  await call('POST', '/admin/commercial/subscriptions', { token: admin.token, body: { subject_type: 'organisation', subject_id: org.id, plan_key: 'umbrella_pro', mark_paid: true } });
  const a1 = await call('POST', '/organisations', { token: owner.token, body: { name: 'Harbour Football Academy', kind: 'academy', parent_organisation_id: org.id, academy: { sports: ['football'], focus: 'development' } } });
  check(a1.approval_status === 'pending' && a1.parent_organisation_id === org.id, 'an academy under the umbrella starts pending');
  await call('POST', '/teams', { token: owner.token, body: { name: 'Harbour U12', sport: 'football', organisation_id: org.id } });
  const coach = await reg('plan_coach', 'Alex Lee'); await call('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: coach.handle, role: 'coach' } });
  await call('POST', '/organisations', { token: owner.token, body: { name: 'Harbour Tennis Academy', kind: 'academy', parent_organisation_id: org.id } });
  const over = await call('POST', '/organisations', { token: owner.token, expect: 402, body: { name: 'Harbour Cricket Academy', kind: 'academy', parent_organisation_id: org.id } });
  check(over.error?.code === 'limit_reached', 'the third academy is refused by the plan');
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${r.status()} ${await r.text()}`);
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(5000);
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
        while (todo.length && !window.__nav) { const n = todo.pop(); const v = n.memoizedProps?.value; if (v && typeof v.push === 'function' && typeof v.goTab === 'function' && v.tab === undefined) { window.__nav = v; break; } if (n.sibling) todo.push(n.sibling); if (n.child) todo.push(n.child); }
      }
      if (!window.__nav) throw new Error('navigator not found');
      window.__nav.push(name, params);
    }, { name, params });
    await wait(p, 2200);
  };
  const VIEWS = [['phone', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }], ['desktop', { width: 1366, height: 900 }]];
  for (const [name, viewport] of VIEWS) {
    // the owner: plan and usage on the umbrella organisation
    const o = await session(owner, viewport);
    await navTo(o.page, 'Org', { id: org.id });
    check(await vis(o.page, 'Plan & usage'), `${name}: the owner sees plan and usage`);
    check(await vis(o.page, '2 of 2 used'), `${name}: academies used against the plan`);
    await shot(o.page, `01-plan-usage-${name}`);
    // a pending academy: the banner explains what is allowed
    const aid = (await db.query("SELECT id FROM organisations WHERE name='Harbour Football Academy'")).rows[0].id;
    await navTo(o.page, 'Org', { id: aid });
    check(await vis(o.page, 'Waiting for platform review'), `${name}: a pending academy shows the review banner`);
    await shot(o.page, `02-pending-academy-${name}`);
    // the wizard: an academy under the umbrella
    await navTo(o.page, 'Orgs');
    await o.page.getByText('Create an organisation').last().click(); await wait(o.page, 1200);
    await o.page.getByText('Academy', { exact: true }).last().click(); await wait(o.page, 800);
    check(await vis(o.page, 'Umbrella organisation'), `${name}: the wizard offers the umbrella organisation for an academy`);
    await shot(o.page, `03-wizard-academy-${name}`);
    await o.ctx.close();
    // the platform admin: approvals queue and which limits are defined
    const a = await session(admin, viewport);
    await navTo(a.page, 'CommercialConsole');
    await a.page.getByText('Approvals', { exact: true }).last().click(); await wait(a.page, 1800);
    check(await vis(a.page, 'Harbour Football Academy'), `${name}: the admin sees the academy in the review queue`);
    await shot(a.page, `04-approvals-${name}`);
    await a.ctx.close();
  }
  await browser.close();
} catch (e) { failures++; log('FAIL ', e.stack ?? e); }
api.kill(); web.close(); await db.end();
log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0);
