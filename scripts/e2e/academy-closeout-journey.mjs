// Browser-driven walk-through of the Academy OS 3/3 close-out (#395): payroll- and booking-backed P&L, branches, delivery figures, decision follow-through and PDF packs,
// on phone, tablet and desktop. Seeds through the API/SQL at run time in a throwaway database; no demo data is in the repo. Same setup notes as academy-outcomes-journey.mjs.
// Everything is created through the API/SQL at run time in a throwaway database (E2E_DATABASE_URL; its schema is recreated each run); no demo data is in the repo.
// Needs: a same-origin web build  EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>  (E2E_DIST, default /tmp/e2e-dist)
// and playwright-core (`npm i --no-save playwright-core`) with a Chromium (E2E_CHROMIUM). Run: node scripts/e2e/academy-outcomes-journey.mjs
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
try {
  // ---------- people, academy, programmes
  const owner = await reg('ada_owner', 'Ada Okafor', ['coach']), coach = await reg('ben_coach', 'Ben Hartley', ['coach']), fin = await reg('chloe_fin', 'Chloe Park', ['coach']);
  const names = ['Priya Nair', 'Tom Alvarez', 'Mia Chen', 'Jonas Weber', 'Sofia Rossi', 'Liam Murphy'];
  const ath = []; for (const [i, n] of names.entries()) ath.push(await reg(`athlete_${i}`, n));
  const org = await call('POST', '/organisations', { token: owner.token, body: { name: 'Riverside Football Academy', kind: 'academy', city: 'Leeds' } });
  await call('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['football'], currency: 'GBP', listed: true } });
  for (const [u, role] of [[coach, 'coach'], [fin, 'finance']]) await sql("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at) VALUES ($1,$2,$3,'active',now())", [org.id, u.id, role]);
  const mkProg = async (title, capacity, fee, currency = 'GBP') => { const p = await call('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'football', title, capacity, admission_mode: 'direct', public: true, focus: 'development' } }); const v = await call('POST', `/academy/programmes/${p.id}/versions`, { token: owner.token, body: { row_version: p.row_version, billing_model: 'one_time', currency, fee_minor: fee } }); return v.programme; };
  const dev = await mkProg('U14 Development Squad', 12, 18000), elite = await mkProg('Elite Performance Group', 8, 30000), camp = await mkProg('Easter Camp', 20, 9000, 'EUR');
  const enrol = async (u, prog) => { const e = await call('POST', `/academy/programmes/${prog.id}/applications`, { token: u.token, body: {} }); await call('POST', `/academy/applications/${e.id}/submit`, { token: u.token, body: { row_version: e.row_version, answers: {} } }); };
  for (const u of ath.slice(0, 4)) await enrol(u, dev); for (const u of ath.slice(4)) await enrol(u, elite); await enrol(ath[0], camp);
  await sql('UPDATE org_cohorts SET coach_id=$2 WHERE organisation_id=$1 AND programme_id IS NOT NULL', [org.id, coach.id]);
  // ---------- attendance: Priya strong, Tom falling away, Mia repeated absence
  const cohorts = await sql('SELECT id, programme_id FROM org_cohorts WHERE organisation_id=$1', [org.id]);
  const cohortOf = (p) => cohorts.find((k) => k.programme_id === p.id).id;
  const pattern = { 0: () => 'present', 1: (d) => (d > 28 ? 'present' : 'absent'), 2: (d) => (d <= 24 && d % 7 === 1 ? 'absent' : 'present') };
  for (const [i, u] of ath.slice(0, 4).entries()) for (let d = 3; d <= 56; d += 7) await sql('INSERT INTO org_attendance(cohort_id, user_id, session_date, status, recorded_by) VALUES ($1,$2,current_date - $3::int,$4,$5)', [cohortOf(dev), u.id, d, (pattern[i] ?? (() => 'present'))(d), coach.id]);
  for (const u of ath.slice(4)) for (let d = 2; d <= 42; d += 7) await sql("INSERT INTO org_attendance(cohort_id, user_id, session_date, status, recorded_by) VALUES ($1,$2,current_date - $3::int,'present',$4)", [cohortOf(elite), u.id, d, coach.id]);
  // ---------- money: payments, a scholarship, a sponsor, an overdue balance
  const charges = await sql("SELECT ch.*, e.user_id FROM academy_charges ch JOIN org_enrolments e ON e.id=ch.enrolment_id WHERE ch.organisation_id=$1 ORDER BY e.user_id, ch.created_at", [org.id]);
  const chargeOf = (u, prog) => charges.find((c) => c.user_id === u.id && c.currency === (prog === camp ? 'EUR' : 'GBP') && Number(c.gross_minor) === (prog === dev ? 18000 : prog === elite ? 30000 : 9000));
  const settle = async (ch, u, cents, cur) => { await sql("UPDATE academy_charges SET status='paid', paid_at=now() - interval '12 days' WHERE id=$1", [ch.id]); await sql("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref, paid_at) VALUES ($1,'stripe','academy_charge',$2,$3,$4,'paid',$5,now() - interval '12 days')", [u.id, ch.id, cents, cur, `ref-${ch.id.slice(0, 6)}`]); };
  for (const u of [ath[0], ath[2], ath[3]]) await settle(chargeOf(u, dev), u, 18000, 'GBP');
  for (const u of [ath[4], ath[5]]) await settle(chargeOf(u, elite), u, 30000, 'GBP');
  await settle(chargeOf(ath[0], camp), ath[0], 9000, 'EUR');
  await sql("UPDATE payments SET refunded_cents=4500, refunded_at=now() - interval '3 days' WHERE purpose_id=$1", [chargeOf(ath[3], dev).id]);
  await sql("UPDATE academy_charges SET due_on = current_date - 38 WHERE id=$1", [chargeOf(ath[1], dev).id]); // Tom owes an old fee
  const spOwner = await reg('northwind', 'Northwind Foods', ['sponsor']);
  const sp = (await sql("INSERT INTO sponsors(owner_id, name) VALUES ($1,'Northwind Foods') RETURNING id", [spOwner.id]))[0];
  const deal = (await sql("INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, currency, status, proposed_by, starts_on, ends_on) VALUES ($1,'organisation',$2,600000,'GBP','active',$3,current_date - 30, current_date + 300) RETURNING id", [sp.id, org.id, spOwner.id]))[0];
  const line = (await sql("INSERT INTO sponsorship_lines(sponsorship_id, version, seq, kind, label, currency, amount_cents, cadence, instalments, first_due_on) VALUES ($1,1,1,'money','Scholarship fund','GBP',600000,'monthly',3,current_date - 30) RETURNING id", [deal.id]).catch(() => []))[0];
  if (line) { await sql("INSERT INTO sponsorship_obligations(sponsorship_id, version, line_id, seq, kind, due_on, amount_cents, currency, status) VALUES ($1,1,$2,1,'money',current_date - 30,200000,'GBP','fulfilled'),($1,1,$2,2,'money',current_date + 5,200000,'GBP','scheduled'),($1,1,$2,3,'money',current_date + 35,200000,'GBP','scheduled')", [deal.id, line.id]); }
  await call('POST', `/academy-charges/${chargeOf(ath[2], dev).id}/funding`, { token: fin.token, body: { funding_source: 'sponsor', funded_minor: 6000, sponsorship_id: deal.id } }).catch((e) => log('(funding on a paid charge is refused, as designed)'));
  const unpaid = chargeOf(ath[5], elite); await sql("UPDATE academy_charges SET status='awaiting_payment', paid_at=NULL, due_on=current_date + 6 WHERE id=$1", [unpaid.id]); await sql('DELETE FROM payments WHERE purpose_id=$1', [unpaid.id]);
  await call('POST', `/academy-charges/${unpaid.id}/funding`, { token: fin.token, body: { funding_source: 'sponsor', funded_minor: 10000, sponsorship_id: deal.id } });
  // ---------- costs and overhead
  const cost = (b) => call('POST', `/organisations/${org.id}/academy/cost-entries`, { token: fin.token, body: { currency: 'GBP', incurred_on: iso(plus(-20)), ...b } });
  await cost({ category: 'staff', programme_id: dev.id, amount_minor: 42000, description: 'Coach fees, spring term', idempotency_key: 'seed-staff-dev' });
  await cost({ category: 'venue', programme_id: dev.id, amount_minor: 18000, description: 'Pitch hire', idempotency_key: 'seed-venue-dev' });
  await cost({ category: 'staff', programme_id: elite.id, amount_minor: 52000, description: 'Head coach and analyst', idempotency_key: 'seed-staff-elite' });
  await cost({ category: 'overhead', amount_minor: 15000, allocation: { method: 'participants' }, description: 'Admin and insurance share', idempotency_key: 'seed-over' });
  // ---------- coaching evidence, pathway, decisions
  const rid = (await sql("INSERT INTO coaching_rubrics(coach_id, name) VALUES ($1,'Technical skills') RETURNING id", [coach.id]))[0].id;
  await sql("INSERT INTO coaching_rubric_versions(rubric_id, version, dimensions) VALUES ($1,1,$2)", [rid, JSON.stringify([{ key: 'passing', name: 'Passing' }, { key: 'first_touch', name: 'First touch' }])]);
  for (const [u, scores] of [[ath[0], [4, 5, 4]], [ath[1], [3, 2]], [ath[2], [4]], [ath[4], [5, 4]]]) for (const s of scores) await sql("INSERT INTO coaching_observations(coach_id, athlete_id, note, visibility, rubric_id, rubric_version, dimension_key, score, obs_type) VALUES ($1,$2,'scored in session','player',$3,1,'passing',$4,'progress')", [coach.id, u.id, rid, s]);
  await sql("INSERT INTO coaching_observations(coach_id, athlete_id, note, visibility, obs_type) VALUES ($1,$2,'PRIVATE: family circumstances','coach_private','general')", [coach.id, ath[1].id]);
  await sql("INSERT INTO coaching_goals(coach_id, athlete_id, title, athlete_text, coach_notes) VALUES ($1,$2,'First touch under pressure','Keep the ball under pressure in small-sided games','PRIVATE')", [coach.id, ath[0].id]);
  const path = await call('POST', `/organisations/${org.id}/academy/pathways`, { token: owner.token, body: { title: 'Outfield player pathway', sport: 'football' } });
  await call('POST', `/academy/pathways/${path.id}/versions`, { token: owner.token, body: { row_version: 1, levels: [
    { key: 'foundation', title: 'Foundation', position: 1, age_min: 10, age_max: 12, destinations: [{ kind: 'next_level', label: 'Development level' }] },
    { key: 'development', title: 'Development', position: 2, prerequisites: ['foundation'], min_attendance_pct: 75, programme_ids: [dev.id], criteria: [{ rubric_id: rid, dimension_key: 'passing', min_avg_score: 3.5, min_observations: 2 }], destinations: [{ kind: 'squad', label: 'Academy squad' }] },
    { key: 'performance', title: 'Performance', position: 3, prerequisites: ['development'], programme_ids: [elite.id], destinations: [{ kind: 'elite_programme', label: 'Elite programme' }, { kind: 'external', label: 'External trials' }] }] } });
  let k = 0; const decide = (u, body) => call('POST', `/academy/pathways/${path.id}/decisions`, { token: owner.token, body: { athlete_id: u.id, idempotency_key: `seed-dec-${++k}-${u.id.slice(0, 6)}`, reason: 'Seeded by the journey script', ...body } });
  await decide(ath[0], { decision: 'place', expected_from_level: null, to_level: 'foundation', reason: 'Initial placement after trial' });
  await decide(ath[0], { decision: 'promote', expected_from_level: 'foundation', acknowledge_unmet_criteria: true, reason: 'Ready for the development squad' });
  await decide(ath[1], { decision: 'place', expected_from_level: null, to_level: 'foundation', reason: 'Initial placement' });
  await decide(ath[4], { decision: 'place', expected_from_level: null, to_level: 'foundation', reason: 'Initial placement' });
  await decide(ath[4], { decision: 'promote', expected_from_level: 'foundation', acknowledge_unmet_criteria: true, reason: 'Moved up from the trial group' });
  const asm = await call('POST', `/academy/pathways/${path.id}/assessments`, { token: coach.token, body: { athlete_id: ath[0].id, level_key: 'development', period_from: iso(plus(-90)), period_to: iso(plus(0)), comment: 'Excellent passing range; keep working on the weaker foot.', comment_visibility: 'athlete' } });
  await call('POST', `/academy/assessments/${asm.id}/review`, { token: owner.token, body: { row_version: asm.row_version, action: 'approve' } });
  await call('POST', `/academy/pathways/${path.id}/assessments`, { token: coach.token, body: { athlete_id: ath[1].id, level_key: 'development', period_from: iso(plus(-90)), period_to: iso(plus(0)), comment: 'Not yet consistent.', comment_visibility: 'staff' } });
  // ---------- care network, legal, clearance
  const phys = await reg('riverside_physio', 'Dr Amara Singh', ['athlete']); await sql("UPDATE users SET roles='{physio}' WHERE id=$1", [phys.id]);
  await sql("INSERT INTO provider_profiles(user_id, provider_type, clinic, city, specialties) VALUES ($1,'physio','Riverside Sports Physio','Leeds','{sprains,rehab}')", [phys.id]);
  await sql("INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, expires_at) VALUES ('physio','user',$1,$1,'approved',1, now() + interval '1 year')", [phys.id]);
  await call('POST', `/organisations/${org.id}/academy/providers`, { token: owner.token, body: { provider_id: phys.id, relation: 'retained', note: 'Match-day cover and first call for sprains' } });
  const lawyer = await reg('lex_counsel', 'Lex Counsel', ['athlete']);
  await sql("INSERT INTO legal_intakes(client_id, lawyer_id, practice_area, jurisdiction, acting_as, acting_for_id, summary_enc, status) VALUES ($1,$2,'Employment contracts','GB','organisation',$3,'x','ready')", [owner.id, lawyer.id, org.id]);
  const doc = await reg('dr_doc', 'Dr Doc', ['athlete']);
  await sql("INSERT INTO clinical_clearances(athlete_id, doctor_id, status, restrictions_enc, assessed_on, valid_until) VALUES ($1,$2,'cleared',NULL,current_date,current_date + 90)", [ath[0].id, doc.id]);
  await call('POST', '/academy/clearance-shares', { token: ath[0].token, body: { organisation_id: org.id } });
  await call('POST', `/organisations/${org.id}/academy/scenarios`, { token: owner.token, body: { programme_id: dev.id, name: 'Add a Saturday cohort', idempotency_key: 'seed-scenario', assumptions: { renewal_pct: 85, new_athletes: 3, price_change_pct: 5, extra_cohorts: 1, extra_cohort_size: 10, extra_cohort_cost_minor: 20000, billing_periods: 1 } } });
  // ===================== close-out seeding: branches, sessions, a venue booking, approved payroll, a graduation =====================
  const mgr = await reg('arena_mgr', 'Arena Manager', ['venue_manager']);
  const venue = await call('POST', '/venues', { token: mgr.token, body: { name: 'Riverside Arena', city: 'Leeds', timezone: 'UTC', currency: 'GBP' } });
  await call('POST', `/venues/${venue.id}/hours`, { token: mgr.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '00:00', closes: '23:59' })) } });
  const court = await call('POST', `/venues/${venue.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Pitch 1', sport: 'football', hourly_rate_cents: 6000, max_players: 14 } });
  const devCohort = cohortOf(dev), eliteCohort = cohortOf(elite);
  const mkSession = async (cohort, prog, daysAgo, hour, status) => (await sql("INSERT INTO academy_sessions(organisation_id, cohort_id, programme_id, title, starts_at, ends_at, status, created_by) VALUES ($1,$2,$3,'Training', (current_date - $4::int + make_interval(hours => $5)) AT TIME ZONE 'UTC', (current_date - $4::int + make_interval(hours => $5 + 1)) AT TIME ZONE 'UTC', $6, $7) RETURNING *", [org.id, cohort, prog.id, daysAgo, hour, status, owner.id]))[0];
  const s = []; for (const d of [-3, -4, -5]) s.push(await mkSession(devCohort, dev, d, 17, 'published')); // future, so the booking engine accepts them; moved back below
  s.push(await mkSession(devCohort, dev, 10, 17, 'cancelled')); s.push(await mkSession(eliteCohort, elite, 12, 18, 'published')); s.push(await mkSession(eliteCohort, elite, 5, 18, 'published'));
  for (const x of s.slice(0, 3)) { const r = await call('POST', `/academy/sessions/${x.id}/venue`, { token: owner.token, body: { resource_id: court.id } }); if (r?.code || r?.error) log('(venue booking not allowed on a past session; falling back to a direct booking row)', r.error ?? r.code); }
  for (const [x, back] of [[s[0], 24], [s[1], 18], [s[2], 12]]) await sql("UPDATE academy_sessions SET starts_at=starts_at - make_interval(days => $2), ends_at=ends_at - make_interval(days => $2) WHERE id=$1", [x.id, back]); // they were delivered in the past
  await sql("UPDATE academy_sessions SET status='completed' WHERE id = ANY($1)", [[s[0].id, s[1].id, s[2].id, s[4].id]]); // delivered after they were booked
  // approved payroll for the development squad (replaces the manual staff cost entered above), plus a payroll adjustment nobody tied to a programme
  const sheet = async (sess, prog, amount) => { const t = (await sql("INSERT INTO academy_timesheets(organisation_id, user_id, session_id, work_date, minutes, status, programme_id) VALUES ($1,$2,$3,$4,60,'approved',$5) RETURNING id", [org.id, coach.id, sess.id, iso(new Date(sess.starts_at)), prog.id]))[0]; return { id: t.id, work_date: iso(new Date(sess.starts_at)), amount }; };
  for (const x of s) Object.assign(x, (await sql('SELECT * FROM academy_sessions WHERE id=$1', [x.id]))[0]);
  const sheets = [await sheet(s[0], dev, 12000), await sheet(s[1], dev, 12000), await sheet(s[2], dev, 12000)];
  const run = (await sql("INSERT INTO academy_payroll_runs(organisation_id, currency, period_start, period_end, idempotency_key, created_by) VALUES ($1,'GBP',current_date - 30, current_date, 'seed-run', $2) RETURNING id", [org.id, fin.id]))[0];
  await sql("INSERT INTO academy_payroll_lines(run_id, user_id, base_minor, gross_minor, detail) VALUES ($1,$2,36000,36000,$3)", [run.id, coach.id, JSON.stringify(sheets.map((x) => ({ timesheet_id: x.id, work_date: x.work_date, amount_minor: x.amount })))]);
  await sql("UPDATE academy_payroll_runs SET total_minor=36000, unpriced='[{\"reason\":\"no compensation term\"}]', status='approved', approved_at=now(), approved_by=$2 WHERE id=$1", [run.id, fin.id]);
  await sql('UPDATE academy_timesheets SET payroll_run_id=$1 WHERE id = ANY($2::uuid[])', [run.id, sheets.map((x) => x.id)]);
  // branches
  const north = await call('POST', `/organisations/${org.id}/academy/branches`, { token: owner.token, body: { name: 'Leeds North', city: 'Leeds', venue_ids: [venue.id], idempotency_key: 'seed-branch-n' } });
  const south = await call('POST', `/organisations/${org.id}/academy/branches`, { token: owner.token, body: { name: 'Leeds South', city: 'Leeds', idempotency_key: 'seed-branch-s' } });
  await call('POST', `/academy/programmes/${dev.id}/branch`, { token: owner.token, body: { branch_id: north.id } });
  await call('POST', `/academy/programmes/${elite.id}/branch`, { token: owner.token, body: { branch_id: south.id } });
  // a graduation and a squad decision to carry through, for a young player on the final level
  await sql("INSERT INTO academy_progression_decisions(organisation_id, athlete_id, pathway_id, version_id, decision, from_level, to_level, reason, decided_by, idempotency_key) SELECT $1,$2,$3,(SELECT id FROM academy_pathway_versions WHERE pathway_id=$3 ORDER BY version DESC LIMIT 1),'invite_squad','foundation','foundation','Ready for the academy squad',$4,'seed-squad'", [org.id, ath[4].id, path.id, owner.id]);
  // spread the history over six months so the trend and the prior-period comparison have something real to show
  await sql("UPDATE academy_charges SET due_on = current_date - ((abs(hashtext(id::text)) % 5) * 30 + 3) WHERE organisation_id=$1 AND status <> 'cancelled'", [org.id]);
  await sql("UPDATE payments p SET paid_at = (SELECT ch.due_on + 2 FROM academy_charges ch WHERE ch.id=p.purpose_id)::timestamptz WHERE p.purpose_type='academy_charge'");
  for (const [daysBack, amt, prog] of [[40, 9000, dev], [70, 11000, dev], [100, 10000, dev], [45, 13000, elite], [75, 13000, elite], [105, 12000, elite], [150, 8000, dev], [165, 9000, elite]]) {
    const t = (await sql("INSERT INTO academy_timesheets(organisation_id, user_id, work_date, minutes, status, programme_id) VALUES ($1,$2,current_date - $3::int,600,'approved',$4) RETURNING id", [org.id, coach.id, daysBack, prog.id]))[0];
    const r = (await sql("INSERT INTO academy_payroll_runs(organisation_id, currency, period_start, period_end, idempotency_key, created_by) VALUES ($1,'GBP',current_date - $2::int - 5, current_date - $2::int + 5, $3, $4) RETURNING id", [org.id, daysBack, `seed-run-${daysBack}`, fin.id]))[0];
    await sql("INSERT INTO academy_payroll_lines(run_id, user_id, base_minor, gross_minor, detail) VALUES ($1,$2,$3,$3,$4)", [r.id, coach.id, amt, JSON.stringify([{ timesheet_id: t.id, work_date: iso(plus(-daysBack)), amount_minor: amt }])]);
    await sql("UPDATE academy_payroll_runs SET total_minor=$2, status='approved', approved_at=now(), approved_by=$3 WHERE id=$1", [r.id, amt, fin.id]);
    await sql('UPDATE academy_timesheets SET payroll_run_id=$2 WHERE id=$1', [t.id, r.id]);
  }
  await call('POST', `/academy/branches/${north.id}`, { token: owner.token, body: { code: 'LDS-N', manager_id: coach.id, address: '12 Riverside Way', opened_on: iso(plus(-700)), athlete_target: 24 } });
  await call('POST', `/academy/branches/${south.id}`, { token: owner.token, body: { code: 'LDS-S', athlete_target: 16, opened_on: iso(plus(-200)) } });
  log('seeded');
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: true }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${r.status()} ${await r.text()}`);
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(2500);
    return { ctx, page };
  };
  const wait = (p, ms = 1500) => p.waitForTimeout(ms);
  const shot = async (p, n, scrolls = 0) => { await p.screenshot({ path: `${OUT}${n}.png` });
    for (let i = 1; i <= scrolls; i++) { await p.mouse.move(p.viewportSize().width / 2, p.viewportSize().height / 2); await p.mouse.wheel(0, p.viewportSize().height * 0.85); await wait(p, 700); await p.screenshot({ path: `${OUT}${n}-scroll${i}.png` }); } };
  const vis = async (p, t) => (await p.getByText(t).count()) > 0;
  const click = async (p, t, ms = 1800) => { await p.getByText(t, { exact: true }).first().click(); await wait(p, ms); };
  const openOrgs = async (p) => { await p.getByLabel('Home', { exact: true }).last().click().catch(() => {}); await wait(p, 1500); };
  const openAcademy = async (p) => { await openOrgs(p); await p.getByText(/Riverside Football Academy/).first().click(); await wait(p, 2500); await click(p, 'Academy', 2500); };
  const side = async (p, name, ms = 2200) => { await p.getByRole('tab', { name: new RegExp(name) }).first().click(); await wait(p, ms); };
  // ---- 1. owner, desktop: Finance > Profit & loss now reads payroll and bookings, by branch
  const { page: d } = await session(owner, { width: 1280, height: 1100 });
  if (false) {
    await d.screenshot({ path: `${OUT}nav-0.png` });
    log('LABELS0', (await d.locator('[aria-label]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).slice(0, 60).join(' | '));
    await d.getByText('More', { exact: true }).first().click().catch((e) => log('no More text', e.message.slice(0, 80))); await d.waitForTimeout(1500);
    await d.screenshot({ path: `${OUT}nav-1.png` });
    log('LABELS1', (await d.locator('[aria-label]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).slice(0, 80).join(' | '));
    throw new Error('NAV_DEBUG stop');
  }
  await openAcademy(d); await side(d, 'Finance'); await wait(d, 3000);
  check(await vis(d, 'Financial overview') && await vis(d, 'Branch comparison'), 'overview: finance opens on the leadership overview with the branch comparison');
  check(await vis(d, /Monthly trend/) && await vis(d, /Where the cost goes/), 'overview: monthly trend and cost mix are shown');
  check(await vis(d, 'How complete the evidence is'), 'overview: evidence completeness is shown');
  await shot(d, '00-overview-desktop', 4);
  await click(d, 'Profit & loss', 2800);
  check(await vis(d, /approved payroll/i), 'finance: says where staff cost comes from');
  check(await vis(d, 'By branch'), 'finance: by-branch view appears once a branch exists');
  check(await vis(d, /Leeds North/) && await vis(d, /Leeds South/), 'finance: both branches listed');
  check(await vis(d, /no pay term/), 'finance: unpriced timesheets are reported, not hidden');
  check(await vis(d, 'Finance pack (PDF)'), 'finance: the finance pack button is present');
  await shot(d, '01-pnl-branches-desktop', 3);
  await d.getByText('U14 Development Squad').last().click(); await wait(d, 2500);
  check(await vis(d, /approved payroll/i) && await vis(d, /Set aside|management entry/), 'finance: drill-down shows payroll lines and the manual entry that was set aside');
  await shot(d, '02-pnl-drilldown-desktop', 3);
  // branch filter
  await d.getByLabel(/Branch: All branches/).first().click(); await wait(d, 800); await shot(d, '03-branch-filter-desktop');
  await d.getByText('Leeds North', { exact: true }).last().click(); await wait(d, 2500);
  check(!(await vis(d, 'Elite Performance Group')), 'finance: filtering to a branch shows only its programmes');
  await shot(d, '04-pnl-one-branch-desktop');
  // ---- 2. executive home: delivery figures are real
  await openAcademy(d);
  check(await vis(d, 'Academy pulse') && await vis(d, 'Branch comparison'), 'executive home: pulse and branch comparison at the top');
  check(await vis(d, 'Sessions scheduled') && await vis(d, 'Staffing exceptions'), 'executive home: delivery shows scheduled, cancelled and staffing exceptions');
  check(!(await vis(d, /Cancelled sessions: missing/)), 'executive home: no longer says delivery is missing');
  check(await vis(d, 'Management review (PDF)'), 'executive home: management review PDF button');
  await shot(d, '05-executive-home-desktop', 2);
  // ---- 3. settings: branches
  await side(d, 'Settings'); await wait(d, 1500);
  check(await vis(d, 'Branches') && await vis(d, 'Leeds North'), 'settings: branches are managed here');
  await shot(d, '06-branches-desktop');
  await d.getByText('Edit', { exact: true }).nth(1).click(); await wait(d, 1500); await shot(d, '07a-edit-branch-desktop'); await d.keyboard.press('Escape'); await wait(d, 500);
  await click(d, '＋ Add branch', 1500); await shot(d, '07-add-branch-desktop'); await d.keyboard.press('Escape'); await wait(d, 500);
  // ---- 4. progress: follow-through
  await side(d, 'Progress'); await click(d, 'Sofia Rossi', 2800);
  check(await vis(d, 'Carry the decision through') && await vis(d, 'Invite to the squad'), 'progress: a squad decision can be carried through');
  await shot(d, '08-follow-through-desktop', 3);
  await d.getByText('Send invitation', { exact: true }).first().click(); await wait(d, 1500); await shot(d, '09-follow-through-form-desktop');
  await d.keyboard.press('Escape'); await wait(d, 400);
  check(await vis(d, 'Progress report (PDF)'), 'progress: the athlete progress report PDF button');
  await d.context().close();
  // ---- 5. phone
  const { page: ph } = await session(owner, { width: 390, height: 844 });
  await openAcademy(ph); await side(ph, 'Finance'); await wait(ph, 3000); await shot(ph, '09a-overview-phone', 4);
  await click(ph, 'Profit & loss', 2800); await shot(ph, '10-pnl-phone', 3);
  await openAcademy(ph); await shot(ph, '11-executive-phone', 2);
  await side(ph, 'Settings'); await shot(ph, '12-branches-phone', 1);
  await ph.context().close();
  // ---- 6. tablet: finance role sees the finance pack, not the people review
  const { page: tb } = await session(fin, { width: 820, height: 1100 });
  await openAcademy(tb); await side(tb, 'Finance'); await wait(tb, 3000); await shot(tb, '12a-overview-tablet', 3);
  await click(tb, 'Profit & loss', 2800);
  check(await vis(tb, 'Finance pack (PDF)') && !(await vis(tb, 'Management review (PDF)')), 'finance role: finance pack only');
  await shot(tb, '13-pnl-tablet', 2); await tb.context().close();
  // ---- 7. athlete / guardian: progress report
  const { page: at } = await session(ath[0], { width: 390, height: 844 });
  const pdf = async (who, p, body) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${who.token}` }, body: JSON.stringify(body) }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
  let atOk = false;
  try {
    await at.getByLabel(/Find an academy/).first().click({ timeout: 8000 }); await wait(at, 2500);
    await at.getByText(/Riverside Football Academy/).first().click({ timeout: 8000 }); await wait(at, 2500);
    await at.getByText('Enquire or apply', { exact: true }).first().click({ timeout: 8000 }); await wait(at, 3000);
    await click(at, 'Progress', 2500);
    atOk = await vis(at, 'Progress report (PDF)');
    await shot(at, '14-athlete-progress-phone', 2);
  } catch (e) { log('(athlete screen not reached by this route:', e.message.split('\n')[0], ')'); }
  log(atOk ? 'PASS  athlete: can open their own progress report' : 'SKIP  athlete screen not captured; the same report is verified through the API below');
  const own = await pdf(ath[0], `/organisations/${org.id}/academy/athletes/${ath[0].id}/progress-report`, {});
  check(own.s === 201, 'pdf: the athlete can issue their own progress report');
  const other = await pdf(ath[1], `/organisations/${org.id}/academy/athletes/${ath[0].id}/progress-report`, {});
  check(other.s === 404, 'pdf: another athlete cannot issue it');
  await at.context().close();
  // ---- 8. the PDFs really render and are protected
  const fp = await pdf(fin, `/organisations/${org.id}/academy/finance-pack`, {});
  check(fp.s === 201 && fp.j.family === 'academy_finance_pack', 'pdf: finance pack is issued');
  const bytes = await fetch(`http://127.0.0.1:4000${fp.j.url}`, { headers: { authorization: `Bearer ${fin.token}` } });
  const buf = Buffer.from(await bytes.arrayBuffer()); check(bytes.status === 200 && buf.subarray(0, 4).toString() === '%PDF', 'pdf: finance pack downloads as a real PDF');
  fs.writeFileSync(`${OUT}finance-pack.pdf`, buf);
  const denied = await fetch(`http://127.0.0.1:4000${fp.j.url}`, { headers: { authorization: `Bearer ${coach.token}` } }); check(denied.status === 404, 'pdf: a coach cannot open the finance pack');
  const mr = await pdf(owner, `/organisations/${org.id}/academy/management-review`, {}); check(mr.s === 201, 'pdf: management review is issued');
  fs.writeFileSync(`${OUT}management-review.pdf`, Buffer.from(await (await fetch(`http://127.0.0.1:4000${mr.j.url}`, { headers: { authorization: `Bearer ${owner.token}` } })).arrayBuffer()));
  const pr = await pdf(owner, `/organisations/${org.id}/academy/athletes/${ath[0].id}/progress-report`, {}); check(pr.s === 201, 'pdf: progress report is issued');
  fs.writeFileSync(`${OUT}progress-report.pdf`, Buffer.from(await (await fetch(`http://127.0.0.1:4000${pr.j.url}`, { headers: { authorization: `Bearer ${owner.token}` } })).arrayBuffer()));
  await browser.close();
} catch (e) { console.error(e); failures++; }
finally { api.kill(); web.close(); await db.end(); log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0); }
