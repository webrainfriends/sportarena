// Browser-driven check of sponsor collaboration (#306): tasks, assignment, internal vs shared, notes, escalation. Phone, tablet and desktop.
// Needs: a throwaway Postgres database (E2E_DATABASE_URL; it is migrated, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright-core (`npm i --no-save playwright-core`) with a Chromium (E2E_CHROMIUM, default the pre-installed one).
// It starts the API and a tiny static+proxy server itself. Run: node scripts/e2e/sponsorship-collaboration-journey.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
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
const call = async (method, p, { token, body } = {}) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return r.json().catch(() => ({})); };
const reg = async (h, roles) => { const r = await call('POST', '/auth/register', { body: { handle: h, display_name: h, email: `${h}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); return { ...r.user, token: r.token, email: `${h}@example.com` }; };
const db = new pg.Pool({ connectionString: E.DATABASE_URL });
const sql = async (q) => (await db.query(q)).rows;
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const iso = (d) => d.toISOString().slice(0, 10);
const plus = (days) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d; };
try {
  const suffix = Date.now().toString(36);
  const sponsor = await reg(`cosp${suffix}`, ['sponsor']), ath = await reg(`coath${suffix}`, ['athlete']);
  const brand = await call('POST', '/sponsors', { token: sponsor.token, body: { name: 'Northwind Foods' } });
  await call('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } });
  const money = { kind: 'money', label: 'Monthly support', currency: 'SGD', amount_cents: 50000, cadence: 'monthly', first_due_on: iso(plus(10)), instalments: 6 };
  const deal = await call('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: brand.id, target_type: 'athlete', target_id: ath.id, deliverables: 'Wear the kit', starts_on: iso(plus(5)), ends_on: iso(plus(200)), lines: [money] } });
  await call('PATCH', `/sponsorships/${deal.id}`, { token: ath.token, body: { status: 'active', version: deal.terms_version } });
  await sql(`UPDATE users SET roles='{athlete,sponsor}' WHERE id='${ath.id}'`);
  const ref = (await sql(`SELECT agreement_ref FROM sponsorships WHERE id='${deal.id}'`))[0].agreement_ref;
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${r.status()} ${await r.text()}`);
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(2500);
    return { ctx, page };
  };
  const shot = (page, n) => page.screenshot({ path: `${OUT}${n}.png`, fullPage: false });
  const wait = (p, ms = 1500) => p.waitForTimeout(ms);
  const open = async (p) => { await p.getByText('More', { exact: true }).first().click(); await wait(p); const vp = p.viewportSize(); await p.mouse.click(vp.width / 2, Math.round(vp.height * 0.735)); await wait(p, 2000); const ws = p.getByText('Sponsor workspace'); if (await ws.count()) { await ws.first().click(); await wait(p); } await p.getByText(`Open agreement ${ref}`).first().click(); await wait(p); };
  const workspace = async (p) => { await p.getByText('More', { exact: true }).first().click(); await wait(p); const vp = p.viewportSize(); await p.mouse.click(vp.width / 2, Math.round(vp.height * 0.735)); await wait(p, 2000); const ws = p.getByText('Sponsor workspace'); if (await ws.count()) { await ws.first().click(); await wait(p); } };
  const toTasks = async (p) => { await p.getByText('Tasks & notes').first().scrollIntoViewIfNeeded(); await wait(p, 400); };
  const fillSheet = async (p, fields) => { for (const [label, value] of fields) { const f = p.getByLabel(label, { exact: false }).first(); await f.fill(value); } };

  // ---- 1. sponsor, phone: empty state, then add a task
  const { page: p } = await session(sponsor, { width: 390, height: 844 });
  await open(p); await toTasks(p); await shot(p, '01-empty');
  check(await p.getByText('No open tasks').first().isVisible(), 'empty state is explained');
  await p.getByText('Add the first task', { exact: true }).first().click(); await wait(p, 1200); await shot(p, '02-new-task-sheet');
  await p.getByLabel('What needs doing?', { exact: false }).first().fill('Chase the signed photo release'); await wait(p, 300);
  await shot(p, '03-new-task-filled');
  await p.getByText('Add task', { exact: true }).last().click(); await wait(p, 2000); await toTasks(p); await shot(p, '04-task-listed');
  check(await p.getByText('Chase the signed photo release').first().isVisible(), 'the task is listed');
  check((await sql(`SELECT count(*)::int AS n FROM sponsorship_tasks WHERE sponsorship_id='${deal.id}' AND visibility='internal' AND side='sponsor'`))[0].n === 1, 'stored as internal for the sponsor side');
  // ---- 2. a shared task via the API; the recipient sees it but not the brand's internal one, and cannot edit it
  const shared = await call('POST', '/sponsorship-tasks', { token: sponsor.token, body: { sponsorship_id: deal.id, title: 'Send the kit sizes', visibility: 'shared', due_on: iso(plus(-3)), assignee_id: sponsor.id } });
  await call('POST', '/sponsorship-notes', { token: sponsor.token, body: { task_id: shared.id, visibility: 'shared', body: 'Sizes by Friday please' } });
  await p.reload(); await wait(p, 2500); await open(p); await toTasks(p); await shot(p, '05-shared-overdue');
  check(await p.getByText(/^overdue$/i).first().isVisible(), 'an overdue task is flagged');
  await p.getByText('Escalate', { exact: true }).first().click(); await wait(p, 1000); await shot(p, '06-escalate-sheet');
  await p.getByText('Escalate now', { exact: true }).last().click(); await wait(p, 2000); await toTasks(p); await shot(p, '07-escalated');
  check(await p.getByText(/^escalated$/i).first().isVisible(), 'the escalation is shown');
  await p.getByText('Discussion & notes', { exact: true }).first().click(); await wait(p, 1200);
  await p.getByText('Write a note', { exact: true }).first().click(); await wait(p, 1000);
  await p.getByRole('textbox').last().fill('Agree the shoot plan before renewal'); await shot(p, '06b-agreement-note-sheet');
  await p.getByText('Add note', { exact: true }).last().click(); await wait(p, 2000); await shot(p, '06c-agreement-notes');
  check(await p.getByText('Agree the shoot plan before renewal').first().isVisible(), 'an agreement-level note is written and listed');
  await p.context().close();
  const { page: r } = await session(ath, { width: 390, height: 844 });
  await open(r); await toTasks(r); await shot(r, '08-recipient-view');
  check(await r.getByText('Send the kit sizes').first().isVisible(), 'the recipient sees the shared task');
  check(await r.getByText('Chase the signed photo release').count() === 0, 'the brand\'s internal task is invisible to the recipient');
  check(await r.getByText('Mark done', { exact: true }).count() === 0, 'a shared task of the other side cannot be changed');
  await r.getByText('Notes (1)', { exact: true }).first().click(); await wait(r, 1500); await shot(r, '09-notes-thread');
  check(await r.getByText('Sizes by Friday please').first().isVisible(), 'the shared discussion is readable');
  await r.context().close();
  // ---- 3. program discussion: the brand and one applicant, a private thread; an automatic expiry task; delivery status banner
  const prog = await call('POST', '/sponsorship-programs', { token: sponsor.token, body: { sponsor_id: brand.id, name: 'Youth fund', currency: 'USD', budget_cents: 100000, max_award_cents: 50000 } });
  const rnd = await call('POST', `/sponsorship-programs/${prog.id}/rounds`, { token: sponsor.token, body: { opens_on: iso(plus(-1)), closes_on: iso(plus(30)) } });
  await call('POST', `/sponsorship-programs/${prog.id}/status`, { token: sponsor.token, body: { status: 'published', version: prog.row_version } });
  const applicant = await reg(`coapp${suffix}`, ['athlete']);
  const application = await call('POST', `/program-rounds/${rnd.id}/applications`, { token: applicant.token, body: { requested_cents: 20000, pitch: 'Please back my season', target_type: 'athlete', target_id: applicant.id } });
  await sql(`UPDATE users SET roles='{athlete,sponsor}' WHERE id='${applicant.id}'`);
  const { page: b } = await session(sponsor, { width: 390, height: 844 });
  await workspace(b); await b.getByText('Run programs', { exact: true }).first().click(); await wait(b, 1500);
  await b.getByText('Youth fund').first().click(); await wait(b, 2000);
  await b.getByText('Messages', { exact: true }).first().scrollIntoViewIfNeeded(); await wait(b, 400); await shot(b, '11-program-application-card');
  await b.getByText('Messages', { exact: true }).first().click(); await wait(b, 1500);
  await b.getByText('Write a message', { exact: true }).first().click(); await wait(b, 1000);
  await b.getByRole('textbox').last().fill('Can you share your season calendar?');
  await b.getByText('Applicant too', { exact: true }).first().click(); await wait(b, 300); await shot(b, '12-brand-message-sheet');
  await b.getByText('Send', { exact: true }).last().click(); await wait(b, 2000); await shot(b, '13-brand-thread');
  check(await b.getByText('Can you share your season calendar?').first().isVisible(), 'the brand\'s message is in the thread');
  await b.context().close();
  const { page: ap } = await session(applicant, { width: 390, height: 844 });
  await workspace(ap); await ap.getByText('Sponsorship calls', { exact: true }).first().click(); await wait(ap, 2000);
  await ap.getByText('Messages', { exact: true }).first().scrollIntoViewIfNeeded(); await ap.getByText('Messages', { exact: true }).first().click(); await wait(ap, 1500); await shot(ap, '14-applicant-thread');
  check(await ap.getByText('Can you share your season calendar?').first().isVisible(), 'the applicant sees the brand\'s message');
  check(await ap.getByText(/Other applicants cannot/).first().isVisible(), 'the applicant is told who can see it');
  await ap.context().close();
  // an automatic expiry task appears once the term is close, dated and assigned
  await sql(`UPDATE sponsorships SET ends_on = current_date + 45 WHERE id='${deal.id}'`);
  process.env.DATABASE_URL = E.DATABASE_URL; process.env.SPORTARENA_MASTER_KEY = E.SPORTARENA_MASTER_KEY; process.env.SPORTARENA_JWT_SECRET = E.SPORTARENA_JWT_SECRET;
  const { ensureExpiryTasks } = await import('../../apps/api/src/sponsor-collaboration.js');
  check(await ensureExpiryTasks() === 2, 'one automatic expiry task per side');
  const { page: e } = await session(sponsor, { width: 390, height: 844 });
  await open(e); await toTasks(e); await shot(e, '15-automatic-expiry-task');
  check(await e.getByText('Decide whether to renew this agreement').first().isVisible(), 'the automatic expiry task is listed');
  check(await e.getByText(/^added automatically$/i).first().isVisible(), 'it is labelled as automatic');
  check(await e.getByText(/Reminders are delayed/).count() === 0, 'no warning while the background service is beating (the API runs it in-process here)');
  check(await e.getByText(/Email reminders are not set up/).first().isVisible(), 'unconfigured email is stated plainly');
  await e.context().close();
  // ---- 4. tablet and desktop
  for (const [n, vp] of [['tablet', { width: 820, height: 1100 }], ['desktop', { width: 1280, height: 900 }]]) {
    const { page: w } = await session(sponsor, vp); await open(w); await toTasks(w); await shot(w, `10-${n}`);
    check(await w.getByText('Tasks & notes').first().isVisible(), `${n}: tasks & notes is visible`);
    await w.context().close();
  }
  await browser.close();
} catch (e) { console.error(e); failures++; }
finally { api.kill(); web.close(); await db.end(); log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0); }
