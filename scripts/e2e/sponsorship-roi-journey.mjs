// Browser-driven check of the sponsorship ROI & portfolio intelligence journey (#519): phone, tablet and desktop; the brand's portfolio, exposure,
// deliverables, estimate, renewal pack, comparison, valuation and reports, and the beneficiary's inventory, deliverables and provider figures.
// Needs: a throwaway Postgres database (E2E_DATABASE_URL; it is migrated, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright (or playwright-core) with a Chromium (E2E_CHROMIUM, default the pre-installed one).
// It starts the API and a tiny static+proxy server itself. Run: node scripts/e2e/sponsorship-roi-journey.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import pg from 'pg';
const require = createRequire(import.meta.url);
const { chromium } = (() => { for (const m of ['playwright-core', 'playwright', '/opt/node-tools/node_modules/playwright']) { try { return require(m); } catch { /* try the next */ } } throw new Error('install playwright-core'); })();
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
const call = async (method, p, { token, body, query } = {}) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p} ${r.status} ${JSON.stringify(j)}`); return j; };
const reg = async (h, roles) => { const r = await call('POST', '/auth/register', { body: { handle: h, display_name: h, email: `${h}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); return { ...r.user, token: r.token, email: `${h}@example.com` }; };
const db = new pg.Pool({ connectionString: E.DATABASE_URL });
const sql = async (q, p) => (await db.query(q, p)).rows;
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const iso = (d) => d.toISOString().slice(0, 10);
const plus = (days) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d; };
try {
  const org = await reg('roiorganiser', ['organizer', 'sponsor']), brandOwner = await reg('roibrand', ['sponsor']), stranger = await reg('roistranger', ['sponsor']);
  const ev = await call('POST', '/events', { token: org.token, body: { name: 'Harbour Cup', sport: 'football', city: 'Mumbai' } });
  await call('PATCH', `/events/${ev.id}`, { token: org.token, body: { status: 'open' } });
  const brand = await call('POST', '/sponsors', { token: brandOwner.token, body: { name: 'Northwind Foods' } });
  const money = (cur, cents) => ({ kind: 'money', label: 'Partnership fee', currency: cur, amount_cents: cents, cadence: 'monthly', first_due_on: iso(plus(45)), instalments: 4 });
  const mk = async (lines) => { const d = await call('POST', '/sponsorships', { token: brandOwner.token, body: { sponsor_id: brand.id, target_type: 'event', target_id: ev.id, deliverables: 'Title partnership', starts_on: iso(plus(40)), ends_on: iso(plus(300)), lines } }); await call('PATCH', `/sponsorships/${d.id}`, { token: org.token, body: { status: 'active', version: d.terms_version } }); await sql('UPDATE sponsorships SET starts_on=$2, ends_on=$3 WHERE id=$1', [d.id, iso(plus(-30)), iso(plus(60))]); return d; };
  const dealA = await mk([money('SGD', 400000)]), dealB = await mk([money('SGD', 150000)]);
  const dueA = (await sql("SELECT id FROM sponsorship_obligations WHERE sponsorship_id=$1 AND kind='money' ORDER BY seq LIMIT 1", [dealA.id]))[0].id;
  const pay = await call('POST', `/sponsorship-obligations/${dueA}/payments`, { token: brandOwner.token, body: { amount_cents: 100000, currency: 'SGD', method: 'bank_transfer', reference: 'TT-ROI-1', paid_on: iso(plus(-1)) } });
  await call('PATCH', `/sponsorship-payments/${pay.id}`, { token: org.token, body: { status: 'confirmed' } });
  // inventory and bookings
  const unit = (body) => call('POST', '/sponsor-inventory', { token: org.token, body: { target_type: 'event', target_id: ev.id, ...body } });
  const title = await unit({ kind: 'title_partner', name: 'Title partner', capacity: 1 }), overlay = await unit({ kind: 'livestream_overlay', name: 'Match-day overlay', capacity: 2, exclusive_category: true }), board = await unit({ kind: 'leaderboard', name: 'Leaderboard', capacity: 3 });
  const bk = (u, d, category) => call('POST', `/sponsor-inventory/${u.id}/bookings`, { token: org.token, body: { sponsorship_id: d.id, category, starts_on: iso(plus(-10)), ends_on: iso(plus(50)) } });
  const bTitle = await bk(title, dealA, 'beverage'); await bk(overlay, dealA, 'beverage'); await bk(board, dealB, 'nutrition');
  await call('POST', `/events/${ev.id}/sponsor-placements`, { token: org.token, body: { sponsorship_id: dealA.id, slot: 'title_partner', booking_id: bTitle.id, cta_label: 'Visit Northwind', cta_url: 'https://northwind.example' } });
  for (let i = 0; i < 6; i++) await call('GET', `/public/events/${ev.id}`);
  const pl = (await sql('SELECT id FROM event_sponsor_placements LIMIT 1'))[0].id; await call('POST', `/public/placements/${pl}/click`); await call('POST', `/public/placements/${pl}/click`);
  for (let i = 1; i <= 3; i++) await call('POST', `/sponsorships/${dealA.id}/exposure-signals`, { token: org.token, body: { metric: 'attendance', day: iso(plus(-i)), value: 800 * i, source: 'Gate system', source_ref: `Gate report ${i}` } });
  // broadcast reach is recorded once, in media rights, against a licence deliverable that names the sponsorship (gated by the overlay booking)
  const pu = await reg('roibroadcast', ['organizer']);
  const morg = await call('POST', '/organisations', { token: pu.token, body: { name: 'Harbour Broadcast', kind: 'company' } });
  const mpart = await call('POST', '/media/partners', { token: pu.token, body: { organisation_id: morg.id, kind: 'broadcaster' } });
  const pkg = await call('POST', `/events/${ev.id}/media/packages`, { token: org.token, body: { name: 'Harbour Cup rights', rights: ['live_video', 'highlights'], valid_from: new Date(Date.now() - 864e5).toISOString(), valid_to: new Date(Date.now() + 60 * 864e5).toISOString() } });
  const lic0 = await call('POST', `/media/packages/${pkg.id}/licences`, { token: org.token, body: { partner_id: mpart.id, approved_rights: ['live_video', 'highlights'], effective_from: new Date(Date.now() - 864e5).toISOString(), effective_to: new Date(Date.now() + 30 * 864e5).toISOString(), fee_minor: 500000, currency: 'USD' } });
  const lic = await call('POST', `/media/licences/${lic0.id}/decision`, { token: pu.token, body: { action: 'accept', row_version: lic0.row_version } });
  const mdl = await call('POST', `/media/licences/${lic.id}/deliverables`, { token: org.token, body: { kind: 'graphic_overlay', title: 'Sponsor overlay in every game', due_at: new Date(Date.now() + 2 * 864e5).toISOString(), sponsorship_id: dealA.id } });
  await call('POST', `/media/licences/${lic.id}/measurements`, { token: pu.token, body: { metric: 'views', value: 4200, period_start: new Date(Date.now() - 3 * 864e5).toISOString(), period_end: new Date(Date.now() - 864e5).toISOString(), source_name: 'StreamCo', source_ref: 'StreamCo weekly report 12', deliverable_id: mdl.id } });
  // deliverables: one accepted, one overdue, one awaiting review
  const dl = (body) => call('POST', `/sponsorships/${dealA.id}/deliverables`, { token: org.token, body });
  const d1 = await dl({ kind: 'appearance', title: 'Trophy presentation by the brand ambassador', owed_by: 'recipient', due_on: iso(plus(-2)), evidence_required: 'link' });
  const s1 = await call('POST', `/sponsorship-deliverables/${d1.id}/evidence`, { token: org.token, body: { url: 'https://photos.example/trophy', label: 'Photo album' } });
  await call('PATCH', `/sponsorship-deliverables/${d1.id}/review`, { token: brandOwner.token, body: { decision: 'accept', expected_rev: s1.rev } });
  const d2 = await dl({ kind: 'content', title: 'Highlights reel with sponsor end-card', owed_by: 'recipient', due_on: iso(plus(20)), evidence_required: 'file' }); await sql('UPDATE sponsorship_deliverables SET due_on=$2 WHERE id=$1', [d2.id, iso(plus(-5))]);
  const d3 = await dl({ kind: 'hospitality', title: 'Host ten guests in the hospitality lounge', owed_by: 'sponsor', due_on: iso(plus(15)), evidence_required: 'link' });
  await call('POST', `/sponsorship-deliverables/${d3.id}/evidence`, { token: brandOwner.token, body: { url: 'https://northwind.example/guest-list' } });
  const model = await call('POST', `/sponsors/${brand.id}/valuation-models`, { token: brandOwner.token, body: { name: 'Digital CPM', currency: 'SGD', basis_note: 'Our agency CPM for sports video, 2026 media plan', assumptions: { broadcast_views: { per: 1000, value_cents: 2500 }, placement_impressions: { per: 1000, value_cents: 1200 } } } });
  const rep = await call('POST', '/sponsorship-roi-reports', { token: brandOwner.token, body: { sponsorship_ids: [dealA.id, dealB.id], from: iso(plus(-30)), to: iso(plus(0)), valuation_version_id: model.versions[0].id } });

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
  const openRoi = async (p) => {
    await p.getByText('More', { exact: true }).first().click(); await wait(p); const vp = p.viewportSize(); await p.mouse.click(vp.width / 2, Math.round(vp.height * 0.735)); await wait(p, 2000);
    const ws = p.getByText('Sponsor workspace'); if (await ws.count()) { await ws.first().click(); await wait(p); }
    await p.getByText('ROI & exposure', { exact: true }).first().click(); await wait(p, 2500);
  };
  const tab = async (p, name, n = 0) => { await p.getByText(name, { exact: true }).nth(n).click(); await wait(p, 1800); };
  const vis = async (p, t) => (await p.getByText(t).count()) > 0;
  const refA = (await sql('SELECT agreement_ref FROM sponsorships WHERE id=$1', [dealA.id]))[0].agreement_ref;
  const openFirstAgreement = async (p) => { const el = p.getByText(`Harbour Cup · ${refA}`, { exact: true }).first(); await el.evaluate((e) => e.scrollIntoView({ block: 'center' })); await wait(p, 500); await el.click(); await wait(p, 2200); };
  const down = async (p, t) => { await p.getByText(t).first().scrollIntoViewIfNeeded().catch(() => {}); await wait(p, 400); };

  // ---- 1. the brand, on a phone
  const { page: p } = await session(brandOwner, { width: 390, height: 844 });
  await openRoi(p);
  check(await vis(p, 'Sponsorship ROI'), 'the ROI screen opens');
  check(await vis(p, /from the dues and confirmed payments/), 'money is read from the dues and payments (finance truth)');
  check(await vis(p, 'Deliverable health'), 'deliverable health is shown');
  check(await vis(p, /Not measured by Sportarena/), 'what is not measured is stated');
  await shot(p, '01-portfolio-phone', 3);
  await openFirstAgreement(p);
  check(await vis(p, /Reported by a provider/i) && await vis(p, /Measured by Sportarena/i), 'exposure labels measured vs provider-reported');
  check(await vis(p, /Missing: Broadcast impressions/i), 'an expected metric without data is missing, not zero');
  await shot(p, '02-exposure-phone', 2);
  await tab(p, 'Deliverables'); check(await vis(p, 'Trophy presentation by the brand ambassador'), 'deliverables list'); await shot(p, '03-deliverables-phone', 2);
  await tab(p, 'Estimate'); await p.getByText(/Digital CPM v1/).first().click(); await wait(p, 1800); check(await vis(p, /ESTIMATE/), 'an estimate is labelled as one'); await shot(p, '04-estimate-phone', 1);
  await tab(p, 'Renewal pack'); check(await vis(p, /cannot add return on investment/), 'renewal pack is facts only'); await shot(p, '05-renewal-phone', 2);
  await tab(p, 'Inventory'); check(await vis(p, 'Match-day overlay'), 'inventory booked for the agreement'); await shot(p, '06-inventory-phone');
  await p.getByText('← Back', { exact: true }).first().click(); await wait(p, 1500);
  await tab(p, 'Compare', 0); await wait(p, 1000); await shot(p, '07-compare-phone');
  await tab(p, 'Valuation', 0); check(await vis(p, /own assumptions/), 'valuation is the brand\'s own'); await shot(p, '08-valuation-phone', 1);
  await tab(p, 'Reports', 0); check(await vis(p, /frozen copy/), 'reports explain immutability'); await p.getByText(/→/).first().click(); await wait(p, 1800); check(await vis(p, /Fingerprint verified/i), 'issued report is hash-verified'); await shot(p, '09-reports-phone', 1);
  const [dl1] = await Promise.all([p.waitForEvent('download'), p.getByText('CSV', { exact: true }).first().click()]);
  check(/recipient,status/.test(fs.readFileSync(await dl1.path(), 'utf8')), 'report exports to CSV');
  await p.context().close();
  // ---- 2. tablet and desktop
  for (const [n, vp] of [['tablet', { width: 820, height: 1100 }], ['desktop', { width: 1280, height: 900 }]]) {
    const { page: w } = await session(brandOwner, vp); await openRoi(w); await shot(w, `10-portfolio-${n}`);
    await openFirstAgreement(w); await shot(w, `11-exposure-${n}`);
    check(await vis(w, /Reported by a provider/i), `${n}: exposure is visible`); await w.context().close();
  }
  // ---- 3. the beneficiary (event organiser): sponsorships, deliverables and figures here; inventory in the event console
  const pickTarget = async (o) => {
    await openRoi(o); await o.getByText('I am sponsored', { exact: true }).first().click(); await wait(o, 1500);
    await o.getByText('+ Pick one', { exact: true }).first().click().catch(() => o.getByText('Pick one').first().click()); await wait(o, 800);
    await o.getByText('Harbour Cup').last().click(); await wait(o, 2000);
  };
  {
    const { page: o } = await session(org, { width: 390, height: 844 }); await pickTarget(o);
    check(await vis(o, /Event inventory lives in the event console/i), 'event inventory is not duplicated here; it points to the event console');
    await shot(o, '12-inventory-pointer-phone');
    await tab(o, 'Sponsorships'); await shot(o, '13-sponsorships-phone');
    await o.getByText('Northwind Foods').first().click(); await wait(o, 2000);
    check(await vis(o, /Record a provider figure/), 'the beneficiary can record provider figures'); await shot(o, '14-figures-phone', 1);
    await o.getByText('＋ Record a provider figure').first().click(); await wait(o, 1000); await shot(o, '15-figure-form-phone');
    await o.context().close();
  }
  for (const [n, vp] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 900 }]]) {
    const { page: o } = await session(org, vp); await pickTarget(o);
    await o.getByText('Open the event console', { exact: true }).first().click(); await wait(o, 4000);
    await shot(o, `12-console-${n}`);
    await o.getByText(/Business/).first().click(); await wait(o, 3000);
    await o.getByText('Sponsor inventory', { exact: true }).first().scrollIntoViewIfNeeded().catch(() => {}); await wait(o, 600);
    check(await vis(o, 'Match-day overlay') && await vis(o, /Category-exclusive/i), `${n}: the organiser manages inventory in the event console (Business)`);
    await shot(o, `12-inventory-${n}`, 2);
    await o.context().close();
  }
  // ---- 4. denied
  const { page: s } = await session(stranger, { width: 390, height: 844 }); await openRoi(s);
  check(await vis(s, /Pick an event, team or athlete/i) || await vis(s, /You do not run a brand/i), 'a sponsor with no brand lands on the beneficiary view with a clear prompt'); await shot(s, '16-no-brand-phone');
  await s.context().close();
  const deny = await fetch(`http://127.0.0.1:4000/api/v1/sponsorship-intelligence?sponsor_id=${brand.id}`, { headers: { authorization: `Bearer ${stranger.token}` } });
  check(deny.status === 404, 'the server denies another sponsor');
  const rep2 = await fetch(`http://127.0.0.1:4000/api/v1/sponsorship-roi-reports/${rep.id}`, { headers: { authorization: `Bearer ${org.token}` } });
  check(rep2.status === 404, 'the beneficiary cannot open the brand\'s own report');
  await browser.close();
} catch (e) { console.error(e); failures++; }
finally { api.kill(); web.close(); await db.end(); log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0); }
