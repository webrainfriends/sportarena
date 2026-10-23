// Browser-driven check of the sponsorship amendment journey (#296): phone, tablet and desktop, sponsor and recipient.
// Needs: a throwaway Postgres database (E2E_DATABASE_URL; it is migrated, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright-core (`npm i --no-save playwright-core`) with a Chromium (E2E_CHROMIUM, default the pre-installed one).
// It starts the API, a fake Stripe and a tiny static+proxy server itself. Run: node scripts/e2e/sponsorship-amendments-journey.mjs
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
  const sponsor = await reg('amsponsor', ['sponsor']), ath = await reg('amathlete', ['athlete']), stranger = await reg('amstranger', ['sponsor']);
  const brand = await call('POST', '/sponsors', { token: sponsor.token, body: { name: 'Northwind Foods' } });
  await call('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } });
  const money = { kind: 'money', label: 'Monthly support', currency: 'SGD', amount_cents: 50000, cadence: 'monthly', first_due_on: iso(FIRST), instalments: 6 };
  const deal = await call('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: brand.id, target_type: 'athlete', target_id: ath.id, deliverables: 'Wear the kit', starts_on: iso(plus(1)), ends_on: iso(plus(260)), lines: [money] } });
  await call('PATCH', `/sponsorships/${deal.id}`, { token: ath.token, body: { status: 'active', version: deal.terms_version } });
  const first = (await call('GET', `/sponsorships/${deal.id}`, { token: ath.token })).obligations[0];
  const pay = await call('POST', `/sponsorship-obligations/${first.id}/payments`, { token: sponsor.token, body: { amount_cents: 50000, currency: 'SGD', method: 'bank_transfer', reference: 'JAN-1', paid_on: iso(plus(0)) } });
  await call('PATCH', `/sponsorship-payments/${pay.id}`, { token: ath.token, body: { status: 'confirmed' } });
  await sql("UPDATE users SET roles='{athlete,sponsor}' WHERE handle='amathlete'");
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
  const toAmendments = async (page) => { await page.waitForTimeout(500); };
  const pickDate = async (page, d) => { // the second calendar field on the form is "changes apply from": open it, move to the month, tap the day
    await page.getByText('📅').nth(1).click(); await page.waitForTimeout(600);
    for (let i = 0; i < 14 && !(await page.getByLabel(d, { exact: true }).count()); i++) { await page.getByLabel('Next month').last().click(); await page.waitForTimeout(150); }
    await page.getByLabel(d, { exact: true }).last().click(); await page.waitForTimeout(500);
  };
  // ---- sponsor on a phone: empty state, then propose with a preview of the impact
  const { page: p } = await session(sponsor, { width: 390, height: 844 });
  await openAgreement(p); await toAmendments(p); await shot(p, '01-amendments-empty');
  check(await p.getByText('No amendments yet').first().isVisible(), 'empty state: no amendments yet');
  check(await p.getByText('Propose an amendment', { exact: true }).first().isVisible(), 'sponsor can propose');
  await p.getByText('Propose an amendment', { exact: true }).first().click(); await p.waitForTimeout(1200);
  await p.locator('input').first().fill('600'); await p.waitForTimeout(300);
  await p.getByText('Preview the impact').first().click(); await p.waitForTimeout(1500); await shot(p, '02-form-needs-date');
  check(await p.getByText(/is required/).first().isVisible(), 'missing effective date is explained inline');
  await pickDate(p, iso(EFF_BLOCKED)); await shot(p, '03-form-filled');
  await p.getByText('Preview the impact').first().click(); await p.waitForTimeout(2000); await shot(p, '04-review-blocked');
  check(await p.getByText(/cannot be replaced/).first().isVisible(), 'a date that would touch a settled due is blocked, with the reason');
  await p.getByText('Back', { exact: true }).last().click(); await p.waitForTimeout(800);
  await pickDate(p, iso(EFF));
  await p.getByText('Preview the impact').first().click(); await p.waitForTimeout(2000); await shot(p, '05-review-ok');
  check(await p.getByText(/Send proposal/).first().isVisible() && await p.getByText(/stay exactly as they are/).first().isVisible(), 'the impact is shown before anything is sent');
  await p.getByText('Send proposal', { exact: true }).first().click(); await p.waitForTimeout(2500); await shot(p, '06-sponsor-waiting');
  check(await p.getByText(/Waiting for the recipient/).first().isVisible(), 'sponsor sees it is waiting for the recipient');
  check((await sql("SELECT count(*)::int AS n FROM sponsorship_obligations WHERE sponsorship_id='" + deal.id + "' AND status='cancelled'"))[0].n === 0, 'sending a proposal changed no due');
  await p.context().close();
  const prop = (await call('GET', `/sponsorships/${deal.id}/amendments`, { token: sponsor.token })).amendments[0];
  const { page: r } = await session(ath, { width: 390, height: 844 });
  await openAgreement(r); await toAmendments(r); await shot(r, '04-recipient-open-amendment');
  check(await r.getByText(/Your answer is needed/).first().isVisible(), 'recipient is told it is their turn');
  check(await r.getByText(/stay exactly as they are/).first().isVisible(), 'impact preview shows what stays untouched');
  check(await r.getByText(/Accept these exact terms/).first().isVisible(), 'recipient can accept the exact revision');
  // stale: the sponsor edits while the recipient has the screen open
  await call('POST', `/sponsorship-amendments/${prop.id}/revise`, { token: sponsor.token, body: { rev: 1, expected_version: 1, effective_from: iso(EFF), lines: [{ ...money, amount_cents: 65000 }], reason: 'Bigger season' } });
  await r.getByText(/Accept these exact terms/).first().click(); await r.waitForTimeout(2000); await shot(r, '05-stale-revision');
  check(await r.getByText(/changed \(now revision 2\)|now revision 2/).count() > 0 || await r.getByText(/Revision 2/).count() > 0, 'stale acceptance is refused and the latest revision is shown');
  check((await sql("SELECT count(*)::int AS n FROM sponsorship_obligations WHERE sponsorship_id='" + deal.id + "' AND status='cancelled'"))[0].n === 0, 'a refused acceptance changed nothing');
  await r.reload(); await r.waitForTimeout(2500); await openAgreement(r); await toAmendments(r);
  await r.getByText(/Accept these exact terms/).first().click(); await r.waitForTimeout(2500); await shot(r, '06-accepted');
  check(await r.getByText(/^accepted$/i).first().isVisible(), 'history shows the amendment as accepted');
  check((await sql("SELECT count(*)::int AS n FROM sponsorship_obligations WHERE sponsorship_id='" + deal.id + "' AND status='cancelled'"))[0].n === 5, 'exactly the five untouched future dues were replaced');
  check((await sql("SELECT count(*)::int AS n FROM sponsorship_obligations WHERE sponsorship_id='" + deal.id + "' AND status='fulfilled' AND version=1"))[0].n === 1, 'the fulfilled due is untouched');
  await r.mouse.wheel(0, 900); await r.waitForTimeout(500); await shot(r, '07-commitments-after');
  check(await r.getByText('replaced by amendment').first().isVisible(), 'replaced dues are labelled, not hidden');
  await r.context().close();
  // ---- an outsider is denied; a viewer-only role cannot propose
  check((await fetch(`http://127.0.0.1:4000/api/v1/sponsorships/${deal.id}/amendments`, { headers: { authorization: `Bearer ${stranger.token}` } })).status === 403, 'an outsider is denied the amendment history');
  // ---- tablet and desktop
  for (const [n, vp] of [['tablet', { width: 820, height: 1100 }], ['desktop', { width: 1280, height: 900 }]]) {
    const { page: w } = await session(sponsor, vp); await openAgreement(w); await toAmendments(w); await shot(w, `08-${n}`);
    check(await w.getByText('Amendment history').first().isVisible(), `${n}: amendment history is visible`);
    await w.context().close();
  }
  // ---- brand with a read-only role (denied state), and an organisation recipient changing the payee
  const org = await call('POST', '/organisations', { token: sponsor.token, body: { name: 'Acme Corp', kind: 'company' } });
  const corp = await call('POST', '/sponsors', { token: sponsor.token, body: { name: 'Acme Brand' } });
  await call('POST', `/organisations/${org.id}/assets`, { token: sponsor.token, body: { kind: 'sponsor', asset_id: corp.id } });
  const aud = await reg('amauditor', ['athlete']);
  await call('POST', `/organisations/${org.id}/members`, { token: sponsor.token, body: { person: aud.handle, role: 'auditor' } });
  await call('POST', `/organisations/${org.id}/invite/respond`, { token: aud.token, body: { accept: true } });
  const rorg = await reg('amorgowner', ['coach']);
  const beneficiary = await call('POST', '/organisations', { token: rorg.token, body: { name: 'Riverside Club' } });
  await call('PATCH', `/organisations/${beneficiary.id}`, { token: rorg.token, body: { open_to_sponsors: true } });
  const fin = await reg('amfinance', ['coach']);
  await call('POST', `/organisations/${beneficiary.id}/members`, { token: rorg.token, body: { person: fin.handle, role: 'finance' } });
  await call('POST', `/organisations/${beneficiary.id}/invite/respond`, { token: fin.token, body: { accept: true } });
  const odeal = await call('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: corp.id, target_type: 'organisation', target_id: beneficiary.id, starts_on: iso(plus(1)), ends_on: iso(plus(260)), lines: [money] } });
  await call('PATCH', `/sponsorships/${odeal.id}`, { token: rorg.token, body: { status: 'active', version: 1 } });
  await call('POST', `/sponsorships/${odeal.id}/allocations`, { token: rorg.token, body: { rev: 1, allocations: [{ beneficiary_type: 'organisation', beneficiary_id: beneficiary.id, share_bp: 10000, payee_user_id: rorg.id }] } });
  const open = async (who, id) => { const s2 = await session(who, { width: 390, height: 844 }); await s2.page.goto(`http://localhost:4100/?open=sponsorship:${id}`); await s2.page.waitForTimeout(3500); return s2; };
  const { page: d1 } = await open(aud, odeal.id);
  await shot(d1, '09-denied-auditor');
  check(await d1.getByText(/Your role cannot propose changes/).first().isVisible(), 'a read-only brand role is told why it cannot propose');
  check((await d1.getByText('Propose an amendment', { exact: true }).count()) === 0, 'no propose button for a read-only role');
  await d1.context().close();
  const { page: o1 } = await open(rorg, odeal.id);
  await o1.getByText('Propose an amendment', { exact: true }).first().click(); await o1.waitForTimeout(1500); await shot(o1, '10-payee-form');
  check(await o1.getByText(/Who is paid for Riverside Club/).first().isVisible(), 'the organisation sees the payee choice');
  await o1.getByText(/amfinance|Amend/i).first().click().catch(() => {});
  await o1.getByText(/\(finance\)/).first().click(); await o1.waitForTimeout(400);
  await pickDate(o1, iso(plus(30)));
  await o1.getByText('Preview the impact').first().click(); await o1.waitForTimeout(2000); await shot(o1, '11-payee-review');
  check(await o1.getByText(/Also changes who is paid/).first().isVisible(), 'review says the payee changes');
  await o1.getByText('Send proposal', { exact: true }).first().click(); await o1.waitForTimeout(2500); await shot(o1, '12-payee-sent');
  const alloc = await call('GET', `/sponsorships/${odeal.id}/allocations`, { token: rorg.token });
  check(alloc.allocations[0].payee_user_id === rorg.id, 'the payee is unchanged until the sponsor accepts');
  await o1.context().close();
  const { page: s1 } = await open(sponsor, odeal.id);
  await shot(s1, '13-sponsor-sees-payee-change');
  check(await s1.getByText(/Also changes who is paid/).first().isVisible(), 'the sponsor is told the payee changes, without payee identities');
  check((await s1.getByText(/amfinance/).count()) === 0, 'the sponsor never sees the payee identity');
  await s1.getByText(/Accept these exact terms/).first().click(); await s1.waitForTimeout(2500);
  check((await call('GET', `/sponsorships/${odeal.id}/allocations`, { token: rorg.token })).allocations[0].payee_user_id === fin.id, 'accepting applies the payee change');
  await s1.context().close();
  await browser.close();
} catch (e) { log('ERROR', e.stack); failures++; }
finally { await db.end().catch(() => {}); api.kill(); web.close(); stripe.close(); log(failures ? `FAILURES: ${failures}` : 'ALL PASSED'); process.exit(failures ? 1 : 0); }
