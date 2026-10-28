// Loyalty & referral engine (#509): versioned rules, append-only ledger, idempotency and concurrency, referral abuse, organisation separation,
// sponsor funding, youth, and the venue / academy / coach / event journeys. Every test creates its own people and programmes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { pool, start, stop, call, ok, signup, dateOf } from './tender-helpers.js';
import { signToken } from '../src/auth.js';
import { fromLocal, addDays } from '../src/booking/time.js';

const { tx } = await import('../src/db.js');
const { venueInvoicePaid, academyChargePaid, eventParticipationSweep, membershipTenureSweep } = await import('../src/rewards/activity.js');
const { releaseDueReferrals } = await import('../src/rewards/referrals.js');
const { fulfilChargePaid, cancelUnpaidCharges } = await import('../src/academy-invoices.js');

let admin;
before(async () => {
  await start();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('le_root','Root','{admin}','x','x','le_adminidx') RETURNING id")).rows[0];
  admin = { id: row.id, roles: ['admin'], token: await signToken({ id: row.id, roles: ['admin'] }) };
});
after(stop);

const today = new Date().toISOString().slice(0, 10);
const at = (d, h) => fromLocal(addDays(today, d), h * 60, 'UTC').toISOString();
let seq = 0;
async function venue(mgr, over = {}) {
  const v = ok(await call('POST', '/venues', { token: mgr.token, body: { name: `Engine Arena ${++seq}`, timezone: 'UTC', currency: 'INR', payment_mode: 'online_optional', ...over } }), 201);
  const court = ok(await call('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', hourly_rate_cents: 100000 } }), 201);
  return { v, court };
}
const book = async (u, court, d, h) => ok(await call('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: court.id, starts_at: at(d, h), ends_at: at(d, h + 1) }] } }), 201);
const payAtVenue = (mgr, invoiceId) => ok(call('POST', `/invoices/${invoiceId}/paid`, { token: mgr.token, body: { method: 'cash' } }));
const paid = async (mgr, u, court, d, h) => { const b = await book(u, court, d, h); ok(await call('POST', `/invoices/${b.invoices[0].id}/paid`, { token: mgr.token, body: { method: 'cash' } })); return b; };
const earnRule = (over = {}) => ({ key: 'booking', event: 'venue_booking_paid', mode: 'percent', percent_bp: 1000, ...over });
const rules = (over = {}) => ({ earn: [earnRule()], redeem: { max_redeem_bp: 5000, min_points: 1, purposes: ['venue_invoice'] }, expiry_months: 12, ...over });
async function programme(user, owner, name, r, extra = {}) {
  const p = ok(await call('POST', '/loyalty/programmes', { token: user.token, body: { name, ...owner, ...extra } }), 201);
  if (r) ok(await call('POST', `/loyalty/programmes/${p.id}/publish`, { token: user.token, body: { rules: r } }));
  return p;
}
const venueProg = (mgr, v, r = rules(), name = 'Rewards') => programme(mgr, { owner_kind: 'venue', owner_id: v.id }, name, r);
const balance = async (u, programmeId) => Number((await call('GET', '/me/loyalty', { token: u.token })).body.find((p) => p.id === programmeId)?.points ?? 0);
const adjust = (mgr, p, u, points, reason = 'goodwill gift') => call('POST', `/loyalty/programmes/${p.id}/adjust`, { token: mgr.token, body: { user_handle: u.handle, points, reason } });
const ledger = (programmeId, userId) => pool.query('SELECT * FROM loyalty_ledger WHERE programme_id=$1 AND user_id=$2 ORDER BY seq', [programmeId, userId]).then((r) => r.rows);

// ------------------------------------------------------------------------------------------------------------------------------ rules, versions, ledger
test('versioned rules: a new version changes future earning only; the ledger and published versions are append-only', async () => {
  const mgr = await signup('mgr', ['venue_manager']);
  const { v, court } = await venue(mgr);
  const draft = await programme(mgr, { owner_kind: 'venue', owner_id: v.id }, 'Rewards', null);
  const u = await signup('u');
  const b0 = await book(u, court, 2, 9);
  ok(await call('POST', `/invoices/${b0.invoices[0].id}/paid`, { token: mgr.token, body: { method: 'cash' } }));
  assert.equal(await balance(u, draft.id), 0, 'a draft programme earns nothing');

  ok(await call('POST', `/loyalty/programmes/${draft.id}/publish`, { token: mgr.token, body: { rules: rules() } }));
  const b1 = await book(u, court, 3, 9);
  ok(await call('POST', `/invoices/${b1.invoices[0].id}/paid`, { token: mgr.token, body: { method: 'cash' } }));
  assert.equal(await balance(u, draft.id), 10000);

  const v2 = ok(await call('POST', `/loyalty/programmes/${draft.id}/publish`, { token: mgr.token, body: { rules: rules({ earn: [earnRule({ percent_bp: 2000 })] }), note: 'double points' } }));
  assert.equal(v2.version, 2);
  const b2 = await book(u, court, 4, 9);
  ok(await call('POST', `/invoices/${b2.invoices[0].id}/paid`, { token: mgr.token, body: { method: 'cash' } }));
  const rows = await ledger(draft.id, u.id);
  assert.deepEqual(rows.map((r) => [r.version, r.delta]), [[1, 10000], [2, 20000]], 'each row keeps the version it was earned under');
  assert.equal(await balance(u, draft.id), 30000);

  // append-only, enforced by the database
  await assert.rejects(pool.query('UPDATE loyalty_ledger SET delta = 99 WHERE id=$1', [rows[0].id]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM loyalty_ledger WHERE id=$1', [rows[0].id]), /append-only/);
  await assert.rejects(pool.query('TRUNCATE loyalty_ledger'), /append-only/);
  await assert.rejects(pool.query("UPDATE loyalty_programme_versions SET rules='{}' WHERE programme_id=$1", [draft.id]), /append-only/);
  // a lot can never be drawn below zero, even by a direct write
  await assert.rejects(pool.query("INSERT INTO loyalty_ledger(programme_id, user_id, kind, delta, lot_id, idempotency_key) VALUES ($1,$2,'redeem',-10001,$3,'test:over')", [draft.id, u.id, rows[0].id]), /not enough points/);
  // an admin adjustment needs a reason and an actor
  await assert.rejects(pool.query("INSERT INTO loyalty_ledger(programme_id, user_id, kind, delta, expires_at, idempotency_key) VALUES ($1,$2,'adjust',5,now() + interval '1 day','test:noreason')", [draft.id, u.id]));

  // only the team may publish; rules must make sense for the owner
  const rando = await signup('rando', ['venue_manager']);
  assert.equal((await call('POST', `/loyalty/programmes/${draft.id}/publish`, { token: rando.token, body: { rules: rules() } })).status, 404);
  assert.equal((await call('POST', `/loyalty/programmes/${draft.id}/publish`, { token: mgr.token, body: { rules: rules({ earn: [earnRule({ event: 'academy_payment_paid' })] }) } })).status, 400, 'an academy event cannot earn at a venue');
  assert.equal((await call('POST', `/loyalty/programmes/${draft.id}/publish`, { token: mgr.token, body: { rules: rules({ redeem: { purposes: ['coach_hire'] } }) } })).status, 400);
  assert.equal((await call('POST', `/loyalty/programmes/${draft.id}/publish`, { token: mgr.token, body: { rules: { earn: [{ key: 'x', event: 'venue_booking_paid', mode: 'percent' }] } } })).status, 400, 'a percent rule needs its rate');
  assert.equal((await call('POST', '/loyalty/programmes', { token: rando.token, body: { owner_kind: 'venue', owner_id: v.id, name: 'Mine now' } })).status, 404, 'cannot start a programme on someone else\'s venue');
  assert.equal((await call('POST', '/loyalty/programmes', { token: mgr.token, body: { owner_kind: 'platform', name: 'Network', currency: 'INR' } })).status, 403);

  // pausing stops earning but not spending; ending is final
  ok(await call('POST', `/loyalty/programmes/${draft.id}/status`, { token: mgr.token, body: { action: 'pause' } }));
  const b3 = await book(u, court, 5, 9);
  ok(await call('POST', `/invoices/${b3.invoices[0].id}/paid`, { token: mgr.token, body: { method: 'cash' } }));
  assert.equal(await balance(u, draft.id), 30000, 'paused: no new points');
  const b4 = await book(u, court, 6, 9);
  const used = ok(await call('POST', '/loyalty/redeem', { token: u.token, body: { programme_id: draft.id, purpose_type: 'venue_invoice', purpose_id: b4.invoices[0].id, points: 1000 } }));
  assert.equal(used.points_used, 1000, 'paused: members can still spend');
  ok(await call('POST', `/loyalty/programmes/${draft.id}/status`, { token: mgr.token, body: { action: 'end' } }));
  assert.equal((await call('POST', `/loyalty/programmes/${draft.id}/status`, { token: mgr.token, body: { action: 'resume' } })).status, 409);
});

test('idempotency and concurrency: the same event never pays twice; parallel spending can never overdraw', async () => {
  const mgr = await signup('mgr', ['venue_manager']);
  const { v, court } = await venue(mgr);
  const prog = await venueProg(mgr, v);
  const u = await signup('u');
  const b = await paid(mgr, u, court, 3, 9);
  const inv = (await pool.query('SELECT * FROM invoices WHERE id=$1', [b.invoices[0].id])).rows[0];
  await Promise.all(Array.from({ length: 6 }, () => tx((c) => venueInvoicePaid(c, inv))));
  assert.equal((await ledger(prog.id, u.id)).filter((r) => r.kind === 'earn').length, 1, 'six concurrent replays of the same paid invoice earn once');
  assert.equal(await balance(u, prog.id), 10000);

  // parallel redemptions on one bill: together they respect the 50% cap and the balance
  await adjust(mgr, prog, u, 90000);
  const b2 = await book(u, court, 4, 9);
  const results = await Promise.all(Array.from({ length: 6 }, (_, k) => call('POST', '/loyalty/redeem', { token: u.token, body: { programme_id: prog.id, purpose_type: 'venue_invoice', purpose_id: b2.invoices[0].id, points: 20000, request_key: `req-parallel-${k}` } })));
  const total = results.filter((r) => r.status === 200).reduce((s, r) => s + r.body.points_used, 0);
  assert.equal(total, 50000, 'parallel spends add up to the cap and no more');
  assert.equal((await pool.query('SELECT credits_cents FROM invoices WHERE id=$1', [b2.invoices[0].id])).rows[0].credits_cents, 50000);
  assert.equal(await balance(u, prog.id), 100000 - 50000);

  // a retried request returns the same redemption and takes nothing more
  const b3 = await book(u, court, 5, 9);
  const body = { programme_id: prog.id, purpose_type: 'venue_invoice', purpose_id: b3.invoices[0].id, points: 3000, request_key: 'retry-key-001' };
  const first = ok(await call('POST', '/loyalty/redeem', { token: u.token, body }));
  const again = ok(await call('POST', '/loyalty/redeem', { token: u.token, body }));
  assert.equal(again.redemption_id, first.redemption_id);
  assert.equal(again.replayed, true);
  assert.equal(await balance(u, prog.id), 50000 - 3000);

  // two bills racing for one small balance never take more than there is
  const small = await signup('small');
  await adjust(mgr, prog, small, 1000);
  const [x, y] = await Promise.all([book(small, court, 6, 9), book(small, court, 7, 9)]);
  const race = await Promise.all([x, y].map((bk) => call('POST', '/loyalty/redeem', { token: small.token, body: { programme_id: prog.id, purpose_type: 'venue_invoice', purpose_id: bk.invoices[0].id } })));
  assert.equal(race.filter((r) => r.status === 200).reduce((s, r) => s + r.body.points_used, 0), 1000);
  assert.equal(await balance(small, prog.id), 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM loyalty_lots_open WHERE remaining < 0').then((r) => r.rows[0].n)), 0);
});

test('redemption is atomic with payment and cancellation is deterministic under the programme policy', async () => {
  const mgr = await signup('mgr', ['venue_manager']);
  const { v, court } = await venue(mgr);
  const keep = await venueProg(mgr, v, rules({ redeem: { max_redeem_bp: 10000, min_points: 1, purposes: ['venue_invoice'], restore_on_cancel: 'none' } }), 'Final sale');
  const u = await signup('u');
  await adjust(mgr, keep, u, 100000);
  const b = await book(u, court, 3, 9);
  const full = ok(await call('POST', '/loyalty/redeem', { token: u.token, body: { programme_id: keep.id, purpose_type: 'venue_invoice', purpose_id: b.invoices[0].id } }));
  assert.equal(full.paid, true, 'points that cover the bill pay it in the same step');
  assert.equal((await pool.query('SELECT status, payment_method FROM invoices WHERE id=$1', [b.invoices[0].id])).rows[0].status, 'paid');
  assert.equal(await balance(u, keep.id), 0);
  assert.equal((await ledger(keep.id, u.id)).filter((r) => r.kind === 'earn').length, 0, 'a bill paid entirely with points earns nothing');
  // cancelling a bill paid with points under a "none" policy keeps them spent
  ok(await call('DELETE', `/bookings/${b.bookings[0].id}`, { token: u.token }));
  assert.equal(await balance(u, keep.id), 0, 'restore_on_cancel none: the points stay spent');

  const mgr2 = await signup('mgr2', ['venue_manager']);
  const w = await venue(mgr2);
  const give = await venueProg(mgr2, w.v, rules({ redeem: { max_redeem_bp: 10000, min_points: 1, purposes: ['venue_invoice'], restore_on_cancel: 'full', restore_expiry: 'original' } }), 'Friendly');
  await adjust(mgr2, give, u, 60000);
  const b2 = await book(u, w.court, 3, 9);
  ok(await call('POST', '/loyalty/redeem', { token: u.token, body: { programme_id: give.id, purpose_type: 'venue_invoice', purpose_id: b2.invoices[0].id, points: 60000 } }));
  assert.equal(await balance(u, give.id), 0);
  ok(await call('DELETE', `/bookings/${b2.bookings[0].id}`, { token: u.token }));
  assert.equal(await balance(u, give.id), 60000, 'a cancelled open bill gives every point back');
  const orig = await pool.query("SELECT l.expires_at AS old, r.expires_at AS back FROM loyalty_ledger l JOIN loyalty_ledger r ON r.kind='restore' AND r.programme_id=l.programme_id WHERE l.kind='adjust' AND l.programme_id=$1", [give.id]);
  assert.ok(Math.abs(new Date(orig.rows[0].old) - new Date(orig.rows[0].back)) < 1000, 'restore_expiry original keeps the lot\'s own expiry');
});

// ------------------------------------------------------------------------------------------------------------------------------ referrals
test('referrals: signup alone earns nothing; a qualifying payment plus holdback does; self, ring, repeat and duplicate-device abuse are stopped', async () => {
  const mgr = await signup('mgr', ['venue_manager']);
  const { v, court } = await venue(mgr);
  const plat = await programme(admin, { owner_kind: 'platform' }, 'Network rewards', {
    earn: [], redeem: { max_redeem_bp: 5000, purposes: ['venue_invoice'] }, expiry_months: 12,
    referral: { enabled: true, qualifying_event: 'venue_booking_paid', min_spend_minor: 50000, referrer_points: 20000, invitee_points: 10000, holdback_days: 7, daily_velocity_flag: 2 },
  }, { currency: 'INR' });
  const a = await signup('a'), b = await signup('b'), c = await signup('c'), d = await signup('d');
  const code = ok(await call('POST', `/loyalty/programmes/${plat.id}/referral-codes`, { token: a.token, body: { campaign: 'spring', source: 'whatsapp' } }), 201);
  assert.match(code.code, /^[A-Z2-9]{8}$/);

  // self-referral is refused; a stranger can claim; a second code in the same programme cannot be used
  assert.equal((await call('POST', '/referrals/claim', { token: a.token, body: { code: code.code } })).status, 409);
  const claim = ok(await call('POST', '/referrals/claim', { token: b.token, body: { code: code.code } }), 201);
  assert.equal(claim.status, 'registered');
  assert.equal((await call('POST', '/referrals/claim', { token: b.token, body: { code: code.code } })).status, 409, 'one referral per person per programme');
  assert.equal(await balance(a, plat.id) + await balance(b, plat.id), 0, 'signing up earns nothing');

  // a ring: b invites c, then a tries to enter c's code
  const bCode = ok(await call('POST', `/loyalty/programmes/${plat.id}/referral-codes`, { token: b.token, body: {} }), 201);
  ok(await call('POST', '/referrals/claim', { token: c.token, body: { code: bCode.code } }), 201);
  const cCode = ok(await call('POST', `/loyalty/programmes/${plat.id}/referral-codes`, { token: c.token, body: {} }), 201);
  assert.equal((await call('POST', '/referrals/claim', { token: a.token, body: { code: cCode.code } })).status, 409, 'a -> b -> c -> a is a loop');

  // below the minimum spend does not qualify; a qualifying payment does, but pays only after the holdback
  const small = await book(b, court, 2, 9);
  await pool.query('UPDATE invoices SET total_cents = 20000 WHERE id=$1', [small.invoices[0].id]);
  ok(await call('POST', `/invoices/${small.invoices[0].id}/paid`, { token: mgr.token, body: { method: 'cash' } }));
  assert.equal((await pool.query('SELECT status FROM loyalty_referrals WHERE invitee_id=$1', [b.id])).rows[0].status, 'registered', 'under the minimum spend');
  const big = await paid(mgr, b, court, 3, 9);
  const ref = (await pool.query('SELECT * FROM loyalty_referrals WHERE invitee_id=$1', [b.id])).rows[0];
  assert.equal(ref.status, 'qualified');
  assert.equal(await balance(a, plat.id), 0, 'held back until the holdback passes');
  assert.equal(await tx(releaseDueReferrals), 0, 'not before release_at');
  await pool.query("UPDATE loyalty_referrals SET release_at = now() - interval '1 minute' WHERE id=$1", [ref.id]);
  assert.equal(await tx(releaseDueReferrals), 1);
  assert.equal(await tx(releaseDueReferrals), 0, 'released once');
  assert.equal(await balance(a, plat.id), 20000);
  assert.equal(await balance(b, plat.id), 10000);
  assert.equal((await pool.query('SELECT status FROM loyalty_referrals WHERE id=$1', [ref.id])).rows[0].status, 'rewarded');
  // the reward is its own balance, separate from any venue programme
  assert.equal((await call('GET', '/me/loyalty', { token: a.token })).body.every((p) => p.id === plat.id), true);

  // refunding the qualifying payment inside the holdback voids the reward
  const e = await signup('e');
  ok(await call('POST', '/referrals/claim', { token: e.token, body: { code: code.code } }), 201);
  const eb = await paid(mgr, e, court, 4, 9);
  assert.equal((await pool.query('SELECT status FROM loyalty_referrals WHERE invitee_id=$1', [e.id])).rows[0].status, 'qualified');
  ok(await call('DELETE', `/bookings/${eb.bookings[0].id}`, { token: e.token }));
  assert.equal((await pool.query('SELECT status FROM loyalty_referrals WHERE invitee_id=$1', [e.id])).rows[0].status, 'void');
  await pool.query("UPDATE loyalty_referrals SET release_at = now() - interval '1 minute' WHERE invitee_id=$1", [e.id]);
  assert.equal(await tx(releaseDueReferrals), 0);
  assert.equal(await balance(a, plat.id), 20000, 'no reward for a refunded payment');

  // a shared device between referrer and invitee is held for review, not rewarded
  await pool.query("INSERT INTO sync_devices(user_id, device_id) VALUES ($1,'dev-shared'), ($2,'dev-shared')", [a.id, d.id]);
  const held = ok(await call('POST', '/referrals/claim', { token: d.token, body: { code: code.code } }), 201);
  assert.equal(held.status, 'under_review');
  assert.equal((await pool.query('SELECT flags FROM loyalty_referrals WHERE invitee_id=$1', [d.id])).rows[0].flags[0], 'shared_device');
  await paid(mgr, d, court, 5, 9);
  assert.equal(await balance(a, plat.id), 20000, 'held referrals do not pay');
  const r = (await call('GET', `/loyalty/programmes/${plat.id}/referrals`, { token: admin.token, query: undefined })).body.find((x) => x.invitee_handle === d.handle);
  assert.equal(r.status, 'held');
  const rev = ok(await call('POST', `/loyalty/referrals/${r.id}/review`, { token: admin.token, body: { decision: 'reject', note: 'same phone as the referrer' } }));
  assert.equal(rev.status, 'blocked');

  // revoked codes and young people
  ok(await call('DELETE', `/referral-codes/${code.id}`, { token: a.token }));
  const f = await signup('f');
  assert.equal((await call('POST', '/referrals/claim', { token: f.token, body: { code: code.code } })).status, 404);
  const kid = await signup('kid');
  await pool.query("UPDATE users SET youth_until = current_date + 365 WHERE id=$1", [kid.id]);
  assert.equal((await call('POST', `/loyalty/programmes/${plat.id}/referral-codes`, { token: kid.token, body: {} })).status, 409);
  assert.equal((await call('POST', '/referrals/claim', { token: kid.token, body: { code: bCode.code } })).status, 409);
});

// ------------------------------------------------------------------------------------------------------------------------------ separation, exchange
test('organisation balances are separate: no leakage across businesses, no spending across programmes, exchange only when both owners agree', async () => {
  const mgrA = await signup('mgrA', ['venue_manager']), mgrB = await signup('mgrB', ['venue_manager']);
  const A = await venue(mgrA), B = await venue(mgrB);
  const pa = await venueProg(mgrA, A.v), pb = await venueProg(mgrB, B.v);
  const u = await signup('u'), other = await signup('other');
  await paid(mgrA, u, A.court, 3, 9);
  await paid(mgrB, other, B.court, 3, 9);
  assert.equal(await balance(u, pa.id), 10000);
  assert.equal(await balance(u, pb.id), 0);

  // each business sees only its own programme and members
  const membersA = ok(await call('GET', `/loyalty/programmes/${pa.id}/members`, { token: mgrA.token }));
  assert.deepEqual(membersA.map((m) => m.handle), [u.handle]);
  assert.equal((await call('GET', `/loyalty/programmes/${pa.id}/members`, { token: mgrB.token })).status, 404);
  assert.equal((await call('GET', `/loyalty/programmes/${pa.id}/liability`, { token: mgrB.token })).status, 404);
  assert.equal((await call('GET', `/loyalty/programmes/${pa.id}/admin`, { token: mgrB.token })).status, 404);
  assert.equal((await adjust(mgrB, pa, u, 100)).status, 404);
  assert.equal((await call('GET', '/loyalty/programmes', { token: mgrB.token })).body.some((p) => p.id === pa.id), false);
  assert.equal((await call('GET', `/loyalty/programmes/${pa.id}`, { token: other.token })).body.my_points, 0, 'a stranger sees the public rules but no one else\'s balance');

  // A's points do not pay B's bill
  const bb = await book(u, B.court, 5, 9);
  assert.equal((await call('POST', '/loyalty/redeem', { token: u.token, body: { programme_id: pa.id, purpose_type: 'venue_invoice', purpose_id: bb.invoices[0].id } })).status, 409);
  assert.equal((await call('POST', '/loyalty/exchange', { token: u.token, body: { rule_id: '00000000-0000-4000-8000-000000000000', points: 100, request_key: 'exchange-none-1' } })).status, 404);

  // exchange: proposed by A, approved only by B
  const rule = ok(await call('POST', '/loyalty/exchange-rules', { token: mgrA.token, body: { from_programme_id: pa.id, to_programme_id: pb.id, rate_bp: 5000 } }), 201);
  assert.equal(rule.status, 'proposed');
  assert.equal((await call('POST', '/loyalty/exchange', { token: u.token, body: { rule_id: rule.id, points: 1000, request_key: 'exchange-early-1' } })).status, 404, 'not live until approved');
  assert.equal((await call('POST', `/loyalty/exchange-rules/${rule.id}/decision`, { token: mgrA.token, body: { decision: 'approve' } })).status, 403, 'the proposer cannot approve for the other side');
  ok(await call('POST', `/loyalty/exchange-rules/${rule.id}/decision`, { token: mgrB.token, body: { decision: 'approve' } }));
  const ex = ok(await call('POST', '/loyalty/exchange', { token: u.token, body: { rule_id: rule.id, points: 4000, request_key: 'exchange-live-01' } }));
  assert.deepEqual([ex.points_out, ex.points_in], [4000, 2000]);
  assert.equal(await balance(u, pa.id), 6000);
  assert.equal(await balance(u, pb.id), 2000);
  assert.equal(ok(await call('POST', '/loyalty/exchange', { token: u.token, body: { rule_id: rule.id, points: 4000, request_key: 'exchange-live-01' } })).replayed, true);
  assert.equal(await balance(u, pa.id), 6000, 'a retry moves nothing');
});

// ------------------------------------------------------------------------------------------------------------------------------ sponsors
test('sponsor-funded rewards need an active, matching sponsorship; a sponsor cannot issue points; funding is a hard limit', async () => {
  const organiser = await signup('org', ['organizer']);
  const sponsorUser = await signup('spons', ['sponsor']);
  const ev = ok(await call('POST', '/events', { token: organiser.token, body: { name: `Sponsored Cup ${++seq}`, sport: 'football', starts_on: dateOf(10), ends_on: dateOf(12), currency: 'INR' } }), 201);
  const otherEv = ok(await call('POST', '/events', { token: organiser.token, body: { name: `Other Cup ${++seq}`, sport: 'football', starts_on: dateOf(10), ends_on: dateOf(12), currency: 'INR' } }), 201);
  const sp = (await pool.query("INSERT INTO sponsors(owner_id, name) VALUES ($1,'Acme') RETURNING id", [sponsorUser.id])).rows[0];
  const deal = async (target, status = 'active', amount = 5000) => (await pool.query("INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, currency, status, proposed_by) VALUES ($1,'event',$2,$3,'INR',$4,$5) RETURNING id", [sp.id, target, amount, status, sponsorUser.id])).rows[0].id;
  const matching = await deal(ev.id), proposed = await deal(ev.id, 'proposed'), wrongEvent = await deal(otherEv.id);
  const mk = (sponsorshipId) => call('POST', '/loyalty/programmes', { token: organiser.token, body: { owner_kind: 'event', owner_id: ev.id, name: `Cup rewards ${++seq}`, funding_owner: 'sponsor', sponsorship_id: sponsorshipId } });
  assert.equal((await mk(proposed)).status, 400, 'a proposed sponsorship does not fund anything');
  assert.equal((await mk(wrongEvent)).status, 403, 'the agreement must name this event');
  assert.equal((await call('POST', '/loyalty/programmes', { token: organiser.token, body: { owner_kind: 'event', owner_id: ev.id, name: 'No deal', funding_owner: 'sponsor' } })).status, 400);
  assert.equal((await call('POST', '/loyalty/programmes', { token: sponsorUser.token, body: { owner_kind: 'event', owner_id: ev.id, name: 'Sponsor run', funding_owner: 'sponsor', sponsorship_id: matching } })).status, 404, 'the sponsor does not run the programme');
  const prog = ok(await mk(matching), 201);
  ok(await call('POST', `/loyalty/programmes/${prog.id}/publish`, { token: organiser.token, body: { rules: { earn: [{ key: 'sprint', event: 'sponsored_challenge', mode: 'fixed', points: 3000, label: 'Sprint challenge' }], redeem: { purposes: [] }, expiry_months: 6 } } }));

  const athlete = await signup('athlete');
  // the sponsor cannot issue or award
  assert.equal((await adjust(sponsorUser, prog, athlete, 500)).status, 404);
  assert.equal((await call('POST', `/loyalty/programmes/${prog.id}/challenges/award`, { token: sponsorUser.token, body: { rule_key: 'sprint', user_handle: athlete.handle, evidence_ref: 'timing-001' } })).status, 404);
  // the organiser awards a verified challenge once; funding (5000) limits what can ever be issued
  const first = ok(await call('POST', `/loyalty/programmes/${prog.id}/challenges/award`, { token: organiser.token, body: { rule_key: 'sprint', user_handle: athlete.handle, evidence_ref: 'timing-001' } }));
  assert.equal(first.points, 3000);
  assert.equal(ok(await call('POST', `/loyalty/programmes/${prog.id}/challenges/award`, { token: organiser.token, body: { rule_key: 'sprint', user_handle: athlete.handle, evidence_ref: 'timing-001' } })).awarded, false, 'one award per reference');
  const second = ok(await call('POST', `/loyalty/programmes/${prog.id}/challenges/award`, { token: organiser.token, body: { rule_key: 'sprint', user_handle: athlete.handle, evidence_ref: 'timing-002' } }));
  assert.equal(second.points, 2000, 'cut to what the sponsorship still funds');
  assert.equal((await call('POST', `/loyalty/programmes/${prog.id}/challenges/award`, { token: organiser.token, body: { rule_key: 'sprint', user_handle: athlete.handle, evidence_ref: 'timing-003' } })).status, 409, 'funding exhausted');
  const liab = ok(await call('GET', `/loyalty/programmes/${prog.id}/liability`, { token: organiser.token }));
  assert.equal(liab.outstanding.by_funding.sponsor, 5000);
  assert.equal((await ledger(prog.id, athlete.id)).every((r) => r.funding_owner === 'sponsor' && r.sponsorship_id === matching), true, 'every row names its funder and agreement');
  // when the agreement ends, nothing more is issued
  await pool.query("UPDATE sponsorships SET status='ended' WHERE id=$1", [matching]);
  assert.equal((await adjust(organiser, prog, athlete, 10)).status, 409);
  assert.equal((await call('POST', `/loyalty/programmes/${prog.id}/status`, { token: organiser.token, body: { action: 'pause' } })).status, 200);
  assert.equal((await call('POST', `/loyalty/programmes/${prog.id}/status`, { token: organiser.token, body: { action: 'resume' } })).status, 400, 'cannot resume once the agreement has ended');
});

// ------------------------------------------------------------------------------------------------------------------------------ youth
test('young people: excluded by default; allowed only through a live guardian link when the programme says so', async () => {
  const mgr = await signup('mgr', ['venue_manager']);
  const { v, court } = await venue(mgr);
  const strict = await venueProg(mgr, v, rules(), 'Adults only');
  const lenient = await venueProg(mgr, v, rules({ eligibility: { youth: 'guardian_linked' } }), 'Family rewards');
  const kid = await signup('kid'), guardian = await signup('parent');
  await pool.query("UPDATE users SET youth_until = current_date + 365 WHERE id=$1", [kid.id]);
  await paid(mgr, kid, court, 3, 9);
  assert.equal(await balance(kid, strict.id), 0);
  assert.equal(await balance(kid, lenient.id), 0, 'no verified guardian link yet');
  assert.equal((await adjust(mgr, strict, kid, 100)).status, 409);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by, decided_at) VALUES ($1,$2,'parent','active',$1, now())", [guardian.id, kid.id]);
  await paid(mgr, kid, court, 4, 9);
  assert.equal(await balance(kid, strict.id), 0);
  assert.equal(await balance(kid, lenient.id), 10000);
  await pool.query("UPDATE guardian_links SET status='revoked', revoked_at=now() WHERE child_id=$1", [kid.id]);
  const b = await book(kid, court, 5, 9);
  assert.equal((await call('POST', '/loyalty/redeem', { token: kid.token, body: { programme_id: lenient.id, purpose_type: 'venue_invoice', purpose_id: b.invoices[0].id } })).status, 403, 'revoking the link stops spending immediately');
});

// ------------------------------------------------------------------------------------------------------------------------------ academy, coach, event
test('academy journey: a paid fee earns for the payer; points pay part of a charge, come back when it is cancelled, and cover it fully when asked', async () => {
  const owner = await signup('academyowner', ['organizer']);
  const org = ok(await call('POST', '/organisations', { token: owner.token, body: { name: `Academy ${++seq}`, kind: 'academy' } }), 201);
  ok(await call('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['football'], currency: 'INR', listed: true } }));
  const ap = ok(await call('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'football', title: `U12 ${seq}`, capacity: 20, admission_mode: 'direct', public: true } }), 201);
  const pub = ok(await call('POST', `/academy/programmes/${ap.id}/versions`, { token: owner.token, body: { row_version: ap.row_version, billing_model: 'one_time', currency: 'INR', fee_minor: 100000 } }), 201);
  const prog = await programme(owner, { owner_kind: 'organisation', owner_id: org.id }, 'Academy rewards', {
    earn: [{ key: 'fees', event: 'academy_payment_paid', mode: 'percent', percent_bp: 500 }], redeem: { max_redeem_bp: 5000, purposes: ['academy_charge'] }, expiry_months: 12,
  }, { currency: 'INR' });
  const parent = await signup('parent');
  const charge = async (amount) => {                       // each charge belongs to its own application (one live application per athlete and programme)
    const kid = await signup('player');
    const app = (await pool.query("INSERT INTO academy_applications(organisation_id, programme_id, athlete_id, applicant_id, stage) VALUES ($1,$2,$3,$4,'submitted') RETURNING id", [org.id, pub.programme.id, kid.id, parent.id])).rows[0];
    return (await pool.query("INSERT INTO academy_charges(application_id, organisation_id, payer_id, seq, kind, due_on, currency, gross_minor, amount_minor) VALUES ($1,$2,$3,1,'tuition',current_date,'INR',$4,$4) RETURNING *", [app.id, org.id, parent.id, amount])).rows[0];
  };
  const c1 = await charge(200000);
  await tx((c) => fulfilChargePaid(c, c1.id, { method: 'cash' }));
  assert.equal(await balance(parent, prog.id), 10000, '5% of the fee, to the payer');
  await tx((c) => fulfilChargePaid(c, c1.id, { method: 'cash' }));
  assert.equal(await balance(parent, prog.id), 10000, 'paying twice cannot earn twice');

  const c2 = await charge(100000);
  const part = ok(await call('POST', '/loyalty/redeem', { token: parent.token, body: { programme_id: prog.id, purpose_type: 'academy_charge', purpose_id: c2.id, points: 6000 } }));
  assert.deepEqual([part.points_used, part.due_after, part.paid], [6000, 94000, false]);
  assert.equal((await call('POST', '/loyalty/redeem', { token: (await signup('x')).token, body: { programme_id: prog.id, purpose_type: 'academy_charge', purpose_id: c2.id } })).status, 403);
  await tx((c) => cancelUnpaidCharges(c, 'id=$1', [c2.id]));
  assert.equal(await balance(parent, prog.id), 10000, 'cancelling the unpaid charge returns the points');

  const c3 = await charge(20000);
  const cover = ok(await call('POST', '/loyalty/redeem', { token: parent.token, body: { programme_id: prog.id, purpose_type: 'academy_charge', purpose_id: c3.id, points: 10000 } }));
  assert.equal(cover.points_used, 10000, 'capped at 50% of the charge');
  assert.equal(cover.paid, false);
  // the remainder is paid in cash: the points part earns nothing
  await tx((c) => fulfilChargePaid(c, c3.id, { method: 'cash' }));
  assert.equal(await balance(parent, prog.id), 500, '5% of the 100 paid in cash, not of the 100 paid in points');
});

test('coach journey: points pay a session; completing a paid session earns once; cancelling returns the points', async () => {
  const coach = await signup('coach', ['coach']);
  const prog = await programme(coach, { owner_kind: 'coach' }, 'Coach club', {
    earn: [{ key: 'sessions', event: 'coach_session_completed', mode: 'fixed', points: 150, min_spend_minor: 1 }], redeem: { max_redeem_bp: 5000, purposes: ['coach_hire'] }, expiry_months: 6,
  }, { currency: 'INR' });
  const athlete = await signup('athlete');
  assert.equal((await adjust(coach, prog, athlete, 5000)).status, 200);
  const hire = async (days) => (await pool.query("INSERT INTO coach_hires(hirer_id, coach_id, starts_at, duration_min, rate_cents_hour, total_cents, status, payment_status) VALUES ($1,$2, now() + make_interval(days => $3), 60, 100000, 100000, 'confirmed', 'unpaid') RETURNING *", [athlete.id, coach.id, days])).rows[0];
  const h1 = await hire(2);
  const used = ok(await call('POST', '/loyalty/redeem', { token: athlete.token, body: { programme_id: prog.id, purpose_type: 'coach_hire', purpose_id: h1.id, points: 3000 } }));
  assert.deepEqual([used.points_used, used.due_after], [3000, 97000]);
  const quote = await call('GET', '/loyalty/options', { token: athlete.token, query: undefined });
  assert.equal(quote.status, 400, 'purpose is required');
  const opts = ok(await call('GET', `/loyalty/options?purpose_type=coach_hire&purpose_id=${h1.id}`, { token: athlete.token }));
  assert.equal(opts[0].usable_points, 2000, '50% cap (50000) less the 3000 already used, limited by the balance of 2000');
  // the rest is paid (card checkout settles elsewhere); completing now earns on the cash part
  await pool.query("UPDATE coach_hires SET payment_status='paid', starts_at = now() - interval '2 hours' WHERE id=$1", [h1.id]);
  ok(await call('PATCH', `/hires/${h1.id}`, { token: coach.token, body: { status: 'completed' } }));
  assert.equal(await balance(athlete, prog.id), 2000 + 150);
  assert.equal((await call('PATCH', `/hires/${h1.id}`, { token: coach.token, body: { status: 'completed' } })).status, 409); // already final
  assert.equal(await balance(athlete, prog.id), 2000 + 150, 'completing again earns nothing');

  const h2 = await hire(3);
  ok(await call('POST', '/loyalty/redeem', { token: athlete.token, body: { programme_id: prog.id, purpose_type: 'coach_hire', purpose_id: h2.id, points: 2000 } }));
  assert.equal(await balance(athlete, prog.id), 150);
  ok(await call('PATCH', `/hires/${h2.id}`, { token: athlete.token, body: { status: 'cancelled' } }));
  assert.equal(await balance(athlete, prog.id), 2150, 'a cancelled session gives its points back');
  assert.equal((await pool.query('SELECT loyalty_credit_cents FROM coach_hires WHERE id=$1', [h2.id])).rows[0].loyalty_credit_cents, 2000, 'the credit stays on the session record for the audit trail');
});

test('event journey: finishing an event rewards accepted entrants once; others earn nothing; memberships earn per month', async () => {
  const organiser = await signup('eorg', ['organizer']);
  const ev = ok(await call('POST', '/events', { token: organiser.token, body: { name: `Finals ${++seq}`, sport: 'football', starts_on: dateOf(1), ends_on: dateOf(2), currency: 'INR' } }), 201);
  const prog = await programme(organiser, { owner_kind: 'event', owner_id: ev.id }, 'Finals rewards', { earn: [{ key: 'played', event: 'event_participation', mode: 'fixed', points: 250 }], redeem: { purposes: [] }, expiry_months: 12 });
  const [p1, p2, p3] = [await signup('p1'), await signup('p2'), await signup('p3')];
  const e1 = ok(await call('POST', `/events/${ev.id}/entries`, { token: p1.token, body: {} }), 201);
  const e2 = ok(await call('POST', `/events/${ev.id}/entries`, { token: p2.token, body: {} }), 201);
  ok(await call('POST', `/events/${ev.id}/entries`, { token: p3.token, body: {} }), 201);
  ok(await call('PATCH', `/entries/${e1.id}`, { token: organiser.token, body: { status: 'accepted' } }));
  ok(await call('PATCH', `/entries/${e2.id}`, { token: organiser.token, body: { status: 'rejected' } }));
  assert.equal(await tx(eventParticipationSweep), 0, 'nothing before the event finishes');
  await pool.query("UPDATE events SET status='completed', ended_at=now() WHERE id=$1", [ev.id]);
  assert.ok(await tx(eventParticipationSweep) >= 1);
  assert.equal(await tx(eventParticipationSweep), 0, 'a second sweep awards nothing');
  assert.equal(await balance(p1, prog.id), 250);
  assert.equal(await balance(p2, prog.id), 0, 'rejected');
  assert.equal(await balance(p3, prog.id), 0, 'pending');

  // memberships: one award per whole month, never twice
  const mgr = await signup('mgr', ['venue_manager']);
  const { v } = await venue(mgr);
  const mp = await venueProg(mgr, v, rules({ earn: [{ key: 'tenure', event: 'membership_tenure', mode: 'fixed', points: 100, min_spend_minor: 1 }] }), 'Members');
  const m = await signup('member');
  const plan = (await pool.query("INSERT INTO venue_plans(venue_id, kind, name, price_cents, duration_days, discount_bp) VALUES ($1,'membership','Gold',50000,30,500) RETURNING id", [v.id])).rows[0];
  await pool.query("INSERT INTO user_plans(plan_id, venue_id, user_id, kind, name, price_cents, currency, status, duration_days, discount_bp, starts_at, expires_at) VALUES ($1,$2,$3,'membership','Gold',50000,'INR','active',30,500, now() - interval '65 days', now() + interval '300 days')", [plan.id, v.id, m.id]);
  assert.equal(await tx(membershipTenureSweep), 2);
  assert.equal(await tx(membershipTenureSweep), 0);
  assert.equal(await balance(m, mp.id), 200);
});

// ------------------------------------------------------------------------------------------------------------------------------ rankings, MCP, docs
test('loyalty has zero impact on rankings: no ranking or standings code reads or writes the loyalty tables', () => {
  const src = new URL('../src/', import.meta.url);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]));
  const files = walk(src).filter((f) => f.pathname.endsWith('.js'));
  const allowed = /\/(rewards\/|scopes\.js|booking\/(loyalty|credits)\.js|capabilities\/(loyalty|venues)\.js|academy-invoices\.js|payments\/service\.js|worker\.js|capabilities\/(hire|academy-billing)\.js|migrate\.js)/;
  const users = files.filter((f) => /loyalty_|rewards\//.test(readFileSync(f, 'utf8'))).map((f) => f.pathname.split('/src/')[1]).filter((p) => !allowed.test(`/${p}`));
  assert.deepEqual(users, [], 'only the loyalty engine and the bills it settles touch the ledger');
  const ranking = files.filter((f) => /standings|leaderboard|ranking|rating/i.test(f.pathname)).map((f) => readFileSync(f, 'utf8')).join('\n');
  assert.doesNotMatch(ranking, /loyalty|rewards\//i, 'rankings never read points');
  assert.doesNotMatch(readFileSync(new URL('helpers.js', src), 'utf8'), /loyalty/i, 'standings() lives in helpers.js and knows nothing of points');
});

test('REST, OpenAPI and MCP expose one loyalty surface, and money-moving calls need the payment scope', async () => {
  const { capabilities } = await import('../src/capabilities/index.js');
  const names = capabilities.filter((c) => c.tag === 'Loyalty').map((c) => c.name);
  for (const n of ['get_loyalty', 'redeem_points', 'publish_loyalty_programme', 'claim_referral_code', 'loyalty_liability', 'adjust_loyalty_points', 'exchange_loyalty_points']) assert.ok(names.includes(n), n);
  assert.equal(capabilities.find((c) => c.name === 'redeem_points').scope, 'payment');
  assert.equal(capabilities.find((c) => c.name === 'exchange_loyalty_points').scope, 'payment');
  for (const old of ['apply_points_to_invoice', 'venue_loyalty', 'grant_loyalty_points']) assert.ok(!capabilities.some((c) => c.name === old), `${old} was merged into the programme capabilities`);
  const { buildOpenApi } = await import('../src/openapi.js');
  const doc = buildOpenApi();
  assert.ok(Object.values(doc.paths).flatMap((p) => Object.values(p)).some((o) => o.operationId === 'redeem_points'));
  const t = await signup('tok');
  const tok = ok(await call('POST', '/me/tokens', { token: t.token, body: { name: 'read only', scopes: ['read'] } }), 201);
  assert.equal((await call('POST', '/loyalty/exchange', { token: tok.token, body: { rule_id: '00000000-0000-4000-8000-000000000000', points: 1, request_key: 'scope-check-1' } })).status, 403, 'a read-only token cannot move points');
  assert.equal((await call('GET', '/me/loyalty', { token: tok.token })).status, 200);
});
