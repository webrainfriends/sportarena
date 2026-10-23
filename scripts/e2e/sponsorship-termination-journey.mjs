// Browser-driven check of the sponsorship termination journey (#298): phone, tablet and desktop, sponsor and recipient.
// Needs: a throwaway Postgres database (E2E_DATABASE_URL; it is migrated, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright-core (`npm i --no-save playwright-core`) with a Chromium (E2E_CHROMIUM, default the pre-installed one).
// It starts the API, a fake Stripe and a tiny static+proxy server itself. Run: node scripts/e2e/sponsorship-termination-journey.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
const E = { DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sportarena_e2e', SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'),
  PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_BASE: 'http://127.0.0.1:4510',
  PROVIDER_COMMISSION_BP: '1000', SETTLEMENT_PAYOUTS: 'on', SETTLEMENT_CURRENCIES: 'INR', PAYMENT_CURRENCY: 'INR', PLATFORM_APPROVALS: 'off', RATE_LIMIT_DISABLED: 'true' };
import pg from 'pg';
const OUT = (process.env.E2E_SHOTS ?? '/tmp/e2e-shots') + '/'; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
// --- fake Stripe
const fake = { sessions: {}, n: 0 };
const stripe = http.createServer(async (req, res) => {
  const ch = []; for await (const c of req) ch.push(c); const raw = Buffer.concat(ch).toString(); const send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (req.url === '/v1/checkout/sessions' && req.method === 'POST') { const f = new URLSearchParams(raw); const id = `cs_${++fake.n}`; fake.sessions[id] = { id, amount_total: Number(f.get('line_items[0][price_data][unit_amount]')), currency: f.get('line_items[0][price_data][currency]'), payment_status: 'unpaid', payment_intent: `pi_${fake.n}` }; return send(200, { id, url: `http://localhost:4100/fake-stripe/${id}` }); }
  if (req.url.startsWith('/v1/checkout/sessions/')) { const s = fake.sessions[req.url.split('/').pop()]; return s ? send(200, s) : send(404, {}); }
  send(200, { id: 're_1' });
});
await new Promise((r) => stripe.listen(4510, '127.0.0.1', r));
// --- API
const api = spawn('node', ['src/server.js'], { cwd: new URL('../../apps/api/', import.meta.url).pathname, env: { ...process.env, ...E }, stdio: ['ignore', 'pipe', 'pipe'] });
api.stdout.on('data', (d) => process.env.V && log('[api]', String(d).trim())); api.stderr.on('data', (d) => process.env.V && log('[api!]', String(d).trim()));
for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:4000/api/v1/payments/methods')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
// --- static + proxy
const DIST = process.env.E2E_DIST ?? '/tmp/e2e-dist';
const web = http.createServer((req, res) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/mcp')) { const p = http.request({ host: '127.0.0.1', port: 4000, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); req.pipe(p); return; }
  if (req.url.startsWith('/fake-stripe/')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<h1>Fake Stripe checkout</h1>'); }
  let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  const ext = path.extname(f); res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.ico': 'image/x-icon' }[ext] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4100, r));
const B = 'http://localhost:4100/api/v1';
const call = async (method, p, { token, body } = {}) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p} ${r.status} ${JSON.stringify(j)}`); return j; };
const reg = async (h, roles) => { const r = await call('POST', '/auth/register', { body: { handle: h, display_name: h, email: `${h}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); return { ...r.user, token: r.token, email: `${h}@example.com` }; };
const db = new pg.Pool({ connectionString: E.DATABASE_URL });
const sql = async (q) => (await db.query(q)).rows;
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const iso = (d) => d.toISOString().slice(0, 10);
const plus = (days) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d; };
const monthsAfter = (d, n) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };
const END = plus(30);
try {
  const sponsor = await reg('tmsponsor', ['sponsor']), ath = await reg('tmathlete', ['athlete']), stranger = await reg('tmstranger', ['sponsor']);
  const brand = await call('POST', '/sponsors', { token: sponsor.token, body: { name: 'Northwind Foods' } });
  await call('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } });
  const money = { kind: 'money', label: 'Season support', currency: 'SGD', amount_cents: 100000, cadence: 'custom', custom_dates: ['2020-01-15', '2020-02-15', '2099-01-01', '2099-02-01'] };
  const goods = { kind: 'goods', label: 'Rackets', quantity: 10, unit: 'pcs', cadence: 'once', first_due_on: '2020-03-01' };
  const deal = await call('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: brand.id, target_type: 'athlete', target_id: ath.id, deliverables: 'Wear the kit', starts_on: '2020-01-01', ends_on: '2099-12-31', lines: [money, goods] } });
  await call('PATCH', `/sponsorships/${deal.id}`, { token: ath.token, body: { status: 'active', version: deal.terms_version } });
  const os = (await call('GET', `/sponsorships/${deal.id}`, { token: ath.token })).obligations;
  const first = os.find((o) => o.due_on === '2020-01-15'), g = os.find((o) => o.kind === 'goods');
  const pay = await call('POST', `/sponsorship-obligations/${first.id}/payments`, { token: sponsor.token, body: { amount_cents: 100000, currency: 'SGD', method: 'bank_transfer', reference: 'JAN-1', paid_on: '2030-01-16' } });
  await call('PATCH', `/sponsorship-payments/${pay.id}`, { token: ath.token, body: { status: 'confirmed' } });
  const dl = await call('POST', `/sponsorship-obligations/${g.id}/deliveries`, { token: sponsor.token, body: { quantity: 10 } });
  await call('PATCH', `/sponsorship-deliveries/${dl.id}`, { token: ath.token, body: { status: 'received', received_quantity: 8 } });
  await sql("UPDATE users SET roles='{athlete,sponsor}' WHERE handle='tmathlete'");
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${r.status()} ${await r.text()}`);
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(2500);
    return { ctx, page };
  };
  const shot = (page, n, full = false) => page.screenshot({ path: `${OUT}${n}.png`, fullPage: full });
  const openAgreement = async (page) => {
    await page.getByText('More', { exact: true }).first().click(); await page.waitForTimeout(1500);
    const vp = page.viewportSize(); await page.mouse.click(vp.width / 2, Math.round(vp.height * 0.735)); await page.waitForTimeout(2000); const ws = page.getByText('Sponsor workspace'); if (await ws.count()) { await ws.first().click(); await page.waitForTimeout(1500); }
    await page.getByText(/Open agreement SPA-/).first().click(); await page.waitForTimeout(1500);
  };
  const toTermination = async (page) => { await page.getByText('Ending this agreement').first().scrollIntoViewIfNeeded(); await page.waitForTimeout(500); };
  // ---- sponsor on a phone: empty state with the impact preview, then notice with a review step
  const { page: p } = await session(sponsor, { width: 390, height: 844 });
  await openAgreement(p); await toTermination(p); await shot(p, '01-termination-empty');
  check(await p.getByText('No termination in progress').first().isVisible(), 'empty state: no termination in progress');
  check(await p.getByText(/stay exactly as they are/).first().isVisible(), 'the impact preview shows what is kept before anyone gives notice');
  await p.getByText('Give notice to end', { exact: true }).first().click(); await p.waitForTimeout(1200); await shot(p, '02-notice-form');
  await p.getByText('Review the impact').first().click(); await p.waitForTimeout(1200); await shot(p, '02b-form-needs-date');
  check(await p.getByText(/is required|Choose the date/).first().isVisible(), 'a missing end date is explained inline');
  await p.getByText('📅').first().click(); await p.waitForTimeout(600);
  for (let i = 0; i < 3 && !(await p.getByLabel(iso(END), { exact: true }).count()); i++) { await p.getByLabel('Next month').last().click(); await p.waitForTimeout(150); }
  await p.getByLabel(iso(END), { exact: true }).last().click(); await p.waitForTimeout(500);
  await p.getByText('Review the impact').first().click(); await p.waitForTimeout(2000); await shot(p, '03-review-before-sending');
  check(await p.getByText('Send notice', { exact: true }).first().isVisible(), 'the impact is reviewed before the notice is sent');
  await p.getByText('Send notice', { exact: true }).first().click(); await p.waitForTimeout(2500); await toTermination(p); await shot(p, '04-sponsor-notice-given');
  check(await p.getByText(/You gave notice/).first().isVisible(), 'sponsor sees the notice it gave');
  check((await sql("SELECT status FROM sponsorships WHERE id='" + deal.id + "'"))[0].status === 'active', 'the agreement keeps running until the effective date');
  await p.context().close();
  // ---- recipient: sees the notice, accepts the terms; a stale answer is refused
  const t0 = (await call('GET', `/sponsorships/${deal.id}/termination`, { token: ath.token })).termination;
  const { page: r } = await session(ath, { width: 390, height: 844 });
  await openAgreement(r); await toTermination(r); await shot(r, '05-recipient-notice');
  check(await r.getByText(/Notice from the sponsor/).first().isVisible() && await r.getByText('Accept these terms', { exact: true }).first().isVisible(), 'recipient is told and can accept or dispute');
  await call('POST', `/sponsorship-terminations/${t0.id}/answer`, { token: sponsor.token, body: { action: 'dispute', rev: t0.rev, note: 'Checking the dates' } });
  await r.getByText('Accept these terms', { exact: true }).first().click(); await r.waitForTimeout(2200); await shot(r, '06-stale-answer');
  check(await r.getByText(/latest version is shown now/).first().isVisible(), 'a stale answer is refused with the reason and the latest state is shown');
  check((await sql("SELECT status FROM sponsorship_terminations WHERE id='" + t0.id + "'"))[0].status === 'notice', 'a refused answer changed nothing');
  await r.context().close();
  // ---- the agreement ends; returns, refunds and the final settlement
  await sql("UPDATE sponsorship_terminations SET effective_on=current_date, notice_on=current_date WHERE id='" + t0.id + "'");
  const ended = (await call('GET', `/sponsorships/${deal.id}/termination`, { token: ath.token }));
  const t1 = ended.termination;
  await call('POST', `/sponsorship-terminations/${t1.id}/returns`, { token: sponsor.token, body: { delivery_id: dl.id, quantity: 3, note: 'Unused' } });
  await call('POST', `/sponsorship-terminations/${t1.id}/refunds`, { token: sponsor.token, body: { sponsorship_payment_id: pay.id, amount_cents: 30000, note: 'Season cut short' } });
  const { page: q } = await session(ath, { width: 390, height: 844 });
  await openAgreement(q); await toTermination(q); await q.mouse.wheel(0, 500); await q.waitForTimeout(500); await shot(q, '07-returns-and-refunds');
  check(await q.getByText('Goods returned').first().isVisible() && await q.getByText('Refunds', { exact: true }).first().isVisible(), 'returns and refunds are shown on the same screen');
  await q.mouse.wheel(0, 700); await q.waitForTimeout(500); await shot(q, '08-final-settlement');
  check(await q.getByText(/Unresolved \(/).first().isVisible(), 'final settlement exposes the unresolved items');
  await q.getByText('Final settlement').first().scrollIntoViewIfNeeded();
  await q.context().close();
  // ---- over-return is refused with an explanation
  const over = await fetch(`http://127.0.0.1:4000/api/v1/sponsorship-terminations/${t1.id}/returns`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sponsor.token}` }, body: JSON.stringify({ delivery_id: dl.id, quantity: 6 }) });
  check(over.status === 409, 'a return above what was received is refused');
  // ---- outsider denied; tablet and desktop
  check((await fetch(`http://127.0.0.1:4000/api/v1/sponsorships/${deal.id}/termination`, { headers: { authorization: `Bearer ${stranger.token}` } })).status === 403, 'an outsider is denied the termination');
  for (const [n, vp] of [['tablet', { width: 820, height: 1100 }], ['desktop', { width: 1280, height: 900 }]]) {
    const { page: w } = await session(sponsor, vp); await openAgreement(w); await toTermination(w); await shot(w, `09-${n}`);
    check(await w.getByText('Final settlement').first().isVisible(), `${n}: final settlement is visible`);
    await w.context().close();
  }
  await browser.close();
} catch (e) { log('ERROR', e.stack); failures++; }
finally { await db.end().catch(() => {}); api.kill(); web.close(); stripe.close(); log(failures ? `FAILURES: ${failures}` : 'ALL PASSED'); process.exit(failures ? 1 : 0); }
