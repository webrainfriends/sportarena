import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Online payment is "enabled" (no provider is called: invoices are settled through the venue team's mark_invoice_paid)
Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { processBallots, rankEntries } = await import('../src/booking/ballots.js');
const { expireUnpaidHolds } = await import('../src/booking/holds.js');
const { fromLocal, addDays } = await import('../src/booking/time.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `bl_${n}_${roles[0]}`, display_name: `Bidder ${n}`, email: `bl${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const today = new Date().toISOString().slice(0, 10);
const at = (d, h) => fromLocal(addDays(today, d), h * 60, 'UTC').toISOString();
const inbox = async (u) => must(await api('GET', '/notifications', { token: u.token })).items;
const entryRow = async (id) => (await pool.query('SELECT * FROM venue_ballot_entries WHERE id=$1', [id])).rows[0];
const slotRow = async (id) => (await pool.query('SELECT * FROM venue_ballot_slots WHERE id=$1', [id])).rows[0];

async function venue(mgr, extra = {}) {
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: `Ballot Arena ${Math.random().toString(36).slice(2, 6)}`, timezone: 'UTC', ...extra } }), 201);
  must(await api('POST', `/venues/${v.id}/hours`, { token: mgr.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '06:00', closes: '22:00' })) } }));
  const court = must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', capacity: 1, hourly_rate_cents: 50000 } }), 201);
  return { v, court };
}
const makeBallot = async (mgr, v, court, { slots = [[3, 18, 19]], ...body } = {}) => must(await api('POST', `/venues/${v.id}/ballots`, { token: mgr.token, body: {
  title: 'Peak evenings', closes_at: new Date(Date.now() + 3_600_000).toISOString(), slots: slots.map(([d, h1, h2]) => ({ resource_id: court.id, starts_at: at(d, h1), ends_at: at(d, h2) })), ...body } }), 201);
const openIt = async (mgr, b) => must(await api('POST', `/ballots/${b.id}/open`, { token: mgr.token }));
const bid = (u, slot, bid_cents, extra = {}) => api('POST', `/ballot-slots/${slot.id}/entries`, { token: u.token, body: { bid_cents, ...extra } });
const book = (u, court, d, h1, h2) => api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: court.id, starts_at: at(d, h1), ends_at: at(d, h2) }] } });
const paid = async (mgr, reservationId) => {
  const inv = (await pool.query("SELECT id FROM invoices WHERE reservation_id=$1 AND kind='invoice' AND status='open'", [reservationId])).rows[0];
  must(await api('POST', `/invoices/${inv.id}/paid`, { token: mgr.token, body: { method: 'upi' } }));
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('ranking is reproducible from the stored seed, highest bid first, ties by seeded shuffle', () => {
  const entries = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, bid_cents: i < 2 ? 900 : 500 }));
  const one = rankEntries(entries, 'highest_bid', 'seed-1').map((e) => e.id);
  assert.deepEqual(rankEntries(entries, 'highest_bid', 'seed-1').map((e) => e.id), one);
  assert.deepEqual(new Set(one.slice(0, 2)), new Set(['a', 'b']));
  assert.deepEqual(new Set(one.slice(2)), new Set(['c', 'd']));
  const lottery = rankEntries(entries, 'random_draw', 'seed-1').map((e) => e.id);
  assert.deepEqual(rankEntries(entries, 'random_draw', 'seed-1').map((e) => e.id), lottery);
});

test('auto ballot: bids are sealed, the held slot is not bookable, the winner pays to confirm, losers are told', async () => {
  const mgr = await signup(['venue_manager']);
  const [a, b, c, stranger] = [await signup(), await signup(), await signup(), await signup()];
  const { v, court } = await venue(mgr, { payment_mode: 'online_required' });
  const ballot = await makeBallot(mgr, v, court);
  const slot = ballot.slots[0];
  assert.equal(slot.floor_cents, 50000, 'floor defaults to the venue rate');
  assert.equal(ballot.status, 'draft');
  assert.equal((await bid(a, slot, 60000)).status, 404, 'a draft takes no bids');
  assert.equal((await api('GET', `/ballots/${ballot.id}`, { token: a.token })).status, 404, 'drafts are private');
  assert.equal((await api('POST', `/ballots/${ballot.id}/open`, { token: stranger.token })).status, 404, 'outsiders learn nothing');
  await openIt(mgr, ballot);

  // while bidding is open the slot is held for the ballot: nobody can book it directly
  assert.equal((await book(stranger, court, 3, 18, 19)).status, 409);
  assert.equal((await bid(a, slot, 40000)).status, 400, 'below the floor');
  const ea = must(await bid(a, slot, 60000, { idempotency_key: 'key-aaaaaaaa' }), 201);
  assert.equal(must(await bid(a, slot, 60000, { idempotency_key: 'key-aaaaaaaa' }), 201).replayed, true);
  assert.equal((await bid(a, slot, 70000)).status, 409, 'one entry per person: change the bid instead');
  const eb = must(await bid(b, slot, 80000), 201);
  must(await bid(c, slot, 55000), 201);
  must(await api('PATCH', `/ballot-entries/${ea.id}`, { token: a.token, body: { bid_cents: 65000 } }));

  // sealed: an entrant sees their own bid only; the venue team sees all
  const mine = must(await api('GET', `/ballots/${ballot.id}`, { token: b.token }));
  assert.equal(mine.entries, undefined);
  assert.deepEqual(mine.my_entries.map((e) => e.bid_cents), [80000]);
  assert.equal(mine.slots[0].entries, 3);
  const team = must(await api('GET', `/ballots/${ballot.id}`, { token: mgr.token }));
  assert.deepEqual(team.entries.map((e) => e.bid_cents).sort(), [55000, 65000, 80000]);

  const drawn = must(await api('POST', `/ballots/${ballot.id}/draw`, { token: mgr.token }));
  assert.equal(drawn.offered, 1);
  assert.equal((await api('POST', `/ballots/${ballot.id}/draw`, { token: mgr.token })).status, 409, 'only once');
  assert.equal((await entryRow(eb.id)).status, 'offered', 'the highest bid wins');
  assert.equal((await entryRow(ea.id)).rank, 2);
  assert.equal((await inbox(b)).some((x) => x.kind === 'ballot_offer'), true);
  assert.equal((await book(stranger, court, 3, 18, 19)).status, 409, 'still held for the winner');
  assert.equal((await api('POST', `/ballot-entries/${ea.id}/accept`, { token: a.token })).status, 409, 'not your offer yet');

  // the winner accepts: a real reservation at their bid, unpaid, so the slot is not allocated yet
  const acc = must(await api('POST', `/ballot-entries/${eb.id}/accept`, { token: b.token }), 201);
  assert.equal(acc.status, 'awaiting_payment');
  assert.equal(acc.reservation.bookings[0].base_cents, 80000);
  assert.equal(acc.reservation.awaiting_payment, true);
  assert.equal((await slotRow(slot.id)).status, 'awaiting_payment');
  assert.equal((await book(stranger, court, 3, 18, 19)).status, 409, 'the unpaid booking holds the slot');
  await paid(mgr, acc.reservation.id);
  assert.equal((await entryRow(eb.id)).status, 'confirmed');
  assert.equal((await slotRow(slot.id)).status, 'confirmed');
  assert.equal((await entryRow(ea.id)).status, 'lost');
  assert.equal((await inbox(a)).some((x) => x.kind === 'ballot_lost'), true);
  assert.equal((await inbox(b)).some((x) => x.kind === 'ballot_confirmed'), true);
  assert.equal((await pool.query('SELECT status FROM venue_ballots WHERE id=$1', [ballot.id])).rows[0].status, 'settled');
  const log = (await pool.query('SELECT action FROM venue_ballot_log WHERE ballot_id=$1 ORDER BY id', [ballot.id])).rows.map((r) => r.action);
  assert.deepEqual(log, ['created', 'opened', 'offered', 'drawn', 'accepted', 'confirmed', 'settled'].filter((x) => log.includes(x)));
  assert.ok(log.includes('drawn') && log.includes('confirmed'));
});

test('an unpaid or unclaimed offer passes to the next ranked entrant; with nobody left the slot is bookable again', async () => {
  const mgr = await signup(['venue_manager']);
  const [a, b, c] = [await signup(), await signup(), await signup()];
  const { v, court } = await venue(mgr, { payment_mode: 'online_required' });
  const ballot = await makeBallot(mgr, v, court);
  const slot = ballot.slots[0];
  await openIt(mgr, ballot);
  const ea = must(await bid(a, slot, 90000), 201), eb = must(await bid(b, slot, 80000), 201), ec = must(await bid(c, slot, 70000), 201);
  must(await api('POST', `/ballots/${ballot.id}/draw`, { token: mgr.token }));
  assert.equal((await entryRow(ea.id)).status, 'offered');

  // a doesn't respond in time: expired, offered to b
  await pool.query("UPDATE venue_ballot_entries SET hold_expires_at = now() - interval '1 minute' WHERE id=$1", [ea.id]);
  assert.equal((await processBallots()).expired, 1);
  assert.equal((await entryRow(ea.id)).status, 'expired');
  assert.equal((await entryRow(eb.id)).status, 'offered');
  assert.equal((await inbox(a)).some((x) => x.kind === 'ballot_expired'), true);

  // b accepts but never pays: the venue's hold sweep cancels the unpaid booking, the ballot passes the slot on to c
  const acc = must(await api('POST', `/ballot-entries/${eb.id}/accept`, { token: b.token }), 201);
  await pool.query("UPDATE reservations SET payment_deadline = now() - interval '1 minute' WHERE id=$1", [acc.reservation.id]);
  await expireUnpaidHolds();
  assert.equal((await processBallots()).expired, 1);
  assert.equal((await entryRow(eb.id)).status, 'expired');
  assert.equal((await entryRow(ec.id)).status, 'offered');

  // c withdraws: nobody is left, the slot is released as unfilled and is bookable again
  must(await api('DELETE', `/ballot-entries/${ec.id}`, { token: c.token }));
  assert.equal((await slotRow(slot.id)).status, 'unfilled');
  must(await book(a, court, 3, 18, 19), 201);
  assert.equal((await pool.query('SELECT status FROM venue_ballots WHERE id=$1', [ballot.id])).rows[0].status, 'settled');
});

test('manual ballot: the venue blocks a slot for a chosen entrant, who is confirmed on payment; random draw bids pay the floor', async () => {
  const mgr = await signup(['venue_manager']);
  const [a, b] = [await signup(), await signup()];
  const { v, court } = await venue(mgr); // pay-at-venue: confirmed as soon as the winner accepts
  const ballot = await makeBallot(mgr, v, court, { mode: 'manual', method: 'random_draw' });
  const slot = ballot.slots[0];
  await openIt(mgr, ballot);
  const ea = must(await bid(a, slot, 99999999), 201);
  assert.equal(ea.bid_cents, 50000, 'a lottery ignores the bid: everyone pays the floor');
  const eb = must(await bid(b, slot, 1), 201);
  assert.equal((await api('PATCH', `/ballot-entries/${eb.id}`, { token: b.token, body: { bid_cents: 60000 } })).status, 409);

  assert.equal((await api('POST', `/ballot-slots/${slot.id}/allocate`, { token: mgr.token, body: { entry_id: eb.id } })).status, 409, 'close the ballot first');
  must(await api('POST', `/ballots/${ballot.id}/close`, { token: mgr.token }));
  assert.equal((await bid(await signup(), slot, 50000)).status, 404, 'closed: no more bids');
  const ran = must(await api('POST', `/ballots/${ballot.id}/draw`, { token: mgr.token }));
  assert.equal(ran.offered, 0, 'manual ballots are only ranked');
  assert.equal((await entryRow(ea.id)).status, 'ranked');
  assert.equal((await api('POST', `/ballot-slots/${slot.id}/allocate`, { token: (await signup()).token, body: { entry_id: eb.id } })).status, 404);

  must(await api('POST', `/ballot-slots/${slot.id}/allocate`, { token: mgr.token, body: { entry_id: ea.id } }));
  must(await api('POST', `/ballot-slots/${slot.id}/allocate`, { token: mgr.token, body: { entry_id: eb.id, reason: 'regular booker' } })); // re-allocate an unpaid hold
  assert.equal((await entryRow(ea.id)).status, 'ranked');
  assert.equal((await entryRow(eb.id)).status, 'offered');
  const acc = must(await api('POST', `/ballot-entries/${eb.id}/accept`, { token: b.token }), 201);
  assert.equal(acc.status, 'confirmed', 'pay-at-venue: nothing to wait for');
  assert.equal((await slotRow(slot.id)).status, 'confirmed');
  assert.equal((await entryRow(ea.id)).status, 'lost');
  const audit = (await pool.query("SELECT action FROM audit_log WHERE action IN ('allocate_ballot_slot','run_ballot_draw','open_venue_ballot') AND actor_id=$1", [mgr.id])).rows;
  assert.ok(audit.length >= 4);
});

test('the sweep closes a ballot at its deadline and draws auto ballots; release and cancel free the slots', async () => {
  const mgr = await signup(['venue_manager']);
  const [a, b] = [await signup(), await signup()];
  const { v, court } = await venue(mgr, { payment_mode: 'online_required' });
  const ballot = await makeBallot(mgr, v, court, { slots: [[3, 18, 19], [3, 19, 20]] });
  await openIt(mgr, ballot);
  const [s1, s2] = ballot.slots;
  const e1 = must(await bid(a, s1, 70000), 201);
  must(await bid(b, s1, 60000), 201);
  assert.equal((await api('POST', `/ballots/${ballot.id}/open`, { token: mgr.token })).status, 409);
  await pool.query("UPDATE venue_ballots SET closes_at = now() - interval '1 minute' WHERE id=$1", [ballot.id]);
  const swept = await processBallots();
  assert.equal(swept.closed, 1);
  assert.equal(swept.drawn, 1);
  assert.equal((await entryRow(e1.id)).status, 'offered');
  assert.equal((await slotRow(s2.id)).status, 'unfilled', 'no entries: released');
  must(await book(a, court, 3, 19, 20), 201); // the unfilled slot is bookable again

  must(await api('POST', `/ballot-slots/${s1.id}/release`, { token: mgr.token, body: { reason: 'Court flooded' } }));
  assert.equal((await entryRow(e1.id)).status, 'lost');
  assert.equal((await slotRow(s1.id)).status, 'offered', 'passed on to the next ranked entrant');
  const cancelled = must(await api('POST', `/ballots/${ballot.id}/cancel`, { token: mgr.token, body: { reason: 'Season ended' } }));
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await slotRow(s1.id)).status, 'cancelled');
  must(await book(b, court, 3, 18, 19), 201);
  assert.equal((await inbox(b)).some((x) => x.kind === 'ballot_cancelled'), true);
});

test('young people cannot bid; a ballot cannot be opened over a taken slot or overlap another', async () => {
  const mgr = await signup(['venue_manager']);
  const a = await signup();
  const { v, court } = await venue(mgr);
  must(await book(a, court, 3, 18, 19), 201);
  const taken = await makeBallot(mgr, v, court);
  assert.equal((await api('POST', `/ballots/${taken.id}/open`, { token: mgr.token })).status, 409, 'already booked');
  const free = await makeBallot(mgr, v, court, { slots: [[4, 18, 19]] });
  await openIt(mgr, free);
  const overlap = await makeBallot(mgr, v, court, { slots: [[4, 18, 19]] });
  assert.equal((await api('POST', `/ballots/${overlap.id}/open`, { token: mgr.token })).status, 409, 'held by another ballot');
  await pool.query("UPDATE users SET youth_until = current_date + 365 WHERE id=$1", [a.id]);
  assert.equal((await bid(a, free.slots[0], 60000)).status, 403);
  assert.equal((await api('POST', `/venues/${v.id}/ballots`, { token: mgr.token, body: { title: 'x', closes_at: at(5, 9), slots: [{ resource_id: court.id, starts_at: at(4, 18), ends_at: at(4, 19) }] } })).status, 400, 'must close before the slot starts');
  const open = must(await api('GET', `/venues/${v.id}/ballots/open`));
  assert.equal(open.length, 1);
  assert.equal(open[0].entries, undefined);
});

test('exposed through REST, OpenAPI and MCP from one definition; accepting is a payment-scoped action', async () => {
  const { capabilities } = await import('../src/capabilities/index.js');
  const names = capabilities.map((c) => c.name);
  for (const nme of ['create_venue_ballot', 'open_venue_ballot', 'run_ballot_draw', 'allocate_ballot_slot', 'enter_ballot', 'accept_ballot_offer', 'list_my_ballot_entries']) assert.ok(names.includes(nme), nme);
  assert.equal(capabilities.find((c) => c.name === 'accept_ballot_offer').scope, 'payment');
  const openapi = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  assert.ok(Object.keys(openapi.paths).some((p) => p.includes('/ballots')));
  assert.equal((await api('POST', '/ballot-slots/00000000-0000-4000-8000-000000000000/entries', { body: {} })).status, 401);
});
