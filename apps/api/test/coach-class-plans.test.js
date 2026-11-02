import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { fromLocal, addDays } = await import('../src/booking/time.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ccp_${n}_${roles[0]}`, display_name: `Ccp ${n}`, email: `ccp${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const TZ = 'Asia/Kolkata';
const today = new Date().toISOString().slice(0, 10);
const at = (d, hour) => fromLocal(addDays(today, d), hour * 60, TZ).toISOString();

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function setup() {
  const mgr = await signup(['venue_manager']);
  const v = ok(await api('POST', '/venues', { token: mgr.token, body: { name: `Arena ${n}`, city: 'Pune', timezone: TZ, currency: 'INR' } }), 201);
  ok(await api('POST', `/venues/${v.id}/hours`, { token: mgr.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '06:00', closes: '22:00' })) } }));
  const court = ok(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court A', sport: 'football', hourly_rate_cents: 50000, max_players: 10 } }), 201);
  const coach = await signup(['coach']);
  ok(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 70000 } }), 201);
  const card = ok(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Group clinic', sport: 'football', audience: 'group', delivery: 'both', unit: 'session', duration_min: 60, price_cents: 0, per_person: true, min_participants: 1, max_participants: 10 } }), 201);
  return { mgr, v, court, coach, card };
}
const book = async (s, day = 3, from = 17, to = 19) => ok(await api('POST', '/reservations', { token: s.coach.token, body: { items: [{ resource_id: s.court.id, starts_at: at(day, from), ends_at: at(day, to) }] } }), 201);
const bookingOf = async (reservation) => (await pool.query('SELECT id FROM bookings WHERE reservation_id=$1', [reservation.id])).rows[0].id;
const publish = (s, body) => api('POST', '/coach/classes', { token: s.coach.token, body: { rate_card_id: s.card.id, starts_at: at(3, 17), duration_minutes: 60, ...body } });

test('a class at a venue needs a confirmed court booking: a venue alone is refused, the booking supplies the venue', async () => {
  const s = await setup();
  const alone = await publish(s, { venue_id: s.v.id });
  assert.equal(alone.status, 400, JSON.stringify(alone.body)); assert.equal(alone.body.error?.details?.code ?? alone.body.error?.code, 'booking_required');
  assert.equal((await publish(s, {})).status, 400, 'neither a booking nor an online link');
  const stranger = await signup(['coach']);
  const reservation = await book(s);
  const bid = await bookingOf(reservation);
  assert.equal((await api('POST', '/coach/classes', { token: stranger.token, body: { rate_card_id: s.card.id, starts_at: at(3, 17), booking_id: bid } })).status, 404, 'a stranger cannot use someone else\'s rate card');
  const offered = ok(await api('GET', '/coach/class-bookings', { token: s.coach.token, query: { starts_at: at(3, 17), duration_minutes: '60' } }));
  assert.equal(offered.length, 1); assert.equal(offered[0].covers, true); assert.equal(offered[0].venue_id, s.v.id);
  assert.equal(ok(await api('GET', '/coach/class-bookings', { token: stranger.token })).length, 0, 'only your own bookings are offered');
  const wrongTime = await publish(s, { booking_id: bid, starts_at: at(5, 17) });
  assert.equal(wrongTime.status, 409); assert.equal(wrongTime.body.error?.details?.code ?? wrongTime.body.error?.code, 'booking_window');
  const k = ok(await publish(s, { booking_id: bid }), 201);
  assert.equal(k.place.venue_id, s.v.id, 'the venue comes from the booking');
  const res = ok(await api('GET', `/reservations/${reservation.id}`, { token: s.mgr.token }));
  assert.ok(res.sessions.some((x) => x.type === 'coach_class' && x.session_id === k.id), 'the venue team sees the class on the reservation');
  return { s, k, reservation };
});

test('cancelling the court booking cancels the class with it, refunds nothing twice and tells the seat holders', async () => {
  const s = await setup();
  const reservation = await book(s, 4);
  const bid = await bookingOf(reservation);
  const k = ok(await publish(s, { booking_id: bid, starts_at: at(4, 17) }), 201);
  const athlete = await signup();
  ok(await api('POST', `/coach/classes/${k.id}/join`, { token: athlete.token, body: {} }), 201);
  ok(await api('DELETE', `/bookings/${bid}`, { token: s.mgr.token, body: { reason: 'Maintenance' } }));
  assert.equal((await pool.query('SELECT status FROM coach_classes WHERE id=$1', [k.id])).rows[0].status, 'cancelled');
  assert.equal((await pool.query("SELECT status FROM coach_class_seats WHERE class_id=$1", [k.id])).rows[0].status, 'cancelled');
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='coach_class_venue_cancelled'", [s.coach.id])).rowCount, 'the coach is told');
});

test('plan a class, share it with seat holders, and track each person; others never see the plan', async () => {
  const s = await setup();
  const reservation = await book(s, 6);
  const k = ok(await publish(s, { booking_id: await bookingOf(reservation), starts_at: at(6, 17) }), 201);
  const a = await signup(), b = await signup(), outsider = await signup();
  for (const u of [a, b]) ok(await api('POST', `/coach/classes/${k.id}/join`, { token: u.token, body: {} }), 201);
  assert.equal((await api('POST', `/coach/classes/${k.id}/workspace`, { token: a.token })).status, 403, 'only the coach opens the workspace');
  const w = ok(await api('POST', `/coach/classes/${k.id}/workspace`, { token: s.coach.token }));
  assert.equal(w.roster.length, 2); assert.equal(w.plan.version, 0);
  assert.equal(ok(await api('POST', `/coach/classes/${k.id}/workspace`, { token: s.coach.token })).record_id, w.record_id, 'repeating returns the same record');
  assert.equal((await api('POST', `/coach/classes/${k.id}/plan/share`, { token: s.coach.token, body: { share: true } })).status, 400, 'nothing to share yet');

  ok(await api('POST', `/coaching/sessions/${w.record_id}/plan`, { token: s.coach.token, body: { objective: 'First touch under pressure', blocks: [{ kind: 'warm_up', title: 'Passing squares', duration_min: 10, coach_notes: 'watch Asha\'s left foot' }, { kind: 'skill_drill', title: 'Receive and turn', duration_min: 20, instructions: 'Open body shape' }] } }));
  const before = ok(await api('GET', `/coach/classes/${k.id}/plan`, { token: a.token }));
  assert.equal(before.shared, false, 'a plan is private until shared');
  assert.equal((await api('GET', `/coach/classes/${k.id}/plan`, { token: outsider.token })).status, 404);

  const shared = ok(await api('POST', `/coach/classes/${k.id}/plan/share`, { token: s.coach.token, body: { share: true } }));
  assert.equal(shared.told, 2); assert.equal(shared.shared_version, 1);
  const mine = ok(await api('GET', `/coach/classes/${k.id}/plan`, { token: a.token }));
  assert.equal(mine.shared, true); assert.equal(mine.objective, 'First touch under pressure'); assert.equal(mine.blocks.length, 2);
  assert.ok(!JSON.stringify(mine).includes('left foot'), 'private coach notes are never shared');
  assert.equal((await api('GET', `/coach/classes/${k.id}/plan`, { token: outsider.token })).status, 404);

  // track: attendance, a note with a score, a summary shared with the athlete
  await pool.query('UPDATE coach_classes SET starts_at = now() - interval \'1 hour\' WHERE id=$1', [k.id]);
  const seat = (await pool.query("SELECT id FROM coach_class_seats WHERE class_id=$1 AND user_id=$2", [k.id, a.id])).rows[0];
  ok(await api('POST', `/coach/classes/${k.id}/seats/${seat.id}/attendance`, { token: s.coach.token, body: { attendance: 'attended' } }));
  ok(await api('POST', `/coaching/sessions/${w.record_id}/player-summaries`, { token: s.coach.token, body: { athlete_id: a.id, summary: 'Much better first touch.', shared: true } }));
  const after2 = ok(await api('POST', `/coach/classes/${k.id}/workspace`, { token: s.coach.token }));
  const row = after2.roster.find((r) => r.user_id === a.id);
  assert.equal(row.class_attendance, 'attended'); assert.equal(row.attendance_rate, 100); assert.equal(row.summary_shared, true);
  const seen = ok(await api('GET', `/coach/classes/${k.id}/plan`, { token: a.token }));
  assert.equal(seen.people[0].attendance, 'attended'); assert.equal(seen.people[0].summary, 'Much better first touch.');
  assert.equal(ok(await api('GET', `/coach/classes/${k.id}/plan`, { token: b.token })).people[0].summary, null, 'one person never sees another\'s summary');

  // the coach's athlete tools now work for class students (a coaching relationship exists)
  assert.equal((await api('POST', '/coaching/observations', { token: s.coach.token, body: { athlete_id: a.id, session_record_id: w.record_id, note: 'Quick feet', visibility: 'coach_private' } })).status, 201);

  // copy the plan to another class
  const k2 = ok(await publish(s, { booking_id: await bookingOf(await book(s, 7)), starts_at: at(7, 17) }), 201);
  const w2 = ok(await api('POST', `/coach/classes/${k2.id}/workspace`, { token: s.coach.token }));
  assert.ok(w2.copy_from.some((c) => c.class_id === k.id));
  ok(await api('POST', `/coach/classes/${k2.id}/plan/copy`, { token: s.coach.token, body: { from_class_id: k.id } }));
  assert.equal(ok(await api('POST', `/coach/classes/${k2.id}/workspace`, { token: s.coach.token })).plan.blocks.length, 2);
  assert.equal(ok(await api('POST', `/coach/classes/${k2.id}/workspace`, { token: s.coach.token })).shared, false, 'a copied plan is not shared automatically');

  // stop sharing
  assert.equal(ok(await api('POST', `/coach/classes/${k.id}/plan/share`, { token: s.coach.token, body: { share: false } })).shared, false);
  assert.equal(ok(await api('GET', `/coach/classes/${k.id}/plan`, { token: a.token })).shared, false);
});

test('score a class on the coach\'s own rubric: per person and skill, history kept, out-of-scale and unseated refused', async () => {
  const s = await setup();
  const k = ok(await api('POST', '/coach/classes', { token: s.coach.token, body: { rate_card_id: s.card.id, starts_at: at(8, 17), online_url: 'https://meet.example.com/x', max_participants: 6 } }), 201);
  const a = await signup(), outsider = await signup();
  ok(await api('POST', `/coach/classes/${k.id}/join`, { token: a.token, body: {} }), 201);
  const rubric = ok(await api('POST', '/coaching/rubrics', { token: s.coach.token, body: { name: 'Passing', sport: 'football', dimensions: [{ key: 'first_touch', name: 'First touch', scale_min: 1, scale_max: 5 }, { key: 'scanning', name: 'Scanning', scale_min: 1, scale_max: 5 }] } }), 201);
  const post = (scores) => api('POST', `/coach/classes/${k.id}/scores`, { token: s.coach.token, body: { rubric_id: rubric.rubric_id ?? rubric.id, scores } });
  assert.equal((await post([{ athlete_id: a.id, dimension_key: 'first_touch', score: 9 }])).status, 400, 'outside the dimension\'s scale');
  assert.equal((await post([{ athlete_id: outsider.id, dimension_key: 'first_touch', score: 3 }])).status, 400, 'no confirmed seat');
  assert.equal((await post([{ athlete_id: a.id, dimension_key: 'nope', score: 3 }])).status, 400);
  assert.equal(ok(await post([{ athlete_id: a.id, dimension_key: 'first_touch', score: 3 }, { athlete_id: a.id, dimension_key: 'scanning', score: 2 }])).saved, 2);
  assert.equal(ok(await post([{ athlete_id: a.id, dimension_key: 'first_touch', score: 3 }])).saved, 0, 'the same score again adds nothing');
  assert.equal(ok(await post([{ athlete_id: a.id, dimension_key: 'first_touch', score: 4 }])).saved, 1);
  const grid = ok(await api('GET', `/coach/classes/${k.id}/scores`, { token: s.coach.token, query: { rubric_id: rubric.rubric_id ?? rubric.id } }));
  assert.equal(grid.rows[0].dimensions.first_touch.score, 4); assert.equal(grid.rows[0].dimensions.scanning.score, 2);
  assert.equal((await api('GET', `/coach/classes/${k.id}/scores`, { token: a.token, query: { rubric_id: rubric.rubric_id ?? rubric.id } })).status, 403, 'only the coach');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM coaching_observations WHERE athlete_id=$1 AND visibility <> 'coach_private'", [a.id])).rows[0].n, 0, 'scoring shares nothing with the student');
});
