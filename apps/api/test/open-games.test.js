import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { fromLocal, addDays } = await import('../src/booking/time.js');
const { syncOpenGames } = await import('../src/open-games-sweeps.js');
const { capabilities } = await import('../src/capabilities/index.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `og_${n}_${roles[0]}`, display_name: `Player ${n}`, email: `og${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const today = new Date().toISOString().slice(0, 10);
const at = (d, h) => fromLocal(addDays(today, d), h * 60, 'UTC').toISOString();
const inbox = async (u) => must(await api('GET', '/notifications', { token: u.token })).items;
const evidence = { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' };
async function verifiedGuardian(parent, child) {
  const l = must(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: child.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
}

async function venue(mgr, { lat, lng } = {}) {
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: `Open Arena ${Math.random().toString(36).slice(2, 6)}`, city: 'Pune', timezone: 'UTC', latitude: lat, longitude: lng } }), 201);
  must(await api('POST', `/venues/${v.id}/hours`, { token: mgr.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '06:00', closes: '22:00' })) } }));
  const court = must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', sport: 'football', capacity: 1, hourly_rate_cents: 50000 } }), 201);
  return { v, court };
}
const book = (u, court, d, h1, h2) => api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: court.id, starts_at: at(d, h1), ends_at: at(d, h2) }] } });
const host = (u, body = {}) => api('POST', '/open-games', { token: u.token, body: { sport: 'football', starts_at: at(2, 18), duration_minutes: 90, location: 'Riverside ground', max_players: 4, approval_mode: 'auto', ...body } });
const join = (u, g, body = {}) => api('POST', `/open-games/${g.id}/join`, { token: u.token, body });
const member = async (g, u) => (await pool.query('SELECT * FROM open_game_members WHERE open_game_id=$1 AND user_id=$2', [g.id, u.id])).rows[0];

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('og_root','og_root','{admin}','x','x','og_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('every open-game capability is a REST route, an OpenAPI operation and an MCP tool from one definition', () => {
  const names = capabilities.filter((c) => c.tag === 'Find & Join Games').map((c) => c.name);
  for (const x of ['host_open_game', 'find_open_games', 'get_open_game', 'join_open_game', 'leave_open_game', 'decide_open_game_request', 'guardian_decide_open_game_join', 'send_open_game_message', 'check_in_open_game', 'complete_open_game', 'raise_open_game_appeal', 'suggest_open_game_players']) assert.ok(names.includes(x), x);
});

test('hosting links the canonical booking and never reserves a slot by itself', async () => {
  const mgr = await signup(['venue_manager']); const hostU = await signup(); const other = await signup();
  const { v, court } = await venue(mgr);
  // an open game at a venue with no booking does not hold the slot: someone else can still book it
  const g1 = must(await host(hostU, { location: undefined, venue_id: v.id, resource_id: court.id, starts_at: at(3, 10) }), 201);
  assert.equal(g1.booking_state, 'unbooked');
  assert.equal(g1.venue_hint.needs, 'book');
  must(await book(other, court, 3, 10, 11), 201);
  // a booking that is not yours / not confirmed / does not cover the time is refused
  const mine = must(await book(hostU, court, 4, 10, 12), 201);
  const bookingId = mine.bookings[0].id;
  assert.equal((await host(other, { venue_id: v.id, resource_id: court.id, booking_id: bookingId, starts_at: at(4, 10) })).status, 403);
  assert.equal((await host(hostU, { venue_id: v.id, resource_id: court.id, booking_id: bookingId, starts_at: at(4, 9), duration_minutes: 120 })).status, 409);
  const g2 = must(await host(hostU, { venue_id: v.id, resource_id: court.id, booking_id: bookingId, starts_at: at(4, 10), duration_minutes: 120 }), 201);
  assert.equal(g2.booking_state, 'confirmed');
  assert.equal(g2.booking.reservation_id, mine.id);
  assert.equal((await host(hostU, { venue_id: v.id, resource_id: court.id, booking_id: bookingId, starts_at: at(4, 10) })).status, 409, 'one booking backs one game');
  // no place at all is refused; a public place is enough
  assert.equal((await host(hostU, { location: undefined })).status, 400);
  assert.equal((await api('POST', '/open-games', { body: {} })).status, 401);
  // the venue cancels the booking: the state is read live, discovery drops the game, the sweep tells people
  const joiner = await signup();
  must(await join(joiner, g2), 201);
  must(await api('DELETE', `/reservations/${mine.id}`, { token: hostU.token }));
  const live = must(await api('GET', `/open-games/${g2.id}`, { token: hostU.token }));
  assert.equal(live.booking_state, 'cancelled');
  assert.ok(!must(await api('GET', '/open-games', { query: { sport: 'football', limit: '100' } })).some((x) => x.id === g2.id));
  await syncOpenGames();
  assert.ok((await inbox(hostU)).some((x) => x.kind === 'open_game_venue_lost'));
  assert.ok((await inbox(joiner)).some((x) => x.kind === 'open_game_venue_lost'));
  await syncOpenGames();
  assert.equal((await inbox(hostU)).filter((x) => x.kind === 'open_game_venue_lost').length, 1, 'told once');
});

test('discovery filters by sport, time, distance, level and cost, and exposes no private participant data', async () => {
  const mgr = await signup(['venue_manager']); const hostU = await signup(); const player = await signup();
  const near = await venue(mgr, { lat: 18.52, lng: 73.85 });
  const far = await venue(mgr, { lat: 28.61, lng: 77.2 });
  must(await api('POST', '/me/sport-profiles', { token: player.token, body: { sport: 'football', role: 'athlete', level: 'amateur' } }), 201);
  const nearG = must(await host(hostU, { location: undefined, venue_id: near.v.id, resource_id: near.court.id, starts_at: at(1, 17), skill_min: 'amateur', skill_max: 'semi_pro', cost_mode: 'split_total', cost_cents: 40000, max_players: 8, format: '5-a-side' }), 201);
  const farG = must(await host(hostU, { location: undefined, venue_id: far.v.id, resource_id: far.court.id, starts_at: at(5, 17), skill_min: 'pro' }), 201);
  const cricket = must(await host(hostU, { sport: 'cricket', starts_at: at(1, 9) }), 201);
  must(await join(player, nearG), 201);
  const ids = (r) => must(r).map((x) => x.id);
  const find = (query, token) => api('GET', '/open-games', { query: { limit: '100', ...query }, token });
  assert.ok(ids(await find({ sport: 'football' })).includes(nearG.id));
  assert.ok(!ids(await find({ sport: 'football' })).includes(cricket.id));
  assert.deepEqual(ids(await find({ sport: 'football', lat: '18.53', lng: '73.86', radius_km: '25' })), [nearG.id]);
  assert.ok(ids(await find({ sport: 'football', level: 'beginner' })).includes(farG.id) === false, 'a pro game excludes a beginner');
  assert.ok(ids(await find({ sport: 'football', level: 'pro' })).includes(farG.id));
  assert.ok(!ids(await find({ sport: 'football', free_only: 'true' })).includes(nearG.id));
  assert.ok(ids(await find({ sport: 'football', max_cost_cents: '5000' })).includes(nearG.id), 'split 400.00 over 8 = 50.00');
  const tomorrow = ids(await find({ when: 'tomorrow' }));
  assert.ok(tomorrow.includes(nearG.id) && tomorrow.includes(cricket.id) && !tomorrow.includes(farG.id));
  assert.equal((await find({ when: 'today', tz: 'Mars/Base' })).status, 400);
  const card = must(await find({ sport: 'football' })).find((x) => x.id === nearG.id);
  assert.equal(card.cost.per_player_cents, 5000);
  assert.equal(card.slots_left, 6, '8 seats: the host and one player hold two');
  // nothing about the people: no address, email, phone, date of birth, calendar
  const text = JSON.stringify([card, must(await api('GET', `/open-games/${nearG.id}`))]);
  for (const bad of ['address', 'email', 'phone', 'dob', 'availability', 'national_id']) assert.ok(!text.toLowerCase().includes(bad), `public view leaks ${bad}`);
  // best_match needs sign-in and explains itself from explicit data only
  assert.equal((await find({ sort: 'best_match' })).status, 403);
  await pool.query("INSERT INTO availability_windows(user_id, weekday, from_time, to_time, timezone) VALUES ($1, extract(dow from $2::timestamptz)::int, '15:00', '21:00', 'UTC')", [player.id, at(5, 17)]);
  const ranked = must(await find({ sport: 'football', sort: 'best_match', lat: '18.53', lng: '73.86' }, player.token));
  const mineNear = ranked.find((x) => x.id === nearG.id);
  assert.equal(mineNear.my_status, 'confirmed');
  assert.ok(ranked.find((x) => x.id === farG.id).reasons.some((r) => r.kind === 'time' && r.ok), 'availability fit is explained');
  assert.ok(mineNear.reasons.some((r) => r.kind === 'sport') && mineNear.reasons.some((r) => r.kind === 'distance'));
  assert.ok(ranked.find((x) => x.id === farG.id).reasons.some((r) => r.kind === 'level' && !r.ok), 'a level mismatch is stated, not hidden');
  // team-only and link-only visibility
  const t = must(await api('POST', '/teams', { token: hostU.token, body: { name: `OG Team ${n}`, sport: 'football' } }), 201);
  const teamG = must(await host(hostU, { team_id: t.id, visibility: 'team' }), 201);
  assert.ok(!ids(await find({}, player.token)).includes(teamG.id));
  assert.equal((await api('GET', `/open-games/${teamG.id}`, { token: player.token })).status, 404);
  assert.equal((await api('GET', `/open-games/${teamG.id}`, { token: hostU.token })).status, 200);
});

test('joining is capacity safe and idempotent under concurrent requests, and never joins a team', async () => {
  const hostU = await signup(); const crowd = []; for (let k = 0; k < 8; k++) crowd.push(await signup());
  const t = must(await api('POST', '/teams', { token: hostU.token, body: { name: `OG Club ${n}`, sport: 'football' } }), 201);
  const g = must(await host(hostU, { team_id: t.id, max_players: 4, host_plays: true }), 201);
  assert.equal(g.slots_left, 3);
  const results = await Promise.all(crowd.map((u) => join(u, g, { idempotency_key: `key-${u.id.slice(0, 8)}` })));
  const statuses = results.map((r) => must(r, 201).status);
  assert.equal(statuses.filter((s) => s === 'confirmed').length, 3);
  assert.equal(statuses.filter((s) => s === 'waitlisted').length, 5);
  assert.equal(Number((await pool.query("SELECT count(*) FROM open_game_members WHERE open_game_id=$1 AND status='confirmed'", [g.id])).rows[0].count), 4);
  // retries replay, never create a second place
  const again = await Promise.all([join(crowd[0], g, { idempotency_key: 'again-again' }), join(crowd[0], g), join(crowd[7], g)]);
  for (const r of again) assert.equal(must(r, 201).replayed, true);
  assert.equal(Number((await pool.query('SELECT count(*) FROM open_game_members WHERE open_game_id=$1', [g.id])).rows[0].count), 9);
  // joining a team's game does not put anyone on the team
  assert.equal(Number((await pool.query("SELECT count(*) FROM team_members WHERE team_id=$1 AND user_id = ANY($2)", [t.id, crowd.map((u) => u.id)])).rows[0].count), 0);
  // the host cannot join their own game; strangers cannot manage it
  assert.equal((await join(hostU, g)).status, 400);
  assert.equal((await api('PATCH', `/open-games/${g.id}`, { token: crowd[0].token, body: { notes: 'mine now' } })).status, 403);
  // a seat holder leaves: the oldest waitlisted person is promoted, once, and the host hears about it
  const seated = results.map((r, k) => ({ r: r.body, u: crowd[k] })).filter((x) => x.r.status === 'confirmed');
  const waiting = results.map((r, k) => ({ r: r.body, u: crowd[k] })).filter((x) => x.r.status === 'waitlisted');
  const oldest = (await pool.query("SELECT user_id FROM open_game_members WHERE open_game_id=$1 AND status='waitlisted' ORDER BY created_at, id LIMIT 1", [g.id])).rows[0].user_id;
  const [l1, l2] = await Promise.all([api('POST', `/open-games/${g.id}/leave`, { token: seated[0].u.token }), api('POST', `/open-games/${g.id}/leave`, { token: seated[0].u.token })]);
  assert.equal(l1.status, 200); assert.equal(l2.status, 200);
  assert.equal((await pool.query("SELECT status FROM open_game_members WHERE open_game_id=$1 AND user_id=$2", [g.id, oldest])).rows[0].status, 'confirmed');
  assert.equal(Number((await pool.query("SELECT count(*) FROM open_game_members WHERE open_game_id=$1 AND status='confirmed'", [g.id])).rows[0].count), 4);
  assert.ok((await inbox(waiting.find((w) => w.u.id === oldest).u)).some((x) => x.kind === 'open_game_promoted'));
  assert.ok((await inbox(hostU)).some((x) => x.kind === 'open_game_full' || x.kind === 'open_game_nearly_full'));
  // raising the seats promotes the waitlist too
  must(await api('PATCH', `/open-games/${g.id}`, { token: hostU.token, body: { max_players: 6 } }));
  assert.equal(Number((await pool.query("SELECT count(*) FROM open_game_members WHERE open_game_id=$1 AND status='confirmed'", [g.id])).rows[0].count), 6);
  assert.equal((await api('PATCH', `/open-games/${g.id}`, { token: hostU.token, body: { max_players: 2 } })).status, 409, 'seats cannot drop below confirmed players');
});

test('host approval mode, ranked requests, decline/remove, and out-of-level players are never auto-approved', async () => {
  const hostU = await signup(); const a = await signup(); const b = await signup(); const c = await signup(); const beginner = await signup();
  must(await api('POST', '/me/sport-profiles', { token: a.token, body: { sport: 'football', role: 'athlete', level: 'amateur' } }), 201);
  must(await api('POST', '/me/sport-profiles', { token: beginner.token, body: { sport: 'football', role: 'athlete', level: 'beginner' } }), 201);
  const gAuto = must(await host(hostU, { approval_mode: 'auto', skill_min: 'amateur', max_players: 5 }), 201);
  assert.equal(must(await join(a, gAuto), 201).status, 'confirmed');
  assert.equal(must(await join(beginner, gAuto), 201).status, 'requested', 'auto-approval only takes players who fit the stated level');
  const g = must(await host(hostU, { approval_mode: 'host', max_players: 3, role_needs: ['goalkeeper'], skill_min: 'amateur' }), 201);
  const ma = must(await join(a, g), 201); assert.equal(ma.status, 'requested');
  must(await api('POST', '/me/sport-profiles', { token: b.token, body: { sport: 'football', role: 'athlete', level: 'amateur' } }), 201);
  must(await join(b, g, { position: 'goalkeeper' }), 201);
  must(await join(c, g), 201);
  assert.ok((await inbox(hostU)).some((x) => x.kind === 'open_game_request'));
  const detail = must(await api('GET', `/open-games/${g.id}`, { token: hostU.token }));
  assert.equal(detail.requests.length, 3);
  assert.deepEqual(detail.requests.map((r) => r.user_id)[0], b.id, 'the role I asked for ranks first, by visible criteria');
  assert.ok(detail.rank_criteria.length >= 3);
  assert.ok(detail.requests.every((r) => r.facts && typeof r.facts.no_shows === 'number'));
  // only the host decides
  assert.equal((await api('POST', `/open-games/${g.id}/members/${ma.member_id}/decision`, { token: b.token, body: { action: 'approve' } })).status, 403);
  assert.equal(must(await api('POST', `/open-games/${g.id}/members/${ma.member_id}/decision`, { token: hostU.token, body: { action: 'approve' } })).status, 'confirmed');
  assert.equal(must(await api('POST', `/open-games/${g.id}/members/${ma.member_id}/decision`, { token: hostU.token, body: { action: 'approve' } })).replayed, true);
  const mc = (await member(g, c)).id;
  assert.equal(must(await api('POST', `/open-games/${g.id}/members/${mc}/decision`, { token: hostU.token, body: { action: 'decline' } })).status, 'declined');
  assert.equal((await join(c, g)).status, 409, 'a declined request cannot be resubmitted');
  assert.ok((await inbox(c)).some((x) => x.kind === 'open_game_declined'));
  const mb = (await member(g, b)).id;
  must(await api('POST', `/open-games/${g.id}/members/${mb}/decision`, { token: hostU.token, body: { action: 'approve' } }));
  must(await api('POST', `/open-games/${g.id}/members/${mb}/decision`, { token: hostU.token, body: { action: 'remove' } }));
  assert.equal((await join(b, g)).status, 409, 'a removed player cannot rejoin');
  // shares: the amount is derived from the game; the host records settlement, idempotently
  const paid = must(await host(hostU, { cost_mode: 'per_player', cost_cents: 15000, currency: 'INR', max_players: 4 }), 201);
  const mp = must(await join(a, paid), 201);
  assert.equal(mp.share_cents, 15000); assert.equal(mp.share_status, 'due');
  assert.equal(must(await api('POST', `/open-games/${paid.id}/members/${mp.member_id}/share`, { token: hostU.token, body: { status: 'settled' } })).share_status, 'settled');
  assert.equal(must(await api('POST', `/open-games/${paid.id}/members/${mp.member_id}/share`, { token: hostU.token, body: { status: 'settled' } })).replayed, true);
  assert.equal((await api('PATCH', `/open-games/${paid.id}`, { token: hostU.token, body: { cost_cents: 20000 } })).status, 409, 'the price is locked once others hold a seat');
});

test('young people: guardian-controlled joining, adult-only games, hidden from public lists, no direct chat', async () => {
  const hostU = await signup(['athlete'], { dob: yearsAgo(30) }); const parent = await signup(['athlete'], { dob: yearsAgo(40) }); const child = await signup(['athlete'], { dob: yearsAgo(12) });
  await verifiedGuardian(parent, child);
  const adultsOnly = must(await host(hostU, { max_players: 6 }), 201);
  assert.equal((await join(child, adultsOnly)).status, 409);
  assert.equal((await api('POST', `/open-games/${adultsOnly.id}/join`, { token: parent.token, body: { on_behalf_of: child.id } })).status, 409);
  assert.equal((await api('POST', '/open-games', { token: child.token, body: { sport: 'football', starts_at: at(2, 18), location: 'Park', max_players: 4 } })).status, 403, 'a young person cannot host');
  const juniors = must(await host(hostU, { audience: 'youth', min_age: 8, max_age: 14, max_players: 6, approval_mode: 'auto' }), 201);
  assert.equal((await join(parent, juniors)).status, 409, 'a youth game is not for adults');
  // discovery respects the audience: adults do not browse young players' games, a guardian and the child do; the child is not shown adult-only games
  const seen = async (u) => must(await api('GET', '/open-games', { token: u.token, query: { limit: '100' } })).map((x) => x.id);
  assert.ok(!(await seen(await signup())).includes(juniors.id));
  assert.ok((await seen(parent)).includes(juniors.id));
  assert.ok((await seen(child)).includes(juniors.id) && !(await seen(child)).includes(adultsOnly.id));
  // the child asks for themselves: nothing happens until a guardian approves, and the guardian is told
  const asked = must(await join(child, juniors), 201);
  assert.equal(asked.status, 'guardian_pending');
  assert.equal(must(await api('GET', `/open-games/${juniors.id}`)).taken, 1, 'a pending request holds no seat');
  assert.ok((await inbox(parent)).some((x) => x.kind === 'open_game_guardian_request'));
  const pending = must(await api('GET', '/me/open-game-guardian-requests', { token: parent.token }));
  assert.equal(pending[0].member_id, asked.member_id);
  assert.equal((await api('POST', `/open-games/${juniors.id}/members/${asked.member_id}/guardian-decision`, { token: hostU.token, body: { decision: 'approve' } })).status, 403, 'the host is not the guardian');
  assert.equal((await api('POST', `/open-games/${juniors.id}/members/${asked.member_id}/decision`, { token: hostU.token, body: { action: 'approve' } })).status, 409);
  // approval needs the guardian's current consent for taking part
  assert.equal((await api('POST', `/open-games/${juniors.id}/members/${asked.member_id}/guardian-decision`, { token: parent.token, body: { decision: 'approve' } })).status, 409);
  must(await api('POST', `/youth/children/${child.id}/consents`, { token: parent.token, body: { purpose: 'participation' } }), 201);
  assert.equal(must(await api('POST', `/open-games/${juniors.id}/members/${asked.member_id}/guardian-decision`, { token: parent.token, body: { decision: 'approve' } })).status, 'confirmed');
  // a guardian can also join for the child directly (needs consent too) and is idempotent
  const sibling = await signup(['athlete'], { dob: yearsAgo(10) }); await verifiedGuardian(parent, sibling);
  assert.equal((await api('POST', `/open-games/${juniors.id}/join`, { token: parent.token, body: { on_behalf_of: sibling.id } })).status, 409);
  // the public view counts young players but never names or shows them
  const pub = must(await api('GET', `/open-games/${juniors.id}`));
  assert.equal(pub.taken, 2);
  assert.equal(pub.other_players, 1);
  assert.ok(!JSON.stringify(pub).includes(child.handle) && !JSON.stringify(pub).includes(child.display_name));
  // no direct chat for a young player; their guardian takes part instead
  assert.equal((await api('POST', `/open-games/${juniors.id}/messages`, { token: child.token, body: { body: 'hi' } })).status, 403);
  must(await api('POST', `/open-games/${juniors.id}/messages`, { token: parent.token, body: { body: 'We will be there' } }), 201);
  // the child cannot check themselves in; the guardian can
  await pool.query("UPDATE games SET starts_at = now() + interval '20 minutes', ends_at = now() + interval '2 hours' WHERE id=$1", [juniors.game_id]);
  assert.equal((await api('POST', `/open-games/${juniors.id}/check-in`, { token: child.token })).status, 403);
  assert.equal(must(await api('POST', `/open-games/${juniors.id}/check-in`, { token: parent.token, body: { on_behalf_of: child.id } })).attendance, 'attended');
  // withdrawing consent stops the young player being promoted from a waitlist
  await pool.query('UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1', [child.id]);
  const full = must(await host(hostU, { audience: 'youth', min_players: 1, max_players: 1, host_plays: false, approval_mode: 'auto', min_age: 8, max_age: 14 }), 201);
  assert.equal((await api('POST', `/open-games/${full.id}/join`, { token: parent.token, body: { on_behalf_of: child.id } })).status, 409, 'consent revoked: no new action for the child');
});

test('the temporary game chat is for confirmed players only and closes after the game', async () => {
  const hostU = await signup(); const p1 = await signup(); const p2 = await signup(); const outsider = await signup();
  const g = must(await host(hostU, { approval_mode: 'host' }), 201);
  const r1 = must(await join(p1, g), 201); must(await join(p2, g), 201);
  assert.equal((await api('POST', `/open-games/${g.id}/messages`, { token: p1.token, body: { body: 'hello' } })).status, 403, 'requested is not confirmed');
  must(await api('POST', `/open-games/${g.id}/members/${r1.member_id}/decision`, { token: hostU.token, body: { action: 'approve' } }));
  must(await api('POST', `/open-games/${g.id}/messages`, { token: p1.token, body: { body: 'Bringing the ball' } }), 201);
  must(await api('POST', `/open-games/${g.id}/messages`, { token: hostU.token, body: { body: 'Great, see you' } }), 201);
  assert.equal((await api('GET', `/open-games/${g.id}/messages`, { token: outsider.token })).status, 403);
  assert.equal((await api('GET', `/open-games/${g.id}/messages`, { token: p2.token })).status, 403);
  const list = must(await api('GET', `/open-games/${g.id}/messages`, { token: p1.token }));
  assert.equal(list.messages.length, 2);
  assert.equal(list.archived, false);
  // after the window the chat is archived: nothing shown, nothing accepted, rows kept
  await pool.query("UPDATE games SET starts_at = now() - interval '3 days', ends_at = now() - interval '70 hours' WHERE id=$1", [g.game_id]);
  const closed = must(await api('GET', `/open-games/${g.id}/messages`, { token: p1.token }));
  assert.equal(closed.archived, true); assert.deepEqual(closed.messages, []);
  assert.equal((await api('POST', `/open-games/${g.id}/messages`, { token: p1.token, body: { body: 'late' } })).status, 409);
  assert.equal(Number((await pool.query('SELECT count(*) FROM open_game_messages WHERE open_game_id=$1', [g.id])).rows[0].count), 2);
  // a cancelled game closes the chat for sending at once
  const g2 = must(await host(hostU), 201); must(await join(p1, g2), 201);
  must(await api('POST', `/open-games/${g2.id}/cancel`, { token: hostU.token, body: { reason: 'Rain' } }));
  assert.equal((await api('POST', `/open-games/${g2.id}/messages`, { token: hostU.token, body: { body: 'sorry' } })).status, 409);
  assert.ok((await inbox(p1)).some((x) => x.kind === 'open_game_cancelled'));
  assert.equal((await join(p2, g2)).status, 409);
  assert.equal(must(await api('POST', `/open-games/${g2.id}/cancel`, { token: hostU.token, body: {} })).status, 'cancelled', 'cancel is repeatable');
});

test('attendance, completion into sports history, factual no-show records and appeals', async () => {
  const hostU = await signup(); const p1 = await signup(); const p2 = await signup(); const p3 = await signup();
  const g = must(await host(hostU, { max_players: 6, cancel_before_hours: 72 }), 201);
  for (const p of [p1, p2, p3]) must(await join(p, g), 201);
  assert.equal((await api('POST', `/open-games/${g.id}/check-in`, { token: p1.token })).status, 409, 'too early');
  assert.equal((await api('POST', `/open-games/${g.id}/complete`, { token: hostU.token })).status, 409, 'not started');
  // p3 leaves inside the cancellation cut-off: a factual late cancellation
  const left = must(await api('POST', `/open-games/${g.id}/leave`, { token: p3.token }));
  assert.equal(left.late_cancel, true);
  await pool.query("UPDATE games SET starts_at = now() - interval '30 minutes', ends_at = now() + interval '1 hour' WHERE id=$1", [g.game_id]);
  must(await api('POST', `/open-games/${g.id}/check-in`, { token: p1.token }));
  assert.equal(must(await api('POST', `/open-games/${g.id}/check-in`, { token: p1.token })).replayed, true);
  const m2 = await member(g, p2);
  assert.equal((await api('POST', `/open-games/${g.id}/members/${m2.id}/attendance`, { token: p1.token, body: { attendance: 'no_show' } })).status, 403);
  must(await api('POST', `/open-games/${g.id}/members/${m2.id}/attendance`, { token: hostU.token, body: { attendance: 'no_show' } }));
  must(await api('POST', `/open-games/${g.id}/members/${(await member(g, hostU)).id}/attendance`, { token: hostU.token, body: { attendance: 'attended' } }));
  assert.ok((await inbox(p2)).some((x) => x.kind === 'open_game_no_show'));
  // facts are counts, not labels; the person and a host they asked can see them, strangers cannot
  const f = must(await api('GET', `/people/${p2.id}/open-game-facts`, { token: hostU.token }));
  assert.equal(f.no_shows, 1); assert.equal(f.games_played, 0);
  assert.ok(!JSON.stringify(f).match(/unsafe|bad|score|rating/i));
  assert.equal((await api('GET', `/people/${p2.id}/open-game-facts`, { token: (await signup()).token })).status, 404);
  assert.equal((await api('GET', `/people/${p2.id}/open-game-facts`, { token: p2.token })).status, 200);
  // complete: attended players become participants of the game (their sports history), no-shows do not
  const done = must(await api('POST', `/open-games/${g.id}/complete`, { token: hostU.token }));
  assert.equal(done.participants_recorded, 2);
  assert.equal(must(await api('POST', `/open-games/${g.id}/complete`, { token: hostU.token })).replayed, true);
  const ps = (await pool.query('SELECT user_id FROM game_participants WHERE game_id=$1', [g.game_id])).rows.map((r) => r.user_id).sort();
  assert.deepEqual(ps, [hostU.id, p1.id].sort());
  // appeals: the player asks, the host can correct, the fact stops counting; upholding is for the platform only
  assert.equal((await api('POST', '/open-game-appeals', { token: p1.token, body: { member_id: m2.id, fact: 'no_show', reason: 'I was there' } })).status, 403);
  const ap = must(await api('POST', '/open-game-appeals', { token: p2.token, body: { member_id: m2.id, fact: 'no_show', reason: 'I was at the other gate' } }), 201);
  assert.equal((await api('POST', '/open-game-appeals', { token: p2.token, body: { member_id: m2.id, fact: 'no_show', reason: 'second try here' } })).status, 409);
  assert.equal(must(await api('GET', `/people/${p2.id}/open-game-facts`, { token: p2.token })).under_review, 1);
  assert.equal((await api('POST', `/open-game-appeals/${ap.id}/resolve`, { token: hostU.token, body: { outcome: 'upheld' } })).status, 403);
  assert.equal((await api('POST', `/open-game-appeals/${ap.id}/resolve`, { token: p2.token, body: { outcome: 'corrected' } })).status, 403);
  must(await api('POST', `/open-game-appeals/${ap.id}/resolve`, { token: hostU.token, body: { outcome: 'corrected', resolution: 'Gate scanner was down' } }));
  const after = must(await api('GET', `/people/${p2.id}/open-game-facts`, { token: p2.token }));
  assert.equal(after.no_shows, 0); assert.equal(after.under_review, 0);
  assert.ok((await inbox(p2)).some((x) => x.kind === 'open_game_appeal_resolved'));
  // the late cancellation can be appealed and upheld by the platform team
  const m3 = await member(g, p3);
  const ap3 = must(await api('POST', '/open-game-appeals', { token: p3.token, body: { member_id: m3.id, fact: 'late_cancel', reason: 'I was ill' } }), 201);
  must(await api('POST', `/open-game-appeals/${ap3.id}/resolve`, { token: admin.token, body: { outcome: 'upheld', resolution: 'Within the rules' } }));
  assert.equal(must(await api('GET', `/people/${p3.id}/open-game-facts`, { token: p3.token })).late_cancellations, 1);
});

test('suggested players are opt-in, adult, ranked by visible criteria and invitations are idempotent', async () => {
  const hostU = await signup(); const yes = await signup(); const no = await signup(); const pro = await signup();
  const youth = await signup(['athlete'], { dob: yearsAgo(13) });
  for (const [u, level] of [[yes, 'amateur'], [no, 'amateur'], [pro, 'pro'], [youth, 'amateur']]) must(await api('POST', '/me/sport-profiles', { token: u.token, body: { sport: 'football', role: 'athlete', level } }), 201);
  assert.equal((await api('PATCH', '/me/open-game-preferences', { token: youth.token, body: { discoverable: true } })).status, 403);
  assert.equal(must(await api('GET', '/me/open-game-preferences', { token: yes.token })).discoverable, false);
  for (const u of [yes, pro]) must(await api('PATCH', '/me/open-game-preferences', { token: u.token, body: { discoverable: true } }));
  const g = must(await host(hostU, { skill_min: 'amateur', skill_max: 'semi_pro', starts_at: at(2, 18), duration_minutes: 60 }), 201);
  await pool.query("INSERT INTO availability_windows(user_id, weekday, from_time, to_time, timezone) VALUES ($1, extract(dow from $2::timestamptz)::int, '17:00', '20:00', 'UTC')", [yes.id, at(2, 18)]);
  assert.equal((await api('GET', `/open-games/${g.id}/suggested-players`, { token: yes.token })).status, 403);
  const list = must(await api('GET', `/open-games/${g.id}/suggested-players`, { token: hostU.token }));
  assert.deepEqual(list.map((x) => x.id), [yes.id, pro.id], 'in-range and free at that time ranks above out-of-range');
  assert.ok(list[0].reasons.some((r) => r.kind === 'time') && list[1].reasons.some((r) => !r.ok));
  assert.ok(!JSON.stringify(list).match(/lat|lng|address|email/i), 'no location or contact in suggestions');
  assert.equal((await api('POST', `/open-games/${g.id}/invites`, { token: hostU.token, body: { user_id: no.id } })).status, 404, 'not opted in');
  must(await api('POST', `/open-games/${g.id}/invites`, { token: hostU.token, body: { user_id: yes.id } }), 201);
  must(await api('POST', `/open-games/${g.id}/invites`, { token: hostU.token, body: { user_id: yes.id } }), 201);
  assert.equal((await inbox(yes)).filter((x) => x.kind === 'open_game_invite').length, 1);
  must(await join(yes, g), 201);
  assert.ok(!must(await api('GET', `/open-games/${g.id}/suggested-players`, { token: hostU.token })).some((x) => x.id === yes.id), 'people already in are not suggested');
});

test('time and venue changes notify, an unfinished game closes itself without inventing no-shows', async () => {
  const hostU = await signup(); const p1 = await signup();
  const g = must(await host(hostU, { approval_mode: 'auto' }), 201);
  must(await join(p1, g), 201);
  must(await api('PATCH', `/open-games/${g.id}`, { token: hostU.token, body: { starts_at: at(3, 19), location: 'North pitch' } }));
  assert.ok((await inbox(p1)).some((x) => x.kind === 'open_game_changed'));
  assert.equal(must(await api('GET', `/open-games/${g.id}`)).place.name, 'North pitch');
  await pool.query("UPDATE games SET starts_at = now() - interval '5 days', ends_at = now() - interval '5 days' + interval '1 hour' WHERE id=$1", [g.game_id]);
  await syncOpenGames();
  const closed = must(await api('GET', `/open-games/${g.id}`));
  assert.equal(closed.status, 'completed');
  assert.equal((await member(g, p1)).attendance, null);
  assert.equal(Number((await pool.query('SELECT count(*) FROM game_participants WHERE game_id=$1', [g.game_id])).rows[0].count), 0);
});

test('every sport in the catalogue can host and be found as an open game (the model is sport-neutral: seats, level, cost)', async () => {
  const sports = must(await api('GET', '/sports'));
  assert.ok(sports.length > 20);
  const hostU = await signup(); const player = await signup();
  const missing = [];
  for (const s of sports) {
    const r = await api('POST', '/open-games', { token: hostU.token, body: { sport: s.slug, starts_at: at(6, 9), location: 'Public ground', max_players: 4, min_players: 2, approval_mode: 'auto' } });
    if (r.status !== 201) { missing.push(`${s.slug}: host ${r.status}`); continue; }
    const found = (await api('GET', '/open-games', { query: { sport: s.slug, limit: '5' } })).body.some((x) => x.id === r.body.id);
    if (!found) missing.push(`${s.slug}: not found`);
    if ((await api('POST', `/open-games/${r.body.id}/join`, { token: player.token, body: {} })).status !== 201) missing.push(`${s.slug}: join`);
  }
  assert.deepEqual(missing, []);
});
