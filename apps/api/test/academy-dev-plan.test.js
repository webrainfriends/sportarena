import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { settle } = await import('../src/payments/service.js');
const { judge, judgeMilestones, tally } = await import('../src/academy-dev-trend.js');
const { capabilities } = await import('../src/capabilities/index.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `ac_${n}`, display_name: `Academy ${n}`, email: `ac${n}@example.com`, password: 'correct-horse-battery', roles: ['athlete'], ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const adult = () => signup({ dob: yearsAgo(30) });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('ac_root','ac_root','{admin}','x','x','ac_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function academy({ capacity = 10, fee = 12000, currency = 'GBP', title } = {}) {
  const owner = await adult();
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Outcomes Academy ${++n}`, kind: 'academy' } }), 201);
  must(await api('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['football'], currency, listed: true } }));
  const prog = must(await api('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'football', title: title ?? `U12 Football ${n}`, capacity, admission_mode: 'direct', public: true } }), 201);
  const pub = must(await api('POST', `/academy/programmes/${prog.id}/versions`, { token: owner.token, body: { row_version: prog.row_version, billing_model: 'one_time', currency, fee_minor: fee } }), 201);
  return { owner, org, programme: pub.programme, version: pub.version };
}
async function enrol(a, person) {
  const enq = must(await api('POST', `/academy/programmes/${a.programme.id}/applications`, { token: person.token, body: {} }), 201);
  const done = must(await api('POST', `/academy/applications/${enq.id}/submit`, { token: person.token, body: { row_version: enq.row_version, answers: {} } }));
  assert.equal(done.stage, 'enrolled');
  const e = (await pool.query('SELECT * FROM org_enrolments WHERE user_id=$1 AND programme_id=$2', [person.id, a.programme.id])).rows[0];
  const ch = (await pool.query('SELECT * FROM academy_charges WHERE enrolment_id=$1 ORDER BY seq', [e.id])).rows;
  return { enrolment: e, charges: ch };
}
const member = async (a, role) => {
  const u = await adult();
  await pool.query("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at) VALUES ($1,$2,$3,'active',now())", [a.org.id, u.id, role]);
  return u;
};
const pay = async (person, charge, cents, currency = 'GBP') => {
  const p = (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref) VALUES ($1,'stripe','academy_charge',$2,$3,$4,'pending',$5) RETURNING id", [person.id, charge.id, cents, currency, `ref-${n++}`])).rows[0];
  await settle(p.id, { paid: true, amount: cents, currency, paymentRef: `pi_${n}` });
  return p.id;
};
const rubric = async (coachId) => {
  const r = (await pool.query("INSERT INTO coaching_rubrics(coach_id, name) VALUES ($1,'Technique') RETURNING id", [coachId])).rows[0];
  await pool.query("INSERT INTO coaching_rubric_versions(rubric_id, version, dimensions) VALUES ($1,1,'[{\"key\":\"passing\",\"name\":\"Passing\"}]')", [r.id]);
  return r.id;
};
const observe = (coachId, athleteId, rubricId, score, visibility) => pool.query(
  "INSERT INTO coaching_observations(coach_id, athlete_id, note, visibility, rubric_id, rubric_version, dimension_key, score, obs_type) VALUES ($1,$2,'note',$3,$4,1,'passing',$5,'progress')", [coachId, athleteId, visibility, rubricId, score]);

const tomorrow = (n = 1) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const ago = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

async function setup() {
  const a = await academy();
  const coach = await member(a, 'coach');
  const edu = await member(a, 'manager');
  const ath = await adult();
  await enrol(a, ath);
  const cohort = (await pool.query('SELECT id FROM org_cohorts WHERE programme_id=$1', [a.programme.id])).rows[0].id;
  await pool.query('UPDATE org_cohorts SET coach_id=$2 WHERE id=$1', [cohort, coach.id]);
  const rid = await rubric(coach.id);
  return { a, coach, edu, ath, cohort, rid };
}

test('trend rules: no data is its own state, direction-aware targets, honest low evidence, no combined score', () => {
  const w = { from: '2026-01-01', to: '2026-12-31', today: '2026-07-01' };
  assert.equal(judge({ baseline: 2, current: null, target: 4, ...w }).state, 'no_data');
  assert.equal(judge({ baseline: 2, current: 0, target: 4, ...w }).state, 'behind');           // a real zero is not "no data"
  assert.equal(judge({ baseline: 2, current: 3.2, target: 4, n: 5, ...w }).state, 'on_track');
  assert.equal(judge({ baseline: 2, current: 2.1, target: 4, n: 5, ...w }).state, 'behind');
  assert.equal(judge({ baseline: 2, current: 4, target: 4, ...w }).state, 'achieved');
  assert.equal(judge({ baseline: 12.5, current: 11.9, target: 11.5, ...w }).lower_is_better, true);   // a time: lower is better
  assert.equal(judge({ baseline: 12.5, current: 11.4, target: 11.5, ...w }).state, 'achieved');
  assert.equal(judge({ baseline: null, current: 3, target: 4, ...w }).state, 'tracking');       // no starting point: no claim either way
  assert.equal(judge({ baseline: 2, current: 3, target: null, ...w }).state, 'tracking');
  assert.equal(judge({ baseline: 2, current: 3, target: 4, n: 1, ...w }).low_evidence, true);
  assert.equal(judgeMilestones([], '2026-07-01').state, 'no_data');
  assert.equal(judgeMilestones([{ status: 'done', due_on: '2026-03-01' }, { status: 'pending', due_on: '2026-05-01' }], '2026-07-01').state, 'behind');
  assert.deepEqual(tally(['behind', 'on_track', 'behind']), { no_data: 0, tracking: 0, on_track: 1, behind: 2, achieved: 0 });
});

test('capabilities are registered once for REST, OpenAPI and MCP', () => {
  const names = ['create_academy_dev_plan', 'update_academy_dev_plan', 'get_academy_dev_plan', 'list_academy_dev_plans', 'get_my_academy_dev_plans', 'get_academy_dev_options', 'set_academy_dev_contributor',
    'add_academy_dev_objective', 'update_academy_dev_objective', 'set_academy_dev_milestone', 'add_academy_dev_intervention', 'update_academy_dev_intervention', 'start_academy_dev_review',
    'update_academy_dev_review', 'sign_academy_dev_review', 'record_academy_dev_decision', 'set_academy_dev_school_link'];
  for (const n of names) assert.equal(capabilities.filter((c) => c.name === n).length, 1, n);
});

test('plan lifecycle: coach opens it, objectives measure canonical records, role-safe views, review sign-off, decision, close', async () => {
  const { a, coach, edu, ath, cohort, rid } = await setup();
  const base = `/organisations/${a.org.id}/academy/dev-plans`;
  const stranger = await adult();
  assert.equal((await api('GET', `${base}`, { token: stranger.token })).status, 404);

  const opts = must(await api('GET', `${base}/options`, { token: coach.token, query: { athlete_id: ath.id } }));
  assert.deepEqual(opts.sports.map((s) => s.sport), ['football']);
  assert.ok(opts.rubrics.some((r) => r.id === rid));
  assert.ok(opts.people.some((p) => p.user_id === edu.id));

  const body = { athlete_id: ath.id, season_label: '2026/27', starts_on: ago(60), ends_on: tomorrow(120), focus: 'First-team readiness', idempotency_key: 'plan-0001' };
  const plan = must(await api('POST', base, { token: coach.token, body }), 201);
  assert.equal(plan.sport, 'football'); assert.equal(plan.lead_id, coach.id); assert.equal(plan.status, 'draft');
  assert.equal(must(await api('POST', base, { token: coach.token, body }), 201).id, plan.id);                       // idempotent
  assert.equal((await api('POST', base, { token: coach.token, body: { ...body, idempotency_key: 'plan-0002' } })).status, 409);   // one plan per season
  assert.equal((await api('POST', base, { token: coach.token, body: { ...body, season_label: 'Bad window', ends_on: ago(100) } })).status, 400);
  { const r = await api('POST', base, { token: stranger.token, body: { ...body, season_label: 'Other' } }); assert.equal(r.status, 404, JSON.stringify(r.body)); }
  // a plan needs an objective before it can go live
  assert.equal((await api('PATCH', `/academy/dev-plans/${plan.id}`, { token: coach.token, body: { row_version: plan.row_version, status: 'active' } })).status, 400);

  // evidence in the canonical tables
  for (let d = 1; d <= 4; d++) await pool.query('INSERT INTO org_attendance(cohort_id, user_id, session_date, status, recorded_by) VALUES ($1,$2,current_date - $3::int,$4,$5)', [cohort, ath.id, d, d === 4 ? 'absent' : 'present', coach.id]);
  await observe(coach.id, ath.id, rid, 2, 'player'); await observe(coach.id, ath.id, rid, 1, 'coach_private');

  const tech = must(await api('POST', `/academy/dev-plans/${plan.id}/objectives`, { token: coach.token, body: { domain: 'technical', competency: 'Passing', title: 'Raise passing accuracy', metric_kind: 'rubric', rubric_id: rid, dimension_key: 'passing', target_value: 4 } }), 201);
  assert.equal(tech.baseline_value, 2);                                           // captured once, dated, from the canonical observation (the private one never counts)
  const att = must(await api('POST', `/academy/dev-plans/${plan.id}/objectives`, { token: coach.token, body: { domain: 'physical', title: 'Hold attendance above 90%', metric_kind: 'attendance', target_value: 90 } }), 201);
  const acad = must(await api('POST', `/academy/dev-plans/${plan.id}/objectives`, { token: coach.token, body: { domain: 'academic', title: 'Keep school grades steady', owner_id: edu.id, visibility: 'staff', milestones: [{ title: 'Term report shared', due_on: ago(5) }, { title: 'Exam plan agreed', due_on: tomorrow(30) }] } }), 201);
  assert.equal(acad.baseline_value, null);
  const mental = must(await api('POST', `/academy/dev-plans/${plan.id}/objectives`, { token: coach.token, body: { domain: 'mental', title: 'Pre-match routine', visibility: 'athlete' } }), 201);
  // validation
  assert.equal((await api('POST', `/academy/dev-plans/${plan.id}/objectives`, { token: coach.token, body: { domain: 'tactical', title: 'Bad rubric', metric_kind: 'rubric', rubric_id: rid, dimension_key: 'nope', target_value: 3 } })).status, 400);
  assert.equal((await api('POST', `/academy/dev-plans/${plan.id}/objectives`, { token: coach.token, body: { domain: 'tactical', title: 'Outside', due_on: '1999-01-01' } })).status, 400);
  assert.equal((await api('POST', `/academy/dev-plans/${plan.id}/objectives`, { token: coach.token, body: { domain: 'tactical', title: 'Owner outside the academy', owner_id: stranger.id } })).status, 400);

  // contributors: education sees academic + personal only
  must(await api('POST', `/academy/dev-plans/${plan.id}/contributors`, { token: coach.token, body: { user_id: edu.id, discipline: 'education', domains: ['academic', 'personal'] } }), 201);
  assert.equal((await api('POST', `/academy/dev-plans/${plan.id}/contributors`, { token: coach.token, body: { user_id: stranger.id, discipline: 'psychology', domains: ['mental'] } })).status, 400);
  const live = must(await api('PATCH', `/academy/dev-plans/${plan.id}`, { token: coach.token, body: { row_version: plan.row_version, status: 'active' } }));
  assert.equal(live.status, 'active');
  assert.equal((await api('PATCH', `/academy/dev-plans/${plan.id}`, { token: coach.token, body: { row_version: plan.row_version, focus: 'stale write' } })).status, 409);

  const v = must(await api('GET', `/academy/dev-plans/${plan.id}`, { token: coach.token }));
  const t = v.domains.technical.objectives[0];
  assert.equal(t.evidence.value, 2); assert.equal(t.evidence.origin, 'coach_observed'); assert.equal(t.state, 'behind'); assert.equal(t.evidence.n, 1); assert.equal(t.low_evidence, true);
  assert.equal(v.domains.physical.objectives[0].evidence.value, 75);              // 3 of 4 recorded sessions
  assert.equal(v.domains.academic.objectives[0].milestone_summary.state, 'behind'); // one overdue milestone
  assert.equal(v.domains.tactical.objectives.length, 0);                          // an empty domain stays visibly empty
  assert.equal(v.strip.objectives, 4); assert.ok(!('score' in v) && !('talent_score' in v.strip));
  assert.equal(v.strip.behind, 3); assert.equal(v.strip.no_data, 1);
  assert.equal(v.my_access.kind, 'lead');
  // the education contributor: only their domains
  const ev = must(await api('GET', `/academy/dev-plans/${plan.id}`, { token: edu.token }));
  assert.deepEqual(ev.domains.technical.objectives, []); assert.equal(ev.domains.academic.objectives.length, 1); assert.equal(ev.clearance, null);
  // the athlete: only athlete-visible objectives, no rationale, no staff material
  const av = must(await api('GET', `/academy/dev-plans/${plan.id}`, { token: ath.token }));
  assert.equal(av.domains.academic.objectives.length, 0); assert.equal(av.domains.mental.objectives.length, 1); assert.equal(av.contributors.length, 0); assert.equal(av.my_access.kind, 'athlete');
  assert.equal((await api('GET', `/academy/dev-plans/${plan.id}`, { token: stranger.token })).status, 404);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='read_academy_dev_plan' AND entity_id=$1", [plan.id])).rows[0].n >= 2, true);

  // tasks and milestones
  const task = must(await api('POST', `/academy/dev-plans/${plan.id}/interventions`, { token: coach.token, body: { kind: 'tutoring', title: 'Weekly maths tutoring', owner_id: edu.id, objective_id: acad.id, due_on: ago(2), detail: 'Private detail' } }), 201);
  assert.equal((await api('POST', `/academy/dev-plans/${plan.id}/interventions`, { token: edu.token, body: { kind: 'conditioning', title: 'Not my domain', objective_id: att.id } })).status, 403);
  assert.equal((await api('PATCH', `/academy/dev-interventions/${task.id}`, { token: ath.token, body: { row_version: 1, status: 'done' } })).status, 404);
  const done = must(await api('PATCH', `/academy/dev-interventions/${task.id}`, { token: edu.token, body: { row_version: 1, status: 'done', completion_note: 'Sessions held' } }));
  assert.equal(done.status, 'done');
  assert.equal((await api('PATCH', `/academy/dev-interventions/${task.id}`, { token: edu.token, body: { row_version: 1, status: 'open' } })).status, 409);
  const ms = (await pool.query('SELECT id FROM academy_dev_milestones WHERE objective_id=$1 ORDER BY due_on', [acad.id])).rows;
  must(await api('POST', `/academy/dev-objectives/${acad.id}/milestones`, { token: edu.token, body: { milestone_id: ms[0].id, status: 'done' } }), 201);
  assert.equal(must(await api('GET', `/academy/dev-plans/${plan.id}`, { token: coach.token })).domains.academic.objectives[0].milestone_summary.state, 'on_track');

  // review: needs a summary and a note for each domain with objectives; contributor concern must be answered
  const rev = must(await api('POST', `/academy/dev-plans/${plan.id}/reviews`, { token: coach.token, body: { period_from: ago(60), period_to: ago(0) } }), 201);
  assert.equal((await api('POST', `/academy/dev-plans/${plan.id}/reviews`, { token: coach.token, body: { period_from: ago(60), period_to: ago(0) } })).status, 409);
  assert.equal((await api('POST', `/academy/dev-reviews/${rev.id}/sign`, { token: coach.token, body: { decision: 'approve' } })).status, 400);   // no summary yet
  const w1 = must(await api('PATCH', `/academy/dev-reviews/${rev.id}`, { token: coach.token, body: { row_version: 1, summary: 'Good first half-season.', domain_notes: { technical: 'Passing improving', physical: 'Good', mental: 'Routine in place' } } }));
  assert.equal((await api('POST', `/academy/dev-reviews/${rev.id}/sign`, { token: coach.token, body: { decision: 'approve' } })).status, 400);   // academic note missing
  assert.equal((await api('PATCH', `/academy/dev-reviews/${rev.id}`, { token: edu.token, body: { row_version: w1.row_version, domain_notes: { technical: 'not mine' } } })).status, 403);
  must(await api('PATCH', `/academy/dev-reviews/${rev.id}`, { token: edu.token, body: { row_version: w1.row_version, domain_notes: { academic: 'Grades steady' } } }));
  must(await api('POST', `/academy/dev-reviews/${rev.id}/sign`, { token: edu.token, body: { decision: 'raise_concern', comment: 'Exam period is heavy' } }), 201);
  assert.equal((await api('POST', `/academy/dev-reviews/${rev.id}/sign`, { token: coach.token, body: { decision: 'approve' } })).status, 400);   // concern must be answered
  assert.equal((await api('POST', `/academy/dev-reviews/${rev.id}/sign`, { token: ath.token, body: { decision: 'acknowledge' } })).status, 404);  // family cannot sign a draft
  const signed = must(await api('POST', `/academy/dev-reviews/${rev.id}/sign`, { token: coach.token, body: { decision: 'approve', comment: 'Will lighten the load in exam weeks', share_with_family: true } }), 201);
  assert.equal(signed.review_status, 'signed_off');
  assert.equal((await api('POST', `/academy/dev-reviews/${rev.id}/sign`, { token: coach.token, body: { decision: 'approve' } })).status, 409);
  assert.equal((await api('PATCH', `/academy/dev-reviews/${rev.id}`, { token: coach.token, body: { row_version: 9, summary: 'late edit' } })).status, 409);
  await assert.rejects(() => pool.query('UPDATE academy_dev_signoffs SET decision=$1', ['approve']), /append-only/);
  // the snapshot is frozen: later evidence does not rewrite it
  await observe(coach.id, ath.id, rid, 5, 'player');
  const after = must(await api('GET', `/academy/dev-plans/${plan.id}`, { token: coach.token }));
  assert.equal(after.reviews[0].snapshot.domains.technical[0].current, 2);
  assert.equal(after.domains.technical.objectives[0].evidence.value, 3.5);
  // the athlete reads only the athlete-visible, family-shared parts and acknowledges
  const fam = must(await api('GET', `/academy/dev-plans/${plan.id}`, { token: ath.token }));
  assert.equal(fam.reviews.length, 1); assert.equal(fam.reviews[0].summary, 'Good first half-season.'); assert.equal(fam.reviews[0].domain_notes, null);
  assert.deepEqual(fam.reviews[0].snapshot.domains.academic, []);
  assert.equal(fam.reviews[0].snapshot.staff_tally, undefined);
  assert.equal(fam.reviews[0].signoffs.some((s) => s.decision === 'raise_concern' && s.comment), false);
  must(await api('POST', `/academy/dev-reviews/${rev.id}/sign`, { token: ath.token, body: { decision: 'acknowledge' } }), 201);
  assert.equal((await api('POST', `/academy/dev-reviews/${rev.id}/sign`, { token: ath.token, body: { decision: 'acknowledge' } })).status, 409);

  // decisions are human, reasoned, tied to a signed-off review, idempotent; closing the season locks the plan
  assert.equal((await api('POST', `/academy/dev-plans/${plan.id}/decisions`, { token: ath.token, body: { kind: 'continue_plan', reason: 'x y z' } })).status, 403);
  assert.equal((await api('POST', `/academy/dev-plans/${plan.id}/decisions`, { token: coach.token, body: { kind: 'continue_plan', reason: 'ok', review_id: ms[0].id } })).status, 400);
  const dec = must(await api('POST', `/academy/dev-plans/${plan.id}/decisions`, { token: coach.token, body: { kind: 'adjust_load', reason: 'Lighter weeks during exams', review_id: rev.id, idempotency_key: 'dec-00001' } }), 201);
  assert.equal(must(await api('POST', `/academy/dev-plans/${plan.id}/decisions`, { token: coach.token, body: { kind: 'adjust_load', reason: 'Lighter weeks during exams', review_id: rev.id, idempotency_key: 'dec-00001' } }), 201).id, dec.id);
  await assert.rejects(() => pool.query('DELETE FROM academy_dev_decisions'), /append-only/);
  must(await api('POST', `/academy/dev-plans/${plan.id}/decisions`, { token: a.owner.token, body: { kind: 'close_season', reason: 'Season complete' } }), 201);
  assert.equal((await api('POST', `/academy/dev-plans/${plan.id}/objectives`, { token: coach.token, body: { domain: 'tactical', title: 'Too late' } })).status, 409);

  // list: owner sees all, coach their athletes, outsider 404
  const all = must(await api('GET', base, { token: a.owner.token }));
  assert.equal(all.total, 1); assert.equal(all.items[0].strip.objectives, 4);
  assert.equal(must(await api('GET', base, { token: a.owner.token, query: { q: 'nobody' } })).total, 0);
  const mine = must(await api('GET', '/academy/my-dev-plans', { token: ath.token }));
  assert.equal(mine.length, 1);
});

test('providers see only their own tasks; a revoked association ends access at once; other academies cannot reach the plan', async () => {
  const { a, coach, ath } = await setup();
  const base = `/organisations/${a.org.id}/academy/dev-plans`;
  const plan = must(await api('POST', base, { token: a.owner.token, body: { athlete_id: ath.id, season_label: '2026/27', starts_on: ago(10), ends_on: tomorrow(200), lead_id: coach.id } }), 201);
  const obj = must(await api('POST', `/academy/dev-plans/${plan.id}/objectives`, { token: a.owner.token, body: { domain: 'physical', title: 'Return-to-load plan', owner_id: coach.id } }), 201);
  const prov = await adult();
  await pool.query("INSERT INTO provider_profiles(user_id, provider_type, headline) VALUES ($1,'physio','Sports physio')", [prov.id]).catch(() => {});
  const assoc = (await pool.query("INSERT INTO org_provider_associations(organisation_id, provider_id, relation, created_by) VALUES ($1,$2,'retained',$3) RETURNING id", [a.org.id, prov.id, a.owner.id])).rows[0];
  must(await api('POST', `/academy/dev-plans/${plan.id}/contributors`, { token: a.owner.token, body: { user_id: prov.id, discipline: 'physio_provider' } }), 201);
  must(await api('POST', `/academy/dev-plans/${plan.id}/interventions`, { token: a.owner.token, body: { kind: 'provider_referral', title: 'Hamstring screen', owner_id: prov.id, objective_id: obj.id } }), 201);
  must(await api('POST', `/academy/dev-plans/${plan.id}/interventions`, { token: a.owner.token, body: { kind: 'conditioning', title: 'Strength block', owner_id: coach.id } }), 201);
  const pv = must(await api('GET', `/academy/dev-plans/${plan.id}`, { token: prov.token }));
  assert.deepEqual(pv.interventions.map((x) => x.title), ['Hamstring screen']); assert.deepEqual(pv.domains, {}); assert.equal(pv.plan.focus, null); assert.equal(pv.reviews.length, 0);
  assert.equal((await api('POST', `/academy/dev-plans/${plan.id}/objectives`, { token: prov.token, body: { domain: 'physical', title: 'Nope' } })).status, 403);
  await pool.query("UPDATE org_provider_associations SET status='revoked' WHERE id=$1", [assoc.id]);
  assert.equal((await api('GET', `/academy/dev-plans/${plan.id}`, { token: prov.token })).status, 404);
  const other = await academy();
  assert.equal((await api('GET', `/academy/dev-plans/${plan.id}`, { token: other.owner.token })).status, 404);
  assert.equal((await api('PATCH', `/academy/dev-plans/${plan.id}`, { token: coach.token, body: { row_version: 1, archive: true } })).status, 200);   // the lead may archive; data is kept
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_dev_plans WHERE id=$1', [plan.id])).rows[0].n, 1);
});

test('young athlete: guardian reads and acknowledges; consent and school sharing are live', async () => {
  const a = await academy();
  const coach = await member(a, 'coach');
  const kid = await signup({ dob: yearsAgo(12) });
  const parent = await adult();
  const l = must(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: kid.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: kid.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence: { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' } } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
  await api('POST', `/youth/children/${kid.id}/consents`, { token: parent.token, body: { purpose: 'participation' } });
  const enq = must(await api('POST', `/academy/programmes/${a.programme.id}/applications`, { token: parent.token, body: { athlete_id: kid.id } }), 201);
  must(await api('POST', `/academy/applications/${enq.id}/submit`, { token: parent.token, body: { row_version: enq.row_version, answers: {} } }));
  const cohort = (await pool.query('SELECT id FROM org_cohorts WHERE programme_id=$1', [a.programme.id])).rows[0].id;
  await pool.query('UPDATE org_cohorts SET coach_id=$2 WHERE id=$1', [cohort, coach.id]);
  const rid = await rubric(coach.id);
  const base = `/organisations/${a.org.id}/academy/dev-plans`;
  const plan = must(await api('POST', base, { token: coach.token, body: { athlete_id: kid.id, season_label: 'U12 2026/27', starts_on: ago(30), ends_on: tomorrow(200) } }), 201);
  must(await api('POST', `/academy/dev-plans/${plan.id}/objectives`, { token: coach.token, body: { domain: 'technical', title: 'Passing', metric_kind: 'rubric', rubric_id: rid, dimension_key: 'passing', target_value: 4 } }), 201);
  assert.equal((await api('GET', `/academy/dev-plans/${plan.id}`, { token: parent.token })).status, 200);
  must(await api('PATCH', `/academy/dev-plans/${plan.id}`, { token: coach.token, body: { row_version: 1, status: 'active' } }));
  // no coaching consent: the rubric objective says so instead of showing a figure or a zero
  const noc = must(await api('GET', `/academy/dev-plans/${plan.id}`, { token: coach.token }));
  assert.equal(noc.domains.technical.objectives[0].missing, 'no_consent'); assert.equal(noc.domains.technical.objectives[0].state, 'no_data');
  const rev = must(await api('POST', `/academy/dev-plans/${plan.id}/reviews`, { token: coach.token, body: { period_from: ago(30), period_to: ago(0) } }), 201);
  must(await api('PATCH', `/academy/dev-reviews/${rev.id}`, { token: coach.token, body: { row_version: 1, summary: 'A strong start for the season.', domain_notes: { technical: 'Early days' } } }));
  must(await api('POST', `/academy/dev-reviews/${rev.id}/sign`, { token: coach.token, body: { decision: 'approve', share_with_family: true } }), 201);
  const pv = must(await api('GET', `/academy/dev-plans/${plan.id}`, { token: parent.token }));
  assert.equal(pv.my_access.kind, 'guardian'); assert.equal(pv.reviews.length, 1); assert.equal(pv.is_youth, true);
  assert.equal((await api('GET', '/academy/my-dev-plans', { token: parent.token, query: { athlete_id: kid.id } })).body.length, 1);
  assert.equal((await api('GET', '/academy/my-dev-plans', { token: (await adult()).token, query: { athlete_id: kid.id } })).status, 404);
  must(await api('POST', `/academy/dev-reviews/${rev.id}/sign`, { token: parent.token, body: { decision: 'acknowledge', comment: 'Thank you' } }), 201);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action IN ('read_child_academy_dev_plan','read_child_academy_dev_plans') AND actor_id=$1", [parent.id])).rows[0].n >= 2, true);

  // school summaries: only what the family chooses, metadata only, gone the moment it is switched off
  const ev = (await pool.query("INSERT INTO academic_evidence(user_id, kind, institution, period_from, period_to, summary_enc) VALUES ($1,'report','St Mary''s School',$2,$3,'secret-summary') RETURNING id", [kid.id, ago(200), ago(20)])).rows[0];
  assert.deepEqual(must(await api('GET', `/academy/dev-plans/${plan.id}`, { token: coach.token })).school.linked, []);
  assert.equal((await api('POST', `/academy/dev-plans/${plan.id}/school-links`, { token: coach.token, body: { evidence_id: ev.id, shared: true } })).status, 403);
  must(await api('POST', `/academy/dev-plans/${plan.id}/school-links`, { token: parent.token, body: { evidence_id: ev.id, shared: true } }));
  const seen = must(await api('GET', `/academy/dev-plans/${plan.id}`, { token: coach.token })).school.linked;
  assert.equal(seen.length, 1); assert.equal(seen[0].institution, "St Mary's School"); assert.ok(!JSON.stringify(seen).includes('secret-summary'));
  must(await api('POST', `/academy/dev-plans/${plan.id}/school-links`, { token: parent.token, body: { evidence_id: ev.id, shared: false } }));
  assert.deepEqual(must(await api('GET', `/academy/dev-plans/${plan.id}`, { token: coach.token })).school.linked, []);
});

test('every catalogued sport can carry a plan (the plan is sport-agnostic; competencies come from the sport\'s own rubric)', async () => {
  const { a, ath } = await setup();
  const sports = (await pool.query('SELECT slug FROM sports ORDER BY slug')).rows;
  assert.ok(sports.length > 10);
  for (const [i, s] of sports.entries()) {
    const p = await api('POST', `/organisations/${a.org.id}/academy/dev-plans`, { token: a.owner.token, body: { athlete_id: ath.id, sport: s.slug, season_label: `S${i}`, starts_on: ago(5), ends_on: tomorrow(100) } });
    assert.equal(p.status, 201, `${s.slug}: ${JSON.stringify(p.body)}`);
  }
});

test('every catalogued sport has a framework; native vs labelled fallback is reported; academic and personal are universal', async () => {
  const { frameworkFor, nativeSports } = await import('../src/academy-dev-catalogue.js');
  const sports = (await pool.query('SELECT slug FROM sports ORDER BY slug')).rows.map((r) => r.slug);
  const native = [], fallback = [];
  for (const s of sports) {
    const f = frameworkFor(s);
    for (const d of ['technical', 'tactical', 'physical', 'mental', 'academic', 'personal']) assert.ok(f.domains[d].length > 0, `${s}/${d} has competencies`);
    (f.fallback ? fallback : native).push(s);
  }
  assert.ok(native.includes('tennis') && native.includes('football') && native.includes('cricket') && native.includes('judo') && native.includes('swimming'));
  assert.deepEqual(frameworkFor('tennis').domains.technical.map((c) => c.key).slice(0, 3), ['serve', 'return', 'forehand']);
  assert.equal(frameworkFor('not-a-sport').fallback, true);
  console.log(`# frameworks: ${native.length} sports native, ${fallback.length} on the labelled generic fallback: ${fallback.join(', ')}`);
  assert.ok(native.length / sports.length > 0.9);
});

test('objective builder: insight with anonymised peer benchmark and projection, objective + tasks in one call, phases and clashes, squad board', async () => {
  const { a, coach, edu, ath, rid, cohort } = await setup();
  const base = `/organisations/${a.org.id}/academy/dev-plans`;
  // tennis-style: this academy's programme is football, so use the football framework; peers are other athletes in the same group
  const peers = [];
  for (let k = 0; k < 6; k++) { const p = await adult(); await enrol(a, p); peers.push(p); }
  await pool.query('UPDATE org_cohorts SET coach_id=$2 WHERE id=$1', [cohort, coach.id]);
  const obs = (u, score, d) => pool.query("INSERT INTO coaching_observations(coach_id, athlete_id, note, visibility, rubric_id, rubric_version, dimension_key, score, obs_type, observed_at) VALUES ($1,$2,'n','player',$3,1,'passing',$4,'progress', now() - ($5::int || ' days')::interval)", [coach.id, u.id, rid, score, d]);
  for (const [i, p] of peers.entries()) { await obs(p, 2 + i * 0.4, 20); await obs(p, 2.2 + i * 0.4, 5); }
  for (const [s, d] of [[2.0, 70], [2.4, 40], [2.8, 10]]) await obs(ath, s, d);
  const plan = must(await api('POST', base, { token: coach.token, body: { athlete_id: ath.id, season_label: '2026/27', starts_on: ago(80), ends_on: tomorrow(200) } }), 201);
  const ins = must(await api('GET', `/academy/dev-plans/${plan.id}/insight`, { token: coach.token, query: { domain: 'technical' } }));
  const pass = ins.competencies.find((c) => c.key === 'passing');
  assert.equal(pass.measure.kind, 'rubric'); assert.equal(pass.measure.dimension_key, 'passing');
  assert.equal(pass.evidence.n, 3); assert.equal(pass.evidence.value, 2.4);
  assert.equal(pass.benchmark.state, 'ok'); assert.equal(pass.benchmark.peers, 6);
  assert.ok(!JSON.stringify(ins).includes(peers[0].id), 'no peer identity in the insight');
  assert.ok(pass.suggestion.target > pass.evidence.value && pass.suggestion.method.length > 10);
  assert.equal(pass.evidence.projection.state, 'projected');
  assert.ok(pass.tasks.length >= 1);
  assert.equal(ins.competencies.find((c) => c.key === 'finishing').measure.kind, 'milestones');   // no rubric measures it: stays honest
  const acad = must(await api('GET', `/academy/dev-plans/${plan.id}/insight`, { token: coach.token, query: { domain: 'academic' } }));
  assert.ok(acad.competencies.some((c) => c.key === 'exam_readiness'));
  assert.equal((await api('GET', `/academy/dev-plans/${plan.id}/insight`, { token: ath.token, query: { domain: 'technical' } })).status, 403);

  // fewer than five peers: no benchmark is shown (nobody can be identified from a tiny group)
  await pool.query("DELETE FROM coaching_observations WHERE athlete_id = ANY($1)", [peers.slice(0, 3).map((p) => p.id)]);
  const few = must(await api('GET', `/academy/dev-plans/${plan.id}/insight`, { token: coach.token, query: { domain: 'technical' } }));
  assert.equal(few.competencies.find((c) => c.key === 'passing').benchmark.state, 'not_enough_peers');

  // objective + its starter tasks and milestones in one call
  const o = must(await api('POST', `/academy/dev-plans/${plan.id}/objectives`, { token: coach.token, body: { domain: 'technical', competency: 'Passing and distribution', competency_key: 'passing', title: 'Raise passing', metric_kind: 'rubric', rubric_id: rid, dimension_key: 'passing', target_value: 3.4, owner_id: coach.id,
    milestones: [{ title: 'Checkpoint 1', due_on: tomorrow(30) }], tasks: [{ kind: 'training_block', title: 'Passing under pressure block', due_on: tomorrow(40) }, { kind: 'video_review', title: 'Passing video review', owner_id: edu.id }] } }), 201);
  assert.equal(o.competency_key, 'passing');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_dev_interventions WHERE objective_id=$1', [o.id])).rows[0].n, 2);

  // phases: validated, and work scheduled in an exam phase is flagged
  const bad = await api('PATCH', `/academy/dev-plans/${plan.id}`, { token: coach.token, body: { row_version: plan.row_version, phases: [{ kind: 'exams', from: tomorrow(20), to: tomorrow(50) }, { kind: 'recovery', from: tomorrow(40), to: tomorrow(60) }] } });
  assert.equal(bad.status, 400);
  const outside = await api('PATCH', `/academy/dev-plans/${plan.id}`, { token: coach.token, body: { row_version: plan.row_version, phases: [{ kind: 'exams', from: tomorrow(20), to: tomorrow(900) }] } });
  assert.equal(outside.status, 400);
  must(await api('PATCH', `/academy/dev-plans/${plan.id}`, { token: coach.token, body: { row_version: plan.row_version, phases: [{ kind: 'pre_season', label: 'Pre-season', from: ago(80), to: ago(30) }, { kind: 'exams', label: 'Summer exams', from: tomorrow(20), to: tomorrow(50) }], status: 'active' } }));
  const v = must(await api('GET', `/academy/dev-plans/${plan.id}`, { token: coach.token }));
  assert.equal(v.phases.length, 2); assert.equal(v.framework.family, 'invasion');
  assert.equal(v.clashes.length, 2);                                           // the milestone (day 30) and the training block (day 40) fall in the exams
  assert.equal(v.clashes[0].phase.kind, 'exams');

  // squad board: explained reasons, never a score
  const board = must(await api('GET', `${base}/board`, { token: a.owner.token }));
  assert.equal(board.total, 1);
  const row = board.items[0];
  assert.ok(row.reasons.some((r) => r.code === 'domains_uncovered') && row.reasons.some((r) => r.code === 'phase_clash'));
  assert.equal(row.cells.technical.objectives, 1); assert.equal(row.cells.tactical.worst, 'empty');
  assert.ok(!JSON.stringify(row).includes('score'));
  assert.equal((await api('GET', `${base}/board`, { token: (await adult()).token })).status, 404);
});
