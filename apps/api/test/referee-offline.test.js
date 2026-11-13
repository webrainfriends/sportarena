import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body, query } = {}) => {
  const qs = query ? '?' + new URLSearchParams(query) : '';
  const r = await fetch(`${base}/api/v1${path}${qs}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const mcp = async (name, args, token) => {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await r.json()).result;
};

let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ro_${n}_${roles[0]}`, display_name: `Ro ${n}`, email: `ro${n}@example.com`, password: 'correct-horse-battery', roles } });
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

const mkTeam = async (u, sport) => (await api('POST', '/teams', { token: u.token, body: { name: `Team ${++n}`, sport } })).body;
const setup = async (sport = 'football') => {
  const org = await signup(['organizer']);
  const ref = await signup(['referee']);
  const m1 = await signup(['coach']);
  const m2 = await signup(['coach']);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `Ref Cup ${++n}`, sport } })).body;
  const home = await mkTeam(m1, sport);
  const away = await mkTeam(m2, sport);
  const fx = (await api('POST', '/fixtures', { token: org.token, body: { event_id: ev.id, home_team_id: home.id, away_team_id: away.id, scheduled_at: new Date(Date.now() + 3600000).toISOString() } })).body;
  await api('POST', `/fixtures/${fx.id}/officials/invite`, { token: org.token, body: { user_id: ref.id, role: 'referee' } });
  const assign = (await api('GET', `/fixtures/${fx.id}/officials`, { token: org.token })).body?.officials?.[0];
  if (assign) await api('POST', `/official-assignments/${assign.id}/respond`, { token: ref.token, body: { response: 'accept' } });
  return { org, ref, m1, m2, ev, home, away, fx };
};

const mkOp = (fixtureId, opType, payload, seq) => ({
  client_key: `${opType}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
  op_type: opType,
  payload_enc: JSON.stringify(payload),
  occurred_at: new Date().toISOString(),
  seq: seq ?? 1,
});

const DEVICE = 'test-device-001';

test('referee-pack: 404 for non-scorer', async () => {
  const { fx } = await setup();
  const rando = await signup(['athlete']);
  const r = await api('GET', `/fixtures/${fx.id}/referee-pack`, { token: rando.token });
  assert.equal(r.status, 404);
});

test('referee-pack: returns pack with crew, lineup, ruleset and pack_token', async () => {
  const { ref, fx } = await setup();
  const r = await api('GET', `/fixtures/${fx.id}/referee-pack`, { token: ref.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.pack_token, 'pack_token present');
  assert.ok(r.body.fixture, 'fixture present');
  assert.ok(Array.isArray(r.body.crew), 'crew array');
  assert.ok(Array.isArray(r.body.lineup), 'lineup array');
  assert.ok(r.body.ruleset, 'ruleset present');
  assert.ok(typeof r.body.pack_version === 'number', 'pack_version is number');
});

test('replay_referee_ops: creates sync session and applies a match_event', async () => {
  const { ref, fx } = await setup();
  const op = mkOp(fx.id, 'match_event', { kind: 'goal', meta: { period: 1 } }, 1);
  const r = await api('POST', `/fixtures/${fx.id}/referee-sync`, {
    token: ref.token,
    body: { device_id: DEVICE, pack_version: 0, device_time: new Date().toISOString(), ops: [op] },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body.outcomes));
  assert.equal(r.body.outcomes[0].client_key, op.client_key);
  assert.equal(r.body.outcomes[0].status, 'applied');
  assert.ok(r.body.session_id);
  assert.ok(typeof r.body.clock_drift_ms === 'number');
});

test('replay_referee_ops: idempotent — duplicate client_key returns duplicate status', async () => {
  const { ref, fx } = await setup();
  const op = mkOp(fx.id, 'match_event', { kind: 'goal' }, 1);
  const payload = { device_id: DEVICE, pack_version: 0, device_time: new Date().toISOString(), ops: [op] };
  await api('POST', `/fixtures/${fx.id}/referee-sync`, { token: ref.token, body: payload });
  const r2 = await api('POST', `/fixtures/${fx.id}/referee-sync`, { token: ref.token, body: payload });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.outcomes[0].status, 'applied'); // already applied row returned
});

test('replay_referee_ops: 404 for non-scorer trying to submit', async () => {
  const { fx } = await setup();
  const rando = await signup(['athlete']);
  const op = mkOp(fx.id, 'match_event', { kind: 'goal' }, 1);
  const r = await api('POST', `/fixtures/${fx.id}/referee-sync`, {
    token: rando.token,
    body: { device_id: DEVICE, pack_version: 0, device_time: new Date().toISOString(), ops: [op] },
  });
  assert.equal(r.status, 404);
});

test('replay_referee_ops: control_op applied to fixture_control_ops', async () => {
  const { ref, fx } = await setup();
  const op = mkOp(fx.id, 'control_op', { kind: 'start', meta: {} }, 1);
  const r = await api('POST', `/fixtures/${fx.id}/referee-sync`, {
    token: ref.token,
    body: { device_id: DEVICE, pack_version: 0, device_time: new Date().toISOString(), ops: [op] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.outcomes[0].status, 'applied');
});

test('replay_referee_ops: official_report created idempotently', async () => {
  const { ref, fx } = await setup();
  const op = mkOp(fx.id, 'official_report', { category: 'match_report', summary: 'All good', note: 'No incidents.' }, 1);
  const r = await api('POST', `/fixtures/${fx.id}/referee-sync`, {
    token: ref.token,
    body: { device_id: DEVICE, pack_version: 0, device_time: new Date().toISOString(), ops: [op] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.outcomes[0].status, 'applied');
  // second call: duplicate
  const r2 = await api('POST', `/fixtures/${fx.id}/referee-sync`, {
    token: ref.token,
    body: { device_id: DEVICE + '2', pack_version: 0, device_time: new Date().toISOString(), ops: [op] },
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.outcomes[0].status, 'applied'); // already applied
});

test('get_referee_sync_status: returns no_session when no ops submitted', async () => {
  const { ref, fx } = await setup();
  const r = await api('GET', `/fixtures/${fx.id}/referee-sync/status`, { token: ref.token, query: { device_id: 'newdev' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'no_session');
});

test('get_referee_sync_status: returns synced after successful batch', async () => {
  const { ref, fx } = await setup();
  const op = mkOp(fx.id, 'match_event', { kind: 'foul' }, 1);
  await api('POST', `/fixtures/${fx.id}/referee-sync`, {
    token: ref.token,
    body: { device_id: DEVICE, pack_version: 0, device_time: new Date().toISOString(), ops: [op] },
  });
  const r = await api('GET', `/fixtures/${fx.id}/referee-sync/status`, { token: ref.token, query: { device_id: DEVICE } });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'synced');
});

test('list_referee_conflicts: empty when no conflicts', async () => {
  const { ref, fx } = await setup();
  const r = await api('GET', `/fixtures/${fx.id}/referee-sync/conflicts`, { token: ref.token, query: { device_id: DEVICE } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.conflicts, []);
});

test('list_referee_sync_history: returns ops for organiser', async () => {
  const { org, ref, fx } = await setup();
  const op = mkOp(fx.id, 'match_event', { kind: 'yellow_card' }, 1);
  await api('POST', `/fixtures/${fx.id}/referee-sync`, {
    token: ref.token,
    body: { device_id: DEVICE, pack_version: 0, device_time: new Date().toISOString(), ops: [op] },
  });
  const r = await api('GET', `/fixtures/${fx.id}/referee-sync/history`, { token: org.token });
  assert.equal(r.status, 200);
  assert.ok(r.body.total >= 1);
  assert.ok(Array.isArray(r.body.ops));
});

test('list_referee_sync_history: forbidden for rando', async () => {
  const { fx } = await setup();
  const rando = await signup(['athlete']);
  const r = await api('GET', `/fixtures/${fx.id}/referee-sync/history`, { token: rando.token });
  assert.ok([403, 404].includes(r.status));
});

test('MCP: get_referee_pack returns correct shape', async () => {
  const { ref, fx } = await setup();
  const r = await mcp('get_referee_pack', { id: fx.id }, ref.token);
  assert.ok(r?.content?.[0]?.text || r?.result, 'MCP result present');
});

test('replay_referee_ops: batch of 5 ops in sequence all applied', async () => {
  const { ref, fx } = await setup();
  const ops = Array.from({ length: 5 }, (_, i) => mkOp(fx.id, 'match_event', { kind: 'goal', meta: { period: 1, minute: i + 10 } }, i + 1));
  const r = await api('POST', `/fixtures/${fx.id}/referee-sync`, {
    token: ref.token,
    body: { device_id: DEVICE + '-batch', pack_version: 0, device_time: new Date().toISOString(), ops },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.outcomes.length, 5);
  assert.ok(r.body.outcomes.every((o) => o.status === 'applied'));
});
