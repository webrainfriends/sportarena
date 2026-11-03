import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `cl_${n}_${roles[0]}`, display_name: `Cl ${n}`, email: `cl${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('the feedback overview is for coaches only', async () => {
  const athlete = await signup(['athlete']);
  assert.equal((await api('GET', '/coach/feedback-overview')).status, 401);
  assert.equal((await api('GET', '/coach/feedback-overview', { token: athlete.token })).status, 403);
});

test('a new coach sees an honest empty overview, not made-up numbers', async () => {
  const coach = await signup(['coach']);
  const r = await api('GET', '/coach/feedback-overview', { token: coach.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.evaluations, { draft: 0, shared: 0, responded: 0, closed: 0, total: 0, last_90_days: 0, waiting_on_me: [] });
  assert.equal(r.body.session_feedback.owed, 0);
  assert.deepEqual(r.body.reviews, { average: null, count: 0, recent: [] });
  assert.deepEqual(r.body.trend, { evaluations: [], rating: [] });
});

const ok = (r, st = 200) => { assert.equal(r.status, st, JSON.stringify(r.body)); return r.body; };

test("a coach's evaluations show in their overview and never in another coach's", async () => {
  const coach = await signup(['coach']);
  ok(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 70000 } }), 201);
  const other = await signup(['coach']);
  const sheet = ok(await api('POST', '/coaching/rubrics', { token: coach.token, body: { name: 'Landing sheet', sport: 'football', dimensions: [{ key: 'scanning', name: 'Scanning', pillar: 'tactical', weight: 1, scale_min: 1, scale_max: 5 }] } }), 201);
  const athlete = await signup(['athlete']);
  // a coaching relationship is required before a coach may evaluate: the athlete joins the coach's class
  const card = ok(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Group clinic', sport: 'football', audience: 'group', delivery: 'both', unit: 'session', duration_min: 60, price_cents: 0, per_person: true, min_participants: 1, max_participants: 10 } }), 201);
  const k = ok(await api('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: card.id, starts_at: new Date(Date.now() + 3 * 864e5).toISOString(), online_url: 'https://meet.example.com/x', max_participants: 6 } }), 201);
  ok(await api('POST', `/coach/classes/${k.id}/join`, { token: athlete.token, body: {} }), 201);
  const ev = await api('POST', '/coaching/evaluations', { token: coach.token, body: { athlete_id: athlete.id, rubric_id: sheet.rubric_id ?? sheet.id } });
  assert.equal(ev.status, 201, JSON.stringify(ev.body));
  const mine = ok(await api('GET', '/coach/feedback-overview', { token: coach.token }));
  assert.equal(mine.evaluations.draft, 1);
  assert.equal(mine.evaluations.waiting_on_me[0].athlete_name, athlete.display_name);
  assert.equal(ok(await api('GET', '/coach/feedback-overview', { token: other.token })).evaluations.total, 0);
});

test('the athlete workspace is unchanged: same tiles, same actions, none of the coach cards', async () => {
  const u = await signup(['athlete', 'coach']);
  const r = await api('GET', '/me/role-workspace?role=athlete', { token: u.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.role, 'athlete');
  assert.deepEqual(r.body.summary.map((s) => s.key), ['selections', 'upcoming', 'passes']);
  assert.deepEqual(r.body.actions.map((a) => a.key), ['availability', 'pass', 'log', 'find']);
  assert.ok(!r.body.work.some((w) => ['insurance', 'evaluation_reply', 'session_feedback'].includes(w.kind)));
});

test('the coach workspace carries the new metrics and keeps the existing actions', async () => {
  const u = await signup(['athlete', 'coach']);
  const r = await api('GET', '/me/role-workspace?role=coach', { token: u.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.role, 'coach');
  assert.deepEqual(r.body.summary.map((s) => s.key), ['athletes', 'requests', 'revisions', 'appointments', 'evaluations', 'rating', 'cover']);
  assert.equal(r.body.summary.find((s) => s.key === 'rating').value, '–', 'no reviews yet shows a dash, not a number');
  assert.ok(['attendance', 'calendar', 'athletes', 'requests'].every((k) => r.body.actions.some((a) => a.key === k)));
  assert.deepEqual(r.body.unavailable ?? [], []);
});
