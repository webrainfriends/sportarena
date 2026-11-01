// Browser-driven check of the unified payout desk (#701) at phone, tablet and desktop widths: due obligations from three sources, a batch,
// maker-checker approval, bank file download and recording a result. Writes PNGs to E2E_SHOTS (default /tmp/e2e-shots).
// Needs a throwaway migrated Postgres (E2E_DATABASE_URL, never dropped here), a same-origin web build in E2E_DIST and playwright(-core).
// Run: node scripts/e2e/payouts-journey.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import pg from 'pg';
const require = createRequire(import.meta.url);
const { chromium } = (() => { for (const m of ['playwright-core', 'playwright', '/opt/node-tools/node_modules/playwright']) { try { return require(m); } catch { /* next */ } } throw new Error('install playwright-core'); })();
const stamp = Date.now().toString(36);
const E = { DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sportarena_e2e', SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'),
  PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'off', RATE_LIMIT_DISABLED: 'true', SETTLEMENT_PAYOUTS: 'on', SETTLEMENT_CURRENCIES: 'INR',
  PLATFORM_ADMIN_EMAILS: `payoutmaker${stamp}@example.com,payoutchecker${stamp}@example.com` };
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
const reg = async (h, roles) => { const r = await call('POST', '/auth/register', { body: { handle: `${h}${stamp}`, display_name: h, email: `${h}${stamp}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); return { ...r.user, token: r.token, email: `${h}${stamp}@example.com` }; };
const db = new pg.Pool({ connectionString: E.DATABASE_URL });
const sql = async (q, p) => (await db.query(q, p)).rows;
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
try {
  const { encrypt } = await import('../../apps/api/src/crypto.js').catch(() => ({}));
  const staff = async (h) => { const u = await reg(h, ['athlete']); await sql("UPDATE users SET roles='{athlete,admin}' WHERE id=$1", [u.id]); const l = await call('POST', '/auth/login', { body: { email: u.email, password: 'correct-horse-battery' } }); return { ...u, token: l.token }; };
  const maker = await staff('payoutmaker'), checker = await staff('payoutchecker');
  const sport = (await sql('SELECT id FROM sports LIMIT 1'))[0].id;
  const account = async (u) => call('POST', '/me/payout-accounts', { token: u.token, body: { currency: 'INR', holder_name: u.display_name, account_number: `5010${Math.floor(Math.random() * 1e8)}`, bank_code: 'HDFC0001234' } }).then(async (a) => { await call('POST', `/admin/payout-accounts/${a.id}/decision`, { token: checker.token, body: { decision: 'verify', reason: 'Holder name checked' } }); });
  const ref = await reg('refereeasha', ['referee']); await account(ref);
  const org = await reg('organiserdev', ['organizer']);
  const ev = (await sql('INSERT INTO events(name, sport_id, organizer_id) VALUES ($1,$2,$3) RETURNING id', ['Harbour Cup', sport, org.id]))[0];
  const fx = (await sql('INSERT INTO fixtures(event_id, scheduled_at) VALUES ($1, now()) RETURNING id', [ev.id]))[0];
  await sql("INSERT INTO fixture_officials(fixture_id, user_id, role, status, fee_minor, fee_currency, pay_status) VALUES ($1,$2,'referee','accepted',250000,'INR','due')", [fx.id, ref.id]);
  const ref2 = await reg('refereeravi', ['referee']); await account(ref2);
  const fx2 = (await sql('INSERT INTO fixtures(event_id, scheduled_at) VALUES ($1, now()) RETURNING id', [ev.id]))[0];
  await sql("INSERT INTO fixture_officials(fixture_id, user_id, role, status, fee_minor, fee_currency, pay_status) VALUES ($1,$2,'umpire','accepted',180000,'INR','due')", [fx2.id, ref2.id]);
  const owner = await reg('venueowner', ['venue_manager']); await account(owner);
  const venue = (await sql('INSERT INTO venues(name, owner_id) VALUES ($1,$2) RETURNING id', ['Marine Arena', owner.id]))[0];
  const partner = (await sql("INSERT INTO partners(code, name, owner_id) VALUES ($1,'Marine Arena Ltd',$2) RETURNING id", [`MA${stamp}`, owner.id]))[0];
  const contract = (await sql("INSERT INTO partner_contracts(contract_no, partner_id, terms, body, body_sha256, effective_from) VALUES ($1,$2,'{}','x','x',current_date) RETURNING id", [`C${stamp}`, partner.id]))[0];
  await sql("INSERT INTO settlements(settlement_no, partner_id, venue_id, contract_id, currency, period_end, commission_bp, net_payable_cents, status, approved_at) VALUES ($1,$2,$3,$4,'INR',current_date,0,1840000,'approved',now())", [`S-${stamp}`, partner.id, venue.id, contract.id]);
  const coach = await reg('coachmeera', ['coach']); await account(coach);
  await sql("INSERT INTO provider_ledger(seller_id, currency, kind, amount_cents, gross_cents, idempotency_key) VALUES ($1,'INR','sale',480000,480000,$2)", [coach.id, `e2e-${stamp}`]);
  const noacct = await reg('physiorahul', ['physio']);
  await sql("INSERT INTO provider_ledger(seller_id, currency, kind, amount_cents, gross_cents, idempotency_key) VALUES ($1,'INR','sale',95000,95000,$2)", [noacct.id, `e2e2-${stamp}`]);
  await call('POST', '/admin/payout-settings/INR', { token: maker.token, body: { currency: 'INR', withholding_bp: 1000, fee_flat_minor: 5000 } });
  const first = await call('POST', '/admin/payout-batches', { token: maker.token, body: { currency: 'INR', client_key: `e2e-b1-${stamp}`, items: [{ source_type: 'official_fee', source_id: (await sql('SELECT id FROM fixture_officials WHERE user_id=$1', [ref.id]))[0].id }] } });

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: true }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${r.status()}`);
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(2500);
    return { ctx, page };
  };
  const wait = (p, ms = 1500) => p.waitForTimeout(ms);
  const vis = async (p, t) => (await p.getByText(t).count()) > 0;
  const navTo = async (p, name) => { await p.evaluate((name) => {
    if (!window.__nav) { const root = document.getElementById('root') ?? document.body.firstElementChild; const key = Object.keys(root).find((k) => k.startsWith('__reactContainer')); const todo = [root[key]];
      while (todo.length && !window.__nav) { const n = todo.pop(); const v = n.memoizedProps?.value; if (v && typeof v.push === 'function' && typeof v.goTab === 'function') { window.__nav = v; break; } if (n.sibling) todo.push(n.sibling); if (n.child) todo.push(n.child); } }
    window.__nav.push(name, {}); }, name); await wait(p, 2500); };
  const open = async (p) => { await navTo(p, 'PartnerConsole'); await p.getByText('Payouts', { exact: true }).first().click(); await wait(p, 2500); };
  const shot = async (p, n, scrolls = 0) => { await p.screenshot({ path: `${OUT}${n}.png` });
    for (let i = 1; i <= scrolls; i++) { await p.mouse.move(p.viewportSize().width / 2, p.viewportSize().height / 2); await p.mouse.wheel(0, p.viewportSize().height * 0.8); await wait(p, 600); await p.screenshot({ path: `${OUT}${n}-scroll${i}.png` }); } };

  const { page: p } = await session(maker, { width: 390, height: 844 }); await open(p);
  check(await vis(p, 'Ready to pay'), 'the payout desk opens under Payouts');
  check(await vis(p, 'Officials fee') && await vis(p, 'Venue settlement') && await vis(p, 'Seller earnings'), 'officials, venues and sellers are listed together');
  check(await vis(p, 'No verified bank account'), 'a payee without a verified account is blocked, not hidden');
  await shot(p, '01-ready-phone', 2);
  await p.getByText('+', { exact: true }).first().click(); await wait(p, 600);
  await p.getByText(/Create batch \(1\)/).first().scrollIntoViewIfNeeded().catch(() => {}); await shot(p, '02-selected-phone');
  await p.getByText(/Batch \d+ ·/).first().scrollIntoViewIfNeeded().catch(() => {});
  await p.getByText(/Batch \d+ ·/).first().click(); await wait(p, 2000);
  check(await vis(p, 'Tax withheld') && await vis(p, 'Paid to banks'), 'a batch shows gross, tax withheld, fees and what banks receive');
  check(await vis(p, 'A second platform team member must approve this batch.'), 'maker-checker is explained');
  await shot(p, '03-batch-phone');
  await p.context().close();
  const { page: q } = await session(checker, { width: 390, height: 844 }); await open(q);
  await q.getByText(/Batch \d+ ·/).first().click(); await wait(q, 2000);
  await q.getByText('Approve', { exact: true }).first().click(); await wait(q, 1500);
  const st = (await sql('SELECT status FROM payout_batches WHERE id=$1', [first.id]))[0].status; check(st === 'approved', 'a second person approves the batch');
  await shot(q, '04-approved-phone');
  const [dl] = await Promise.all([q.waitForEvent('download'), q.getByText('Download bank file', { exact: true }).first().click()]);
  check(/payout_ref,payee,account_holder/.test(fs.readFileSync(await dl.path(), 'utf8')), 'the bank file downloads');
  await wait(q, 1500);
  await q.getByText('Record result', { exact: true }).first().click(); await wait(q, 1000); await shot(q, '05-result-phone');
  await q.context().close();
  for (const [n, vp] of [['tablet', { width: 820, height: 1100 }], ['desktop', { width: 1280, height: 900 }]]) {
    const { page: w } = await session(maker, vp); await open(w); await shot(w, `06-ready-${n}`);
    await w.getByText(/Batch \d+ ·/).first().click(); await wait(w, 1800); await shot(w, `07-batch-${n}`); await w.context().close();
  }
  const { page: r } = await session(maker, { width: 390, height: 844 }); await open(r);
  await r.getByText(/Payout rules/).first().click(); await wait(r, 1000); await shot(r, '08-rules-phone'); await r.context().close();
  await browser.close();
} catch (e) { console.error(e); failures++; }
finally { api.kill(); web.close(); await db.end(); log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0); }
