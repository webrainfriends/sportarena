// Spending points on canonical bills. A redemption takes points from the member's lots and applies them to the bill in the same transaction,
// under the bill's own row lock (the one a card checkout takes), so it can never race a payment. Cancellations put points back under the
// programme's published restore policy. Adapters know how each kind of bill records a credit; the engine knows nothing about payment providers.
import { randomUUID } from 'node:crypto';
import { conflict, forbidden, notFound } from '../errors.js';
import { loadProgramme, redeemable, eligible, balanceOf, draw, openLot, lockMember } from './ledger.js';
import { inScope } from './activity.js';
import { lockPayableInvoice } from '../booking/credits.js';
import { markInvoicePaid } from '../booking/invoices.js';
import { syncChargeInvoice, fulfilChargePaid } from '../academy-invoices.js';
import { config } from '../config.js';

const pointsOnPurpose = async (c, purposeType, purposeId) => Number((await c.query('SELECT coalesce(sum(points - restored),0) AS n FROM loyalty_redemptions WHERE purpose_type=$1 AND purpose_id=$2', [purposeType, purposeId])).rows[0].n);

const ADAPTERS = {
  async venue_invoice(c, user, id) {
    const { inv, due } = await lockPayableInvoice(c, user, id);
    const v = (await c.query('SELECT organisation_id FROM venues WHERE id=$1', [inv.venue_id])).rows[0];
    return {
      currency: inv.currency, total: inv.total_cents, due, scope: { venueId: inv.venue_id, organisationId: v?.organisation_id ?? null },
      async apply(c2, redemption, taken) {
        await c2.query("INSERT INTO invoice_credits(invoice_id, user_id, source, amount_cents, redemption_id) VALUES ($1,$2,'points',$3,$4)", [inv.id, user.id, taken, redemption]);
        await c2.query('UPDATE invoices SET credits_cents = credits_cents + $2 WHERE id=$1', [inv.id, taken]);
        const paid = taken === due ? await markInvoicePaid(c2, inv.id, { method: 'points', by: user.id }) : false;
        return { paid, due_after: due - taken, currency: inv.currency };
      },
    };
  },
  async academy_charge(c, user, id) {
    const ch = (await c.query('SELECT * FROM academy_charges WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!ch) throw notFound('Charge');
    if (ch.payer_id !== user.id) throw forbidden('This is not your charge');
    if (ch.status !== 'awaiting_payment') throw conflict('That charge is not open');
    const inv = await syncChargeInvoice(c, id);
    if (!inv) throw conflict('Nothing left to pay');
    const due = Number(inv.total_cents) - Number(inv.credits_cents);
    if (due <= 0) throw conflict('Nothing left to pay');
    if ((await c.query("SELECT 1 FROM payments WHERE purpose_type='academy_charge' AND purpose_id=$1 AND status='pending' AND provider_ref IS NOT NULL AND created_at > now() - interval '30 minutes'", [id])).rowCount)
      throw conflict('A card checkout for this charge is in progress — finish it, or try again in half an hour');
    return {
      currency: ch.currency, total: Number(inv.total_cents), due, scope: { organisationId: ch.organisation_id },
      async apply(c2, redemption, taken) {
        await c2.query("INSERT INTO invoice_credits(invoice_id, user_id, source, amount_cents, redemption_id) VALUES ($1,$2,'points',$3,$4)", [inv.id, user.id, taken, redemption]);
        await c2.query('UPDATE invoices SET credits_cents = credits_cents + $2 WHERE id=$1', [inv.id, taken]);
        const paid = taken === due ? await fulfilChargePaid(c2, id, { method: 'points' }) : false;
        return { paid, due_after: due - taken, currency: ch.currency };
      },
    };
  },
  async coach_hire(c, user, id) {
    const h = (await c.query('SELECT * FROM coach_hires WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!h) throw notFound('Session');
    if (h.hirer_id !== user.id) throw forbidden('This is not your session');
    if (h.payment_status !== 'unpaid' || h.status === 'cancelled' || h.status === 'completed') throw conflict('That session is not open for payment');
    const due = Number(h.total_cents) - Number(h.loyalty_credit_cents);
    if (due <= 0) throw conflict('Nothing left to pay');
    if ((await c.query("SELECT 1 FROM payments WHERE purpose_type='coach_hire' AND purpose_id=$1 AND status='pending' AND provider_ref IS NOT NULL AND created_at > now() - interval '30 minutes'", [id])).rowCount)
      throw conflict('A card checkout for this session is in progress — finish it, or try again in half an hour');
    return {
      currency: config.payments.currency, total: Number(h.total_cents), due, scope: { coachId: h.coach_id, eventId: h.event_id ?? null },
      async apply(c2, _redemption, taken) {
        await c2.query('UPDATE coach_hires SET loyalty_credit_cents = loyalty_credit_cents + $2 WHERE id=$1', [id, taken]);
        let paid = false;
        if (taken === due) {
          paid = !!(await c2.query("UPDATE coach_hires SET payment_status='paid', status=CASE WHEN request_response_id IS NOT NULL AND status='requested' THEN 'confirmed' ELSE status END WHERE id=$1 AND payment_status='unpaid' AND status IN ('requested','confirmed') RETURNING id", [id])).rowCount;
        }
        return { paid, due_after: due - taken, currency: config.payments.currency };
      },
    };
  },
};
export const REDEEMABLE_PURPOSES = Object.keys(ADAPTERS);

/** What `user` could spend on this bill from this programme right now (for the checkout screen). Read-only. */
export async function quote(c, user, { programmeId, purposeType, purposeId }) {
  const p = await loadProgramme(c, programmeId);
  if (!redeemable(p) || !p.rules.redeem.purposes.includes(purposeType)) return { usable: 0, reason: 'not_redeemable_here' };
  const ad = await ADAPTERS[purposeType](c, user, purposeId);
  if (!inScope(p, ad.scope) || p.currency !== ad.currency) return { usable: 0, reason: 'not_redeemable_here' };
  const have = await balanceOf(c, p.id, user.id);
  const room = Math.floor((ad.total * p.rules.redeem.max_redeem_bp) / 10000) - await pointsOnPurpose(c, purposeType, purposeId);
  return { usable: Math.max(0, Math.min(ad.due, have, room)), balance: have, due: ad.due, currency: ad.currency, max_redeem_bp: p.rules.redeem.max_redeem_bp };
}

export async function redeem(c, user, { programmeId, purposeType, purposeId, points, requestKey }) {
  if (!ADAPTERS[purposeType]) throw conflict('Points cannot be spent on that');
  if (requestKey) {
    const again = (await c.query('SELECT * FROM loyalty_redemptions WHERE request_key=$1 AND user_id=$2', [`${user.id}:${requestKey}`, user.id])).rows[0];
    if (again) return { redemption_id: again.id, points_used: again.points, replayed: true };
  }
  const p = await loadProgramme(c, programmeId);
  if (!p) throw notFound('Programme');
  if (!redeemable(p)) throw conflict('That programme is not open for spending');
  if (!p.rules.redeem.purposes.includes(purposeType)) throw conflict('That programme cannot be spent on this kind of payment');
  const ad = await ADAPTERS[purposeType](c, user, purposeId);              // locks the bill
  if (!inScope(p, ad.scope)) throw conflict('Those points cannot be spent here');
  if (p.currency !== ad.currency) throw conflict('Those points are in another currency');
  const why = await eligible(c, p, user.id);
  if (why) throw forbidden('Your account cannot spend these points');
  await lockMember(c, p.id, user.id);
  const have = await balanceOf(c, p.id, user.id);
  if (have <= 0) throw conflict('You have no points in this programme');
  const room = Math.floor((ad.total * p.rules.redeem.max_redeem_bp) / 10000) - await pointsOnPurpose(c, purposeType, purposeId);
  const use = Math.min(ad.due, have, room, points ?? Infinity);
  if (use < p.rules.redeem.min_points || use <= 0) throw conflict(room <= 0 ? `Points can pay at most ${p.rules.redeem.max_redeem_bp / 100}% of one bill` : `The smallest redemption is ${p.rules.redeem.min_points} points`);
  const id = randomUUID();
  const out = await draw(c, { programmeId: p.id, userId: user.id, points: use, kind: 'redeem', key: `redeem:${id}`, sourceType: purposeType, sourceId: purposeId, reason: 'Spent on a payment', version: p.version });
  if (out.taken <= 0) throw conflict('Those points are no longer available');
  await c.query('INSERT INTO loyalty_redemptions(id, programme_id, user_id, purpose_type, purpose_id, points, version, restore_policy, request_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, p.id, user.id, purposeType, purposeId, out.taken, p.version, JSON.stringify({ restore_on_cancel: p.rules.redeem.restore_on_cancel, restore_expiry: p.rules.redeem.restore_expiry, expiry_months: p.rules.expiry_months }), requestKey ? `${user.id}:${requestKey}` : null]);
  const applied = await ad.apply(c, id, out.taken);
  return { redemption_id: id, programme_id: p.id, points_used: out.taken, value_minor: out.taken, ...applied, balance_after: have - out.taken };
}

/**
 * Put points back after a cancellation or refund. `upTo` is the cumulative number of points that should be back by now (omit for all of them).
 * Policy 'none' keeps the points spent; 'full' returns them. Each restored lot keeps the original expiry or gets a fresh one, per the policy snapshot.
 * Deterministic and idempotent: the restored counter on the redemption (locked here) decides what is still owed back.
 */
export async function restoreRedemption(c, redemptionId, { upTo, reason } = {}) {
  const r = (await c.query('SELECT * FROM loyalty_redemptions WHERE id=$1 FOR UPDATE', [redemptionId])).rows[0];
  if (!r || r.restore_policy.restore_on_cancel === 'none') return 0;
  const target = Math.min(r.points, upTo ?? r.points);
  let left = target - r.restored, put = 0;
  if (left <= 0) return 0;
  await lockMember(c, r.programme_id, r.user_id);
  const used = (await c.query("SELECT d.delta, d.lot_id, l.expires_at FROM loyalty_ledger d JOIN loyalty_ledger l ON l.id=d.lot_id WHERE starts_with(d.idempotency_key, $1) AND d.kind='redeem' ORDER BY d.seq", [`redeem:${r.id}:`])).rows;
  for (const row of used) {
    if (left <= 0) break;
    const take = Math.min(left, -row.delta);
    const original = new Date(Math.max(new Date(row.expires_at).getTime(), Date.now() + 30 * 86_400_000));
    const fresh = new Date(); fresh.setUTCMonth(fresh.getUTCMonth() + r.restore_policy.expiry_months);
    const lot = await openLot(c, { programmeId: r.programme_id, userId: r.user_id, kind: 'restore', points: take, expiresAt: r.restore_policy.restore_expiry === 'original' ? original : fresh, version: r.version, sourceType: r.purpose_type, sourceId: r.purpose_id, key: `restore:${r.id}:${r.restored + put}`, reason: reason ?? 'Payment cancelled', fundingOwner: (await c.query('SELECT funding_owner FROM loyalty_programmes WHERE id=$1', [r.programme_id])).rows[0].funding_owner });
    if (lot) { put += take; left -= take; }
  }
  if (put > 0) await c.query('UPDATE loyalty_redemptions SET restored = restored + $2 WHERE id=$1', [r.id, put]);
  return put;
}

/** Restore every redemption on a bill (cancelled before payment, or refunded): all of it, or a share when only part of the bill is refunded. */
export async function restoreForPurpose(c, purposeType, purposeId, { fraction, reason } = {}) {
  const { rows } = await c.query('SELECT id FROM loyalty_redemptions WHERE purpose_type=$1 AND purpose_id=$2 AND restored < points ORDER BY created_at', [purposeType, purposeId]);
  let n = 0;
  for (const r of rows) {
    const p = (await c.query('SELECT points FROM loyalty_redemptions WHERE id=$1', [r.id])).rows[0].points;
    n += await restoreRedemption(c, r.id, { upTo: fraction && fraction.den > 0 ? Math.floor((p * Math.min(fraction.num, fraction.den)) / fraction.den) : undefined, reason });
  }
  return n;
}
