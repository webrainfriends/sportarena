// Venue slot balloting. A ballot is a front door to the booking engine, not a second booking system: a slot in a live ballot is HELD
// (usedUnits / loadBusy count it as taken for everyone else), the winner is offered it, and it only becomes a real reservation
// (createReservation, the normal invoice and payment) when the winner accepts. Unpaid or unclaimed, it passes to the next ranked entrant.
//   entry:  entered -> ranked -> offered -> awaiting_payment -> confirmed   (or lost / expired / withdrawn)
//   slot:   open -> offered -> awaiting_payment -> confirmed                (or unfilled / cancelled)
//   ballot: draft -> open -> closed -> drawn -> settled                     (or cancelled)
import { many, tx } from '../db.js';
import { logger } from '../logger.js';
import { notify } from '../notify.js';
import { conflict } from '../errors.js';
import { rngFor, shuffled, newDrawSeed } from '../tournament/formats/rng.js';
import { lockResources, createReservation, cancelBookings } from './engine.js';
import { paidHooks } from './invoices.js';

export const LIVE_ENTRY = ['entered', 'ranked', 'offered', 'awaiting_payment', 'confirmed'];

export const logBallot = (c, ballotId, actorId, action, detail = {}) =>
  c.query('INSERT INTO venue_ballot_log(ballot_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)', [ballotId, actorId ?? null, action, detail]);

const when = (d, tz) => d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz });

async function slotContext(c, slotId) {
  return (await c.query(
    `SELECT s.*, b.venue_id, b.title, b.pay_window_minutes, b.method, b.mode, b.status AS ballot_status, b.currency, r.name AS resource_name, v.name AS venue_name, v.timezone
       FROM venue_ballot_slots s JOIN venue_ballots b ON b.id=s.ballot_id JOIN resources r ON r.id=s.resource_id JOIN venues v ON v.id=b.venue_id WHERE s.id=$1`, [slotId])).rows[0];
}

/** Rank the live entries of one slot: highest bid first (ties by a seeded shuffle) or a pure random draw. Reproducible from the stored seed. */
export function rankEntries(entries, method, seed) {
  const rng = rngFor(seed);
  const order = shuffled(entries, rng);
  return method === 'highest_bid' ? order.sort((a, b) => b.bid_cents - a.bid_cents) : order; // Array.sort is stable: shuffled order breaks ties
}

/** Hold the slot for this entrant until they pay (their pay window starts now). */
export async function offerSlot(c, slot, entry, actorId, via) {
  const exp = (await c.query("UPDATE venue_ballot_entries SET status='offered', hold_expires_at=now() + make_interval(mins => $2), updated_at=now() WHERE id=$1 RETURNING hold_expires_at", [entry.id, slot.pay_window_minutes])).rows[0].hold_expires_at;
  await c.query("UPDATE venue_ballot_slots SET status='offered', holder_user_id=$2, winner_entry_id=$3 WHERE id=$1", [slot.id, entry.user_id, entry.id]);
  await logBallot(c, slot.ballot_id, actorId, 'offered', { slot_id: slot.id, entry_id: entry.id, via });
  await notify(c, entry.user_id, {
    kind: 'ballot_offer', title: `You won a slot at ${slot.venue_name}!`,
    body: `${slot.resource_name}, ${when(slot.starts_at, slot.timezone)}. It is held for you until ${when(exp, slot.timezone)} — accept and pay to confirm it.`,
    data: { ballot_id: slot.ballot_id, slot_id: slot.id, entry_id: entry.id, venue_id: slot.venue_id, expires_at: exp }, dedupe_key: `ballot_offer:${entry.id}`, comm: { essential: true },
  });
  return exp;
}

/** The next ranked entrant gets the slot; with nobody left it is released as unfilled (and becomes bookable again). */
export async function offerNext(c, slotId, actorId, via = 'promotion') {
  const slot = await slotContext(c, slotId);
  if (!slot || ['confirmed', 'cancelled'].includes(slot.status)) return null;
  await lockResources(c, [slot.resource_id]);
  const next = (await c.query("SELECT * FROM venue_ballot_entries WHERE slot_id=$1 AND status='ranked' ORDER BY rank LIMIT 1 FOR UPDATE", [slotId])).rows[0];
  if (!next) {
    await c.query("UPDATE venue_ballot_slots SET status='unfilled', holder_user_id=NULL WHERE id=$1", [slotId]);
    await logBallot(c, slot.ballot_id, actorId, 'unfilled', { slot_id: slotId });
    await settleIfDone(c, slot.ballot_id);
    return null;
  }
  await offerSlot(c, slot, next, actorId, via);
  return next;
}

/** Rank every slot of a ballot; in auto mode also offer each slot to its top entrant. Manual ballots stop after ranking (the venue picks). */
export async function drawBallot(c, ballot, actorId) {
  await lockResources(c, (await c.query('SELECT DISTINCT resource_id FROM venue_ballot_slots WHERE ballot_id=$1', [ballot.id])).rows.map((r) => r.resource_id));
  const seed = ballot.draw_seed ?? newDrawSeed();
  const slots = (await c.query("SELECT id FROM venue_ballot_slots WHERE ballot_id=$1 AND status='open' ORDER BY starts_at, id", [ballot.id])).rows;
  let offered = 0, unfilled = 0;
  for (const { id } of slots) {
    const entries = (await c.query("SELECT * FROM venue_ballot_entries WHERE slot_id=$1 AND status='entered' ORDER BY created_at, id", [id])).rows;
    const ranked = rankEntries(entries, ballot.method, `${seed}:${id}`);
    for (const [i, e] of ranked.entries()) await c.query("UPDATE venue_ballot_entries SET status='ranked', rank=$2, updated_at=now() WHERE id=$1", [e.id, i + 1]);
    if (ballot.mode !== 'auto') continue;
    if (await offerNext(c, id, actorId, 'draw')) offered++; else unfilled++;
  }
  await c.query("UPDATE venue_ballots SET status='drawn', draw_seed=$2, drawn_at=now(), updated_at=now(), row_version=row_version+1 WHERE id=$1", [ballot.id, seed]);
  await logBallot(c, ballot.id, actorId, 'drawn', { seed, method: ballot.method, mode: ballot.mode, slots: slots.length, offered, unfilled });
  await settleIfDone(c, ballot.id);
  return { seed, slots: slots.length, offered, unfilled };
}

/** The winner accepts: a real reservation is placed through the normal engine, so price rules, tax, invoice and payment all apply. */
export async function acceptOffer(c, user, entry) {
  const slot = await slotContext(c, entry.slot_id);
  await lockResources(c, [slot.resource_id]);
  const fresh = (await c.query('SELECT * FROM venue_ballot_entries WHERE id=$1 FOR UPDATE', [entry.id])).rows[0];
  if (fresh.status !== 'offered' || fresh.hold_expires_at <= new Date()) throw conflict('That offer is no longer open');
  const placed = await createReservation(c, { user, items: [{ resource_id: slot.resource_id, starts_at: slot.starts_at, ends_at: slot.ends_at, quantity: slot.quantity }], prices: [fresh.bid_cents], source: 'user', note: `Ballot: ${slot.title}` });
  if (placed.payment_deadline && placed.payment_deadline < fresh.hold_expires_at) await c.query('UPDATE reservations SET payment_deadline=$2 WHERE id=$1', [placed.reservationId, fresh.hold_expires_at]);
  await c.query("UPDATE venue_ballot_entries SET status='awaiting_payment', reservation_id=$2, updated_at=now() WHERE id=$1", [fresh.id, placed.reservationId]);
  await c.query("UPDATE venue_ballot_slots SET status='awaiting_payment' WHERE id=$1", [slot.id]);
  await logBallot(c, slot.ballot_id, user.id, 'accepted', { slot_id: slot.id, entry_id: fresh.id, reservation_id: placed.reservationId });
  // nothing to wait for when the venue is paid at the venue: the slot is confirmed now
  if (!placed.payment_deadline) await confirmEntry(c, fresh.id);
  return placed.reservationId;
}

/** Payment is in (or not needed): confirm the winner, tell everyone else they lost. Idempotent. */
export async function confirmEntry(c, entryId) {
  const e = (await c.query("UPDATE venue_ballot_entries SET status='confirmed', hold_expires_at=NULL, updated_at=now() WHERE id=$1 AND status IN ('awaiting_payment','offered') RETURNING *", [entryId])).rows[0];
  if (!e) return false;
  const slot = await slotContext(c, e.slot_id);
  await c.query("UPDATE venue_ballot_slots SET status='confirmed', holder_user_id=$2, winner_entry_id=$3 WHERE id=$1", [slot.id, e.user_id, e.id]);
  await logBallot(c, slot.ballot_id, null, 'confirmed', { slot_id: slot.id, entry_id: e.id });
  await notify(c, e.user_id, { kind: 'ballot_confirmed', title: `Slot confirmed at ${slot.venue_name}`, body: `${slot.resource_name}, ${when(slot.starts_at, slot.timezone)} is yours.`, data: { ballot_id: slot.ballot_id, slot_id: slot.id, reservation_id: e.reservation_id, venue_id: slot.venue_id }, dedupe_key: `ballot_confirmed:${e.id}` });
  const losers = (await c.query("UPDATE venue_ballot_entries SET status='lost', updated_at=now() WHERE slot_id=$1 AND id <> $2 AND status IN ('entered','ranked') RETURNING id, user_id", [slot.id, e.id])).rows;
  for (const l of losers) {
    await notify(c, l.user_id, { kind: 'ballot_lost', title: `Not this time at ${slot.venue_name}`, body: `${slot.resource_name}, ${when(slot.starts_at, slot.timezone)} went to another entrant.`, data: { ballot_id: slot.ballot_id, slot_id: slot.id, venue_id: slot.venue_id }, dedupe_key: `ballot_lost:${l.id}` });
  }
  await settleIfDone(c, slot.ballot_id);
  return true;
}

/** Give up a held or awaiting-payment slot (the entrant withdrew, the hold ran out, or the venue released it) and pass it on. */
export async function releaseEntry(c, entry, status, actor, reason) {
  const slot = await slotContext(c, entry.slot_id);
  await lockResources(c, [slot.resource_id]);
  if (entry.reservation_id) {
    const ids = (await c.query("SELECT id FROM bookings WHERE reservation_id=$1 AND status='confirmed'", [entry.reservation_id])).rows.map((r) => r.id);
    if (ids.length) await cancelBookings(c, ids, { actor: actor ?? { id: entry.user_id }, byVenue: false, waive: true, silent: true, reason: reason ?? 'Ballot slot released' });
  }
  await c.query('UPDATE venue_ballot_entries SET status=$2, hold_expires_at=NULL, updated_at=now() WHERE id=$1', [entry.id, status]);
  await logBallot(c, slot.ballot_id, actor?.id ?? null, status, { slot_id: slot.id, entry_id: entry.id, reason: reason ?? null });
  if (['offered', 'awaiting_payment'].includes(slot.status) && slot.winner_entry_id === entry.id) {
    await c.query("UPDATE venue_ballot_slots SET status='open', holder_user_id=NULL, winner_entry_id=NULL WHERE id=$1", [slot.id]);
    // auto ballots pass the slot to the next ranked entrant; in a manual ballot the venue picks again
    if (['closed', 'drawn'].includes(slot.ballot_status) && slot.mode === 'auto') await offerNext(c, slot.id, actor?.id ?? null, 'promotion');
  }
}

/** A drawn ballot is settled once every slot has an outcome. */
export async function settleIfDone(c, ballotId) {
  const open = (await c.query("SELECT 1 FROM venue_ballot_slots WHERE ballot_id=$1 AND status IN ('open','offered','awaiting_payment') LIMIT 1", [ballotId])).rowCount;
  if (open) return false;
  const r = await c.query("UPDATE venue_ballots SET status='settled', updated_at=now(), row_version=row_version+1 WHERE id=$1 AND status='drawn'", [ballotId]);
  if (r.rowCount) await logBallot(c, ballotId, null, 'settled');
  return r.rowCount > 0;
}

// payment of the reservation invoice is the moment the slot is really allocated
paidHooks.push(async (c, inv) => {
  const open = (await c.query("SELECT 1 FROM invoices WHERE reservation_id=$1 AND kind='invoice' AND status='open'", [inv.reservation_id])).rowCount;
  if (open) return;
  const e = (await c.query("SELECT id FROM venue_ballot_entries WHERE reservation_id=$1 AND status='awaiting_payment'", [inv.reservation_id])).rows[0];
  if (e) await confirmEntry(c, e.id);
});

/** Worker sweep: close ballots past their deadline (auto ones are drawn), expire unclaimed offers, reconcile payments, pass slots on. */
export async function processBallots() {
  const out = { closed: 0, drawn: 0, expired: 0, confirmed: 0 };
  const each = async (rows, fn) => { for (const r of rows) { try { await tx((c) => fn(c, r)); } catch (e) { logger.error('ballot sweep failed', { id: r.id, error: String(e.message).slice(0, 300) }); } } };
  await each(await many("SELECT id FROM venue_ballots WHERE status='open' AND closes_at <= now() ORDER BY closes_at LIMIT 50"), async (c, r) => {
    const b = (await c.query("SELECT * FROM venue_ballots WHERE id=$1 AND status='open' FOR UPDATE", [r.id])).rows[0];
    if (!b || b.closes_at > new Date()) return;
    await c.query("UPDATE venue_ballots SET status='closed', updated_at=now(), row_version=row_version+1 WHERE id=$1", [b.id]);
    await logBallot(c, b.id, null, 'closed', { by: 'deadline' });
    out.closed++;
    if (b.mode === 'auto') { await drawBallot(c, { ...b, status: 'closed' }, null); out.drawn++; }
  });
  await each(await many("SELECT * FROM venue_ballot_entries WHERE status='offered' AND hold_expires_at <= now() ORDER BY hold_expires_at LIMIT 100"), async (c, e) => {
    const cur = (await c.query("SELECT * FROM venue_ballot_entries WHERE id=$1 AND status='offered' FOR UPDATE", [e.id])).rows[0];
    if (!cur || cur.hold_expires_at > new Date()) return;
    await releaseEntry(c, cur, 'expired', null, 'Offer not accepted in time');
    const slot = await slotContext(c, cur.slot_id);
    await notify(c, cur.user_id, { kind: 'ballot_expired', title: 'Your ballot offer expired', body: `You didn't accept ${slot.resource_name} at ${slot.venue_name} in time, so it went to the next entrant.`, data: { ballot_id: slot.ballot_id, venue_id: slot.venue_id }, dedupe_key: `ballot_expired:${cur.id}` });
    out.expired++;
  });
  // winners who accepted but never paid: the venue's own hold sweep cancels the unpaid booking, the ballot then passes the slot on
  await each(await many(
    `SELECT e.* FROM venue_ballot_entries e JOIN reservations r ON r.id=e.reservation_id
      WHERE e.status='awaiting_payment' AND (r.status='cancelled' OR NOT EXISTS (SELECT 1 FROM bookings b WHERE b.reservation_id=r.id AND b.status='confirmed')
         OR NOT EXISTS (SELECT 1 FROM invoices i WHERE i.reservation_id=r.id AND i.kind='invoice' AND i.status='open')) LIMIT 100`), async (c, e) => {
    const cur = (await c.query("SELECT * FROM venue_ballot_entries WHERE id=$1 AND status='awaiting_payment' FOR UPDATE", [e.id])).rows[0];
    if (!cur) return;
    const live = (await c.query("SELECT 1 FROM bookings WHERE reservation_id=$1 AND status='confirmed'", [cur.reservation_id])).rowCount;
    if (live) { if (await confirmEntry(c, cur.id)) out.confirmed++; return; } // paid (or settled at the venue) but the hook missed it
    await releaseEntry(c, cur, 'expired', null, 'Payment not completed in time');
    const slot = await slotContext(c, cur.slot_id);
    await notify(c, cur.user_id, { kind: 'ballot_expired', title: 'Your ballot slot was released', body: `Payment for ${slot.resource_name} at ${slot.venue_name} wasn't completed in time, so it went to the next entrant. Nothing was charged.`, data: { ballot_id: slot.ballot_id, venue_id: slot.venue_id }, dedupe_key: `ballot_expired:${cur.id}` });
    out.expired++;
  });
  await each(await many("SELECT id FROM venue_ballots WHERE status='drawn' LIMIT 100"), (c, b) => settleIfDone(c, b.id));
  return out;
}
