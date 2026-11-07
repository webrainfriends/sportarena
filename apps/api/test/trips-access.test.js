// PS-23: Accessible athlete delegation travel and transport logistics.
// Tests: privacy scoping, guardian boundaries, suitability calculation, alert triggers, cross-tenant 404.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ta_${n}_${roles[0]}`, display_name: `TA ${n}`, email: `ta${n}@example.com`, password: 'correct-horse-battery', roles } });
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

async function setup() {
  const manager = await signup(['coach']), athlete = await signup(), athlete2 = await signup(), guardian = await signup(), minor = await signup(), stranger = await signup();
  const org = ok(await api('POST', '/organisations', { token: manager.token, body: { name: `Access Org ${n}`, kind: 'club', city: 'Madrid' } }), 201);
  const team = ok(await api('POST', '/teams', { token: manager.token, body: { name: `Access Team ${n}`, org_id: org.id, sport: 'football' } }), 201);
  const trip = ok(await api('POST', '/trips', { token: manager.token, body: { name: `Access Trip ${n}`, team_id: team.id, origin: 'London', destination: 'Barcelona', timezone: 'Europe/Madrid', depart_at: new Date(Date.now() + 7 * 86400e3).toISOString(), return_at: new Date(Date.now() + 14 * 86400e3).toISOString() } }), 201);
  // Invite athletes
  const pa = ok(await api('POST', `/trips/${trip.id}/party`, { token: manager.token, body: { user_id: athlete.id, role: 'athlete' } }), 201);
  const pa2 = ok(await api('POST', `/trips/${trip.id}/party`, { token: manager.token, body: { user_id: athlete2.id, role: 'athlete' } }), 201);
  // Confirm both
  await api('POST', `/trips/${trip.id}/party/respond`, { token: athlete.token, body: { response: 'confirm' } });
  await api('POST', `/trips/${trip.id}/party/respond`, { token: athlete2.token, body: { response: 'confirm' } });
  // Minor + guardian
  await pool.query('UPDATE users SET youth_until = current_date + 700 WHERE id=$1', [minor.id]);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [guardian.id, minor.id]);
  const pMinor = ok(await api('POST', `/trips/${trip.id}/party`, { token: manager.token, body: { user_id: minor.id, role: 'athlete' } }), 201);
  await api('POST', `/trips/${trip.id}/party/respond`, { token: minor.token, body: { response: 'confirm' } });
  return { manager, athlete, athlete2, guardian, minor, stranger, trip, pa, pa2, pMinor };
}

test('athlete adds own access need; note visible to manager, absent from provider manifest', async () => {
  const g = await setup();
  const need = ok(await api('POST', `/trips/${g.trip.id}/access/needs`, {
    token: g.athlete.token,
    body: { need_type: 'wav', scope: 'provider_minimal', note: 'Need ramp access due to manual chair' },
  }), 201);
  assert.equal(need.need_type, 'wav');
  assert.ok(!need.note_enc, 'note_enc should not be in response');

  // Manager sees decrypted note via full plan
  const plan = ok(await api('GET', `/trips/${g.trip.id}/access`, { token: g.manager.token }));
  const pNeeds = plan.participants.find((p) => p.participant_id === g.pa.id)?.needs ?? [];
  assert.ok(pNeeds.length > 0);

  // Provider manifest should include wav but never note
  const manifest = ok(await api('GET', `/trips/${g.trip.id}/access/needs/provider`, { token: g.manager.token }));
  assert.ok(manifest.provider_needs.some((n) => n.need_type === 'wav'));
  for (const pn of manifest.provider_needs) {
    assert.ok(!('note' in pn), 'Provider manifest must not include note');
    assert.ok(!('note_enc' in pn), 'Provider manifest must not include note_enc');
  }
});

test('ops_only need never appears in provider manifest', async () => {
  const g = await setup();
  ok(await api('POST', `/trips/${g.trip.id}/access/needs`, {
    token: g.athlete.token,
    body: { need_type: 'rooming_hoist', scope: 'ops_only' },
  }), 201);
  const manifest = ok(await api('GET', `/trips/${g.trip.id}/access/needs/provider`, { token: g.manager.token }));
  assert.ok(!manifest.provider_needs.some((n) => n.need_type === 'rooming_hoist'), 'ops_only rooming need must not appear in provider manifest');
});

test('medication_carry_on and rooming_ never appear in provider manifest even with provider_minimal scope', async () => {
  const g = await setup();
  for (const nt of ['medication_carry_on', 'rooming_roll_in', 'rooming_ground_floor']) {
    await api('POST', `/trips/${g.trip.id}/access/needs`, { token: g.athlete.token, body: { need_type: nt, scope: 'provider_minimal' } });
  }
  const manifest = ok(await api('GET', `/trips/${g.trip.id}/access/needs/provider`, { token: g.manager.token }));
  for (const nt of ['medication_carry_on', 'rooming_roll_in', 'rooming_ground_floor']) {
    assert.ok(!manifest.provider_needs.some((n) => n.need_type === nt), `${nt} must not appear in provider manifest`);
  }
});

test('guardian can add access need for minor ward', async () => {
  const g = await setup();
  const need = ok(await api('POST', `/trips/${g.trip.id}/access/needs`, {
    token: g.guardian.token,
    body: { participant_id: g.pMinor.id, need_type: 'escort', scope: 'ops_only' },
  }), 201);
  assert.equal(need.need_type, 'escort');
});

test('stranger cannot add need for another participant', async () => {
  const g = await setup();
  const r = await api('POST', `/trips/${g.trip.id}/access/needs`, {
    token: g.stranger.token,
    body: { participant_id: g.pa.id, need_type: 'hearing_loop', scope: 'ops_only' },
  });
  assert.ok([403, 404].includes(r.status), 'stranger must get 403 or 404');
});

test('non-guardian athlete cannot add need for another participant', async () => {
  const g = await setup();
  const r = await api('POST', `/trips/${g.trip.id}/access/needs`, {
    token: g.athlete2.token,
    body: { participant_id: g.pa.id, need_type: 'guide_dog', scope: 'ops_only' },
  });
  assert.ok([403, 404].includes(r.status), 'non-guardian must be blocked from other participant needs');
});

test('add need is idempotent on (trip, participant, need_type)', async () => {
  const g = await setup();
  const a = ok(await api('POST', `/trips/${g.trip.id}/access/needs`, { token: g.athlete.token, body: { need_type: 'wav', scope: 'ops_only' } }), 201);
  const b = ok(await api('POST', `/trips/${g.trip.id}/access/needs`, { token: g.athlete.token, body: { need_type: 'wav', scope: 'provider_minimal' } }));
  assert.equal(a.id, b.id, 'upsert should return same record id');
  assert.equal(b.scope, 'provider_minimal', 'scope should be updated');
});

test('cross-tenant: stranger cannot read trip access plan', async () => {
  const g = await setup();
  const r = await api('GET', `/trips/${g.trip.id}/access`, { token: g.stranger.token });
  assert.ok([403, 404].includes(r.status), 'cross-tenant read must be blocked');
});

test('soft-delete removes need from active plan; data retained in DB', async () => {
  const g = await setup();
  const need = ok(await api('POST', `/trips/${g.trip.id}/access/needs`, { token: g.athlete.token, body: { need_type: 'securement', scope: 'ops_only' } }), 201);
  ok(await api('DELETE', `/trips/${g.trip.id}/access/needs/${need.id}`, { token: g.athlete.token }));
  const { rows } = await pool.query('SELECT archived_at FROM trip_access_needs WHERE id=$1', [need.id]);
  assert.ok(rows[0]?.archived_at, 'archived_at should be set after soft-delete');
  const plan = ok(await api('GET', `/trips/${g.trip.id}/access`, { token: g.manager.token }));
  const pNeeds = plan.participants.find((p) => p.participant_id === g.pa.id)?.needs ?? [];
  assert.ok(!pNeeds.some((n) => n.id === need.id), 'removed need must not appear in active plan');
});

test('WAV capacity gap: vehicle with 0 wheelchair_spaces → gap state; with 2 → met for ≤2 wav needs', async () => {
  const g = await setup();
  // Add a vehicle with 0 wheelchair_spaces
  const veh = (await pool.query(
    "INSERT INTO academy_transport_vehicles(org_id, description, capacity, wheelchair_spaces) VALUES ((SELECT id FROM organisations LIMIT 1),'Test bus',30,0) RETURNING id"
  )).rows[0];
  // Add a segment
  const seg = (await pool.query(
    `INSERT INTO trip_segments(trip_id, origin, destination, mode, depart_at, arrive_at, depart_tz, vehicle_id, status)
     VALUES ($1,'Madrid','Barcelona','coach',now() + interval '1 day',now() + interval '1 day 3 hours','Europe/Madrid',$2,'planned') RETURNING id`,
    [g.trip.id, veh.id])).rows[0];
  // Add both athletes as segment passengers
  for (const pa of [g.pa, g.pa2]) {
    await pool.query('INSERT INTO trip_segment_passengers(segment_id, participant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [seg.id, pa.id]);
  }
  // Both athletes need WAV
  await api('POST', `/trips/${g.trip.id}/access/needs`, { token: g.athlete.token, body: { need_type: 'wav', scope: 'ops_only' } });
  await api('POST', `/trips/${g.trip.id}/access/needs`, { token: g.athlete2.token, body: { need_type: 'wav', scope: 'ops_only' } });
  // Recheck
  const result = ok(await api('POST', `/trips/${g.trip.id}/access/suitability/recheck`, { token: g.manager.token }));
  assert.ok(result.rechecked > 0);
  const wavCheck = result.results.flatMap((r) => r.checks).find((c) => c.need_type === 'wav');
  assert.equal(wavCheck?.state, 'gap', 'vehicle with 0 wheelchair_spaces should give gap state');

  // Now give the vehicle 2 spaces → state should be met
  await pool.query('UPDATE academy_transport_vehicles SET wheelchair_spaces=2 WHERE id=$1', [veh.id]);
  const result2 = ok(await api('POST', `/trips/${g.trip.id}/access/suitability/recheck`, { token: g.manager.token }));
  const wavCheck2 = result2.results.flatMap((r) => r.checks).find((c) => c.need_type === 'wav');
  assert.equal(wavCheck2?.state, 'met', 'vehicle with 2 spaces for 2 wav needs should be met');
});

test('partial state when fewer spaces than need count', async () => {
  const g = await setup();
  const veh = (await pool.query(
    "INSERT INTO academy_transport_vehicles(org_id, description, capacity, wheelchair_spaces) VALUES ((SELECT id FROM organisations LIMIT 1),'Partial bus',30,1) RETURNING id"
  )).rows[0];
  const seg = (await pool.query(
    `INSERT INTO trip_segments(trip_id, origin, destination, mode, depart_at, arrive_at, depart_tz, vehicle_id, status)
     VALUES ($1,'Madrid','Valencia','coach',now() + interval '2 days',now() + interval '2 days 2 hours','Europe/Madrid',$2,'planned') RETURNING id`,
    [g.trip.id, veh.id])).rows[0];
  for (const pa of [g.pa, g.pa2]) {
    await pool.query('INSERT INTO trip_segment_passengers(segment_id, participant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [seg.id, pa.id]);
  }
  await api('POST', `/trips/${g.trip.id}/access/needs`, { token: g.athlete.token, body: { need_type: 'wav', scope: 'ops_only' } });
  await api('POST', `/trips/${g.trip.id}/access/needs`, { token: g.athlete2.token, body: { need_type: 'wav', scope: 'ops_only' } });
  const result = ok(await api('POST', `/trips/${g.trip.id}/access/suitability/recheck`, { token: g.manager.token }));
  const wavCheck = result.results.flatMap((r) => r.checks).find((c) => c.need_type === 'wav');
  assert.equal(wavCheck?.state, 'partial', '1 space for 2 wav needs should give partial');
});

test('vehicle access specs update and retrieval', async () => {
  const veh = (await pool.query(
    "INSERT INTO academy_transport_vehicles(org_id, description, capacity) VALUES ((SELECT id FROM organisations LIMIT 1),'Spec bus',45) RETURNING id"
  )).rows[0];
  const manager = (await pool.query('SELECT id FROM users LIMIT 1')).rows[0];
  const r = ok(await api('PATCH', `/vehicles/${veh.id}/access-specs`, {
    token: null,
    body: { wheelchair_spaces: 3, low_floor: true, hoist: false, securement_points: 3, hearing_loop: true },
  }));
  assert.equal(r.wheelchair_spaces, 3);
  assert.equal(r.low_floor, true);
  assert.equal(r.hearing_loop, true);
  assert.ok(r.access_verified_at);
});

test('resolve access alert', async () => {
  const g = await setup();
  // Insert an alert directly
  const { rows } = await pool.query(
    "INSERT INTO trip_access_alerts(trip_id, alert_type, detail) VALUES ($1,'wav_capacity_gap','{}') RETURNING id",
    [g.trip.id]);
  const alertId = rows[0].id;
  const alerts = ok(await api('GET', `/trips/${g.trip.id}/access/alerts`, { token: g.manager.token }));
  assert.ok(alerts.alerts.some((a) => a.id === alertId));
  ok(await api('PATCH', `/trips/${g.trip.id}/access/alerts/${alertId}/resolve`, { token: g.manager.token }));
  const after = ok(await api('GET', `/trips/${g.trip.id}/access/alerts`, { token: g.manager.token }));
  assert.ok(!after.alerts.some((a) => a.id === alertId), 'resolved alert should not appear in open alerts');
});
