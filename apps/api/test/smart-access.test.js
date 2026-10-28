import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { addDays } = await import('../src/booking/time.js');
const { mintToken, readToken, checkToken, subjectKey, macOf, geoVerdict, distanceM } = await import('../src/access-layer.js');
const { sweepAccessGrants } = await import('../src/access-grants.js');
const { MANUAL_REASONS } = await import('../src/access-layer.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `sa_${n}_${roles[0]}`, display_name: `Sa ${n}`, email: `sa${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const today = new Date().toISOString().slice(0, 10);
const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('sa_root','sa_root','{admin}','x','x','sa_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

// ------------------------------------------------------------------------------------------------------------------ fixtures
async function academy({ athletes = 3, youth = 0 } = {}) {
  const owner = await signup(), coach = await signup(['coach']), stranger = await signup();
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `Smart ${n}`, kind: 'academy' } }), 201);
  ok(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: coach.handle, role: 'coach' } }), 201);
  ok(await api('POST', `/organisations/${org.id}/invite/respond`, { token: coach.token, body: { accept: true } }));
  const cohort = ok(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'U12', coach_id: coach.id } }), 201);
  const players = [];
  for (let k = 0; k < athletes; k++) players.push(await signup());
  const kids = [], parents = [];
  for (let k = 0; k < youth; k++) { const kid = await signup(['athlete'], { dob: yearsAgo(11) }); kids.push(kid); parents.push(await guardianOf(kid)); }
  const all = [...players, ...kids];
  ok(await api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${all.map((p) => `${p.handle},yes`).join('\n')}` } }), 201);
  return { owner, coach, stranger, org, cohort, players, kids, parents };
}
/** a published session that is in progress right now */
async function liveSession(a, { self = false, geo = false, minsIn = 5 } = {}) {
  const start = addDays(today, 3);
  const made = ok(await api('POST', `/cohorts/${a.cohort.id}/academy/timetable`, { token: a.owner.token, body: { idempotency_key: key(), starts_on: start, ends_on: start, weekdays: [dow(start)], start_time: '17:00', duration_min: 60, timezone: 'UTC', lead_id: a.coach.id } }), 201);
  const sid = made.created[0].id;
  ok(await api('POST', `/organisations/${a.org.id}/academy/sessions/publish`, { token: a.owner.token, body: { session_ids: [sid], acknowledge_warnings: true } }));
  await pool.query("UPDATE academy_sessions SET starts_at=now() - ($2 * interval '1 minute'), ends_at=now() + interval '55 minutes', self_checkin=$3, geo_checkin=$4 WHERE id=$1", [sid, minsIn, self, geo]);
  return sid;
}
const pass = (u, sid, extra = {}) => api('GET', '/access/pass', { token: u.token, query: { domain: 'academy_session', subject_ref: sid, ...extra } });
const capture = (u, body) => api('POST', '/access/captures', { token: u.token, body: { idempotency_key: key(), ...body } });
const scanPass = (op, sid, token, extra = {}) => capture(op, { domain: 'academy_session', subject_ref: sid, method: 'qr', token, ...extra });
const attendance = async (sid, uid) => (await pool.query('SELECT * FROM academy_attendance WHERE session_id=$1 AND user_id=$2', [sid, uid])).rows[0];
const anomalies = async (where, ...p) => (await pool.query(`SELECT kind FROM access_anomalies WHERE ${where}`, p)).rows.map((r) => r.kind);
async function guardianOf(child) {
  const parent = await signup(['athlete'], { dob: yearsAgo(40) });
  const l = ok(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: child.id, relationship: 'parent' } }), 201);
  ok(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  ok(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence: { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' } } }), 201);
  ok(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
  ok(await api('POST', `/youth/children/${child.id}/consents`, { token: parent.token, body: { purpose: 'participation' } }), 201);
  return parent;
}

// ------------------------------------------------------------------------------------------------------------------ pure pieces
test('tokens: signed per subject, bound to a window, tamper-proof; the offline check is the same pure function', () => {
  const ref = '11111111-1111-4111-8111-111111111111', uid = '22222222-2222-4222-8222-222222222222';
  const { token } = mintToken('academy_session', ref, { type: 'P', userId: uid });
  const t = readToken(token);
  assert.equal(t.domain, 'academy_session');
  assert.equal(checkToken(t, new Date()), 'ok');
  assert.equal(checkToken(t, new Date(Date.now() + 5 * 60000)), 'expired', 'a pass dies within a couple of minutes');
  assert.equal(checkToken(t, new Date(Date.now() - 5 * 60000)), 'expired', 'and cannot be used before it exists');
  assert.equal(checkToken({ ...t, userId: '33333333-3333-4333-8333-333333333333' }, new Date()), 'invalid', 'the person is part of the mac');
  assert.equal(checkToken({ ...t, ref: '44444444-4444-4444-8444-444444444444' }, new Date()), 'invalid', 'and so is the subject');
  assert.equal(readToken('GA1.ACR-ABCDEFGHJK.1.aaaaaaaaaaaaaaaaaaaa'), null, 'a printed accreditation token is not a pass');
  // what an offline device does with the pack key gives the same answer
  assert.equal(macOf(subjectKey('academy_session', ref), 'P', uid, t.w), t.mac);
  const site = readToken(mintToken('team_event', `${ref}_e_${uid}`, { type: 'S' }).token);
  assert.equal(site.type, 'S');
  assert.equal(checkToken(site, new Date(Date.now() + 2 * 60000)), 'ok', 'the door code survives a slow scan');
});

test('the app\'s offline checker (plain JS HMAC) agrees with the server for any message and any key', async () => {
  const { hmacHex, sha256, readToken: appRead, checkOffline } = await import('../../app/src/access-crypto.js');
  const { createHash } = await import('node:crypto');
  for (const m of ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(200), 'héllo wörld ✓']) {
    assert.equal(Buffer.from(sha256(new TextEncoder().encode(m))).toString('hex'), createHash('sha256').update(m).digest('hex'), `sha256 of ${m.length} chars`);
    assert.equal(hmacHex('k'.repeat(64), m), createHmac('sha256', 'k'.repeat(64)).update(m).digest('hex'));
  }
  assert.equal(hmacHex('k'.repeat(100), 'long key'), createHmac('sha256', 'k'.repeat(100)).update('long key').digest('hex'));
  const ref = '11111111-1111-4111-8111-111111111111', uid = '22222222-2222-4222-8222-222222222222';
  const key = subjectKey('academy_session', ref);
  const pack = { key, steps: { P: 30, S: 60 }, skew: { P: [1, 2], S: [1, 3] } };
  const t = mintToken('academy_session', ref, { type: 'P', userId: uid }).token;
  assert.equal(checkOffline(appRead(t), new Date(), pack), 'ok');
  assert.equal(checkOffline(appRead(t), new Date(Date.now() + 10 * 60000), pack), 'expired');
  assert.equal(checkOffline(appRead(t.replace(/.$/, (ch) => (ch === 'a' ? 'b' : 'a'))), new Date(), pack), 'invalid');
  assert.equal(checkOffline(null, new Date(), pack), 'invalid');
});

test('geofence: inside, outside, and no usable location', () => {
  const venue = { lat: 18.5204, lng: 73.8567, radius_m: 200 };
  assert.equal(geoVerdict(venue, { lat: 18.5206, lng: 73.8568, accuracy_m: 20 }), 'inside');
  assert.equal(geoVerdict(venue, { lat: 18.53, lng: 73.87, accuracy_m: 20 }), 'outside');
  assert.equal(geoVerdict(venue, undefined), 'unavailable');
  assert.equal(geoVerdict(venue, { lat: 18.5204, lng: 73.8567, accuracy_m: 5000 }), 'unavailable', 'too coarse to prove anything');
  assert.equal(geoVerdict({ radius_m: 200 }, { lat: 1, lng: 1 }), 'unavailable', 'a venue with no coordinates cannot judge');
  assert.ok(distanceM({ lat: 0, lng: 0 }, { lat: 0, lng: 0.001 }) > 100);
});

// ------------------------------------------------------------------------------------------------------------------ QR
test('academy QR: a pass checks in once; replay, tamper, wrong session and expiry are refused and reported', async () => {
  const a = await academy();
  const sid = await liveSession(a), other = await liveSession(a);
  const [p0, p1] = a.players;
  assert.equal((await pass(a.stranger, sid)).status, 404, 'someone not on the roster cannot hold a pass');
  const mine = ok(await pass(p0, sid));
  assert.ok(mine.refresh_in_s <= 30 && mine.token.startsWith('GQ1.P.'));
  assert.ok(!mine.token.includes(p0.handle) && !mine.token.includes(p0.display_name), 'nothing personal in the code');

  assert.equal((await scanPass(p1, sid, mine.token)).status, 403, 'only staff scan a pass');
  const first = ok(await scanPass(a.coach, sid, mine.token, { idempotency_key: 'scan-0001-abc' }), 201);
  assert.equal(first.capture.verdict, 'recorded');
  assert.equal(first.capture.person.user_id, p0.id);
  assert.equal(first.capture.verified, true);
  assert.equal(first.capture.canonical_ref.startsWith('academy_attendance:'), true);
  const row = await attendance(sid, p0.id);
  assert.equal(row.status, 'present');
  assert.equal(row.source, 'qr');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_attendance WHERE session_id=$1', [sid])).rows[0].n, 1, 'one canonical row; the capture is only evidence');

  // a retry of the same scan changes nothing; a second scan of the same code is a replay
  assert.equal(ok(await scanPass(a.coach, sid, mine.token, { idempotency_key: 'scan-0001-abc' }), 201).replayed, true);
  const replay = ok(await scanPass(a.coach, sid, mine.token), 201);
  assert.equal(replay.capture.verdict, 'denied');
  assert.equal(replay.capture.reason_code, 'qr_replay');
  assert.ok((await anomalies('subject_ref=$1 AND kind=$2', sid, 'qr_replay')).length >= 1);
  // tampered, wrong subject, expired
  assert.equal(ok(await scanPass(a.coach, sid, mine.token.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'))), 201).capture.reason_code, 'qr_invalid');
  const elsewhere = ok(await pass(p1, other));
  assert.equal(ok(await scanPass(a.coach, sid, elsewhere.token), 201).capture.reason_code, 'qr_wrong_subject');
  const stale = mintToken('academy_session', sid, { type: 'P', userId: p1.id, at: new Date(Date.now() - 10 * 60000) }).token;
  assert.equal(ok(await scanPass(a.coach, sid, stale), 201).capture.reason_code, 'qr_expired');
  assert.equal((await attendance(sid, p1.id))?.status ?? 'expected', 'expected', 'nothing was marked by a refused scan');
  // every presentation, good or bad, is recorded and the record is append-only
  const n0 = (await pool.query('SELECT count(*)::int AS n FROM access_captures WHERE subject_ref=$1', [sid])).rows[0].n;
  assert.ok(n0 >= 5);
  await assert.rejects(pool.query('DELETE FROM access_captures WHERE subject_ref=$1', [sid]), /append-only/);
  // the plain-text pass never contains the raw token in the evidence
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM access_captures WHERE token_idx = $1', [mine.token])).rows[0].n, 0);
});

test('my passes: one list of everything I (or my child) can show a pass for, nothing for strangers', async () => {
  const a = await academy({ athletes: 1, youth: 1 });
  const sid = await liveSession(a);
  const mine = ok(await api('GET', '/me/access/passes', { token: a.players[0].token }));
  assert.ok(mine.some((x) => x.domain === 'academy_session' && x.subject_ref === sid && x.athlete.is_me));
  assert.deepEqual(ok(await api('GET', '/me/access/passes', { token: a.stranger.token })), []);
  const fam = ok(await api('GET', '/me/access/passes', { token: a.parents[0].token }));
  assert.ok(fam.some((x) => x.subject_ref === sid && x.athlete.id === a.kids[0].id && x.athlete.youth), 'the guardian holds the child\'s pass');
  assert.ok(!ok(await api('GET', '/me/access/passes', { token: a.kids[0].token })).some((x) => x.subject_ref === sid), 'a young person does not hold their own');
  const t = await teamEvent();
  assert.ok(ok(await api('GET', '/me/access/passes', { token: t.p0.token })).some((x) => x.subject_ref === t.ref));
});

test('academy QR site code: self check-in without a geofence needs the code, the switch, and a roster place', async () => {
  const a = await academy();
  const off = await liveSession(a), on = await liveSession(a, { self: true });
  assert.equal((await api('GET', '/access/site-code', { token: a.players[0].token, query: { domain: 'academy_session', subject_ref: on } })).status, 404, 'athletes do not mint door codes');
  assert.equal((await api('GET', '/access/site-code', { token: a.coach.token, query: { domain: 'academy_session', subject_ref: off } })).status, 409, 'self check-in is off');
  const site = ok(await api('GET', '/access/site-code', { token: a.coach.token, query: { domain: 'academy_session', subject_ref: on } }));
  assert.ok(site.token.startsWith('GQ1.S.'));
  const me = a.players[0];
  const done = ok(await capture(me, { domain: 'academy_session', subject_ref: on, method: 'qr', token: site.token }), 201);
  assert.equal(done.capture.verdict, 'recorded');
  assert.equal((await attendance(on, me.id)).source, 'qr');
  assert.equal(ok(await capture(me, { domain: 'academy_session', subject_ref: on, method: 'qr', token: site.token }), 201).capture.reason_code, 'already_recorded');
  assert.equal(ok(await capture(a.stranger, { domain: 'academy_session', subject_ref: on, method: 'qr', token: site.token }), 201).capture.reason_code, 'not_eligible');
  const wrongDoor = ok(await capture(a.players[1], { domain: 'academy_session', subject_ref: off, method: 'qr', token: site.token }), 201);
  assert.equal(wrongDoor.capture.reason_code, 'qr_wrong_subject');
  // the existing self check-in endpoint is the same path, so it leaves evidence too
  const viaOld = ok(await api('POST', `/academy/sessions/${on}/self-check-in`, { token: a.players[2].token, body: { idempotency_key: key() } }));
  assert.equal(viaOld.status, 'present');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM access_captures WHERE subject_ref=$1 AND user_id=$2 AND method='self'", [on, a.players[2].id])).rows[0].n, 1);
});

// ------------------------------------------------------------------------------------------------------------------ geofence
async function sessionAt(a, sid, lat, lng) {
  const mgr = await signup(['venue_manager']);
  const v = ok(await api('POST', '/venues', { token: mgr.token, body: { name: `Geo Arena ${n}`, timezone: 'UTC', currency: 'INR', latitude: lat, longitude: lng } }), 201);
  const court = ok(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'C1', hourly_rate_cents: 100 } }), 201);
  const rs = (await pool.query("INSERT INTO reservations(code, user_id, currency) VALUES ($1,$2,'INR') RETURNING id", [`GEO${n}${Date.now() % 100000}`, mgr.id])).rows[0];
  const b = (await pool.query("INSERT INTO bookings(resource_id, user_id, reservation_id, starts_at, ends_at) VALUES ($1,$2,$3,now() - interval '1 hour', now() + interval '2 hours') RETURNING id", [court.id, mgr.id, rs.id])).rows[0];
  await pool.query("INSERT INTO session_venue_links(reservation_id, booking_id, session_type, session_id, linked_by) VALUES ($1,$2,'academy_session',$3,$4)", [rs.id, b.id, sid, mgr.id]);
  return { mgr, v, court, rs, b };
}
test('geofence: inside records; outside, or no location, is held for staff, and no coordinates are ever stored', async () => {
  const a = await academy({ athletes: 4 });
  const sid = await liveSession(a, { self: true, geo: true });
  await sessionAt(a, sid, 18.5204, 73.8567);
  const site = ok(await api('GET', '/access/site-code', { token: a.coach.token, query: { domain: 'academy_session', subject_ref: sid } }));
  assert.equal(site.geo_required, true);
  const [inside, outside, nothing, manual] = a.players;
  const go = (u, geo) => capture(u, { domain: 'academy_session', subject_ref: sid, method: 'qr', token: site.token, geo });
  assert.equal(ok(await go(inside, { lat: 18.5206, lng: 73.8566, accuracy_m: 15 }), 201).capture.verdict, 'recorded');
  assert.equal(ok(await go(inside, { lat: 18.5206, lng: 73.8566, accuracy_m: 15 }), 201).capture.reason_code, 'already_recorded');
  const out = ok(await go(outside, { lat: 18.60, lng: 73.95, accuracy_m: 15 }), 201);
  assert.equal(out.capture.verdict, 'pending_review');
  assert.equal(out.capture.reason_code, 'geofence_mismatch');
  assert.equal(out.capture.geo_result, 'outside');
  assert.equal((await attendance(sid, outside.id))?.status ?? 'expected', 'expected', 'a miss is not an accusation and not a mark');
  const none = ok(await go(nothing, undefined), 201);
  assert.equal(none.capture.reason_code, 'geo_unavailable');
  assert.equal(none.capture.verdict, 'pending_review');
  assert.ok((await anomalies('subject_ref=$1 AND kind=$2', sid, 'geofence_mismatch')).length >= 1);
  // no coordinates anywhere in the evidence
  const dump = JSON.stringify((await pool.query('SELECT * FROM access_captures WHERE subject_ref=$1', [sid])).rows);
  assert.ok(!dump.includes('18.60') && !dump.includes('73.95') && !dump.includes('18.5206'), 'coordinates are used once and never kept');
  // geo method on its own (no QR) works only where the organisation switched it on
  assert.equal(ok(await capture(manual, { domain: 'academy_session', subject_ref: sid, method: 'geo', geo: { lat: 18.5204, lng: 73.8567, accuracy_m: 10 } }), 201).capture.verdict, 'recorded');

  // staff fallback: the held list is a work list; accepting needs a reason, applies the mark with history; it can be done once
  const held = ok(await api('GET', '/access/captures', { token: a.coach.token, query: { domain: 'academy_session', subject_ref: sid, unresolved: 'true' } }));
  assert.equal(held.length, 2);
  const heldOut = held.find((h) => h.person.user_id === outside.id);
  assert.equal((await api('POST', `/access/captures/${heldOut.id}/review`, { token: outside.token, body: { decision: 'accepted', reason: 'I was there' } })).status, 404, 'not for the athlete');
  assert.equal((await api('POST', `/access/captures/${heldOut.id}/review`, { token: a.coach.token, body: { decision: 'accepted' } })).status, 400, 'a reason is needed');
  const acc = ok(await api('POST', `/access/captures/${heldOut.id}/review`, { token: a.coach.token, body: { decision: 'accepted', reason: 'Seen on the pitch by the coach' } }));
  assert.ok(acc.result_capture_id);
  assert.equal((await attendance(sid, outside.id)).status, 'present');
  assert.equal((await api('POST', `/access/captures/${heldOut.id}/review`, { token: a.coach.token, body: { decision: 'rejected', reason: 'changed my mind' } })).status, 409);
  const hist = ok(await api('GET', `/academy/sessions/${sid}/attendance/history`, { token: a.coach.token, query: { user_id: outside.id } }));
  assert.ok(hist.some((h) => h.to_status === 'present' && h.by), 'the correction keeps who and why');
  const heldNone = held.find((h) => h.person.user_id === nothing.id);
  ok(await api('POST', `/access/captures/${heldNone.id}/review`, { token: a.coach.token, body: { decision: 'rejected', reason: 'Not at the session' } }));
  assert.equal((await attendance(sid, nothing.id))?.status ?? 'expected', 'expected');
});

// ------------------------------------------------------------------------------------------------------------------ RFID / NFC
test('RFID/NFC: a tag is only a lookup key; the roster decides; suspended, unknown and foreign tags are refused', async () => {
  const a = await academy({ athletes: 3 });
  const sid = await liveSession(a);
  const [p0, p1] = a.players;
  const reg = ok(await api('POST', '/access/credentials', { token: p0.token, body: { kind: 'nfc', provider: 'acme', identifier: 'TAG-04A1B2C3', label: 'Wristband' } }), 201);
  assert.ok(!JSON.stringify(reg).includes('04A1B2C3'));
  assert.equal((await api('POST', '/access/credentials', { token: p1.token, body: { kind: 'nfc', provider: 'acme', identifier: 'TAG-04A1B2C3' } })).status, 409, 'one live owner per tag');
  assert.equal((await api('POST', '/access/credentials', { token: a.stranger.token, body: { kind: 'rfid', identifier: 'ANOTHER-1', user_id: p0.id } })).status, 403, 'nobody registers a tag for someone else');
  const staffReg = ok(await api('POST', '/access/credentials', { token: a.owner.token, body: { kind: 'rfid', provider: 'acme', identifier: 'CARD-9981', user_id: p1.id, organisation_id: a.org.id } }), 201);
  const stored = JSON.stringify((await pool.query('SELECT * FROM access_credentials')).rows);
  assert.ok(!stored.includes('04A1B2C3') && !stored.includes('CARD-9981'), 'the raw id is never stored');

  const tap = (u, credential, extra = {}) => capture(u, { domain: 'academy_session', subject_ref: sid, method: 'nfc', provider: 'acme', credential, ...extra });
  assert.equal((await tap(p1, 'TAG-04A1B2C3')).status, 403, 'an athlete cannot present a tag as staff');
  const hit = ok(await tap(a.coach, 'TAG-04A1B2C3'), 201);
  assert.equal(hit.capture.verdict, 'recorded');
  assert.equal(hit.capture.person.user_id, p0.id);
  assert.equal((await attendance(sid, p0.id)).source, 'nfc');
  const unknown = ok(await tap(a.coach, 'NOT-REGISTERED'), 201);
  assert.equal(unknown.capture.reason_code, 'credential_unknown');
  assert.equal(unknown.capture.person, null);
  assert.ok((await anomalies('subject_ref=$1 AND kind=$2', sid, 'unknown_credential')).length >= 1);
  // a tag of someone who is not on this roster: identified, then refused by the server-side roster
  const guest = await signup();
  ok(await api('POST', '/access/credentials', { token: guest.token, body: { kind: 'rfid', provider: 'acme', identifier: 'GUEST-1' } }), 201);
  assert.equal(ok(await tap(a.coach, 'GUEST-1'), 201).capture.reason_code, 'not_eligible');
  // suspend: works at once; restore: works again; revoke frees the tag
  ok(await api('POST', `/access/credentials/${staffReg.id}/end`, { token: p1.token, body: { action: 'suspend' } }));
  assert.equal(ok(await tap(a.coach, 'CARD-9981'), 201).capture.reason_code, 'credential_inactive');
  ok(await api('POST', `/access/credentials/${staffReg.id}/end`, { token: a.owner.token, body: { action: 'restore' } }));
  assert.equal(ok(await tap(a.coach, 'CARD-9981'), 201).capture.verdict, 'recorded');
  assert.equal((await api('POST', `/access/credentials/${staffReg.id}/end`, { token: a.stranger.token, body: { action: 'revoke' } })).status, 404);
  ok(await api('POST', `/access/credentials/${staffReg.id}/end`, { token: p1.token, body: { action: 'revoke' } }));
  ok(await api('POST', '/access/credentials', { token: guest.token, body: { kind: 'rfid', provider: 'acme', identifier: 'CARD-9981' } }), 201);
  assert.equal(ok(await api('GET', '/access/credentials', { token: p0.token })).length, 1);
  void reg;
});

// ------------------------------------------------------------------------------------------------------------------ manual, staff authority
test('front desk: a manual entry needs authority and a reason; scans never overwrite a staff mark; corrections keep who and why', async () => {
  const a = await academy();
  const sid = await liveSession(a);
  const [p0, p1] = a.players;
  assert.equal((await capture(p0, { domain: 'academy_session', subject_ref: sid, method: 'manual', user_id: p1.id, reason_code: 'other' })).status, 403);
  assert.equal((await capture(a.coach, { domain: 'academy_session', subject_ref: sid, method: 'manual', user_id: p0.id })).status, 400, 'a reason is needed');
  const man = ok(await capture(a.coach, { domain: 'academy_session', subject_ref: sid, method: 'manual', user_id: p0.id, reason_code: 'device_failure', note: 'scanner offline' }), 201);
  assert.equal(man.capture.verdict, 'recorded');
  assert.equal((await attendance(sid, p0.id)).source, 'staff');
  const list = ok(await api('GET', '/access/captures', { token: a.coach.token, query: { domain: 'academy_session', subject_ref: sid, method: 'manual' } }));
  assert.equal(list[0].reason, 'device_failure: scanner offline', 'the staff reason is kept, decrypted for staff and audited');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_access_reason'")).rowCount >= 1);
  assert.ok(!(await pool.query('SELECT reason_enc FROM access_captures WHERE id=$1', [man.capture.id])).rows[0].reason_enc.includes('scanner'), 'encrypted at rest');
  // staff already marked p1 excused; a scan is evidence, not authority
  ok(await api('POST', `/academy/sessions/${sid}/attendance`, { token: a.coach.token, body: { entries: [{ user_id: p1.id, status: 'excused', reason_code: 'illness' }] } }));
  const pass1 = ok(await pass(p1, sid));
  const held = ok(await scanPass(a.coach, sid, pass1.token), 201);
  assert.equal(held.capture.verdict, 'pending_review');
  assert.equal(held.capture.reason_code, 'staff_mark_exists');
  assert.equal((await attendance(sid, p1.id)).status, 'excused');
  // the existing roster tap rides the same path
  const old = ok(await api('POST', `/academy/sessions/${sid}/check-in`, { token: a.coach.token, body: { user_id: a.players[2].id, idempotency_key: key() } }));
  assert.equal(old.status, 'present');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM access_captures WHERE user_id=$1 AND method='manual'", [a.players[2].id])).rows[0].n, 1);
  assert.ok(MANUAL_REASONS.includes('roster_tap'));
  // check-out: early leaving is recorded as left_early with history
  const out = ok(await capture(a.coach, { domain: 'academy_session', subject_ref: sid, method: 'manual', user_id: p0.id, direction: 'out', reason_code: 'other', note: 'dentist' }), 201);
  assert.equal(out.capture.verdict, 'recorded');
  assert.equal((await attendance(sid, p0.id)).status, 'left_early');
});

// ------------------------------------------------------------------------------------------------------------------ youth
test('youth: a young person never checks in alone and never leaves on a scan; the guardian and pickup rules hold', async () => {
  const a = await academy({ athletes: 1, youth: 1 });
  const sid = await liveSession(a, { self: true });
  const kid = a.kids[0], parent = a.parents[0];
  const delegate = await signup(['athlete'], { dob: yearsAgo(35) });
  ok(await api('POST', `/youth/children/${kid.id}/pickup-delegates`, { token: parent.token, body: { delegate_user_id: delegate.id } }), 201);

  assert.equal((await pass(kid, sid)).status, 403, 'a guardian holds the child\'s pass');
  assert.equal((await pass(a.stranger, sid, { athlete_id: kid.id })).status, 403);
  const site = ok(await api('GET', '/access/site-code', { token: a.coach.token, query: { domain: 'academy_session', subject_ref: sid } }));
  const alone = ok(await capture(kid, { domain: 'academy_session', subject_ref: sid, method: 'qr', token: site.token }), 201);
  assert.equal(alone.capture.reason_code, 'guardian_required');
  assert.equal(alone.capture.verdict, 'denied');
  const kidPass = ok(await pass(parent, sid, { athlete_id: kid.id }));
  const arrive = ok(await scanPass(a.coach, sid, kidPass.token), 201);
  assert.equal(arrive.capture.verdict, 'recorded');
  assert.equal(arrive.capture.person.youth, true);
  // leaving: a bare scan (QR or tag) is not release
  const leave = ok(await capture(a.coach, { domain: 'academy_session', subject_ref: sid, method: 'manual', user_id: kid.id, direction: 'out', reason_code: 'other' }), 201);
  assert.equal(leave.capture.verdict, 'denied');
  assert.equal(leave.capture.reason_code, 'pickup_authorisation_required');
  assert.ok(leave.capture.release_candidates.some((r) => r.user_id === parent.id) && leave.capture.release_candidates.some((r) => r.user_id === delegate.id), 'staff are shown who may collect');
  assert.equal((await attendance(sid, kid.id)).left_at, null);
  const wrong = ok(await capture(a.coach, { domain: 'academy_session', subject_ref: sid, method: 'manual', user_id: kid.id, direction: 'out', reason_code: 'other', released_to_user_id: a.stranger.id }), 201);
  assert.equal(wrong.capture.reason_code, 'pickup_authorisation_required');
  const right = ok(await capture(a.coach, { domain: 'academy_session', subject_ref: sid, method: 'manual', user_id: kid.id, direction: 'out', reason_code: 'other', released_to_user_id: delegate.id }), 201);
  assert.equal(right.capture.verdict, 'recorded');
  assert.equal((await attendance(sid, kid.id)).status, 'left_early');
  // an expired authorisation stops working at once
  ok(await api('GET', `/youth/children/${kid.id}/pickup-delegates`, { token: parent.token }));
  await pool.query("UPDATE pickup_delegates SET revoked_at=now() WHERE child_id=$1 AND delegate_user_id=$2", [kid.id, delegate.id]);
  const gone = ok(await capture(a.coach, { domain: 'academy_session', subject_ref: sid, method: 'manual', user_id: kid.id, direction: 'out', reason_code: 'other', released_to_user_id: delegate.id }), 201);
  assert.equal(gone.capture.verdict, 'denied');
  // the geofence outcome of a young person is not shown to staff
  const evidence = ok(await api('GET', '/access/captures', { token: a.coach.token, query: { domain: 'academy_session', subject_ref: sid, user_id: kid.id } }));
  assert.ok(evidence.every((e) => e.geo_result === 'not_shown'));
});

// ------------------------------------------------------------------------------------------------------------------ team / event attendance
async function teamEvent() {
  const mgr = await signup(['coach']), org = await signup(['organizer']), p0 = await signup(), p1 = await signup(), outsider = await signup();
  const team = ok(await api('POST', '/teams', { token: mgr.token, body: { name: `Squad ${n}`, sport: 'football' } }), 201);
  for (const p of [p0, p1]) await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, p.id]);
  const ev = ok(await api('POST', '/events', { token: org.token, body: { name: `Cup ${n}`, sport: 'football', starts_on: today, ends_on: addDays(today, 1) } }), 201);
  const entry = ok(await api('POST', `/events/${ev.id}/entries`, { token: mgr.token, body: { team_id: team.id } }), 201);
  ok(await api('PATCH', `/entries/${entry.id}`, { token: org.token, body: { status: 'accepted' } }));
  return { mgr, org, p0, p1, outsider, team, ev, ref: `${team.id}_e_${ev.id}` };
}
test('team events: managers scan member passes and tags into team_attendance; undo needs a reason; the evidence is the history', async () => {
  const t = await teamEvent();
  const mint = (u) => api('GET', '/access/pass', { token: u.token, query: { domain: 'team_event', subject_ref: t.ref } });
  assert.equal((await mint(t.outsider)).status, 404, 'only members hold a pass');
  const p = ok(await mint(t.p0));
  assert.equal((await capture(t.p1, { domain: 'team_event', subject_ref: t.ref, method: 'qr', token: p.token })).status, 403, 'only managers scan');
  const a1 = ok(await capture(t.mgr, { domain: 'team_event', subject_ref: t.ref, method: 'qr', token: p.token }), 201);
  assert.equal(a1.capture.verdict, 'recorded');
  const row = (await pool.query('SELECT * FROM team_attendance WHERE team_id=$1 AND user_id=$2', [t.team.id, t.p0.id])).rows[0];
  assert.ok(row.checked_in_at && row.checked_in_by === t.mgr.id);
  // site code for the squad to scan themselves
  const site = ok(await api('GET', '/access/site-code', { token: t.mgr.token, query: { domain: 'team_event', subject_ref: t.ref } }));
  assert.equal(ok(await capture(t.p1, { domain: 'team_event', subject_ref: t.ref, method: 'qr', token: site.token }), 201).capture.verdict, 'recorded');
  assert.equal(ok(await capture(t.outsider, { domain: 'team_event', subject_ref: t.ref, method: 'qr', token: site.token }), 201).capture.reason_code, 'not_eligible');
  // check-out, then the existing manager endpoint (same path) for the undo
  const out = ok(await capture(t.mgr, { domain: 'team_event', subject_ref: t.ref, method: 'manual', user_id: t.p0.id, direction: 'out', reason_code: 'other' }), 201);
  assert.equal(out.capture.verdict, 'recorded');
  assert.ok((await pool.query('SELECT checked_out_at FROM team_attendance WHERE id=$1', [row.id])).rows[0].checked_out_at);
  assert.equal((await api('POST', `/teams/${t.team.id}/attendance/${t.p1.id}/check-in`, { token: t.mgr.token, body: { event_id: t.ev.id, checked_in: false } })).status, 400, 'an undo needs a reason');
  const undone = ok(await api('POST', `/teams/${t.team.id}/attendance/${t.p1.id}/check-in`, { token: t.mgr.token, body: { event_id: t.ev.id, checked_in: false, reason: 'tapped the wrong player' } }));
  assert.equal(undone.checked_in_at, null);
  const ev = ok(await api('GET', '/access/captures', { token: t.mgr.token, query: { team_id: t.team.id, user_id: t.p1.id } }));
  assert.ok(ev.some((e) => e.flags.includes('undo') && e.reason.includes('wrong player')), 'the undo is kept with who and why');
  const again = ok(await api('POST', `/teams/${t.team.id}/attendance/${t.p1.id}/check-in`, { token: t.mgr.token, body: { event_id: t.ev.id } }));
  assert.ok(again.checked_in_at);
  assert.equal((await api('GET', '/access/captures', { token: t.p0.token, query: { team_id: t.team.id } })).status, 403);
});

test('team events and youth: a scan needs the guardian\'s drop-off first and cannot collect a young person', async () => {
  const mgr = await signup(['coach']), org = await signup(['organizer']), kid = await signup(['athlete'], { dob: yearsAgo(10) });
  const team = ok(await api('POST', '/teams', { token: mgr.token, body: { name: `Juniors ${n}`, sport: 'football' } }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, kid.id]);
  const ev = ok(await api('POST', '/events', { token: org.token, body: { name: `Junior Cup ${n}`, sport: 'football', starts_on: today, ends_on: today } }), 201);
  const ref = `${team.id}_e_${ev.id}`;
  const parent = await guardianOf(kid);
  const p = ok(await api('GET', '/access/pass', { token: parent.token, query: { domain: 'team_event', subject_ref: ref, athlete_id: kid.id } }));
  assert.equal(ok(await capture(mgr, { domain: 'team_event', subject_ref: ref, method: 'qr', token: p.token }), 201).capture.reason_code, 'guardian_drop_off_required');
  ok(await api('POST', `/youth/teams/${team.id}/check-ins`, { token: parent.token, body: { child_id: kid.id, kind: 'drop_off' } }), 201);
  const p2 = ok(await api('GET', '/access/pass', { token: parent.token, query: { domain: 'team_event', subject_ref: ref, athlete_id: kid.id } }));
  assert.equal(ok(await capture(mgr, { domain: 'team_event', subject_ref: ref, method: 'qr', token: p2.token }), 201).capture.verdict, 'recorded');
  const leave = ok(await capture(mgr, { domain: 'team_event', subject_ref: ref, method: 'manual', user_id: kid.id, direction: 'out', reason_code: 'other' }), 201);
  assert.equal(leave.capture.reason_code, 'pickup_authorisation_required', 'collection goes through the guardian pickup flow');
});

// ------------------------------------------------------------------------------------------------------------------ offline
test('offline: a pack is limited to one subject; sync is idempotent, labelled, re-judged, and conflicts surface', async () => {
  const a = await academy({ athletes: 3 });
  const sid = await liveSession(a);
  assert.equal((await api('GET', '/access/offline-pack', { token: a.players[0].token, query: { domain: 'academy_session', subject_ref: sid } })).status, 404);
  const pack = ok(await api('GET', '/access/offline-pack', { token: a.coach.token, query: { domain: 'academy_session', subject_ref: sid } }));
  assert.match(pack.note, /provisional/);
  assert.ok(new Date(pack.valid_until) > new Date());
  // the device verifies with the pack key only
  const [p0, p1, p2] = a.players;
  const seenAt = new Date(Date.now() - 20 * 60000);
  const mintAt = (u, at) => mintToken('academy_session', sid, { type: 'P', userId: u.id, at }).token;
  const tok0 = mintAt(p0, seenAt);
  assert.equal(checkToken(readToken(tok0), seenAt, pack.key), 'ok', 'valid at the moment it was seen, with no server');
  assert.equal(checkToken(readToken(tok0), new Date(), pack.key), 'expired');
  const item = (u, at, k) => ({ domain: 'academy_session', subject_ref: sid, method: 'qr', token: mintAt(u, at), idempotency_key: k, captured_at: at.toISOString(), device_id: 'tablet-1' });
  const batch = { items: [item(p0, seenAt, 'offline-key-0001'), item(p0, seenAt, 'offline-key-0002'), item(p1, new Date(Date.now() - 10 * 60000), 'offline-key-0003')] };
  const r1 = ok(await api('POST', '/access/captures/sync', { token: a.coach.token, body: batch }));
  const by = Object.fromEntries(r1.results.map((r) => [r.idempotency_key, r]));
  assert.equal(by['offline-key-0001'].status, 'synced');
  assert.equal(by['offline-key-0001'].capture.offline, true);
  assert.deepEqual(by['offline-key-0001'].capture.flags, ['offline']);
  assert.equal(by['offline-key-0002'].status, 'conflict', 'the same code seen by a second device is a replay, not a second check-in');
  assert.equal(by['offline-key-0002'].capture.reason_code, 'qr_replay');
  assert.equal(by['offline-key-0003'].status, 'synced');
  const row = await attendance(sid, p0.id);
  assert.ok(Math.abs(new Date(row.arrived_at) - seenAt) < 2000, 'the arrival time is when the device saw it, not when it synced');
  // idempotent
  const r2 = ok(await api('POST', '/access/captures/sync', { token: a.coach.token, body: batch }));
  assert.deepEqual(r2.results.map((r) => r.status), ['already_synced', 'already_synced', 'already_synced']);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM access_captures WHERE subject_ref=$1 AND offline", [sid])).rows[0].n, 3);
  // a booking-style change while offline: the athlete was un-enrolled meanwhile, so the scan conflicts instead of succeeding
  await pool.query("UPDATE org_enrolments SET status='withdrawn' WHERE cohort_id=$1 AND user_id=$2", [a.cohort.id, p2.id]);
  const r3 = ok(await api('POST', '/access/captures/sync', { token: a.coach.token, body: { items: [item(p2, new Date(Date.now() - 5 * 60000), 'offline-key-0004')] } }));
  assert.equal(r3.results[0].status, 'conflict');
  assert.ok((await anomalies('subject_ref=$1 AND kind=$2', sid, 'offline_conflict')).length >= 1);
  // too old, in the future, and not staff
  const old = ok(await api('POST', '/access/captures/sync', { token: a.coach.token, body: { items: [item(p1, new Date(Date.now() - 80 * 3600000), 'offline-key-0005')] } }));
  assert.equal(old.results[0].capture.reason_code, 'offline_too_old');
  const future = ok(await api('POST', '/access/captures/sync', { token: a.coach.token, body: { items: [item(p1, new Date(Date.now() + 3600000), 'offline-key-0006')] } }));
  assert.equal(future.results[0].status, 'rejected');
  const notStaff = ok(await api('POST', '/access/captures/sync', { token: p1.token, body: { items: [item(p1, seenAt, 'offline-key-0007')] } }));
  assert.equal(notStaff.results[0].status, 'rejected');
  // gates need a live server check
  assert.equal((await api('GET', '/access/offline-pack', { token: a.coach.token, query: { domain: 'venue_access', subject_ref: sid } })).status, 400);
});

// ------------------------------------------------------------------------------------------------------------------ the whole sport catalogue
test('every sport: presence is sport-neutral, so every catalogue sport behaves the same (no silent defaults)', async () => {
  const a = await academy({ athletes: 1 });
  const sid = await liveSession(a);
  const sports = (await pool.query('SELECT slug FROM sports ORDER BY slug')).rows;
  assert.ok(sports.length > 10);
  let k = 0;
  for (const { slug } of sports) {
    const copy = (await pool.query("INSERT INTO academy_sessions SELECT (jsonb_populate_record(NULL::academy_sessions, to_jsonb(s) || jsonb_build_object('id', gen_random_uuid(), 'sport', $2::text, 'starts_at', s.starts_at + ($3 * interval '1 second'), 'ends_at', s.ends_at + ($3 * interval '1 second')))).* FROM academy_sessions s WHERE s.id=$1 RETURNING id", [sid, slug, 1 + (k += 1)])).rows[0];
    const r = ok(await scanPass(a.coach, copy.id, ok(await pass(a.players[0], copy.id)).token), 201);
    assert.equal(r.capture.verdict, 'recorded', slug);
    assert.equal((await attendance(copy.id, a.players[0].id)).status, 'present', slug);
  }
});

// ------------------------------------------------------------------------------------------------------------------ gates, hardware, grants
function controller() {
  const state = { up: true, answer: { ok: true, ref: 'prov-ref-1' }, calls: [] };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.calls.push({ headers: req.headers, body: body ? JSON.parse(body) : null });
      if (!state.up) { res.statusCode = 500; return res.end('down'); }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(state.answer));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, state, url: `http://127.0.0.1:${srv.address().port}/ctl` })));
}
const sign = (secret, p, ts, nonce, method, provider, credential, direction) => createHmac('sha256', secret).update(`${p}|${ts}|${nonce}|${method}|${provider}|${credential}|${direction}`).digest('hex');
async function bookingNow(venueId, courtId, user, { status = 'confirmed', resStatus = 'confirmed', startMin = -10, endMin = 50 } = {}) {
  const rs = (await pool.query("INSERT INTO reservations(code, user_id, currency, status) VALUES ($1,$2,'INR',$3) RETURNING id", [`GT${n}${Math.random().toString(36).slice(2, 7)}`, user.id, resStatus])).rows[0];
  const b = (await pool.query("INSERT INTO bookings(resource_id, user_id, reservation_id, starts_at, ends_at, status) VALUES ($1,$2,$3, now() + ($4 * interval '1 minute'), now() + ($5 * interval '1 minute'), $6) RETURNING id", [courtId, user.id, rs.id, startMin, endMin, status])).rows[0];
  return { rs, b };
}
async function gateVenue(provider = 'webhook') {
  const mgr = await signup(['venue_manager']), member = await signup(), other = await signup(), stranger = await signup();
  const v = ok(await api('POST', '/venues', { token: mgr.token, body: { name: `Gate Arena ${n}`, timezone: 'UTC', currency: 'INR' } }), 201);
  const court = ok(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'C1', hourly_rate_cents: 100 } }), 201);
  const ctl = await controller();
  const point = ok(await api('POST', '/access/points', { token: mgr.token, body: { venue_id: v.id, name: 'Main turnstile', kind: 'turnstile', provider, endpoint_url: provider === 'webhook' ? ctl.url : undefined } }), 201);
  return { mgr, member, other, stranger, v, court, ctl, point };
}
const device = (g, credential, { nonce = key(), direction = 'in', provider = 'acme', secret = g.point.secret, ts = Math.floor(Date.now() / 1000) } = {}) =>
  api('POST', '/access/device-events', { body: { point_id: g.point.id, ts, nonce, method: 'rfid', provider, credential, direction, signature: sign(secret, g.point.id, ts, nonce, 'rfid', provider, credential, direction) } });

test('gate: access comes from a live booking; a controller must confirm; failures are never a grant', async () => {
  const g = await gateVenue();
  after(() => g.ctl.srv.close());
  assert.ok(g.point.secret?.startsWith('acs_'), 'the secret is shown once');
  assert.equal((await api('POST', '/access/points', { token: g.stranger.token, body: { venue_id: g.v.id, name: 'Sneaky', provider: 'manual' } })).status, 403);
  assert.equal((await api('POST', '/access/points', { token: g.mgr.token, body: { venue_id: g.v.id, name: 'Bad', provider: 'webhook', endpoint_url: 'http://example.com/x' } })).status, 400, 'a controller URL must be https (loopback excepted outside production)');
  assert.ok(!JSON.stringify(ok(await api('GET', '/access/points', { token: g.mgr.token, query: { venue_id: g.v.id } }))).includes(g.point.secret));
  ok(await api('POST', '/access/credentials', { token: g.member.token, body: { kind: 'rfid', provider: 'acme', identifier: 'GATE-TAG-1' } }), 201);
  ok(await api('POST', '/access/credentials', { token: g.other.token, body: { kind: 'rfid', provider: 'acme', identifier: 'GATE-TAG-2' } }), 201);

  // no booking: denied, and the controller was never asked to open
  const calls0 = g.ctl.state.calls.length;
  const none = ok(await device(g, 'GATE-TAG-1'), 201);
  assert.equal(none.granted, false);
  assert.equal(none.reason_code, 'no_current_booking');
  assert.equal(g.ctl.state.calls.length, calls0);
  // a booking now: granted, the controller opened, the booking records the arrival
  const { rs, b } = await bookingNow(g.v.id, g.court.id, g.member);
  const yes = ok(await device(g, 'GATE-TAG-1'), 201);
  assert.equal(yes.granted, true);
  assert.equal(g.ctl.state.calls.at(-1).body.action, 'open');
  assert.ok(g.ctl.state.calls.at(-1).headers['x-access-signature'].length === 64, 'commands to the controller are signed');
  assert.ok((await pool.query('SELECT checked_in_at FROM bookings WHERE id=$1', [b.id])).rows[0].checked_in_at);
  // someone else's tag does not borrow it; a bad signature or stale timestamp is a 404
  assert.equal(ok(await device(g, 'GATE-TAG-2'), 201).reason_code, 'no_current_booking');
  assert.equal((await device(g, 'GATE-TAG-1', { secret: 'acs_wrong' })).status, 404);
  assert.equal((await device(g, 'GATE-TAG-1', { ts: Math.floor(Date.now() / 1000) - 600 })).status, 404);
  // a retry with the same nonce is the same answer, not a second capture
  const nonce = key();
  const first = ok(await device(g, 'GATE-TAG-1', { nonce }), 201);
  const retry = ok(await device(g, 'GATE-TAG-1', { nonce }), 201);
  assert.equal(retry.replayed, true);
  assert.equal(retry.capture_id, first.capture_id);
  // the controller down: nothing opens, nothing is recorded as arrival
  const { b: b2 } = await bookingNow(g.v.id, g.court.id, g.other);
  g.ctl.state.up = false;
  const down = ok(await device(g, 'GATE-TAG-2'), 201);
  assert.equal(down.granted, false);
  assert.equal(down.verdict, 'provider_unavailable');
  assert.equal((await pool.query('SELECT checked_in_at FROM bookings WHERE id=$1', [b2.id])).rows[0].checked_in_at, null, 'no fabricated success');
  assert.ok((await anomalies('venue_id=$1 AND kind=$2', g.v.id, 'provider_unavailable')).length >= 1);
  g.ctl.state.up = true;
  g.ctl.state.answer = { ok: false };
  assert.equal(ok(await device(g, 'GATE-TAG-2'), 201).reason_code, 'provider_rejected');
  g.ctl.state.answer = { something: 'else' };
  assert.equal(ok(await device(g, 'GATE-TAG-2'), 201).verdict, 'provider_unavailable', 'a vague answer is not a yes');
  g.ctl.state.answer = { ok: true };
  assert.equal(ok(await device(g, 'GATE-TAG-2'), 201).granted, true, 'and it recovers');
  // cancelled booking: denied and reported, with the reason a front desk can act on
  await pool.query("UPDATE reservations SET status='cancelled' WHERE id=$1", [rs.id]);
  await pool.query("UPDATE bookings SET status='cancelled' WHERE reservation_id=$1", [rs.id]);
  const cancelled = ok(await device(g, 'GATE-TAG-1', { direction: 'in' }), 201);
  assert.equal(cancelled.granted, false);
  assert.equal(cancelled.reason_code, 'booking_cancelled');
  assert.ok((await anomalies('venue_id=$1 AND kind=$2', g.v.id, 'booking_cancelled')).length >= 1);
  // an active membership opens the door with no booking; an expired one is reported as inactive
  ok(await api('POST', '/access/credentials', { token: g.stranger.token, body: { kind: 'rfid', provider: 'acme', identifier: 'GATE-TAG-3' } }), 201);
  const plan = (await pool.query("INSERT INTO venue_plans(venue_id, kind, name, price_cents, duration_days, discount_bp) VALUES ($1,'membership','Gold',1000,30,1000) RETURNING id", [g.v.id])).rows[0];
  const up = (await pool.query("INSERT INTO user_plans(plan_id, venue_id, user_id, kind, name, status, price_cents, currency, discount_bp, duration_days, starts_at, expires_at) VALUES ($1,$2,$3,'membership','Gold','active',1000,'INR',1000,30,now(),now() + interval '30 days') RETURNING id", [plan.id, g.v.id, g.member.id])).rows[0];
  assert.equal(ok(await device(g, 'GATE-TAG-1'), 201).granted, true);
  await pool.query("UPDATE user_plans SET user_id=$2 WHERE id=$1", [up.id, g.stranger.id]);
  assert.equal(ok(await device(g, 'GATE-TAG-3'), 201).granted, true);
  await pool.query("UPDATE user_plans SET status='expired', expires_at=now() - interval '1 day' WHERE id=$1", [up.id]);
  assert.equal(ok(await device(g, 'GATE-TAG-3'), 201).reason_code, 'membership_inactive');
  // front desk: the same point as a manual door
  const mp = ok(await api('POST', '/access/points', { token: g.mgr.token, body: { venue_id: g.v.id, name: 'Reception', provider: 'manual' } }), 201);
  assert.equal(mp.secret, null);
  const walkin = await signup();
  const desk = ok(await capture(g.mgr, { domain: 'venue_access', subject_ref: mp.id, method: 'manual', user_id: walkin.id, reason_code: 'forgot_credential' }), 201);
  assert.equal(desk.capture.reason_code, 'no_current_booking', 'even by hand the entitlement is judged');
  // the report separates evidence from the final record, and is for the venue team only
  const rep = ok(await api('GET', '/access/report', { token: g.mgr.token, query: { venue_id: g.v.id } }));
  assert.ok(rep.evidence.total >= 8 && rep.evidence.denials_by_reason.length >= 3);
  assert.equal(rep.final.source, 'bookings');
  assert.equal((await api('GET', '/access/report', { token: g.stranger.token, query: { venue_id: g.v.id } })).status, 403);
  const an = ok(await api('GET', '/access/anomalies', { token: g.mgr.token, query: { venue_id: g.v.id } }));
  assert.ok(an.some((x) => x.kind === 'booking_cancelled'));
  const rv = ok(await api('POST', `/access/anomalies/${an[0].id}/review`, { token: g.mgr.token, body: { status: 'reviewed', note: 'Checked with the desk' } }));
  assert.equal(rv.status, 'reviewed');
  assert.equal((await api('POST', `/access/anomalies/${an[0].id}/review`, { token: g.stranger.token, body: { status: 'dismissed', note: 'nope nope' } })).status, 404);
});

test('grants follow their source: a cancelled booking or a released locker revokes promptly, and an unreachable controller stays honestly pending', async () => {
  const g = await gateVenue();
  after(() => g.ctl.srv.close());
  const { rs, b } = await bookingNow(g.v.id, g.court.id, g.member, { startMin: 5, endMin: 65 });
  const grant = ok(await api('POST', `/access/points/${g.point.id}/grants`, { token: g.mgr.token, body: { source_type: 'booking', source_id: b.id } }), 201);
  assert.equal(grant.status, 'active');
  assert.equal(grant.provider_ref, 'prov-ref-1');
  assert.equal(g.ctl.state.calls.at(-1).body.action, 'provision');
  assert.equal((await api('POST', `/access/points/${g.point.id}/grants`, { token: g.stranger.token, body: { source_type: 'booking', source_id: b.id } })).status, 404);
  assert.equal((await api('POST', `/access/points/${g.point.id}/grants`, { token: g.mgr.token, body: { source_type: 'accreditation', source_id: b.id } })).status, 400);
  // the controller cannot confirm: nothing is recorded as issued
  const { b: b2 } = await bookingNow(g.v.id, g.court.id, g.other, { startMin: 5, endMin: 65 });
  g.ctl.state.up = false;
  assert.equal((await api('POST', `/access/points/${g.point.id}/grants`, { token: g.mgr.token, body: { source_type: 'booking', source_id: b2.id } })).status, 502);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM access_grants WHERE source_id=$1', [b2.id])).rows[0].n, 0);
  g.ctl.state.up = true;

  // cancelling the reservation through the API revokes the grant right after commit
  ok(await api('DELETE', `/reservations/${rs.id}`, { token: g.member.token }));
  await new Promise((r) => setTimeout(r, 300));
  let gr = (await pool.query('SELECT status, revoke_reason FROM access_grants WHERE id=$1', [grant.id])).rows[0];
  assert.equal(gr.status, 'revoked');
  assert.equal(g.ctl.state.calls.at(-1).body.action, 'revoke');
  // the controller is down when the next source ends: it shows revoke_pending until a retry succeeds
  const { b: b3 } = await bookingNow(g.v.id, g.court.id, g.other, { startMin: 5, endMin: 65 });
  const g3 = ok(await api('POST', `/access/points/${g.point.id}/grants`, { token: g.mgr.token, body: { source_type: 'booking', source_id: b3.id } }), 201);
  g.ctl.state.up = false;
  await pool.query("UPDATE bookings SET status='cancelled' WHERE id=$1", [b3.id]);
  assert.equal(await sweepAccessGrants() >= 1, true);
  gr = (await pool.query('SELECT status FROM access_grants WHERE id=$1', [g3.id])).rows[0];
  assert.equal(gr.status, 'revoke_pending', 'not claimed revoked while the controller has not confirmed');
  assert.equal(ok(await api('GET', `/access/points/${g.point.id}/grants`, { token: g.mgr.token, query: { status: 'revoke_pending' } })).length, 1);
  const feed = ok(await api('GET', `/access/points/${g.point.id}/revocations`, { token: g.mgr.token }));
  assert.ok(feed.grants.some((x) => x.grant_id === g3.id), 'devices that cache credentials see it');
  g.ctl.state.up = true;
  await sweepAccessGrants();
  assert.equal((await pool.query('SELECT status FROM access_grants WHERE id=$1', [g3.id])).rows[0].status, 'revoked');
  // manual revoke by staff, and a locker grant that follows the locker assignment
  const { rs: rs4, b: b4 } = await bookingNow(g.v.id, g.court.id, g.member, { startMin: 5, endMin: 65 });
  ok(await api('POST', `/venues/${g.v.id}/lockers`, { token: g.mgr.token, body: { prefix: 'L', count: 1 } }), 201);
  const lk = ok(await api('POST', `/reservations/${rs4.id}/locker`, { token: g.mgr.token, body: {} }), 201);
  const lg = ok(await api('POST', `/access/points/${g.point.id}/grants`, { token: g.mgr.token, body: { source_type: 'locker_assignment', source_id: lk.id } }), 201);
  assert.ok(!JSON.stringify(g.ctl.state.calls.at(-1)).match(/\bpin\b/i), 'the locker PIN is never sent to a controller');
  ok(await api('DELETE', `/locker-assignments/${lk.id}`, { token: g.mgr.token }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await pool.query('SELECT status FROM access_grants WHERE id=$1', [lg.id])).rows[0].status, 'revoked');
  const g4 = ok(await api('POST', `/access/points/${g.point.id}/grants`, { token: g.mgr.token, body: { source_type: 'booking', source_id: b4.id } }), 201);
  assert.equal(ok(await api('POST', `/access/grants/${g4.id}/revoke`, { token: g.mgr.token })).status, 'revoked');
  // a manual access point cannot hold temporary credentials
  const mp = ok(await api('POST', '/access/points', { token: g.mgr.token, body: { venue_id: g.v.id, name: 'Reception', provider: 'manual' } }), 201);
  assert.equal((await api('POST', `/access/points/${mp.id}/grants`, { token: g.mgr.token, body: { source_type: 'booking', source_id: b4.id } })).status, 409);
  // rotating the secret invalidates the old one
  const rot = ok(await api('PATCH', `/access/points/${g.point.id}`, { token: g.mgr.token, body: { rotate_secret: true } }));
  assert.ok(rot.secret && rot.secret !== g.point.secret);
  assert.equal((await device(g, 'X-TAG', { secret: g.point.secret })).status, 404);
});

// ------------------------------------------------------------------------------------------------------------------ event gate + accreditation
test('event gate: the accreditation engine decides live; a revoked badge stops at once; each pass works once', async () => {
  const org = await signup(['organizer']), athlete = await signup(['athlete']), guard = await signup(['coach']), stranger = await signup();
  const ev = ok(await api('POST', '/events', { token: org.token, body: { name: `Gate Cup ${n}`, sport: 'football', starts_on: addDays(today, -1), ends_on: addDays(today, 2) } }), 201);
  const zone = ok(await api('POST', `/events/${ev.id}/accreditation/zones`, { token: org.token, body: { name: 'Field of play', kind: 'field_of_play' } }), 201);
  const cat = ok(await api('POST', `/events/${ev.id}/accreditation/categories`, { token: org.token, body: { name: 'Athlete', eligible: ['athlete'], zone_ids: [zone.id], self_apply: true } }), 201);
  const e = ok(await api('POST', `/events/${ev.id}/entries`, { token: athlete.token }), 201);
  ok(await api('PATCH', `/entries/${e.id}`, { token: org.token, body: { status: 'accepted' } }));
  const app = ok(await api('POST', `/accreditation/categories/${cat.id}/apply`, { token: athlete.token }), 201);
  ok(await api('POST', `/accreditations/${app.id}/decision`, { token: org.token, body: { decision: 'approve' } }));
  const role = ok(await api('POST', `/events/${ev.id}/staff-roles`, { token: org.token, body: { role: 'security' } }), 201);
  const inv = ok(await api('POST', `/staff-roles/${role.id}/invite`, { token: org.token, body: { user_id: guard.id } }), 201);
  ok(await api('POST', `/staff-assignments/${inv.id}/respond`, { token: guard.token, body: { accept: true } }));

  assert.equal((await api('POST', '/access/points', { token: guard.token, body: { event_id: ev.id, name: 'North gate', provider: 'manual' } })).status, 403, 'organiser only');
  const pt = ok(await api('POST', '/access/points', { token: org.token, body: { event_id: ev.id, zone_id: zone.id, name: 'North gate', kind: 'gate', provider: 'manual' } }), 201);
  assert.equal(ok(await api('GET', '/access/points', { token: guard.token, query: { event_id: ev.id } })).length, 1, 'gate staff see it');
  const myPass = ok(await api('GET', '/access/pass', { token: athlete.token, query: { domain: 'event_gate', subject_ref: pt.id } }));
  assert.equal((await capture(athlete, { domain: 'event_gate', subject_ref: pt.id, method: 'qr', token: myPass.token })).status, 403);
  const hit = ok(await capture(guard, { domain: 'event_gate', subject_ref: pt.id, method: 'qr', token: myPass.token }), 201);
  assert.equal(hit.capture.verdict, 'granted');
  assert.ok(hit.capture.canonical_ref.startsWith('accreditation_scans:'));
  assert.equal((await pool.query("SELECT result, zone_id FROM accreditation_scans WHERE event_id=$1", [ev.id])).rows[0].zone_id, zone.id, 'the accreditation scan log is the canonical record');
  assert.equal(ok(await capture(guard, { domain: 'event_gate', subject_ref: pt.id, method: 'qr', token: myPass.token }), 201).capture.reason_code, 'qr_replay');
  // by tag as well
  ok(await api('POST', '/access/credentials', { token: athlete.token, body: { kind: 'nfc', provider: 'acme', identifier: 'EVENT-WRISTBAND-1' } }), 201);
  const tag = (extra = {}) => capture(guard, { domain: 'event_gate', subject_ref: pt.id, method: 'nfc', provider: 'acme', credential: 'EVENT-WRISTBAND-1', ...extra });
  assert.equal(ok(await tag(), 201).capture.verdict, 'granted');
  assert.equal(ok(await tag({ direction: 'out' }), 201).capture.verdict, 'granted');
  // the organiser revokes: the next presentation is refused at once, and reported
  ok(await api('POST', `/accreditations/${app.id}/access`, { token: org.token, body: { action: 'revoke', reason: 'conduct' } }));
  const refused = ok(await tag(), 201);
  assert.equal(refused.capture.verdict, 'denied');
  assert.equal(refused.capture.reason_code, 'revoked');
  assert.ok((await anomalies('event_id=$1 AND kind=$2', ev.id, 'accreditation_cancelled')).length >= 1);
  const rep = ok(await api('GET', '/access/report', { token: org.token, query: { event_id: ev.id } }));
  assert.equal(rep.final.source, 'accreditation_scans');
  assert.equal((await api('GET', '/access/report', { token: stranger.token, query: { event_id: ev.id } })).status, 403);
  assert.equal(ok(await capture(guard, { domain: 'event_gate', subject_ref: pt.id, method: 'nfc', provider: 'acme', credential: 'NOBODY' }), 201).capture.reason_code, 'credential_unknown');
});

// ------------------------------------------------------------------------------------------------------------------ reporting + MCP
test('report: evidence and final attendance are separate layers; scope is enforced; MCP exposes the same capabilities', async () => {
  const a = await academy({ athletes: 3 });
  const sid = await liveSession(a);
  const [p0, p1] = a.players;
  ok(await scanPass(a.coach, sid, ok(await pass(p0, sid)).token), 201);
  ok(await scanPass(a.coach, sid, 'GQ1.nonsense'), 201);
  ok(await api('POST', `/academy/sessions/${sid}/attendance`, { token: a.coach.token, body: { entries: [{ user_id: p1.id, status: 'absent' }] } }));
  const rep = ok(await api('GET', '/access/report', { token: a.owner.token, query: { organisation_id: a.org.id } }));
  assert.equal(rep.evidence.total, 2);
  assert.ok(rep.evidence.by_verdict.some((v) => v.verdict === 'denied') && rep.evidence.by_verdict.some((v) => v.verdict === 'recorded'));
  assert.equal(rep.final.source, 'academy_attendance');
  assert.equal(rep.final.by_status.present, 1);
  assert.equal(rep.final.by_status.absent, 1);
  assert.equal(rep.final.no_show_rate, 50, 'no-shows come from the canonical marks, not from scans');
  assert.ok(rep.note.includes('canonical'));
  assert.equal((await api('GET', '/access/report', { token: a.stranger.token, query: { organisation_id: a.org.id } })).status, 404);
  assert.equal((await api('GET', '/access/report', { token: a.owner.token, query: { organisation_id: a.org.id, venue_id: sid } })).status, 400, 'one scope at a time');
  const one = ok(await api('GET', '/access/report', { token: a.coach.token, query: { domain: 'academy_session', subject_ref: sid } }));
  assert.equal(one.final.by_status.present, 1);
  const options = ok(await api('GET', '/access/options', { token: a.coach.token }));
  assert.ok(options.providers.some((p) => p.key === 'webhook') && options.messages.qr_replay);
  // MCP
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${a.coach.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  const tools = (await r.json()).result.tools.map((t) => t.name);
  for (const name of ['record_access_capture', 'get_access_pass', 'get_access_site_code', 'sync_access_captures', 'register_access_credential', 'create_access_point', 'issue_access_grant', 'get_access_report', 'list_access_anomalies']) assert.ok(tools.includes(name), name);
});
