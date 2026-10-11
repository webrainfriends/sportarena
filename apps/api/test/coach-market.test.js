import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `cm_${n}_${roles[0]}`, display_name: `Cm ${n}`, email: `cm${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const inFuture = (days, hour = 9) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const coachOf = async (sport = 'football', rate = 60000) => {
  const coach = await signup(['coach']);
  ok(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport, role: 'coach', level: 'pro', hourly_rate_cents: rate } }), 201);
  return coach;
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('post a need, coaches answer, athlete accepts one: a hire is created and the rest are declined', async () => {
  const athlete = await signup(['athlete']), c1 = await coachOf(), c2 = await coachOf(), other = await coachOf('tennis');
  const req = ok(await api('POST', '/coach-requests', { token: athlete.token, body: { sport: 'football', title: 'Goalkeeping twice a week', delivery: 'in_person', budget_max_cents: 70000, sessions_per_week: 2, preferred_days: [2, 4, 2] } }), 201);
  assert.deepEqual(req.preferred_days, [2, 4]);
  // it is also a Community card that points back at the request
  const feed = ok(await api('GET', '/market/posts?kind=wanted', { token: c1.token })).find((x) => x.coach_request_id === req.id);
  assert.ok(feed && feed.title.startsWith('Coach wanted') && feed.is_mine === false, 'request is published in the community feed');
  // any signed-in person can open the request; the page tells them what is missing before they can answer
  const peek = ok(await api('GET', `/coach-requests/${req.id}`, { token: other.token }));
  assert.deepEqual(peek.can_respond, { is_coach: true, coaches_this_sport: false, open: true });
  const fan = await signup(['athlete']);
  assert.equal(ok(await api('GET', `/coach-requests/${req.id}`, { token: fan.token })).can_respond.is_coach, false);
  assert.equal(ok(await api('GET', '/coach-requests?all_sports=true', { token: fan.token })).some((r) => r.id === req.id), true, 'visible on Open positions for everyone signed in');
  // the board shows it to football coaches only
  assert.equal(ok(await api('GET', '/coach-requests', { token: c1.token })).filter((r) => r.id === req.id).length, 1);
  assert.equal(ok(await api('GET', '/coach-requests', { token: other.token })).filter((r) => r.id === req.id).length, 0, 'tennis coach does not see football request by default');
  assert.equal(ok(await api('GET', '/coach-requests?all_sports=true', { token: athlete.token })).some((r) => r.id === req.id), false, 'you do not see your own request on the board');
  assert.equal((await api('POST', `/coach-requests/${req.id}/respond`, { token: other.token, body: { starts_at: inFuture(3) } })).status, 400, 'must coach the sport');
  assert.equal((await api('POST', `/coach-requests/${req.id}/respond`, { token: athlete.token, body: { starts_at: inFuture(3) } })).status, 403);
  const a1 = ok(await api('POST', `/coach-requests/${req.id}/respond`, { token: c1.token, body: { starts_at: inFuture(3), message: 'Happy to help', rate_cents_hour: 55000 } }), 201);
  const a2 = ok(await api('POST', `/coach-requests/${req.id}/respond`, { token: c2.token, body: { starts_at: inFuture(4) } }), 201);
  assert.equal(a2.rate_cents_hour, 60000, 'defaults to the coach\'s own rate');
  // the athlete sees both answers, a coach only their own
  const seen = ok(await api('GET', `/coach-requests/${req.id}`, { token: athlete.token }));
  assert.equal(seen.responses.length, 2);
  assert.ok(!/email|password/i.test(JSON.stringify(seen)));
  const mine = ok(await api('GET', `/coach-requests/${req.id}`, { token: c1.token }));
  assert.equal(mine.responses.length, 0); assert.equal(mine.my_response.id, a1.id);
  assert.equal(ok(await api('GET', '/coach-requests/mine', { token: athlete.token }))[0].pending_responses, 2);
  // only the owner decides
  assert.equal((await api('POST', `/coach-responses/${a1.id}/decision`, { token: c2.token, body: { decision: 'accept' } })).status, 403);
  const done = ok(await api('POST', `/coach-responses/${a1.id}/decision`, { token: athlete.token, body: { decision: 'accept' } }));
  assert.equal(done.status, 'accepted');
  assert.equal(done.hire.total_cents, 55000); assert.equal(done.hire.status, 'confirmed', 'no payment provider in tests: confirmed straight away');
  const after2 = ok(await api('GET', `/coach-requests/${req.id}`, { token: athlete.token }));
  assert.equal(after2.status, 'filled');
  assert.equal(ok(await api('GET', '/market/posts?kind=wanted', { token: c1.token })).some((x) => x.coach_request_id === req.id), false, 'a filled request leaves the open feed');
  assert.deepEqual(after2.responses.map((r) => r.status).sort(), ['accepted', 'declined']);
  assert.equal((await api('POST', `/coach-responses/${a2.id}/decision`, { token: athlete.token, body: { decision: 'accept' } })).status, 409, 'already declined');
  assert.equal((await api('POST', `/coach-requests/${req.id}/respond`, { token: c2.token, body: { starts_at: inFuture(5) } })).status, 409, 'request is filled');
  // the accepted coach was told
  const inbox = ok(await api('GET', '/notifications', { token: c1.token }));
  assert.ok(JSON.stringify(inbox).includes('chose you'));
});

test('closing a request declines pending answers; answers can be withdrawn; youth cannot post', async () => {
  const athlete = await signup(['athlete']), coach = await coachOf();
  const req = ok(await api('POST', '/coach-requests', { token: athlete.token, body: { sport: 'football', title: 'Fitness block' } }), 201);
  const a = ok(await api('POST', `/coach-requests/${req.id}/respond`, { token: coach.token, body: { starts_at: inFuture(3) } }), 201);
  const updated = ok(await api('POST', `/coach-requests/${req.id}/respond`, { token: coach.token, body: { starts_at: inFuture(3), rate_cents_hour: 40000 } }), 201);
  assert.equal(updated.id, a.id, 'answering again updates the same answer');
  ok(await api('POST', `/coach-responses/${a.id}/withdraw`, { token: coach.token }));
  assert.equal((await api('POST', `/coach-responses/${a.id}/withdraw`, { token: coach.token })).status, 409);
  ok(await api('POST', `/coach-requests/${req.id}/close`, { token: athlete.token }));
  assert.equal((await api('POST', `/coach-requests/${req.id}/close`, { token: athlete.token })).status, 409);
  assert.equal((await api('POST', `/coach-requests/${req.id}/respond`, { token: coach.token, body: { starts_at: inFuture(3) } })).status, 409);
  assert.equal(ok(await api('GET', '/coach-requests/mine?status=closed', { token: athlete.token })).length, 1, 'kept as history');
  await pool.query("UPDATE users SET youth_until = current_date + 400 WHERE id=$1", [athlete.id]);
  assert.equal((await api('POST', '/coach-requests', { token: athlete.token, body: { sport: 'football', title: 'Minor request' } })).status, 403);
});

test('coach hours drive bookable slots; booking off-grid is refused; profile shows rating after a verified review', async () => {
  const coach = await coachOf(), athlete = await signup(['athlete']);
  assert.equal(ok(await api('GET', `/coaches/${coach.id}/slots`)).grid, false, 'no hours = no grid');
  ok(await api('POST', '/me/coach-profile', { token: coach.token, body: { headline: 'GK specialist', city: 'Pune', delivery: 'both', specialties: ['goalkeeping'], timezone: 'UTC', slot_min: 60 } }));
  assert.equal((await api('POST', '/me/coach-availability', { token: coach.token, body: { windows: [{ weekday: 1, start: '10:00', end: '09:00' }] } })).status, 400);
  const all = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '09:00', end: '12:00' }));
  ok(await api('POST', '/me/coach-availability', { token: coach.token, body: { windows: all } }));
  const slots = ok(await api('GET', `/coaches/${coach.id}/slots?from=${encodeURIComponent(inFuture(2, 0))}&to=${encodeURIComponent(inFuture(3, 0))}`));
  assert.equal(slots.grid, true); assert.equal(slots.slots.length, 3);
  const body = { coach_id: coach.id, sport: 'football', starts_at: slots.slots[0], duration_min: 60 };
  assert.equal((await api('POST', '/hires', { token: athlete.token, body: { ...body, starts_at: inFuture(2, 15) } })).status, 409, 'outside open hours');
  const hire = ok(await api('POST', '/hires', { token: athlete.token, body }), 201);
  const after2 = ok(await api('GET', `/coaches/${coach.id}/slots?from=${encodeURIComponent(inFuture(2, 0))}&to=${encodeURIComponent(inFuture(3, 0))}`));
  assert.equal(after2.slots.length, 2, 'a booked slot disappears');
  // review needs a completed session, by the athlete, once
  assert.equal((await api('POST', `/hires/${hire.id}/review`, { token: athlete.token, body: { rating: 5 } })).status, 409);
  ok(await api('PATCH', `/hires/${hire.id}`, { token: coach.token, body: { status: 'confirmed' } }));
  ok(await api('PATCH', `/hires/${hire.id}`, { token: coach.token, body: { status: 'completed' } }));
  assert.equal((await api('POST', `/hires/${hire.id}/review`, { token: coach.token, body: { rating: 5 } })).status, 403);
  const review = ok(await api('POST', `/hires/${hire.id}/review`, { token: athlete.token, body: { rating: 4, body: 'Sharp drills' } }), 201);
  assert.equal((await api('POST', `/hires/${hire.id}/review`, { token: athlete.token, body: { rating: 1 } })).status, 409);
  assert.equal((await api('POST', `/coach-reviews/${review.id}/reply`, { token: athlete.token, body: { reply: 'Thanks!' } })).status, 403);
  ok(await api('POST', `/coach-reviews/${review.id}/reply`, { token: coach.token, body: { reply: 'Thanks, see you Tuesday' } }));
  assert.equal((await api('POST', `/coach-reviews/${review.id}/reply`, { token: coach.token, body: { reply: 'Again' } })).status, 409);
  const prof = ok(await api('GET', `/coaches/${coach.id}`));
  assert.equal(prof.rating.avg, 4); assert.equal(prof.rating.count, 1); assert.equal(prof.stats.sessions_done, 1);
  assert.equal(prof.reviews[0].reply, 'Thanks, see you Tuesday'); assert.equal(prof.profile.headline, 'GK specialist');
  assert.ok(!/email|password/i.test(JSON.stringify(prof)));
  // search: rating filter, sort, hours filter
  const found = ok(await api('GET', '/coaches?sport=football&min_rating=4&has_hours=true'));
  assert.deepEqual(found.map((x) => x.id), [coach.id]);
  assert.equal(found[0].rating, 4); assert.equal(found[0].sessions_done, 1);
  assert.ok(ok(await api('GET', '/coaches?sport=football&max_rate_cents=100&sort=rate')).every((x) => Number(x.hourly_rate_cents) <= 100));
  assert.equal(ok(await api('GET', '/coaches?sport=football&q=goalkeeping')).some((x) => x.id === coach.id), true, 'searches specialties');
  // not taking athletes: hidden from booking
  ok(await api('POST', '/me/coach-profile', { token: coach.token, body: { accepting: false } }));
  assert.equal((await api('POST', '/hires', { token: athlete.token, body: { ...body, starts_at: slots.slots[1] } })).status, 400);
});

test('overview and payment ledger track schedule and money for both sides', async () => {
  const coach = await coachOf(), athlete = await signup(['athlete']);
  const h1 = ok(await api('POST', '/hires', { token: athlete.token, body: { coach_id: coach.id, sport: 'football', starts_at: inFuture(3), duration_min: 90 } }), 201);
  const h2 = ok(await api('POST', '/hires', { token: athlete.token, body: { coach_id: coach.id, sport: 'football', starts_at: inFuture(5), duration_min: 60 } }), 201);
  ok(await api('PATCH', `/hires/${h1.id}`, { token: coach.token, body: { status: 'confirmed' } }));
  ok(await api('PATCH', `/hires/${h2.id}`, { token: athlete.token, body: { status: 'cancelled' } }));
  const a = ok(await api('GET', '/coaching/overview', { token: athlete.token }));
  assert.equal(a.coach, null, 'athlete has no coach side');
  assert.deepEqual(a.athlete.upcoming.map((x) => x.id), [h1.id]);
  const c = ok(await api('GET', '/coaching/overview', { token: coach.token }));
  assert.equal(c.coach.upcoming.length, 1); assert.equal(c.coach.to_confirm.length, 0);
  assert.equal(ok(await api('GET', '/coaching/payments', { token: athlete.token })).length, 2);
  assert.equal(ok(await api('GET', '/coaching/payments?as=coach', { token: coach.token })).length, 2);
  assert.equal((await api('GET', '/coaching/payments?as=coach', { token: athlete.token })).status, 403);
  // the cancelled session notified the coach
  assert.ok(JSON.stringify(ok(await api('GET', '/notifications', { token: coach.token }))).includes('cancelled'));
});
