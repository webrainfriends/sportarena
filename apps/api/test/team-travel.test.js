// Team & delegation travel operations (#485): trips over canonical events/teams/people, the travel party, itinerary, rooming, documents,
// youth trip consent, history, money and audience-safe reports. Real PostgreSQL, real HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const rpc = async (method, params, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `tv_${n}_${roles[0]}`, display_name: `Trav ${n}`, email: `tv${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const kid = (age = 14) => signup(['athlete'], { dob: yearsAgo(age) });
const evidence = { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' };
async function verifiedGuardian(parent, child) {
  const l = must(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: child.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
}
const addTo = (teamId, user, role = 'player') => pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,$3,'active') ON CONFLICT (team_id, user_id) DO UPDATE SET status='active', role=$3", [teamId, user.id, role]);
const inDays = (d, h = 9) => { const x = new Date(Date.now() + d * 864e5); x.setUTCHours(h, 0, 0, 0); return x; };
const iso = (d, h) => inDays(d, h).toISOString();
/** An ISO instant written with the +05:30 offset of Asia/Kolkata */
const kolkata = (d, h, m = 0) => { const x = inDays(d, h); x.setUTCMinutes(m); const t = new Date(x.getTime() + 330 * 60000); return `${t.toISOString().slice(0, 19)}+05:30`; };
const uniq = () => `key-${Date.now()}-${++n}-${Math.random().toString(36).slice(2, 8)}`;

/** a club: manager (team owner), team, event they are entered in, and a trip over it */
async function club() {
  const mgr = await signup(['organizer', 'athlete']);
  const team = must(await api('POST', '/teams', { token: mgr.token, body: { name: `Travel FC ${++n}`, sport: 'football' } }), 201);
  const host = await signup(['organizer']);
  const ev = must(await api('POST', '/events', { token: host.token, body: { name: `Away Cup ${n}`, sport: 'football', starts_on: iso(10).slice(0, 10), ends_on: iso(12).slice(0, 10) } }), 201);
  const rival = must(await api('POST', '/teams', { token: host.token, body: { name: `Rivals ${n}`, sport: 'football' } }), 201);
  await pool.query("INSERT INTO event_entries(event_id, team_id, status) VALUES ($1,$2,'accepted')", [ev.id, team.id]);
  const fx = (await pool.query('INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at) VALUES ($1,$2,$3,$4) RETURNING *', [ev.id, rival.id, team.id, iso(11, 14)])).rows[0];
  const trip = must(await api('POST', '/trips', { token: mgr.token, body: {
    name: `Away Cup trip ${n}`, team_id: team.id, origin: 'Mumbai', destination: 'Delhi', timezone: 'Asia/Kolkata', depart_at: kolkata(9, 3), return_at: kolkata(13, 15),
    event_ids: [ev.id], fixture_ids: [fx.id], idempotency_key: uniq(),
  } }), 201);
  return { mgr, team, host, ev, fx, trip, rival };
}

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('tv_root','tv_root','{admin}','x','x','tv_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('a trip links canonical events and fixtures, is idempotent, and is invisible to outsiders', async () => {
  const { mgr, team, ev, fx, trip, host } = await club();
  assert.equal(trip.status, 'planning');
  assert.equal(trip.manager_id, mgr.id);
  const detail = must(await api('GET', `/trips/${trip.id}`, { token: mgr.token }));
  assert.equal(detail.events.length, 2); // the event and the fixture, referenced not copied
  assert.ok(detail.events.some((l) => l.fixture_id === fx.id && l.event_id === ev.id));
  assert.ok(detail.party.some((p) => p.user_id === mgr.id && p.role === 'manager' && p.status === 'confirmed'));
  assert.equal((await pool.query('SELECT count(*)::int AS c FROM fixtures WHERE event_id=$1', [ev.id])).rows[0].c, 1); // nothing copied
  // same idempotency key returns the same trip
  const key = uniq();
  const body = { name: 'Idem', team_id: team.id, origin: 'A', destination: 'B', timezone: 'Asia/Kolkata', depart_at: kolkata(20, 3), return_at: kolkata(22, 3), idempotency_key: key };
  const a = must(await api('POST', '/trips', { token: mgr.token, body }), 201), b = must(await api('POST', '/trips', { token: mgr.token, body }), 201);
  assert.equal(a.id, b.id);
  // places: a country from the ISO list and a map point (from Google / Apple Maps) are validated; filter trips by destination country
  const placed = { ...body, idempotency_key: uniq(), destination: 'Dubai', destination_country: 'AE', destination_lat: 25.2048, destination_lng: 55.2708, origin_country: 'IN' };
  const pt = must(await api('POST', '/trips', { token: mgr.token, body: placed }), 201);
  assert.equal(pt.destination_country, 'AE'); assert.equal(pt.destination_lat, 25.2048);
  assert.equal((await api('POST', '/trips', { token: mgr.token, body: { ...placed, idempotency_key: uniq(), destination_country: 'ZZ' } })).status, 400);
  assert.equal((await api('POST', '/trips', { token: mgr.token, body: { ...placed, idempotency_key: uniq(), destination_lng: undefined } })).status, 400);
  assert.equal((await api('POST', '/trips', { token: mgr.token, body: { ...placed, idempotency_key: uniq(), destination_lat: 123 } })).status, 400);
  assert.deepEqual(must(await api('GET', '/trips', { token: mgr.token, query: { country: 'AE' } })).map((t) => t.id), [pt.id]);
  const moved = must(await api('PATCH', `/trips/${pt.id}`, { token: mgr.token, body: { row_version: pt.row_version, destination_country: 'GB', destination_lat: 51.5, destination_lng: -0.12, destination: 'London' } }));
  assert.equal(moved.destination_country, 'GB');
  // outsiders: 404 (existence not leaked), cannot create on someone else's team or link an event they are not part of
  const stranger = await signup(['athlete']);
  assert.equal((await api('GET', `/trips/${trip.id}`, { token: stranger.token })).status, 404);
  assert.equal((await api('POST', '/trips', { token: stranger.token, body: { ...body, idempotency_key: uniq() } })).status, 404);
  const otherEv = must(await api('POST', '/events', { token: (await signup(['organizer'])).token, body: { name: 'Unrelated', sport: 'football' } }), 201);
  assert.equal((await api('POST', `/trips/${trip.id}/events`, { token: mgr.token, body: { event_id: otherEv.id } })).status, 404);
  assert.equal((await api('POST', `/trips/${trip.id}/events`, { token: stranger.token, body: { event_id: ev.id } })).status, 404);
  // the organiser of the event is not thereby a trip manager
  assert.equal((await api('GET', `/trips/${trip.id}`, { token: host.token })).status, 404);
  // unlink keeps history and leaves the fixture alone
  const link = detail.events.find((l) => l.fixture_id === fx.id);
  must(await api('POST', `/trips/${trip.id}/events/${link.id}/unlink`, { token: mgr.token }));
  assert.equal(must(await api('GET', `/trips/${trip.id}`, { token: mgr.token })).events.length, 1);
  assert.equal((await pool.query('SELECT status FROM fixtures WHERE id=$1', [fx.id])).rows[0].status, 'scheduled');
  assert.ok((await pool.query("SELECT 1 FROM trip_changes WHERE trip_id=$1 AND action='unlinked'", [trip.id])).rowCount);
  assert.ok(must(await api('GET', '/trips', { token: mgr.token })).some((t) => t.id === trip.id));
  assert.equal(must(await api('GET', '/trips', { token: stranger.token })).length, 0);
});

test('the travel party comes from canonical records and is distinct from team membership', async () => {
  const { mgr, team, trip } = await club();
  const p1 = await signup(['athlete']), outsider = await signup(['athlete']), coach = await signup(['coach']);
  await addTo(team.id, p1); await addTo(team.id, coach, 'coach');
  // being on the team does not put you on the trip
  assert.equal(must(await api('GET', `/trips/${trip.id}`, { token: mgr.token })).party.some((p) => p.user_id === p1.id), false);
  assert.equal((await api('GET', `/trips/${trip.id}`, { token: p1.token })).status, 404);
  const cands = must(await api('GET', `/trips/${trip.id}/candidates`, { token: mgr.token }));
  assert.ok(cands.some((c) => c.user_id === p1.id && c.suggested_role === 'athlete') && cands.some((c) => c.user_id === coach.id && c.suggested_role === 'coach'));
  assert.ok(!cands.some((c) => c.user_id === outsider.id));
  // a stranger to every canonical record cannot be invited, a guest only if the trip allows it
  assert.equal((await api('POST', `/trips/${trip.id}/party`, { token: mgr.token, body: { user_id: outsider.id, role: 'athlete' } })).status, 400);
  assert.equal((await api('POST', `/trips/${trip.id}/party`, { token: mgr.token, body: { user_id: outsider.id, role: 'guest' } })).status, 409);
  assert.equal((await api('POST', `/trips/${trip.id}/party`, { token: p1.token, body: { user_id: outsider.id, role: 'guest' } })).status, 404);
  const inv = must(await api('POST', `/trips/${trip.id}/party`, { token: mgr.token, body: { user_id: p1.id, role: 'athlete' } }), 201);
  assert.equal(inv.status, 'invited'); assert.equal(inv.basis, 'team_roster');
  assert.equal((await api('POST', `/trips/${trip.id}/party`, { token: mgr.token, body: { user_id: p1.id, role: 'athlete' } })).status, 409);
  // invited: sees the trip, can confirm, and now shows in the party
  assert.ok(must(await api('GET', '/notifications', { token: p1.token })).items.some((x) => x.kind === 'trip_invitation'));
  assert.equal(must(await api('POST', `/trips/${trip.id}/party/respond`, { token: p1.token, body: { response: 'confirm' } })).status, 'confirmed');
  assert.equal((await api('POST', `/trips/${trip.id}/party/respond`, { token: p1.token, body: { response: 'decline' } })).status, 409);
  must(await api('PATCH', `/trips/${trip.id}`, { token: mgr.token, body: { row_version: trip.row_version, allow_guests: true } }));
  must(await api('POST', `/trips/${trip.id}/party`, { token: mgr.token, body: { user_id: outsider.id, role: 'guest' } }), 201);
  // a traveller cannot edit the trip
  assert.equal((await api('PATCH', `/trips/${trip.id}`, { token: p1.token, body: { row_version: 2, name: 'Mine now' } })).status, 403);
});

test('time zones are checked, legs are versioned, and a change tells only the people on that leg', async () => {
  const { mgr, team, trip } = await club();
  const a = await signup(['athlete']), b = await signup(['athlete']);
  for (const u of [a, b]) { await addTo(team.id, u); must(await api('POST', `/trips/${trip.id}/party`, { token: mgr.token, body: { user_id: u.id, role: 'athlete' } }), 201); must(await api('POST', `/trips/${trip.id}/party/respond`, { token: u.token, body: { response: 'confirm' } })); }
  const party = must(await api('GET', `/trips/${trip.id}`, { token: mgr.token })).party;
  const pa = party.find((p) => p.user_id === a.id).id, pb = party.find((p) => p.user_id === b.id).id;
  const leg = { mode: 'air', provider: 'Some Air', reference: 'AB123', origin: 'Mumbai', destination: 'Dubai', depart_at: kolkata(9, 3), depart_tz: 'Asia/Kolkata', arrive_at: `${iso(9, 12).slice(0, 19)}+04:00`, arrive_tz: 'Asia/Dubai' };
  // the written offset must be the zone's real offset
  const bad = await api('POST', `/trips/${trip.id}/segments`, { token: mgr.token, body: { ...leg, depart_at: `${iso(9, 3).slice(0, 19)}+01:00`, passenger_ids: [pa] } });
  assert.equal(bad.status, 400); assert.match(bad.body.message ?? bad.body.error?.message ?? JSON.stringify(bad.body), /Asia\/Kolkata/);
  assert.equal((await api('POST', `/trips/${trip.id}/segments`, { token: mgr.token, body: { ...leg, depart_tz: 'Mars/Olympus', passenger_ids: [] } })).status, 400);
  // arrival "before" departure by clock time but after as an instant is fine; before as an instant is not
  assert.equal((await api('POST', `/trips/${trip.id}/segments`, { token: mgr.token, body: { ...leg, arrive_at: kolkata(9, 2), arrive_tz: 'Asia/Kolkata' } })).status, 400);
  const seg = must(await api('POST', `/trips/${trip.id}/segments`, { token: mgr.token, body: { ...leg, passenger_ids: [pa] } }), 201);
  assert.equal(seg.row_version, 1);
  assert.equal(seg.reference_info.verified, false);
  assert.equal(seg.reference_info.source, 'external');
  assert.match(seg.reference_info.label, /not verified|has not verified/i);
  assert.equal((await api('POST', `/trips/${trip.id}/segments`, { token: mgr.token, body: { ...leg, svc_order_id: '00000000-0000-0000-0000-000000000000' } })).status, 404);
  // a traveller cannot edit; a stale version is refused
  assert.equal((await api('PATCH', `/trips/${trip.id}/segments/${seg.id}`, { token: a.token, body: { row_version: 1, change_note: 'x1', status: 'delayed' } })).status, 403);
  const delayed = must(await api('PATCH', `/trips/${trip.id}/segments/${seg.id}`, { token: mgr.token, body: { row_version: 1, change_note: 'Two hour delay', status: 'delayed', depart_at: kolkata(9, 5), depart_tz: 'Asia/Kolkata' } }));
  assert.equal(delayed.row_version, 2); assert.equal(delayed.status, 'delayed');
  assert.equal((await api('PATCH', `/trips/${trip.id}/segments/${seg.id}`, { token: mgr.token, body: { row_version: 1, change_note: 'stale edit', note: 'x' } })).status, 409);
  // only the affected traveller was told; the other was not; the history keeps both versions
  assert.ok(must(await api('GET', '/notifications', { token: a.token })).items.some((x) => x.kind === 'trip_change' && /delayed/.test(x.title)));
  assert.ok(!must(await api('GET', '/notifications', { token: b.token })).items.some((x) => x.kind === 'trip_change' && /delayed/.test(x.title)));
  const hist = must(await api('GET', `/trips/${trip.id}/changes`, { token: mgr.token }));
  assert.ok(hist.filter((h) => h.entity === 'segment').length >= 2);
  assert.equal(must(await api('GET', `/trips/${trip.id}/changes`, { token: b.token })).filter((h) => h.entity === 'segment').length, 0);
  // itinerary is scoped: b is on no leg, a sees theirs, the manager sees all
  assert.equal(must(await api('GET', `/trips/${trip.id}/itinerary`, { token: b.token })).length, 0);
  const mine = must(await api('GET', `/trips/${trip.id}/itinerary`, { token: a.token }));
  assert.equal(mine.length, 1); assert.match(mine[0].depart_local, /\d/); assert.equal(mine[0].arrive_tz, 'Asia/Dubai');
  // history is append-only at the database
  await assert.rejects(pool.query('UPDATE trip_changes SET note=$1 WHERE trip_id=$2', ['edited', trip.id]), /append-only/);
  // impact view reads fixtures but never edits them
  const impact = must(await api('GET', `/trips/${trip.id}/impact`, { token: mgr.token, query: { segment_id: seg.id, buffer_hours: 24 * 5 } }));
  assert.ok(impact.fixtures_at_risk.length >= 1); assert.match(impact.note, /never modify a fixture/);
  assert.equal((await api('GET', `/trips/${trip.id}/impact`, { token: a.token, query: { segment_id: seg.id } })).status, 403);
  // withdrawing with a replacement moves the leg across and keeps the history
  const c2 = await signup(['athlete']); await addTo(team.id, c2);
  const w = must(await api('POST', `/trips/${trip.id}/party/${pa}/withdraw`, { token: mgr.token, body: { reason: 'Injured', replacement_user_id: c2.id } }));
  assert.equal(w.segments_released, 1); assert.equal(w.withdrawn.status, 'replaced');
  assert.equal(must(await api('GET', `/trips/${trip.id}/itinerary`, { token: c2.token })).length, 1);
  assert.equal((await api('GET', `/trips/${trip.id}`, { token: a.token })).status, 404);
});

test('young travellers: trip-specific guardian consent, masked names, chaperone, safeguarding rooms and private rooming', async () => {
  const { mgr, team, trip } = await club();
  const child = await kid(), buddy = await kid(13), parent = await signup(['athlete'], { dob: yearsAgo(40) }), other = await signup(['athlete']);
  await verifiedGuardian(parent, child);
  for (const u of [child, buddy, other]) await addTo(team.id, u);
  // a young person can travel only as an athlete
  assert.equal((await api('POST', `/trips/${trip.id}/party`, { token: mgr.token, body: { user_id: child.id, role: 'chaperone' } })).status, 400);
  must(await api('POST', `/trips/${trip.id}/party`, { token: mgr.token, body: { user_id: child.id, role: 'athlete' } }), 201);
  must(await api('POST', `/trips/${trip.id}/party`, { token: mgr.token, body: { user_id: buddy.id, role: 'athlete' } }), 201);
  must(await api('POST', `/trips/${trip.id}/party`, { token: mgr.token, body: { user_id: other.id, role: 'athlete' } }), 201);
  must(await api('POST', `/trips/${trip.id}/party/respond`, { token: other.token, body: { response: 'confirm' } }));
  const party = must(await api('GET', `/trips/${trip.id}`, { token: mgr.token })).party;
  const pc = party.find((p) => p.user_id === child.id).id, pbuddy = party.find((p) => p.user_id === buddy.id).id, pother = party.find((p) => p.user_id === other.id).id;
  // the child cannot confirm for themselves; the guardian is told and the manager's readiness shows the gap
  const self = await api('POST', `/trips/${trip.id}/party/respond`, { token: child.token, body: { response: 'confirm' } });
  assert.equal(self.status, 409); assert.equal(self.body.details?.code ?? self.body.error?.details?.code ?? 'guardian_consent_required', 'guardian_consent_required');
  assert.ok(must(await api('GET', '/notifications', { token: parent.token })).items.some((x) => x.kind === 'trip_invitation'));
  assert.ok(must(await api('GET', `/trips/${trip.id}/readiness`, { token: mgr.token })).find((r) => r.participant_id === pc).issues.some((i) => i.code === 'guardian_travel_consent'));
  // general participation consent is NOT travel consent
  assert.equal((await api('POST', `/youth/children/${child.id}/consents`, { token: parent.token, body: { purpose: 'participation' } })).status < 300, true);
  assert.ok(must(await api('GET', `/trips/${trip.id}/readiness`, { token: mgr.token })).find((r) => r.participant_id === pc).issues.some((i) => i.code === 'guardian_travel_consent'));
  // only a verified guardian can decide; a bystander, the manager and the child cannot
  for (const u of [other, mgr, child]) assert.ok([403, 404].includes((await api('POST', `/trips/${trip.id}/party/${pc}/consent`, { token: u.token, body: { decision: 'grant' } })).status));
  // cannot confirm the trip with young travellers and no adult chaperone besides the manager? the manager counts; make the check explicit
  must(await api('POST', `/trips/${trip.id}/party/${pc}/consent`, { token: parent.token, body: { decision: 'grant', emergency_contact_ok: true } }));
  assert.equal((await api('POST', `/trips/${trip.id}/party/${pc}/consent`, { token: parent.token, body: { decision: 'grant' } })).status, 409);
  const after = must(await api('GET', `/trips/${trip.id}`, { token: mgr.token })).party.find((p) => p.id === pc);
  assert.equal(after.status, 'confirmed'); assert.equal(after.young, true);
  assert.ok(!must(await api('GET', `/trips/${trip.id}/readiness`, { token: mgr.token })).find((r) => r.participant_id === pc).issues.some((i) => i.code === 'guardian_travel_consent'));
  // other travellers never see young travellers' names; staff and the child's guardian do
  const seenByOther = must(await api('GET', `/trips/${trip.id}`, { token: other.token })).party;
  assert.ok(seenByOther.filter((p) => p.id === pc || p.id === pbuddy).every((p) => p.masked && p.display_name === 'Young traveller'));
  assert.equal(must(await api('GET', `/trips/${trip.id}`, { token: parent.token })).party.find((p) => p.id === pc).display_name, child.display_name);
  assert.equal(must(await api('GET', `/trips/${trip.id}`, { token: parent.token })).party.find((p) => p.id === pbuddy).display_name, 'Young traveller');
  // rooming safeguarding: a young traveller cannot share with an unrelated adult
  const stay = must(await api('POST', `/trips/${trip.id}/stays`, { token: mgr.token, body: { property_name: 'Team Hotel', check_in_at: kolkata(9, 8), check_out_at: kolkata(13, 6), tz: 'Asia/Kolkata', status: 'booked', reference: 'HTL-9' } }), 201);
  assert.equal(stay.reference_info.verified, false);
  const rooms = must(await api('POST', `/trips/${trip.id}/stays/${stay.id}/rooms`, { token: mgr.token, body: { room_type: 'twin', capacity: 2, count: 2 } }), 201);
  must(await api('POST', `/trips/${trip.id}/rooms/${rooms[0].id}/assign`, { token: mgr.token, body: { participant_id: pother } }));
  const clash = await api('POST', `/trips/${trip.id}/rooms/${rooms[0].id}/assign`, { token: mgr.token, body: { participant_id: pc } });
  assert.equal(clash.status, 409); assert.match(JSON.stringify(clash.body), /safeguarding/i);
  must(await api('POST', `/trips/${trip.id}/rooms/${rooms[1].id}/assign`, { token: mgr.token, body: { participant_id: pc } }));
  assert.equal((await api('POST', `/trips/${trip.id}/rooms/${rooms[1].id}/assign`, { token: mgr.token, body: { participant_id: pother } })).status, 409); // already roomed elsewhere / safeguarding
  // capacity
  must(await api('POST', `/trips/${trip.id}/party/${pbuddy}/consent`, { token: (await (async () => { const p2 = await signup(['athlete'], { dob: yearsAgo(41) }); await verifiedGuardian(p2, buddy); return p2; })()).token, body: { decision: 'grant' } }));
  must(await api('POST', `/trips/${trip.id}/rooms/${rooms[1].id}/assign`, { token: mgr.token, body: { participant_id: pbuddy } }));
  const third = await signup(['athlete']); await addTo(team.id, third);
  const pthird = must(await api('POST', `/trips/${trip.id}/party`, { token: mgr.token, body: { user_id: third.id, role: 'athlete' } }), 201).id;
  assert.equal((await api('POST', `/trips/${trip.id}/rooms/${rooms[1].id}/assign`, { token: mgr.token, body: { participant_id: pthird } })).status, 409);
  // rooming views: the child sees no room number or roommate; the guardian sees the room; an adult traveller sees nothing of the young travellers' room; staff see all
  const childView = must(await api('GET', `/trips/${trip.id}/rooming`, { token: child.token }));
  assert.equal(childView.length, 1); assert.ok(childView[0].rooms.every((r) => r.label === null && r.occupants.length === 0));
  const otherView = must(await api('GET', `/trips/${trip.id}/rooming`, { token: other.token }));
  assert.ok(otherView.every((s) => s.rooms.every((r) => r.occupants.every((o) => o.display_name !== child.display_name && o.display_name !== buddy.display_name))));
  const staffView = must(await api('GET', `/trips/${trip.id}/rooming`, { token: mgr.token }));
  assert.ok(staffView[0].rooms.some((r) => r.occupants.some((o) => o.young)));
  assert.equal(must(await api('GET', `/trips/${trip.id}/rooming`, { token: parent.token })).length, 1);
  // revoking consent returns the child to invited and tells the manager; the trip cannot then be confirmed by an approver until chaperone rule is met
  must(await api('POST', `/trips/${trip.id}/party/${pc}/consent`, { token: parent.token, body: { decision: 'revoke' } }));
  assert.equal(must(await api('GET', `/trips/${trip.id}`, { token: mgr.token })).party.find((p) => p.id === pc).status, 'invited');
  // emergency contact: staff only, window-limited, names only, audited
  assert.equal((await api('GET', `/trips/${trip.id}/party/${pc}/emergency`, { token: other.token })).status, 403);
  assert.equal((await api('GET', `/trips/${trip.id}/party/${pc}/emergency`, { token: mgr.token })).status, 409); // trip is days away
});

test('passport and visa data is minimised, encrypted, revealed only to the holder and absent from notifications and history', async () => {
  const { mgr, team, trip } = await club();
  must(await api('PATCH', `/trips/${trip.id}`, { token: mgr.token, body: { row_version: trip.row_version, documents_required: true } }));
  const a = await signup(['athlete']); await addTo(team.id, a);
  const pa = must(await api('POST', `/trips/${trip.id}/party`, { token: mgr.token, body: { user_id: a.id, role: 'athlete' } }), 201).id;
  must(await api('POST', `/trips/${trip.id}/party/respond`, { token: a.token, body: { response: 'confirm' } }));
  const NUMBER = 'ZX9988776', REF = 'drive-scan-secret-55';
  // staff may set status and expiry but not the identifier
  assert.equal((await api('POST', `/trips/${trip.id}/party/${pa}/documents/passport`, { token: mgr.token, body: { status: 'held', expires_on: '2099-01-01', number: NUMBER } })).status, 403);
  assert.equal((await api('POST', `/trips/${trip.id}/party/${pa}/documents/passport`, { token: mgr.token, body: { status: 'flying' } })).status, 400);
  must(await api('POST', `/trips/${trip.id}/party/${pa}/documents/visa`, { token: mgr.token, body: { status: 'not_required' } }));
  // short-dated passport: flagged, and the holder is notified without any number
  const doc = must(await api('POST', `/trips/${trip.id}/party/${pa}/documents/passport`, { token: a.token, body: { status: 'held', expires_on: iso(15).slice(0, 10), number: NUMBER, evidence_ref: REF } }));
  assert.equal(doc.has_number, true); assert.equal(doc.expires_too_soon, true); assert.ok(!JSON.stringify(doc).includes(NUMBER));
  assert.ok(must(await api('GET', `/trips/${trip.id}/readiness`, { token: mgr.token })).find((r) => r.participant_id === pa).issues.some((i) => i.code === 'passport_expiry'));
  const raw = (await pool.query('SELECT number_enc, evidence_ref_enc FROM trip_documents WHERE participant_id=$1 AND kind=$2', [pa, 'passport'])).rows[0];
  assert.ok(!raw.number_enc.includes(NUMBER) && !raw.evidence_ref_enc.includes(REF));
  // the sweep re-checks passports against the trip's current dates and tells the right people, once, without any number
  const sweeps = await import('../src/trips-sweeps.js');
  must(await api('PATCH', `/trips/${trip.id}`, { token: mgr.token, body: { row_version: (await pool.query('SELECT row_version FROM trips WHERE id=$1', [trip.id])).rows[0].row_version, passport_min_months: 24 } }));
  must(await api('POST', `/trips/${trip.id}/party/${pa}/documents/passport`, { token: a.token, body: { status: 'held', expires_on: iso(400).slice(0, 10) } }));
  const first = await sweeps.remindPassports(), again = await sweeps.remindPassports();
  assert.ok(first >= 1); assert.equal(again, 0);
  assert.ok(!JSON.stringify(must(await api('GET', '/notifications', { token: a.token }))).includes(NUMBER));
  // the number never reaches notifications, history, compliance lists or reports
  for (const t of [a, mgr]) assert.ok(!JSON.stringify(must(await api('GET', '/notifications', { token: t.token })).items).includes(NUMBER));
  assert.ok(!JSON.stringify((await pool.query('SELECT snapshot, note FROM trip_changes WHERE trip_id=$1', [trip.id])).rows).includes(NUMBER));
  assert.ok(!JSON.stringify(must(await api('GET', `/trips/${trip.id}/compliance`, { token: mgr.token }))).includes(NUMBER));
  // only the holder reveals it, and it is audited; staff get 404
  assert.equal((await api('GET', `/trips/${trip.id}/party/${pa}/documents/passport/reveal`, { token: mgr.token })).status, 404);
  const rev = must(await api('GET', `/trips/${trip.id}/party/${pa}/documents/passport/reveal`, { token: a.token }));
  assert.equal(rev.number, NUMBER); assert.equal(rev.evidence_ref, REF);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='reveal_trip_document' AND actor_id=$1", [a.id])).rowCount);
  // a bystander on another team's trip cannot even see the list
  const out = await signup(['athlete']);
  assert.equal((await api('GET', `/trips/${trip.id}/compliance`, { token: out.token })).status, 404);
});

test('status, approval and chaperone rules; per diem keeps entitlement, claim, payment and balance apart; money is idempotent', async () => {
  const { mgr, team, trip, ev } = await club();
  const owner = mgr; // team owner approves
  const a = await signup(['athlete']), c = await kid();
  const parent = await signup(['athlete'], { dob: yearsAgo(38) }); await verifiedGuardian(parent, c);
  await addTo(team.id, a); await addTo(team.id, c);
  const pa = must(await api('POST', `/trips/${trip.id}/party`, { token: mgr.token, body: { user_id: a.id, role: 'athlete' } }), 201).id;
  must(await api('POST', `/trips/${trip.id}/party/respond`, { token: a.token, body: { response: 'confirm' } }));
  const pc = must(await api('POST', `/trips/${trip.id}/party`, { token: mgr.token, body: { user_id: c.id, role: 'athlete' } }), 201).id;
  must(await api('POST', `/trips/${trip.id}/party/${pc}/consent`, { token: parent.token, body: { decision: 'grant' } }));
  assert.equal((await api('POST', `/trips/${trip.id}/status`, { token: mgr.token, body: { to: 'completed' } })).status, 409);
  assert.equal((await api('POST', `/trips/${trip.id}/status`, { token: mgr.token, body: { to: 'cancelled' } })).status, 400); // a reason is required
  must(await api('POST', `/trips/${trip.id}/status`, { token: mgr.token, body: { to: 'approval_pending' } }));
  assert.equal(must(await api('POST', `/trips/${trip.id}/status`, { token: owner.token, body: { to: 'confirmed' } })).status, 'confirmed');
  // a participant cannot change status
  assert.equal((await api('POST', `/trips/${trip.id}/status`, { token: a.token, body: { to: 'in_progress' } })).status, 403);
  // per diem: proposal pays nobody, unapproved is not payable
  const pol = must(await api('POST', `/trips/${trip.id}/perdiem`, { token: mgr.token, body: { currency: 'INR', daily_minor: 50000, roles: ['athlete'] } }), 201);
  assert.equal(pol.approved_at, null);
  const pay = (kind, who, amount, extra = {}) => api('POST', `/trips/${trip.id}/payments`, { token: mgr.token, body: { participant_id: who, kind, amount_minor: amount, currency: 'INR', idempotency_key: uniq(), ...extra } });
  assert.equal((await pay('per_diem', pa, 1000)).status, 409);
  assert.equal((await api('POST', `/trips/${trip.id}/perdiem/approve`, { token: a.token })).status, 403);
  must(await api('POST', `/trips/${trip.id}/perdiem/approve`, { token: owner.token }));
  const fin = must(await api('GET', `/trips/${trip.id}/finance`, { token: mgr.token }));
  const row = fin.travellers.find((t) => t.participant_id === pa);
  assert.equal(row.entitlement.days, 5); assert.equal(row.entitlement.amount_minor, 250000);
  assert.equal(row.per_diem_paid_minor, 0); assert.equal(row.per_diem_balance_minor, 250000); // entitled, nothing paid
  // paying more than the entitlement is refused; idempotent key never double-records
  assert.equal((await pay('per_diem', pa, 300000)).status, 409);
  const key = uniq();
  const p1 = must(await pay('per_diem', pa, 100000, { idempotency_key: key }), 201), p2 = must(await pay('per_diem', pa, 100000, { idempotency_key: key }), 201);
  assert.equal(p1.id, p2.id);
  must(await pay('advance', pa, 20000), 201);
  // claims: a traveller claims for self only; a claim is not money
  const claimBody = (k) => ({ category: 'meals', description: 'Team dinner', amount_minor: 45000, currency: 'INR', incurred_on: iso(10).slice(0, 10), receipt_ref: 'receipt-777', idempotency_key: k });
  const k = uniq();
  const cl = must(await api('POST', `/trips/${trip.id}/claims`, { token: a.token, body: claimBody(k) }), 201);
  assert.equal(must(await api('POST', `/trips/${trip.id}/claims`, { token: a.token, body: claimBody(k) }), 201).id, cl.id);
  assert.equal((await api('POST', `/trips/${trip.id}/claims`, { token: a.token, body: { ...claimBody(uniq()), participant_id: pc } })).status, 403);
  assert.ok(!(await pool.query('SELECT receipt_ref_enc FROM trip_claims WHERE id=$1', [cl.id])).rows[0].receipt_ref_enc.includes('receipt-777'));
  assert.equal((await api('POST', `/trips/${trip.id}/claims/${cl.id}/reimburse`, { token: mgr.token, body: {} })).status, 409); // not approved yet
  assert.equal((await api('POST', `/trips/${trip.id}/claims/${cl.id}/decide`, { token: a.token, body: { decision: 'approve' } })).status, 403);
  assert.equal((await api('POST', `/trips/${trip.id}/claims/${cl.id}/decide`, { token: mgr.token, body: { decision: 'reject' } })).status, 400);
  must(await api('POST', `/trips/${trip.id}/claims/${cl.id}/decide`, { token: mgr.token, body: { decision: 'approve' } }));
  let st = must(await api('GET', `/trips/${trip.id}/finance`, { token: a.token }));
  assert.equal(st.travellers.length, 1);
  assert.equal(st.travellers[0].claims.approved_minor, 45000); assert.equal(st.travellers[0].claims.reimbursed_minor, 0); assert.equal(st.travellers[0].claims_balance_minor, 45000);
  // reimbursing: ledgered in the canonical event budget when a line is given; idempotent
  const line = (await pool.query("INSERT INTO event_budget_lines(event_id, direction, category, name, planned_cents) VALUES ($1,'expense','transport','Team travel',1000000) RETURNING id", [ev.id])).rows[0];
  assert.equal((await api('POST', `/trips/${trip.id}/claims/${cl.id}/reimburse`, { token: mgr.token, body: { budget_line_id: line.id } })).status, 403); // mgr does not organise the event
  const r1 = must(await api('POST', `/trips/${trip.id}/claims/${cl.id}/reimburse`, { token: mgr.token, body: { reference: 'UPI-1' } })), r2 = must(await api('POST', `/trips/${trip.id}/claims/${cl.id}/reimburse`, { token: mgr.token, body: {} }));
  assert.equal(r1.id, r2.id); assert.equal(r1.source, 'external_record');
  st = must(await api('GET', `/trips/${trip.id}/finance`, { token: mgr.token }));
  const t = st.travellers.find((x) => x.participant_id === pa);
  assert.equal(t.claims.reimbursed_minor, 45000); assert.equal(t.claims_balance_minor, 0); assert.equal(t.per_diem_paid_minor, 100000); assert.equal(t.advances_minor, 20000);
  assert.equal(t.net_due_minor, 250000 + 45000 - 100000 - 45000 - 20000);
  // the organiser posts to the canonical ledger
  // chaperone rule: young traveller + only the manager is fine (the manager is an adult manager)
  must(await api('POST', `/trips/${trip.id}/status`, { token: mgr.token, body: { to: 'in_progress' } }));
  const cost = must(await api('GET', `/trips/${trip.id}/reports/cost`, { token: mgr.token }));
  assert.match(cost.csv, /INR/);
  assert.equal((await api('GET', `/trips/${trip.id}/reports/cost`, { token: a.token })).status, 403);
  must(await api('POST', `/trips/${trip.id}/status`, { token: mgr.token, body: { to: 'completed' } }));
  // a completed trip is read-only
  assert.equal((await api('POST', `/trips/${trip.id}/segments`, { token: mgr.token, body: { mode: 'rail', origin: 'A', destination: 'B', depart_at: kolkata(9, 3), depart_tz: 'Asia/Kolkata', arrive_at: kolkata(9, 6), arrive_tz: 'Asia/Kolkata' } })).status, 409);
});

test('equipment, incidents, the movement board and audience-safe reports', async () => {
  const { mgr, team, trip } = await club();
  const a = await signup(['athlete']), c = await kid(), parent = await signup(['athlete'], { dob: yearsAgo(39) });
  await verifiedGuardian(parent, c); await addTo(team.id, a); await addTo(team.id, c);
  const pa = must(await api('POST', `/trips/${trip.id}/party`, { token: mgr.token, body: { user_id: a.id, role: 'athlete' } }), 201).id;
  must(await api('POST', `/trips/${trip.id}/party/respond`, { token: a.token, body: { response: 'confirm' } }));
  const pc = must(await api('POST', `/trips/${trip.id}/party`, { token: mgr.token, body: { user_id: c.id, role: 'athlete' } }), 201).id;
  const seg = must(await api('POST', `/trips/${trip.id}/segments`, { token: mgr.token, body: { mode: 'coach', origin: 'Mumbai', destination: 'Delhi', depart_at: kolkata(9, 3), depart_tz: 'Asia/Kolkata', arrive_at: kolkata(10, 9), arrive_tz: 'Asia/Kolkata', meeting_point: 'Gate 4', passenger_ids: [pa, pc] } }), 201);
  const g = must(await api('POST', `/trips/${trip.id}/gear`, { token: mgr.token, body: { category: 'kit', description: 'Match balls', quantity: 12, responsible_id: a.id, segment_id: seg.id } }), 201);
  assert.equal((await api('POST', `/trips/${trip.id}/gear`, { token: mgr.token, body: { category: 'kit', description: 'x', quantity: 1, responsible_id: (await signup()).id } })).status, 400);
  // the person responsible updates state; others cannot; every checkpoint is kept
  must(await api('PATCH', `/trips/${trip.id}/gear/${g.id}`, { token: a.token, body: { row_version: 1, state: 'loaded', checkpoint: 'Depot' } }));
  assert.equal((await api('PATCH', `/trips/${trip.id}/gear/${g.id}`, { token: a.token, body: { row_version: 2, quantity: 5 } })).status, 403);
  assert.equal((await api('PATCH', `/trips/${trip.id}/gear/${g.id}`, { token: c.token, body: { row_version: 2, state: 'received' } })).status, 403);
  assert.equal((await api('PATCH', `/trips/${trip.id}/gear/${g.id}`, { token: a.token, body: { row_version: 1, state: 'received' } })).status, 409); // stale
  must(await api('PATCH', `/trips/${trip.id}/gear/${g.id}`, { token: mgr.token, body: { row_version: 2, state: 'damaged', checkpoint: 'Delhi hotel', note: '2 balls punctured' } }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM trip_gear_log WHERE gear_id=$1', [g.id])).rows[0].n, 3);
  assert.equal(must(await api('GET', `/trips/${trip.id}/gear`, { token: a.token })).length, 1);
  assert.equal(must(await api('GET', `/trips/${trip.id}/gear`, { token: c.token })).length, 0);
  // incidents: anyone on the trip can report, staff resolve; a stranger cannot see
  const inc = must(await api('POST', `/trips/${trip.id}/incidents`, { token: a.token, body: { kind: 'delay', summary: 'Coach left late' } }), 201);
  assert.equal((await api('POST', `/trips/${trip.id}/incidents/${inc.id}/resolve`, { token: a.token, body: { resolution: 'ok' } })).status, 403);
  // the board
  const board = must(await api('GET', `/trips/${trip.id}/board`, { token: mgr.token }));
  assert.equal(board.scope, 'manager'); assert.ok(board.next_movement); assert.equal(board.open_incidents.length, 1);
  assert.equal(board.equipment.problems.length, 1); assert.ok(board.exceptions.some((e) => e.participant_id === pc && e.issues.some((i) => i.code === 'guardian_travel_consent')));
  assert.ok(board.counts.unconfirmed >= 1);
  const mine = must(await api('GET', `/trips/${trip.id}/board`, { token: a.token }));
  assert.equal(mine.scope, 'personal'); assert.equal(mine.exceptions, undefined); assert.equal(mine.open_incidents, undefined);
  must(await api('POST', `/trips/${trip.id}/incidents/${inc.id}/resolve`, { token: mgr.token, body: { resolution: 'Rebooked pick-up' } }));
  assert.equal(must(await api('GET', `/trips/${trip.id}/board`, { token: mgr.token })).open_incidents.length, 0);
  // reports: manager full, supplier hides young names/rooms/documents/money, traveller sees own rows only, every export audited with an expiry
  const man = must(await api('GET', `/trips/${trip.id}/reports/manifest`, { token: mgr.token }));
  assert.ok(man.csv.includes(c.display_name)); assert.ok(man.expires_at);
  const sup = must(await api('GET', `/trips/${trip.id}/reports/manifest`, { token: mgr.token, query: { audience: 'supplier' } }));
  assert.ok(!sup.csv.includes(c.display_name) && sup.csv.includes('young traveller'));
  assert.equal((await api('GET', `/trips/${trip.id}/reports/rooming`, { token: mgr.token, query: { audience: 'supplier' } })).status, 400);
  assert.equal((await api('GET', `/trips/${trip.id}/reports/manifest`, { token: a.token, query: { audience: 'supplier' } })).status, 403);
  const own = must(await api('GET', `/trips/${trip.id}/reports/itinerary`, { token: a.token, query: { audience: 'traveller' } }));
  assert.equal(own.rows.length, 1);
  assert.equal(must(await api('GET', `/trips/${trip.id}/reports/itinerary`, { token: (await (async () => { const z = await signup(['athlete']); await addTo(team.id, z); must(await api('POST', `/trips/${trip.id}/party`, { token: mgr.token, body: { user_id: z.id, role: 'athlete' } }), 201); return z; })()).token, query: { audience: 'traveller' } })).rows.length, 0);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action LIKE 'export_trip_report_%' AND entity_id=$1", [trip.id])).rowCount >= 3);
  // branded PDF (#249): same rows, live access check on every download, personal copies stay personal
  const pdf = must(await api('POST', `/trips/${trip.id}/reports/manifest/document`, { token: mgr.token, body: { audience: 'supplier' } }), 201);
  const get = (id, token) => fetch(`${base}${pdf.url.replace(pdf.id, id)}`, { headers: { authorization: `Bearer ${token}` } });
  const dl = await get(pdf.id, mgr.token);
  assert.equal(dl.status, 200); assert.match(dl.headers.get('content-type'), /pdf/); assert.equal(Buffer.from(await dl.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  assert.equal((await get(pdf.id, a.token)).status, 404);   // a traveller cannot fetch the supplier / staff copy
  assert.equal((await api('POST', `/trips/${trip.id}/reports/manifest/document`, { token: a.token, body: { audience: 'supplier' } })).status, 403);
  const mineDoc = must(await api('POST', `/trips/${trip.id}/reports/itinerary/document`, { token: a.token, body: { audience: 'traveller' } }), 201);
  assert.equal((await get(mineDoc.id, a.token)).status, 200);
  assert.equal((await get(mineDoc.id, mgr.token)).status, 404); // even staff cannot open someone's personal copy
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action LIKE 'generate_trip_report_document_%' AND actor_id=$1", [a.id])).rowCount);
  for (const k of ['equipment', 'readiness', 'movement', 'itinerary']) assert.ok(must(await api('GET', `/trips/${trip.id}/reports/${k}`, { token: mgr.token })).columns.length);
});

test('REST, OpenAPI and MCP expose the same travel capabilities, and young travellers\' trips are not public', async () => {
  const spec = (await (await fetch(`${base}/api/v1/openapi.json`)).json());
  const ops = Object.values(spec.paths).flatMap((p) => Object.values(p)).map((o) => o.operationId).filter((o) => /trip/.test(o));
  for (const name of ['create_trip', 'get_trip_board', 'invite_trip_participant', 'add_trip_segment', 'assign_trip_room', 'set_trip_document', 'decide_trip_consent', 'get_trip_report', 'record_trip_payment']) assert.ok(ops.includes(name), name);
  const { mgr, trip } = await club();
  const tools = (await rpc('tools/list', {}, mgr.token)).tools.map((t) => t.name);
  for (const name of ops) assert.ok(tools.includes(name), `MCP tool for ${name}`);
  const r = await rpc('tools/call', { name: 'get_trip_board', arguments: { id: trip.id } }, mgr.token);
  assert.ok(!r.isError, JSON.stringify(r)); assert.match(r.content[0].text, /next_movement|scope/);
  // no unauthenticated access to any trip capability
  assert.equal((await api('GET', `/trips/${trip.id}`)).status, 401);
  assert.equal((await api('GET', `/trips/${trip.id}/board`)).status, 401);
});

test('accepted supplier orders feed the itinerary without duplicating procurement, and reimbursements post to the canonical event budget', async () => {
  const { mgr, team } = await club();
  // an event the manager organises, with the team entered: the ledger the trip posts to
  const ev = must(await api('POST', '/events', { token: mgr.token, body: { name: `Own Cup ${++n}`, sport: 'football', starts_on: iso(10).slice(0, 10), ends_on: iso(12).slice(0, 10) } }), 201);
  await pool.query("INSERT INTO event_entries(event_id, team_id, status) VALUES ($1,$2,'accepted')", [ev.id, team.id]);
  const trip = must(await api('POST', '/trips', { token: mgr.token, body: { name: 'Ledger trip', team_id: team.id, origin: 'A', destination: 'B', timezone: 'Asia/Kolkata', depart_at: kolkata(9, 3), return_at: kolkata(13, 15), event_ids: [ev.id], idempotency_key: uniq() } }), 201);
  // procurement: a confirmed travel order in supplier services, and a different buyer's order the manager cannot use
  const sup = await signup(['supplier']), other = await signup(['organizer']);
  const profile = (await pool.query("INSERT INTO svc_profiles(owner_id, supplier_type, legal_name) VALUES ($1,'company','Coach Hire Ltd') RETURNING id", [sup.id])).rows[0];
  const mkOrder = async (owner, category, status = 'confirmed', ref = 'TP-1') => {
    const buyer = (await pool.query("SELECT id FROM svc_buyers WHERE owner_id=$1", [owner.id])).rows[0] ?? (await pool.query("INSERT INTO svc_buyers(owner_id, name, currency) VALUES ($1,'Buyer','INR') RETURNING id", [owner.id])).rows[0];
    const req = (await pool.query("INSERT INTO svc_requirements(buyer_id, category, title, quantity, unit, currency, created_by) VALUES ($1,$2,'Need','1','trip','INR',$3) RETURNING id", [buyer.id, category, owner.id])).rows[0];
    const rfq = (await pool.query("INSERT INTO svc_rfqs(buyer_id, requirement_id, title, scope, currency, created_by) VALUES ($1,$2,'RFQ',$3,'INR',$4) RETURNING id", [buyer.id, req.id, { category }, owner.id])).rows[0];
    const o = (await pool.query("INSERT INTO svc_orders(number, buyer_id, profile_id, rfq_id, currency, net_minor, tax_minor, gross_minor, status, travel_confirmation, third_party_ref, created_by) VALUES ($1,$2,$3,$4,'INR',100000,18000,118000,$5,'third_party_reference_recorded',$6,$7) RETURNING id, number", [`SO-${Date.now()}-${n++}`, buyer.id, profile.id, rfq.id, status, ref, owner.id])).rows[0];
    return { ...o, rfq: rfq.id };
  };
  const mine = await mkOrder(mgr, 'travel'), foreign = await mkOrder(other, 'travel'), hotel = await mkOrder(mgr, 'accommodation'), pending = await mkOrder(mgr, 'travel', 'pending_supplier');
  const leg = { mode: 'coach', origin: 'A', destination: 'B', depart_at: kolkata(9, 3), depart_tz: 'Asia/Kolkata', arrive_at: kolkata(9, 9), arrive_tz: 'Asia/Kolkata' };
  assert.equal((await api('POST', `/trips/${trip.id}/segments`, { token: mgr.token, body: { ...leg, svc_order_id: foreign.id } })).status, 404);      // someone else's order: not found
  assert.equal((await api('POST', `/trips/${trip.id}/segments`, { token: mgr.token, body: { ...leg, svc_order_id: hotel.id } })).status, 400);        // wrong category
  assert.equal((await api('POST', `/trips/${trip.id}/segments`, { token: mgr.token, body: { ...leg, svc_order_id: pending.id } })).status, 409);      // not yet confirmed by the supplier
  const seg = must(await api('POST', `/trips/${trip.id}/segments`, { token: mgr.token, body: { ...leg, svc_order_id: mine.id } }), 201);
  assert.equal(seg.reference_info.source, 'supplier_order'); assert.equal(seg.reference_info.verified, false); assert.match(seg.reference_info.label, /not a live availability check/i);
  assert.equal(seg.reference, 'TP-1');
  const stay = must(await api('POST', `/trips/${trip.id}/stays`, { token: mgr.token, body: { property_name: 'Hotel', check_in_at: kolkata(9, 8), check_out_at: kolkata(13, 6), tz: 'Asia/Kolkata', svc_order_id: hotel.id } }), 201);
  assert.equal(stay.reference_info.source, 'supplier_order');
  // linking sourcing: an RFQ and an order, once each, never creating a second quote or order
  const before = (await pool.query('SELECT (SELECT count(*) FROM svc_orders) AS o, (SELECT count(*) FROM svc_rfqs) AS r')).rows[0];
  must(await api('POST', `/trips/${trip.id}/suppliers`, { token: mgr.token, body: { purpose: 'travel', order_id: mine.id } }), 201);
  must(await api('POST', `/trips/${trip.id}/suppliers`, { token: mgr.token, body: { purpose: 'accommodation', rfq_id: hotel.rfq } }), 201);
  assert.equal((await api('POST', `/trips/${trip.id}/suppliers`, { token: mgr.token, body: { purpose: 'travel', order_id: mine.id } })).status, 409);
  assert.equal((await api('POST', `/trips/${trip.id}/suppliers`, { token: mgr.token, body: { purpose: 'travel', order_id: foreign.id } })).status, 404);
  assert.deepEqual((await pool.query('SELECT (SELECT count(*) FROM svc_orders) AS o, (SELECT count(*) FROM svc_rfqs) AS r')).rows[0], before);
  const links = must(await api('GET', `/trips/${trip.id}/suppliers`, { token: mgr.token }));
  assert.equal(links.length, 2); assert.equal(links.find((l) => l.order_id).supplier_name, 'Coach Hire Ltd');
  assert.equal(must(await api('GET', `/trips/${trip.id}/reports/cost`, { token: mgr.token })).rows[0][1], '1180.00');
  // money: approved claim reimbursed through the canonical event budget ledger, and voiding it voids the ledger entry too
  const claim = must(await api('POST', `/trips/${trip.id}/claims`, { token: mgr.token, body: { category: 'transport', description: 'Taxi', amount_minor: 30000, currency: 'INR', incurred_on: iso(10).slice(0, 10), idempotency_key: uniq() } }), 201);
  const mate = await signup(['athlete']); await addTo(team.id, mate);
  const pm = must(await api('POST', `/trips/${trip.id}/party`, { token: mgr.token, body: { user_id: mate.id, role: 'staff' } }), 201).id;
  must(await api('POST', `/trips/${trip.id}/party/respond`, { token: mate.token, body: { response: 'confirm' } }));
  assert.equal((await api('POST', `/trips/${trip.id}/claims/${claim.id}/decide`, { token: mgr.token, body: { decision: 'approve' } })).status, 403); // not your own claim
  // a second manager (the confirmed staff member made manager) decides it
  must(await api('PATCH', `/trips/${trip.id}`, { token: mgr.token, body: { row_version: (await pool.query('SELECT row_version FROM trips WHERE id=$1', [trip.id])).rows[0].row_version, manager_id: mate.id } }));
  must(await api('POST', `/trips/${trip.id}/claims/${claim.id}/decide`, { token: mate.token, body: { decision: 'approve' } }));
  const line = (await pool.query("INSERT INTO event_budget_lines(event_id, direction, category, name, planned_cents) VALUES ($1,'expense','transport','Team travel',500000) RETURNING id", [ev.id])).rows[0];
  const other2 = must(await api('POST', `/trips/${trip.id}/claims/${claim.id}/reimburse`, { token: mgr.token, body: { budget_line_id: line.id, reference: 'BANK-9' } }));
  assert.equal(other2.source, 'event_budget'); assert.ok(other2.budget_payment_id);
  assert.equal((await pool.query('SELECT amount_cents::int AS a FROM event_budget_payments WHERE id=$1', [other2.budget_payment_id])).rows[0].a, 30000);
  assert.equal(must(await api('POST', `/trips/${trip.id}/claims/${claim.id}/reimburse`, { token: mgr.token, body: { budget_line_id: line.id } })).id, other2.id); // idempotent: one ledger entry
  assert.equal((await pool.query('SELECT count(*)::int AS c FROM event_budget_payments WHERE line_id=$1', [line.id])).rows[0].c, 1);
  must(await api('POST', `/trips/${trip.id}/payments/${other2.id}/void`, { token: mgr.token, body: { reason: 'Paid twice' } }));
  assert.ok((await pool.query('SELECT voided_at FROM event_budget_payments WHERE id=$1', [other2.budget_payment_id])).rows[0].voided_at);
  void pm;
});

test('every sport in the catalogue can travel: a trip is sport-agnostic and records the sport for display only', async () => {
  const { mgr, team } = await club();
  const sports = (await pool.query('SELECT slug FROM sports ORDER BY slug')).rows;
  assert.ok(sports.length > 20);
  for (const sp of sports) {
    const t = must(await api('POST', '/trips', { token: mgr.token, body: { name: `Trip ${sp.slug}`, team_id: team.id, sport: sp.slug, origin: 'A', destination: 'B', timezone: 'UTC', depart_at: kolkata(30, 3), return_at: kolkata(31, 3), idempotency_key: uniq() } }), 201);
    assert.equal(t.sport_name !== null, true);
  }
});
