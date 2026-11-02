// Browser-driven check of the guardian's class queue (#656 follow-up): a young person asks to join a coach class, the guardian sees it beside game requests, opens it and approves.
// Same prerequisites as coach-classes-journey.mjs. Run: node scripts/e2e/coach-classes-guardian-journey.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire('/opt/node-tools/')('playwright');
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
const reg = async (h, name, roles = ['athlete']) => { const r = await call('POST', '/auth/register', { body: { handle: h, display_name: name, email: `${h}@example.com`, password: 'correct-horse-battery', roles } }); return { ...r.user, token: r.token, email: `${h}@example.com` }; };
const db = new pg.Pool({ connectionString: E.DATABASE_URL });
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const key = () => `e2e-${Math.random().toString(36).slice(2)}${Date.now()}`;
const wait = (p, ms = 1200) => p.waitForTimeout(ms);

const R = Date.now().toString(36);
const inH = (h) => new Date(Date.now() + h * 36e5).toISOString();
// a class at a venue runs on a court booked through the normal booking flow: open the venue, add a court, book it as the coach, return the booking
const courtBooking = async (mgr, venue, coach, startsAt, hours = 2) => {
  await call('POST', `/venues/${venue.id}/hours`, { token: mgr.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '06:00', closes: '22:00' })) } });
  const court = await call('POST', `/venues/${venue.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', hourly_rate_cents: 50000, max_players: 10 } });
  const res = await call('POST', '/reservations', { token: coach.token, body: { items: [{ resource_id: court.id, starts_at: startsAt, ends_at: new Date(+new Date(startsAt) + hours * 36e5).toISOString() }] } });
  return (await call('GET', `/reservations/${res.id}`, { token: coach.token })).bookings[0].id;
};
const at10 = (days) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); d.setUTCHours(10, 0, 0, 0); return d.toISOString(); };

const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
try {
  const coach = await reg(`cg_c${R}`, 'Coach Meera', ['coach']);
  const reg2 = async (h, name, dob) => { const r = await call('POST', '/auth/register', { body: { handle: h, display_name: name, email: `${h}@example.com`, password: 'correct-horse-battery', roles: ['athlete'], dob } }); return { ...r.user, token: r.token, email: `${h}@example.com` }; };
  const parent = await reg2(`cg_p${R}`, 'Priya Rao', yearsAgo(40)), child = await reg2(`cg_k${R}`, 'Aarav Rao', yearsAgo(12));
  // a verified guardian link and current participation consent, written directly: the approval flow itself is covered by the API tests
  await db.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by, decided_at) VALUES ($1,$2,'parent','active',$1,now())", [parent.id, child.id]);
  await db.query("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'participation',$2,1, now() + interval '90 days')", [child.id, parent.id]);
  await call('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'badminton', role: 'coach', level: 'pro', hourly_rate_cents: 80000 } });
  const mgr = await reg(`cg_m${R}`, 'Venue Admin', ['venue_manager']);
  const venue = await call('POST', '/venues', { token: mgr.token, body: { name: `Smash Arena ${R}`, city: 'Pune', timezone: 'UTC' } });
  const card = await call('POST', '/coach/rate-cards', { token: coach.token, body: { audience: 'group', unit: 'session', duration_min: 60, per_person: true, min_participants: 2, max_participants: 8, delivery: 'both', title: 'Junior badminton basics', sport: 'badminton', price_cents: 30000 } });
  const booking = await courtBooking(mgr, venue, coach, at10(3));
  const k = await call('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: card.id, starts_at: at10(3), booking_id: booking, audience: 'youth', min_age: 8, max_age: 14, max_participants: 8 } });
  const ask = await call('POST', `/coach/classes/${k.id}/join`, { token: child.token, body: {} });
  check(ask.status === 'guardian_pending', 'a young person asking for a class waits for their guardian (API)');

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error('login failed');
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(2500);
    return { ctx, page };
  };
  const shot = (page, n) => page.screenshot({ path: `${OUT}${n}.png`, fullPage: false });
  const vis = async (p, t, ms = 5000) => { try { await p.getByText(t).first().waitFor({ state: 'visible', timeout: ms }); return true; } catch { return false; } };
  const navTo = async (p, name, params = {}) => {
    await p.evaluate(({ name, params }) => {
      if (!window.__nav) {
        const root = document.getElementById('root') ?? document.body.firstElementChild;
        const key = Object.keys(root).find((k) => k.startsWith('__reactContainer'));
        const todo = [root[key]];
        while (todo.length && !window.__nav) { const n = todo.pop(); const v = n.memoizedProps?.value; if (v && typeof v.push === 'function' && typeof v.goTab === 'function') { window.__nav = v; break; } if (n.sibling) todo.push(n.sibling); if (n.child) todo.push(n.child); }
      }
      window.__nav.push(name, params);
    }, { name, params });
    await wait(p, 2200);
  };
  const VIEWS = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1360, height: 860 } };
  for (const [name, vp] of Object.entries(VIEWS)) {
    const { ctx, page: p } = await session(parent, vp);
    await navTo(p, 'FindGames');
    check(await vis(p, 'WAITING FOR YOUR APPROVAL') && await vis(p, 'Aarav Rao asked to join Junior badminton basics'), `${name}: the guardian sees the class request in the same queue as game requests`);
    await shot(p, `cls-07-guardian-queue-${name}`);
    if (name === 'phone') {
      await p.getByText('View class', { exact: true }).first().click(); await wait(p, 1500);
      check(await vis(p, 'Junior badminton basics'), 'the guardian can open the class before deciding'); await shot(p, 'cls-08-guardian-view-class-phone');
      await p.keyboard.press('Escape'); await wait(p, 500);
    }
    await ctx.close();
  }
  {
    const { ctx, page: p } = await session(parent, VIEWS.phone);
    await navTo(p, 'FindGames');
    await p.getByText('Approve', { exact: true }).first().click(); await wait(p, 2000);
    check(!(await vis(p, 'asked to join Junior badminton basics', 2500)), 'approving takes the request out of the queue');
    const row = (await db.query("SELECT status, applied_by FROM coach_class_seats WHERE id=$1", [ask.seat_id])).rows[0];
    check(row.status === 'confirmed' && row.applied_by === parent.id, 'the child holds the seat and the approving guardian is the payer');
    await ctx.close();
  }
  await browser.close();
} catch (e) { log('ERROR', e.message); failures++; } finally { await db.end().catch(() => {}); api.kill(); web.close(); }
process.exit(failures ? 1 : 0);
