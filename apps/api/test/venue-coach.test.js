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
  const r = await api('POST', '/auth/register', { body: { handle: `vc_${n}_${roles[0]}`, display_name: `Vc ${n}`, email: `vc${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const post = (u, p, body) => api('POST', p, { token: u.token, body });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function setup() {
  const mgr = await signup(['venue_manager']), coach = await signup(['coach']), other = await signup(['coach']), stranger = await signup(['athlete']);
  const v = ok(await post(mgr, '/venues', { name: `Arena ${n}`, city: 'Pune', timezone: 'UTC', currency: 'INR' }), 201);
  const court = ok(await post(mgr, `/venues/${v.id}/resources`, { kind: 'court', name: 'Court A', sport: 'football', hourly_rate_cents: 50000, max_players: 10 }), 201);
  for (const u of [coach, other]) ok(await post(u, '/me/sport-profiles', { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 60000 }), 201);
  return { mgr, coach, other, stranger, v, court };
}
const slotBody = (s, extra = {}) => ({ venue_id: s.v.id, sport: 'football', start: '10:00', duration_min: 60, starts_on: day(5), extra_dates: [day(5)], ...extra });

test('tie-up: venue proposes, coach amends, venue agrees; turn order and visibility are enforced', async () => {
  const s = await setup();
  assert.equal((await post(s.stranger, '/venue-coach-ties', { venue_id: s.v.id, kind: 'independent', share_bp: 7000 })).status, 400, 'a non-coach cannot propose');
  const t = ok(await post(s.mgr, '/venue-coach-ties', { venue_id: s.v.id, coach_id: s.coach.id, kind: 'independent', share_bp: 6000, sports: ['football'], note: 'Evenings' }), 201);
  assert.equal(t.status, 'proposed'); assert.equal(t.note, 'Evenings');
  assert.equal((await post(s.mgr, '/venue-coach-ties', { venue_id: s.v.id, coach_id: s.coach.id, kind: 'staff', pay_model: 'staff' })).status, 409, 'one live tie per pair');
  assert.equal((await post(s.mgr, `/venue-coach-ties/${t.id}/respond`, { decision: 'agree' })).status, 403, 'cannot answer your own proposal');
  assert.equal((await post(s.stranger, `/venue-coach-ties/${t.id}/respond`, { decision: 'agree' })).status, 404, 'outsiders do not see it');
  assert.equal((await post(s.coach, `/venue-coach-ties/${t.id}/respond`, { decision: 'amend' })).status, 400, 'amend needs a change');
  const am = ok(await post(s.coach, `/venue-coach-ties/${t.id}/respond`, { decision: 'amend', share_bp: 7500 }));
  assert.equal(am.share_bp, 7500); assert.equal(am.proposed_by, 'coach'); assert.equal(am.row_version, 2);
  assert.equal((await post(s.coach, `/venue-coach-ties/${t.id}/respond`, { decision: 'agree' })).status, 403, 'the turn went back to the venue');
  const mine = ok(await api('GET', '/venue-coach-ties', { token: s.mgr.token }));
  assert.deepEqual(mine, [], 'venue_id is required for the venue view; without it you see only your own coach ties');
  const list = ok(await api('GET', `/venue-coach-ties?venue_id=${s.v.id}`, { token: s.mgr.token }));
  assert.equal(list[0].waiting_on, 'venue');
  assert.equal(ok(await post(s.mgr, `/venue-coach-ties/${t.id}/respond`, { decision: 'agree' })).status, 'agreed');
  const hist = ok(await api('GET', `/venue-coach-history/tie/${t.id}`, { token: s.coach.token }));
  assert.deepEqual(hist.map((h) => h.action), ['propose', 'amend', 'agree']);
  assert.equal((await api('GET', `/venue-coach-history/tie/${t.id}`, { token: s.stranger.token })).status, 404);
});

test('a coach can propose to a venue, and a rejected tie can be proposed again', async () => {
  const s = await setup();
  const t = ok(await post(s.coach, '/venue-coach-ties', { venue_id: s.v.id, kind: 'independent', pay_model: 'flat_fee', flat_fee_cents: 20000 }), 201);
  assert.equal(t.coach_id, s.coach.id); assert.equal(t.proposed_by, 'coach');
  ok(await post(s.mgr, `/venue-coach-ties/${t.id}/respond`, { decision: 'reject', reason: 'No room' }));
  const again = ok(await post(s.coach, '/venue-coach-ties', { venue_id: s.v.id, kind: 'independent', pay_model: 'flat_fee', flat_fee_cents: 15000 }), 201);
  assert.notEqual(again.id, t.id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM venue_coach_ties WHERE venue_id=$1', [s.v.id])).rows[0].n, 2, 'the rejected tie is kept');
});

test('roster: propose -> amend -> agree holds the court and the coach; cancel frees both', async () => {
  const s = await setup();
  const made = ok(await post(s.mgr, '/venue-coach-slots', slotBody(s, { coach_id: s.coach.id, resource_id: s.court.id, price_cents: 40000 })), 201);
  const slot = made.slots[0];
  assert.equal(slot.status, 'proposed'); assert.equal(made.tie_id, null, 'ad-hoc: no standing tie');
  assert.equal((await post(s.mgr, `/venue-coach-slots/${slot.id}/respond`, { decision: 'agree' })).status, 403);
  const am = ok(await post(s.coach, `/venue-coach-slots/${slot.id}/respond`, { decision: 'amend', duration_min: 90 }));
  assert.equal(am.proposed_by, 'coach');
  const agreed = ok(await post(s.mgr, `/venue-coach-slots/${slot.id}/respond`, { decision: 'agree' }));
  assert.equal(agreed.status, 'agreed');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM venue_blocks WHERE batch_id=$1 AND released_at IS NULL', [agreed.block_id])).rows[0].n, 1, 'the court is held');
  // another slot for the same coach at the same time cannot be agreed, whichever side proposed it
  const dup = ok(await post(s.mgr, '/venue-coach-slots', slotBody(s, { coach_id: s.coach.id })), 201).slots[0];
  assert.equal((await post(s.coach, `/venue-coach-slots/${dup.id}/respond`, { decision: 'agree' })).status, 409, 'the coach is already agreed into that time');
  const dup2 = ok(await post(s.coach, '/venue-coach-slots', slotBody(s)), 201).slots[0];
  assert.equal((await post(s.mgr, `/venue-coach-slots/${dup2.id}/respond`, { decision: 'agree' })).status, 409);
  const roster = ok(await api('GET', `/venue-coach-roster?venue_id=${s.v.id}`, { token: s.mgr.token }));
  assert.equal(roster.find((r) => r.id === slot.id).court_name, 'Court A');
  const mineAsCoach = ok(await api('GET', '/venue-coach-roster', { token: s.coach.token }));
  assert.equal(mineAsCoach.some((r) => r.id === slot.id), true);
  assert.equal((await api('GET', `/venue-coach-roster?venue_id=${s.v.id}`, { token: s.stranger.token })).status, 403);
  ok(await post(s.coach, `/venue-coach-slots/${slot.id}/cancel`, { reason: 'Injury' }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM venue_blocks WHERE batch_id=$1 AND released_at IS NULL', [agreed.block_id])).rows[0].n, 0, 'the court is freed');
  const hist = ok(await api('GET', `/venue-coach-history/slot/${slot.id}`, { token: s.mgr.token }));
  assert.deepEqual(hist.map((h) => h.action), ['propose', 'amend', 'agree', 'cancel']);
  assert.equal(hist[3].reason, 'Injury');
});

test('concurrent agreement of two overlapping slots for one coach: exactly one wins', async () => {
  const s = await setup();
  const a = ok(await post(s.coach, '/venue-coach-slots', slotBody(s, { resource_id: s.court.id })), 201).slots[0];
  const b = ok(await post(s.coach, '/venue-coach-slots', slotBody(s)), 201).slots[0];
  const rs = await Promise.all([post(s.mgr, `/venue-coach-slots/${a.id}/respond`, { decision: 'agree' }), post(s.mgr, `/venue-coach-slots/${b.id}/respond`, { decision: 'agree' })]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs.map((r) => r.body)));
});

test('ending a tie-up cancels its upcoming slots; sports outside the tie are refused', async () => {
  const s = await setup();
  const t = ok(await post(s.mgr, '/venue-coach-ties', { venue_id: s.v.id, coach_id: s.coach.id, kind: 'staff', pay_model: 'staff', sports: ['football'] }), 201);
  ok(await post(s.coach, `/venue-coach-ties/${t.id}/respond`, { decision: 'agree' }));
  assert.equal((await post(s.mgr, '/venue-coach-slots', slotBody(s, { coach_id: s.coach.id, sport: 'tennis' }))).status, 400);
  const slot = ok(await post(s.mgr, '/venue-coach-slots', slotBody(s, { coach_id: s.coach.id, resource_id: s.court.id })), 201);
  assert.equal(slot.tie_id, t.id);
  ok(await post(s.coach, `/venue-coach-slots/${slot.slots[0].id}/respond`, { decision: 'agree' }));
  const end = ok(await post(s.mgr, `/venue-coach-ties/${t.id}/cancel`, { reason: 'Season over' }));
  assert.equal(end.cancelled_slots, 1);
  assert.equal((await pool.query("SELECT status FROM venue_coach_slots WHERE id=$1", [slot.slots[0].id])).rows[0].status, 'cancelled');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM venue_blocks WHERE released_at IS NULL AND batch_id=$1', [slot.slots[0].id])).rows[0].n, 0);
});

test('an agreed roster slot takes the coach off the open slots and blocks a direct hire', async () => {
  const s = await setup();
  const slot = ok(await post(s.mgr, '/venue-coach-slots', slotBody(s, { coach_id: s.coach.id })), 201).slots[0];
  ok(await post(s.coach, `/venue-coach-slots/${slot.id}/respond`, { decision: 'agree' }));
  const hire = await post(s.stranger, '/hires', { coach_id: s.coach.id, sport: 'football', starts_at: slot.starts_at, duration_min: 60 });
  assert.equal(hire.status, 409, JSON.stringify(hire.body));
  assert.match(hire.body.error.message, /not free/);
});
