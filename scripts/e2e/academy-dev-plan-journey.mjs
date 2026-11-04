// Browser-driven check of the athlete development plan (#785) inside Academy → Progress: the plan list, one plan with its six domains,
// objectives measured from canonical records, tasks, reviews and sign-off, and the athlete / guardian / specialist / provider views, on phone, tablet and desktop.
// Everything is created through the API/SQL at run time in a throwaway database (E2E_DATABASE_URL; its schema is recreated each run); no demo data is in the repo.
// Needs: a same-origin web build  EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>  (E2E_DIST, default /tmp/e2e-dist) and a Chromium.
// Run: node scripts/e2e/academy-dev-plan-journey.mjs   (screenshots in E2E_SHOTS, default /tmp/e2e-shots)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.E2E_PLAYWRIGHT ?? 'playwright-core');
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
const reg = async (h, name, roles = ['athlete'], age = 28) => { const r = await call('POST', '/auth/register', { body: { handle: h, display_name: name, email: `${h}@example.com`, password: 'correct-horse-battery', roles, dob: yearsAgo(age) } }); return { ...r.user, token: r.token, email: `${h}@example.com` }; };
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const iso = (d) => d.toISOString().slice(0, 10);
const plus = (days) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d; };

const plusDays = (n) => iso(plus(n));
try {
  // ---------- people and academy
  const owner = await reg('ada_owner', 'Ada Okafor', ['coach']), coach = await reg('ben_coach', 'Ben Hartley', ['coach']);
  const edu = await reg('grace_edu', 'Grace Mensah', ['coach']), psy = await reg('lena_psy', 'Dr Lena Okoye', ['coach']), cond = await reg('marco_cond', 'Marco Silva', ['coach']);
  const tom = await reg('tom_alvarez', 'Tom Alvarez', ['athlete'], 15), priya = await reg('priya_nair', 'Priya Nair', ['athlete'], 19), mia = await reg('mia_chen', 'Mia Chen', ['athlete'], 20);
  const parent = await reg('maria_alvarez', 'Maria Alvarez', ['athlete'], 44);
  const org = await call('POST', '/organisations', { token: owner.token, body: { name: 'Riverside Football Academy', kind: 'academy', city: 'Leeds' } });
  await call('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['football'], currency: 'GBP', listed: true } });
  for (const [u, role] of [[coach, 'coach'], [edu, 'manager'], [psy, 'manager'], [cond, 'manager']]) await sql("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at) VALUES ($1,$2,$3,'active',now())", [org.id, u.id, role]);
  const prog = await call('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'football', title: 'U16 Performance Squad', capacity: 20, admission_mode: 'direct', public: true } });
  const pub = await call('POST', `/academy/programmes/${prog.id}/versions`, { token: owner.token, body: { row_version: prog.row_version, billing_model: 'one_time', currency: 'GBP', fee_minor: 24000 } });
  // the young athlete: verified guardian, with participation + coaching consent
  const link = await call('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: tom.id, relationship: 'parent' } });
  await call('POST', `/youth/guardian-links/${link.id}/respond`, { token: tom.token, body: { accept: true } });
  await call('POST', `/youth/guardian-links/${link.id}/evidence`, { token: parent.token, body: { evidence: { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' } } });
  const [adm] = await sql("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('e2e_root','root','{admin}','x','x','e2e_root') RETURNING id");
  Object.assign(process.env, E);
  const { signToken } = await import('../../apps/api/src/auth.js');
  const admTok = await signToken({ id: adm.id, roles: ['admin'] });
  await call('POST', `/youth/guardian-links/${link.id}/decision`, { token: admTok, body: { decision: 'approve', note: 'Documents match' } });
  for (const purpose of ['participation', 'coaching']) await call('POST', `/youth/children/${tom.id}/consents`, { token: parent.token, body: { purpose } }).catch((e) => log('(consent)', purpose, String(e.message).slice(0, 90)));
  const tprog = await call('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'tennis', title: 'U16 Tennis Performance', capacity: 20, admission_mode: 'direct', public: true } });
  await call('POST', `/academy/programmes/${tprog.id}/versions`, { token: owner.token, body: { row_version: tprog.row_version, billing_model: 'one_time', currency: 'GBP', fee_minor: 36000 } });
  const enrol = async (u, asParent, pr = prog) => { const e = await call('POST', `/academy/programmes/${pr.id}/applications`, { token: (asParent ?? u).token, body: asParent ? { athlete_id: u.id } : {} }); await call('POST', `/academy/applications/${e.id}/submit`, { token: (asParent ?? u).token, body: { row_version: e.row_version, answers: {} } }); };
  await enrol(tom, parent); await enrol(priya); await enrol(mia, undefined, tprog);
  const tpeers = []; for (const [k, n] of ['Lucas Meyer', 'Aiko Tanaka', 'Noah Bell', 'Sara Costa', 'Omar Haddad', 'Eva Novak'].entries()) { const u = await reg(`tennis_peer_${k}`, n, ['athlete'], 19); await enrol(u, undefined, tprog); tpeers.push(u); }
  await sql('UPDATE org_cohorts SET coach_id=$2 WHERE organisation_id=$1 AND programme_id IS NOT NULL', [org.id, coach.id]);
  const [cohort] = await sql('SELECT id FROM org_cohorts WHERE organisation_id=$1 AND programme_id=$2', [org.id, prog.id]);
  // ---------- canonical records the plan will read (rubrics, observations, attendance, a coaching goal, a school record, a pathway)
  const rub = async (name, dims) => { const [r] = await sql('INSERT INTO coaching_rubrics(coach_id, name) VALUES ($1,$2) RETURNING id', [coach.id, name]); await sql('INSERT INTO coaching_rubric_versions(rubric_id, version, dimensions) VALUES ($1,1,$2)', [r.id, JSON.stringify(dims)]); return r.id; };
  const tech = await rub('Technical skills', [{ key: 'passing', name: 'Passing' }, { key: 'first_touch', name: 'First touch' }]);
  const tact = await rub('Game understanding', [{ key: 'positioning', name: 'Positioning' }, { key: 'pressing', name: 'Pressing triggers' }]);
  const observe = (athlete, rid, dim, score, daysAgo) => sql("INSERT INTO coaching_observations(coach_id, athlete_id, note, visibility, rubric_id, rubric_version, dimension_key, score, obs_type, observed_at) VALUES ($1,$2,'shared note','player',$3,1,$4,$5,'progress', now() - ($6::int || ' days')::interval)", [coach.id, athlete.id, rid, dim, score, daysAgo]);
  const tennis = await rub('Tennis technical', [{ key: 'serve', name: 'Serve' }, { key: 'forehand', name: 'Forehand' }, { key: 'backhand', name: 'Backhand' }, { key: 'return', name: 'Return of serve' }]);
  const tennisTactics = await rub('Tennis tactical', [{ key: 'point_construction', name: 'Point construction' }]);
  for (const [i, u] of tpeers.entries()) for (const [d, base] of [[40, 2.4], [8, 2.7]]) await observe(u, tennis, 'serve', Math.round((base + i * 0.35) * 10) / 10, d);
  for (const [s, d] of [[2.6, 100], [2.8, 70], [3.0, 40], [3.1, 12]]) await observe(mia, tennis, 'serve', s, d);
  for (const [s, d] of [[3.2, 90], [3.3, 20]]) await observe(mia, tennis, 'forehand', s, d);
  for (const [s, d] of [[2.4, 118], [2.6, 110], [2.8, 100]]) await observe(tom, tech, 'passing', s, d);
  for (const [s, d] of [[3.0, 115], [3.1, 105]]) await observe(tom, tech, 'first_touch', s, d);
  for (let d = 119; d >= 85; d -= 7) await sql("INSERT INTO org_attendance(cohort_id, user_id, session_date, status, recorded_by) VALUES ($1,$2,current_date - $3::int,$4,$5)", [cohort.id, tom.id, d, d % 21 === 0 ? 'absent' : 'present', coach.id]);
  const [goal] = await sql("INSERT INTO coaching_goals(coach_id, athlete_id, title, category, status, review_on, athlete_text) VALUES ($1,$2,'Scan before receiving','tactical','active', current_date + 21, 'Check both shoulders before every pass') RETURNING id", [coach.id, tom.id]);
  const [ev] = await sql("INSERT INTO academic_evidence(user_id, kind, institution, period_from, period_to, summary_enc, provenance) VALUES ($1,'report','St Bede''s Grammar School',current_date - 200,current_date - 30,'x','institution_issued') RETURNING id", [tom.id]);
  const pw = await call('POST', `/organisations/${org.id}/academy/pathways`, { token: owner.token, body: { title: 'Outfield player pathway', sport: 'football' } });
  await call('POST', `/academy/pathways/${pw.id}/versions`, { token: owner.token, body: { row_version: pw.row_version, levels: [{ key: 'foundation', title: 'Foundation', position: 1 }, { key: 'development', title: 'Development', position: 2, prerequisites: ['foundation'] }, { key: 'performance', title: 'Performance', position: 3, prerequisites: ['development'] }] } });
  await call('POST', `/academy/pathways/${pw.id}/decisions`, { token: owner.token, body: { athlete_id: tom.id, decision: 'place', to_level: 'development', expected_from_level: null, reason: 'Placed after the autumn trials', idempotency_key: 'place-tom-01' } });
  log('seeded records');
  // ---------- the plan, written through the API exactly as the screens do
  const P = `/organisations/${org.id}/academy/dev-plans`;
  const plan = await call('POST', P, { token: coach.token, body: { athlete_id: tom.id, season_label: '2026/27', starts_on: plusDays(-120), ends_on: plusDays(190), pathway_id: pw.id, focus: 'Become a composed first-team-ready central midfielder: quicker decisions, a stronger base, school and sport in balance.', review_every_days: 42, idempotency_key: 'plan-tom' } });
  const obj = (b) => call('POST', `/academy/dev-plans/${plan.id}/objectives`, { token: coach.token, body: b });
  const o1 = await obj({ domain: 'technical', title: 'Raise passing accuracy under pressure', competency: 'Passing', metric_kind: 'rubric', rubric_id: tech, dimension_key: 'passing', target_value: 4.2, owner_id: coach.id, due_on: plusDays(150) });
  await obj({ domain: 'technical', title: 'Clean first touch with both feet', competency: 'First touch', metric_kind: 'rubric', rubric_id: tech, dimension_key: 'first_touch', target_value: 4, owner_id: coach.id, due_on: plusDays(150) });
  await obj({ domain: 'tactical', title: 'Read pressing triggers and position early', competency: 'Pressing triggers', metric_kind: 'rubric', rubric_id: tact, dimension_key: 'pressing', target_value: 4, owner_id: coach.id });
  await obj({ domain: 'tactical', title: 'Scan before receiving', metric_kind: 'coach_goal', coach_goal_id: goal.id, owner_id: coach.id });
  await obj({ domain: 'physical', title: 'Hold training attendance at or above 92%', metric_kind: 'attendance', target_value: 92, owner_id: cond.id, due_on: plusDays(180) });
  await obj({ domain: 'physical', title: 'Complete the strength base block', metric_kind: 'milestones', owner_id: cond.id, due_on: plusDays(90), milestones: [{ title: 'Baseline screening done', due_on: plusDays(-90) }, { title: 'Block 1 completed', due_on: plusDays(-20) }, { title: 'Block 2 completed', due_on: plusDays(60) }] });
  await obj({ domain: 'mental', title: 'Build a pre-match routine and use it every game', metric_kind: 'milestones', owner_id: psy.id, due_on: plusDays(120), milestones: [{ title: 'Routine agreed with psychologist', due_on: plusDays(-60) }, { title: 'Used in 5 consecutive matches', due_on: plusDays(40) }] });
  await obj({ domain: 'academic', title: 'Keep grades steady through exam periods', metric_kind: 'milestones', owner_id: edu.id, visibility: 'athlete', milestones: [{ title: 'Term report shared', due_on: plusDays(-30) }, { title: 'Exam-week training plan agreed', due_on: plusDays(25) }] });
  await obj({ domain: 'personal', title: 'Weekly check-in on settling into the residence', metric_kind: 'milestones', owner_id: edu.id, visibility: 'staff', milestones: [{ title: 'First four check-ins held', due_on: plusDays(-10) }] });
  // later evidence arrives after the baselines were taken, so the trend is visible
  for (const [s, d] of [[3.0, 70], [3.3, 45], [3.5, 20], [3.6, 6]]) await observe(tom, tech, 'passing', s, d);
  for (const [s, d] of [[3.2, 60], [3.4, 25]]) await observe(tom, tech, 'first_touch', s, d);
  for (let d = 78; d >= 1; d -= 7) await sql("INSERT INTO org_attendance(cohort_id, user_id, session_date, status, recorded_by) VALUES ($1,$2,current_date - $3::int,$4,$5)", [cohort.id, tom.id, d, d % 28 === 1 ? 'absent' : 'present', coach.id]);
  const detail = () => call('GET', `/academy/dev-plans/${plan.id}`, { token: coach.token });
  let v = await detail();
  const msOf = (title) => v.domains.physical.objectives.concat(v.domains.mental.objectives, v.domains.academic.objectives, v.domains.personal.objectives).find((o) => o.title === title);
  const mark = async (title, ms) => { const o = msOf(title); for (const m of o.milestones.filter((x) => ms.includes(x.title))) await call('POST', `/academy/dev-objectives/${o.id}/milestones`, { token: coach.token, body: { milestone_id: m.id, status: 'done' } }); };
  await mark('Complete the strength base block', ['Baseline screening done', 'Block 1 completed']); await mark('Build a pre-match routine and use it every game', ['Routine agreed with psychologist']); await mark('Keep grades steady through exam periods', ['Term report shared']);
  for (const [uid, discipline, domains] of [[edu.id, 'education', ['academic', 'personal']], [psy.id, 'psychology', ['mental']], [cond.id, 'conditioning', ['physical']]]) await call('POST', `/academy/dev-plans/${plan.id}/contributors`, { token: coach.token, body: { user_id: uid, discipline, domains } });
  const phys = await reg('riverside_physio', 'Dr Amara Singh', ['athlete']); await sql("UPDATE users SET roles='{physio}' WHERE id=$1", [phys.id]);
  await sql("INSERT INTO provider_profiles(user_id, provider_type, clinic, city, specialties) VALUES ($1,'physio','Riverside Sports Physio','Leeds','{rehab}')", [phys.id]);
  await sql("INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, expires_at) VALUES ('physio','user',$1,$1,'approved',1, now() + interval '1 year')", [phys.id]);
  await call('POST', `/organisations/${org.id}/academy/providers`, { token: owner.token, body: { provider_id: phys.id, relation: 'retained' } });
  await call('POST', `/academy/dev-plans/${plan.id}/contributors`, { token: coach.token, body: { user_id: phys.id, discipline: 'physio_provider', domains: [] } });
  const task = (b) => call('POST', `/academy/dev-plans/${plan.id}/interventions`, { token: coach.token, body: b });
  await task({ kind: 'conditioning', title: 'Two strength sessions a week, hamstring emphasis', owner_id: cond.id, objective_id: msOf('Complete the strength base block').id, due_on: plusDays(30), visibility: 'athlete' });
  await task({ kind: 'psychology_session', title: 'Fortnightly routine rehearsal and visualisation', owner_id: psy.id, due_on: plusDays(-4), visibility: 'athlete', objective_id: msOf('Build a pre-match routine and use it every game').id });
  await task({ kind: 'tutoring', title: 'Maths and physics tutoring before exams', owner_id: edu.id, due_on: plusDays(14), visibility: 'athlete', objective_id: msOf('Keep grades steady through exam periods').id });
  await task({ kind: 'provider_referral', title: 'Pre-season hamstring screen', owner_id: phys.id, due_on: plusDays(10) });
  await task({ kind: 'guardian_meeting', title: 'Review the season plan with Maria', owner_id: coach.id, due_on: plusDays(7), visibility: 'athlete' });
  await call('PATCH', `/academy/dev-plans/${plan.id}`, { token: coach.token, body: { row_version: (await detail()).plan.row_version, status: 'active' } });
  // one signed-off review shared with the family, and a second one open
  const rev = await call('POST', `/academy/dev-plans/${plan.id}/reviews`, { token: coach.token, body: { period_from: plusDays(-120), period_to: plusDays(-45) } });
  await call('PATCH', `/academy/dev-reviews/${rev.id}`, { token: coach.token, body: { row_version: 1, summary: 'A good start. Passing is improving month on month and attendance is strong. We will lighten the load around exams and keep building the pre-match routine.', domain_notes: { technical: 'Passing 2.6 to 3.3. First touch steady.', tactical: 'No pressing data yet: add a video-review block.', physical: 'Screening done. Block 1 on track.', mental: 'Routine agreed; not yet used consistently.', academic: 'Grades steady at school; exams in 8 weeks.', personal: 'Settling well.' } } });
  await call('POST', `/academy/dev-reviews/${rev.id}/sign`, { token: edu.token, body: { decision: 'approve', comment: 'Academic picture is steady.' } });
  await call('POST', `/academy/dev-reviews/${rev.id}/sign`, { token: coach.token, body: { decision: 'approve', comment: 'Agreed with all specialists.', share_with_family: true } });
  await call('POST', `/academy/dev-plans/${plan.id}/decisions`, { token: coach.token, body: { kind: 'adjust_load', reason: 'Lighter training weeks during the exam period', review_id: rev.id, idempotency_key: 'dec-tom-1' } });
  await call('POST', `/academy/dev-plans/${plan.id}/reviews`, { token: coach.token, body: { period_from: plusDays(-44), period_to: plusDays(0) } });
  // two more plans so the list is realistic
  await call('PATCH', `/academy/dev-plans/${plan.id}`, { token: coach.token, body: { row_version: (await detail()).plan.row_version, phases: [{ kind: 'pre_season', from: plusDays(-120), to: plusDays(-70) }, { kind: 'competition', from: plusDays(-69), to: plusDays(15) }, { kind: 'exams', label: 'Summer exams', from: plusDays(16), to: plusDays(50) }, { kind: 'recovery', from: plusDays(51), to: plusDays(75) }, { kind: 'competition', label: 'Autumn season', from: plusDays(76), to: plusDays(190) }] } });
  await call('POST', `/academy/dev-plans/${plan.id}/interventions`, { token: coach.token, body: { kind: 'conditioning', title: 'Peak strength block', owner_id: cond.id, due_on: plusDays(30) } });
  const miaPlan = await call('POST', P, { token: coach.token, body: { athlete_id: mia.id, season_label: '2026/27', starts_on: plusDays(-100), ends_on: plusDays(200), idempotency_key: 'plan-mia' } });
  await call('POST', `/academy/dev-plans/${miaPlan.id}/objectives`, { token: coach.token, body: { domain: 'physical', title: 'Build a robust base before the autumn tour', metric_kind: 'milestones', owner_id: cond.id, milestones: [{ title: 'Screening complete', due_on: plusDays(-40) }, { title: 'Strength block 1 complete', due_on: plusDays(30) }] } });
  await call('PATCH', `/academy/dev-plans/${miaPlan.id}`, { token: coach.token, body: { row_version: miaPlan.row_version, status: 'active' } });
  for (const [u, label] of [[priya, '2026/27']]) await call('POST', P, { token: owner.token, body: { athlete_id: u.id, season_label: label, starts_on: plusDays(-30), ends_on: plusDays(280), lead_id: coach.id, idempotency_key: `plan-${u.handle}` } });
  for (const [u, label] of []) await call('POST', P, { token: owner.token, body: { athlete_id: u.id, season_label: label, starts_on: plusDays(-30), ends_on: plusDays(280), lead_id: coach.id, idempotency_key: `plan-${u.handle}` } });
  log('seeded plan');

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: true }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${r.status()} ${await r.text()}`);
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(3500); if (process.env.DEBUGSHOT) await page.screenshot({ path: OUT + 'debug-login.png' });
    return { ctx, page };
  };
  const wait = (p, ms = 1500) => p.waitForTimeout(ms);
  const shot = async (p, n, scrolls = 0) => { await p.screenshot({ path: `${OUT}${n}.png` });
    for (let i = 1; i <= scrolls; i++) { await p.mouse.move(p.viewportSize().width / 2, p.viewportSize().height / 2); await p.mouse.wheel(0, p.viewportSize().height * 0.85); await wait(p, 700); await p.screenshot({ path: `${OUT}${n}-scroll${i}.png` }); } };
  const vis = async (p, t) => (await p.getByText(t).count()) > 0;
  const click = async (p, t, ms = 1800) => { await p.getByText(t, { exact: true }).first().click(); await wait(p, ms); };
  const side = async (p, name, ms = 2200) => { await p.getByRole('tab', { name: new RegExp(name) }).first().click(); await wait(p, ms); };
  const openOrgs = async (p) => { await p.getByLabel('Organisations').first().click(); await wait(p, 2500); };
  const openAcademy = async (p) => { await p.getByText(/Riverside Football Academy/).first().click(); await wait(p, 2800); await click(p, 'Academy', 2800); };
  const openPlans = async (p) => { await openAcademy(p); await side(p, 'Progress'); await click(p, 'Development plans', 2500); };

  // ---- 1. technical director on desktop
  const { page: d } = await session(owner, { width: 1280, height: 1100 });
  await openPlans(d);
  check(await vis(d, 'Athlete development plans'), 'owner: the development plans live inside Academy → Progress');
  check(await vis(d, 'Tom Alvarez') && await vis(d, 'Priya Nair'), 'owner: every athlete plan is listed');
  await shot(d, '01-plans-list-desktop');
  await click(d, 'Tom Alvarez', 3000);
  check(await vis(d, 'Objectives by domain') && await vis(d, /There is no combined talent score/), 'plan: six domains, and the page says there is no combined score');
  check(await vis(d, /Passing/) && await vis(d, /Coach observations/), 'plan: a rubric objective shows its figure with its source');
  check(await vis(d, /Pathway|Outfield player pathway/), 'plan: the #395 pathway and level are shown, linked, not copied');
  await shot(d, '02-plan-detail-desktop', 3);
  await click(d, '🧠 Mental · 1', 1500); await shot(d, '03-plan-mental-desktop');
  await click(d, '♟️ Tactical · 2', 1500); check(await vis(d, 'No data'), 'plan: an objective with no evidence says "No data", not zero'); await shot(d, '04-plan-tactical-nodata-desktop');
  await d.getByText('Add objective', { exact: true }).first().click(); await wait(d, 1500); await shot(d, '05-builder-1-domain-desktop');
  await d.getByText('Technical', { exact: true }).first().click(); await click(d, 'Next', 1800); await shot(d, '05b-builder-2-competency-desktop'); await d.keyboard.press('Escape'); await wait(d, 600);
  await d.getByText('Sign off', { exact: true }).first().scrollIntoViewIfNeeded().catch(() => {}); await shot(d, '06-plan-side-desktop');
  // ---- 1b. tennis: the guided builder with a peer benchmark, and the squad board
  await d.getByText(/All plans/).first().click(); await wait(d, 2000); await click(d, 'Squad board', 3000);
  check(await vis(d, 'Squad board') && await vis(d, /No objective in/), 'board: attention reasons are explained, with uncovered domains named');
  await shot(d, '06b-squad-board-desktop', 1);
  await d.getByText(/Mia Chen/).first().click(); await wait(d, 3000);
  await d.getByText('Add objective', { exact: true }).first().click(); await wait(d, 1500);
  await d.getByText('Technical', { exact: true }).first().click(); await click(d, 'Next', 2500);
  check(await vis(d, 'Serve') && await vis(d, 'Return of serve') && await vis(d, 'Forehand'), 'builder: tennis shows its own competencies (serve, return, forehand)');
  await shot(d, '05c-builder-tennis-competencies-desktop');
  await d.getByText('Serve', { exact: true }).first().click(); await click(d, 'Next', 2500);
  check(await vis(d, /Against 6 peers in the same groups/) && await vis(d, /Suggested target/), 'builder: anonymised peer benchmark and a suggested target with its method');
  await shot(d, '05d-builder-3-target-desktop', 1);
  await click(d, 'Next', 1800); await shot(d, '05e-builder-4-support-desktop', 1); await click(d, 'Next', 1800); await shot(d, '05f-builder-5-review-desktop');
  await d.getByText('Create objective', { exact: true }).first().click(); await wait(d, 3000);
  check(await vis(d, /Raise Serve/), 'builder: the objective, its checkpoints and tasks are created in one go');
  await shot(d, '05g-tennis-plan-desktop', 1);
  await d.context().close();
  // ---- 2. phone and tablet
  const { page: ph } = await session(coach, { width: 390, height: 844 });
  await openPlans(ph); await click(ph, 'Squad board', 2800); await shot(ph, '07b-squad-board-phone', 1); await click(ph, 'Plans', 2000); await shot(ph, '07-plans-list-phone', 1); await click(ph, 'Tom Alvarez', 3000); await shot(ph, '08-plan-detail-phone', 4);
  await ph.context().close();
  const { page: tb } = await session(coach, { width: 820, height: 1180 });
  await openPlans(tb); await click(tb, 'Tom Alvarez', 3000); await shot(tb, '09-plan-detail-tablet', 2);
  await tb.context().close();
  // ---- 3. specialist (education) and provider: role-safe views
  const { page: ed } = await session(edu, { width: 390, height: 844 });
  const edView = await call('GET', `/academy/dev-plans/${plan.id}`, { token: edu.token });
  check(edView.domains.technical.objectives.length === 0 && edView.domains.academic.objectives.length === 1, 'education: sees only their domains');
  const pvView = await call('GET', `/academy/dev-plans/${plan.id}`, { token: phys.token });
  check(Object.keys(pvView.domains).length === 0 && pvView.interventions.length === 1 && pvView.plan.focus === null, 'provider: sees only the task assigned to them, no objectives or focus');
  await ed.context().close();
  // ---- 4. athlete / guardian
  const { page: gu } = await session(parent, { width: 390, height: 844 });
  await gu.goto('http://localhost:4100/?open=organisations'); await wait(gu, 3500);
  await gu.getByText(/My academy/).first().click(); await wait(gu, 2500); await click(gu, 'Progress', 2500);
  check(await vis(gu, 'Athlete development plans'), 'guardian: sees the child’s development plan under My academy → Progress');
  await shot(gu, '10-guardian-progress-phone');
  await gu.getByText(/Riverside Football Academy/).first().click().catch(() => {}); await wait(gu, 2500); await shot(gu, '11-guardian-plan-phone', 3);
  const fam = await call('GET', `/academy/dev-plans/${plan.id}`, { token: parent.token });
  check(!JSON.stringify(fam).includes('Settling well') && fam.domains.personal.objectives.length === 0, 'guardian: staff-only objectives and staff notes are not in the response');
  check(fam.reviews.length === 1 && fam.reviews[0].domain_notes === null, 'guardian: only the signed-off, shared review, without the staff domain notes');
  await gu.context().close();
  await browser.close();
} catch (e) { console.error(e); failures++; }
finally { api.kill(); web.close(); await db.end(); log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0); }
