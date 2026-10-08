import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete'], name) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `hl_${n}_${roles[0]}`, display_name: name ?? `Health ${n}`, email: `hl${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const provider = async (role, name, sport = 'football', profile) => {
  const u = await signup([role], name);
  must(await api('POST', '/me/sport-profiles', { token: u.token, body: { sport, role, hourly_rate_cents: 60000 } }), 201);
  if (profile) must(await api('POST', '/me/provider-profile', { token: u.token, body: { provider_type: role, ...profile } }));
  return u;
};
const verify = (u, type) => pool.query("INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at) VALUES ($1,'user',$2,$2,'approved',1,now(), now() + interval '300 days')", [type, u.id]);
const futureAt = (days, hour = 9, min = 0) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, min, 0, 0); return d; };
const allWeek = (start = '09:00', end = '17:00') => [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start, end }));

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('provider profile + search: public-safe fields, filters, sorts, pagination, empty state', async () => {
  const ana = await provider('physio', 'Ana Physio', 'football', { headline: 'Sports injury rehab', bio: 'Ten years in football rehab', clinic: 'Core Clinic', city: 'Pune', remote_ok: true, languages: ['English', 'Hindi'], specialties: ['knee', 'acl'], consult_fee_cents: 80000 });
  const raj = await provider('doctor', 'Raj Doctor', 'tennis', { city: 'Mumbai', specialties: ['sports medicine'], languages: ['English'], consult_fee_cents: 150000, accepting_patients: false });
  const sam = await provider('physio', 'Sam Legacy', 'football'); // sport profile only, no provider profile
  const hidden = await provider('physio', 'Hidden Hank', 'football', { city: 'Pune', listed: false });
  const patient = await signup(['athlete']);
  await verify(ana, 'physio');
  must(await api('POST', '/testimonials', { token: patient.token, body: { subject_type: 'user', subject_id: ana.id, rating: 5, body: 'Great rehab plan' } }), 201);

  assert.equal((await api('POST', '/me/provider-profile', { token: patient.token, body: { provider_type: 'physio' } })).status, 403, 'only providers');
  assert.equal((await api('POST', '/me/provider-profile', { token: ana.token, body: { provider_type: 'doctor' } })).status, 400, 'role must match');
  assert.equal((await api('POST', '/me/provider-profile', { token: ana.token, body: { provider_type: 'physio', timezone: 'Mars/Base' } })).status, 400);

  const s = (query) => api('GET', '/providers/search', { query }).then((r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; });
  const names = (rows) => rows.map((r) => r.display_name);
  const all = await s({ sort: 'name' });
  assert.deepEqual(names(all), ['Ana Physio', 'Raj Doctor', 'Sam Legacy'], 'unlisted providers are not shown; legacy providers still are');
  const a = all[0];
  assert.deepEqual([a.provider_type, a.city, a.remote_ok, a.credential_verified, Number(a.rating), a.rating_count, Number(a.fee_cents)], ['physio', 'Pune', true, true, 5, 1, 80000]);
  assert.ok(a.verified.some((b) => b.type === 'physio'));
  assert.deepEqual(a.book, { capability: 'book_appointment', provider_id: ana.id });
  assert.deepEqual(a.consent, { capability: 'grant_medical_access', provider_id: ana.id });
  const text = JSON.stringify(all);
  assert.ok(!/email|password|phone|dob|license|licence|reason|medical/i.test(text.replace(/book_appointment|grant_medical_access/g, '')), 'public-safe');
  assert.equal(Number(all[2].fee_cents), 60000, 'legacy fee comes from the sport profile rate');

  assert.deepEqual(names(await s({ type: 'doctor' })), ['Raj Doctor']);
  assert.deepEqual(names(await s({ sport: 'tennis' })), ['Raj Doctor']);
  assert.deepEqual(names(await s({ city: 'pune' })), ['Ana Physio']);
  assert.deepEqual(names(await s({ remote: 'true' })), ['Ana Physio']);
  assert.deepEqual(names(await s({ accepting: 'true', sort: 'name' })), ['Ana Physio', 'Sam Legacy']);
  assert.deepEqual(names(await s({ specialty: 'knee' })), ['Ana Physio']);
  assert.deepEqual(names(await s({ language: 'hindi' })), ['Ana Physio']);
  assert.deepEqual(names(await s({ verified: 'true' })), ['Ana Physio']);
  assert.deepEqual(names(await s({ min_rating: '4' })), ['Ana Physio']);
  assert.deepEqual(names(await s({ max_fee_cents: '70000' })), ['Sam Legacy']);
  assert.deepEqual(names(await s({ min_fee_cents: '100000' })), ['Raj Doctor']);
  assert.deepEqual(names(await s({ q: 'core clinic' })), ['Ana Physio']);
  assert.deepEqual(names(await s({ sort: 'fee' })), ['Sam Legacy', 'Ana Physio', 'Raj Doctor']);
  assert.deepEqual(names(await s({ sort: 'name', limit: '1', offset: '1' })), ['Raj Doctor']);
  assert.deepEqual(await s({ q: 'zzz-no-such-provider' }), [], 'empty result is an empty list');
  assert.equal((await api('GET', '/providers/search', { query: { sort: 'popularity' } })).status, 400);

  const prof = must(await api('GET', `/providers/${ana.id}`));
  assert.equal(prof.clinic, 'Core Clinic'); assert.equal(prof.currency, 'INR'); assert.deepEqual(prof.hours.windows, []);
  assert.equal((await api('GET', `/providers/${hidden.id}`)).status, 404, 'unlisted profile is not public');
  assert.equal((await api('GET', `/providers/${patient.id}`)).status, 404);
  assert.equal(sam.id !== undefined, true);
});

test('availability: weekly hours in the provider time zone, slots, time off, booking only on open slots, no double booking', async () => {
  const doc = await provider('physio', 'Slots Physio', 'football', { timezone: 'Asia/Kolkata', slot_min: 30 });
  const pat = await signup(['athlete']), pat2 = await signup(['athlete']);
  assert.equal((await api('POST', '/me/provider-availability', { token: pat.token, body: { windows: [] } })).status, 403);
  assert.equal((await api('POST', '/me/provider-availability', { token: doc.token, body: { windows: [{ weekday: 1, start: '10:00', end: '09:00' }] } })).status, 400);
  assert.equal((await api('POST', '/me/provider-availability', { token: doc.token, body: { windows: [{ weekday: 1, start: '09:00', end: '12:00' }, { weekday: 1, start: '11:00', end: '13:00' }] } })).status, 400, 'overlap');
  must(await api('POST', '/me/provider-availability', { token: doc.token, body: { windows: allWeek('09:00', '11:00') } }));
  const from = new Date(Date.now() + 2 * 864e5).toISOString(), to = new Date(Date.now() + 4 * 864e5).toISOString();
  const grid = must(await api('GET', `/providers/${doc.id}/slots`, { query: { from, to } }));
  assert.equal(grid.grid, true); assert.equal(grid.timezone, 'Asia/Kolkata');
  assert.equal(grid.slots.length, 8, '2 days x 4 half-hour slots');
  // 09:00 IST = 03:30 UTC
  assert.ok(grid.slots.every((x) => ['03:30', '04:00', '04:30', '05:00'].includes(x.slice(11, 16))), grid.slots.join());
  assert.equal((await api('GET', `/providers/${doc.id}/slots`, { query: { from, to: new Date(Date.now() + 90 * 864e5).toISOString() } })).status, 400, 'range limit');

  const first = grid.slots[0];
  assert.equal((await api('POST', '/appointments', { token: pat.token, body: { provider_id: doc.id, starts_at: new Date(+new Date(first) + 7 * 60_000).toISOString() } })).status, 409, 'off the grid');
  assert.equal((await api('POST', '/appointments', { token: pat.token, body: { provider_id: doc.id, starts_at: new Date(+new Date(first) + 180 * 60_000).toISOString() } })).status, 409, 'outside opening hours');
  // five people race for the same slot: exactly one wins
  const racers = await Promise.all(Array.from({ length: 5 }, async () => (await signup(['athlete'])).token));
  const results = await Promise.all(racers.map((t) => api('POST', '/appointments', { token: t, body: { provider_id: doc.id, starts_at: first, reason: 'knee' } })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409]);
  const after = must(await api('GET', `/providers/${doc.id}/slots`, { query: { from, to } }));
  assert.ok(!after.slots.includes(first) && after.slots.length === 7, 'booked slot disappears');
  // time off removes slots; removing it brings them back
  const off = must(await api('POST', '/me/provider-time-off', { token: doc.token, body: { starts_at: from, ends_at: to } }), 201);
  assert.deepEqual(must(await api('GET', `/providers/${doc.id}/slots`, { query: { from, to } })).slots, []);
  assert.equal((await api('POST', '/appointments', { token: pat2.token, body: { provider_id: doc.id, starts_at: after.slots[0] } })).status, 409, 'time off blocks booking');
  assert.equal((await api('DELETE', `/me/provider-time-off/${off.id}`, { token: pat.token })).status, 403);
  must(await api('DELETE', `/me/provider-time-off/${off.id}`, { token: doc.token }));
  assert.equal(must(await api('GET', `/providers/${doc.id}/slots`, { query: { from, to } })).slots.length, 7);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_time_off WHERE removed_at IS NOT NULL')).rows[0].n, 1, 'kept as history');

  // replacing hours keeps the old windows as history
  must(await api('POST', '/me/provider-availability', { token: doc.token, body: { windows: [{ weekday: 0, start: '09:00', end: '10:00' }] } }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_availability WHERE provider_id=$1 AND removed_at IS NOT NULL', [doc.id])).rows[0].n, 7);

  // availability filter + soonest sort in search
  const found = must(await api('GET', '/providers/search', { query: { available_from: from, available_to: new Date(Date.now() + 10 * 864e5).toISOString(), sort: 'soonest' } }));
  assert.ok(found.length >= 1 && found.every((r) => r.next_available_at && r.open_slots > 0));
  assert.deepEqual(must(await api('GET', '/providers/search', { query: { available_from: new Date(Date.now() - 3600e3).toISOString(), available_to: new Date(Date.now() - 1800e3).toISOString() } })), [], 'nothing open in the past');
});

test('appointment lifecycle: guarded transitions and generic notifications', async () => {
  const doc = await provider('doctor', 'Life Doctor', 'football', { accepting_patients: true });
  const ath = await signup(['athlete']), other = await signup(['athlete']);
  const when = futureAt(6, 10).toISOString();
  const a = must(await api('POST', '/appointments', { token: ath.token, body: { provider_id: doc.id, starts_at: when, reason: 'Secret knee pain' } }), 201);
  assert.equal((await api('POST', '/appointments', { token: ath.token, body: { provider_id: doc.id, starts_at: new Date(Date.now() - 864e5).toISOString() } })).status, 400, 'past');
  const req = (await pool.query("SELECT title, body FROM notifications WHERE user_id=$1 AND kind='appointment_requested'", [doc.id])).rows;
  assert.equal(req.length, 1); assert.ok(!/knee|Secret/i.test(JSON.stringify(req)), 'no clinical text in notifications');
  assert.equal((await api('PATCH', `/appointments/${a.id}`, { token: other.token, body: { status: 'cancelled' } })).status, 403);
  assert.equal((await api('PATCH', `/appointments/${a.id}`, { token: ath.token, body: { status: 'confirmed' } })).status, 403, 'athlete cannot confirm');
  assert.equal((await api('PATCH', `/appointments/${a.id}`, { token: doc.token, body: { status: 'completed' } })).status, 409, 'must be confirmed first');
  must(await api('PATCH', `/appointments/${a.id}`, { token: doc.token, body: { status: 'confirmed' } }));
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='appointment_update'", [ath.id])).rowCount === 1);
  must(await api('PATCH', `/appointments/${a.id}`, { token: ath.token, body: { status: 'cancelled' } }));
  assert.equal((await pool.query('SELECT cancelled_by FROM appointments WHERE id=$1', [a.id])).rows[0].cancelled_by, ath.id);
  assert.equal((await api('PATCH', `/appointments/${a.id}`, { token: doc.token, body: { status: 'confirmed' } })).status, 409, 'cancelled is final');
  // the cancelled slot is free again
  must(await api('POST', '/appointments', { token: other.token, body: { provider_id: doc.id, starts_at: when } }), 201);
  // a provider who stopped taking patients refuses new requests
  must(await api('POST', '/me/provider-profile', { token: doc.token, body: { provider_type: 'doctor', accepting_patients: false } }));
  assert.equal((await api('POST', '/appointments', { token: ath.token, body: { provider_id: doc.id, starts_at: futureAt(9, 10).toISOString() } })).status, 409);
});

test('consent: scoped, time-limited, revocable with history; every clinical path re-checks it', async () => {
  const doc = await provider('doctor', 'Consent Doc', 'football');
  const ath = await signup(['athlete']), stranger = await signup(['athlete']);
  const rec = (body) => api('POST', '/medical/records', { token: doc.token, body: { athlete_id: ath.id, kind: 'checkup', summary: 'Knee stable', ...body } });
  assert.equal((await rec({})).status, 403, 'no consent yet');
  assert.equal((await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: stranger.id } })).status, 400, 'not a provider');
  assert.equal((await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: ath.id } })).status, 400);

  // clearance-only consent: fit-to-play status yes, records no
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id, scope: 'clearance' } }), 201);
  assert.equal((await rec({})).status, 403);
  assert.equal((await api('GET', '/medical/records', { token: doc.token, query: { athlete_id: ath.id } })).status, 403);
  assert.equal((await api('GET', `/people/${ath.id}/clearance`, { token: doc.token })).status, 200);
  assert.deepEqual(must(await api('GET', '/medical/patients', { token: doc.token })).map((x) => [x.athlete_id, x.scope]), [[ath.id, 'clearance']]);

  // upgrade to full, with an expiry
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id, scope: 'full', expires_in_days: 30 } }), 201);
  const r1 = must(await rec({ clearance: 'cleared', details: 'Private detail' }), 201);
  assert.equal(must(await api('GET', '/medical/records', { token: doc.token, query: { athlete_id: ath.id } }))[0].details, 'Private detail');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_clinical' AND actor_id=$1", [doc.id])).rowCount >= 1);

  // an expired grant stops working without anyone revoking it
  await pool.query("UPDATE medical_grants SET expires_at = now() - interval '1 minute' WHERE athlete_id=$1", [ath.id]);
  assert.equal((await rec({})).status, 403); assert.equal((await api('GET', `/people/${ath.id}/clearance`, { token: doc.token })).status, 403);
  assert.equal(must(await api('GET', '/medical/grants', { token: ath.token })).grants[0].state, 'expired');
  assert.deepEqual(must(await api('GET', '/medical/patients', { token: doc.token })), []);

  // re-grant, then revoke: access ends at once, the row and the history stay
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
  assert.equal((await rec({})).status, 201);
  must(await api('DELETE', `/medical/grants/${doc.id}`, { token: ath.token }));
  assert.equal((await rec({})).status, 403); assert.equal((await api('GET', '/medical/records', { token: doc.token, query: { athlete_id: ath.id } })).status, 403);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM medical_grants WHERE athlete_id=$1', [ath.id])).rows[0].n, 1, 'revoke does not delete');
  const mine = must(await api('GET', '/medical/grants', { token: ath.token }));
  assert.equal(mine.grants[0].state, 'revoked');
  assert.deepEqual(mine.history.map((h) => h.action).reverse(), ['grant', 'grant', 'grant', 'revoke']);
  await assert.rejects(pool.query('DELETE FROM medical_grant_events'), /append-only/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind IN ('consent_granted','consent_revoked')", [doc.id])).rows[0].n, 4);
  assert.ok((await pool.query("SELECT body FROM notifications WHERE user_id=$1 AND kind='consent_granted'", [doc.id])).rows.every((r) => !r.body.includes(ath.display_name)));
  // the records the provider wrote earlier are untouched and still the athlete's
  assert.equal(must(await api('GET', '/medical/records', { token: ath.token })).find((x) => x.id === r1.id).summary, 'Knee stable');
});

test('migration keeps existing consent as full, active access with its history', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../migrations/', import.meta.url);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE TABLE schema_migrations (name text PRIMARY KEY, at timestamptz DEFAULT now())');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql') && x < '019_health_providers.sql').sort()) { await pool.query(readFileSync(new URL(f, dir), 'utf8')); await pool.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]); }
  const mk = async (h) => (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$1,'{athlete}','x','x',$1) RETURNING id", [h])).rows[0].id;
  const [a, p] = [await mk('old_a'), await mk('old_p')];
  await pool.query('INSERT INTO medical_grants(athlete_id, provider_id) VALUES ($1,$2)', [a, p]);
  await migrate();
  const g = (await pool.query('SELECT scope, expires_at, revoked_at FROM medical_grants WHERE athlete_id=$1', [a])).rows[0];
  assert.deepEqual([g.scope, g.expires_at, g.revoked_at], ['full', null, null]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM medical_grant_events WHERE athlete_id=$1 AND action='grant'", [a])).rows[0].n, 1);
});
