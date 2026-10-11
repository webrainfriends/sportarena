import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { fromLocal, addDays } = await import('../src/booking/time.js');
const { expandDates } = await import('../src/recurrence.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `vs_${n}_${roles[0]}`, display_name: `Vs ${n}`, email: `vs${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const TZ = 'Asia/Kolkata';
const today = new Date().toISOString().slice(0, 10);
const dayPlus = (d) => addDays(today, d);
const at = (date, hour, min = 0) => fromLocal(date, hour * 60 + min, TZ).toISOString();
const dowOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function makeVenue() {
  const mgr = await signup(['venue_manager']);
  const v = ok(await api('POST', '/venues', { token: mgr.token, body: { name: `Arena ${n}`, city: 'Pune', timezone: TZ, currency: 'INR' } }), 201);
  ok(await api('POST', `/venues/${v.id}/hours`, { token: mgr.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '06:00', closes: '22:00' })) } }));
  const mk = (name) => api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name, sport: 'football', hourly_rate_cents: 50000, max_players: 10 } }).then((r) => ok(r, 201));
  return { mgr, v, a: await mk('Court A'), b: await mk('Court B') };
}
async function coachOf() {
  const coach = await signup(['coach']);
  ok(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', hourly_rate_cents: 60000 } }), 201);
  return coach;
}
/** a weekly series (Tue/Thu 17:00 venue-local), `count` sessions, starting tomorrow-ish */
const series = (athlete, coach, over = {}) => api('POST', '/hires/series', { token: athlete.token, body: { coach_id: coach.id, sport: 'football', start: '17:00', timezone: TZ, duration_min: 60, starts_on: dayPlus(2), weekdays: [2, 4], count: 6, ...over } });

test('recurrence: weekly pattern, every n weeks, custom dates and exclusions', () => {
  const d = expandDates({ starts_on: '2026-11-02', weekdays: [1, 3], count: 4, every_n_weeks: 1, exclude_dates: [], extra_dates: [] });
  assert.deepEqual(d, ['2026-11-02', '2026-11-04', '2026-11-09', '2026-11-11']);
  assert.deepEqual(expandDates({ starts_on: '2026-11-02', weekdays: [1], ends_on: '2026-12-01', every_n_weeks: 2, exclude_dates: ['2026-11-16'], extra_dates: ['2026-11-20'] }), ['2026-11-02', '2026-11-20', '2026-11-30']);
  assert.deepEqual(expandDates({ starts_on: '2026-11-02', weekdays: [], exclude_dates: [], extra_dates: ['2026-11-05', '2026-11-03'] }), ['2026-11-03', '2026-11-05'], 'custom dates only');
  assert.throws(() => expandDates({ starts_on: '2026-11-02', weekdays: [1], exclude_dates: [], extra_dates: [] }), /ends/);
  assert.throws(() => expandDates({ starts_on: '2026-11-02', weekdays: [0, 1, 2, 3, 4, 5, 6], count: 60, exclude_dates: [], extra_dates: ['2027-01-01'] }), /most in one go/);
});

test('coaching series: preview, skip or refuse unbookable dates, one hire per date', async () => {
  const coach = await coachOf(), athlete = await signup(), other = await signup();
  const prev = ok(await series(athlete, coach, { preview: true }), 201);
  assert.equal(prev.requested, 6); assert.equal(prev.bookable, 6); assert.equal(prev.total_cents, 6 * 60000);
  // someone else already holds one of the dates
  const taken = prev.dates[2];
  ok(await api('POST', '/hires', { token: other.token, body: { coach_id: coach.id, sport: 'football', starts_at: taken.starts_at, duration_min: 60 } }), 201);
  const p2 = ok(await series(athlete, coach, { preview: true }), 201);
  assert.equal(p2.bookable, 5); assert.equal(p2.skipped[0].date, taken.date);
  const strict = await series(athlete, coach, { on_conflict: 'fail' });
  assert.equal(strict.status, 409); assert.equal(ok(await api('GET', '/hires', { token: athlete.token })).length, 0, 'nothing was booked');
  const made = ok(await series(athlete, coach, { exclude_dates: [prev.dates[0].date] }), 201);
  assert.equal(made.hires.length, 4); assert.equal(made.skipped.length, 1);
  const rows = ok(await api('GET', '/hires', { token: athlete.token }));
  assert.equal(rows.length, 4); assert.ok(rows.every((h) => h.series_id === made.series_id));
  assert.equal((await api('POST', '/hires/series', { token: athlete.token, body: { coach_id: athlete.id, sport: 'football', start: '17:00', starts_on: dayPlus(2), weekdays: [2], count: 2 } })).status, 409, 'cannot hire yourself: no date can be booked');
  assert.equal((await series(athlete, coach, { starts_on: dayPlus(-30), weekdays: [], extra_dates: [dayPlus(-30)] })).status, 409, 'past dates cannot be booked');
});

test('book a court for a series: either party can book, sessions are linked, the other side is told', async () => {
  const { mgr, v, a } = await makeVenue();
  const coach = await coachOf(), athlete = await signup(), stranger = await signup();
  const made = ok(await series(athlete, coach, { starts_on: dayPlus(3), count: 4 }), 201);
  const refs = made.hires.map((h) => ({ type: 'coach_hire', id: h.id }));
  const board0 = ok(await api('GET', '/training/venues/board', { token: athlete.token }));
  assert.equal(board0.needs_venue.length, 4); assert.equal(board0.has_venue.length, 0);
  assert.equal((await api('POST', '/training/venues/book', { token: stranger.token, body: { sessions: refs, resource_id: a.id } })).status, 403);
  assert.equal((await api('POST', '/training/venues/book', { token: athlete.token, body: { sessions: refs } })).status, 400, 'a court is required');
  const quote = ok(await api('POST', '/training/venues/quote', { token: athlete.token, body: { sessions: refs, resource_id: a.id, buffer_before_min: 0 } }));
  assert.equal(quote.ok, true); assert.equal(quote.lines_placed, 4); assert.equal(quote.total_cents, 4 * 50000); assert.equal(quote.booked, false);
  assert.equal(ok(await api('GET', '/reservations', { token: athlete.token })).length, 0, 'a quote books nothing');
  const booked = ok(await api('POST', '/training/venues/book', { token: athlete.token, body: { sessions: refs, resource_id: a.id } }), 201);
  assert.equal(booked.booked, true); assert.equal(booked.lines_placed, 4); assert.ok(booked.code);
  const res = ok(await api('GET', `/reservations/${booked.reservation_id}`, { token: athlete.token }));
  assert.equal(res.bookings.length, 4); assert.equal(res.sessions.length, 4, 'the reservation shows its coaching sessions');
  assert.ok(res.sessions.every((s) => s.coach_name && s.athlete_name));
  assert.equal(ok(await api('GET', `/reservations/${booked.reservation_id}`, { token: mgr.token })).sessions.length, 4, 'the venue team sees the coaching sessions too');
  // both sides see it on their board and schedule
  const mine = ok(await api('GET', '/training/venues/board', { token: athlete.token }));
  assert.equal(mine.has_venue.length, 4); assert.equal(mine.has_venue[0].venue.venue_name, v.name);
  const theirs = ok(await api('GET', '/training/venues/board', { token: coach.token }));
  assert.equal(theirs.has_venue.length, 4); assert.equal(theirs.has_venue[0].i_am_coach, true);
  assert.ok(JSON.stringify(ok(await api('GET', '/notifications', { token: coach.token }))).includes(`booked ${v.name}`) || JSON.stringify(ok(await api('GET', '/notifications', { token: coach.token }))).includes('booked a venue'));
  const cal = ok(await api('GET', `/coach/calendar?from=${dayPlus(1)}&to=${dayPlus(30)}`, { token: coach.token }));
  assert.ok(cal.items.filter((x) => x.kind === 'hire').every((x) => x.venue?.startsWith(v.name)), 'coach calendar shows where');
  assert.ok(ok(await api('GET', '/coaching/overview', { token: athlete.token })).athlete.upcoming.every((h) => h.venue?.includes('Court A')));
  // a session can only be held once
  const again = await api('POST', '/training/venues/book', { token: athlete.token, body: { sessions: refs, resource_id: a.id } });
  assert.equal(again.status, 409); assert.equal(again.body.error.details.problems.length, 4);
  // cancelling a session frees its link; the booking stays
  ok(await api('PATCH', `/hires/${made.hires[0].id}`, { token: athlete.token, body: { status: 'cancelled' } }));
  const after = ok(await api('GET', '/training/venues/board', { token: athlete.token }));
  assert.equal(after.has_venue.length, 3);
});

test('court taken on some dates: skip them or refuse everything; the coach can be the booker', async () => {
  const { a, b } = await makeVenue();
  const coach = await coachOf(), athlete = await signup(), rival = await signup();
  const made = ok(await series(athlete, coach, { starts_on: dayPlus(3), count: 3 }), 201);
  const refs = made.hires.map((h) => ({ type: 'coach_hire', id: h.id }));
  const second = made.hires[1];
  ok(await api('POST', '/reservations', { token: rival.token, body: { items: [{ resource_id: a.id, starts_at: new Date(second.starts_at).toISOString(), ends_at: new Date(+new Date(second.starts_at) + 3600_000).toISOString() }] } }), 201);
  const q = ok(await api('POST', '/training/venues/quote', { token: coach.token, body: { sessions: refs, resource_id: a.id } }));
  assert.equal(q.ok, false); assert.equal(q.lines_placed, 2); assert.equal(q.problems.length, 1); assert.equal(q.problems[0].session_id, second.id);
  const strict = await api('POST', '/training/venues/book', { token: coach.token, body: { sessions: refs, resource_id: a.id, on_conflict: 'fail' } });
  assert.equal(strict.status, 409);
  assert.equal(ok(await api('GET', '/reservations', { token: coach.token })).length, 0, 'refused: nothing booked');
  // the coach books, using Court B for the taken one (custom arrangement)
  const custom = ok(await api('POST', '/training/venues/book', { token: coach.token, body: { sessions: [refs[0], { ...refs[1], resource_id: b.id }, refs[2]], resource_id: a.id } }), 201);
  assert.equal(custom.lines_placed, 3); assert.equal(custom.problems.length, 0);
  const res = ok(await api('GET', `/reservations/${custom.reservation_id}`, { token: coach.token }));
  assert.deepEqual(res.bookings.map((x) => x.resource_name).sort(), ['Court A', 'Court A', 'Court B']);
  assert.ok(JSON.stringify(ok(await api('GET', '/notifications', { token: athlete.token }))).includes('booked a venue'), 'the athlete is told');
});

test('attach sessions to a booking you already made, and recurring court bookings that pick up your sessions', async () => {
  const { a } = await makeVenue();
  const coach = await coachOf(), athlete = await signup();
  const date = dayPlus(5), later = dayPlus(6);
  const h1 = ok(await api('POST', '/hires', { token: athlete.token, body: { coach_id: coach.id, sport: 'football', starts_at: at(date, 17), duration_min: 60 } }), 201);
  const h2 = ok(await api('POST', '/hires', { token: athlete.token, body: { coach_id: coach.id, sport: 'football', starts_at: at(later, 17), duration_min: 60 } }), 201);
  // the athlete books a court for 16:30-18:30 on the first date only
  const rs = ok(await api('POST', '/reservations', { token: athlete.token, body: { items: [{ resource_id: a.id, starts_at: at(date, 16, 0), ends_at: at(date, 18) }] } }), 201);
  const bad = await api('POST', '/training/venues/attach', { token: athlete.token, body: { reservation_id: rs.id, sessions: [{ type: 'coach_hire', id: h2.id }] } });
  assert.equal(bad.status, 409, 'the booked time does not cover that session');
  assert.equal((await api('POST', '/training/venues/attach', { token: coach.token, body: { reservation_id: rs.id } })).status, 403, 'only the booker attaches');
  const got = ok(await api('POST', '/training/venues/attach', { token: athlete.token, body: { reservation_id: rs.id } }));
  assert.deepEqual(got.linked.map((x) => x.session_id), [h1.id]);
  // release keeps the booking
  const link = (await pool.query('SELECT id FROM session_venue_links WHERE session_id=$1 AND released_at IS NULL', [h1.id])).rows[0];
  assert.equal((await api('DELETE', `/training/venues/links/${link.id}`, { token: (await signup()).token })).status, 403);
  ok(await api('DELETE', `/training/venues/links/${link.id}`, { token: coach.token }));
  assert.equal(ok(await api('GET', `/reservations/${rs.id}`, { token: athlete.token })).bookings.length, 1);
  // recurring: Mon-Sun style pattern on the two session dates at 17:00-18:00, attaching the sessions
  const q = ok(await api('POST', '/reservations/recurring/quote', { token: athlete.token, body: { resource_id: a.id, start: '17:00', end: '18:00', starts_on: later, weekdays: [], extra_dates: [later, dayPlus(9), dayPlus(13)], attach_sessions: true } }));
  assert.equal(q.lines_placed, 3); assert.equal(q.sessions_attached, 1);
  const rec = ok(await api('POST', '/reservations/recurring', { token: athlete.token, body: { resource_id: a.id, start: '17:00', end: '18:00', starts_on: later, weekdays: [], extra_dates: [later, dayPlus(9), dayPlus(13)], exclude_dates: [dayPlus(13)], attach_sessions: true } }), 201);
  assert.equal(rec.lines_placed, 2); assert.equal(rec.sessions_attached, 1); assert.equal(rec.dates_requested, 2);
  assert.equal(ok(await api('GET', `/reservations/${rec.reservation_id}`, { token: athlete.token })).sessions.length, 1);
  // a true weekly pattern
  const wd = dowOf(dayPlus(20));
  const weekly = ok(await api('POST', '/reservations/recurring', { token: athlete.token, body: { resource_id: a.id, start: '18:00', end: '19:00', starts_on: dayPlus(20), weekdays: [wd], count: 4 } }), 201);
  assert.equal(weekly.lines_placed, 4); assert.equal(weekly.dates.length, 4);
  assert.equal((await api('POST', '/reservations/recurring', { token: athlete.token, body: { resource_id: a.id, start: '19:00', end: '18:00', starts_on: dayPlus(20), weekdays: [wd], count: 2 } })).status, 400);
  // the same weekly pattern again: every date is taken
  const clash = await api('POST', '/reservations/recurring', { token: athlete.token, body: { resource_id: a.id, start: '18:00', end: '19:00', starts_on: dayPlus(20), weekdays: [wd], count: 4 } });
  assert.equal(clash.status, 409);
});
