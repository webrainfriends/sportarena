// Retakes every screenshot of the academy Process card / PDF guide (apps/api/src/guides/academy-process.js) from the real app, on phone and
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
import { seedPickup } from './lib/pickup-fixture.mjs';
import { seedWellbeing } from './lib/wellbeing-fixture.mjs';
import { ACADEMY_STEPS, SHOT_SIZES, shotFile, sourcesHash, MANIFEST_FILE } from '../../apps/api/src/guides/academy-process.js';

const API_DIR = new URL('../../apps/api/', import.meta.url).pathname;
const DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sportarena_e2e';
const E = { DATABASE_URL: DB, SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'), PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'off', RATE_LIMIT_DISABLED: 'true' };
const OUT = path.dirname(MANIFEST_FILE); fs.mkdirSync(OUT, { recursive: true });
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
  if (!r.ok) { log(`  ! ${method} ${p} -> ${r.status} ${t.slice(0, 160)}`); return null; }
  return j;
};
const stamp = Date.now().toString(36);
const reg = async (h, name, roles, extra = {}) => { const r = await call('POST', '/auth/register', { body: { handle: `${h}_${stamp}`, display_name: name, email: `${h}_${stamp}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); return { ...r.user, token: r.token, email: `${h}_${stamp}@example.com` }; };
const wait = (p, ms = 1500) => p.waitForTimeout(ms);
const click = async (p, text, opts = {}) => { await p.getByText(text, { exact: true, ...opts }).first().click({ timeout: 8000 }); await wait(p, 1500); };
let failures = 0;
try {
  // ------------------------------------------------------------------ a small, real academy created through the API
  const owner = await reg('guide_owner', 'Priya Nair', ['organizer', 'venue_manager']), coach = await reg('guide_coach', 'Alex Lee', ['coach']), mgr = owner;   // the academy owner also runs the venue
  const org = await call('POST', '/organisations', { token: owner.token, body: { name: 'Riverside Academy', kind: 'academy', city: 'Pune' } });
  await call('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: coach.handle, role: 'coach' } });
  await call('POST', `/organisations/${org.id}/invite/respond`, { token: coach.token, body: { accept: true } });
  const venue = await call('POST', '/venues', { token: mgr.token, body: { name: 'Riverside Arena', city: 'Pune', timezone: 'UTC', currency: 'INR' } });
  await call('POST', `/venues/${venue.id}/hours`, { token: mgr.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '06:00', closes: '22:00' })) } });
  await call('POST', `/venues/${venue.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court A', sport: 'football', hourly_rate_cents: 80000, max_players: 12 } });
  await call('POST', `/organisations/${org.id}/academy/suppliers`, { token: owner.token, body: { kind: 'maintenance', name: 'GreenTurf Maintenance', all_venues: true } });
  await call('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'football', title: 'U12 Football Development', format: 'term_course', age_min: 9, age_max: 12, capacity: 24, coach_ids: [coach.id] } });
  const u12 = await call('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'U12 Football', coach_id: coach.id } });
  const monday = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
  const end = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 27); return d.toISOString().slice(0, 10); })();
  const tt = await call('POST', `/cohorts/${u12.id}/academy/timetable`, { token: owner.token, body: { idempotency_key: `g-${stamp}`, starts_on: monday, ends_on: end, weekdays: [1, 3], start_time: '17:00', duration_min: 60, delivery_type: 'training', lead_id: coach.id } });
  if (tt?.created) await call('POST', `/organisations/${org.id}/academy/sessions/publish`, { token: owner.token, body: { session_ids: tt.created.map((x) => x.id), acknowledge_warnings: true } });

  // a student linked to a school, with the academics the guide step photographs (everything through the public API)
  const student = await reg('guide_student', 'Aarav Mehta', ['athlete']);
  await call('POST', `/cohorts/${u12.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${student.handle},yes` } });
  const school = await call('POST', '/organisations', { token: owner.token, body: { name: 'Greenfield International School', kind: 'school', city: 'Pune' } });
  const enrolmentId = (await call('GET', `/cohorts/${u12.id}/enrolments`, { token: owner.token })).find((e) => e.handle === student.handle).enrolment_id;
  const alink = await call('POST', `/organisations/${org.id}/academics/links`, { token: owner.token, body: { enrolment_id: enrolmentId, school_org_id: school.id, curriculum: 'cbse', year_group: 'Grade 10' } });
  if (alink) {
    for (const party of [org.id, school.id]) await call('POST', '/academics/consents', { token: student.token, body: { athlete_id: student.id, party_org_id: party, scopes: ['timetable', 'attendance', 'attainment'], detail: 'summary' } });
    const exam = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
    await call('POST', `/academics/links/${alink.id}/items`, { token: owner.token, body: { items: [{ kind: 'exam', starts_at: `${exam}T04:00:00Z`, ends_at: `${exam}T07:00:00Z`, timezone: 'Asia/Kolkata', high_stakes: true }] } });
  }
  // young athletes, guardians, one session in the past and its handovers, so the Safety & pickup step photographs real figures
  const db = new pg.Pool({ connectionString: DB });
  await seedPickup({ call, reg, org, owner, coach, cohort: u12, db, apiDir: API_DIR, env: E, log });
  // the academy opts in to campuses (one default campus, no record changed) so the guide step photographs real figures
  await call('POST', `/organisations/${org.id}/campuses/adopt`, { token: owner.token, body: { name: 'Pune Campus', country: 'IN' } });

  // ------------------------------------------------------------------ the browser
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const open = async (viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post('http://localhost:4100/api/v1/auth/login', { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: owner.email, password: 'correct-horse-battery' } });
    if (!r.ok()) throw new Error(`login ${r.status()}`);
    await page.goto('http://localhost:4100/'); await wait(page, 2500);
    return page;
  };
  // the app has no URL routing: grab the navigator from the React tree (test only) and push screens like the wheel does
  const navTo = async (p, name, params = {}) => {
    await p.evaluate(({ name, params }) => {
      if (!window.__nav) {
        const root = document.getElementById('root') ?? document.body.firstElementChild, key = Object.keys(root).find((k) => k.startsWith('__reactContainer')), todo = [root[key]];
        while (todo.length && !window.__nav) { const n = todo.pop(); const v = n.memoizedProps?.value; if (v && typeof v.push === 'function' && typeof v.goTab === 'function' && v.tab === undefined) {   // the NavBridge value drives React Navigation; the outer provider (tab set) only serves signed-out pages
           window.__nav = v; break; } if (n.sibling) todo.push(n.sibling); if (n.child) todo.push(n.child); }
      }
      window.__nav.push(name, params);
    }, { name, params });
    await wait(p, 2200);
  };
  const inOrg = async (p, fn) => { await navTo(p, 'Org', { id: org.id }); await fn(); };
  // where each step is photographed: the same screen its "Open this screen" button reaches
  const SCENES = {
    create: async (p) => { await navTo(p, 'Orgs'); },
    venues: (p) => inOrg(p, () => click(p, 'Teams, events & venues')),
    staff: (p) => inOrg(p, () => click(p, 'People')),
    suppliers: (p) => inOrg(p, async () => { await click(p, 'Academy'); await click(p, 'Partners'); }),
    programmes: (p) => inOrg(p, async () => { await click(p, 'Academy'); await click(p, 'Programmes'); }),
    coaches: async (p) => { await navTo(p, 'Manage', { id: venue.id, tab: 'coaches' }); await p.getByText('Tie-ups', { exact: true }).first().scrollIntoViewIfNeeded(); await wait(p, 600); },
    students: (p) => inOrg(p, async () => { await click(p, 'Academy'); await click(p, 'Admissions'); }),
    classes: (p) => inOrg(p, async () => { await click(p, 'Academy'); await click(p, 'Operations'); }),
    tax: async (p) => { await navTo(p, 'Finance', { id: org.id }); await click(p, 'Tax').catch(() => {}); },
    revenue: (p) => inOrg(p, async () => { await click(p, 'Academy'); await click(p, 'Finance'); await click(p, 'Costs'); }),
    reports: (p) => inOrg(p, async () => { await click(p, 'Academy'); }),
    academics: (p) => inOrg(p, async () => { await click(p, 'Academy'); await click(p, 'Academics'); await click(p, 'Athletes'); }),   // the Academy tab opens on its Home (executive view)
    campuses: (p) => inOrg(p, async () => { await click(p, 'Campuses'); }),
    wellbeing: (p) => inOrg(p, async () => { await click(p, 'Academy'); await click(p, 'Wellbeing'); }),
    safety: (p) => inOrg(p, async () => { await click(p, 'Academy'); await click(p, 'Safety & pickup'); }),   // the Academy tab opens on its Home (executive view)
  };
  const manifest = { generated_at: new Date().toISOString(), steps: {} };
  for (const [size, viewport] of Object.entries(SHOT_SIZES)) {
    for (const s of ACADEMY_STEPS) {
      const page = await open(viewport);   // a fresh page per shot keeps every screenshot independent of the one before
      try { await SCENES[s.id](page); await page.screenshot({ path: path.join(OUT, shotFile(s.id, size)) }); log(`PASS  ${s.id} ${size}`); }
      catch (e) { failures++; log(`FAIL  ${s.id} ${size}: ${e.message.split('\n')[0]}`); if (process.env.V) await page.screenshot({ path: `/tmp/guide-fail-${s.id}-${size}.png` }); }
      await page.context().close();
    }
  }
  // UX_SHOTS=<dir>: also photograph the Process card itself (collapsed and with a step open) at phone, tablet and desktop widths
  if (process.env.UX_SHOTS) {
    fs.mkdirSync(process.env.UX_SHOTS, { recursive: true });
    for (const [size, viewport] of Object.entries({ phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1280, height: 900 } })) {
      const page = await open(viewport);
      try {
        await inOrg(page, () => click(page, 'Academy'));
        await page.screenshot({ path: path.join(process.env.UX_SHOTS, `guide-card-1-closed-${size}.png`) });
        await click(page, 'Start guide');
        await page.getByLabel(/^Step 5:/).first().click(); await wait(page, 1200);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(process.env.UX_SHOTS, `guide-card-2-step-${size}.png`) });
        log(`PASS  card ${size}`);
      } catch (e) { failures++; log(`FAIL  card ${size}: ${e.message.split('\n')[0]}`); await page.screenshot({ path: `/tmp/guide-fail-card-${size}.png` }); }
      await page.context().close();
    }
  }
  for (const s of ACADEMY_STEPS) manifest.steps[s.id] = sourcesHash(s);
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n');
  await browser.close();
} catch (e) { failures++; log('ERROR', e); }
api.kill(); web.close();
log(failures ? `${failures} failure(s)` : 'all screenshots taken');
process.exit(failures ? 1 : 0);
