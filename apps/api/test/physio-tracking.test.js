// Physio rehab tracking: outcome readings, goals, home-exercise log, progress reports, suggestions, home and analytics.
// Same gates as treatment plans (verified credential + the patient's active full consent) and the patient keeps their own data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `pt_${n}_${roles[0]}`, display_name: `Track ${n}`, email: `pt${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201);
  const u = { ...r.body.user, token: r.body.token };
  if (roles[0] !== 'athlete') must(await api('POST', '/me/sport-profiles', { token: u.token, body: { sport: 'football', role: roles[0] } }), 201);
  return u;
};
const verify = (u, type) => pool.query("INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at) VALUES ($1,'user',$2,$2,'approved',1,now(), now() + interval '300 days')", [type, u.id]);
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

/** A patient who shared full records with a verified physio who has published a plan (3 days a week). */
const setup = async (reviewDays = 30) => {
  const ath = await signup(['athlete']), physio = await signup(['physio']);
  await verify(physio, 'physio');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: physio.id } }), 201);
  const ex = must(await api('POST', '/me/exercises', { token: physio.token, body: { title: 'Heel raise', body_region: 'ankle_foot', difficulty: 'beginner', goal: 'strength', instructions: 'Rise onto your toes slowly.' } }));
  const plan = must(await api('POST', '/treatment-plans', { token: physio.token, body: { patient_id: ath.id, title: 'Ankle rehab', goals: 'Walk without pain', review_date: day(reviewDays), items: [{ exercise_id: ex.id, sets: 3, reps: 10, times_per_week: 3 }] } }), 201);
  must(await api('POST', `/treatment-plans/${plan.id}/publish`, { token: physio.token, body: { base_version: 1, material_change: true } }));
  return { ath, physio, plan };
};
/** Pretend the plan was published `days` ago (the adherence window starts at publication). */
const age = (plan, days) => pool.query("UPDATE treatment_plan_versions SET published_at = now() - make_interval(days => $2) WHERE plan_id=$1 AND status='published'", [plan.id, days]);
const outcome = (physio, ath, body) => api('POST', '/physio/outcomes', { token: physio.token, body: { patient_id: ath.id, ...body } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('outcome readings: validated, encrypted, voided not deleted, summarised as a series; the patient sees them without notes', async () => {
  const { ath, physio, plan } = await setup();
  assert.equal((await outcome(physio, ath, { measure: 'pain', value: 11 })).status, 400, 'out of range');
  assert.equal((await outcome(physio, ath, { measure: 'range_of_motion', value: 90 })).status, 400, 'a joint measure needs a region');
  assert.equal((await outcome(physio, ath, { measure: 'pain', value: 5, measured_at: new Date(Date.now() + 864e5).toISOString() })).status, 400, 'not in the future');
  const first = must(await outcome(physio, ath, { measure: 'pain', value: 7, measured_at: new Date(Date.now() - 14 * 864e5).toISOString(), plan_id: plan.id, note: 'sharp on weight bearing' }), 201);
  must(await outcome(physio, ath, { measure: 'pain', value: 4 }), 201);
  const typo = must(await outcome(physio, ath, { measure: 'pain', value: 9 }), 201);
  must(await outcome(physio, ath, { measure: 'range_of_motion', body_region: 'ankle_foot', side: 'left', value: 25 }), 201);
  assert.ok(!(await pool.query('SELECT note_enc FROM physio_outcomes WHERE id=$1', [first.id])).rows[0].note_enc.includes('sharp'), 'notes are encrypted at rest');
  assert.equal((await api('POST', `/physio/outcomes/${typo.id}/void`, { token: physio.token, body: { reason: 'typo' } })).status, 200);
  assert.equal((await api('POST', `/physio/outcomes/${typo.id}/void`, { token: physio.token, body: { reason: 'again' } })).status, 409);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM physio_outcomes')).rows[0].n, 4, 'a voided reading is kept');

  const file = must(await api('GET', `/physio/patients/${ath.id}/progress`, { token: physio.token }));
  const pain = file.outcomes.find((s) => s.measure === 'pain');
  assert.equal(pain.count, 2); assert.equal(pain.baseline.value, 7); assert.equal(pain.latest.value, 4); assert.equal(pain.change, -3); assert.equal(pain.direction, 'improved');
  assert.equal(pain.points[0].note, 'sharp on weight bearing');
  assert.equal(file.outcomes.find((s) => s.measure === 'range_of_motion').direction, null, 'one reading has no direction');

  const mine = must(await api('GET', '/me/physio-progress', { token: ath.token }));
  assert.equal(mine.outcomes.find((s) => s.measure === 'pain').latest.value, 4);
  assert.equal(mine.outcomes.find((s) => s.measure === 'pain').points[0].note, undefined, 'the patient does not get clinician notes');

  const other = await signup(['physio']); await verify(other, 'physio');
  assert.equal((await outcome(other, ath, { measure: 'pain', value: 3 })).status, 403, 'no consent');
  assert.equal((await api('GET', `/physio/patients/${ath.id}/progress`, { token: other.token })).status, 403);
  const unverified = await signup(['physio']);
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: unverified.id } }), 201);
  assert.equal((await outcome(unverified, ath, { measure: 'pain', value: 3 })).body.error.code, 'credential_required');
  assert.equal((await api('POST', '/physio/outcomes', { token: ath.token, body: { patient_id: ath.id, measure: 'pain', value: 1 } })).status, 403, 'patients do not record clinical readings');
});

test('goals: measured progress follows the readings, closing is final, stale edits are refused, unshared goals stay private', async () => {
  const { ath, physio } = await setup();
  assert.equal((await api('POST', '/physio/goals', { token: physio.token, body: { patient_id: ath.id, title: 'Pain down', measure: 'pain' } })).status, 400, 'measure needs baseline and target');
  assert.equal((await api('POST', '/physio/goals', { token: physio.token, body: { patient_id: ath.id, title: 'Bad date', target_date: day(-2) } })).status, 400);
  const g = must(await api('POST', '/physio/goals', { token: physio.token, body: { patient_id: ath.id, title: 'Pain under 2', measure: 'pain', baseline: 8, target: 2, target_date: day(60) } }), 201);
  assert.equal(g.progress.percent, null, 'no reading yet');
  const priv = must(await api('POST', '/physio/goals', { token: physio.token, body: { patient_id: ath.id, title: 'Clinician-only note to self', shared: false } }), 201);
  must(await outcome(physio, ath, { measure: 'pain', value: 5 }), 201);
  let list = must(await api('GET', '/physio/goals', { token: physio.token, query: { patient_id: ath.id } }));
  assert.equal(list.find((x) => x.id === g.id).progress.percent, 50);
  must(await outcome(physio, ath, { measure: 'pain', value: 2 }), 201);
  list = must(await api('GET', '/physio/goals', { token: physio.token }));
  assert.equal(list.find((x) => x.id === g.id).progress.met, true);
  const sug = must(await api('GET', '/physio/suggestions', { token: physio.token }));
  assert.ok(sug.items.some((s) => s.kind === 'goal_looks_met' && s.goal_id === g.id), 'a met goal is suggested for closing');

  const mine = must(await api('GET', '/me/physio-progress', { token: ath.token }));
  assert.deepEqual(mine.goals.map((x) => x.id), [g.id], 'the patient sees only shared goals');
  assert.ok(!mine.goals.some((x) => x.id === priv.id));

  assert.equal((await api('PATCH', `/physio/goals/${g.id}`, { token: physio.token, body: { row_version: 99, title: 'x y' } })).status, 409);
  const closed = must(await api('PATCH', `/physio/goals/${g.id}`, { token: physio.token, body: { row_version: g.row_version, status: 'achieved', closing_note: 'Walking pain free' } }));
  assert.equal(closed.status, 'achieved'); assert.ok(closed.closed_at);
  assert.equal((await api('PATCH', `/physio/goals/${g.id}`, { token: physio.token, body: { row_version: closed.row_version, title: 'Reopen' } })).status, 409, 'closed goals are a record');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM physio_goals')).rows[0].n, 2);
});

test('home-exercise log: only the patient on an active plan, latest entry of a day counts, the clinician sees the summary', async () => {
  const { ath, physio, plan } = await setup();
  await age(plan, 20);
  const log = (body, who = ath) => api('POST', `/treatment-plans/${plan.id}/adherence`, { token: who.token, body });
  assert.equal((await log({ status: 'done', done_on: day(3) })).status, 400, 'not in the future');
  assert.equal((await log({ status: 'done', done_on: day(-30) })).status, 400, 'at most two weeks back');
  must(await log({ status: 'skipped', done_on: day(-1), pain: 3 }));
  must(await log({ status: 'done', done_on: day(-1), pain: 2, effort: 6, note: 'felt stiff at first' }));
  must(await log({ status: 'partial', done_on: day(-2) }));
  assert.equal((await log({ status: 'done' }, physio)).status, 404, 'the clinician does not log for the patient');
  const stranger = await signup(['athlete']);
  assert.equal((await log({ status: 'done' }, stranger)).status, 404);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM treatment_plan_adherence')).rows[0].n, 3, 'entries are appended, never overwritten');
  assert.ok(!(await pool.query("SELECT note_enc FROM treatment_plan_adherence WHERE note_enc IS NOT NULL")).rows[0].note_enc.includes('stiff'));

  const a = must(await api('GET', `/treatment-plans/${plan.id}/adherence`, { token: physio.token }));
  assert.equal(a.summary.days_done, 1); assert.equal(a.summary.days_partial, 1); assert.equal(a.summary.days_skipped, 0, 'the later entry replaced the skip');
  assert.equal(a.summary.expected_per_week, 3);
  assert.equal(a.days.find((d) => d.done_on === day(-1)).note, 'felt stiff at first');
  assert.equal(must(await api('GET', `/treatment-plans/${plan.id}/adherence`, { token: ath.token })).days.length, 2, 'the patient sees their own log');
  assert.equal((await api('GET', `/treatment-plans/${plan.id}/adherence`, { token: stranger.token })).status, 404);

  must(await api('POST', `/treatment-plans/${plan.id}/status`, { token: physio.token, body: { status: 'paused' } }));
  assert.equal((await log({ status: 'done' })).status, 409, 'a paused plan takes no new logs');
});

test('reports: draft, preview, immutable numbered versions, patient audience notified and can read; private stays private', async () => {
  const { ath, physio, plan } = await setup();
  await age(plan, 20);
  must(await outcome(physio, ath, { measure: 'pain', value: 8, measured_at: new Date(Date.now() - 10 * 864e5).toISOString() }), 201);
  must(await outcome(physio, ath, { measure: 'pain', value: 3 }), 201);
  must(await api('POST', '/physio/goals', { token: physio.token, body: { patient_id: ath.id, title: 'Shared goal', measure: 'pain', baseline: 8, target: 2 } }), 201);
  must(await api('POST', '/physio/goals', { token: physio.token, body: { patient_id: ath.id, title: 'Private goal', shared: false } }), 201);
  must(await api('POST', `/treatment-plans/${plan.id}/adherence`, { token: ath.token, body: { status: 'done' } }));

  const body = { patient_id: ath.id, plan_id: plan.id, title: 'Six-week progress', audience: 'patient', period_from: day(-30), period_to: day(0), narrative: 'Steady improvement in pain.' };
  assert.equal((await api('POST', '/physio/reports', { token: physio.token, body: { ...body, period_to: day(-40) } })).status, 400);
  const rep = must(await api('POST', '/physio/reports', { token: physio.token, body }), 201);
  assert.equal(rep.status, 'draft'); assert.equal(rep.narrative, 'Steady improvement in pain.');
  assert.ok(!(await pool.query('SELECT narrative_enc FROM physio_reports WHERE id=$1', [rep.id])).rows[0].narrative_enc.includes('Steady'));
  assert.equal(must(await api('GET', '/me/physio-reports', { token: ath.token })).length, 0, 'drafts are invisible to the patient');

  const prev = must(await api('GET', `/physio/reports/${rep.id}/preview`, { token: physio.token }));
  assert.equal(prev.outcomes[0].change, -5);
  assert.equal(prev.adherence.days_done, 1);

  assert.equal((await api('POST', `/physio/reports/${rep.id}/publish`, { token: physio.token, body: { row_version: 99 } })).status, 409);
  const v1 = must(await api('POST', `/physio/reports/${rep.id}/publish`, { token: physio.token, body: { row_version: rep.row_version } }), 201);
  assert.equal(v1.version, 1); assert.equal(v1.notified_patient, true);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='physio_report'", [ath.id])).rows[0].n, 1);

  const mine = must(await api('GET', '/me/physio-reports', { token: ath.token }));
  assert.equal(mine.length, 1); assert.equal(mine[0].snapshot.narrative, 'Steady improvement in pain.');
  assert.deepEqual(mine[0].snapshot.goals.map((g) => g.title), ['Shared goal'], 'private goals are not in a patient report');
  assert.equal(mine[0].snapshot.outcomes[0].points[0].note, undefined);
  assert.equal(mine[0].read_at, null);
  const read = must(await api('POST', `/me/physio-reports/${rep.id}/read`, { token: ath.token, body: {} }));
  assert.equal(must(await api('POST', `/me/physio-reports/${rep.id}/read`, { token: ath.token, body: {} })).read_at, read.read_at, 'the first read time is kept');

  const edited = must(await api('POST', '/physio/reports', { token: physio.token, body: { ...body, id: rep.id, row_version: rep.row_version + 1, narrative: 'Revised wording.' } }), 201); // publishing moved the version on by one
  const v2 = must(await api('POST', `/physio/reports/${rep.id}/publish`, { token: physio.token, body: { row_version: edited.row_version } }), 201);
  assert.equal(v2.version, 2);
  const full = must(await api('GET', `/physio/reports/${rep.id}`, { token: physio.token, query: { version: 1 } }));
  assert.equal(full.snapshot.narrative, 'Steady improvement in pain.', 'version 1 still reads as issued');
  assert.equal(full.versions.length, 2);
  await assert.rejects(pool.query('UPDATE physio_report_versions SET audience=$1 WHERE report_id=$2', ['private', rep.id]), /immutable/);
  await assert.rejects(pool.query('DELETE FROM physio_report_versions WHERE report_id=$1', [rep.id]), /immutable/);

  const priv = must(await api('POST', '/physio/reports', { token: physio.token, body: { ...body, title: 'For my file', audience: 'private' } }), 201);
  must(await api('POST', `/physio/reports/${priv.id}/publish`, { token: physio.token, body: { row_version: priv.row_version } }), 201);
  assert.equal(must(await api('GET', '/me/physio-reports', { token: ath.token })).length, 1, 'a private report is never shown to the patient');
  assert.equal(must(await api('GET', '/physio/reports', { token: physio.token })).length, 2);
  const other = await signup(['physio']); await verify(other, 'physio');
  assert.equal((await api('GET', `/physio/reports/${rep.id}`, { token: other.token })).status, 404);
});

test('suggestions, home and analytics come from the clinician\'s own records and respect consent and snoozes', async () => {
  const { ath, physio, plan } = await setup(-3);
  // pain rising, session never noted, plan review overdue, no outcomes before
  must(await outcome(physio, ath, { measure: 'pain', value: 3, measured_at: new Date(Date.now() - 5 * 864e5).toISOString() }), 201);
  must(await outcome(physio, ath, { measure: 'pain', value: 6 }), 201);
  must(await api('POST', `/treatment-plans/${plan.id}/adherence`, { token: ath.token, body: { status: 'done', pain: 8 } }));
  const s = must(await api('GET', '/physio/suggestions', { token: physio.token }));
  const kinds = s.items.map((x) => x.kind);
  assert.ok(kinds.includes('plan_review_due'), 'review date has passed');
  assert.ok(kinds.includes('pain_rising'));
  assert.ok(kinds.includes('pain_reported_at_home'));
  assert.equal(s.items[0].priority, 'high', 'most urgent first');
  assert.ok(s.items.every((x) => x.reason && x.patient_name));

  const rising = s.items.find((x) => x.kind === 'pain_rising');
  const snooze = must(await api('POST', '/physio/suggestions/snooze', { token: physio.token, body: { key: rising.key, days: 7 } }));
  assert.ok(snooze.until);
  assert.ok(!must(await api('GET', '/physio/suggestions', { token: physio.token })).items.some((x) => x.key === rising.key), 'snoozed prompts are hidden');

  const home = must(await api('GET', '/physio/home', { token: physio.token }));
  assert.equal(home.credential.ok, true); assert.equal(home.counts.patients, 1); assert.equal(home.counts.active_plans, 1);
  assert.ok(home.suggestions.total >= 2);

  const an = must(await api('GET', '/physio/analytics', { token: physio.token }));
  assert.equal(an.plans.active, 1);
  assert.equal(an.outcomes.by_measure[0].measure, 'pain');
  assert.equal(an.outcomes.by_measure[0].worse, 1, 'pain went up in the period');
  assert.equal(an.adherence.with_logs, 0, 'plan is too new to be counted');
  assert.equal((await api('GET', '/physio/analytics', { token: physio.token, query: { from: day(0), to: day(-5) } })).status, 400);

  // a patient is not a clinician; an unverified physio still gets a home, minus anything clinical
  assert.equal((await api('GET', '/physio/home', { token: ath.token })).status, 403);
  const raw = await signup(['physio']);
  const rawHome = must(await api('GET', '/physio/home', { token: raw.token }));
  assert.equal(rawHome.credential.ok, false); assert.equal(rawHome.counts, null);
  assert.equal((await api('GET', '/physio/suggestions', { token: raw.token })).body.error.code, 'credential_required');

  // withdrawing consent ends the clinician's view at once but not the patient's
  must(await api('DELETE', `/medical/grants/${physio.id}`, { token: ath.token }));
  assert.equal((await outcome(physio, ath, { measure: 'pain', value: 1 })).status, 403);
  assert.equal((await api('GET', `/physio/patients/${ath.id}/progress`, { token: physio.token })).status, 403);
  assert.equal(must(await api('GET', '/physio/suggestions', { token: physio.token })).items.length, 0, 'no patient, no suggestions');
  assert.equal(must(await api('GET', '/me/physio-progress', { token: ath.token })).outcomes.find((x) => x.measure === 'pain').count, 2, 'the patient keeps their data');
});
