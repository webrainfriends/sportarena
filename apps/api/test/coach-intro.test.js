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
  const r = await api('POST', '/auth/register', { body: { handle: `ci_${n}_${roles[0]}`, display_name: `Ci ${n}`, email: `ci${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const dayAt = (days, hour = 9) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const coachWithIntro = async (extra = {}) => {
  const coach = await signup(['coach']);
  ok(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 60000 } }), 201);
  const intro = ok(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Trial', sport: 'football', audience: 'individual', unit: 'session', duration_min: 45, price_cents: 20000, is_intro: true, ...extra } }), 201);
  return { coach, intro };
};
const book = (who, coach, intro, day, extra = {}) => api('POST', '/hires', { token: who.token, body: { coach_id: coach.id, rate_card_id: intro.id, starts_at: dayAt(day), ...extra } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('concurrent double-booking of an intro: exactly one succeeds, the other is a clear 409', async () => {
  const { coach, intro } = await coachWithIntro(), athlete = await signup(['athlete']);
  const rs = await Promise.all([book(athlete, coach, intro, 3), book(athlete, coach, intro, 4), book(athlete, coach, intro, 5)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409], JSON.stringify(rs.map((r) => r.body)));
  const lost = rs.find((r) => r.status === 409).body.error;
  assert.equal(lost.details.code, 'intro_used');
  assert.match(lost.message, /used this coach's intro session/);
  const st = ok(await api('GET', `/coaches/${coach.id}/intro-status`, { token: athlete.token }));
  assert.equal(st.offers[0].available, false);
  const other = await signup(['athlete']);
  assert.equal(ok(await api('GET', `/coaches/${coach.id}/intro-status`, { token: other.token })).offers[0].available, true, 'another athlete is unaffected');
  ok(await book(other, coach, intro, 6), 201);
});

test('cancelled and refunded intros free the allowance; completed ones keep it', async () => {
  const { coach, intro } = await coachWithIntro(), athlete = await signup(['athlete']);
  const h1 = ok(await book(athlete, coach, intro, 3), 201);
  assert.equal((await book(athlete, coach, intro, 4)).status, 409);
  ok(await api('PATCH', `/hires/${h1.id}`, { token: athlete.token, body: { status: 'cancelled' } }));
  const h2 = ok(await book(athlete, coach, intro, 4), 201);
  ok(await api('PATCH', `/hires/${h2.id}`, { token: coach.token, body: { status: 'confirmed' } }));
  await pool.query("UPDATE coach_hires SET starts_at = now() - interval '2 hours' WHERE id=$1", [h2.id]);
  ok(await api('PATCH', `/hires/${h2.id}`, { token: coach.token, body: { status: 'completed' } }));
  assert.equal((await book(athlete, coach, intro, 5)).status, 409, 'a completed intro counts');
  await pool.query("UPDATE coach_hires SET payment_status='refunded' WHERE id=$1", [h2.id]);
  ok(await book(athlete, coach, intro, 5), 201);
  // expiry (the sweep sets status='expired') also frees it
  const e = await signup(['athlete']);
  const he = ok(await book(e, coach, intro, 6), 201);
  await pool.query("UPDATE coach_hires SET status='expired' WHERE id=$1", [he.id]);
  ok(await book(e, coach, intro, 6), 201);
});

test('other cards are not limited, and the limit is per coach unless the card is per sport', async () => {
  const { coach, intro } = await coachWithIntro(), athlete = await signup(['athlete']);
  const paid = ok(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Hour', sport: 'football', audience: 'individual', unit: 'hour', price_cents: 50000 } }), 201);
  ok(await book(athlete, coach, intro, 3), 201);
  ok(await book(athlete, coach, paid, 4), 201);
  ok(await book(athlete, coach, paid, 5), 201);
  const second = await coachWithIntro();
  ok(await book(athlete, second.coach, second.intro, 3), 201, 'a different coach has its own intro');
  const sc = await coachWithIntro({ intro_scope: 'sport' });
  ok(await book(athlete, sc.coach, sc.intro, 3), 201);
  assert.equal((await book(athlete, sc.coach, sc.intro, 4)).status, 409);
});

test('guardian bookings count against the child, not the paying guardian', async () => {
  const { coach, intro } = await coachWithIntro();
  const kid = await signup(['athlete']), parent = await signup(['athlete']), stranger = await signup(['athlete']);
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, kid.id]);
  assert.equal((await book(stranger, coach, intro, 3, { athlete_id: kid.id })).status, 404, 'not a guardian: existence is not leaked');
  const h = ok(await book(parent, coach, intro, 3, { athlete_id: kid.id }), 201);
  assert.equal(h.athlete_id, kid.id);
  assert.equal((await book(parent, coach, intro, 4, { athlete_id: kid.id })).status, 409, "the child's intro is used");
  ok(await book(parent, coach, intro, 4), 201);   // the guardian's own intro is separate
});

test('a series books the intro once; preview says so; accepting a coach answer is limited too', async () => {
  const { coach, intro } = await coachWithIntro(), athlete = await signup(['athlete']);
  const body = { coach_id: coach.id, rate_card_id: intro.id, start: '09:00', timezone: 'UTC', weekdays: [1, 2, 3, 4, 5, 6, 0], starts_on: dayAt(2).slice(0, 10), count: 3 };
  const pv = ok(await api('POST', '/hires/series', { token: athlete.token, body: { ...body, preview: true } }), 201);
  assert.equal(pv.bookable, 1);
  assert.match(pv.skipped[0].problem, /intro session/);
  const made = ok(await api('POST', '/hires/series', { token: athlete.token, body }), 201);
  assert.equal(made.hires.length, 1);
  // a coach quoting their intro card on an athlete's request: accepting is limited like a direct booking
  const used = await signup(['athlete']);
  ok(await book(used, coach, intro, 12), 201);
  const req = ok(await api('POST', '/coach-requests', { token: used.token, body: { sport: 'football', title: 'Need a coach', delivery: 'in_person', budget_max_cents: 70000 } }), 201);
  const ans = ok(await api('POST', `/coach-requests/${req.id}/respond`, { token: coach.token, body: { rate_card_id: intro.id, starts_at: dayAt(14) } }), 201);
  const acc = await api('POST', `/coach-responses/${ans.id}/decision`, { token: used.token, body: { decision: 'accept' } });
  assert.equal(acc.status, 409, JSON.stringify(acc.body));
  assert.equal(acc.body.error.details.code, 'intro_used');
  const fresh = await signup(['athlete']);
  const req2 = ok(await api('POST', '/coach-requests', { token: fresh.token, body: { sport: 'football', title: 'Need a coach', delivery: 'in_person', budget_max_cents: 70000 } }), 201);
  const ans2 = ok(await api('POST', `/coach-requests/${req2.id}/respond`, { token: coach.token, body: { rate_card_id: intro.id, starts_at: dayAt(15) } }), 201);
  ok(await api('POST', `/coach-responses/${ans2.id}/decision`, { token: fresh.token, body: { decision: 'accept' } }));
});

test('migration kept history: rows are flagged, never deleted', async () => {
  const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='coach_hires' AND column_name IN ('athlete_id','intro_scope','intro_counted')")).rows;
  assert.equal(cols.length, 3);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM coach_hires WHERE athlete_id IS NULL')).rows[0].n, 0);
});
