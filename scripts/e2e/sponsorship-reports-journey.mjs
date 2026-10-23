// Browser-driven check of the sponsorship reports journey (#305): phone, tablet and desktop; ageing, funnel, outcomes, fulfilment, renewals,
// saved filters, scheduled delivery, export, the empty state and the denied state.
// Needs: a throwaway Postgres database (E2E_DATABASE_URL; it is migrated, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright-core (`npm i --no-save playwright-core`) with a Chromium (E2E_CHROMIUM, default the pre-installed one).
// It starts the API and a tiny static+proxy server itself. Run: node scripts/e2e/sponsorship-reports-journey.mjs
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
const call = async (method, p, { token, body } = {}) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p} ${r.status} ${JSON.stringify(j)}`); return j; };
const reg = async (h, roles) => { const r = await call('POST', '/auth/register', { body: { handle: h, display_name: h, email: `${h}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); return { ...r.user, token: r.token, email: `${h}@example.com` }; };
const db = new pg.Pool({ connectionString: E.DATABASE_URL });
const sql = async (q, p) => (await db.query(q, p)).rows;
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const iso = (d) => d.toISOString().slice(0, 10);
const plus = (days) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d; };
try {
  const sponsor = await reg('rpsponsor', ['sponsor']), ath = await reg('rpathlete', ['athlete']), ath2 = await reg('rpathlete2', ['athlete']), newbie = await reg('rpnewbie', ['sponsor']), coach = await reg('rpcoach', ['coach']), nobrand = await reg('rpnobrand', ['sponsor']);
  await sql("UPDATE users SET roles='{athlete,sponsor}' WHERE handle='rpathlete'"); // so the Sponsors workspace shows for the beneficiary
  const brand = await call('POST', '/sponsors', { token: sponsor.token, body: { name: 'Northwind Foods' } });
  await call('POST', '/sponsors', { token: newbie.token, body: { name: 'Fresh Start Co' } });
  for (const [a, n] of [[ath, 'Priya Nair'], [ath2, 'Tom Alvarez']]) { await call('POST', '/me/sponsorship-profile', { token: a.token, body: { open_to_sponsors: true } }); await sql('UPDATE users SET display_name=$2 WHERE id=$1', [a.id, n]); }
  // a real agreement: three monthly instalments (one paid and confirmed, one reported but unconfirmed, two overdue) plus goods with an estimate and an endorsement
  const deal = await call('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: brand.id, target_type: 'athlete', target_id: ath.id, deliverables: 'Wear the kit', starts_on: iso(plus(1)), ends_on: iso(plus(85)), lines: [
    { kind: 'money', label: 'Monthly support', currency: 'SGD', amount_cents: 120000, cadence: 'monthly', instalments: 3, first_due_on: iso(plus(20)) },
    { kind: 'goods', label: 'Training kit', quantity: 20, currency: 'SGD', estimate_cents: 450000, first_due_on: iso(plus(20)) },
    { kind: 'endorsement', label: 'Social posts', promoter: 'recipient', currency: 'SGD', estimate_cents: 90000, first_due_on: iso(plus(25)) }] } });
  await call('PATCH', `/sponsorships/${deal.id}`, { token: ath.token, body: { status: 'active', version: deal.terms_version } });
  const ob = (await call('GET', '/sponsorship-obligations', { token: sponsor.token, query: undefined })).obligations;
  const money = ob.filter((o) => o.kind === 'money').sort((a, b) => a.due_on.localeCompare(b.due_on));
  const pay = (o, ref, cents) => call('POST', `/sponsorship-obligations/${o.id}/payments`, { token: sponsor.token, body: { amount_cents: cents, currency: 'SGD', method: 'bank_transfer', reference: ref, paid_on: iso(plus(0)) } });
  const p1 = await pay(money[0], 'BANK-001', 120000); await call('PATCH', `/sponsorship-payments/${p1.id}`, { token: ath.token, body: { status: 'confirmed' } });
  await pay(money[1], 'BANK-002', 50000);
  await sql('UPDATE sponsorship_obligations SET due_on=$2 WHERE id=$1', [money[1].id, iso(plus(-40))]);
  await sql('UPDATE sponsorship_obligations SET due_on=$2 WHERE id=$1', [money[2].id, iso(plus(-8))]);
  await sql("UPDATE sponsorship_payments SET created_at = now() - interval '10 days' WHERE reference='BANK-002'");
  const goods = ob.find((o) => o.kind === 'goods'); await sql('UPDATE sponsorship_obligations SET due_on=$2 WHERE id=$1', [goods.id, iso(plus(-3))]);
  // a funding program with one application, one offer
  let prog = await call('POST', '/sponsorship-programs', { token: sponsor.token, body: { sponsor_id: brand.id, name: 'Rising Stars Fund', currency: 'SGD', budget_cents: 1000000, max_award_cents: 500000 } });
  const rd = await call('POST', `/sponsorship-programs/${prog.id}/rounds`, { token: sponsor.token, body: { opens_on: iso(plus(-1)), closes_on: iso(plus(30)) } });
  prog = await call('POST', `/sponsorship-programs/${prog.id}/status`, { token: sponsor.token, body: { status: 'published', version: prog.row_version } });
  for (const [a, cents] of [[ath, 300000], [ath2, 200000]]) await call('POST', `/program-rounds/${rd.id}/applications`, { token: a.token, body: { target_type: 'athlete', target_id: a.id, requested_cents: cents, pitch: 'Please back me' } });

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: true }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${r.status()} ${await r.text()}`);
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(2500);
    return { ctx, page };
  };
  const wait = (p, ms = 1500) => p.waitForTimeout(ms);
  const shot = async (p, n, scrolls = 0) => { await p.screenshot({ path: `${OUT}${n}.png` });
    for (let i = 1; i <= scrolls; i++) { await p.mouse.move(p.viewportSize().width / 2, p.viewportSize().height / 2); await p.mouse.wheel(0, p.viewportSize().height * 0.8); await wait(p, 600); await p.screenshot({ path: `${OUT}${n}-scroll${i}.png` }); } };
  const openReports = async (p) => {
    await p.getByText('More', { exact: true }).first().click(); await wait(p); const vp = p.viewportSize(); await p.mouse.click(vp.width / 2, Math.round(vp.height * 0.735)); await wait(p, 2000);
    const ws = p.getByText('Sponsor workspace'); if (await ws.count()) { await ws.first().click(); await wait(p); }
    await p.getByText('Reports', { exact: true }).first().click(); await wait(p, 2500);
  };
  const tab = async (p, name) => { await p.getByText(name, { exact: true }).first().click(); await wait(p, 1800); };
  const vis = async (p, t) => (await p.getByText(t).count()) > 0;

  // ---- 1. sponsor, phone: ageing
  const { page: p } = await session(sponsor, { width: 390, height: 844 });
  await openReports(p);
  check(await vis(p, 'Sponsorship reports'), 'the reports screen opens');
  check(await vis(p, /Cash outstanding/), 'cash outstanding is shown');
  check(await vis(p, /Estimates, not cash/), 'estimates are shown apart from cash');
  await p.getByText('Reconciles to source').first().scrollIntoViewIfNeeded().catch(() => {});
  check(await vis(p, /reconciles to source/i), 'the report states it reconciles to source');
  check(await vis(p, /Payment confirmations/), 'the stale unconfirmed payment is flagged as a data source issue');
  await shot(p, '02-ageing-phone', 4);
  // ---- 2. other reports
  await tab(p, 'Funnel'); await shot(p, '03-funnel-phone'); check(await vis(p, 'Rising Stars Fund'), 'funnel lists the program');
  await tab(p, 'Outcomes'); await shot(p, '04-outcomes-phone'); check(await vis(p, /not shared/i), 'outcomes shows consent is missing, not data');
  await tab(p, 'Fulfilment'); await shot(p, '05-fulfilment-phone'); check(await vis(p, 'Training kit'), 'fulfilment lists the goods due');
  await tab(p, 'Renewals'); await shot(p, '06-renewals-phone'); check(await vis(p, /Days left/), 'renewals lists the ending agreement');
  await tab(p, 'Ageing');
  // ---- 3. save a filter, schedule it
  await p.getByText('Save these filters', { exact: true }).first().click(); await wait(p, 1000); await shot(p, '07-save-filter-sheet');
  await p.getByPlaceholder('e.g. Monthly ageing, all brands').fill('Monthly ageing'); await p.getByText('Save filter', { exact: true }).last().click(); await wait(p, 2000);
  check(await vis(p, 'Monthly ageing'), 'the saved filter appears as a chip');
  await p.getByText('Schedule delivery', { exact: true }).first().click(); await wait(p, 1000); await shot(p, '08-schedule-sheet');
  await p.getByText('Schedule', { exact: true }).last().click(); await wait(p, 2000);
  check((await sql('SELECT count(*)::int AS n FROM sponsor_report_schedules'))[0].n === 1, 'a schedule was created');
  await shot(p, '09-after-schedule', 2);
  // ---- 4. export downloads
  const [dl] = await Promise.all([p.waitForEvent('download'), p.getByText('CSV', { exact: true }).first().click()]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  check(/outstanding_cents/.test(csv) && /Training kit/.test(csv), 'CSV downloads with cash and estimate rows');
  const [dx] = await Promise.all([p.waitForEvent('download'), p.getByText('XLSX', { exact: true }).first().click()]);
  check(fs.readFileSync(await dx.path()).subarray(0, 2).toString() === 'PK', 'XLSX downloads');
  const [dp] = await Promise.all([p.waitForEvent('download'), p.getByText('Branded PDF', { exact: true }).first().click()]);
  check(fs.readFileSync(await dp.path()).subarray(0, 4).toString() === '%PDF', 'PDF downloads');
  await p.context().close();
  // ---- 5. tablet and desktop
  for (const [n, vp] of [['tablet', { width: 820, height: 1100 }], ['desktop', { width: 1280, height: 900 }]]) {
    const { page: w } = await session(sponsor, vp); await openReports(w); await shot(w, `10-ageing-${n}`); await tab(w, 'Fulfilment'); await shot(w, `11-fulfilment-${n}`);
    check(await vis(w, /Cash and estimates|cash and estimates separate/), `${n}: basis line is visible`);
    await w.context().close();
  }
  // ---- 6. empty state (a brand with nothing yet), recipient view, denied
  const { page: e } = await session(newbie, { width: 390, height: 844 });
  await openReports(e); await shot(e, '12-empty-state'); check(await vis(e, 'Nothing to report yet'), 'empty state is explained');
  await e.context().close();
  const { page: dn } = await session(nobrand, { width: 390, height: 844 });
  await openReports(dn); await shot(dn, '14-no-brand-recipient-default'); await dn.getByText('Brands I run', { exact: true }).first().click(); await wait(dn, 1500); await shot(dn, '15-denied'); check(await vis(dn, 'No access'), 'a sponsor with no brand role sees a clear denied state');
  await dn.context().close();
  const { page: r } = await session(ath, { width: 390, height: 844 });
  await openReports(r); await r.getByText('I am the beneficiary', { exact: true }).first().click(); await wait(r, 2000); await shot(r, '13-recipient-view');
  check(await vis(r, /Cash outstanding/), 'the athlete sees their own agreements');
  await r.context().close();
  check((await call('GET', '/sponsorship-reports/ageing', { token: coach.token }).then(() => false, (er) => /403/.test(er.message))), 'a person with no brand role is denied by the server');
  await browser.close();
} catch (e) { console.error(e); failures++; }
finally { api.kill(); web.close(); await db.end(); log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0); }
