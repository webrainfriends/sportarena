import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/registry.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `cu_${n}_${roles[0]}`, display_name: `Cu ${n}`, email: `cu${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const addDays = (d, k) => new Date(new Date(`${d}T00:00:00Z`).getTime() + k * 864e5).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const LIB = {
  philosophy: { statement: 'Play with courage, think before you act.', values: [{ key: 'respect', title: 'Respect' }], principles: [{ key: 'questions', title: 'Coach with questions' }] },
  stages: [{ key: 'foundation', title: 'Foundation', age_min: 8, age_max: 10, hours_per_week: 4 }, { key: 'development', title: 'Development', age_min: 11, age_max: 13, hours_per_week: 8 }],
  game_model: [{ key: 'build', phase: 'in_possession', title: 'Build from the back' }, { key: 'press', phase: 'out_of_possession', title: 'Press on the trigger' }],
  standards: { session_minutes: 75, rpe_target: 7, coach_ratio: 10 },
  competencies: [
    { key: 'first_touch', pillar: 'technical', title: 'First touch', proficiency: [{ stage_key: 'foundation', descriptor: 'Stops the ball under control' }] }, { key: 'scanning', pillar: 'tactical', title: 'Scanning' },
    { key: 'speed', pillar: 'physical', title: 'Speed' }, { key: 'resilience', pillar: 'mental', title: 'Resilience' },
  ],
  outcomes: [{ competency_key: 'first_touch', age_min: 10, age_max: 12, outcome: 'Controls a driven pass with either foot' }],
  drills: [
    { key: 'rondo', title: 'Rondo 4v2', kind: 'skill_drill', competency_keys: ['first_touch', 'scanning'], duration_min: 15, instructions: 'Keep the ball', area: '10x10 m' },
    { key: 'sprint', title: 'Sprint ladder', kind: 'conditioning', competency_keys: ['speed'], duration_min: 10 },
  ],
};
const OBJ = [
  { key: 'touch_u12', title: 'Receive on the back foot', competency_key: 'first_touch', sessions_target: 1, drill_keys: ['rondo'], success_criteria: '8 of 10 receptions controlled in two touches', priority: 'core', mastery_target: 'develop', guardian_summary: 'Learning to control the ball first time.' },
  { key: 'speed_u12', title: 'Repeat sprint quality', competency_key: 'speed', sessions_target: 2, drill_keys: ['sprint'], success_criteria: 'Sprint decrement under 5% across six reps', rpe_target: 8 },
];

/** An academy with owner, a Technical Director (engagement with curriculum permission), two coaches, a cohort and players, plus 3 generated sessions. */
async function academy() {
  const owner = await signup(), td = await signup(), coach = await signup(['coach']), coach2 = await signup(['coach']), finance = await signup();
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `Curriculum Academy ${n}`, kind: 'academy' } }), 201);
  for (const [u, role] of [[td, 'staff'], [coach, 'coach'], [coach2, 'coach'], [finance, 'finance']]) {
    ok(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
    ok(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
  }
  ok(await api('POST', `/organisations/${org.id}/academy/staff/${td.id}`, { token: owner.token, body: { job_title: 'Technical Director', template: 'head_coach' } }));
  const cohort = ok(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'U12 Football', coach_id: coach.id } }), 201);
  const players = [await signup(), await signup()];
  ok(await api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${players.map((p) => `${p.handle},yes`).join('\n')}` } }), 201);
  const start = addDays(today, 3);
  const dow = new Date(`${start}T00:00:00Z`).getUTCDay();
  const gen = ok(await api('POST', `/cohorts/${cohort.id}/academy/timetable`, { token: owner.token, body: { idempotency_key: `k${n}${Date.now()}`, starts_on: start, ends_on: addDays(start, 14), weekdays: [dow], start_time: '17:00', duration_min: 60, timezone: 'UTC', lead_id: coach.id } }), 201);
  return { owner, td, coach, coach2, finance, org, cohort, players, sessions: gen.created.map((c) => c.id) };
}
/** Make a generated session published and already under way (the timetable only creates future drafts). */
const startSession = (sid, hoursAgo = 2) => pool.query("UPDATE academy_sessions SET status='published', starts_at=now() - ($2 || ' hours')::interval, ends_at=now() - ($2 || ' hours')::interval + interval '1 hour' WHERE id=$1", [sid, String(hoursAgo)]);

async function methodology(a, sport = 'football') {
  const m = ok(await api('POST', `/organisations/${a.org.id}/academy/methodologies`, { token: a.owner.token, body: { sport, title: `${sport} way` } }), 201);
  const pub = ok(await api('POST', `/academy/methodologies/${m.id}/versions`, { token: a.td.token, body: { row_version: m.row_version, ...LIB } }), 201);
  return { m: pub.methodology, v: pub.version };
}
async function publishedCurriculum(a, mid, extra = {}, objectives = OBJ, by = a.td) {
  const cur = ok(await api('POST', `/organisations/${a.org.id}/academy/curricula`, { token: a.owner.token, body: { methodology_id: mid, title: 'U12 Technical Core', age_min: 10, age_max: 12, level_key: 'development', ...extra } }), 201);
  const d = ok(await api('POST', `/academy/curricula/${cur.id}/versions`, { token: by.token, body: { objectives } }), 201);
  ok(await api('POST', `/academy/curriculum-versions/${d.id}/submit`, { token: by.token }));
  ok(await api('POST', `/academy/curriculum-versions/${d.id}/decision`, { token: a.owner.token, body: { decision: 'approve' } }));
  ok(await api('POST', `/academy/curriculum-versions/${d.id}/publish`, { token: a.owner.token }), 200);
  return { cur, version: d };
}

test('lifecycle: library → versioned curriculum → TD approval → publish → assign → map → run in coaching tools → evidence → coverage; version B never rewrites history', async () => {
  const a = await academy();
  const { m } = await methodology(a);
  const lib = ok(await api('GET', `/organisations/${a.org.id}/academy/methodologies`, { token: a.coach.token }));
  assert.equal(lib.length, 1); assert.equal(lib[0].competencies, 4); assert.equal(lib[0].drills, 2);

  const cur = ok(await api('POST', `/organisations/${a.org.id}/academy/curricula`, { token: a.owner.token, body: { methodology_id: m.id, title: 'U12 Technical Core', age_min: 10, age_max: 12, level_key: 'development' } }), 201);
  assert.equal(cur.status, 'draft');
  const draft = ok(await api('POST', `/academy/curricula/${cur.id}/versions`, { token: a.td.token, body: { objectives: OBJ, effective_from: today } }), 201);
  assert.equal(draft.version, 1); assert.equal(draft.status, 'draft');
  // saving again replaces the open draft rather than stacking versions
  const again = ok(await api('POST', `/academy/curricula/${cur.id}/versions`, { token: a.td.token, body: { objectives: OBJ, effective_from: today } }), 201);
  assert.equal(again.id, draft.id);
  // cannot assign or publish yet
  assert.equal((await api('POST', `/academy/curricula/${cur.id}/assignments`, { token: a.owner.token, body: { cohort_id: a.cohort.id } })).status, 409);
  assert.equal((await api('POST', `/academy/curriculum-versions/${draft.id}/publish`, { token: a.owner.token })).status, 409, 'only approved versions publish');
  ok(await api('POST', `/academy/curriculum-versions/${draft.id}/submit`, { token: a.td.token }));
  // four eyes: the TD who submitted cannot approve; the owner can
  assert.equal((await api('POST', `/academy/curriculum-versions/${draft.id}/decision`, { token: a.td.token, body: { decision: 'approve' } })).status, 403);
  // a frozen version cannot be edited, by API or by SQL
  assert.equal((await api('POST', `/academy/curricula/${cur.id}/versions`, { token: a.td.token, body: { objectives: OBJ } })).status, 409);
  await assert.rejects(pool.query("UPDATE academy_curriculum_versions SET objectives='[]' WHERE id=$1", [draft.id]), /cannot be edited/);
  assert.equal(ok(await api('POST', `/academy/curriculum-versions/${draft.id}/decision`, { token: a.owner.token, body: { decision: 'approve' } })).status, 'approved');
  assert.equal(ok(await api('POST', `/academy/curriculum-versions/${draft.id}/publish`, { token: a.td.token })).status, 'published');

  const asg = ok(await api('POST', `/academy/curricula/${cur.id}/assignments`, { token: a.td.token, body: { cohort_id: a.cohort.id, coach_id: a.coach.id } }), 201);
  assert.equal(ok(await api('POST', `/academy/curricula/${cur.id}/assignments`, { token: a.td.token, body: { cohort_id: a.cohort.id, coach_id: a.coach.id } }), 201).id, asg.id, 'repeat returns the same assignment');
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='academy_curriculum_assigned'", [a.coach.id])).rowCount >= 1);

  // the coach sees the assigned curriculum, the other coach does not
  assert.equal(ok(await api('GET', `/organisations/${a.org.id}/academy/curricula`, { token: a.coach.token })).length, 1);
  assert.equal(ok(await api('GET', `/organisations/${a.org.id}/academy/curricula`, { token: a.coach2.token })).length, 0);
  assert.equal((await api('GET', `/academy/curricula/${cur.id}`, { token: a.coach2.token })).status, 404);

  const sid = a.sessions[0];
  await startSession(sid);
  const offered = ok(await api('GET', `/academy/sessions/${sid}/objectives`, { token: a.coach.token }));
  assert.equal(offered.available.length, 2); assert.equal(offered.objectives.length, 0);
  const mapped = ok(await api('POST', `/academy/sessions/${sid}/objectives`, { token: a.coach.token, body: { add_keys: ['touch_u12'] } }), 201);
  assert.equal(mapped.length, 1); assert.equal(mapped[0].snapshot.pillar, 'technical'); assert.equal(mapped[0].snapshot.version, 1);
  assert.equal(ok(await api('POST', `/academy/sessions/${sid}/objectives`, { token: a.coach.token, body: { add_keys: ['touch_u12'] } }), 201).length, 1, 'idempotent');
  assert.equal((await api('POST', `/academy/sessions/${sid}/objectives`, { token: a.coach.token, body: { add_keys: ['nope'] } })).status, 400);
  assert.equal((await api('POST', `/academy/sessions/${sid}/objectives`, { token: a.coach2.token, body: { add_keys: ['touch_u12'] } })).status, 403);

  // delivering without evidence is refused; run it in the existing coaching tools, then record
  const noEv = await api('POST', `/academy/sessions/${sid}/objectives/touch_u12/outcome`, { token: a.coach.token, body: { outcome: 'delivered' } });
  assert.equal(noEv.status, 400); assert.equal(noEv.body.error.details?.code, 'evidence_required');
  const loaded = ok(await api('POST', `/academy/sessions/${sid}/objectives/plan`, { token: a.coach.token, body: {} }), 201);
  assert.deepEqual(loaded.added, ['Rondo 4v2']);
  assert.deepEqual(ok(await api('POST', `/academy/sessions/${sid}/objectives/plan`, { token: a.coach.token, body: {} }), 201).added, [], 'repeat adds nothing twice');
  const ws = ok(await api('GET', `/coaching/sessions/${loaded.record_id}`, { token: a.coach.token }));
  const blk = ws.plan.blocks[0];
  assert.deepEqual(blk.tags.slice(0, 2), ['obj:touch_u12', 'drill:rondo']); assert.deepEqual(blk.trains, ['first_touch']);
  ok(await api('POST', `/coaching/sessions/${loaded.record_id}/start`, { token: a.coach.token }));
  ok(await api('POST', `/coaching/sessions/${loaded.record_id}/blocks/${blk.id}`, { token: a.coach.token, body: { status: 'completed' } }));
  const done = ok(await api('POST', `/academy/sessions/${sid}/objectives/touch_u12/outcome`, { token: a.coach.token, body: { outcome: 'delivered' } }));
  assert.equal(done.status, 'delivered'); assert.equal(done.evidence.blocks_done, 1); assert.equal(done.evidence.attested, false);
  // the TD sees the evidence (counts) but not the coach's private record id
  const tdView = ok(await api('GET', `/academy/sessions/${sid}/objectives`, { token: a.td.token }));
  assert.equal(tdView.objectives[0].live_evidence.blocks_done, 1); assert.equal(tdView.objectives[0].live_evidence.record_id, null);

  // version B: change the objective, approve, publish tomorrow-or-later; the past session keeps version 1's wording
  const b = ok(await api('POST', `/academy/curricula/${cur.id}/versions`, { token: a.td.token, body: { objectives: [{ ...OBJ[0], title: 'Receive and turn (revised)' }, OBJ[1]] } }), 201);
  assert.equal(b.version, 2);
  ok(await api('POST', `/academy/curriculum-versions/${b.id}/submit`, { token: a.td.token }));
  ok(await api('POST', `/academy/curriculum-versions/${b.id}/decision`, { token: a.owner.token, body: { decision: 'approve' } }));
  assert.equal((await api('POST', `/academy/curriculum-versions/${b.id}/publish`, { token: a.owner.token, body: { effective_from: addDays(today, -1) } })).status, 400, 'no back-dating');
  assert.equal((await api('POST', `/academy/curriculum-versions/${b.id}/publish`, { token: a.owner.token, body: { effective_from: today } })).status, 400, 'must start after the version it replaces');
  ok(await api('POST', `/academy/curriculum-versions/${b.id}/publish`, { token: a.owner.token, body: { effective_from: addDays(today, 1) } }));
  const det = ok(await api('GET', `/academy/curricula/${cur.id}`, { token: a.owner.token }));
  assert.equal(det.versions.find((v) => v.version === 1).status, 'superseded');
  assert.equal(det.in_force.version, 1, 'version 2 starts tomorrow, 1 still applies today');
  const snap = (await pool.query("SELECT snapshot FROM academy_session_objectives WHERE session_id=$1 AND objective_key='touch_u12'", [sid])).rows[0].snapshot;
  assert.equal(snap.title, 'Receive on the back foot'); assert.equal(snap.version, 1);
  await assert.rejects(pool.query("UPDATE academy_session_objectives SET snapshot='{}' WHERE session_id=$1", [sid]), /cannot be rewritten/);
  // a session after the switch maps version 2
  await pool.query("UPDATE academy_sessions SET starts_at = (current_date + 1) + time '10:00', ends_at = (current_date + 1) + time '11:00', timezone='UTC' WHERE id=$1", [a.sessions[2]]);
  const later = ok(await api('POST', `/academy/sessions/${a.sessions[2]}/objectives`, { token: a.coach.token, body: { add_keys: ['touch_u12'] } }), 201);
  assert.equal(later[0].snapshot.version, 2); assert.equal(later[0].snapshot.title, 'Receive and turn (revised)');

  // deviation: partly / not delivered need a reason
  await startSession(a.sessions[1], 3);
  ok(await api('POST', `/academy/sessions/${a.sessions[1]}/objectives`, { token: a.td.token, body: { add_keys: ['speed_u12'] } }), 201);
  assert.equal((await api('POST', `/academy/sessions/${a.sessions[1]}/objectives/speed_u12/outcome`, { token: a.coach.token, body: { outcome: 'not_delivered' } })).status, 400);
  const dev = ok(await api('POST', `/academy/sessions/${a.sessions[1]}/objectives/speed_u12/outcome`, { token: a.coach.token, body: { outcome: 'not_delivered', deviation_reason: 'weather', deviation_note: 'Pitch waterlogged' } }));
  assert.equal(dev.deviation_reason, 'weather');
  // an objective with a recorded outcome cannot be withdrawn; an unrecorded one can
  assert.equal((await api('POST', `/academy/sessions/${sid}/objectives`, { token: a.coach.token, body: { remove_keys: ['touch_u12'] } })).status, 409);

  // coverage for the TD and for the coach
  const cov = ok(await api('GET', `/organisations/${a.org.id}/academy/curriculum-coverage`, { token: a.td.token }));
  assert.equal(cov.items.length, 1);
  const it = cov.items[0];
  assert.equal(it.totals.objectives, 2); assert.equal(it.totals.complete, 1); assert.equal(it.totals.coverage_pct, 50);
  assert.deepEqual(it.deviations, [{ reason: 'weather', n: 1 }]);
  assert.equal(it.objectives.find((o) => o.key === 'touch_u12').evidence.blocks_done, 1);
  assert.equal(ok(await api('GET', `/organisations/${a.org.id}/academy/curriculum-coverage`, { token: a.coach2.token })).items.length, 0);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/curriculum-coverage`, { token: a.finance.token })).status, 403);

  // review is append-only and stores the coverage at the time
  assert.equal((await api('POST', `/academy/curricula/${cur.id}/reviews`, { token: a.td.token, body: { outcome: 'needs_attention' } })).status, 400, 'needs a note');
  const rv = ok(await api('POST', `/academy/curricula/${cur.id}/reviews`, { token: a.td.token, body: { outcome: 'needs_attention', note: 'Speed work lost to weather' } }), 201);
  assert.equal(rv.coverage.cohorts[0].coverage_pct, 50);
  assert.equal((await api('POST', `/academy/curricula/${cur.id}/reviews`, { token: a.coach.token, body: { outcome: 'on_track' } })).status, 403);

  // ending the assignment keeps everything on record
  ok(await api('POST', `/academy/curriculum-assignments/${asg.id}/end`, { token: a.td.token }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_session_objectives')).rows[0].n, 3);
});

test('negative paths: authorization, validation, stale versions, rejection and self-approval', async () => {
  const a = await academy();
  // coaches and finance cannot govern; outsiders get 404
  const outsider = await signup();
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/methodologies`, { token: a.coach.token, body: { sport: 'football', title: 'x1' } })).status, 403);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/methodologies`, { token: a.finance.token, body: { sport: 'football', title: 'x1' } })).status, 403);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/methodologies`, { token: outsider.token })).status, 404);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/curricula`, { token: a.finance.token })).status, 403);
  const { m } = await methodology(a);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/methodologies`, { token: a.owner.token, body: { sport: 'football', title: 'FOOTBALL WAY' } })).status, 409, 'duplicate title');
  // stale methodology publish
  assert.equal((await api('POST', `/academy/methodologies/${m.id}/versions`, { token: a.owner.token, body: { row_version: 1, ...LIB } })).status, 409);
  // library validation
  const fresh = ok(await api('POST', `/organisations/${a.org.id}/academy/methodologies`, { token: a.owner.token, body: { sport: 'tennis', title: 'Baseline' } }), 201);
  const bad = (patch) => api('POST', `/academy/methodologies/${fresh.id}/versions`, { token: a.owner.token, body: { row_version: fresh.row_version, ...LIB, ...patch } });
  assert.equal((await bad({ drills: [{ key: 'd', title: 'Drill', competency_keys: ['ghost'] }] })).status, 400);
  assert.equal((await bad({ competencies: [LIB.competencies[0], LIB.competencies[0]] })).status, 400);
  assert.equal((await bad({ outcomes: [{ competency_key: 'ghost', outcome: 'x1' }] })).status, 400);
  assert.equal((await bad({ competencies: [{ ...LIB.competencies[0], rubric_id: '00000000-0000-4000-8000-000000000000' }] })).status, 400);
  // curriculum on an unpublished methodology; foreign season/campus/pathway
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/curricula`, { token: a.owner.token, body: { methodology_id: fresh.id, title: 'Too early' } })).status, 409);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/curricula`, { token: a.owner.token, body: { methodology_id: m.id, title: 'Bad ages', age_min: 14, age_max: 10 } })).status, 400);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/curricula`, { token: a.owner.token, body: { methodology_id: m.id, title: 'Bad season', season_id: '00000000-0000-4000-8000-000000000000' } })).status, 400);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/curricula`, { token: a.owner.token, body: { methodology_id: m.id, title: 'Bad campus', venue_id: '00000000-0000-4000-8000-000000000000' } })).status, 400);
  const cur = ok(await api('POST', `/organisations/${a.org.id}/academy/curricula`, { token: a.owner.token, body: { methodology_id: m.id, title: 'Core' } }), 201);
  const draft = (objectives) => api('POST', `/academy/curricula/${cur.id}/versions`, { token: a.td.token, body: { objectives } });
  assert.equal((await draft([{ ...OBJ[0], competency_key: 'ghost' }])).status, 400);
  assert.equal((await draft([{ ...OBJ[0], drill_keys: ['ghost'] }])).status, 400);
  assert.equal((await draft([OBJ[0], OBJ[0]])).status, 400);
  assert.equal((await draft([{ ...OBJ[0], op: 'exclude' }])).status, 400, 'no parent to exclude from');
  assert.equal((await api('POST', `/academy/curricula/${cur.id}/versions`, { token: a.coach.token, body: { objectives: OBJ } })).status, 403);
  // rejection needs a reason; after rejection a new draft is allowed and the old one stays
  const d = ok(await draft(OBJ), 201);
  ok(await api('POST', `/academy/curriculum-versions/${d.id}/submit`, { token: a.td.token }));
  assert.equal((await api('POST', `/academy/curriculum-versions/${d.id}/submit`, { token: a.td.token })).status, 409);
  assert.equal((await api('POST', `/academy/curriculum-versions/${d.id}/decision`, { token: a.owner.token, body: { decision: 'reject' } })).status, 400);
  ok(await api('POST', `/academy/curriculum-versions/${d.id}/decision`, { token: a.owner.token, body: { decision: 'reject', note: 'Too many objectives' } }));
  assert.equal((await api('POST', `/academy/curriculum-versions/${d.id}/publish`, { token: a.owner.token })).status, 409);
  assert.equal(ok(await draft(OBJ), 201).version, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM academy_curriculum_versions WHERE status='rejected'")).rows[0].n, 1);
  // an owner who authored and approves is recorded as self-approved
  const d2 = (await pool.query("SELECT id FROM academy_curriculum_versions WHERE curriculum_id=$1 AND version=2", [cur.id])).rows[0].id;
  ok(await api('POST', `/academy/curriculum-versions/${d2}/submit`, { token: a.owner.token }));
  assert.equal(ok(await api('POST', `/academy/curriculum-versions/${d2}/decision`, { token: a.owner.token, body: { decision: 'approve' } })).self_approved, true);
  // assignment guards: unpublished curriculum, foreign cohort, non-coach
  const cur2 = ok(await api('POST', `/organisations/${a.org.id}/academy/curricula`, { token: a.owner.token, body: { methodology_id: m.id, title: 'Unpublished' } }), 201);
  assert.equal((await api('POST', `/academy/curricula/${cur2.id}/assignments`, { token: a.owner.token, body: { cohort_id: a.cohort.id } })).status, 409);
  ok(await api('POST', `/academy/curriculum-versions/${d2}/publish`, { token: a.owner.token }));
  assert.equal((await api('POST', `/academy/curricula/${cur.id}/assignments`, { token: a.owner.token, body: { cohort_id: '00000000-0000-4000-8000-000000000000' } })).status, 400);
  assert.equal((await api('POST', `/academy/curricula/${cur.id}/assignments`, { token: a.owner.token, body: { cohort_id: a.cohort.id, coach_id: a.players[0].id } })).status, 400);
  ok(await api('POST', `/academy/curricula/${cur.id}/assignments`, { token: a.owner.token, body: { cohort_id: a.cohort.id, coach_id: a.coach.id } }), 201);
  // outcomes: not before the session starts, not on a cancelled/draft one, not for someone outside the session
  const sid = a.sessions[0];
  assert.equal((await api('POST', `/academy/sessions/${sid}/objectives`, { token: a.coach.token, body: { add_keys: ['touch_u12'] } })).status, 201);
  assert.equal((await api('POST', `/academy/sessions/${sid}/objectives/touch_u12/outcome`, { token: a.coach.token, body: { outcome: 'delivered', evidence_note: 'x1' } })).status, 409, 'session has not started');
  assert.equal((await api('POST', `/academy/sessions/${sid}/objectives/touch_u12/outcome`, { token: a.finance.token, body: { outcome: 'partly', deviation_reason: 'other' } })).status, 403);
  await startSession(sid);
  const att = ok(await api('POST', `/academy/sessions/${sid}/objectives/touch_u12/outcome`, { token: a.coach.token, body: { outcome: 'delivered', evidence_note: 'Ran the rondo off-platform with the group' } }));
  assert.equal(att.evidence.attested, true, 'attestation without a completed block is flagged');
  assert.equal((await api('POST', `/academy/sessions/${sid}/objectives/ghost/outcome`, { token: a.coach.token, body: { outcome: 'partly', deviation_reason: 'other' } })).status, 404);
  assert.equal((await api('POST', `/academy/sessions/${sid}/objectives/plan`, { token: a.coach2.token, body: {} })).status, 403);
  assert.equal((await api('GET', `/academy/sessions/${sid}/objectives`, { token: outsider.token })).status, 404);
});

test('inheritance: a campus curriculum inherits from the academy core, overrides and excludes; the parent in force is read live', async () => {
  const a = await academy();
  const { m } = await methodology(a);
  const { cur: core } = await publishedCurriculum(a, m.id);
  const child = ok(await api('POST', `/organisations/${a.org.id}/academy/curricula`, { token: a.owner.token, body: { methodology_id: m.id, title: 'North campus U12', parent_id: core.id } }), 201);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/curricula`, { token: a.owner.token, body: { methodology_id: m.id, title: 'Cross', parent_id: '00000000-0000-4000-8000-000000000000' } })).status, 400);
  const v = ok(await api('POST', `/academy/curricula/${child.id}/versions`, { token: a.td.token, body: { objectives: [
    { key: 'speed_u12', title: 'Speed (campus)', competency_key: 'speed', op: 'exclude' },
    { key: 'touch_u12', title: 'Receive and play (campus)', competency_key: 'first_touch', op: 'override', drill_keys: ['rondo'], success_criteria: 'Plays forward in two touches' },
    { key: 'scan_n', title: 'Scan before receiving', competency_key: 'scanning', drill_keys: ['rondo'], success_criteria: 'Checks both shoulders before 7 of 10 receptions' },
  ] } }), 201);
  ok(await api('POST', `/academy/curriculum-versions/${v.id}/submit`, { token: a.td.token }));
  ok(await api('POST', `/academy/curriculum-versions/${v.id}/decision`, { token: a.owner.token, body: { decision: 'approve' } }));
  ok(await api('POST', `/academy/curriculum-versions/${v.id}/publish`, { token: a.owner.token }));
  const det = ok(await api('GET', `/academy/curricula/${child.id}`, { token: a.owner.token }));
  assert.deepEqual(det.objectives.map((o) => o.key).sort(), ['scan_n', 'touch_u12']);
  assert.equal(det.objectives.find((o) => o.key === 'touch_u12').title, 'Receive and play (campus)');
  assert.equal(det.curriculum.parent_title, 'U12 Technical Core');
  // overriding something the parent does not have is refused
  const c2 = ok(await api('POST', `/organisations/${a.org.id}/academy/curricula`, { token: a.owner.token, body: { methodology_id: m.id, title: 'East campus', parent_id: core.id } }), 201);
  assert.equal((await api('POST', `/academy/curricula/${c2.id}/versions`, { token: a.td.token, body: { objectives: [{ key: 'ghost', title: 'Ghost', competency_key: 'speed', op: 'override' }] } })).status, 400);
  // a different methodology cannot be inherited
  const other = await methodology(a, 'cricket');
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/curricula`, { token: a.owner.token, body: { methodology_id: other.m.id, title: 'Mismatch', parent_id: core.id } })).status, 400);
});

test('families: guardian summary in plain language, no other athletes, guardian link required', async () => {
  const a = await academy();
  const { m } = await methodology(a);
  const { cur } = await publishedCurriculum(a, m.id);
  ok(await api('POST', `/academy/curricula/${cur.id}/assignments`, { token: a.owner.token, body: { cohort_id: a.cohort.id, coach_id: a.coach.id } }), 201);
  const mine = ok(await api('GET', '/academy/my-curriculum', { token: a.players[0].token }));
  assert.equal(mine.curricula.length, 1); assert.equal(mine.curricula[0].total, 2); assert.equal(mine.curricula[0].complete, 0);
  assert.equal(mine.curricula[0].objectives[0].summary, 'Learning to control the ball first time.');
  assert.equal(JSON.stringify(mine).includes(a.players[1].id), false, 'no other athlete');
  assert.equal((await api('GET', '/academy/my-curriculum', { token: a.players[0].token, query: { athlete_id: a.players[1].id } })).status, 403, 'not a guardian');
  assert.equal(ok(await api('GET', '/academy/my-curriculum', { token: (await signup()).token })).curricula.length, 0);
  // a verified guardian reads a young athlete's groups, and it is audited
  const parent = await signup(['athlete'], { dob: yearsAgo(40) }), kid = await signup(['athlete'], { dob: yearsAgo(10) });
  const l = ok(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: kid.id, relationship: 'parent' } }), 201);
  ok(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: kid.token, body: { accept: true } }));
  assert.equal((await api('GET', '/academy/my-curriculum', { token: parent.token, query: { athlete_id: kid.id } })).status, 403, 'link not yet verified');
});

test('every sport in the catalogue can carry a methodology and a published curriculum (no sport on a silent default)', async () => {
  const a = await academy();
  const sports = (await pool.query('SELECT slug FROM sports ORDER BY slug')).rows.map((r) => r.slug);
  assert.ok(sports.length > 20, `catalogue has ${sports.length} sports`);
  for (const sport of sports) {
    const { m } = await methodology(a, sport);
    assert.equal(m.sport, sport); assert.equal(m.current_version, 1);
  }
  assert.equal(ok(await api('GET', `/organisations/${a.org.id}/academy/methodologies`, { token: a.owner.token })).length, sports.length);
});

test('registry: every curriculum capability is REST + MCP with a summary, and the new permission is additive', async () => {
  const mine = capabilities.filter((c) => /curricul|methodolog|session_objective/.test(c.name));
  assert.ok(mine.length >= 17, `found ${mine.length}`);
  for (const c of mine) { assert.ok(c.summary && c.summary.length > 20, c.name); assert.ok(c.path && c.method, c.name); }
  const { PERMS, TEMPLATES } = await import('../src/academy-ops.js');
  assert.ok(PERMS.includes('curriculum') && PERMS.includes('payroll'));
  assert.ok(TEMPLATES.head_coach.permissions.includes('curriculum') && !TEMPLATES.coach.permissions.includes('curriculum'));
});

test('elite governance: stages, game model, periodisation, readiness gate, field-level diff and delivery analytics', async () => {
  const a = await academy();
  const { m, v } = await methodology(a);
  assert.equal(v.stages.length, 2); assert.equal(v.game_model.length, 2); assert.equal(v.standards.coach_ratio, 10);
  const bad = (patch) => api('POST', `/academy/methodologies/${m.id}/versions`, { token: a.owner.token, body: { row_version: m.row_version, ...LIB, ...patch } });
  assert.equal((await bad({ competencies: [{ ...LIB.competencies[0], proficiency: [{ stage_key: 'ghost', descriptor: 'x1' }] }] })).status, 400);
  assert.equal((await bad({ outcomes: [{ competency_key: 'first_touch', stage_key: 'ghost', outcome: 'x1' }] })).status, 400);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/curricula`, { token: a.owner.token, body: { methodology_id: m.id, title: 'Bad stage', stage_key: 'ghost' } })).status, 400);
  const cur = ok(await api('POST', `/organisations/${a.org.id}/academy/curricula`, { token: a.owner.token, body: { methodology_id: m.id, title: 'Development stage', stage_key: 'development' } }), 201);
  assert.equal(cur.stage_key, 'development');
  const phases = [{ key: 'pre', title: 'Pre-season', starts_on: today, ends_on: addDays(today, 30), intensity: 'high', focus_keys: ['speed'] }, { key: 'in', title: 'In-season', starts_on: addDays(today, 31), ends_on: addDays(today, 120), intensity: 'medium' }];
  const noCrit = ok(await api('POST', `/academy/curricula/${cur.id}/versions`, { token: a.td.token, body: { objectives: [{ ...OBJ[0], success_criteria: undefined }], phases } }), 201);
  assert.equal(noCrit.phases.length, 2);
  assert.equal((await api('POST', `/academy/curricula/${cur.id}/versions`, { token: a.td.token, body: { objectives: OBJ, phases: [{ ...phases[0], focus_keys: ['ghost'] }] } })).status, 400);
  assert.equal((await api('POST', `/academy/curricula/${cur.id}/versions`, { token: a.td.token, body: { objectives: OBJ, phases: [phases[0], phases[0]] } })).status, 400, 'duplicate phase keys');
  // readiness: blockers stop submission
  const r1 = ok(await api('GET', `/academy/curriculum-versions/${noCrit.id}/readiness`, { token: a.td.token }));
  assert.equal(r1.readiness.ready, false); assert.ok(r1.readiness.blockers.some((b) => b.code === 'no_success_criteria'));
  const blocked = await api('POST', `/academy/curriculum-versions/${noCrit.id}/submit`, { token: a.td.token });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error.details.code, 'not_ready');
  // overlapping phases and an unknown phase on an objective are blockers too
  ok(await api('POST', `/academy/curricula/${cur.id}/versions`, { token: a.td.token, body: { objectives: [{ ...OBJ[0], phase_keys: ['ghost'] }], phases: [phases[0], { ...phases[1], key: 'late', starts_on: addDays(today, 10) }] } }), 201);
  const r2 = ok(await api('GET', `/academy/curriculum-versions/${noCrit.id}/readiness`, { token: a.td.token }));
  assert.ok(r2.readiness.blockers.some((b) => b.code === 'unknown_phase') && r2.readiness.blockers.some((b) => b.code === 'phase_overlap'));
  // a clean draft: warnings travel but do not block
  ok(await api('POST', `/academy/curricula/${cur.id}/versions`, { token: a.td.token, body: { objectives: [{ ...OBJ[0], phase_keys: ['pre'], guardian_summary: undefined, drill_keys: [] }], phases } }), 201);
  const r3 = ok(await api('GET', `/academy/curriculum-versions/${noCrit.id}/readiness`, { token: a.td.token }));
  assert.equal(r3.readiness.ready, true);
  assert.ok(r3.readiness.warnings.some((w) => w.code === 'pillar_missing') && r3.readiness.warnings.some((w) => w.code === 'no_drills') && r3.readiness.warnings.some((w) => w.code === 'no_family_line'));
  const sub = ok(await api('POST', `/academy/curriculum-versions/${noCrit.id}/submit`, { token: a.td.token }));
  assert.ok(sub.warnings.length >= 3);
  assert.equal((await api('GET', `/academy/curriculum-versions/${noCrit.id}/readiness`, { token: a.coach.token })).status, 404, 'a coach cannot read approval material');
  ok(await api('POST', `/academy/curriculum-versions/${noCrit.id}/decision`, { token: a.owner.token, body: { decision: 'approve' } }));
  ok(await api('POST', `/academy/curriculum-versions/${noCrit.id}/publish`, { token: a.owner.token }));
  // version 2: the diff names exactly what changed
  const v2 = ok(await api('POST', `/academy/curricula/${cur.id}/versions`, { token: a.td.token, body: { objectives: [{ ...OBJ[0], phase_keys: ['pre'], success_criteria: '9 of 10 receptions controlled', drill_keys: ['rondo'] }, OBJ[1]], phases } }), 201);
  const d = ok(await api('GET', `/academy/curriculum-versions/${v2.id}/readiness`, { token: a.td.token }));
  assert.equal(d.against, 1); assert.deepEqual(d.diff.added.map((x) => x.key), ['speed_u12']);
  const ch = d.diff.changed.find((x) => x.key === 'touch_u12');
  assert.ok(ch.fields.includes('success_criteria') && ch.fields.includes('drill_keys'));
  assert.equal(ch.after.success_criteria, '9 of 10 receptions controlled');
  // detail returns the open version's review for the approver
  const det = ok(await api('GET', `/academy/curricula/${cur.id}`, { token: a.owner.token }));
  assert.equal(det.open_review.against, 1);
  // delivery analytics after a recorded session
  ok(await api('POST', `/academy/curriculum-versions/${v2.id}/submit`, { token: a.td.token }));
  ok(await api('POST', `/academy/curriculum-versions/${v2.id}/decision`, { token: a.owner.token, body: { decision: 'approve' } }));
  ok(await api('POST', `/academy/curriculum-versions/${v2.id}/publish`, { token: a.owner.token, body: { effective_from: addDays(today, 1) } }));
  ok(await api('POST', `/academy/curricula/${cur.id}/assignments`, { token: a.owner.token, body: { cohort_id: a.cohort.id, coach_id: a.coach.id } }), 201);
  await startSession(a.sessions[0]);
  ok(await api('POST', `/academy/sessions/${a.sessions[0]}/objectives`, { token: a.coach.token, body: { add_keys: ['touch_u12'] } }), 201);
  ok(await api('POST', `/academy/sessions/${a.sessions[0]}/objectives/touch_u12/outcome`, { token: a.coach.token, body: { outcome: 'delivered', evidence_note: 'Ran it as planned' } }));
  const cov = ok(await api('GET', `/organisations/${a.org.id}/academy/curriculum-coverage`, { token: a.td.token }));
  assert.ok(cov.by_pillar.length >= 1 && cov.analytics.trend.length === 1 && cov.analytics.trend[0].delivered === 1);
  assert.equal(cov.analytics.coaches[0].attested, 1); assert.equal(cov.analytics.drills.length, 0);
  assert.equal(cov.items[0].objectives[0].priority, 'core');
});

test('forward planner, acknowledgement, feedback loop, rollover and export', async () => {
  const a = await academy();
  const { m } = await methodology(a);
  const phases = [{ key: 'pre', title: 'Pre-season', starts_on: today, ends_on: addDays(today, 60), intensity: 'high', focus_keys: ['speed'] }];
  const objs = [{ ...OBJ[0], phase_keys: ['pre'] }, { ...OBJ[1], phase_keys: ['pre'], priority: 'support' }, { key: 'resil', title: 'Reset after errors', competency_key: 'resilience', success_criteria: 'Back in shape in five seconds', priority: 'stretch', phase_keys: ['nope'] }];
  const cur = ok(await api('POST', `/organisations/${a.org.id}/academy/curricula`, { token: a.owner.token, body: { methodology_id: m.id, title: 'Planner curriculum' } }), 201);
  const d = ok(await api('POST', `/academy/curricula/${cur.id}/versions`, { token: a.td.token, body: { objectives: objs.slice(0, 2), phases } }), 201);
  ok(await api('POST', `/academy/curriculum-versions/${d.id}/submit`, { token: a.td.token }));
  ok(await api('POST', `/academy/curriculum-versions/${d.id}/decision`, { token: a.owner.token, body: { decision: 'approve' } }));
  ok(await api('POST', `/academy/curriculum-versions/${d.id}/publish`, { token: a.owner.token }));
  assert.equal((await pool.query("SELECT 1 FROM notifications WHERE kind='academy_curriculum_published' AND data->>'curriculum_id'=$1", [cur.id])).rowCount, 0, 'nobody assigned yet, nobody told');
  ok(await api('POST', `/academy/curricula/${cur.id}/assignments`, { token: a.td.token, body: { cohort_id: a.cohort.id, coach_id: a.coach.id } }), 201);

  // acknowledgement: only the assigned coach, idempotent, visible to the TD
  const det0 = ok(await api('GET', `/academy/curricula/${cur.id}`, { token: a.coach.token }));
  assert.equal(det0.needs_ack, true);
  assert.equal((await api('POST', `/academy/curriculum-versions/${d.id}/acknowledge`, { token: a.coach2.token })).status, 404);
  ok(await api('POST', `/academy/curriculum-versions/${d.id}/acknowledge`, { token: a.coach.token }), 201);
  ok(await api('POST', `/academy/curriculum-versions/${d.id}/acknowledge`, { token: a.coach.token }), 201);
  assert.equal(ok(await api('GET', `/academy/curricula/${cur.id}`, { token: a.coach.token })).needs_ack, false);
  assert.equal(ok(await api('GET', `/academy/curricula/${cur.id}`, { token: a.td.token })).assignments[0].acknowledged, true);

  // planner: suggestions follow the phase, priority and sessions target; nothing is written until applied
  const plan = ok(await api('GET', `/organisations/${a.org.id}/academy/cohorts/${a.cohort.id}/objective-plan`, { token: a.coach.token, query: { weeks: '4', per_session: '2' } }));
  assert.ok(plan.sessions.length >= 1);
  const first = plan.sessions[0];
  assert.equal(first.phase.key, 'pre'); assert.deepEqual(first.suggestions.map((x) => x.key), ['speed_u12', 'touch_u12'], 'the phase focus (speed) outranks a core objective with one session left');
  assert.ok(first.suggestions[0].reasons.includes('phase_focus') && first.suggestions[1].reasons.includes('core'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_session_objectives WHERE session_id = ANY($1)', [a.sessions])).rows[0].n, 0);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/cohorts/${a.cohort.id}/objective-plan`, { token: a.coach2.token })).status, 404, 'not their group');
  const applied = ok(await api('POST', `/organisations/${a.org.id}/academy/cohorts/${a.cohort.id}/objective-plan`, { token: a.coach.token, body: { items: plan.sessions.slice(0, 2).map((s) => ({ session_id: s.session_id, keys: s.suggestions.map((x) => x.key) })) } }), 201);
  assert.equal(applied.applied, 2);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/cohorts/${a.cohort.id}/objective-plan`, { token: a.coach.token, body: { items: [{ session_id: plan.sessions[0].session_id, keys: ['ghost'] }] } })).status, 400);
  // atomic: a bad item rolls the whole plan back
  const before = (await pool.query('SELECT count(*)::int AS n FROM academy_session_objectives')).rows[0].n;
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/cohorts/${a.cohort.id}/objective-plan`, { token: a.coach.token, body: { items: [{ session_id: plan.sessions[2]?.session_id ?? plan.sessions[0].session_id, keys: ['speed_u12'] }, { session_id: plan.sessions[0].session_id, keys: ['ghost'] }] } })).status, 400);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_session_objectives')).rows[0].n, before);
  const again = ok(await api('GET', `/organisations/${a.org.id}/academy/cohorts/${a.cohort.id}/objective-plan`, { token: a.coach.token }));
  assert.deepEqual(again.sessions[0].already.sort(), applied.sessions.length ? again.sessions[0].already.sort() : []);
  assert.ok(again.sessions[0].already.length >= 1, 'already-mapped objectives are not suggested twice');

  // feedback loop
  const fb = ok(await api('POST', `/academy/curricula/${cur.id}/feedback`, { token: a.coach.token, body: { objective_key: 'speed_u12', kind: 'too_hard', note: 'Eight reps is too many for this age' } }), 201);
  assert.equal((await api('POST', `/academy/curricula/${cur.id}/feedback`, { token: a.coach.token, body: { objective_key: 'ghost', kind: 'unclear', note: 'x1' } })).status, 400);
  assert.equal((await api('POST', `/academy/curricula/${cur.id}/feedback`, { token: a.coach2.token, body: { kind: 'other', note: 'not mine' } })).status, 404);
  assert.equal(ok(await api('GET', `/organisations/${a.org.id}/academy/curriculum-feedback`, { token: a.coach.token })).length, 1);
  assert.equal(ok(await api('GET', `/organisations/${a.org.id}/academy/curriculum-feedback`, { token: a.coach2.token })).length, 0);
  assert.equal(ok(await api('GET', `/organisations/${a.org.id}/academy/curriculum-feedback`, { token: a.td.token, query: { status: 'open' } })).length, 1);
  assert.equal((await api('POST', `/academy/curriculum-feedback/${fb.id}/resolve`, { token: a.coach.token, body: { status: 'accepted' } })).status, 403);
  assert.equal((await api('POST', `/academy/curriculum-feedback/${fb.id}/resolve`, { token: a.td.token, body: { status: 'declined' } })).status, 400);
  assert.equal(ok(await api('POST', `/academy/curriculum-feedback/${fb.id}/resolve`, { token: a.td.token, body: { status: 'accepted', note: 'Will cut to six reps' } })).status, 'accepted');
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='academy_curriculum_feedback'", [a.coach.id])).rowCount >= 1);

  // a published version notifies the assigned coach
  const v2 = ok(await api('POST', `/academy/curricula/${cur.id}/versions`, { token: a.td.token, body: { objectives: objs.slice(0, 2).map((o) => (o.key === 'speed_u12' ? { ...o, success_criteria: 'Sprint decrement under 6% across six reps' } : o)), phases } }), 201);
  ok(await api('POST', `/academy/curriculum-versions/${v2.id}/submit`, { token: a.td.token }));
  ok(await api('POST', `/academy/curriculum-versions/${v2.id}/decision`, { token: a.owner.token, body: { decision: 'approve' } }));
  ok(await api('POST', `/academy/curriculum-versions/${v2.id}/publish`, { token: a.owner.token, body: { effective_from: addDays(today, 1) } }));
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='academy_curriculum_published'", [a.coach.id])).rowCount >= 1);

  // rollover into a new draft; the source is untouched; assignments are not copied
  const ro = ok(await api('POST', `/academy/curricula/${cur.id}/rollover`, { token: a.td.token, body: { title: 'Planner curriculum 2027', shift_days: 365 } }), 201);
  assert.equal(ro.version.status, 'draft'); assert.equal(ro.version.version, 1); assert.equal(ro.version.objectives.length, 2);
  assert.equal(String(ro.version.phases[0].starts_on), addDays(today, 365));
  assert.equal(ok(await api('GET', `/academy/curricula/${ro.curriculum.id}`, { token: a.td.token })).assignments.length, 0);
  assert.equal((await api('POST', `/academy/curricula/${cur.id}/rollover`, { token: a.coach.token, body: { title: 'Nope' } })).status, 403);
  assert.equal(ok(await api('GET', `/academy/curricula/${cur.id}`, { token: a.owner.token })).versions.length, 2);

  // export
  const ex = ok(await api('GET', `/organisations/${a.org.id}/academy/curriculum-coverage/export`, { token: a.td.token }));
  assert.match(ex.filename, /^curriculum-coverage-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.ok(ex.csv.split('\n')[0].startsWith('group,curriculum,version,pillar')); assert.ok(ex.csv.split('\n').length >= 3);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/curriculum-coverage/export`, { token: a.finance.token })).status, 403);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='export_academy_curriculum_coverage'")).rowCount === 1);
});
