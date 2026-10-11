import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { readiness, workload } = await import('../src/readiness.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async () => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `wl_${n}`, display_name: `Wl ${n}`, email: `wl${n}@example.com`, password: 'correct-horse-battery', roles: ['athlete'] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const day = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('readiness maths: weights renormalise, pain stands in for soreness, workload takes points off', () => {
  assert.equal(readiness({}).score, null);
  assert.equal(readiness({ wellness: { sleep_hours: 8, sleep_quality: 5, soreness: 0, mood: 5 } }).score, 100);
  assert.equal(readiness({ wellness: { sleep_hours: 4 } }).score, 50, 'only sleep logged: scored on sleep alone');
  assert.equal(readiness({ pain: [{ severity: 8 }] }).score, 20, 'open pain counts as soreness');
  assert.equal(readiness({ wellness: { soreness: 2 }, pain: [{ severity: 9 }] }).score, 80, 'what you logged today wins');
  const full = { sleep_hours: 8, sleep_quality: 5, soreness: 0, mood: 5 };
  assert.equal(readiness({ wellness: full, acwr: { ratio: 1.6 } }).score, 90);
  assert.equal(readiness({ wellness: full, acwr: { ratio: 1.4 } }).score, 95);
  assert.equal(readiness({ wellness: { soreness: 10 } }).band, 'rest');
  assert.equal(readiness({ wellness: { sleep_hours: 5 } }).band, 'moderate');
  assert.equal(readiness({ wellness: { sleep_hours: 6 } }).band, 'ready');
});

test('workload maths: building until three weeks of logs, then bands', () => {
  const mk = (days, f) => Array.from({ length: days }, (_, i) => ({ session_date: day(-i), load: f(i) }));
  assert.equal(workload([], day()).status, 'no_data');
  assert.equal(workload(mk(5, () => 300), day()).status, 'building');
  const steady = workload(mk(28, () => 300), day());
  assert.equal(steady.ratio, 1); assert.equal(steady.status, 'optimal');
  const spike = workload(mk(28, (i) => (i < 7 ? 600 : 300)), day());
  assert.equal(spike.status, 'high'); assert.equal(spike.ratio, 1.6);
  const rest = workload(mk(28, (i) => (i < 7 ? 100 : 400)), day());
  assert.equal(rest.status, 'low');
  assert.equal(spike.weeks.length, 8); assert.equal(spike.weeks.at(-1).week_ending, day()); assert.equal(spike.weeks.at(-1).load, 4200);
});

test('daily log: upsert merges, water adds up, notes are encrypted and audited, and it is private', async () => {
  const a = await signup(), b = await signup();
  assert.equal((await api('POST', '/me/wellness', { body: { mood: 3 } })).status, 401);
  assert.equal((await api('POST', '/me/wellness', { token: a.token, body: {} })).status, 400, 'log something');
  assert.equal((await api('POST', '/me/wellness', { token: a.token, body: { mood: 9 } })).status, 400);
  assert.equal((await api('POST', '/me/wellness', { token: a.token, body: { mood: 3, date: day(5) } })).status, 400, 'not the future');

  const first = await api('POST', '/me/wellness', { token: a.token, body: { sleep_hours: 7.5, sleep_quality: 4, water_add_ml: 250 } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await api('POST', '/me/wellness', { token: a.token, body: { soreness: 3, mood: 4, water_add_ml: 500, note: 'Tight left calf after sprints' } });
  assert.equal(second.body.id, first.body.id, 'one row per day');
  assert.equal(Number(second.body.sleep_hours), 7.5, 'earlier values kept'); assert.equal(second.body.soreness, 3); assert.equal(second.body.water_ml, 750); assert.equal(second.body.has_note, true);
  assert.equal(JSON.stringify(second.body).includes('calf'), false, 'the note is not echoed back');
  assert.equal((await api('POST', '/me/wellness', { token: a.token, body: { water_ml: 2000 } })).body.water_ml, 2000, 'water_ml sets the total');

  const raw = (await pool.query('SELECT note_enc FROM wellness_logs WHERE id=$1', [first.body.id])).rows[0].note_enc;
  assert.match(raw, /^v1\./); assert.ok(!raw.includes('calf'));
  const before = (await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE actor_id=$1 AND action='read_wellness'", [a.id])).rows[0].n;
  const list = await api('GET', '/me/wellness', { token: a.token });
  assert.equal(list.body[0].note, 'Tight left calf after sprints');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE actor_id=$1 AND action='read_wellness'", [a.id])).rows[0].n, before + 1, 'reading a note is audit-logged');
  assert.deepEqual((await api('GET', '/me/wellness', { token: b.token })).body, [], 'nobody else sees it');
});

test('body map: readings keep history, current is the latest open, resolving closes it, notes encrypted', async () => {
  const a = await signup(), b = await signup();
  assert.equal((await api('POST', '/me/body-pain', { token: a.token, body: { region: 'elbow_x', severity: 5 } })).status, 400);
  assert.equal((await api('POST', '/me/body-pain', { token: a.token, body: { region: 'knee', severity: 11 } })).status, 400);
  const r1 = (await api('POST', '/me/body-pain', { token: a.token, body: { region: 'knee', side: 'left', severity: 4, note: 'Clicks on stairs' } })).body;
  const r2 = (await api('POST', '/me/body-pain', { token: a.token, body: { region: 'knee', side: 'left', severity: 7 } })).body;
  await api('POST', '/me/body-pain', { token: a.token, body: { region: 'hamstring', side: 'right', kind: 'tightness', severity: 3 } });

  const open = (await api('GET', '/me/body-pain', { token: a.token })).body;
  assert.equal(open.length, 2);
  assert.equal(open.find((x) => x.region === 'knee').severity, 7, 'latest reading is the current state');
  assert.equal((await api('GET', '/me/body-pain?history=true', { token: a.token })).body.length, 3);
  assert.match((await pool.query('SELECT note_enc FROM body_pain_logs WHERE id=$1', [r1.id])).rows[0].note_enc, /^v1\./);
  assert.equal((await api('GET', '/me/body-pain?history=true', { token: a.token })).body.find((x) => x.id === r1.id).note, 'Clicks on stairs');

  assert.equal((await api('POST', `/me/body-pain/${r2.id}/resolve`, { token: b.token })).status, 404, 'not yours');
  assert.equal((await api('POST', `/me/body-pain/${r2.id}/resolve`, { token: a.token })).body.resolved, 2, 'closes every open reading for the knee');
  const after = (await api('GET', '/me/body-pain', { token: a.token })).body;
  assert.deepEqual(after.map((x) => x.region), ['hamstring']);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM body_pain_logs WHERE user_id=$1', [a.id])).rows[0].n, 3, 'nothing deleted');
});

test('workload and readiness through the API', async () => {
  const a = await signup(), b = await signup();
  assert.equal((await api('GET', '/me/readiness', { token: a.token })).body.score, null, 'nothing logged yet');
  assert.equal((await api('GET', '/me/workload', { token: a.token })).body.status, 'no_data');
  assert.equal((await api('POST', '/me/loads', { token: a.token, body: { minutes: 0, rpe: 5 } })).status, 400);
  assert.equal((await api('POST', '/me/loads', { token: a.token, body: { minutes: 60, rpe: 11 } })).status, 400);

  for (let i = 0; i < 28; i++) {
    const r = await api('POST', '/me/loads', { token: a.token, body: { date: day(-i), kind: i % 5 === 0 ? 'match' : 'training', minutes: i < 7 ? 100 : 50, rpe: 6 } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    if (i === 0) assert.equal(r.body.load, 600, 'load = minutes x RPE');
  }
  const w = (await api('GET', '/me/workload', { token: a.token })).body;
  assert.equal(w.status, 'high'); assert.equal(w.acute, 4200); assert.ok(w.ratio > 1.5);

  await api('POST', '/me/wellness', { token: a.token, body: { sleep_hours: 8, sleep_quality: 5, soreness: 0, mood: 5 } });
  const r = (await api('GET', '/me/readiness', { token: a.token })).body;
  assert.equal(r.score, 90, 'a perfect day, minus 10 for a spiking workload');
  assert.equal(r.band, 'ready'); assert.equal(r.workload.status, 'high');

  await api('POST', '/me/body-pain', { token: a.token, body: { region: 'ankle', severity: 8 } });
  await api('POST', '/me/wellness', { token: a.token, body: { soreness: 8 } });
  assert.equal((await api('GET', '/me/readiness', { token: a.token })).body.open_pain, 1);

  // archive: removed from the numbers, kept in the table; others cannot touch it
  const loads = (await api('GET', '/me/loads', { token: a.token })).body;
  assert.equal(loads.length, 28);
  assert.equal((await api('POST', `/me/loads/${loads[0].id}/archive`, { token: b.token })).status, 404);
  assert.equal((await api('POST', `/me/loads/${loads[0].id}/archive`, { token: a.token })).status, 200);
  assert.equal((await api('POST', `/me/loads/${loads[0].id}/archive`, { token: a.token })).status, 404);
  assert.equal((await api('GET', '/me/loads', { token: a.token })).body.length, 27);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM session_loads WHERE user_id=$1', [a.id])).rows[0].n, 28);
  assert.deepEqual((await api('GET', '/me/loads', { token: b.token })).body, []);
});
