import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/capabilities/index.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `vs_${n}_${roles[0]}`, display_name: `Vs ${n}`, email: `vs${n}@example.com`, password: 'correct-horse-battery', roles } });
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

// an organiser, an official who is not the organiser, and athletes entered individually in a sprint meet
const meet = async (sport = 'athletics', athletes = 3) => {
  const org = await signup(['organizer']), other = await signup(['referee']), outsider = await signup(['athlete']);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `Meet ${++n}`, sport } })).body;
  await pool.query("INSERT INTO event_staff(event_id, user_id, role, status) VALUES ($1,$2,'timekeeper','accepted')", [ev.id, other.id]);
  const people = [];
  for (let k = 0; k < athletes; k++) {
    const a = await signup(['athlete']);
    await pool.query("INSERT INTO event_entries(event_id, user_id, status) VALUES ($1,$2,'accepted')", [ev.id, a.id]);
    people.push(a);
  }
  return { org, other, outsider, ev, people };
};
const submit = (t, who, body) => api('POST', '/performances', { token: t.org.token, body: { user_id: who.id, sport: 'athletics', metric: '100m_time_s', event_id: t.ev.id, ...body } });
const approve = (t, perf, by = t.other) => api('POST', `/performances/${perf.id}/approve`, { token: by.token });
// a second official: admin approves (the organiser submits)
const admin = async () => {
  const a = await signup(['athlete']);
  await pool.query("UPDATE users SET roles = roles || '{admin}' WHERE id=$1", [a.id]);
  return { ...a, roles: [...a.roles, 'admin'] }; // keep the registration token: roles are read live, and signing in would drop the label (the account is not on the platform-admin list)
};

test('self-reported practice, however high, never changes the official ranking', async () => {
  const t = await meet('basketball', 2);
  const [a, b] = t.people;
  const practice = await api('POST', '/performances', { token: a.token, body: { sport: 'basketball', metric: 'points', value: 1000, points: 99999999 } });
  assert.equal(practice.status, 201);
  assert.equal(practice.body.provenance, 'self_reported');
  assert.equal(practice.body.evidence_label, 'Self-reported practice');
  assert.equal((await api('GET', `/leaderboard?sport=basketball&event_id=${t.ev.id}`)).body.length, 0);
  const r = await api('POST', '/performances', { token: t.org.token, body: { user_id: b.id, sport: 'basketball', metric: 'points', value: 12, event_id: t.ev.id } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'submitted');
  assert.equal(r.body.official_points, 12);
  assert.equal((await approve(t, r.body)).status, 200);
  const lb = (await api('GET', `/leaderboard?sport=basketball`)).body;
  assert.deepEqual(lb.map((x) => x.id), [b.id], 'only the approved competition result is ranked');
  assert.equal(lb[0].evidence_label, 'Approved competition result');
  // stats: public sees official only; the athlete also sees labelled practice, never added to the official total
  const pub = (await api('GET', `/people/${a.id}/stats`)).body;
  assert.equal(pub.by_metric.length, 0);
  const mine = (await api('GET', `/people/${a.id}/stats`, { token: a.token })).body;
  assert.equal(mine.total_points, 0);
  assert.equal(mine.by_metric[0].evidence_label, 'Self-reported practice');
  assert.equal((await api('GET', '/performances', { token: b.token, body: undefined })).body.every((x) => x.user_id === b.id || x.status === 'approved'), true);
  const feed = (await api('GET', '/performances?user_id=' + a.id)).body;
  assert.equal(feed.length, 0, 'practice is private to the athlete');
});

test('timing events rank lower-is-better, with documented tie-breaks and shared ranks only when everything ties', async () => {
  const t = await meet('athletics', 4);
  const [a, b, c, d] = t.people;
  const results = [[a, 11.5, '2026-03-02'], [b, 10.9, '2026-03-05'], [c, 10.9, '2026-03-01'], [d, 12.2, '2026-03-01']];
  for (const [who, value, achieved_on] of results) {
    const r = await submit(t, who, { value, achieved_on });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.direction, 'lower');
    assert.equal((await approve(t, r.body)).status, 200);
  }
  const lb = (await api('GET', `/leaderboard?sport=athletics&metric=100m_time_s&event_id=${t.ev.id}`)).body;
  assert.deepEqual(lb.map((x) => x.id), [c.id, b.id, a.id, d.id], 'fastest first; equal times: the earlier achievement wins');
  assert.deepEqual(lb.map((x) => x.rank), [1, 2, 3, 4]);
  assert.equal(lb[0].ranking, 'lower_is_better');
  // paging is deterministic and keeps real ranks
  const p2 = (await api('GET', `/leaderboard?sport=athletics&metric=100m_time_s&event_id=${t.ev.id}&limit=2&offset=2`)).body;
  assert.deepEqual(p2.map((x) => [x.id, x.rank]), [[a.id, 3], [d.id, 4]]);
  // season filter
  assert.equal((await api('GET', `/leaderboard?sport=athletics&event_id=${t.ev.id}&season=2026`)).body.length, 4);
  assert.equal((await api('GET', `/leaderboard?sport=athletics&event_id=${t.ev.id}&season=2019`)).body.length, 0);
  assert.equal((await api('GET', `/leaderboard?sport=athletics&event_id=${t.ev.id}&category=no-such-category`)).body.length, 0);
  // identical on every tie-break shares a rank
  const e = await signup(['athlete']);
  await pool.query("INSERT INTO event_entries(event_id, user_id, status) VALUES ($1,$2,'accepted')", [t.ev.id, e.id]);
  const r = await submit(t, e, { value: 10.9, achieved_on: '2026-03-01' });
  await approve(t, r.body);
  const ranks = (await api('GET', `/leaderboard?sport=athletics&metric=100m_time_s&event_id=${t.ev.id}`)).body.map((x) => x.rank);
  assert.deepEqual(ranks, [1, 1, 3, 4, 5], 'two athletes equal on every tie-break share rank 1; the next is 3');
});

test('separation of duties and who may act', async () => {
  const t = await meet();
  const [a] = t.people;
  const r = (await submit(t, a, { value: 11 })).body;
  assert.equal((await approve(t, r, t.org)).status, 403, 'the submitter cannot approve');
  assert.equal((await approve(t, r, a)).status, 403, 'the athlete cannot approve');
  assert.equal((await approve(t, r, t.outsider)).status, 403, 'an unrelated person cannot approve');
  assert.equal((await api('POST', '/performances', { token: a.token, body: { sport: 'athletics', metric: '100m_time_s', value: 9, event_id: t.ev.id } })).status, 403, 'athletes cannot submit their own competition result');
  assert.equal((await api('POST', '/performances', { token: t.outsider.token, body: { user_id: a.id, sport: 'athletics', metric: '100m_time_s', value: 9, event_id: t.ev.id } })).status, 403);
  const adm = await admin();
  assert.equal((await approve(t, (await submit(t, t.people[1], { value: 12 })).body, t.other)).status, 200, 'an accepted timekeeper is a valid second official');
  assert.equal((await approve(t, r, adm)).status, 200, 'an admin can act as the second official');
  assert.equal((await approve(t, r, adm)).status, 409, 'already approved');
  const hist = (await api('GET', `/performances/${r.id}/history`, { token: a.token })).body;
  assert.deepEqual(hist.map((h) => h.action), ['submitted', 'approved']);
  assert.equal((await api('GET', `/performances/${r.id}/history`, { token: t.outsider.token })).status, 404);
});

test('invalid inputs are refused with a reason', async () => {
  const t = await meet();
  const [a] = t.people;
  const other = await meet();
  assert.equal((await submit(t, t.outsider, { value: 11 })).status, 422, 'not entered in the event');
  assert.equal((await submit(t, a, { value: -3 })).status, 422);
  assert.equal((await submit(t, a, { value: 0 })).status, 422, 'a time must be positive');
  assert.equal((await submit(t, a, { value: 999999 })).status, 422, 'out of range');
  assert.equal((await api('POST', '/performances', { token: t.org.token, body: { user_id: a.id, sport: 'basketball', metric: 'points', value: 3, event_id: t.ev.id } })).status, 422, 'wrong sport for the event');
  assert.equal((await api('POST', '/performances', { token: t.org.token, body: { user_id: a.id, sport: 'basketball', metric: 'points', value: 2.5, event_id: t.ev.id } })).status, 422);
  assert.equal((await submit(t, a, { value: 11, achieved_on: '2999-01-01' })).status, 422, 'not in the future');
  assert.equal((await api('POST', '/performances', { token: a.token, body: { sport: 'athletics', metric: 'steps', value: 5, imported: true } })).status, 422, 'imports need evidence');
  const imp = await api('POST', '/performances', { token: a.token, body: { sport: 'athletics', metric: '100m_time_s', value: 11.2, imported: true, evidence_ref: 'https://example.com/run/1' } });
  assert.equal(imp.status, 201);
  assert.equal(imp.body.evidence_label, 'Imported evidence');
  // fixture from another event
  const [b] = other.people;
  const org2 = other.org;
  const ev2 = other.ev;
  const fx = (await pool.query("INSERT INTO fixtures(event_id, scheduled_at) VALUES ($1, now()) RETURNING id", [ev2.id])).rows[0].id;
  assert.equal((await api('POST', '/performances', { token: t.org.token, body: { user_id: a.id, sport: 'athletics', metric: '100m_time_s', value: 11, event_id: t.ev.id, fixture_id: fx } })).status, 422, 'game belongs to a different event');
  assert.equal((await api('POST', '/performances', { token: org2.token, body: { user_id: b.id, sport: 'athletics', metric: '100m_time_s', value: 11, fixture_id: fx } })).status, 201);
});

test('corrections keep the evidence, update standings only once approved, and disputes pull a result out meanwhile', async () => {
  const t = await meet('athletics', 2);
  const [a, b] = t.people;
  const ra = (await submit(t, a, { value: 11 })).body, rb = (await submit(t, b, { value: 12 })).body;
  await approve(t, ra); await approve(t, rb);
  const board = async () => (await api('GET', `/leaderboard?sport=athletics&metric=100m_time_s&event_id=${t.ev.id}`)).body.map((x) => x.id);
  assert.deepEqual(await board(), [a.id, b.id]);
  // the athlete disputes: removed from standings until decided
  assert.equal((await api('POST', `/performances/${ra.id}/dispute`, { token: b.token, body: { reason: 'wrong lane recorded' } })).status, 403, 'only the athlete concerned or an official');
  assert.equal((await api('POST', `/performances/${ra.id}/dispute`, { token: a.token, body: { reason: 'timer started late, I ran 11.8' } })).status, 200);
  assert.deepEqual(await board(), [b.id]);
  // correction by the organiser; the old value is gone from standings only after approval
  const fix = await api('POST', `/performances/${ra.id}/correct`, { token: t.org.token, body: { value: 11.8, reason: 'photo finish review' } });
  assert.equal(fix.status, 201, JSON.stringify(fix.body));
  assert.equal(fix.body.supersedes_id, ra.id);
  assert.equal((await api('POST', `/performances/${ra.id}/correct`, { token: t.org.token, body: { value: 11.7, reason: 'second try' } })).status, 409, 'one pending correction at a time');
  assert.deepEqual(await board(), [b.id]);
  assert.equal((await approve(t, fix.body, t.org)).status, 403);
  assert.equal((await approve(t, fix.body)).status, 200);
  assert.deepEqual(await board(), [a.id, b.id], 'the corrected 11.8 still beats 12');
});

test('retries and double-clicks do not create duplicate results', async () => {
  const t = await meet('athletics', 1);
  const [a] = t.people;
  const body = { user_id: a.id, sport: 'athletics', metric: '100m_time_s', value: 11, event_id: t.ev.id, client_key: 'retry-key-0001' };
  const one = await api('POST', '/performances', { token: t.org.token, body });
  const two = await api('POST', '/performances', { token: t.org.token, body });
  assert.equal(one.body.id, two.body.id, 'same client_key returns the same result');
  // two different submissions at once for the same game/metric: exactly one wins
  const fx = (await pool.query("INSERT INTO fixtures(event_id, scheduled_at) VALUES ($1, now()) RETURNING id", [t.ev.id])).rows[0].id;
  const race = await Promise.all([1, 2, 3].map((k) => api('POST', '/performances', { token: t.org.token, body: { ...body, client_key: `race-key-000${k}`, fixture_id: fx, value: 10 + k, event_id: undefined } })));
  assert.deepEqual(race.map((r) => r.status).sort(), [201, 409, 409]);
});

test('results recorded before approvals existed are kept: organiser-recorded stay official, athlete-logged become practice', async () => {
  const t = await meet('athletics', 1);
  const [a] = t.people;
  const sport = (await pool.query("SELECT id FROM sports WHERE slug='athletics'")).rows[0].id;
  // a row as the old code wrote it, then the migration's backfill statements
  const mig = (await import('node:fs')).readFileSync(new URL('../migrations/038_verified_scoring.sql', import.meta.url), 'utf8');
  const legacy = (await pool.query("INSERT INTO performances(user_id, sport_id, event_id, metric, value, points, recorded_by) VALUES ($1,$2,$3,'long_jump_m',6.1,7,$4) RETURNING id", [a.id, sport, t.ev.id, t.org.id])).rows[0].id;
  const mine = (await pool.query("INSERT INTO performances(user_id, sport_id, metric, value, points, recorded_by) VALUES ($1,$2,'long_jump_m',9,999,$1) RETURNING id", [a.id, sport])).rows[0].id;
  await pool.query(mig.slice(mig.indexOf('UPDATE performances SET provenance'), mig.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS performances_client_key')));
  const rows = (await pool.query('SELECT id, provenance, status, official_points FROM performances WHERE id = ANY($1)', [[legacy, mine]])).rows;
  assert.deepEqual(rows.find((r) => r.id === legacy), { id: legacy, provenance: 'approved_competition', status: 'approved', official_points: 7 });
  assert.equal(rows.find((r) => r.id === mine).provenance, 'self_reported');
  assert.equal(rows.find((r) => r.id === mine).official_points, null);
});

test('every new capability is on the shared registry (REST + MCP + OpenAPI)', () => {
  for (const name of ['approve_performance', 'reject_performance', 'dispute_performance', 'correct_performance', 'list_performances', 'get_performance_history', 'list_scoring_rules']) {
    assert.ok(capabilities.some((c) => c.name === name), name);
  }
});

test('metric tie-break uses the date the best value was achieved, and points of non-best results do not count', async () => {
  const t = await meet('athletics', 2);
  const [x, y] = t.people;
  // x: best 10.9 on 3 March, plus two slower runs; y: only 10.9 on 3 March
  for (const [who, value, achieved_on] of [[x, 11.5, '2026-01-01'], [x, 12.0, '2026-02-01'], [x, 10.9, '2026-03-03'], [y, 10.9, '2026-03-03']]) {
    const r = await submit(t, who, { value, achieved_on });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await approve(t, r.body)).status, 200);
  }
  const lb = (await api('GET', `/leaderboard?sport=athletics&metric=100m_time_s&event_id=${t.ev.id}`)).body;
  assert.deepEqual(lb.map((r) => r.rank), [1, 1], 'equal best value on the same day: extra slower results must not break the tie');
  assert.ok(lb.every((r) => String(r.best_on).startsWith('2026-03-03') || new Date(r.best_on).toISOString().startsWith('2026-03-0')), 'best_on is the date of the best result');
  assert.ok(lb.every((r) => Number(r.points) === Number(lb[0].points)), 'points shown for a metric board are those of the best result');
  // an earlier achievement of the same best value wins
  const z = await signup(['athlete']);
  await pool.query("INSERT INTO event_entries(event_id, user_id, status) VALUES ($1,$2,'accepted')", [t.ev.id, z.id]);
  const rz = await submit(t, z, { value: 10.9, achieved_on: '2026-02-20' });
  await approve(t, rz.body);
  const lb2 = (await api('GET', `/leaderboard?sport=athletics&metric=100m_time_s&event_id=${t.ev.id}`)).body;
  assert.equal(lb2[0].id, z.id);
  assert.deepEqual(lb2.map((r) => r.rank), [1, 2, 2]);
});

test('category and season filters and pagination across pages', async () => {
  const t = await meet('athletics', 5);
  for (const [k, who] of t.people.entries()) {
    const r = await submit(t, who, { value: 10 + k, achieved_on: '2025-06-01' });
    await approve(t, r.body);
  }
  const cat = (await pool.query("SELECT category FROM sports WHERE slug='athletics'")).rows[0].category;
  const q = `sport=athletics&metric=100m_time_s&event_id=${t.ev.id}`;
  assert.equal((await api('GET', `/leaderboard?${q}&category=${encodeURIComponent(cat)}`)).body.length, 5);
  assert.equal((await api('GET', `/leaderboard?${q}&category=${encodeURIComponent(cat)}-other`)).body.length, 0);
  assert.equal((await api('GET', `/leaderboard?${q}&season=2025`)).body.length, 5);
  assert.equal((await api('GET', `/leaderboard?${q}&season=2026`)).body.length, 0);
  const seen = [];
  for (const offset of [0, 2, 4]) {
    const pg = (await api('GET', `/leaderboard?${q}&limit=2&offset=${offset}`)).body;
    pg.forEach((r, k) => assert.equal(r.rank, offset + k + 1));
    seen.push(...pg.map((r) => r.id));
  }
  assert.deepEqual(seen, t.people.map((p) => p.id), 'pages join up without gaps or repeats');
});

test('rejecting follows the same separation of duties as approving', async () => {
  const t = await meet();
  const [a] = t.people;
  const r = (await submit(t, a, { value: 11 })).body;
  const reject = (by) => api('POST', `/performances/${r.id}/reject`, { token: by.token, body: { reason: 'timing sheet does not match' } });
  assert.equal((await reject(t.org)).status, 403, 'the submitter cannot reject');
  assert.equal((await reject(a)).status, 403, 'the athlete cannot reject');
  assert.equal((await reject(t.outsider)).status, 403);
  assert.equal((await reject(t.other)).status, 200);
});

test('a correction carries the evidence, has its own history, and the superseded row logs its real previous status', async () => {
  const t = await meet('athletics', 1);
  const [a] = t.people;
  const ra = (await submit(t, a, { value: 11, evidence_ref: 'https://example.com/sheet/1' })).body;
  await approve(t, ra);
  await api('POST', `/performances/${ra.id}/dispute`, { token: a.token, body: { reason: 'timer started late' } });
  const fix = (await api('POST', `/performances/${ra.id}/correct`, { token: t.org.token, body: { value: 11.8, reason: 'photo finish review' } })).body;
  assert.equal(fix.evidence_ref, 'https://example.com/sheet/1');
  await approve(t, fix);
  const newHist = (await api('GET', `/performances/${fix.id}/history`, { token: a.token })).body;
  assert.deepEqual(newHist.map((h) => h.action), ['submitted', 'approved']);
  assert.equal(newHist[0].note, 'photo finish review');
  const oldHist = (await api('GET', `/performances/${ra.id}/history`, { token: a.token })).body;
  assert.deepEqual(oldHist.map((h) => h.action), ['submitted', 'approved', 'disputed', 'corrected', 'superseded']);
  assert.equal(oldHist.at(-1).from_status, 'disputed');
});

const rpc = async (method, params, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()).result;
};

test('an athlete can dispute a result once; officials are notified; a reason is required', async () => {
  const t = await meet('athletics', 1);
  const [a] = t.people;
  const r = (await submit(t, a, { value: 11 })).body;
  assert.equal((await approve(t, r)).status, 200);
  assert.equal((await api('POST', `/performances/${r.id}/dispute`, { token: a.token, body: {} })).status, 400, 'a reason is required');
  assert.equal((await api('POST', `/performances/${r.id}/dispute`, { token: a.token, body: { reason: 'abc' } })).status, 400, 'too short to be a reason');
  assert.equal((await api('POST', `/performances/${r.id}/dispute`, { token: a.token, body: { reason: 'timer started late' } })).status, 200);
  assert.equal((await api('POST', `/performances/${r.id}/dispute`, { token: a.token, body: { reason: 'still wrong, again' } })).status, 409, 'already disputed');
  // the organiser and the accepted official hear about it
  for (const who of [t.org, t.other]) {
    const inbox = (await api('GET', '/notifications', { token: who.token })).body;
    const hit = (inbox.items ?? inbox).find((x) => x.kind === 'result_disputed' && x.data?.performance_id === r.id);
    assert.ok(hit, 'official notified');
  }
  const queue = await api('GET', `/performances?event_id=${t.ev.id}&status=disputed`, { token: t.org.token });
  assert.deepEqual(queue.body.map((x) => x.id), [r.id], 'disputed results show in the officials queue');
  // an official re-approves; the athlete cannot pull it out of the standings a second time
  assert.equal((await approve(t, r)).status, 200);
  const again = await api('POST', `/performances/${r.id}/dispute`, { token: a.token, body: { reason: 'dispute it once more' } });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal((await api('GET', `/leaderboard?sport=athletics&metric=100m_time_s&event_id=${t.ev.id}`)).body.length, 1, 'result still counts');
  assert.equal((await api('POST', `/performances/${r.id}/dispute`, { token: t.other.token, body: { reason: 'official flags it for review' } })).status, 200, 'an official may still flag it');
});

test('event-only submissions: an identical double entry is refused, different attempts are valid and the board keeps the best', async () => {
  const t = await meet('athletics', 1);
  const [a] = t.people;
  const first = await submit(t, a, { value: 11.4, achieved_on: '2026-03-01' });
  assert.equal(first.status, 201);
  const dup = await submit(t, a, { value: 11.4, achieved_on: '2026-03-01' });
  assert.equal(dup.status, 409, JSON.stringify(dup.body));
  const second = await submit(t, a, { value: 10.8, achieved_on: '2026-03-01' });
  assert.equal(second.status, 201, 'a different attempt is allowed');
  assert.equal((await approve(t, first.body)).status, 200);
  assert.equal((await approve(t, second.body)).status, 200);
  const lb = (await api('GET', `/leaderboard?sport=athletics&metric=100m_time_s&event_id=${t.ev.id}`)).body;
  assert.equal(lb.length, 1);
  assert.equal(Number(lb[0].best), 10.8, 'the better attempt counts');
  assert.equal(lb[0].entries, 2);
});

test('concurrent decisions on one result: exactly one wins', async () => {
  const t = await meet('athletics', 2);
  const adm = await admin();
  const r1 = (await submit(t, t.people[0], { value: 11 })).body;
  const both = await Promise.all([approve(t, r1, t.other), approve(t, r1, adm)]);
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 409]);
  const r2 = (await submit(t, t.people[1], { value: 12 })).body;
  const mixed = await Promise.all([approve(t, r2, t.other), api('POST', `/performances/${r2.id}/reject`, { token: adm.token, body: { reason: 'false start recorded' } })]);
  assert.deepEqual(mixed.map((x) => x.status).sort(), [200, 409]);
});

test('no-metric tie-break order: official points, then more approved results, then earliest approval', async () => {
  const t = await meet('basketball', 4);
  const [a, b, c, d] = t.people;
  const ok = async (who, metric, value) => {
    const r = await api('POST', '/performances', { token: t.org.token, body: { user_id: who.id, sport: 'basketball', metric, value, event_id: t.ev.id } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await approve(t, r.body)).status, 200);
  };
  await ok(a, 'points', 10); // 10 pts, 1 result, approved first
  await ok(b, 'points', 5); await ok(b, 'assists', 5); // 10 pts, 2 results
  await ok(c, 'points', 10); // 10 pts, 1 result, approved after a
  await ok(d, 'points', 3);
  const lb = (await api('GET', `/leaderboard?sport=basketball&event_id=${t.ev.id}`)).body;
  assert.deepEqual(lb.map((x) => x.id), [b.id, a.id, c.id, d.id]);
  assert.deepEqual(lb.map((x) => x.rank), [1, 2, 3, 4]);
});

test('season is the calendar year of achieved_on', async () => {
  const t = await meet('athletics', 2);
  const [a, b] = t.people;
  const ra = (await submit(t, a, { value: 11, achieved_on: '2025-12-31' })).body, rb = (await submit(t, b, { value: 12, achieved_on: '2026-01-01' })).body;
  await approve(t, ra); await approve(t, rb);
  const season = async (y) => (await api('GET', `/leaderboard?sport=athletics&event_id=${t.ev.id}&season=${y}`)).body.map((x) => x.id);
  assert.deepEqual(await season(2025), [a.id]);
  assert.deepEqual(await season(2026), [b.id]);
});

test('MCP: approve_performance is forbidden for the submitter, list_scoring_rules works, leaderboard matches REST', async () => {
  const t = await meet('athletics', 1);
  const [a] = t.people;
  const r = (await submit(t, a, { value: 11.2 })).body;
  const denied = await rpc('tools/call', { name: 'approve_performance', arguments: { id: r.id } }, t.org.token);
  assert.equal(denied.isError, true);
  assert.equal(JSON.parse(denied.content[0].text).code, 'forbidden');
  const ok = await rpc('tools/call', { name: 'approve_performance', arguments: { id: r.id } }, t.other.token);
  assert.ok(!ok.isError, JSON.stringify(ok));
  const rules = await rpc('tools/call', { name: 'list_scoring_rules', arguments: { sport: 'athletics', metric: '100m_time_s' } });
  assert.ok(!rules.isError);
  const rule = rules.structuredContent.result?.rule ?? rules.structuredContent.rule;
  assert.equal(rule.direction, 'lower');
  const mcp = await rpc('tools/call', { name: 'leaderboard', arguments: { sport: 'athletics', metric: '100m_time_s', event_id: t.ev.id } });
  const rest = (await api('GET', `/leaderboard?sport=athletics&metric=100m_time_s&event_id=${t.ev.id}`)).body;
  const rows = mcp.structuredContent.result;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows.map((x) => [x.id, x.rank, Number(x.best)]), rest.map((x) => [x.id, x.rank, Number(x.best)]));
});
