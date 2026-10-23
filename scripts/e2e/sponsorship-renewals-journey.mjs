// Browser-driven check of the term-expiry / renewal journey (#299): phone, tablet and desktop, sponsor and recipient.
// Needs: a throwaway Postgres database (E2E_DATABASE_URL; it is migrated, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright-core (`npm i --no-save playwright-core`) with a Chromium (E2E_CHROMIUM, default the pre-installed one).
// It starts the API, a fake Stripe and a tiny static+proxy server itself. Run: node scripts/e2e/sponsorship-renewals-journey.mjs
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
const FIRST = plus(10), LAST = monthsAfter(FIRST, 6), EFF_BLOCKED = plus(4), EFF = plus(30);
try {
  const sponsor = await reg('rnsponsor', ['sponsor']), ath = await reg('rnathlete', ['athlete']), stranger = await reg('rnstranger', ['sponsor']);
  const brand = await call('POST', '/sponsors', { token: sponsor.token, body: { name: 'Northwind Foods' } });
  await call('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } });
  const money = { kind: 'money', label: 'Monthly support', currency: 'SGD', amount_cents: 50000, cadence: 'monthly', first_due_on: iso(plus(-100)), instalments: 6 };
  const deal = await call('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: brand.id, target_type: 'athlete', target_id: ath.id, deliverables: 'Wear the kit', starts_on: iso(plus(-101)), ends_on: iso(plus(-100 + 5 * 30 + 29)), lines: [money] } });
  await call('PATCH', `/sponsorships/${deal.id}`, { token: ath.token, body: { status: 'active', version: deal.terms_version } });
  const first = (await call('GET', `/sponsorships/${deal.id}`, { token: ath.token })).obligations[0];
  const pay = await call('POST', `/sponsorship-obligations/${first.id}/payments`, { token: sponsor.token, body: { amount_cents: 50000, currency: 'SGD', method: 'bank_transfer', reference: 'JAN-1', paid_on: iso(plus(-99)) } });
  await call('PATCH', `/sponsorship-payments/${pay.id}`, { token: ath.token, body: { status: 'confirmed' } });
  await sql("UPDATE users SET roles='{athlete,sponsor}' WHERE handle='rnathlete'");
  await sql("UPDATE sponsorships SET ends_on = current_date + 30 WHERE id='" + deal.id + "'");
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
    await page.getByText('More', { exact: true }).first().click(); await page.waitForTimeout(1500);
    const vp = page.viewportSize(); await page.mouse.click(vp.width / 2, Math.round(vp.height * 0.735)); await page.waitForTimeout(2000); const ws = page.getByText('Sponsor workspace'); if (await ws.count()) { await ws.first().click(); await page.waitForTimeout(2000); }
    await page.getByText(/Open agreement SPA-/).first().click(); await page.waitForTimeout(1500);
  };
  const wait = (p, ms = 1500) => p.waitForTimeout(ms);
  const open = async (p, ref) => { await p.getByText('More', { exact: true }).first().click(); await wait(p); const vp = p.viewportSize(); await p.mouse.click(vp.width / 2, Math.round(vp.height * 0.735)); await wait(p, 2000); const ws = p.getByText('Sponsor workspace'); if (await ws.count()) { await ws.first().click(); await wait(p); } await p.getByText(ref ? `Open agreement ${ref}` : /Open agreement SPA-/).first().click(); await wait(p); };
  const toRenewal = async (p) => { await p.getByText('Term & renewal').first().scrollIntoViewIfNeeded(); await wait(p, 400); };
  const ref = (await sql("SELECT agreement_ref FROM sponsorships WHERE id='" + deal.id + "'"))[0].agreement_ref;
  // ---- 1. sponsor, phone: the term is running, 30 days left, nothing renews by itself
  const { page: p } = await session(sponsor, { width: 390, height: 844 });
  await open(p, ref); await toRenewal(p); await shot(p, '01-active-30-days-left');
  check(await p.getByText(/30 days left in the term/).first().isVisible(), 'days left are shown');
  check(await p.getByText(/Nothing renews by itself/).first().isVisible(), 'the no-silent-renewal rule is stated');
  check(await p.getByText('Propose a renewal', { exact: true }).count() === 1, 'the renewal can be proposed inside the 90 day window');
  // ---- 2. share a plan
  await p.getByText('Share our plan', { exact: true }).first().click(); await wait(p, 1200); await shot(p, '02-plan-sheet');
  await p.getByText('Share with the other side', { exact: true }).first().click(); await wait(p, 2000); await toRenewal(p); await shot(p, '03-plan-shared');
  check(await p.getByText(/You: We want to renew/).first().isVisible(), 'our plan is shown');
  check(await p.getByText(/The other side: no answer yet/).first().isVisible(), 'the other side has not answered');
  await p.context().close();
  // ---- 3. the date passes: expired term, dues still owed
  await sql("UPDATE sponsorships SET ends_on = current_date - 1 WHERE id='" + deal.id + "'");
  process.env.DATABASE_URL = E.DATABASE_URL; process.env.SPORTARENA_MASTER_KEY = E.SPORTARENA_MASTER_KEY; process.env.SPORTARENA_JWT_SECRET = E.SPORTARENA_JWT_SECRET;
  const { processSponsorshipTerms } = await import('../../apps/api/src/sponsor-renewals.js');
  await processSponsorshipTerms();
  check((await sql("SELECT status FROM sponsorships WHERE id='" + deal.id + "'"))[0].status === 'term_expired', 'the worker moved the agreement to term_expired');
  check((await sql("SELECT count(*)::int AS n FROM sponsorship_obligations WHERE sponsorship_id='" + deal.id + "' AND status='scheduled'"))[0].n === 5, 'the five unpaid dues are still owed');
  const { page: r } = await session(ath, { width: 390, height: 844 });
  await open(r, ref); await toRenewal(r); await shot(r, '04-recipient-term-expired');
  check(await r.getByText(/still open/).first().isVisible(), 'the recipient sees the term ended but dues are open');
  check(await r.getByText(/The sponsor: We want to renew/).count() + await r.getByText(/The other side: We want to renew/).count() > 0, 'the sponsor\'s plan is visible');
  await r.getByText('Share our plan', { exact: true }).first().click(); await wait(r, 1200);
  await r.getByText('We do not want to renew', { exact: true }).first().click(); await wait(r, 400); await shot(r, '05-recipient-plan-not-renew');
  await r.getByText('Share with the other side', { exact: true }).first().click(); await wait(r, 2000);
  // ---- 4. the recipient proposes a renewal; the sponsor must sign off the exact version
  await r.getByText('Propose a renewal', { exact: true }).first().click(); await wait(r, 1200); await shot(r, '06-propose-renewal-sheet');
  await r.getByText(/^Send to the sponsor/).first().click(); await wait(r, 3000); await shot(r, '07-renewal-open-as-recipient');
  check(await r.getByText(/renewal of SPA-/i).first().isVisible(), 'the renewal screen links back to the previous agreement');
  check(await r.getByText('Withdraw renewal', { exact: true }).first().isVisible(), 'the proposer can withdraw');
  check(await r.getByText(/Accept these exact terms/).count() === 0, 'the proposer cannot accept their own terms');
  await r.context().close();
  const succ = (await sql("SELECT id, agreement_ref FROM sponsorships WHERE renews_id='" + deal.id + "'"))[0];
  const { page: s2 } = await session(sponsor, { width: 390, height: 844 });
  await open(s2, succ.agreement_ref); await shot(s2, '08-sponsor-sees-renewal');
  check(await s2.getByText(/Sign off these exact terms \(v1\)/).first().isVisible(), 'the sponsor is asked to sign off the exact version');
  check(await s2.getByText('Decline renewal', { exact: true }).first().isVisible(), 'the sponsor can decline instead');
  await s2.getByText(/Sign off these exact terms/).first().click(); await wait(s2, 2500); await shot(s2, '09-renewal-active');
  check((await sql("SELECT status FROM sponsorships WHERE id='" + succ.id + "'"))[0].status === 'active', 'only the sign-off activated the renewal');
  check((await sql("SELECT count(*)::int AS n FROM sponsorship_obligations WHERE sponsorship_id='" + succ.id + "'"))[0].n === 6, 'the renewal got its own six dues');
  check((await sql("SELECT status FROM sponsorships WHERE id='" + deal.id + "'"))[0].status === 'term_expired', 'the old agreement and its dues are untouched');
  await s2.context().close();
  // ---- 5. previous agreement still reachable; completed state after settlement
  await sql("UPDATE sponsorship_obligations SET status='fulfilled', fulfilled_at=now() WHERE sponsorship_id='" + deal.id + "' AND status='scheduled'");
  await processSponsorshipTerms();
  const { page: h } = await session(sponsor, { width: 390, height: 844 });
  await open(h, ref); await toRenewal(h); await shot(h, '10-previous-agreement-completed');
  check(await h.getByText(/Every due is settled/).first().isVisible(), 'completed: every due is settled');
  check(await h.getByText(/Renewal SPA-/).first().isVisible(), 'the linked renewal is shown on the previous agreement');
  await h.context().close();
  // ---- 6. denied, tablet and desktop
  check((await fetch(`http://127.0.0.1:4000/api/v1/sponsorships/${deal.id}`, { headers: { authorization: `Bearer ${stranger.token}` } })).status === 403, 'an outsider is denied');
  for (const [n, vp] of [['tablet', { width: 820, height: 1100 }], ['desktop', { width: 1280, height: 900 }]]) {
    const { page: w } = await session(ath, vp); await open(w, succ.agreement_ref); await toRenewal(w); await shot(w, `11-${n}`);
    check(await w.getByText('Term & renewal').first().isVisible(), `${n}: term & renewal is visible`);
    await w.context().close();
  }
  await browser.close();
} catch (e) { console.error(e); failures++; }
finally { api.kill(); stripe.close(); web.close(); await db.end(); log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0); }
