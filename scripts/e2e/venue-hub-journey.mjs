// Browser-driven check of the venue owner's home: a NEW venue user sees the registration wizard with the Find coach / Find supplier / Tender zone
// cards; once courts, a timetable and prices exist the same Home becomes the command centre (today's numbers, attention centre, live facility
// timeline, bookings and events, revenue, demand, suppliers, upkeep, customers, compliance). Phone, tablet and desktop widths, light theme.
// Data is created through the public API (plus the few rows the API cannot create without a payment provider or the live clock: bookings, a review, a shift).
// Needs a throwaway Postgres (E2E_DATABASE_URL), a same-origin web build in E2E_DIST and playwright with a Chromium.
// Run: node scripts/e2e/venue-hub-journey.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire('/opt/node-tools/')('playwright');
import pg from 'pg';
const E = {
  DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sportarena_e2e', SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'),
  PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'off', PLATFORM_ADMIN_EMAILS: 'rraja.edge@gmail.com,rrajas1978@icloud.com',
};
const OUT = (process.env.E2E_SHOTS ?? '/tmp/e2e-shots') + '/'; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const api = spawn('node', ['src/server.js'], { cwd: new URL('../../apps/api/', import.meta.url).pathname, env: { ...process.env, ...E }, stdio: ['ignore', 'pipe', 'pipe'] });
api.stdout.on('data', (d) => process.env.V && log('[api]', String(d).trim())); api.stderr.on('data', (d) => process.env.V && log('[api!]', String(d).trim()));
for (let i = 0; i < 90; i++) { try { if ((await fetch('http://127.0.0.1:4000/api/v1/payments/methods')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
const DIST = process.env.E2E_DIST ?? '/tmp/e2e-dist';
const web = http.createServer((req, res) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/mcp')) { const p = http.request({ host: '127.0.0.1', port: 4000, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); req.pipe(p); return; }
  let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  const ext = path.extname(f); res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf' }[ext] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4100, r));
const B = 'http://localhost:4100/api/v1';
const call = async (method, p, { token, body } = {}) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j).slice(0, 300)}`); return j; };
const reg = async (h, name, roles = ['athlete'], email) => { const r = await call('POST', '/auth/register', { body: { handle: h, display_name: name, email: email ?? `${h}@example.com`, password: 'correct-horse-battery', roles } }); return { ...r.user, token: r.token, email: email ?? `${h}@example.com` }; };
const db = new pg.Pool({ connectionString: E.DATABASE_URL });
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const wait = (p, ms = 1200) => p.waitForTimeout(ms);
const tag = Math.random().toString(36).slice(2, 7);


try {
  const mgr = await reg(`vh_new_${tag}`, 'Meera Kapoor', ['venue_manager']);
  const owner = await reg(`vh_own_${tag}`, 'Arjun Mehta', ['venue_manager']);
  const guest = await reg(`vh_guest_${tag}`, 'Kiran Rao', ['athlete']);
  const guest2 = await reg(`vh_guest2_${tag}`, 'Dev Patel', ['athlete']);

  // the open venue: courts, hours, a weekly timetable and prices, then real activity around it
  const venue = await call('POST', '/venues', { token: owner.token, body: { name: 'Marine Drive Courts', city: 'Mumbai', timezone: 'UTC', currency: 'INR', legal_name: 'Marine Drive Sports LLP' } });
  const courts = [];
  for (const n of ['Court 1', 'Court 2', 'Court 3', 'Indoor Hall']) courts.push(await call('POST', `/venues/${venue.id}/resources`, { token: owner.token, body: { kind: n === 'Indoor Hall' ? 'room' : 'court', name: n, sport: n === 'Indoor Hall' ? 'badminton' : 'tennis', hourly_rate_cents: 60000 } }));
  await call('POST', `/venues/${venue.id}/hours`, { token: owner.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '00:00', closes: '24:00' })) } });
  await call('POST', `/venues/${venue.id}/timetable/weekly`, { token: owner.token, body: { all_courts: true, rows: [{ weekdays: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }] } });
  const q = (s, a) => db.query(s, a);
  const book = (r, u, startH, hours, pay = 'paid') => q(`INSERT INTO bookings (resource_id, user_id, starts_at, ends_at, quantity, status, base_cents, price_cents, payable_cents, payment_status)
    VALUES ($1,$2, now() + ($3 || ' hours')::interval, now() + ($3::float + $4::float || ' hours')::interval, 1, 'confirmed', 60000, 60000, 60000, $5)`, [r, u, String(startH), String(hours), pay]);
  await book(courts[0].id, guest.id, -0.5, 1.5); await book(courts[0].id, guest2.id, 4, 1, 'unpaid'); await book(courts[1].id, guest.id, -3, 1);
  for (let d = 1; d <= 20; d++) { const r = courts[d % 3].id; await q(`INSERT INTO bookings (resource_id, user_id, starts_at, ends_at, quantity, status, base_cents, price_cents, payable_cents, payment_status)
    VALUES ($1,$2, now() - ($3 || ' days')::interval, now() - ($3 || ' days')::interval + interval '1 hour', 1, 'confirmed', 60000, 60000, 60000, 'paid')`, [r, d % 2 ? guest.id : guest2.id, String(d)]); }
  await q("INSERT INTO venue_maintenance (venue_id, resource_id, title, status, priority, due_on) VALUES ($1,$2,'Resurface Court 3','in_progress','urgent', current_date - 1)", [venue.id, courts[2].id]);
  await q("INSERT INTO venue_maintenance (venue_id, resource_id, title, status, priority, due_on) VALUES ($1,$2,'Floodlight inspection','scheduled','high', current_date + 3)", [venue.id, courts[0].id]);
  await q("INSERT INTO testimonials (subject_type, subject_id, author_id, rating, body, status, visibility) VALUES ('venue',$1,$2,2,'Showers were cold','published','public')", [venue.id, guest.id]);
  await q("INSERT INTO testimonials (subject_type, subject_id, author_id, rating, body, status, visibility, reply_body, reply_by, replied_at) VALUES ('venue',$1,$2,5,'Great courts','published','public','Thank you!',$3, now())", [venue.id, guest2.id, owner.id]);
  const day2 = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  await call('POST', `/venues/${venue.id}/compliance`, { token: owner.token, body: { kind: 'fire', title: 'Fire safety certificate', reference: 'FS-2291', expires_on: day2(12) } });
  await call('POST', `/venues/${venue.id}/compliance`, { token: owner.token, body: { kind: 'food', title: 'Cafe food licence', expires_on: day2(200) } });
  await call('POST', `/venues/${venue.id}/blocks`, { token: owner.token, body: { resource_ids: [courts[1].id], from_date: day2(0), to_date: day2(0), start_time: '20:00', end_time: '23:00', kind: 'private', reason: 'Corporate sports day' } });

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const SIZES = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1366, height: 900 } };
  const open = async (viewport, url, who) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    if (who) { const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${who.email}`); }
    await page.goto(url); await wait(page, 2800);
    return { ctx, page };
  };
  const shot = (page, n, full = false) => page.screenshot({ path: `${OUT}${n}.png`, fullPage: full });
  const vis = async (p, t, ms = 4000) => { try { await p.getByText(t).first().waitFor({ state: 'visible', timeout: ms }); return true; } catch { return false; } };
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
  const goTab = async (p, tab, params = {}) => {
    await navTo(p, 'Notifications');
    await p.evaluate(({ tab, params }) => window.__nav.goTab(tab, params), { tab, params });
    await wait(p, 2200);
  };
  const noOverflow = async (p, label) => { const w = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); check(w <= 1, `${label}: no horizontal page scroll`); };
  const tall = async (p, text, label) => { const b = await p.getByText(text).first().boundingBox().catch(() => null); check(!!b && b.height >= 28, `${label}: reachable control`); };


  // ---------------------------------------------------------------- 1. a new venue user: wizard + find cards
  for (const [size, vp] of Object.entries(SIZES)) {
    const { ctx, page: p } = await open(vp, 'http://localhost:4100/', mgr);
    check(await vis(p, 'Open your venue for bookings'), `${size}: the new venue user lands on the registration wizard`);
    check(await vis(p, 'Venue name'), `${size}: the venue basics are asked inline`);
    check(await vis(p, 'Find a coach') && await vis(p, 'Find a supplier') && await vis(p, 'Tender zone'), `${size}: Find coach, Find supplier and Tender zone cards are on the landing page`);
    check(!(await p.getByText('Profile completion').count()), `${size}: no profile-completion block at the centre`);
    await shot(p, `01-new-venue-${size}`); await p.setViewportSize({ width: vp.width, height: size === 'desktop' ? 1500 : 2200 }); await wait(p, 1200); await shot(p, `01-new-venue-${size}-tall`);
    await noOverflow(p, `${size} new venue home`);
    await ctx.close();
  }
  // registering through the wizard creates the venue and continues into the guided setup
  { const { ctx, page: p } = await open(SIZES.tablet, 'http://localhost:4100/', mgr);
    await p.getByLabel('Venue name').first().fill(`Harbour ${tag}`); await wait(p, 300);
    await p.getByText('Create venue', { exact: true }).first().click(); await wait(p, 3500);
    check(await vis(p, `Finish setting up Harbour ${tag}`), 'registering in the wizard creates the venue and continues the setup on the same page');
    check((await db.query("SELECT count(*)::int AS n FROM venues WHERE name='Harbour "+tag+"'")).rows[0].n === 1, 'the venue was created once');
    await shot(p, '02-wizard-after-register-tablet'); await ctx.close(); }

  // ---------------------------------------------------------------- 2. the command centre of an open venue
  for (const [size, vp] of Object.entries(SIZES)) {
    const { ctx, page: p } = await open(vp, 'http://localhost:4100/', owner);
    await wait(p, 1500);
    check(await vis(p, 'Marine Drive Courts'), `${size}: the venue name heads the home`);
    check(await vis(p, 'Revenue today') && await vis(p, 'Actions required'), `${size}: the four headline cards show`);
    check(await vis(p, 'Review my day'), `${size}: the AI venue manager card offers "Review my day"`);
    check(await vis(p, 'Attention centre'), `${size}: the attention centre is there`);
    check(await vis(p, 'Resurface Court 3') || await vis(p, 'maintenance job is overdue'), `${size}: overdue maintenance is surfaced`);
    check(await vis(p, 'Live facility availability'), `${size}: live facility availability section`);
    check(await vis(p, 'Court 1'), `${size}: courts are listed with their state`);
    await shot(p, `03-command-centre-${size}`); await p.setViewportSize({ width: vp.width, height: size === 'phone' ? 5600 : size === 'tablet' ? 4200 : 3300 }); await wait(p, 1500); await shot(p, `03-command-centre-${size}-tall`); await p.setViewportSize(vp); await wait(p, 600);
    await noOverflow(p, `${size} command centre`);
    if (size === 'phone') {
      await p.getByText('Review my day', { exact: true }).first().click(); await wait(p, 1200);
      await shot(p, '04-review-my-day-phone');
      check(await vis(p, 'maintenance job is overdue'), 'Review my day lists every attention item with its action');
    }
    await ctx.close();
  }
  // an outsider cannot read it
  const outsider = await fetch(`http://127.0.0.1:4000/api/v1/venues/${venue.id}/command-centre`, { headers: { authorization: `Bearer ${guest.token}` } });
  check(outsider.status === 403, 'a non-member is refused by the API (403)');

  // the Urdu pack in right-to-left
  { const ctx = await browser.newContext({ viewport: SIZES.phone, locale: 'ur-PK' }); const page = await ctx.newPage();
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: owner.email, password: 'correct-horse-battery' } });
    await page.addInitScript(() => { try { localStorage.setItem('locale', 'ur'); } catch {} });
    await page.goto('http://localhost:4100/'); await wait(page, 3500); await page.setViewportSize({ width: 390, height: 3000 }); await wait(page, 1200); await shot(page, '05-command-centre-urdu-phone-tall'); await ctx.close(); }

  await browser.close();
} catch (e) { log('ERROR', e); failures++; }
log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
api.kill(); web.close(); await db.end();
process.exit(failures ? 1 : 0);
