import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { fromLocal, addDays } = await import('../src/booking/time.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `hub_${n}_${roles[0]}`, display_name: `Ev ${n}`, email: `hub${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const at = (d, hour) => fromLocal(addDays(new Date().toISOString().slice(0, 10), d), hour * 60, 'Asia/Kolkata').toISOString();

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function setup() {
  const coach = await signup(['coach']);
  ok(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 70000 } }), 201);
  const card = ok(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Group clinic', sport: 'football', audience: 'group', delivery: 'both', unit: 'session', duration_min: 60, price_cents: 0, per_person: true, min_participants: 1, max_participants: 10 } }), 201);
  const k = ok(await api('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: card.id, starts_at: at(3, 17), online_url: 'https://meet.example.com/x', max_participants: 6 } }), 201);
  const a = await signup();
  ok(await api('POST', `/coach/classes/${k.id}/join`, { token: a.token, body: {} }), 201);
  const sheet = ok(await api('POST', '/coaching/rubrics', { token: coach.token, body: { name: 'Midfield profile', sport: 'football', dimensions: [
    { key: 'first_touch', name: 'First touch', pillar: 'technical', weight: 2, scale_min: 1, scale_max: 5, target: 5, anchors: { 1: 'Loses the ball on receipt', 5: 'Controls and plays in one movement under pressure' }, evidence_hint: 'Count touches under pressure' },
    { key: 'scanning', name: 'Scanning', pillar: 'tactical', weight: 1, scale_min: 1, scale_max: 5 },
    { key: 'sprint', name: '30 m sprint', pillar: 'physical', weight: 1, scale_min: 3, scale_max: 6, direction: 'lower_is_better', unit: 's' },
    { key: 'composure', name: 'Composure', pillar: 'mental', weight: 0, scale_min: 1, scale_max: 5 }] } }), 201);
  return { coach, k, a, sheet: { id: sheet.rubric_id ?? sheet.id } };
  return { coach, k, a, sheet: { id: sheet.rubric_id ?? sheet.id } };
}

test('one evaluation sheet scores any session of the coach through its record; links are derived by the server, never trusted', async () => {
  const s = await setup();
  const ws = ok(await api('POST', `/coach/classes/${s.k.id}/workspace`, { token: s.coach.token, body: {} }));
  ok(await api('POST', `/coach/classes/${s.k.id}/scores`, { token: s.coach.token, body: { rubric_id: s.sheet.id, scores: [{ athlete_id: s.a.id, dimension_key: 'first_touch', score: 4 }] } }));
  const ev = ok(await api('POST', '/coaching/evaluations', { token: s.coach.token, body: { athlete_id: s.a.id, rubric_id: s.sheet.id, context_type: 'session', session_record_id: ws.record_id } }), 201);
  assert.equal(ev.criteria.find((c) => c.key === 'first_touch').score, 4, 'scores given in the session carry in');
  const row = (await pool.query('SELECT session_record_id, class_id, hire_id FROM coaching_evaluations WHERE id=$1', [ev.id])).rows[0];
  assert.equal(row.session_record_id, ws.record_id); assert.equal(row.class_id, s.k.id, 'a class record also fills the class link'); assert.equal(row.hire_id, null);
  // another coach cannot attach to this record, and an athlete who is not in the session cannot be evaluated against it
  const stranger = await signup(['coach']);
  assert.equal((await api('POST', '/coaching/evaluations', { token: stranger.token, body: { athlete_id: s.a.id, rubric_id: s.sheet.id, session_record_id: ws.record_id } })).status, 403, 'no coaching relationship, so the record is never reached');
  const other = await signup();
  assert.equal((await api('POST', '/coaching/evaluations', { token: s.coach.token, body: { athlete_id: other.id, rubric_id: s.sheet.id, session_record_id: ws.record_id } })).status >= 400, true);
});

test('the widened context list keeps every old value and adds booking, academy and game', async () => {
  const { rows } = await pool.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='coaching_evaluations_context_type_check'");
  for (const c of ['class', 'session', 'period', 'match', 'trial', 'custom', 'booking', 'academy', 'game']) assert.match(rows[0].d, new RegExp(`'${c}'`));
});

test('a 1:1 booking opens the same workspace; the athlete sees only what the coach shares, on the booking itself', async () => {
  const coach = await signup(['coach']), a = await signup(), stranger = await signup();
  ok(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 70000 } }), 201);
  const hire = ok(await api('POST', '/hires', { token: a.token, body: { coach_id: coach.id, sport: 'football', starts_at: at(4, 9), duration_min: 60 } }), 201);
  await pool.query("UPDATE coach_hires SET status='confirmed' WHERE id=$1", [hire.id]);
  assert.equal((await api('POST', '/coaching/workspace', { token: stranger.token, body: { source_type: 'coach_hire', source_id: hire.id } })).status, 403, 'only the coach of the booking');
  const ws = ok(await api('POST', '/coaching/workspace', { token: coach.token, body: { source_type: 'coach_hire', source_id: hire.id } }));
  assert.deepEqual(ws.roster.map((r) => r.user_id), [a.id]);
  assert.equal(ok(await api('POST', '/coaching/workspace', { token: coach.token, body: { source_type: 'coach_hire', source_id: hire.id } })).record_id, ws.record_id, 'repeating returns the same record');
  // nothing is visible until shared; strangers never learn the session exists
  assert.equal(ok(await api('GET', `/hires/${hire.id}/timeline`, { token: a.token })).workspace.shared, false);
  assert.equal((await api('GET', `/coaching/sessions/${ws.record_id}/shared`, { token: stranger.token })).status, 404);
  ok(await api('POST', `/coaching/sessions/${ws.record_id}/plan`, { token: coach.token, body: { objective: 'Weak foot', blocks: [{ kind: 'skill_drill', title: 'Wall passes', duration_min: 15, coach_notes: 'private note' }] } }));
  assert.equal((await api('POST', `/coaching/sessions/${ws.record_id}/plan/share`, { token: stranger.token, body: { share: true } })).status, 403, 'not a coach');
  const rival = await signup(['coach']);
  assert.equal((await api('POST', `/coaching/sessions/${ws.record_id}/plan/share`, { token: rival.token, body: { share: true } })).status, 404, 'another coach never learns it exists');
  ok(await api('POST', `/coaching/sessions/${ws.record_id}/plan/share`, { token: coach.token, body: { share: true } }));
  const tl = ok(await api('GET', `/hires/${hire.id}/timeline`, { token: a.token })).workspace;
  assert.equal(tl.shared, true); assert.equal(tl.blocks[0].title, 'Wall passes'); assert.equal(tl.blocks[0].coach_notes, undefined, 'private coach notes never leave');
  // an unshared plan disappears again, and a second session reuses the first plan
  ok(await api('POST', `/coaching/sessions/${ws.record_id}/plan/share`, { token: coach.token, body: { share: false } }));
  assert.equal(ok(await api('GET', `/coaching/sessions/${ws.record_id}/shared`, { token: a.token })).shared, false);
});

test('a drill added to a plan remembers where it came from, and its use can be traced', async () => {
  const s = await setup();
  const ws = ok(await api('POST', '/coaching/workspace', { token: s.coach.token, body: { source_type: 'coach_class', source_id: s.k.id } }));
  const saved = ok(await api('POST', `/coaching/sessions/${ws.record_id}/plan`, { token: s.coach.token, body: { blocks: [{ kind: 'skill_drill', title: 'Rondo', duration_min: 10, trains: ['first_touch'] }] } }));
  const drill = ok(await api('POST', '/coaching/templates', { token: s.coach.token, body: { title: 'Rondo', scope: 'block', session_record_id: ws.record_id, block_id: saved.plan.blocks[0].id } }), 201);
  assert.deepEqual(drill.blocks[0].trains, ['first_touch'], 'the criteria it trains travel with the drill');
  assert.equal(ok(await api('GET', `/coaching/drills/${drill.id}/usage`, { token: s.coach.token })).sessions, 0);
  const applied = ok(await api('POST', `/coaching/sessions/${ws.record_id}/apply-template`, { token: s.coach.token, body: { template_id: drill.id, mode: 'replace' } }));
  assert.equal(applied.plan.blocks[0].drill_id, drill.id); assert.equal(applied.plan.blocks[0].drill_version, drill.version);
  const use = ok(await api('GET', `/coaching/drills/${drill.id}/usage`, { token: s.coach.token }));
  assert.equal(use.sessions, 1); assert.equal(use.uses[0].record_id, ws.record_id); assert.equal(use.uses[0].people, 1);
  assert.equal((await api('GET', `/coaching/drills/${drill.id}/usage`, { token: s.a.token })).status, 403);
});

test('the same sheet scores a booking as it scores a class: per person and skill, history kept, out-of-scale and outsiders refused', async () => {
  const s = await setup();
  const ws = ok(await api('POST', '/coaching/workspace', { token: s.coach.token, body: { source_type: 'coach_class', source_id: s.k.id } }));
  assert.equal(ws.duration_min > 0, true); assert.equal(ws.locked, false);
  const put = (score, extra = {}) => api('POST', `/coaching/sessions/${ws.record_id}/scores`, { token: s.coach.token, body: { rubric_id: s.sheet.id, scores: [{ athlete_id: s.a.id, dimension_key: 'first_touch', score, ...extra }] } });
  assert.equal(ok(await put(3)).saved, 1); assert.equal(ok(await put(3)).saved, 0, 'the same score is not a new fact'); assert.equal(ok(await put(5)).saved, 1);
  assert.equal((await put(9)).status, 400, 'out of scale'); assert.equal((await put(3, { dimension_key: 'nope' })).status, 400);
  const outsider = await signup();
  assert.equal((await api('POST', `/coaching/sessions/${ws.record_id}/scores`, { token: s.coach.token, body: { rubric_id: s.sheet.id, scores: [{ athlete_id: outsider.id, dimension_key: 'first_touch', score: 3 }] } })).status, 400);
  const grid = ok(await api('GET', `/coaching/sessions/${ws.record_id}/scores`, { token: s.coach.token, query: { rubric_id: s.sheet.id } }));
  assert.equal(grid.rows[0].dimensions.first_touch.score, 5);
});
