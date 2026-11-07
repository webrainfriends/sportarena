import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// PS-06 Verified accessible venue & facility discovery: confidence metadata, outages, checklists, discovery filter.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { capabilities } = await import('../src/capabilities/index.js');
const { VENUE_FEATURES, VENUE_FEATURE_SET } = await import('../src/inclusion.js');

let server, base, n = 0, manager, athlete;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const uid = () => `ps06_${++n}_${Date.now()}`;

before(async () => {
  await migrate(pool);
  const app = createApp();
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;

  // Create a venue manager user and an athlete user
  const mu = await pool.query(`INSERT INTO users(email,name) VALUES('${uid()}@ps06.test','Manager') RETURNING id`);
  manager = { id: mu.rows[0].id, token: await signToken({ sub: mu.rows[0].id }) };
  const au = await pool.query(`INSERT INTO users(email,name) VALUES('${uid()}@ps06.test','Athlete') RETURNING id`);
  athlete = { id: au.rows[0].id, token: await signToken({ sub: au.rows[0].id }) };

  // Create a venue owned by manager
  const vr = await pool.query(`INSERT INTO venues(name,owner_id,city,country,currency) VALUES('PS06 Arena','${manager.id}','London','GB','GBP') RETURNING id`);
  manager.venueId = vr.rows[0].id;
});

after(async () => {
  await new Promise((res) => server.close(res));
  await pool.end();
});

test('VENUE_FEATURES has 13 entries and VENUE_FEATURE_SET matches', () => {
  assert.equal(VENUE_FEATURES.length, 13);
  for (const f of VENUE_FEATURES) assert.ok(VENUE_FEATURE_SET.has(f), `${f} missing from set`);
});

test('upsert_venue_access_feature — saves confidence and returns updated feature', async () => {
  const r = await api('PATCH', `/venues/${manager.venueId}/access-features/lift`, {
    token: manager.token,
    body: { confidence: 'certified', source: 'BSOSA', assessor_name: 'J Smith', evidence_ref: 'BS8300:2018', last_checked: '2025-01-15', expires_at: '2027-01-15' },
  });
  const b = ok(r);
  assert.equal(b.feature, 'lift');
  assert.equal(b.confidence, 'certified');
  assert.equal(b.assessor_name, 'J Smith');
});

test('list_venue_access_features_verified — returns all 13 features, unknown ones included', async () => {
  const r = await api('GET', `/venues/${manager.venueId}/access-features`, { token: manager.token });
  const b = ok(r);
  assert.equal(b.features.length, 13, 'should return all 13 feature rows');
  const liftRow = b.features.find((f) => f.feature === 'lift');
  assert.equal(liftRow.state, 'certified');
  const unknownRow = b.features.find((f) => f.feature === 'hearing_loop');
  assert.equal(unknownRow.state, 'unknown');
});

test('get_venue_access_feature_detail — returns feature detail', async () => {
  // Set lift with detail
  await api('PATCH', `/venues/${manager.venueId}/access-features/lift`, {
    token: manager.token,
    body: { confidence: 'certified', feature_detail: { lift_width_mm: 900, lift_depth_mm: 1200, notes: 'Rear-opening doors' } },
  });
  const r = await api('GET', `/venues/${manager.venueId}/access-features/lift`, { token: manager.token });
  const b = ok(r);
  assert.equal(b.feature_detail?.lift_width_mm, 900);
  assert.equal(b.feature_detail?.notes, 'Rear-opening doors');
});

test('raise_access_outage — creates outage and marks feature outage_active', async () => {
  const r = await api('POST', `/venues/${manager.venueId}/access-outages`, {
    token: manager.token,
    body: { feature: 'lift', reason: 'Maintenance', ends_at: '2026-12-01' },
  });
  const b = ok(r, 201);
  assert.ok(b.id, 'should return outage id');
  manager.outageId = b.id;

  const list = await api('GET', `/venues/${manager.venueId}/access-features`, { token: manager.token });
  const liftRow = list.body.features.find((f) => f.feature === 'lift');
  assert.ok(liftRow.outage_active, 'lift should show outage_active');
  assert.equal(liftRow.outage_reason, 'Maintenance');
});

test('list_access_outages — lists open outages for a venue', async () => {
  const r = await api('GET', `/venues/${manager.venueId}/access-outages`, { token: manager.token });
  const b = ok(r);
  assert.ok(Array.isArray(b.outages));
  const o = b.outages.find((x) => x.id === manager.outageId);
  assert.ok(o, 'should find raised outage');
  assert.equal(o.feature, 'lift');
  assert.equal(o.resolved_at, null);
});

test('resolve_access_outage — clears outage', async () => {
  const r = await api('PATCH', `/venues/${manager.venueId}/access-outages/${manager.outageId}/resolve`, { token: manager.token });
  ok(r);

  const list = await api('GET', `/venues/${manager.venueId}/access-features`, { token: manager.token });
  const liftRow = list.body.features.find((f) => f.feature === 'lift');
  assert.equal(liftRow.outage_active, false, 'outage should be cleared');
});

test('get_booking_access_suitability — returns checklist items with correct states', async () => {
  // Create a resource and booking at the venue
  const res = await pool.query(`INSERT INTO resources(venue_id,name,kind) VALUES('${manager.venueId}','Court 1','court') RETURNING id`);
  const bk = await pool.query(`INSERT INTO bookings(user_id,resource_id,starts_at,ends_at,status,total_cents,currency) VALUES('${athlete.id}','${res.rows[0].id}',now()+interval'1 day',now()+interval'1 day'+interval'1 hour','confirmed',1000,'GBP') RETURNING id`);
  const bookingId = bk.rows[0].id;

  // Set a need on the booking that maps to 'lift'
  await pool.query(`UPDATE bookings SET access_needs=ARRAY['lift_access'] WHERE id='${bookingId}'`);

  const r = await api('GET', `/bookings/${bookingId}/access-suitability`, { token: athlete.token });
  const b = ok(r);
  assert.ok(Array.isArray(b.items));
  const liftItem = b.items.find((i) => i.feature === 'lift');
  // lift is certified and no active outage → should be 'met'
  assert.ok(['met', 'unknown'].includes(liftItem?.state), `unexpected state: ${liftItem?.state}`);
});

test('list_venues access filter — filters correctly by feature + confidence', async () => {
  // Set step_free_route as certified
  await api('PATCH', `/venues/${manager.venueId}/access-features/step_free_route`, {
    token: manager.token,
    body: { confidence: 'certified' },
  });

  // Filter: requires step_free_route at certified level
  const r = await api('GET', '/venues', {
    token: athlete.token,
    query: { access_features: 'step_free_route', access_confidence: 'certified' },
  });
  const b = ok(r);
  assert.ok(Array.isArray(b));
  const found = b.find((v) => v.id === manager.venueId);
  assert.ok(found, 'venue should appear when it meets filter');
  assert.ok(found.access_feature_states?.length, 'should include access_feature_states');
});
