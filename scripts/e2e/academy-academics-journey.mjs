// Browser-driven walk-through of Academics & school integration (#783): verified school links, consent, school timetable, sport-study clash before publication,
// attendance exceptions, restricted grades, coordination tasks and the athlete / guardian "School" view, at phone, tablet and desktop widths.
// Everything is created through the API/SQL at run time in a throwaway database (E2E_DATABASE_URL); no demo data is in the repo. Same setup notes as academy-closeout-journey.mjs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import pg from 'pg';
const E = { DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://postgres:x@127.0.0.1:5432/sportarena_e2e', SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'),
  PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'off', RATE_LIMIT_DISABLED: 'true' };
const OUT = (process.env.E2E_SHOTS ?? '/tmp/e2e-shots') + '/'; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const db = new pg.Pool({ connectionString: E.DATABASE_URL });
await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
const sql = async (q, p) => (await db.query(q, p)).rows;
const api = spawn('node', ['src/server.js'], { cwd: new URL('../../apps/api/', import.meta.url).pathname, env: { ...process.env, ...E }, stdio: ['ignore', 'pipe', 'pipe'] });
api.stdout.on('data', (d) => process.env.V && log('[api]', String(d).trim())); api.stderr.on('data', (d) => process.env.V && log('[api!]', String(d).trim()));
for (let i = 0; i < 90; i++) { try { if ((await fetch('http://127.0.0.1:4000/api/v1/payments/methods')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
const DIST = process.env.E2E_DIST ?? '/tmp/e2e-dist';
const web = http.createServer((req, res) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/mcp')) { const p = http.request({ host: '127.0.0.1', port: 4000, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); req.pipe(p); return; }
  let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  const ext = path.extname(f); res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.ico': 'image/x-icon' }[ext] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4100, r));
const B = 'http://localhost:4100/api/v1';
const call = async (method, p, { token, body, query } = {}) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p} ${r.status} ${JSON.stringify(j)}`); return j; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const reg = async (h, name, roles = ['athlete']) => { const r = await call('POST', '/auth/register', { body: { handle: h, display_name: name, email: `${h}@example.com`, password: 'correct-horse-battery', roles, dob: yearsAgo(28) } }); return { ...r.user, token: r.token, email: `${h}@example.com` }; };
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const iso = (d) => d.toISOString().slice(0, 10);
const plus = (days) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d; };
const hdrs = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });
const must = async (p) => p;
try {
  const owner = await reg('ada_owner', 'Ada Okafor', ['coach']), coach = await reg('ben_coach', 'Ben Hartley', ['coach']), edu = await reg('eva_edu', 'Eva Lindqvist', ['coach']), head = await reg('hugh_head', 'Hugh Mercer', ['coach']);
  const names = ['Priya Nair', 'Tom Alvarez', 'Mia Chen', 'Jonas Weber', 'Sofia Rossi'];
  const ath = []; for (const [i, n] of names.entries()) ath.push(await reg(`athlete_${i}`, n));
  const org = await call('POST', '/organisations', { token: owner.token, body: { name: 'Riverside Tennis Academy', kind: 'academy', city: 'Leeds' } });
  await call('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['tennis'], currency: 'GBP', listed: true } });
  for (const [u, role] of [[coach, 'coach'], [edu, 'staff']]) await sql("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at) VALUES ($1,$2,$3,'active',now())", [org.id, u.id, role]);
  await call('POST', `/organisations/${org.id}/academy/staff/${edu.id}`, { token: owner.token, body: { job_title: 'Education coordinator', template: 'education_coordinator' } });
  const prog = await call('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'tennis', title: 'Full-time Performance Squad', capacity: 12, admission_mode: 'direct', public: true, focus: 'elite' } });
  await call('POST', `/academy/programmes/${prog.id}/versions`, { token: owner.token, body: { row_version: prog.row_version, billing_model: 'free', currency: 'GBP', fee_minor: 0 } });
  for (const u of ath) { const e = await call('POST', `/academy/programmes/${prog.id}/applications`, { token: u.token, body: {} }); await call('POST', `/academy/applications/${e.id}/submit`, { token: u.token, body: { row_version: e.row_version, answers: {} } }); }
  const cohort = (await sql('SELECT id FROM org_cohorts WHERE organisation_id=$1 AND programme_id IS NOT NULL LIMIT 1', [org.id]))[0];
  await sql('UPDATE org_cohorts SET coach_id=$2 WHERE id=$1', [cohort.id, coach.id]);
  const school = await call('POST', '/organisations', { token: head.token, body: { name: 'Ashworth Sixth Form College', kind: 'college', city: 'Leeds' } });
  await sql("UPDATE organisations SET approval_status='approved' WHERE id=$1", [school.id]);
  const enrol = async (u) => (await sql("SELECT id FROM org_enrolments WHERE user_id=$1 AND status='enrolled'", [u.id]))[0].id;
  const links = [];
  for (const [i, u] of ath.slice(0, 4).entries()) links.push(await call('POST', `/academy/enrolments/${await enrol(u)}/school-links`, { token: owner.token, body: { school_org_id: school.id, year_group: i < 2 ? 'Year 12' : 'Year 13', student_ref: `ASH-${1000 + i}`, import_authorised: i === 0, idempotency_key: `seed-link-${i}` } }));
  for (const u of ath.slice(0, 3)) await call('POST', '/me/academy/academics/share', { token: u.token, body: { organisation_id: org.id, level: 'schedule', enabled: true } });
  for (const u of ath.slice(0, 2)) await call('POST', '/me/academy/academics/share', { token: u.token, body: { organisation_id: org.id, level: 'progress', enabled: true } });
  const at = (days, h) => { const d = plus(days); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };
  await call('POST', `/organisations/${org.id}/academy/academics/frameworks`, { token: edu.token, body: { key: 'a_level', name: 'A-level A*–E', kind: 'letter', scale: { grades: ['A*', 'A', 'B', 'C', 'D', 'E', 'U'] }, pass_mark: 'E' } });
  const fw = (await call('GET', `/organisations/${org.id}/academy/academics/frameworks`, { token: edu.token })).frameworks[0];
  await call('POST', `/academy/school-links/${links[0].id}/blocks`, { token: edu.token, body: { kind: 'exam', recurrence: 'once', starts_at: at(3, 9), ends_at: at(3, 11), label: 'Mathematics paper 2', source: 'school_confirmed', source_ref: 'Exam board timetable 2026' } });
  await call('POST', `/academy/school-links/${links[1].id}/blocks`, { token: edu.token, body: { kind: 'exam', recurrence: 'once', starts_at: at(6, 13), ends_at: at(6, 15), label: 'Physics paper 1', source: 'school_confirmed', source_ref: 'Exam board timetable 2026' } });
  for (const l of links.slice(0, 3)) await call('POST', `/academy/school-links/${l.id}/blocks`, { token: edu.token, body: { kind: 'school_day', recurrence: 'weekly', weekday: 2, start_time: '08:45', end_time: '12:30', valid_from: iso(plus(-30)), valid_to: iso(plus(90)), timezone: 'UTC', source: 'school_confirmed', source_ref: 'Autumn term timetable' } });
  await call('POST', `/academy/school-links/${links[2].id}/blocks`, { token: edu.token, body: { kind: 'tutoring', recurrence: 'once', starts_at: at(4, 17), ends_at: at(4, 18), source: 'manual_verified', source_ref: 'Tutor agreement' } });
  const att = (l, p, pres, au, un, src = 'school_confirmed') => call('POST', `/academy/school-links/${l.id}/attendance`, { token: edu.token, body: { period_from: iso(plus(-60)), period_to: iso(plus(-1)), sessions_possible: p, present: pres, authorised_absence: au, unauthorised_absence: un, source: src, source_ref: 'Autumn registers' } });
  await att(links[0], 50, 49, 1, 0); await att(links[1], 50, 41, 3, 6); await att(links[2], 50, 46, 4, 0, 'manual_verified');
  const snap = (l, term, grades, standing, vis) => call('POST', `/academy/school-links/${l.id}/snapshots`, { token: edu.token, body: { term_label: term, period_from: iso(plus(-120)), period_to: iso(plus(-5)), framework_id: fw.id, entries: grades.map(([subject, grade, target]) => ({ subject, grade, target })), comment: 'Consistent effort; balancing travel with coursework well.', standing, visibility: vis, source: 'school_report', source_ref: `${term} report`, source_date: iso(plus(-5)), idempotency_key: `seed-${term}-${l.id}` } });
  await snap(links[0], 'Summer 2026', [['Mathematics', 'A', 'A*'], ['Physics', 'B', 'A'], ['Economics', 'A']], 'on_track', 'athlete_guardian');
  await snap(links[1], 'Summer 2026', [['Mathematics', 'C', 'B'], ['Chemistry', 'D', 'C']], 'concern', 'athlete_guardian');
  await call('POST', `/organisations/${org.id}/academy/academic-tasks`, { token: edu.token, body: { athlete_id: ath[1].id, link_id: links[1].id, kind: 'guardian_meeting', audience: 'guardian', title: 'Meet the family about attendance and workload', due_on: iso(plus(5)), assignee_id: edu.id, priority: 'high', idempotency_key: 'seed-task-1' } });
  await call('POST', `/organisations/${org.id}/academy/academic-tasks`, { token: edu.token, body: { athlete_id: ath[0].id, link_id: links[0].id, kind: 'coach_school_liaison', audience: 'coach', title: 'Agree training load around mock exams', due_on: iso(plus(-1)), assignee_id: coach.id, idempotency_key: 'seed-task-2' } });
  // sport sessions: one clashes with Priya's exam (draft), one is clear
  const mk = async (title, days, h, status) => (await sql("INSERT INTO academy_sessions(organisation_id, cohort_id, programme_id, title, starts_at, ends_at, status, created_by) VALUES ($1,$2,$3,$4,$5,$5::timestamptz + interval '90 minutes',$6,$7) RETURNING id", [org.id, cohort.id, prog.id, title, at(days, h), status, owner.id]))[0];
  const clash = await mk('Serve & return technical block', 3, 10, 'draft'); await mk('Match play', 3, 15, 'draft'); await mk('Fitness & conditioning', 2, 16, 'published');
  for (const s of await sql('SELECT id FROM academy_sessions WHERE organisation_id=$1', [org.id])) await sql("INSERT INTO academy_session_staff(session_id, user_id, role, status, assigned_by) VALUES ($1,$2,'lead','confirmed',$3)", [s.id, coach.id, owner.id]);
  const pub = await call('POST', `/organisations/${org.id}/academy/sessions/publish`, { token: owner.token, body: { session_ids: [clash.id] } });
  check(pub.results[0].published === false && pub.results[0].conflicts[0].code === 'school_exam_clash', 'publication is refused with a school exam clash');
  log('seeded');
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${r.status()}`);
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(2500);
    return { ctx, page };
  };
  const wait = (p, ms = 1500) => p.waitForTimeout(ms);
  const click = async (p, t, ms = 1800) => { const l = p.getByText(t, { exact: true }).locator('visible=true').first(); await l.scrollIntoViewIfNeeded().catch(() => {}); await l.click({ force: true, timeout: 8000 }); await wait(p, ms); };
  const openOrgs = async (p) => { await p.getByLabel('Home', { exact: true }).last().click().catch(() => {}); await wait(p, 1500); };
  const openAcademy = async (p) => { await openOrgs(p); await p.getByText(/Riverside Tennis Academy/).first().click(); await wait(p, 2500); await click(p, 'Academy', 2500); await p.getByText('Academics', { exact: true }).first().click(); await wait(p, 2500); };
  const shot = async (p, n, scrolls = 0) => { await p.screenshot({ path: `${OUT}${n}.png` }); for (let i = 1; i <= scrolls; i++) { await p.mouse.move(p.viewportSize().width / 2, p.viewportSize().height / 2); await p.mouse.wheel(0, p.viewportSize().height * 0.85); await wait(p, 700); await p.screenshot({ path: `${OUT}${n}-scroll${i}.png` }); } };
  const VIEW = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1280, height: 1000 } };
  for (const [size, vp] of Object.entries(VIEW)) {
    const { ctx, page: p } = await session(edu, vp);
    await openAcademy(p); await shot(p, `1-overview-${size}`, size === 'phone' ? 3 : 1);
    await click(p, 'Athletes'); await shot(p, `2-athletes-${size}`);
    await p.getByText('Priya Nair').first().click(); await wait(p, 2500); await shot(p, `3-athlete-detail-${size}`, size === 'phone' ? 4 : 2);
    await ctx.close();
  }
  { const { ctx, page: p } = await session(edu, VIEW.desktop); await openAcademy(p); await click(p, 'School timetable'); await shot(p, '4-timetable-desktop'); await click(p, 'Coordination'); await shot(p, '5-tasks-desktop'); await click(p, 'Rules & import'); await shot(p, '6-setup-desktop', 1); await ctx.close(); }
  { const { ctx, page: p } = await session(coach, VIEW.phone); await openOrgs(p); await p.getByText(/Riverside Tennis Academy/).first().click(); await wait(p, 2500); await click(p, 'Academy', 2500); check(!(await p.getByText('Academics', { exact: true }).count()), 'an ordinary coach has no Academics tab'); await ctx.close(); }
  for (const [size, vp] of Object.entries({ phone: VIEW.phone, tablet: VIEW.tablet })) {
    const { ctx, page: p } = await session(ath[1], vp);
    await p.goto('http://localhost:4100/'); await wait(p, 2000);
    await p.evaluate(() => { const root = document.getElementById('root') ?? document.body.firstElementChild, key = Object.keys(root).find((k) => k.startsWith('__reactContainer')), todo = [root[key]]; while (todo.length) { const n = todo.pop(); const v = n.memoizedProps?.value; if (v && typeof v.push === 'function' && typeof v.goTab === 'function' && v.tab === undefined) { window.__nav = v; break; } if (n.sibling) todo.push(n.sibling); if (n.child) todo.push(n.child); } window.__nav.push('AcademyFamily', {}); });
    await wait(p, 2500); await click(p, 'School', 2500); await shot(p, `7-athlete-school-${size}`, 2); await ctx.close();
  }
  await browser.close();
} catch (e) { failures++; log('FAIL', e.stack?.split('\n').slice(0, 4).join(' | ')); }
finally { api.kill(); web.close(); await db.end(); log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0); }
