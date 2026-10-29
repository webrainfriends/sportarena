// Venue slot ballots: the venue team opens a ballot for oversubscribed slots, people bid, winners are drawn (auto) or picked by hand
// (manual), and a slot is only allocated once the winner pays. See src/booking/ballots.js for the lifecycle and the booking-engine hold.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { isYouth } from '../youth.js';
import { mustManage, canManage, loadVenueCtx, checkWindow, priceWindow, blockedBy, usedUnits, lockResources, cancelBookings, reservationView } from '../booking/engine.js';
import { acceptOffer, drawBallot, logBallot, offerSlot, releaseEntry, settleIfDone, LIVE_ENTRY } from '../booking/ballots.js';

const TAG = 'Venue ballots';
const dt = z.string().datetime({ offset: true });
const method = z.enum(['highest_bid', 'random_draw']).describe('highest_bid: the highest bid wins each slot (ties are drawn); random_draw: a fair lottery, everyone pays the floor price');
const mode = z.enum(['auto', 'manual']).describe('auto: the draw offers each slot to its top entrant; manual: the venue picks who gets each slot');

const ballotOf = async (ballotId, c = pool) => {
  const b = (await c.query('SELECT * FROM venue_ballots WHERE id=$1', [ballotId])).rows[0];
  if (!b) throw notFound('Ballot');
  return b;
};
/** The venue team only; anyone else gets a 404 so a ballot's existence is not leaked. */
const managedBallot = async (user, ballotId, c = pool) => {
  const b = await ballotOf(ballotId, c);
  if (!(await canManage(user, b.venue_id, c))) throw notFound('Ballot');
  return b;
};
const stale = (b, v) => { if (v !== undefined && v !== b.row_version) throw conflict('This ballot changed — reload it and try again', { code: 'stale' }); };

// ------------------------------------------------------------------ venue team
cap({
  name: 'create_venue_ballot', method: 'POST', path: '/venues/:id/ballots', tag: TAG, status: 201,
  summary: 'Draft a ballot for oversubscribed slots (venue team). Each slot is a court and time window; its floor price defaults to the venue rate. Bidding opens when you open it; nothing is held until then.',
  input: z.object({
    id, title: z.string().min(1).max(120), method: method.default('highest_bid'), mode: mode.default('auto'),
    opens_at: dt.optional(), closes_at: dt, pay_window_minutes: z.number().int().min(5).max(2880).default(30).describe('how long a winner has to accept and pay'),
    slots: z.array(z.object({ resource_id: id, starts_at: dt, ends_at: dt, quantity: z.number().int().min(1).max(1000).default(1), floor_cents: z.number().int().min(0).optional() })).min(1).max(200),
  }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    return tx(async (c) => {
      const ctx = await loadVenueCtx(c, i.id);
      const resIds = [...new Set(i.slots.map((s) => s.resource_id))];
      await lockResources(c, resIds);
      const resources = new Map((await c.query('SELECT * FROM resources WHERE id = ANY($1::uuid[]) AND venue_id=$2 AND active', [resIds, i.id])).rows.map((r) => [r.id, r]));
      const closes = new Date(i.closes_at);
      if (closes <= new Date()) throw badRequest('The closing time must be in the future');
      if (i.opens_at && new Date(i.opens_at) >= closes) throw badRequest('Bidding must open before it closes');
      const seen = [];
      const rows = i.slots.map((s) => {
        const res = resources.get(s.resource_id);
        if (!res) throw badRequest('Every slot must be a bookable area of this venue');
        const start = new Date(s.starts_at), end = new Date(s.ends_at);
        if (closes > start) throw badRequest('Bidding must close before the earliest slot starts');
        if (s.quantity > res.capacity) throw badRequest(`${res.name} has ${res.capacity} unit(s)`);
        checkWindow(ctx, res, start, end, { staff: true });
        if (seen.some((x) => x.r === res.id && x.s < end && x.e > start)) throw badRequest(`${res.name} has overlapping slots in this ballot`);
        seen.push({ r: res.id, s: start, e: end });
        return { res, start, end, qty: s.quantity, floor: s.floor_cents ?? priceWindow(ctx, res, start, end, s.quantity).base_cents };
      });
      const b = (await c.query(
        'INSERT INTO venue_ballots(venue_id, title, method, mode, opens_at, closes_at, pay_window_minutes, currency, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [i.id, i.title, i.method, i.mode, i.opens_at ?? null, closes, i.pay_window_minutes, ctx.venue.currency, user.id])).rows[0];
      for (const r of rows) await c.query('INSERT INTO venue_ballot_slots(ballot_id, resource_id, starts_at, ends_at, quantity, floor_cents) VALUES ($1,$2,$3,$4,$5,$6)', [b.id, r.res.id, r.start, r.end, r.qty, r.floor]);
      await logBallot(c, b.id, user.id, 'created', { slots: rows.length });
      await audit(c, user.id, 'create_venue_ballot', 'venue_ballots', b.id);
      return ballotDetail(c, b, user);
    });
  },
});

cap({
  name: 'update_venue_ballot', method: 'PATCH', path: '/ballots/:id', tag: TAG,
  summary: 'Edit a draft ballot (venue team): title, method, mode, closing time and pay window. Slots and rules are fixed once it is open.',
  input: z.object({ id, title: z.string().min(1).max(120).optional(), method: method.optional(), mode: mode.optional(), opens_at: dt.nullable().optional(), closes_at: dt.optional(), pay_window_minutes: z.number().int().min(5).max(2880).optional(), row_version: z.number().int().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const b = await managedBallot(user, i.id, c);
      stale(b, i.row_version);
      if (b.status !== 'draft') throw conflict('Only a draft ballot can be edited');
      const closes = i.closes_at ? new Date(i.closes_at) : b.closes_at;
      if (closes <= new Date()) throw badRequest('The closing time must be in the future');
      const first = (await c.query('SELECT min(starts_at) AS s FROM venue_ballot_slots WHERE ballot_id=$1', [b.id])).rows[0].s;
      if (first && closes > first) throw badRequest('Bidding must close before the earliest slot starts');
      const n = (await c.query(
        `UPDATE venue_ballots SET title=coalesce($2,title), method=coalesce($3,method), mode=coalesce($4,mode), opens_at=CASE WHEN $5::boolean THEN $6 ELSE opens_at END,
                closes_at=$7, pay_window_minutes=coalesce($8,pay_window_minutes), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
        [b.id, i.title ?? null, i.method ?? null, i.mode ?? null, i.opens_at !== undefined, i.opens_at ?? null, closes, i.pay_window_minutes ?? null])).rows[0];
      await logBallot(c, b.id, user.id, 'updated');
      return ballotDetail(c, n, user);
    });
  },
});

cap({
  name: 'open_venue_ballot', method: 'POST', path: '/ballots/:id/open', tag: TAG,
  summary: 'Open bidding (venue team). Every slot must still be free; from now on the slots are held for the ballot and cannot be booked directly.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const b = await managedBallot(user, i.id, c);
      if (b.status !== 'draft') throw conflict('Only a draft ballot can be opened');
      if (b.closes_at <= new Date()) throw badRequest('The closing time has passed — edit it first');
      const slots = (await c.query('SELECT s.*, r.name, r.capacity FROM venue_ballot_slots s JOIN resources r ON r.id=s.resource_id WHERE s.ballot_id=$1', [b.id])).rows;
      await lockResources(c, slots.map((s) => s.resource_id));
      for (const s of slots) {
        if (await blockedBy(c, b.venue_id, s.resource_id, s.starts_at, s.ends_at)) throw conflict(`${s.name} is blocked during one of the slots`);
        const used = await usedUnits(c, s.resource_id, s.starts_at, s.ends_at, undefined, null);
        if (used + s.quantity > s.capacity) throw conflict(`${s.name} is already taken or held for one of the slots`);
      }
      const n = (await c.query("UPDATE venue_ballots SET status='open', opens_at=coalesce(opens_at, now()), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [b.id])).rows[0];
      await logBallot(c, b.id, user.id, 'opened');
      await audit(c, user.id, 'open_venue_ballot', 'venue_ballots', b.id);
      return ballotDetail(c, n, user);
    });
  },
});

cap({
  name: 'close_venue_ballot', method: 'POST', path: '/ballots/:id/close', tag: TAG,
  summary: 'Stop taking bids now (venue team). Auto ballots are not drawn until you run the draw (or the deadline sweep does it); manual ballots are ready for you to allocate.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const b = await managedBallot(user, i.id, c);
      if (b.status !== 'open') throw conflict('Only an open ballot can be closed');
      const n = (await c.query("UPDATE venue_ballots SET status='closed', row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [b.id])).rows[0];
      await logBallot(c, b.id, user.id, 'closed', { by: 'venue' });
      await audit(c, user.id, 'close_venue_ballot', 'venue_ballots', b.id);
      return ballotDetail(c, n, user);
    });
  },
});

cap({
  name: 'run_ballot_draw', method: 'POST', path: '/ballots/:id/draw', tag: TAG,
  summary: 'Rank the entries of every slot (venue team). Auto ballots then offer each slot to its top entrant, who has the pay window to accept and pay; manual ballots only get the ranking, you allocate. The random seed is stored so the draw can be reproduced.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const b = await managedBallot(user, i.id, c);
      if (!['open', 'closed'].includes(b.status)) throw conflict('This ballot has already been drawn or cancelled');
      const cur = (await c.query('SELECT * FROM venue_ballots WHERE id=$1 FOR UPDATE', [b.id])).rows[0];
      if (!['open', 'closed'].includes(cur.status)) throw conflict('This ballot has already been drawn or cancelled');
      const result = await drawBallot(c, cur, user.id);
      await audit(c, user.id, 'run_ballot_draw', 'venue_ballots', b.id);
      return { ...result, ballot: await ballotDetail(c, await ballotOf(b.id, c), user) };
    });
  },
});

cap({
  name: 'allocate_ballot_slot', method: 'POST', path: '/ballot-slots/:id/allocate', tag: TAG,
  summary: 'Pick who gets a slot (venue team): the slot is blocked for that entrant, who has the pay window to accept and pay. Works on closed ballots, either mode. Re-allocating moves an unpaid hold to someone else.',
  input: z.object({ id, entry_id: id, reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const slot = (await c.query(`SELECT s.*, b.venue_id, b.title, b.pay_window_minutes, b.status AS ballot_status, r.name AS resource_name, v.name AS venue_name, v.timezone
        FROM venue_ballot_slots s JOIN venue_ballots b ON b.id=s.ballot_id JOIN resources r ON r.id=s.resource_id JOIN venues v ON v.id=b.venue_id WHERE s.id=$1`, [i.id])).rows[0];
      if (!slot || !(await canManage(user, slot.venue_id, c))) throw notFound('Slot');
      if (!['closed', 'drawn'].includes(slot.ballot_status)) throw conflict('Close the ballot before allocating slots');
      await lockResources(c, [slot.resource_id]);
      const cur = (await c.query('SELECT * FROM venue_ballot_slots WHERE id=$1 FOR UPDATE', [slot.id])).rows[0];
      if (!['open', 'offered'].includes(cur.status)) throw conflict('That slot already has a paid or pending winner');
      const e = (await c.query('SELECT * FROM venue_ballot_entries WHERE id=$1 AND slot_id=$2 FOR UPDATE', [i.entry_id, slot.id])).rows[0];
      if (!e || !['entered', 'ranked'].includes(e.status)) throw badRequest('Pick a live entry for this slot');
      if (cur.status === 'offered') await c.query("UPDATE venue_ballot_entries SET status='ranked', hold_expires_at=NULL, updated_at=now() WHERE id=$1 AND status='offered'", [cur.winner_entry_id]);
      await offerSlot(c, { ...slot, ...cur }, e, user.id, 'manual');
      if (slot.ballot_status === 'closed') await c.query("UPDATE venue_ballots SET status='drawn', drawn_at=coalesce(drawn_at, now()), updated_at=now(), row_version=row_version+1 WHERE id=$1", [slot.ballot_id]);
      await logBallot(c, slot.ballot_id, user.id, 'allocated', { slot_id: slot.id, entry_id: e.id, reason: i.reason ?? null });
      await audit(c, user.id, 'allocate_ballot_slot', 'venue_ballot_slots', slot.id);
      return (await c.query('SELECT * FROM venue_ballot_slots WHERE id=$1', [slot.id])).rows[0];
    });
  },
});

cap({
  name: 'release_ballot_slot', method: 'POST', path: '/ballot-slots/:id/release', tag: TAG,
  summary: 'Take a slot back (venue team). With a held or unpaid winner they lose it (an auto ballot offers it to the next ranked entrant; a manual one reopens it); with no winner the slot is marked unfilled and becomes bookable again.',
  input: z.object({ id, reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const slot = (await c.query('SELECT s.*, b.venue_id, b.status AS ballot_status FROM venue_ballot_slots s JOIN venue_ballots b ON b.id=s.ballot_id WHERE s.id=$1', [i.id])).rows[0];
      if (!slot || !(await canManage(user, slot.venue_id, c))) throw notFound('Slot');
      if (!['closed', 'drawn'].includes(slot.ballot_status)) throw conflict('Only a closed ballot has slots to release');
      await lockResources(c, [slot.resource_id]);
      if (['offered', 'awaiting_payment'].includes(slot.status)) {
        const e = (await c.query('SELECT * FROM venue_ballot_entries WHERE id=$1 FOR UPDATE', [slot.winner_entry_id])).rows[0];
        await releaseEntry(c, e, 'lost', user, i.reason ?? 'Released by the venue');
        await notify(c, e.user_id, { kind: 'ballot_released', title: 'The venue released your ballot slot', body: i.reason ?? 'The venue took the slot back.', data: { ballot_id: slot.ballot_id, venue_id: slot.venue_id }, dedupe_key: `ballot_released:${e.id}` });
      } else if (slot.status === 'open') {
        await c.query("UPDATE venue_ballot_slots SET status='unfilled' WHERE id=$1", [slot.id]);
        await c.query("UPDATE venue_ballot_entries SET status='lost', updated_at=now() WHERE slot_id=$1 AND status IN ('entered','ranked')", [slot.id]);
        await logBallot(c, slot.ballot_id, user.id, 'unfilled', { slot_id: slot.id, by: 'venue' });
      } else throw conflict('That slot is already settled');
      await audit(c, user.id, 'release_ballot_slot', 'venue_ballot_slots', slot.id);
      await settleIfDone(c, slot.ballot_id);
      return (await c.query('SELECT * FROM venue_ballot_slots WHERE id=$1', [slot.id])).rows[0];
    });
  },
});

cap({
  name: 'cancel_venue_ballot', method: 'POST', path: '/ballots/:id/cancel', tag: TAG,
  summary: 'Cancel a ballot (venue team). Held slots are released, unpaid reservations cancelled (nothing charged), entrants told. Slots already paid and confirmed stay booked.',
  input: z.object({ id, reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const b = await managedBallot(user, i.id, c);
      if (['settled', 'cancelled'].includes(b.status)) throw conflict('This ballot is already finished');
      await lockResources(c, (await c.query('SELECT DISTINCT resource_id FROM venue_ballot_slots WHERE ballot_id=$1', [b.id])).rows.map((r) => r.resource_id));
      await c.query("UPDATE venue_ballots SET status='cancelled', row_version=row_version+1, updated_at=now() WHERE id=$1", [b.id]);
      const entries = (await c.query("SELECT e.*, s.status AS slot_status FROM venue_ballot_entries e JOIN venue_ballot_slots s ON s.id=e.slot_id WHERE e.ballot_id=$1 AND e.status IN ('entered','ranked','offered','awaiting_payment')", [b.id])).rows;
      for (const e of entries) {
        if (e.reservation_id) {
          const ids = (await c.query("SELECT id FROM bookings WHERE reservation_id=$1 AND status='confirmed' AND payment_status <> 'paid'", [e.reservation_id])).rows.map((r) => r.id);
          if (ids.length) await cancelBookings(c, ids, { actor: user, byVenue: true, waive: true, silent: true, reason: i.reason ?? 'Ballot cancelled' });
        }
        await c.query("UPDATE venue_ballot_entries SET status='withdrawn', hold_expires_at=NULL, updated_at=now() WHERE id=$1", [e.id]);
        await notify(c, e.user_id, { kind: 'ballot_cancelled', title: 'A ballot you entered was cancelled', body: i.reason ?? 'The venue cancelled the ballot.', data: { ballot_id: b.id, venue_id: b.venue_id }, dedupe_key: `ballot_cancelled:${e.id}` });
      }
      await c.query("UPDATE venue_ballot_slots SET status='cancelled', holder_user_id=NULL WHERE ballot_id=$1 AND status IN ('open','offered','awaiting_payment')", [b.id]);
      await logBallot(c, b.id, user.id, 'cancelled', { reason: i.reason ?? null });
      await audit(c, user.id, 'cancel_venue_ballot', 'venue_ballots', b.id);
      return ballotDetail(c, await ballotOf(b.id, c), user);
    });
  },
});

cap({
  name: 'list_venue_ballots', method: 'GET', path: '/venues/:id/ballots', tag: TAG,
  summary: 'All ballots of a venue with slot and entry counts (venue team).', input: z.object({ id, status: z.enum(['draft', 'open', 'closed', 'drawn', 'settled', 'cancelled']).optional(), ...page }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    return many(
      `SELECT b.*, (SELECT count(*)::int FROM venue_ballot_slots s WHERE s.ballot_id=b.id) AS slots,
              (SELECT count(*)::int FROM venue_ballot_entries e WHERE e.ballot_id=b.id AND e.status IN ('entered','ranked','offered','awaiting_payment','confirmed')) AS entries,
              (SELECT count(*)::int FROM venue_ballot_slots s WHERE s.ballot_id=b.id AND s.status='confirmed') AS confirmed
         FROM venue_ballots b WHERE b.venue_id=$1 AND ($2::text IS NULL OR b.status=$2) ORDER BY b.created_at DESC LIMIT $3 OFFSET $4`, [i.id, i.status ?? null, i.limit, i.offset]);
  },
});

/** A ballot with its slots. The venue team also gets every entry (bids are sealed from everyone else); an entrant gets only their own. */
async function ballotDetail(c, b, viewer) {
  const manager = viewer && (await canManage(viewer, b.venue_id, c));
  const venue = (await c.query('SELECT id, name, timezone, currency FROM venues WHERE id=$1', [b.venue_id])).rows[0];
  const slots = (await c.query(
    `SELECT s.*, r.name AS resource_name, r.kind AS resource_kind,
            (SELECT count(*)::int FROM venue_ballot_entries e WHERE e.slot_id=s.id AND e.status = ANY($2)) AS entries
       FROM venue_ballot_slots s JOIN resources r ON r.id=s.resource_id WHERE s.ballot_id=$1 ORDER BY s.starts_at, r.name, s.id`, [b.id, LIVE_ENTRY])).rows;
  const out = { ...b, venue, slots: slots.map((s) => ({ ...s, holder_user_id: manager ? s.holder_user_id : undefined, winner_entry_id: manager ? s.winner_entry_id : undefined })), is_manager: !!manager };
  if (manager) {
    out.entries = (await c.query(
      `SELECT e.id, e.slot_id, e.user_id, e.bid_cents, e.status, e.rank, e.hold_expires_at, e.reservation_id, e.created_at, u.display_name, u.handle
         FROM venue_ballot_entries e JOIN users u ON u.id=e.user_id WHERE e.ballot_id=$1 ORDER BY e.slot_id, coalesce(e.rank, 1000000), e.bid_cents DESC, e.created_at`, [b.id])).rows;
    out.log = (await c.query('SELECT id, actor_id, action, detail, created_at FROM venue_ballot_log WHERE ballot_id=$1 ORDER BY id DESC LIMIT 100', [b.id])).rows;
  } else if (viewer) {
    out.my_entries = (await c.query('SELECT id, slot_id, bid_cents, status, rank, hold_expires_at, reservation_id FROM venue_ballot_entries WHERE ballot_id=$1 AND user_id=$2 ORDER BY created_at', [b.id, viewer.id])).rows;
  }
  if (!b.draw_seed || !manager) delete out.draw_seed; // the seed is shown to the venue team once drawn, for audit
  return out;
}

cap({
  name: 'get_venue_ballot', method: 'GET', path: '/ballots/:id', tag: TAG, auth: 'public',
  summary: 'A ballot and its slots. The venue team also sees every entry, bid and the audit log; an entrant sees only their own entries (bids are sealed). Drafts are visible to the venue team only.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const b = await ballotOf(i.id);
    if (b.status === 'draft' && !(await canManage(user, b.venue_id))) throw notFound('Ballot');
    return ballotDetail(pool, b, user);
  },
});

// ------------------------------------------------------------------ people entering
cap({
  name: 'list_open_ballots', method: 'GET', path: '/venues/:id/ballots/open', tag: TAG, auth: 'public',
  summary: 'Ballots currently taking bids at a venue, with their slots, floor prices, closing time and how many have entered (never the bids). Signed-in people also see their own entries.',
  input: z.object({ id }),
  async handler({ user }, i) {
    if (!(await one('SELECT 1 FROM venues WHERE id=$1', [i.id]))) throw notFound('Venue');
    const rows = await many("SELECT * FROM venue_ballots WHERE venue_id=$1 AND status='open' AND closes_at > now() ORDER BY closes_at", [i.id]);
    return Promise.all(rows.map((b) => ballotDetail(pool, b, user)));
  },
});

cap({
  name: 'enter_ballot', method: 'POST', path: '/ballot-slots/:id/entries', tag: TAG, status: 201,
  summary: 'Bid for a ballot slot. Nothing is charged now: if you win you get the slot held for you and must accept and pay within the venue\'s pay window. In a random draw the bid is the floor price. Replaying the same idempotency_key returns the same entry. Young people cannot enter themselves — a guardian enters for themselves.',
  input: z.object({ id, bid_cents: z.number().int().min(0).optional().describe('your offer in minor units, at or above the floor price'), idempotency_key: z.string().min(8).max(100).optional() }),
  async handler({ user }, i) {
    if (await isYouth(user.id)) throw forbidden('A guardian needs to enter this ballot — young people cannot bid');
    return tx(async (c) => {
      const slot = (await c.query(`SELECT s.*, b.status AS ballot_status, b.method, b.opens_at, b.closes_at, b.venue_id FROM venue_ballot_slots s JOIN venue_ballots b ON b.id=s.ballot_id WHERE s.id=$1 FOR UPDATE OF s`, [i.id])).rows[0];
      if (!slot || slot.ballot_status !== 'open') throw notFound('Ballot slot');
      if (slot.closes_at <= new Date() || (slot.opens_at && slot.opens_at > new Date())) throw conflict('Bidding is not open');
      if (slot.status !== 'open') throw conflict('That slot is no longer taking bids');
      if (i.idempotency_key) {
        const same = (await c.query('SELECT * FROM venue_ballot_entries WHERE user_id=$1 AND slot_id=$2 AND idempotency_key=$3', [user.id, slot.id, i.idempotency_key])).rows[0];
        if (same) return { ...pub(same), replayed: true };
      }
      const bid = slot.method === 'random_draw' ? slot.floor_cents : i.bid_cents ?? slot.floor_cents;
      if (bid < slot.floor_cents) throw badRequest(`The bid must be at least the floor price (${slot.floor_cents})`, { code: 'below_floor', floor_cents: slot.floor_cents });
      if ((await c.query('SELECT 1 FROM venue_ballot_entries WHERE slot_id=$1 AND user_id=$2 AND status = ANY($3)', [slot.id, user.id, LIVE_ENTRY])).rowCount) throw conflict('You have already entered this slot — change your bid instead');
      const e = (await c.query('INSERT INTO venue_ballot_entries(ballot_id, slot_id, user_id, entered_by, bid_cents, idempotency_key) VALUES ($1,$2,$3,$3,$4,$5) RETURNING *', [slot.ballot_id, slot.id, user.id, bid, i.idempotency_key ?? null])).rows[0];
      return pub(e);
    });
  },
});
const pub = (e) => ({ id: e.id, ballot_id: e.ballot_id, slot_id: e.slot_id, bid_cents: e.bid_cents, status: e.status, rank: e.rank, hold_expires_at: e.hold_expires_at, reservation_id: e.reservation_id, created_at: e.created_at });

cap({
  name: 'update_ballot_bid', method: 'PATCH', path: '/ballot-entries/:id', tag: TAG,
  summary: 'Change your bid while the ballot is still taking bids.', input: z.object({ id, bid_cents: z.number().int().min(0) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = (await c.query(`SELECT e.*, s.floor_cents, s.status AS slot_status, b.status AS ballot_status, b.method, b.closes_at FROM venue_ballot_entries e JOIN venue_ballot_slots s ON s.id=e.slot_id JOIN venue_ballots b ON b.id=e.ballot_id WHERE e.id=$1 AND e.user_id=$2 FOR UPDATE OF e`, [i.id, user.id])).rows[0];
      if (!e) throw notFound('Ballot entry');
      if (e.ballot_status !== 'open' || e.closes_at <= new Date() || e.status !== 'entered') throw conflict('Bids can only be changed while bidding is open');
      if (e.method === 'random_draw') throw conflict('This is a random draw — there is no bid to change');
      if (i.bid_cents < e.floor_cents) throw badRequest(`The bid must be at least the floor price (${e.floor_cents})`, { code: 'below_floor', floor_cents: e.floor_cents });
      return pub((await c.query('UPDATE venue_ballot_entries SET bid_cents=$2, updated_at=now() WHERE id=$1 RETURNING *', [e.id, i.bid_cents])).rows[0]);
    });
  },
});

cap({
  name: 'withdraw_ballot_entry', method: 'DELETE', path: '/ballot-entries/:id', tag: TAG,
  summary: 'Withdraw your entry. If you hold the slot (not yet paid) it passes to the next ranked entrant; an unpaid reservation is cancelled with nothing charged. A paid, confirmed slot is cancelled as a normal booking instead.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = (await c.query('SELECT * FROM venue_ballot_entries WHERE id=$1 AND user_id=$2 FOR UPDATE', [i.id, user.id])).rows[0];
      if (!e) throw notFound('Ballot entry');
      if (['confirmed', 'lost', 'expired', 'withdrawn'].includes(e.status)) throw conflict('This entry is already finished');
      if (['offered', 'awaiting_payment'].includes(e.status)) await releaseEntry(c, e, 'withdrawn', user, 'Withdrawn by the entrant');
      else { await c.query("UPDATE venue_ballot_entries SET status='withdrawn', updated_at=now() WHERE id=$1", [e.id]); await logBallot(c, e.ballot_id, user.id, 'withdrawn', { entry_id: e.id }); }
      return { ok: true };
    });
  },
});

cap({
  name: 'list_my_ballot_entries', method: 'GET', path: '/me/ballot-entries', tag: TAG,
  summary: 'Your ballot entries with venue, slot, status, queue position once drawn, and when a held offer expires.', input: z.object({ include_done: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    return many(
      `SELECT e.id, e.ballot_id, e.slot_id, e.bid_cents, e.status, e.rank, e.hold_expires_at, e.reservation_id, e.created_at,
              b.title, b.status AS ballot_status, b.closes_at, b.method, b.mode, b.currency, b.pay_window_minutes, s.starts_at, s.ends_at, s.floor_cents, s.status AS slot_status,
              r.name AS resource_name, v.id AS venue_id, v.name AS venue_name, v.timezone
         FROM venue_ballot_entries e JOIN venue_ballots b ON b.id=e.ballot_id JOIN venue_ballot_slots s ON s.id=e.slot_id JOIN resources r ON r.id=s.resource_id JOIN venues v ON v.id=b.venue_id
        WHERE e.user_id=$1 AND ($2 OR e.status IN ('entered','ranked','offered','awaiting_payment')) ORDER BY (e.status IN ('offered','awaiting_payment')) DESC, s.starts_at LIMIT 100`, [user.id, i.include_done]);
  },
});

cap({
  name: 'accept_ballot_offer', method: 'POST', path: '/ballot-entries/:id/accept', tag: TAG, status: 201,
  summary: 'Accept a slot you won. A reservation is placed at your bid through the normal booking engine; pay its invoice (create_payment, purpose venue_invoice) before the hold ends to confirm the slot. At a pay-at-venue venue it is confirmed straight away.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = (await c.query('SELECT * FROM venue_ballot_entries WHERE id=$1 AND user_id=$2', [i.id, user.id])).rows[0];
      if (!e) throw notFound('Ballot entry');
      if (e.status === 'awaiting_payment' && e.reservation_id) return { entry_id: e.id, status: e.status, reservation: await reservationView(c, e.reservation_id, user), replayed: true };
      const reservationId = await acceptOffer(c, user, e);
      const now = (await c.query('SELECT status, hold_expires_at FROM venue_ballot_entries WHERE id=$1', [e.id])).rows[0];
      return { entry_id: e.id, status: now.status, hold_expires_at: now.hold_expires_at, reservation: await reservationView(c, reservationId, user) };
    });
  },
});
