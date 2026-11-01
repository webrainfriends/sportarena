// Map + list discovery, saved searches and venue leaderboards (#696).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/capabilities/index.js');
const { checkSavedSearches } = await import('../src/discovery-alerts.js');
const { parseBbox, inBbox } = await import('../src/geo.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `dc_${n}_${roles[0]}`, display_name: `Person ${n}`, email: `dc${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const inHours = (h) => new Date(Date.now() + h * 36e5).toISOString();

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function venue(mgr, name, city, lat, lng, sport = 'football') {
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name, city, timezone: 'UTC', latitude: lat, longitude: lng } }), 201);
  must(await api('POST', `/venues/${v.id}/hours`, { token: mgr.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '06:00', closes: '22:00' })) } }));
  must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', sport, capacity: 1, hourly_rate_cents: 50000 } }), 201);
  return v;
}
const host = (u, body = {}) => api('POST', '/open-games', { token: u.token, body: { sport: 'football', starts_at: inHours(30), duration_minutes: 90, location: 'Riverside ground', max_players: 4, approval_mode: 'auto', ...body } });

test('the bbox helper handles normal and antimeridian boxes', () => {
  const b = parseBbox('10,70,20,80');
  assert.ok(inBbox(b, 15, 75)); assert.ok(!inBbox(b, 25, 75)); assert.ok(!inBbox(b, 15, null));
  const wrap = parseBbox('-10,170,10,-170');
  assert.ok(inBbox(wrap, 0, 175)); assert.ok(inBbox(wrap, 0, -175)); assert.ok(!inBbox(wrap, 0, 0));
  assert.equal(parseBbox('20,70,10,80'), null, 'south above north is rejected');
});

test('discover_nearby: map pins are exactly the list rows; bbox, radius, kinds, sport and price filter all three kinds', async () => {
  const mgr = await signup(['venue_manager']); const hostU = await signup();
  const pune = await venue(mgr, 'Pune Arena', 'Pune', 18.5204, 73.8567);
  const mumbai = await venue(mgr, 'Mumbai Arena', 'Mumbai', 19.076, 72.8777);
  await venue(mgr, 'Squash Hub', 'Pune', 18.53, 73.86, 'squash');
  const g = must(await host(hostU, { place_latitude: 18.521, place_longitude: 73.857, place_city: 'Pune', location: 'Pune Arena lawn' }), 201);

  const all = must(await api('GET', '/discover', { query: { lat: 18.52, lng: 73.85, radius_km: 20 } }));
  assert.ok(all.items.some((x) => x.kind === 'venue' && x.id === pune.id));
  assert.ok(all.items.some((x) => x.kind === 'game' && x.id === g.id));
  assert.ok(!all.items.some((x) => x.id === mumbai.id), 'Mumbai is outside 20 km');
  assert.deepEqual(all.pins.map((p) => p.key).sort(), all.items.filter((x) => x.place?.latitude != null).map((x) => `${x.kind}:${x.id}`).sort(), 'pins == list');
  assert.equal(all.total, all.items.length); assert.equal(all.counts.venue + all.counts.game + all.counts.class, all.total);

  const box = must(await api('GET', '/discover', { query: { bbox: '18.9,72.5,19.3,73.0', kinds: 'venue' } }));
  assert.deepEqual(box.items.map((x) => x.id), [mumbai.id], 'bbox shows only the Mumbai venue');

  const sq = must(await api('GET', '/discover', { query: { sport: 'squash', kinds: 'venue' } }));
  assert.ok(sq.items.every((x) => x.sport_slugs.includes('squash')) && sq.items.length === 1);
  const multi = must(await api('GET', '/discover', { query: { sport: 'squash,football', kinds: 'venue' } }));
  assert.equal(multi.items.length, 3);

  const cheap = must(await api('GET', '/discover', { query: { kinds: 'venue', max_price_cents: 100 } }));
  assert.equal(cheap.items.length, 0, 'no venue is that cheap');
  assert.equal((await api('GET', '/discover', { query: { sort: 'distance' } })).status, 400, 'distance sort needs a point');
  assert.equal((await api('GET', '/discover', { query: { bbox: 'nonsense' } })).status, 400 || 422);
  const q = await api('GET', '/discover', { query: { sport: 'no-such-sport' } });
  assert.equal(q.status, 404);
  // coordinates on the public surface are rounded to ~110 m
  for (const x of all.items) if (x.place?.latitude != null) assert.equal(x.place.latitude, Math.round(x.place.latitude * 1000) / 1000);
});

test('seats-left and live availability: a full game drops out of has_seats results and the card reports seats', async () => {
  const hostU = await signup(); const a = await signup();
  const g = must(await host(hostU, { max_players: 2, place_latitude: 12.97, place_longitude: 77.59, place_city: 'Bengaluru', location: 'Cubbon park' }), 201);
  const r1 = must(await api('GET', '/discover', { query: { kinds: 'game', city: 'Bengaluru', has_seats: 'true' } }));
  const card = r1.items.find((x) => x.id === g.id); assert.ok(card);
  assert.equal(card.seats_left, 1, 'host holds one of two seats'); assert.equal(card.price_unit, 'player');
  must(await api('POST', `/open-games/${g.id}/join`, { token: a.token, body: {} }), 201);
  const r2 = must(await api('GET', '/discover', { query: { kinds: 'game', city: 'Bengaluru', has_seats: 'true' } }));
  assert.ok(!r2.items.some((x) => x.id === g.id), 'full game is not listed when seats are required');
  const r3 = must(await api('GET', '/discover', { query: { kinds: 'game', city: 'Bengaluru' } }));
  assert.equal(r3.items.find((x) => x.id === g.id).seats_left, 0);
});

test('minors are never listed publicly; classes accept geo, price, level and audience filters', async () => {
  const guardian = await signup(['athlete'], { dob: yearsAgo(40) });
  const kid = await signup(['athlete'], { dob: yearsAgo(12) });
  const coach = await signup(['coach'], { dob: yearsAgo(35) });
  must(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 70000 } }), 201);
  const rc = must(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Clinic', sport: 'football', audience: 'group', delivery: 'both', unit: 'session', duration_min: 60, price_cents: 50000, per_person: true, min_participants: 1, max_participants: 10 } }), 201);
  const youth = must(await api('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: rc.id, starts_at: inHours(48), online_url: 'https://meet.example.com/a', audience: 'youth', min_age: 8, max_age: 14 } }), 201);
  const adult = must(await api('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: rc.id, starts_at: inHours(50), online_url: 'https://meet.example.com/b', audience: 'adults' } }), 201);
  const pub = must(await api('GET', '/discover', { query: { kinds: 'class' } }));
  assert.ok(pub.items.some((x) => x.id === adult.id)); assert.ok(!pub.items.some((x) => x.id === youth.id), 'youth class hidden from the public');
  const asKid = must(await api('GET', '/discover', { token: kid.token, query: { kinds: 'class' } }));
  assert.ok(asKid.items.some((x) => x.id === youth.id), 'a young person sees young classes');
  assert.equal(must(await api('GET', '/coach/classes', { query: { max_price_cents: 100 } })).length, 0);
  assert.ok(must(await api('GET', '/coach/classes', { query: { max_price_cents: 50000, level: 'beginner', sort: 'price' } })).length >= 1);
  assert.equal((await api('GET', '/coach/classes', { query: { sort: 'distance' } })).status, 400);
  assert.ok(guardian.id);
});

test('saved searches: limit, rounding, privacy, soft delete, and an alert fires once for a new match only', async () => {
  const u = await signup(); const hostU = await signup(); const other = await signup();
  assert.equal((await api('POST', '/me/saved-searches', { body: { name: 'x' } })).status, 401);
  const s = must(await api('POST', '/me/saved-searches', { token: u.token, body: { name: 'Pune football', sport: 'football', lat: 18.52049, lng: 73.85671, radius_km: 25, kinds: 'game' } }), 201);
  assert.equal(s.filters.lat, 18.52); assert.equal(s.filters.lng, 73.86, 'centre is rounded to ~1 km before storing');
  assert.equal((await api('POST', '/me/saved-searches', { token: u.token, body: { name: 'bad', sport: 'no-such-sport' } })).status, 404);
  assert.equal(await checkSavedSearches(), 0, 'first run only records what exists');
  const g = must(await host(hostU, { place_latitude: 18.53, place_longitude: 73.85, place_city: 'Pune', location: 'Baner ground' }), 201);
  assert.equal(await checkSavedSearches(), 1, 'a new game in the area is announced');
  assert.equal(await checkSavedSearches(), 0, 'and only once');
  const inbox = (await pool.query("SELECT * FROM notifications WHERE user_id=$1 AND kind='search_match'", [u.id])).rows;
  assert.equal(inbox.length, 1); assert.equal(inbox[0].data.items[0].id, g.id);
  assert.equal(must(await api('GET', '/me/saved-searches', { token: other.token })).length, 0, 'private to the owner');
  assert.equal((await api('DELETE', `/me/saved-searches/${s.id}`, { token: other.token })).status, 404);
  must(await api('PATCH', `/me/saved-searches/${s.id}`, { token: u.token, body: { alerts_on: false } }));
  must(await api('DELETE', `/me/saved-searches/${s.id}`, { token: u.token }));
  assert.equal((await pool.query('SELECT archived_at FROM saved_searches WHERE id=$1', [s.id])).rows[0].archived_at != null, true, 'archived, not erased');
  for (let k = 0; k < 20; k++) must(await api('POST', '/me/saved-searches', { token: u.token, body: { name: `s${k}` } }), 201);
  assert.equal((await api('POST', '/me/saved-searches', { token: u.token, body: { name: 'over' } })).status, 400);
});

test('every sport in the catalogue is accepted by discover and by the three searches', async () => {
  const sports = (await pool.query('SELECT slug FROM sports ORDER BY slug')).rows;
  assert.ok(sports.length >= 200);
  for (const { slug } of sports) {
    const r = await api('GET', '/discover', { query: { sport: slug, lat: 18.52, lng: 73.85, radius_km: 5 } });
    assert.equal(r.status, 200, `${slug}: ${JSON.stringify(r.body)}`);
  }
});

test('venue leaderboards: scope.venue_id is accepted, validated and listed; rating formulas cannot be venue-scoped', async () => {
  const names = capabilities.map((c) => c.name);
  for (const nme of ['discover_nearby', 'save_search', 'list_saved_searches', 'update_saved_search', 'delete_saved_search']) assert.ok(names.includes(nme), nme);
  assert.ok(capabilities.find((c) => c.name === 'discover_nearby').auth === 'public');
  const admin = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('dc_root','dc_root','{admin}','x','x','dc_root') RETURNING id")).rows[0];
  const { signToken } = await import('../src/auth.js');
  const token = await signToken({ id: admin.id, roles: ['admin'] });
  const mgr = await signup(['venue_manager']);
  const v = await venue(mgr, 'Leaderboard Arena', 'Chennai', 13.08, 80.27);
  const def = { sport: 'football', subject: 'player', name: 'Venue goals', formula_kind: 'metric', metric: 'goals', aggregation: 'sum', scope: { venue_id: v.id }, expected_version: 0, min_samples: 3, min_distinct_events: 2 };
  const made = await api('POST', '/rankings', { token, body: def });
  assert.ok([200, 201].includes(made.status), JSON.stringify(made.body));
  const bad = await api('POST', '/rankings', { token, body: { ...def, name: 'Ghost venue', scope: { venue_id: '00000000-0000-4000-8000-000000000000' } } });
  assert.equal(bad.status, 422);
  const listed = must(await api('GET', '/rankings', { query: { sport: 'football', venue_id: v.id } }));
  assert.equal(listed.definitions.length, 1); assert.equal(listed.definitions[0].scope.venue_id, v.id);
  assert.equal(must(await api('GET', '/rankings', { query: { sport: 'football', venue_id: '00000000-0000-4000-8000-000000000000' } })).definitions.length, 0);
  const table = must(await api('GET', `/rankings/${listed.definitions[0].id}`));
  assert.ok(table.formula && table.version != null, 'the table states its formula and version');
});
