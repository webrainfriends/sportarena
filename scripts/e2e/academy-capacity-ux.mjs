// Photographs the capacity & workforce scenario screens (#805) from the real app at phone, tablet and desktop widths, light and dark,
// with real data created through the public API (its own throwaway database; nothing is seeded into the product).
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir /tmp/e2e-dist
//   E2E_DATABASE_URL=postgres://postgres@127.0.0.1:5432/sportarena_e2e UX_SHOTS=docs/ux node scripts/e2e/academy-capacity-ux.mjs
// desktop, and records which screen files they came from (apps/api/assets/guides/academy/manifest.json). Run after any change to an
// organisation / academy / venue / coach / tax screen:   npm run guide:shots
// Needs a throwaway Postgres (E2E_DATABASE_URL, migrated here, never dropped), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir /tmp/e2e-dist     (E2E_DIST)
// and playwright-core with a Chromium (E2E_CHROMIUM, default the pre-installed one). All data is created through the public API.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const { chromium } = (() => { for (const n of [process.env.PLAYWRIGHT_PATH, 'playwright-core', 'playwright']) { if (!n) continue; try { return req(n); } catch {} } throw new Error('playwright is not installed'); })();
import pg from 'pg';


const API_DIR = new URL('../../apps/api/', import.meta.url).pathname;
const DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sportarena_e2e';
const E = { DATABASE_URL: DB, SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'), PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'off', RATE_LIMIT_DISABLED: 'true' };
const OUT = process.env.UX_SHOTS ?? 'docs/ux'; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
execFileSync('node', ['src/migrate.js'], { cwd: API_DIR, env: { ...process.env, ...E }, stdio: 'inherit' });
const api = spawn('node', ['src/server.js'], { cwd: API_DIR, env: { ...process.env, ...E }, stdio: ['ignore', 'pipe', 'pipe'] });
api.stderr.on('data', (d) => process.env.V && log('[api!]', String(d).trim()));
for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:4000/api/v1/payments/methods')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
const DIST = process.env.E2E_DIST ?? '/tmp/e2e-dist';
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.webmanifest': 'application/json' };
const web = http.createServer((req, res) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/mcp')) {
    const p = http.request({ host: '127.0.0.1', port: 4000, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(p); return;
  }
  let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4100, r));
const call = async (method, p, { token, body } = {}) => {
  const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) { log(`  ! ${method} ${p} -> ${r.status} ${t.slice(0, 200)}`); return null; }
  return j;
};
const stamp = Date.now().toString(36);
const reg = async (h, name, roles) => { const r = await call('POST', '/auth/register', { body: { handle: `${h}_${stamp}`, display_name: name, email: `${h}_${stamp}@example.com`, password: 'correct-horse-battery', roles } }); return { ...r.user, token: r.token, email: `${h}_${stamp}@example.com`, handle: `${h}_${stamp}` }; };
const wait = (p, ms = 1500) => p.waitForTimeout(ms);
const click = async (p, text, opts = {}) => { await p.getByText(text, { exact: true, ...opts }).first().click({ timeout: 8000 }); await wait(p, 1500); };
const addDays = (d, k) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 864e5).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);
let failures = 0;
try {
  const db = new pg.Pool({ connectionString: DB });
  const owner = await reg('cap_owner', 'Priya Nair', ['organizer', 'venue_manager']), coach = await reg('cap_coach', 'Alex Lee', ['coach']), coach2 = await reg('cap_coach2', 'Marta Ruiz', ['coach']), finance = await reg('cap_fin', 'Sam Okoye', ['organizer']);
  const org = await call('POST', '/organisations', { token: owner.token, body: { name: 'Riverside Academy', kind: 'academy', city: 'Pune' } });
  for (const [u, role] of [[coach, 'coach'], [coach2, 'coach'], [finance, 'finance']]) { await call('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }); await call('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }); }
  await call('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['football'], currency: 'INR', listed: true } });
  await call('POST', `/organisations/${org.id}/academy/availability`, { token: coach.token, body: { replace_weekly: true, weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_time: '15:00', end_time: '20:00' })) } });
  const venue = await call('POST', '/venues', { token: owner.token, body: { name: 'Riverside Arena', city: 'Pune', timezone: 'UTC', currency: 'INR' } });
  await call('POST', `/venues/${venue.id}/hours`, { token: owner.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '06:00', closes: '22:00' })) } });
  const court = await call('POST', `/venues/${venue.id}/resources`, { token: owner.token, body: { kind: 'court', name: 'Court A', sport: 'football', hourly_rate_cents: 80000, max_players: 12 } });
  await db.query('UPDATE venues SET organisation_id=$1 WHERE id=$2', [org.id, venue.id]);
  const prog = await call('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'football', title: 'U12 Football Development', format: 'term_course', age_min: 9, age_max: 12, capacity: 6, admission_mode: 'direct', public: true } });
  const pub = await call('POST', `/academy/programmes/${prog.id}/versions`, { token: owner.token, body: { row_version: prog.row_version, billing_model: 'monthly', currency: 'INR', fee_minor: 450000 } });
  const u12 = await call('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'U12 Football', coach_id: coach.id } });
  const kids = []; for (let k = 0; k < 5; k++) kids.push(await reg(`cap_kid${k}`, ['Aarav', 'Kabir', 'Noah', 'Ishaan', 'Leo'][k] + ' M.', ['athlete']));
  await call('POST', `/cohorts/${u12.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${kids.map((p) => `${p.handle},yes`).join('\n')}` } });
  await db.query('UPDATE org_enrolments SET programme_id=$1 WHERE cohort_id=$2', [pub.programme.id, u12.id]);
  await call('PATCH', `/cohorts/${u12.id}/academy/staffing`, { token: owner.token, body: { max_ratio: 4 } });
  const start = addDays(today, 4), wd = new Date(`${start}T00:00:00Z`).getUTCDay();
  await call('POST', `/cohorts/${u12.id}/academy/timetable`, { token: owner.token, body: { idempotency_key: `cap-${stamp}`, starts_on: start, ends_on: addDays(start, 21), weekdays: [wd], start_time: '17:00', duration_min: 60, timezone: 'UTC', lead_id: coach.id } });
  await db.query("INSERT INTO bookings(resource_id, user_id, starts_at, ends_at, status) VALUES ($1,$2,$3,$4,'confirmed')", [court.id, owner.id, `${start}T17:00:00Z`, `${start}T18:00:00Z`]);
  // a development pathway with athletes placed by a human decision
  const pw = await call('POST', `/organisations/${org.id}/academy/pathways`, { token: owner.token, body: { title: 'Football pathway', sport: 'football' } });
  const v = await call('POST', `/academy/pathways/${pw.id}/versions`, { token: owner.token, body: { row_version: 1, levels: [{ key: 'foundation', title: 'Foundation', position: 1, programme_ids: [] }, { key: 'development', title: 'Development', position: 2, programme_ids: [pub.programme.id] }] } });
  await db.query("UPDATE academy_pathways SET status='active' WHERE id=$1", [pw.id]);
  for (const k of kids) await db.query("INSERT INTO academy_progression_decisions(organisation_id, athlete_id, pathway_id, version_id, decision, to_level, reason, decided_by) VALUES ($1,$2,$3,$4,'place','foundation','Placed after trial',$5)", [org.id, k.id, pw.id, v.version?.id ?? (await db.query('SELECT id FROM academy_pathway_versions WHERE pathway_id=$1', [pw.id])).rows[0].id, owner.id]);
  const run = (name, a) => call('POST', `/organisations/${org.id}/academy/capacity-scenarios`, { token: owner.token, body: { name, assumptions: a, idempotency_key: `cs-${name.replace(/\W/g, '')}-${stamp}` } });
  const horizon = { from: start, to: addDays(start, 21) };
  const a = await run('Add a Saturday U12 B cohort', { horizon, enrolment_mix: [{ programme_id: pub.programme.id, change: 3 }], promotions: [{ pathway_id: pw.id, from_level: 'foundation', athletes: 4 }],
    cohorts: [{ name: 'U12 B', programme_id: pub.programme.id, athletes: 9, weekdays: [wd], start_time: '17:00', end_time: '18:00', venue_id: venue.id, coach_ids: [coach.id], source_cohort_id: u12.id, max_ratio: 4 }] });
  await run('Move the same cohort a day later', { horizon, enrolment_mix: [{ programme_id: pub.programme.id, change: 3 }], cohorts: [{ name: 'U12 B', programme_id: pub.programme.id, athletes: 9, weekdays: [(wd + 1) % 7], start_time: '17:00', end_time: '18:00', venue_id: venue.id, coach_ids: [coach2.id], max_ratio: 4 }] });
  await run('Impossible: removes too many', { horizon, enrolment_mix: [{ programme_id: pub.programme.id, change: -40 }], cohorts: [{ name: 'Backwards', programme_id: pub.programme.id, athletes: 5, weekdays: [1], start_time: '18:00', end_time: '17:00', coach_ids: [] }] });

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const open = async (viewport, who = owner, dark = false) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 }); const page = await ctx.newPage();
    if (dark) await ctx.addInitScript(() => { try { localStorage.setItem('theme', 'dark'); } catch {} });
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post('http://localhost:4100/api/v1/auth/login', { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } });
    if (!r.ok()) throw new Error(`login ${r.status()}`);
    await page.goto('http://localhost:4100/'); await wait(page, 2500);
    return page;
  };
  const navTo = async (p, name, params = {}) => {
    await p.evaluate(({ name, params }) => {
      if (!window.__nav) {
        const root = document.getElementById('root') ?? document.body.firstElementChild, key = Object.keys(root).find((k) => k.startsWith('__reactContainer')), todo = [root[key]];
        while (todo.length && !window.__nav) { const n = todo.pop(); const v = n.memoizedProps?.value; if (v && typeof v.push === 'function' && typeof v.goTab === 'function' && v.tab === undefined) { window.__nav = v; break; } if (n.sibling) todo.push(n.sibling); if (n.child) todo.push(n.child); }
      }
      window.__nav.push(name, params);
    }, { name, params });
    await wait(p, 2200);
  };
  const SIZES = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1280, height: 900 } };
  const forecast = async (p) => { await navTo(p, 'Org', { id: org.id }); await click(p, 'Academy'); await click(p, 'Finance'); await click(p, 'Forecast'); };
  const shot = async (name, size, fn, { who = owner, dark = false, full = true, tall = false } = {}) => {
    if (process.env.ONLY && !process.env.ONLY.split(',').some((x) => name.startsWith(x))) return;
    const page = await open(tall ? { ...SIZES[size], height: size === 'phone' ? 3000 : 2200 } : SIZES[size], who, dark);
    try { await fn(page); await page.screenshot({ path: path.join(OUT, `capacity-${name}-${size}${dark ? '-dark' : ''}.png`), fullPage: full }); log(`PASS  ${name} ${size}${dark ? ' dark' : ''}`); }
    catch (e) { failures++; log(`FAIL  ${name} ${size}: ${e.message.split('\n')[0]}`); await page.screenshot({ path: `/tmp/capacity-fail-${name}-${size}.png` }); }
    await page.context().close();
  };
  const studio = async (p) => { await forecast(p); await click(p, '＋ New capacity scenario'); await p.getByPlaceholder('e.g. Add a Saturday U12 cohort').fill('Add a Saturday U12 B cohort'); await wait(p, 500); };
  const plus = async (p, n) => { for (let i = 0; i < n; i++) { await p.getByText('+', { exact: true }).first().click(); await wait(p, 200); } };
  const promo = async (p) => { const btns = p.getByText('+', { exact: true }); const count = await btns.count(); if (count > 1) for (let i = 0; i < 4; i++) { await btns.nth(1).click(); await wait(p, 200); } };
  const pickMenu = async (p, label, option) => { await p.getByLabel(new RegExp(`^${label}:`)).first().click(); await wait(p, 600); await p.getByText(option, { exact: false }).last().click(); await wait(p, 800); };
  const fillCohort = async (p) => {
    await click(p, '＋ Add a cohort'); await p.getByPlaceholder('e.g. U12 B').fill('U12 B'); await pickMenu(p, 'Cohort.s programme|Programme for the cohort|Cohort', 'U12 Football Development');
    await click(p, 'Sat'); await click(p, 'Sun');
    await pickMenu(p, 'Venue', 'Riverside Arena'); await pickMenu(p, 'Check the School timetable of cohort', 'U12 Football');
    await p.getByText('Find a free slot').first().click(); await wait(p, 2500);
  };
  const openCard = async (p, title) => { await p.getByText(title, { exact: true }).first().scrollIntoViewIfNeeded(); await p.getByText(title, { exact: true }).first().locator('xpath=ancestor::*[.//*[text()="▼"]][1]').getByText('▼').first().click(); await wait(p, 1200); };
  for (const size of ['phone', 'tablet', 'desktop']) {
    await shot('1-list', size, forecast);
    await shot('2-result', size, async (p) => { await forecast(p); await openCard(p, 'Add a Saturday U12 B cohort'); }, { tall: true });
    await shot('3-impossible', size, async (p) => { await forecast(p); await openCard(p, 'Impossible: removes too many'); }, { tall: true });
    await shot('4-studio-brief', size, async (p) => { await forecast(p); await click(p, '＋ New capacity scenario'); await p.getByPlaceholder('e.g. Add a Saturday U12 cohort').fill('Add a Saturday U12 B cohort'); await wait(p, 600); }, { tall: true });
    await shot('5-studio-demand', size, async (p) => { await studio(p); await click(p, '2 · Demand'); await plus(p, 3); await promo(p); await wait(p, 2500); }, { tall: true });
    await shot('6-studio-cohorts', size, async (p) => { await studio(p); await click(p, '3 · Cohorts'); await fillCohort(p); await wait(p, 3000); }, { tall: true });
    await shot('7-studio-review', size, async (p) => { await studio(p); await click(p, '3 · Cohorts'); await fillCohort(p); await click(p, '4 · Constraints'); await plus(p, 1, 'extra'); await click(p, '5 · Review'); await wait(p, 3000); }, { tall: true });
  }
  await shot('2-result', 'tablet', async (p) => { await forecast(p); await openCard(p, 'Add a Saturday U12 B cohort'); }, { dark: true, tall: true });
  await shot('1-list', 'phone', forecast, { dark: true });
  await shot('5-coach-denied', 'phone', async (p) => { await navTo(p, 'Org', { id: org.id }); await click(p, 'Academy'); }, { who: coach, full: false });
  await browser.close();
} catch (e) { failures++; log('ERROR', e); }
api.kill(); web.close();
log(failures ? `${failures} failure(s)` : 'all capacity screens photographed');
process.exit(failures ? 1 : 0);
