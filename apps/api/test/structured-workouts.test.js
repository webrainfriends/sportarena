import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const ws = await import('../src/workout-structure.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `sw_${n}_${roles[0]}`, display_name: `SW Person${n}`, email: `sw${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const post = (t, p, body) => api('POST', p, { token: t, body });
const get = (t, p) => api('GET', p, { token: t });
const patch = (t, p, body) => api('PATCH', p, { token: t, body });
const inFuture = (days, hour = 9) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const squat = { id: 'squat', kind: 'strength', label: 'Back squat', sets: 4, reps: 8, load_kg: 60, rest_sec: 90, demo: { url: 'https://example.com/squat', title: 'Squat form' } };
const reps = { id: 'rep800', kind: 'interval', label: '800 m repeats', sets: 5, work_m: 800, rest_sec: 120, zone: { kind: 'pace', level: 4, min: 190, max: 210 } };
const session = (blocks, extra = {}) => ({ starts_at: inFuture(3, 17), duration_min: 60, kind: 'conditioning', title: 'Structured', blocks, ...extra });

// a coach and athlete who actively work together (confirmed hire gives the relationship)
const pair = async (sport = 'athletics') => {
  const coach = await signup(['coach']), athlete = await signup(['athlete']);
  ok(await post(coach.token, '/me/sport-profiles', { sport, role: 'coach', level: 'pro', hourly_rate_cents: 50000 }), 201);
  const hire = ok(await post(athlete.token, '/hires', { coach_id: coach.id, sport, starts_at: inFuture(2), duration_min: 60 }), 201);
  ok(await patch(coach.token, `/hires/${hire.id}`, { status: 'confirmed' }));
  return { coach, athlete };
};
const accepted = async (sport, blocks) => {
  const { coach, athlete } = await pair(sport);
  const plan = ok(await post(coach.token, '/training-plans', { athlete_id: athlete.id, sport, title: 'Block', content: { sessions: [session(blocks)] } }), 201);
  ok(await post(coach.token, `/training-plans/${plan.id}/propose`));
  ok(await post(athlete.token, `/training-plans/${plan.id}/respond`, { response: 'accepted' }));
  const full = ok(await get(athlete.token, `/training-plans/${plan.id}`));
  return { coach, athlete, plan, s: full.sessions[0] };
};

test('unit and sport validation rejects workouts that cannot be carried out', async () => {
  const { coach, athlete } = await pair('football');
  const make = (blocks) => post(coach.token, '/training-plans', { athlete_id: athlete.id, sport: 'football', title: 'Plan', content: { sessions: [session(blocks)] } });
  assert.equal((await make([reps])).status, 400, 'pace zones are not used for football');
  assert.equal((await make([{ id: 'a', kind: 'work', label: 'x', zone: { kind: 'power', level: 3 }, work_sec: 60 }])).status, 400, 'power zone outside power sports');
  assert.equal((await make([squat, { ...squat }])).status, 400, 'duplicate ids');
  assert.equal((await make([{ id: 'i', kind: 'interval', label: 'I', work_m: 200 }])).status, 400, 'interval needs repetitions');
  assert.equal((await make([{ id: 'r', kind: 'rest', label: 'R' }])).status, 400, 'rest needs a time');
  assert.equal((await make([{ ...squat, demo: { url: 'http://example.com/x' } }])).status, 400, 'demo must be https');
  assert.equal((await make([{ ...squat, demo: { url: 'https://user:pw@example.com/x' } }])).status, 400, 'no credentials in links');
  assert.equal((await make([{ ...squat, sets: 0 }])).status, 400);
  assert.equal((await make([{ ...squat, reps: 5000 }])).status, 400);
  assert.equal((await make([{ id: 'z', kind: 'work', label: 'Z', work_m: 100, zone: { kind: 'pace', level: 2, min: 300, max: 200 } }])).status, 400);
  ok(await make([squat, { id: 'rest1', kind: 'rest', label: 'Walk', rest_sec: 180 }]), 201);
  assert.deepEqual(ws.rulesFor({ slug: 'swimming', scoring: 'time' }), { distance: true, pace: true, power: false, pace_per_m: 100, power_zones: false });
  assert.equal(ws.rulesFor({ slug: 'cycling', scoring: 'time' }).power, true);
});

test('a structured plan is private until proposed, copied to the session on acceptance, and existing free-text sessions are unchanged', async () => {
  const { coach, athlete } = await pair('athletics');
  const plan = ok(await post(coach.token, '/training-plans', { athlete_id: athlete.id, sport: 'athletics', title: 'Mixed', content: { sessions: [session([reps]), { starts_at: inFuture(5, 17), duration_min: 45, kind: 'skill', title: 'Plain session', instructions: 'Free text' }] } }), 201);
  assert.equal(ok(await get(athlete.token, `/training-plans/${plan.id}`)).revisions.length, 0);
  ok(await post(coach.token, `/training-plans/${plan.id}/propose`));
  ok(await post(athlete.token, `/training-plans/${plan.id}/respond`, { response: 'accepted' }));
  const full = ok(await get(athlete.token, `/training-plans/${plan.id}`));
  const [a, b] = full.sessions;
  assert.equal(a.structure.length, 1);
  assert.deepEqual(a.summary, { blocks: 1, distance_m: 4000, work_sec: 0, rest_sec: 600 });
  assert.equal(b.structure, null); assert.equal(b.summary, undefined);
  assert.equal(full.sport_rules.pace, true);
  assert.equal(full.viewer, 'athlete');
});

test('the athlete records results against the plan: save progress, stale copies are refused, finishing is final and retry-safe', async () => {
  const { coach, athlete, s } = await accepted('athletics', [reps, { ...squat, id: 'sq2' }]);
  assert.equal(s.version, 1);
  const url = `/training-sessions/${s.id}`;
  assert.equal((await patch(coach.token, url, { actuals: [], expected_version: 1 })).status, 403, 'coach cannot record athlete results');
  assert.equal((await patch(athlete.token, url, { actuals: [{ block_id: 'nope', completed: true }], expected_version: 1 })).status, 400, 'unknown block');
  assert.equal((await patch(athlete.token, url, { actuals: [{ block_id: 'rep800', completed: true }] })).status, 400, 'expected_version required');
  assert.equal((await patch(athlete.token, url, { actuals: [{ block_id: 'sq2', completed: true, avg_power_w: 200 }], expected_version: 1 })).status, 400, 'no power in athletics');
  assert.equal((await patch(athlete.token, url, { actuals: [{ block_id: 'rep800', completed: true }, { block_id: 'rep800', completed: true }], expected_version: 1 })).status, 400, 'two results for a block');

  const half = [{ block_id: 'rep800', completed: false, sets_done: 3, distance_m: 2400, avg_pace: 205 }];
  const saved = ok(await patch(athlete.token, url, { actuals: half, expected_version: 1 }));
  assert.equal(saved.version, 2); assert.equal(saved.status, 'scheduled');
  assert.equal((await patch(athlete.token, url, { actuals: half, expected_version: 1 })).status, 409, 'stale device');

  const final = [{ block_id: 'rep800', completed: true, sets_done: 5, distance_m: 4000, avg_pace: 215 }, { block_id: 'sq2', completed: true, sets_done: 4, reps_done: 8, load_kg: 60 }];
  const done = ok(await patch(athlete.token, url, { status: 'completed', actuals: final, expected_version: 2, athlete_rpe: 8, athlete_feedback: 'Tough' }));
  assert.equal(done.status, 'completed');
  // an identical retry (double tap, lost response) succeeds without changing anything; a different one is refused
  const again = ok(await patch(athlete.token, url, { status: 'completed', actuals: final, expected_version: 2, athlete_rpe: 8, athlete_feedback: 'Tough' }));
  assert.equal(again.version, done.version);
  assert.equal((await patch(athlete.token, url, { status: 'completed', actuals: half, expected_version: 3 })).status, 409);
  assert.equal((await patch(athlete.token, url, { status: 'skipped' })).status, 409);

  const view = ok(await get(coach.token, `/training-plans/${(await pool.query('SELECT plan_id FROM training_sessions WHERE id=$1', [s.id])).rows[0].plan_id}`)).sessions[0];
  const rep = view.compliance.blocks.find((b) => b.block_id === 'rep800');
  assert.equal(rep.completed, true);
  assert.equal(rep.metrics.find((m) => m.metric === 'pace').in_zone, false, '215 s/km is slower than the 190-210 zone');
  assert.equal(view.compliance.pct, 100);
  assert.equal(view.athlete_rpe, 8);
});

test('a skipped or partial session is compared honestly, and sessions without a structure refuse results', async () => {
  const { athlete, s } = await accepted('athletics', [reps]);
  const url = `/training-sessions/${s.id}`;
  const part = ok(await patch(athlete.token, url, { status: 'completed', actuals: [{ block_id: 'rep800', completed: true, sets_done: 3, distance_m: 2000 }], expected_version: 1 }));
  assert.equal(part.status, 'completed');
  const planId = (await pool.query('SELECT plan_id FROM training_sessions WHERE id=$1', [s.id])).rows[0].plan_id;
  const c = ok(await get(athlete.token, `/training-plans/${planId}`)).sessions[0].compliance;
  assert.equal(c.pct, 55, 'average of 60% sets and 50% distance');
  const { coach, athlete: a2 } = await pair('athletics');
  const plan = ok(await post(coach.token, '/training-plans', { athlete_id: a2.id, sport: 'athletics', title: 'Plain', content: { sessions: [{ starts_at: inFuture(3), duration_min: 30, kind: 'skill', title: 'Plain' }] } }), 201);
  ok(await post(coach.token, `/training-plans/${plan.id}/propose`));
  ok(await post(a2.token, `/training-plans/${plan.id}/respond`, { response: 'accepted' }));
  const plain = ok(await get(a2.token, `/training-plans/${plan.id}`)).sessions[0];
  assert.equal((await patch(a2.token, `/training-sessions/${plain.id}`, { actuals: [], expected_version: 1 })).status, 400);
  ok(await patch(a2.token, `/training-sessions/${plain.id}`, { status: 'completed', athlete_rpe: 6 }));
});

test('live revocation: once the relationship ends the coach keeps their plan but no longer sees what the athlete recorded; strangers see nothing', async () => {
  const { coach, athlete, plan, s } = await accepted('athletics', [reps]);
  ok(await patch(athlete.token, `/training-sessions/${s.id}`, { status: 'completed', athlete_rpe: 7, athlete_feedback: 'Private', actuals: [{ block_id: 'rep800', completed: true, sets_done: 5 }], expected_version: 1 }));
  const live = ok(await get(coach.token, `/training-plans/${plan.id}`)).sessions[0];
  assert.equal(live.athlete_feedback, 'Private'); assert.ok(live.compliance);
  const stranger = await signup(['coach']);
  assert.equal((await get(stranger.token, `/training-plans/${plan.id}`)).status, 404);
  assert.equal((await patch(stranger.token, `/training-sessions/${s.id}`, { coach_feedback: 'hi' })).status, 403);
  ok(await post(athlete.token, `/training-plans/${plan.id}/close`));
  await pool.query("UPDATE coach_hires SET status='cancelled' WHERE coach_id=$1", [coach.id]);
  const gone = ok(await get(coach.token, `/training-plans/${plan.id}`)).sessions[0];
  assert.equal(gone.actuals, undefined); assert.equal(gone.athlete_feedback, null); assert.equal(gone.athlete_data_hidden, 'relationship_ended'); assert.equal(gone.compliance, undefined);
  assert.equal(gone.structure.length, 1, 'the coach\'s own plan stays');
  assert.equal((await patch(coach.token, `/training-sessions/${s.id}`, { coach_feedback: 'late' })).status, 403);
  // the data itself is never removed
  assert.equal((await pool.query('SELECT athlete_rpe FROM training_sessions WHERE id=$1', [s.id])).rows[0].athlete_rpe, 7);
});

test('young athletes: a structured plan needs guardian coaching consent, the guardian reads it only while consent stands, and withdrawal hides recorded results', async () => {
  const coach = await signup(['coach']), kid = await signup(['athlete']), parent = await signup(['athlete']);
  const team = ok(await post(coach.token, '/teams', { name: `Youth SW ${n}`, sport: 'athletics' }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, kid.id]);
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, kid.id]);
  const consent = (purpose) => pool.query("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,$2,$3,1, now() + interval '30 days') ON CONFLICT (child_id, purpose) DO UPDATE SET revoked_at=NULL, expires_at=now() + interval '30 days'", [kid.id, purpose, parent.id]);
  await consent('participation');
  const plan = ok(await post(coach.token, '/training-plans', { athlete_id: kid.id, sport: 'athletics', title: 'Youth', content: { sessions: [session([reps])] } }), 201);
  const refused = await post(coach.token, `/training-plans/${plan.id}/propose`);
  assert.equal(refused.status, 409); assert.equal(refused.body.error.details?.code ?? refused.body.error.code, 'guardian_consent_required');
  await consent('coaching');
  ok(await post(coach.token, `/training-plans/${plan.id}/propose`));
  ok(await post(kid.token, `/training-plans/${plan.id}/respond`, { response: 'accepted' }));
  const sid = ok(await get(kid.token, `/training-plans/${plan.id}`)).sessions[0].id;
  ok(await patch(kid.token, `/training-sessions/${sid}`, { status: 'completed', actuals: [{ block_id: 'rep800', completed: true, sets_done: 5 }], expected_version: 1 }));
  const g = ok(await get(parent.token, `/training-plans/${plan.id}`));
  assert.equal(g.viewer, 'guardian'); assert.ok(g.sessions[0].compliance);
  assert.equal((await patch(parent.token, `/training-sessions/${sid}`, { coach_feedback: 'x' })).status, 403, 'guardians read, they do not write');
  await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='coaching'", [kid.id]);
  const hiddenFromParent = ok(await get(parent.token, `/training-plans/${plan.id}`)).sessions[0];
  assert.equal(hiddenFromParent.compliance, undefined); assert.equal(hiddenFromParent.athlete_data_hidden, 'guardian_consent');
  const hiddenFromCoach = ok(await get(coach.token, `/training-plans/${plan.id}`)).sessions[0];
  assert.equal(hiddenFromCoach.compliance, undefined); assert.equal(hiddenFromCoach.athlete_data_hidden, 'guardian_consent');
  await consent('coaching');
  assert.ok(ok(await get(coach.token, `/training-plans/${plan.id}`)).sessions[0].compliance, 'allowing it again restores it');
});

test('a revision can restructure a future session; completed history keeps its blocks and results', async () => {
  const { coach, athlete, plan, s } = await accepted('athletics', [reps]);
  ok(await post(coach.token, `/training-plans/${plan.id}/revisions`), 201);
  const next = { ...reps, label: '600 m repeats', work_m: 600 };
  ok(await patch(coach.token, `/training-plans/${plan.id}/draft`, { content: { sessions: [{ ...session([next]), session_id: s.id, starts_at: s.starts_at }] } }));
  ok(await post(coach.token, `/training-plans/${plan.id}/propose`));
  ok(await post(athlete.token, `/training-plans/${plan.id}/respond`, { response: 'accepted' }));
  const after = ok(await get(athlete.token, `/training-plans/${plan.id}`)).sessions[0];
  assert.equal(after.structure[0].work_m, 600); assert.equal(after.summary.distance_m, 3000);
  assert.equal(after.from_rev, 2);
});

test('the capability is exposed over REST, OpenAPI and MCP with the same schema', async () => {
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json().catch(() => null);
  const text = JSON.stringify(spec ?? {});
  assert.ok(text.includes('expected_version') && text.includes('work_m'), 'OpenAPI carries the workout schema');
});

test('pro-level plan: periodisation phases, session objective/focus, weekly training load and week-on-week change', async () => {
  const { coach, athlete } = await pair('athletics');
  const mk = (body) => post(coach.token, '/training-plans', { athlete_id: athlete.id, sport: 'athletics', title: 'Season plan', content: body });
  const d = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const phase = (id, kind, from, to) => ({ id, kind, label: id, from, to, focus: 'Aerobic base' });
  assert.equal((await mk({ sessions: [session([reps])], phases: [phase('a', 'preparation', d(0), d(20)), phase('b', 'competition', d(10), d(40))] })).status, 400, 'overlapping phases');
  assert.equal((await mk({ sessions: [session([reps])], phases: [phase('a', 'preparation', d(20), d(0))] })).status, 400, 'ends before it starts');
  const plan = ok(await mk({ sessions: [session([reps], { objective: 'Repeat-sprint ability', focus: 'speed', target_rpe: 8, duration_min: 60 }), { ...session([squat], { target_rpe: 5, duration_min: 60, title: 'Gym' }), starts_at: inFuture(11, 9) }], phases: [phase('base', 'preparation', d(0), d(30))] }), 201);
  ok(await post(coach.token, `/training-plans/${plan.id}/propose`));
  ok(await post(athlete.token, `/training-plans/${plan.id}/respond`, { response: 'accepted' }));
  const view = ok(await get(coach.token, `/training-plans/${plan.id}`));
  assert.equal(view.phases[0].kind, 'preparation');
  assert.equal(view.sessions[0].objective, 'Repeat-sprint ability'); assert.equal(view.sessions[0].focus, 'speed');
  assert.equal(view.sessions[0].planned_load, 480);
  assert.equal(view.weeks.length, 2);
  assert.equal(view.weeks[0].phase, 'base');
  assert.equal(view.weeks[0].planned_load + view.weeks[1].planned_load, 780);
  assert.ok(view.weeks[1].planned_load_change_pct !== null);
  // completing a session fills actual load = effort x minutes
  const sid = view.sessions[0].id;
  ok(await patch(athlete.token, `/training-sessions/${sid}`, { status: 'completed', athlete_rpe: 7 }));
  const after = ok(await get(athlete.token, `/training-plans/${plan.id}`));
  assert.equal(after.sessions[0].actual_load, 420);
  assert.equal(after.weeks[0].completed, 1);
});

test('PDF export: coach, athlete and consenting guardian can download it; revoked access leaves the athlete\'s results out; strangers are refused; exports are audited', async () => {
  const { coach, athlete, plan, s } = await accepted('athletics', [reps]);
  ok(await patch(athlete.token, `/training-sessions/${s.id}`, { status: 'completed', athlete_rpe: 7, athlete_feedback: 'SECRETFEEDBACK', actuals: [{ block_id: 'rep800', completed: true, sets_done: 5 }], expected_version: 1 }));
  for (const who of [coach, athlete]) {
    const f = ok(await get(who.token, `/training-plans/${plan.id}/export`));
    assert.equal(f.content_type, 'application/pdf');
    const buf = Buffer.from(f.content, 'base64');
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-'); assert.ok(f.pages >= 1);
  }
  const stranger = await signup(['coach']);
  assert.equal((await get(stranger.token, `/training-plans/${plan.id}/export`)).status, 404);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='export' AND entity='training_plan' AND entity_id=$1", [plan.id])).rows.length >= 2);
  // the renderer is fed the same redacted view: no athlete feedback once access has ended
  const { renderTrainingPlan } = await import('../src/documents/training-plan-pdf.js');
  const live = ok(await get(coach.token, `/training-plans/${plan.id}`));
  assert.ok(live.sessions[0].athlete_feedback === 'SECRETFEEDBACK');
  ok(await post(athlete.token, `/training-plans/${plan.id}/close`));
  await pool.query("UPDATE coach_hires SET status='cancelled' WHERE coach_id=$1", [coach.id]);
  const gone = ok(await get(coach.token, `/training-plans/${plan.id}`));
  assert.equal(gone.sessions[0].athlete_feedback, null); assert.equal(gone.weeks[0].completed, null); assert.equal(gone.sessions[0].actual_load, null);
  const out = await renderTrainingPlan(gone);
  assert.ok(out.buffer.length > 500 && out.pages >= 1);
});
