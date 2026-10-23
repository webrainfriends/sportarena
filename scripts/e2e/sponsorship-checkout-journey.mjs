// Browser-driven check of the sponsorship checkout journey (#294): phone, tablet and desktop, sponsor and recipient.
// Needs: a throwaway Postgres database (E2E_DATABASE_URL; it is migrated, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright-core (`npm i --no-save playwright-core`) with a Chromium (E2E_CHROMIUM, default the pre-installed one).
// It starts the API, a fake Stripe and a tiny static+proxy server itself. Run: node scripts/e2e/sponsorship-checkout-journey.mjs
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
try {
  const sponsor = await reg('uisponsor', ['sponsor']), ath = await reg('uiathlete', ['athlete']), fin = await reg('uistranger', ['sponsor']);
  const brand = await call('POST', '/sponsors', { token: sponsor.token, body: { name: 'Northwind Foods' } });
  await call('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } });
  const deal = await call('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: brand.id, target_type: 'athlete', target_id: ath.id, deliverables: 'Wear the kit', starts_on: '2030-01-01', ends_on: '2030-12-31', lines: [{ kind: 'money', label: 'Season support', currency: 'INR', amount_cents: 100000, cadence: 'once', first_due_on: '2030-02-01' }] } });
  await call('PATCH', `/sponsorships/${deal.id}`, { token: ath.token, body: { status: 'active', version: deal.terms_version } });
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${r.status()} ${await r.text()}`);
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(2500);
    return { ctx, page };
  };
  const shot = (page, n) => page.screenshot({ path: `${OUT}${n}.png`, fullPage: false });
  const openAgreement = async (page) => {
    await page.getByText('More', { exact: true }).first().click(); await page.waitForTimeout(1500); await shot(page, '00b-more');
    const vp = page.viewportSize(); await page.mouse.click(vp.width / 2, Math.round(vp.height * 0.735)); await page.waitForTimeout(2000); const ws = page.getByText('Sponsor workspace'); if (await ws.count()) { await ws.first().click(); await page.waitForTimeout(2000); } await shot(page, '00c-workspace');
    await page.getByText(/Open agreement SPA-/).first().click(); await page.waitForTimeout(1500);
  };
  // ---- phone: sponsor journey
  const { page: p } = await session(sponsor, { width: 390, height: 844 });
  await shot(p, '00-home');
  await openAgreement(p); await shot(p, '01-agreement');
  check(await p.getByText('Pay online', { exact: true }).first().isVisible(), 'sponsor sees Pay online on an open money due');
  check(await p.getByText(/Report a bank payment/).first().isVisible(), 'sponsor can still report a bank payment');
  check(await p.getByText(/Still due/).first().isVisible(), 'still-due amount is shown');
  // recipient has no payout account yet -> blocked with an explanation
  await p.getByText('Pay online', { exact: true }).first().click(); await p.waitForTimeout(1500); await shot(p, '02-pay-sheet');
  await p.getByText(/Pay .* with card \(Stripe\)/).first().click(); await p.waitForTimeout(1500); await shot(p, '03-blocked-not-onboarded');
  check(await p.getByText(/has not set up payouts/).first().isVisible(), 'denied/blocked state explains the recipient has no payout account');
  check(await p.getByRole('alert').first().isVisible(), 'the error is announced as an alert (accessibility)');
  check(await p.getByRole('button', { name: 'Pay online' }).first().count() > 0, 'Pay online is exposed as a button');
  await p.context().close();
  // ---- the recipient onboards: payout account created and verified by the platform team
  await sql("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('uiadmin','uiadmin','{admin}','x','x','uiadmin')");
  Object.assign(process.env, E);
  const { signToken } = await import(new URL('../../apps/api/src/auth.js', import.meta.url).pathname);
  const adminId = (await sql("SELECT id FROM users WHERE handle='uiadmin'"))[0].id;
  const adminToken = await signToken({ id: adminId, roles: ['admin'] });
  const acc = await call('POST', '/me/payout-accounts', { token: ath.token, body: { currency: 'INR', holder_name: 'UI Athlete', account_number: '123456789012', bank_code: 'HDFC0001234' } });
  await call('POST', `/admin/payout-accounts/${acc.id}/decision`, { token: adminToken, body: { decision: 'verify', reason: 'Holder name matches the profile' } });
  const lastPayment = async () => (await sql('SELECT id FROM payments ORDER BY created_at DESC LIMIT 1'))[0].id;
  // ---- partial online payment through the browser
  const { page: q } = await session(sponsor, { width: 390, height: 844 });
  await openAgreement(q);
  await q.getByText('Pay online', { exact: true }).first().click(); await q.waitForTimeout(1200);
  await q.getByText('Other amount', { exact: true }).click(); await q.waitForTimeout(500);
  await q.locator('input').last().fill('9999'); await q.waitForTimeout(400); await shot(q, '04-amount-too-high');
  check(await q.getByText(/At most/).first().isVisible(), 'an amount above what is due is flagged before paying');
  await q.locator('input').last().fill('400'); await q.waitForTimeout(400); await shot(q, '05-partial-amount');
  await q.getByText(/Pay .*400\.00 with card \(Stripe\)/).first().click(); await q.waitForTimeout(2500);
  check(q.url().includes('/fake-stripe/'), 'sponsor is sent to the provider checkout page');
  const sid = q.url().split('/').pop(); fake.sessions[sid].payment_status = 'paid';
  await q.goto(`http://localhost:4100/?payment=${await lastPayment()}&result=success`); await q.waitForTimeout(4000); await shot(q, '06-after-return');
  check(await q.getByText(/verified by provider/).first().isVisible(), 'returning from checkout lands on the agreement with the payment verified by the provider');
  check(await q.getByText(/Still due ₹600\.00/).first().isVisible(), 'part-paid: ₹600 still due');
  check(await q.getByText('SCHEDULED').first().isVisible(), 'part-paid due is not marked fulfilled');
  // ---- stale: someone else reserves most of the due while the sheet is open
  await q.getByText('Pay online', { exact: true }).first().click(); await q.waitForTimeout(1000);
  const other = await call('POST', `/sponsorship-obligations/${(await sql('SELECT id FROM sponsorship_obligations LIMIT 1'))[0].id}/checkout`, { token: sponsor.token, body: { provider: 'stripe', amount_cents: 50000 } });
  await q.getByText(/Pay ₹600\.00 with card/).first().click(); await q.waitForTimeout(2000); await shot(q, '07-stale-conflict');
  check(await q.getByText(/Only 10000 is still due|Nothing is left/).first().isVisible(), 'stale amount: the sheet explains what changed instead of failing silently');
  await q.reload(); await q.waitForTimeout(2500);
  await openAgreement(q); await shot(q, '08-checkout-open');
  check(await q.getByText(/checkout open/).first().isVisible(), 'an open checkout is shown on the due');
  await q.getByText('Cancel this checkout').first().click(); await q.waitForTimeout(2000); await shot(q, '09-after-cancel');
  check((await q.getByText(/checkout open/).count()) === 0, 'cancelling frees the due again');
  await q.context().close();
  // ---- recipient: sees it verified, cannot reverse it, can confirm a manual report, sees reconciliation
  const odue = (await sql('SELECT id FROM sponsorship_obligations LIMIT 1'))[0].id;
  await call('POST', `/sponsorship-obligations/${odue}/payments`, { token: sponsor.token, body: { amount_cents: 10000, currency: 'INR', method: 'bank_transfer', reference: 'TRX-UI-1', paid_on: '2030-01-20' } });
  // the athlete also opens the Sponsors workspace (a module on the More wheel) to reach the agreement as its recipient
  await sql("UPDATE users SET roles='{athlete,sponsor}' WHERE handle='uiathlete'");
  const { page: r } = await session(ath, { width: 390, height: 844 });
  await openAgreement(r); await shot(r, '10-recipient');
  check(await r.getByText(/verified by provider/).first().isVisible(), 'recipient sees the online payment as verified');
  check(await r.getByText('Confirm received').first().isVisible(), 'recipient can confirm the manual report');
  check(await r.getByText(/unverified/).first().isVisible(), 'the manual report is labelled unverified');
  check((await r.getByText('Pay online', { exact: true }).count()) === 0, 'recipient is not offered Pay online');
  check((await r.getByText('Reverse', { exact: true }).count()) === 0, 'an online payment has no manual Reverse');
  check(await r.getByText(/reconciles/i).first().isVisible(), 'reconciliation shows Reconciles');
  await r.mouse.wheel(0, 700); await r.waitForTimeout(500); await shot(r, '11-recipient-reconciliation');
  await r.context().close();
  // ---- tablet and desktop layouts
  for (const [n, vp] of [['tablet', { width: 820, height: 1100 }], ['desktop', { width: 1280, height: 900 }]]) {
    const { page: w } = await session(sponsor, vp); await openAgreement(w); await shot(w, `12-${n}`);
    check(await w.getByText('Pay online', { exact: true }).first().isVisible(), `${n}: Pay online is visible`);
    await w.getByText('Pay online', { exact: true }).first().click(); await w.waitForTimeout(1000); await shot(w, `13-${n}-sheet`);
    check(await w.getByText(/Pay .* with card/).first().isVisible(), `${n}: checkout sheet is usable`);
    await w.context().close();
  }
  await browser.close();
} catch (e) { log('ERROR', e.stack); failures++; }
finally { await db.end().catch(() => {}); api.kill(); web.close(); stripe.close(); log(failures ? `FAILURES: ${failures}` : 'ALL PASSED'); process.exit(failures ? 1 : 0); }
