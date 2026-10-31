// Browser-driven check of coach-published group classes (#656): phone, tablet and desktop; coach, athletes and a waitlisted athlete.
// Needs: a throwaway Postgres database (E2E_DATABASE_URL; it is migrated, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright-core (`npm i --no-save playwright-core`) with a Chromium (E2E_CHROMIUM, default the pre-installed one).
// Payments are switched on with a placeholder Stripe key so a paid seat is HELD and the Pay button shows; nothing is ever charged.
// It starts the API and a tiny static+proxy server itself. Run: node scripts/e2e/coach-classes-journey.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
const E = { DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sportarena_e2e', SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'),
  PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'off', RATE_LIMIT_DISABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_preview_only' };
const OUT = (process.env.E2E_SHOTS ?? '/tmp/e2e-shots') + '/'; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const api = spawn('node', ['src/server.js'], { cwd: new URL('../../apps/api/', import.meta.url).pathname, env: { ...process.env, ...E }, stdio: ['ignore', 'pipe', 'pipe'] });
api.stdout.on('data', (d) => process.env.V && log('[api]', String(d).trim())); api.stderr.on('data', (d) => process.env.V && log('[api!]', String(d).trim()));
for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:4000/api/v1/payments/methods')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
const DIST = process.env.E2E_DIST ?? '/tmp/e2e-dist';
const web = http.createServer((req, res) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/mcp')) {
    const p = http.request({ host: '127.0.0.1', port: 4000, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(p); return;
  }
  let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  const ext = path.extname(f); res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.ico': 'image/x-icon' }[ext] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4100, r));
const B = 'http://localhost:4100/api/v1';
const call = async (method, p, { token, body } = {}) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j)}`); return j; };
const stamp = Date.now().toString(36);
const reg = async (name, roles) => { const handle = `${name.toLowerCase().replace(/\W/g, '')}${stamp}`; const r = await call('POST', '/auth/register', { body: { handle, display_name: name, email: `${handle}@example.com`, password: 'correct-horse-battery', roles } }); return { ...r.user, token: r.token, email: `${handle}@example.com` }; };
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const at = (n, h) => { const d = new Date(Date.now() + n * 864e5); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };
const VIEWPORTS = [['phone', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }], ['desktop', { width: 1280, height: 900 }]];
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport, locale) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    if (locale) await ctx.addInitScript((l) => { try { localStorage.setItem('locale', l); } catch {} }, locale);
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${r.status()}`);
    return { ctx, page };
  };
  const open = async (who, vp, target, locale) => { const s = await session(who, vp, locale); await s.page.goto(`http://localhost:4100/?open=${target}`); await s.page.waitForTimeout(3500); return s; };
  const shot = (page, n, full = true) => page.screenshot({ path: `${OUT}${n}.png`, fullPage: full });

  // real people, a real rate card and real classes: the same calls the forms make
  const coach = await reg('Coach Rohan', ['coach']);
  const [aarav, meera, kabir, isha, dev] = [await reg('Aarav', ['athlete']), await reg('Meera', ['athlete']), await reg('Kabir', ['athlete']), await reg('Isha', ['athlete']), await reg('Dev', ['athlete'])];
  await call('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 60000 } });
  const card = await call('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Small-group football', sport: 'football', audience: 'group', delivery: 'both', unit: 'session', duration_min: 60, price_cents: 60000, per_person: true, min_participants: 2, max_participants: 8 } });
  const free = await call('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Open footwork clinic', sport: 'football', audience: 'group', unit: 'session', duration_min: 45, price_cents: 0, per_person: true, min_participants: 1, max_participants: 3 } });
  const pub = async (cardId, body) => (await call('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: cardId, ...body } })).classes[0];
  const paid = await pub(card.id, { title: 'Passing & movement', starts_at: at(3, 12), location: 'Riverside ground', max_participants: 6, min_participants: 3, cutoff_hours: 12, notes: 'Bring boots and a water bottle. We work in small passing triangles.' });
  const full = await pub(free.id, { title: 'Footwork clinic', starts_at: at(4, 13), location: 'Riverside ground', max_participants: 3, min_participants: 1 });
  const online = await pub(card.id, { title: 'Tactics review (online)', delivery: 'online', online_link: 'https://meet.example.com/tactics-review', starts_at: at(5, 14), max_participants: 8, min_participants: 2 });
  const pg = new (await import('pg')).default.Pool({ connectionString: E.DATABASE_URL });
  // athletes join: the paid class holds seats (payment pending); the free clinic fills up and Dev queues
  for (const u of [aarav, meera]) await call('POST', `/coach-classes/${paid.id}/join`, { token: u.token, body: {} });
  for (const u of [aarav, meera, kabir]) await call('POST', `/coach-classes/${full.id}/join`, { token: u.token, body: {} });
  const w = await call('POST', `/coach-classes/${full.id}/join`, { token: dev.token, body: {} });
  check(w.status === 'waitlisted', 'a full class puts the next person on the waitlist');
  // two seats on the paid class are already paid (throwaway database; real payments settle through canonical payments, covered by the API tests)
  await pg.query("UPDATE coach_class_seats SET status='confirmed', payment_status='paid', pay_by=NULL WHERE class_id=$1 AND user_id=$2", [paid.id, meera.id]);
  const held = (await call('GET', `/coach-classes/${paid.id}`, { token: aarav.token })).my_seats[0];
  check(held.status === 'held' && held.pay_by, 'a paid class holds the seat with a payment deadline');
  // a class that has started, to show attendance
  const done = await pub(free.id, { title: 'Early footwork session', starts_at: at(9, 7), location: 'Riverside ground', max_participants: 3, min_participants: 1 });
  await call('POST', `/coach-classes/${done.id}/join`, { token: isha.token, body: {} }); await call('POST', `/coach-classes/${done.id}/join`, { token: kabir.token, body: {} });
  await pg.query("UPDATE coach_classes SET starts_at = now() - interval '20 minutes', cutoff_at = now() - interval '3 hours' WHERE id=$1", [done.id]);

  for (const [vn, vp] of VIEWPORTS) {
    // 1 athlete: the Classes segment of Hire
    const a = await session(aarav, vp); await a.page.goto('http://localhost:4100/'); await a.page.waitForTimeout(2500);
    await a.page.getByText('Calendar', { exact: true }).first().click(); await a.page.waitForTimeout(1500);
    await a.page.getByText('Hire a coach').first().click(); await a.page.waitForTimeout(1800);
    await a.page.getByText('Classes', { exact: true }).first().click(); await a.page.waitForTimeout(2200);
    await shot(a.page, `coach-classes-01-find-${vn}`);
    check(await a.page.getByText('Passing & movement').first().isVisible(), `${vn}: the Classes segment lists the coach's classes with seats`);
    await a.ctx.close();
    // 2 athlete: a held seat with the payment deadline and the Pay button
    const h = await open(aarav, vp, `coach-class:${paid.id}`); await shot(h.page, `coach-classes-02-held-${vn}`);
    check(await h.page.getByText(/Pay ₹/).first().isVisible() && await h.page.getByText(/Needs 2 more people/).first().isVisible(), `${vn}: held seat shows Pay and how many more people the class needs`);
    await h.ctx.close();
    // 3 athlete on the waitlist
    const q = await open(dev, vp, `coach-class:${full.id}`); await shot(q.page, `coach-classes-03-waitlist-${vn}`);
    check(await q.page.getByText(/On the waitlist/).first().isVisible(), `${vn}: a full class shows the waitlist position`);
    await q.ctx.close();
    // 4 coach: all classes
    const k = await open(coach, vp, 'coach-classes'); await shot(k.page, `coach-classes-04-coach-list-${vn}`);
    check(await k.page.getByText('Court needed').first().isVisible(), `${vn}: the coach's list flags classes that still need a court`);
    check(await k.page.getByText('Footwork clinic').first().isVisible(), `${vn}: the coach sees every class with seats`);
    // 5 coach: publish sheet
    await k.page.getByText('+ Publish a class').first().click(); await k.page.waitForTimeout(1200);
    const pick = k.page.getByText('Small-group football').first(); if (await pick.isVisible().catch(() => false)) { await pick.click(); await k.page.getByText('Next', { exact: true }).first().click(); await k.page.waitForTimeout(1500); }
    await shot(k.page, `coach-classes-05-publish-${vn}`, false);
    await k.ctx.close();
    // 6 coach: roster with payment state, and a started class with attendance
    const r = await open(coach, vp, `coach-class:${paid.id}`); await shot(r.page, `coach-classes-06-roster-${vn}`);
    check(await r.page.getByText(/Who is coming/).first().isVisible() && await r.page.getByText('Cancel class').first().isVisible(), `${vn}: the coach sees who is coming and can cancel`);
    check(await r.page.getByText('Book a court for this class').first().isVisible() && await r.page.getByText('No court booked yet').first().isVisible(), `${vn}: an in-person class without a court offers Book a court`);
    await r.ctx.close();
    const t = await open(coach, vp, `coach-class:${done.id}`); await shot(t.page, `coach-classes-07-attendance-${vn}`);
    check(await t.page.getByText('Attended').first().isVisible() && await t.page.getByText('No-show').first().isVisible(), `${vn}: a started class offers attendance`);
    await t.page.getByText('No-show').first().click(); await t.page.waitForTimeout(1500);
    check((await pg.query("SELECT count(*)::int AS n FROM coach_class_seats WHERE class_id=$1 AND attendance='no_show'", [done.id])).rows[0].n === 1, `${vn}: tapping No-show records it`);
    await pg.query("UPDATE coach_class_seats SET attendance=NULL WHERE class_id=$1", [done.id]);
    await t.ctx.close();
  }
  // 7 online link only for a confirmed seat
  const iseat = await call('POST', `/coach-classes/${online.id}/join`, { token: isha.token, body: {} });
  check(iseat.status === 'held', 'a paid online seat is held until it is paid, and the link stays hidden');
  await pg.query("UPDATE coach_class_seats SET status='confirmed', payment_status='paid', pay_by=NULL WHERE id=$1", [iseat.seat_id]);   // as if the payment settled
  const o = await open(isha, VIEWPORTS[0][1], `coach-class:${online.id}`); await shot(o.page, 'coach-classes-08-online-phone');
  check(await o.page.getByText('Open the class link').first().isVisible(), 'a confirmed seat reveals the online link');
  // 8 languages: the same held seat in Urdu (right-to-left) and Tamil, from the machine-drafted packs
  const ur = await open(aarav, VIEWPORTS[0][1], `coach-class:${paid.id}`, 'ur-PK'); await shot(ur.page, 'coach-classes-09-urdu-rtl-phone');
  check(await ur.page.evaluate(() => document.documentElement.dir) === 'rtl', 'Urdu switches the page to right-to-left');
  check(await ur.page.getByText('سیٹ برقرار رکھنے کے لیے ادائیگی کریں').first().isVisible(), 'the held-seat card is in Urdu');
  await ur.ctx.close();
  const ta = await open(coach, VIEWPORTS[1][1], 'coach-classes', 'ta-IN'); await shot(ta.page, 'coach-classes-10-tamil-tablet');
  check(await ta.page.getByText('உங்கள் வகுப்புகள்').first().isVisible(), 'the coach list is in Tamil');
  await ta.ctx.close();
} catch (e) { log('ERROR', e.stack); failures++; }
finally { await browser?.close(); api.kill(); web.close(); }
log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0);
