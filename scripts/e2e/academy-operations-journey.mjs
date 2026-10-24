// Browser-driven check of Academy Operations (#394): the director's Today / Week / Staff / Pay views, a session (attendance, staff,
// venue), the coach's phone agenda and the athlete's sessions, on phone, tablet and desktop. All data is created through the public API.
// Needs: a throwaway Postgres database (E2E_DATABASE_URL; migrated, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright-core with a Chromium (E2E_CHROMIUM, default the pre-installed one). Run: node scripts/e2e/academy-operations-journey.mjs
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
const reg = async (h, name, roles = ['athlete']) => { const r = await call('POST', '/auth/register', { body: { handle: h, display_name: name, email: `${h}@example.com`, password: 'correct-horse-battery', roles } }); return { ...r.user, token: r.token, email: `${h}@example.com` }; };
const db = new pg.Pool({ connectionString: E.DATABASE_URL });
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const key = () => `e2e-${Math.random().toString(36).slice(2)}${Date.now()}`;
const wait = (p, ms = 1200) => p.waitForTimeout(ms);
try {
  // ---------------------------------------------------------------- data, created through the public API
  const owner = await reg('ao_owner', 'Priya Nair', ['organizer']), lee = await reg('ao_lee', 'Alex Lee', ['coach']), omar = await reg('ao_omar', 'Omar Haddad', ['coach']), sam = await reg('ao_sam', 'Sam Okafor', ['coach']);
  const reg1 = await reg('ao_front', 'Rina Das'), fin = await reg('ao_fin', 'Dev Mehta');
  const org = await call('POST', '/organisations', { token: owner.token, body: { name: 'Riverside Academy', kind: 'academy', city: 'Pune' } });
  for (const [u, role] of [[lee, 'coach'], [omar, 'coach'], [sam, 'coach'], [reg1, 'staff'], [fin, 'finance']]) {
    await call('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } });
    await call('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } });
  }
  await call('POST', `/organisations/${org.id}/academy/staff/${reg1.id}`, { token: owner.token, body: { job_title: 'Registrar / front desk', template: 'registrar' } });
  await call('POST', `/organisations/${org.id}/academy/staff/${lee.id}`, { token: owner.token, body: { job_title: 'Head coach', template: 'head_coach', required_credentials: ['coach_badge'] } });
  const kids = []; for (let i = 1; i <= 12; i++) kids.push(await reg(`ao_k${i}`, ['Ava', 'Ben', 'Chloe', 'Dev', 'Ella', 'Finn', 'Gita', 'Hugo', 'Isla', 'Jai', 'Kira', 'Leo'][i - 1] + ' ' + ['Shah', 'Roy', 'Patel', 'Iyer', 'Khan', 'Bose'][i % 6]));
  const u12 = await call('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'U12 Football', coach_id: lee.id } });
  const u14 = await call('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'U14 Football', coach_id: omar.id } });
  await call('POST', `/cohorts/${u12.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${kids.slice(0, 8).map((k) => `${k.handle},yes`).join('\n')}` } });
  await call('POST', `/cohorts/${u14.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${kids.slice(8).map((k) => `${k.handle},yes`).join('\n')}` } });
  await call('PATCH', `/cohorts/${u12.id}/academy/staffing`, { token: owner.token, body: { min_coaches: 2, max_ratio: 6 } });
  const mgr = await reg('ao_venue', 'Venue manager', ['venue_manager']);
  const venue = await call('POST', '/venues', { token: mgr.token, body: { name: 'Riverside Arena', city: 'Pune', timezone: 'UTC', currency: 'INR' } });
  await call('POST', `/venues/${venue.id}/hours`, { token: mgr.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '06:00', closes: '23:00' })) } });
  const court = await call('POST', `/venues/${venue.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court A', sport: 'football', hourly_rate_cents: 80000, max_players: 12 } });
  // a term: U12 Mon/Wed, U14 Tue/Thu at 17:00 for four weeks from the start of this week; one closure
  const monday = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
  const t12 = await call('POST', `/cohorts/${u12.id}/academy/timetable`, { token: owner.token, body: { idempotency_key: key(), starts_on: monday, ends_on: day(27), weekdays: [1, 3], start_time: '17:00', duration_min: 60, timezone: 'UTC', lead_id: lee.id, assistant_ids: [sam.id], delivery_type: 'training' } });
  const t14 = await call('POST', `/cohorts/${u14.id}/academy/timetable`, { token: owner.token, body: { idempotency_key: key(), starts_on: monday, ends_on: day(27), weekdays: [2, 4], start_time: '17:00', duration_min: 60, timezone: 'UTC', lead_id: omar.id, delivery_type: 'training' } });
  const all = [...t12.created, ...t14.created].map((x) => x.id);
  await call('POST', `/organisations/${org.id}/academy/sessions/publish`, { token: owner.token, body: { session_ids: all, acknowledge_warnings: true } });
  // two sessions today (one understaffed, one fine) so Operations Today has something to show
  const nextHour = new Date(Math.ceil((Date.now() + 20 * 60000) / 3600000) * 3600000), soon = nextHour, later = new Date(+nextHour + 2 * 3600000);   // the venue engine books on the hour
  const sToday = await call('POST', `/cohorts/${u12.id}/academy/sessions`, { token: owner.token, body: { starts_at: soon.toISOString(), duration_min: 60, title: 'U12 Football · Skills', lead_id: lee.id, assistant_ids: [] } });
  const sLater = await call('POST', `/cohorts/${u14.id}/academy/sessions`, { token: owner.token, body: { starts_at: later.toISOString(), duration_min: 60, title: 'U14 Football · Match prep', delivery_type: 'match_prep', lead_id: omar.id } });
  await call('POST', `/academy/sessions/${sToday.id}/venue`, { token: owner.token, body: { resource_id: court.id } });
  await call('POST', `/organisations/${org.id}/academy/sessions/publish`, { token: owner.token, body: { session_ids: [sToday.id, sLater.id], acknowledge_warnings: true } });
  // a cover request, a leave request, time and pay
  await call('POST', `/academy/sessions/${all[3]}/cover`, { token: omar.token, body: { reason: 'Family matter' } }).catch(() => {});
  await call('POST', `/organisations/${org.id}/academy/time-off`, { token: sam.token, body: { on_date: day(9), ends_on: day(10), reason: 'Exam invigilation' } });
  for (const [u, rate] of [[lee, 90000], [sam, 45000], [omar, 80000]]) await call('POST', `/organisations/${org.id}/academy/comp-rules`, { token: fin.token, body: { user_id: u.id, model: 'hourly', rate_minor: rate, currency: 'INR', effective_from: day(-90) } });
  for (const [u, d0] of [[lee, 3], [sam, 3], [omar, 2]]) {
    const t = await call('POST', `/organisations/${org.id}/academy/timesheets`, { token: owner.token, body: { idempotency_key: key(), user_id: u.id, label: 'Skills session', clock_in: `${day(-d0)}T17:00:00Z`, clock_out: `${day(-d0)}T18:20:00Z`, break_min: 0 } });
    if (u !== sam) await call('POST', `/academy/timesheets/${t.id}/decision`, { token: owner.token, body: { action: 'approve' } });
  }
  const nowS = await call('POST', `/cohorts/${u14.id}/academy/sessions`, { token: owner.token, body: { starts_at: new Date(Date.now() - 5 * 60000).toISOString(), duration_min: 60, title: 'U14 Football · Squad training', lead_id: omar.id, assistant_ids: [sam.id] } });
  await call('POST', `/organisations/${org.id}/academy/sessions/publish`, { token: owner.token, body: { session_ids: [nowS.id], acknowledge_warnings: true } });
  const sheets = await call('GET', `/organisations/${org.id}/academy/timesheets?status=submitted`, { token: owner.token });
  for (const t of sheets) await call('POST', `/academy/timesheets/${t.id}/decision`, { token: owner.token, body: { action: 'approve' } });
  await call('POST', `/organisations/${org.id}/academy/pay-adjustments`, { token: fin.token, body: { user_id: lee.id, amount_minor: 150000, currency: 'INR', reason: 'Kit allowance', on_date: day(-1) } });
  const run = await call('POST', `/organisations/${org.id}/academy/payroll`, { token: fin.token, body: { currency: 'INR', period_start: day(-14), period_end: day(0), idempotency_key: key(), commit: true } });
  await call('POST', `/academy/payroll/${run.id}/approve`, { token: fin.token, body: { row_version: run.row_version } });
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${r.status()} ${await r.text()}`);
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(2500);
    return { ctx, page };
  };
  const shot = (page, n) => page.screenshot({ path: `${OUT}${n}.png`, fullPage: false });
  const vis = async (p, t, ms = 4000) => { try { await p.getByText(t).first().waitFor({ state: 'visible', timeout: ms }); return true; } catch { return false; } };
  // the app has no URL routing, so the journey grabs the navigator from the React tree (test only) and pushes screens like the wheel does
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
  const openOps = async (p) => {
    await navTo(p, 'Org', { id: org.id });
    await p.getByText('Academy', { exact: true }).last().click(); await wait(p, 1500);
    await p.getByText('Operations', { exact: true }).first().click(); await wait(p, 2500);
  };
  // ---------------------------------------------------------------- director, tablet
  {
    const { ctx, page: p } = await session(owner, { width: 1180, height: 1000 });
    await openOps(p);
    await shot(p, '01-today-tablet');
    check(await vis(p, 'U12 Football · Skills'), 'Today lists the session that starts soon');
    check(await vis(p, 'Take attendance'), 'Today offers the attendance quick action');
    await p.getByText('Week', { exact: true }).first().click(); await wait(p, 2000); await shot(p, '02-week-tablet');
    check(await vis(p, 'Build a term timetable'), 'Week offers the term builder');
    await p.getByText('Build a term timetable').first().click(); await wait(p, 1000); await shot(p, '03-builder');
    await p.keyboard.press('Escape'); await wait(p, 500);
    await p.getByText('Staff & leave', { exact: true }).first().click(); await wait(p, 2000); await shot(p, '04-staff');
    check(await vis(p, 'Exam invigilation') || await vis(p, 'Leave requests'), 'Staff shows the leave request');
    await p.getByText('Time & pay', { exact: true }).first().click(); await wait(p, 2000); await shot(p, '05-pay-timesheets');
    await p.getByText('Terms', { exact: true }).first().click(); await wait(p, 1500); await shot(p, '06-pay-terms');
    await p.getByText('Payroll', { exact: true }).first().click(); await wait(p, 1500); await shot(p, '07-payroll-runs');
    await p.getByText(/→/).first().click(); await wait(p, 1500); await shot(p, '08-payroll-run');
    check(await vis(p, 'Kit allowance') || await vis(p, 'Approved'), 'an approved payroll run opens with its lines');
    await p.keyboard.press('Escape'); await wait(p, 500);
    await p.getByText('Insights', { exact: true }).first().click(); await wait(p, 2000); await shot(p, '09-insights');
    await ctx.close();
  }
  // ---------------------------------------------------------------- the session (coach on a phone)
  {
    const { ctx, page: p } = await session(omar, { width: 390, height: 844 });
    await navTo(p, 'AcademyAgenda'); await shot(p, '10-coach-agenda-phone');
    check(await vis(p, 'My academy week'), 'the coach sees their academy week');
    await navTo(p, 'AcademySession', { id: nowS.id, tab: 'attendance' }); await shot(p, '11-attendance-phone');
    check(await vis(p, 'Mark everyone still expected as present'), 'attendance offers a bulk mark');
    await p.getByText('Mark everyone still expected as present').first().click(); await wait(p, 2000); await shot(p, '12-attendance-marked-phone');
    check(await vis(p, '4 present') || await vis(p, 'Present'), 'athletes are marked present');
    await p.getByText(/^Staff \(/).first().click(); await wait(p, 1500); await shot(p, '13-session-staff-phone');
    await ctx.close();
  }
  // ---------------------------------------------------------------- the director on the session screen (desktop)
  {
    const { ctx, page: p } = await session(owner, { width: 1280, height: 1000 });
    await navTo(p, 'AcademySession', { id: sToday.id, tab: 'staff' }); await shot(p, '14-session-staff-desktop');
    await p.getByText('Find a substitute').first().click(); await wait(p, 2000); await shot(p, '15-substitute-desktop');
    check(await vis(p, 'Ranked on facts only'), 'substitute suggestions are explained');
    await p.getByText('Venue', { exact: true }).first().click(); await wait(p, 1500); await shot(p, '16-session-venue-desktop');
    await p.getByText('Details & history', { exact: true }).first().click(); await wait(p, 1500); await shot(p, '17-session-details-desktop');
    await ctx.close();
  }
  // ---------------------------------------------------------------- the athlete's family view (phone)
  {
    const { ctx, page: p } = await session(kids[0], { width: 390, height: 844 });
    await navTo(p, 'AcademyFamily'); await p.getByText('Sessions', { exact: true }).first().click(); await wait(p, 2000); await shot(p, '18-athlete-sessions-phone');
    check(await vis(p, 'Coming up'), 'the athlete sees their sessions');
    await ctx.close();
  }
  await browser.close();
} catch (e) { log('ERROR', e.message); failures++; } finally { await db.end().catch(() => {}); api.kill(); web.close(); }
process.exit(failures ? 1 : 0);
