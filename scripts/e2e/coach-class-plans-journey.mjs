// Browser-driven check of coach class planning: a venue class needs a court booking, the coach plans and shares the class and tracks each student,
// and a student sees the shared plan, on phone, tablet and desktop. All data is created through the public API; nothing is seeded.
// Needs: a throwaway Postgres database (E2E_DATABASE_URL, migrated, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright with a Chromium (E2E_CHROMIUM). Run: node scripts/e2e/coach-class-plans-journey.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import pg from 'pg';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.E2E_PLAYWRIGHT ?? 'playwright');
const E = { DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sportarena_e2e', SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'),
  PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'off', PLATFORM_ADMIN_EMAILS: 'rraja.edge@gmail.com,rrajas1978@icloud.com', RATE_LIMIT_DISABLED: 'true' };
const OUT = (process.env.E2E_SHOTS ?? '/tmp/e2e-shots') + '/'; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const api = spawn('node', ['src/server.js'], { cwd: new URL('../../apps/api/', import.meta.url).pathname, env: { ...process.env, ...E }, stdio: ['ignore', 'pipe', 'pipe'] });
api.stdout.on('data', (d) => process.env.V && log('[api]', String(d).trim())); api.stderr.on('data', (d) => process.env.V && log('[api!]', String(d).trim()));
for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:4000/api/v1/payments/methods')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
const DIST = process.env.E2E_DIST ?? '/tmp/e2e-dist';
const web = http.createServer((req, res) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/mcp')) { const p = http.request({ host: '127.0.0.1', port: 4000, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); req.pipe(p); return; }
  let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  const ext = path.extname(f); res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf' }[ext] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4100, r));
const B = 'http://localhost:4100/api/v1';
const call = async (method, p, { token, body, expect } = {}) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (expect ? r.status !== expect : r.status >= 300) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j)}`); return { status: r.status, ...j }; };
const reg = async (h, name, email = `${h}@example.com`) => { const r = await call('POST', '/auth/register', { body: { handle: h, display_name: name, email, password: 'correct-horse-battery', roles: ['organizer'] } }); return { token: r.token, id: r.user.id, handle: h, email }; };
const db = new pg.Pool({ connectionString: E.DATABASE_URL });
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const wait = (p, ms = 1200) => p.waitForTimeout(ms);
const R = Math.random().toString(36).slice(2, 7);
const reg2 = async (h, name, roles) => { const r = await call('POST', '/auth/register', { body: { handle: `${h}${R}`, display_name: name, email: `${h}${R}@example.com`, password: 'correct-horse-battery', roles } }); return { token: r.token, id: r.user.id, handle: `${h}${R}`, email: `${h}${R}@example.com` }; };
const at10 = (days) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); d.setUTCHours(10, 0, 0, 0); return d.toISOString(); };
try {
  const coach = await reg2('pl_coach', 'Coach Meera', ['coach']), mgr = await reg2('pl_mgr', 'Venue Admin', ['venue_manager']);
  const students = []; for (const nm of ['Asha Rao', 'Dev Patel', 'Isha Nair']) students.push(await reg2(`pl_s${students.length}`, nm, ['athlete']));
  await call('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 70000 } });
  const venue = await call('POST', '/venues', { token: mgr.token, body: { name: `Smash Arena ${R}`, city: 'Pune', timezone: 'UTC' } });
  await call('POST', `/venues/${venue.id}/hours`, { token: mgr.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '06:00', closes: '22:00' })) } });
  const court = await call('POST', `/venues/${venue.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', hourly_rate_cents: 50000, max_players: 10 } });
  const card = await call('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Five-a-side passing', sport: 'football', audience: 'group', delivery: 'both', unit: 'session', duration_min: 60, price_cents: 0, per_person: true, min_participants: 1, max_participants: 10 } });
  const alone = await call('POST', '/coach/classes', { token: coach.token, expect: 400, body: { rate_card_id: card.id, starts_at: at10(2), venue_id: venue.id } });
  check(alone.error?.details?.code === 'booking_required' || alone.error?.code === 'booking_required', 'a class at a venue without a court booking is refused');
  const res = await call('POST', '/reservations', { token: coach.token, body: { items: [{ resource_id: court.id, starts_at: at10(2), ends_at: new Date(+new Date(at10(2)) + 2 * 36e5).toISOString() }] } });
  const booking = (await call('GET', `/reservations/${res.id}`, { token: coach.token })).bookings[0].id;
  const k = await call('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: card.id, starts_at: at10(2), booking_id: booking, title: 'Passing patterns', max_participants: 8 } });
  const k2 = await call('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: card.id, starts_at: at10(5), online_url: 'https://meet.example.com/passing', title: 'Second clinic', max_participants: 8 } });
  for (const st of students) await call('POST', `/coach/classes/${k.id}/join`, { token: st.token, body: {} });
  const w = await call('POST', `/coach/classes/${k.id}/workspace`, { token: coach.token, expect: 200 });
  await call('POST', `/coaching/sessions/${w.record_id}/plan`, { token: coach.token, body: { objective: 'First touch under pressure', blocks: [{ kind: 'warm_up', title: 'Passing squares', duration_min: 10 }, { kind: 'skill_drill', title: 'Receive and turn', duration_min: 20, instructions: 'Open body shape, scan before the ball arrives.' }, { kind: 'conditioned_game', title: '3 v 2 to goal', duration_min: 20, coach_notes: 'Rotate after every attack.' }] } });
  await call('POST', `/coach/classes/${k.id}/plan/share`, { token: coach.token, body: { share: true } });
  await db.query("UPDATE coach_class_seats SET attendance='attended' WHERE class_id=$1 AND user_id=$2", [k.id, students[0].id]);
  await call('POST', `/coaching/sessions/${w.record_id}/player-summaries`, { token: coach.token, body: { athlete_id: students[0].id, summary: 'Much better first touch; keep scanning early.', shared: true } });
  const rubric = await call('POST', '/coaching/rubrics', { token: coach.token, body: { name: 'Passing and receiving', sport: 'football', dimensions: [{ key: 'first_touch', name: 'First touch', scale_min: 1, scale_max: 5 }, { key: 'scanning', name: 'Scanning', scale_min: 1, scale_max: 5 }, { key: 'weight_of_pass', name: 'Weight of pass', scale_min: 1, scale_max: 5 }] } });
  const rid = rubric.rubric_id ?? rubric.id;
  const kp = await call('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: card.id, starts_at: at10(9), online_url: 'https://meet.example.com/week0', title: 'Passing patterns, week one', max_participants: 8 } });
  for (const st of students) await call('POST', `/coach/classes/${kp.id}/join`, { token: st.token, body: {} });
  const prior = [[2, 2, 3], [3, 3, 3], [2, 4, 2]];
  await call('POST', `/coach/classes/${kp.id}/scores`, { token: coach.token, body: { rubric_id: rid, scores: students.flatMap((st, i) => ['first_touch', 'scanning', 'weight_of_pass'].map((dimension_key, j) => ({ athlete_id: st.id, dimension_key, score: prior[i][j] }))) } });
  const wk = await call('POST', `/coach/classes/${kp.id}/workspace`, { token: coach.token, expect: 200 });
  await db.query("UPDATE coach_classes SET starts_at = now() - interval '7 days' WHERE id=$1", [kp.id]);
  await db.query("UPDATE coaching_observations SET observed_at = now() - interval '7 days' WHERE session_record_id=$1", [wk.record_id]);
  await call('POST', '/coaching/templates', { token: coach.token, body: { title: 'Receive and turn, gates', scope: 'block', sport: 'football', blocks: [{ kind: 'skill_drill', title: 'Receive and turn, gates', duration_min: 15, instructions: 'Pairs through gates, one touch to open the body.' }] } });
  await call('POST', `/coach/classes/${k.id}/scores`, { token: coach.token, body: { rubric_id: rid, scores: [{ athlete_id: students[0].id, dimension_key: 'first_touch', score: 3 }, { athlete_id: students[0].id, dimension_key: 'scanning', score: 4 }] } });
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${r.status()} ${await r.text()}`);
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(5000);
    return { ctx, page };
  };
  const shot = (page, n) => page.screenshot({ path: `${OUT}${n}.png`, fullPage: false });
  const vis = async (p, t, ms = 4000) => { try { await p.getByText(t).first().waitFor({ state: 'visible', timeout: ms }); return true; } catch { return false; } };
  const navTo = async (p, name, params = {}) => {
    await p.evaluate(({ name, params }) => {
      if (!window.__nav) {
        const root = document.getElementById('root') ?? document.body.firstElementChild;
        const key = Object.keys(root).find((k) => k.startsWith('__reactContainer'));
        const todo = [root[key]];
        while (todo.length && !window.__nav) { const n = todo.pop(); const v = n.memoizedProps?.value; if (v && typeof v.push === 'function' && typeof v.goTab === 'function' && v.tab === undefined) { window.__nav = v; break; } if (n.sibling) todo.push(n.sibling); if (n.child) todo.push(n.child); }
      }
      if (!window.__nav) throw new Error('navigator not found');
      window.__nav.push(name, params);
    }, { name, params });
    await wait(p, 2200);
  };
  const VIEWS = [['phone', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }], ['desktop', { width: 1366, height: 900 }]];
  for (const [name, viewport] of VIEWS) {
    const c1 = await session(coach, viewport);
    await navTo(c1.page, 'ClassStudio', { id: k.id });
    check(await vis(c1.page, 'Passing squares'), `${name}: the studio shows the timeline`);
    check(await vis(c1.page, 'planned'), `${name}: the time budget is shown`);
    await c1.page.getByText('Receive and turn').first().click(); await wait(c1.page, 800);
    check(await vis(c1.page, 'Coaching cues'), `${name}: a block opens for full editing`);
    await shot(c1.page, `01-studio-plan-${name}`);
    await c1.page.getByText('Students', { exact: true }).last().click(); await wait(c1.page, 2000);
    check(await vis(c1.page, 'First touch'), `${name}: the scoring grid shows the rubric skills`);
    check(await vis(c1.page, 'since last class'), `${name}: the change since the last class is shown`);
    await shot(c1.page, `02-studio-students-${name}`);
    await c1.page.getByText('Review', { exact: true }).last().click(); await wait(c1.page, 1500);
    await shot(c1.page, `03-studio-review-${name}`);
    await c1.ctx.close();
    const s1 = await session(students[0], viewport);
    await navTo(s1.page, 'CoachProfile', { id: coach.id });
    await s1.page.getByText('Passing patterns').last().click(); await wait(s1.page, 2000);
    check(await vis(s1.page, 'First touch under pressure'), `${name}: a student sees the shared plan`);
    check(await vis(s1.page, 'Much better first touch'), `${name}: a student sees the summary shared with them`);
    await shot(s1.page, `04-student-plan-${name}`);
    await s1.ctx.close();
  }
  await browser.close();
} catch (e) { failures++; log('FAIL ', e.stack ?? e); }
api.kill(); web.close(); await db.end();
log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0);
