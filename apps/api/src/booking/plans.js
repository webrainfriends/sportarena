// Memberships and multi-session passes: activate on payment, give sessions back when what they paid is voided or refunded, expire.
import { query, tx } from '../db.js';
import { notify } from '../notify.js';
import { toMajor } from '../currency.js';

/** Payment confirmed: the plan starts. A renewal starts when the current membership ends. */
export async function activateUserPlan(c, id) {
  const p = (await c.query("SELECT * FROM user_plans WHERE id=$1 AND status='awaiting_payment' FOR UPDATE", [id])).rows[0];
  if (!p) return false;
  const queued = p.kind === 'membership'
    ? (await c.query("SELECT max(expires_at) AS e FROM user_plans WHERE user_id=$1 AND venue_id=$2 AND kind='membership' AND status='active' AND expires_at > now()", [p.user_id, p.venue_id])).rows[0].e
    : null;
  const u = (await c.query(
    `UPDATE user_plans SET status='active', starts_at = coalesce($2::timestamptz, now()), expires_at = coalesce($2::timestamptz, now()) + make_interval(days => duration_days) WHERE id=$1 RETURNING starts_at, expires_at`, [id, queued])).rows[0];
  const v = (await c.query('SELECT id, name FROM venues WHERE id=$1', [p.venue_id])).rows[0];
  await notify(c, p.user_id, {
    kind: 'plan_active', title: `${p.name} is active ✓`,
    body: p.kind === 'membership' ? `${p.discount_bp / 100}% off every booking at ${v.name} until ${u.expires_at.toISOString().slice(0, 10)}.` : `${p.sessions_total} sessions at ${v.name}, use them by ${u.expires_at.toISOString().slice(0, 10)}. Pay for a booking with "Use pass".`,
    data: { venue_id: v.id } });
  return true;
}

/** Sessions that paid an invoice come back (invoice voided / shrunk / refunded). `give` of `amount` cents were returned. */
export async function restoreSessions(c, credit, give) {
  if (!credit.user_plan_id) return;
  const upto = (cents) => Math.floor((credit.units * cents) / credit.amount_cents); // sessions that `cents` of the credit represents
  const back = upto(credit.returned_cents + give) - upto(credit.returned_cents);
  if (back <= 0) return;
  // an expired pass is given a week of grace so the returned sessions are usable
  await c.query(
    `UPDATE user_plans SET sessions_left = least(sessions_total, sessions_left + $2), status = 'active', expires_at = greatest(expires_at, now() + interval '7 days') WHERE id=$1 AND status IN ('active','used_up','expired')`, [credit.user_plan_id, back]);
}

/** Mark ended memberships/passes. Returns how many ended. */
export async function expireUserPlans() {
  const { rowCount } = await query("UPDATE user_plans SET status='expired' WHERE status IN ('active','used_up') AND expires_at <= now()");
  return rowCount;
}

export const memberDiscountBp = async (c, userId, venueId) => Number((await c.query(
  "SELECT coalesce(max(discount_bp),0) AS bp FROM user_plans WHERE user_id=$1 AND venue_id=$2 AND kind='membership' AND status='active' AND starts_at <= now() AND expires_at > now()", [userId, venueId])).rows[0].bp);

export const money = (cents, cur) => `${cur} ${toMajor(cents, cur)}`;

/**
 * Subscriptions: a membership sold with auto_renew gets its next period raised a week before it ends, at the plan's current
 * price, waiting for payment (nobody is charged automatically). The member is told once and pays it like any plan; it starts
 * when the current one ends. Skipped when the venue stopped selling the plan. Returns how many renewals were raised.
 */
export async function raiseSubscriptionRenewals({ limit = 100 } = {}) {
  return tx(async (c) => {
    const { rows } = await c.query(
      `SELECT up.*, p.price_cents AS new_price, p.active AS on_sale, p.duration_days AS new_days, p.discount_bp AS new_discount, v.name AS venue_name, v.currency AS venue_currency
         FROM user_plans up JOIN venue_plans p ON p.id=up.plan_id JOIN venues v ON v.id=up.venue_id
        WHERE up.kind='membership' AND up.auto_renew AND up.status='active' AND up.expires_at > now() AND up.expires_at <= now() + interval '7 days'
          AND NOT EXISTS (SELECT 1 FROM user_plans nx WHERE nx.renews_id=up.id)
          AND NOT EXISTS (SELECT 1 FROM user_plans o WHERE o.user_id=up.user_id AND o.venue_id=up.venue_id AND o.kind='membership' AND o.id<>up.id AND (o.status='awaiting_payment' OR (o.status='active' AND o.expires_at > up.expires_at)))
        ORDER BY up.expires_at LIMIT $1 FOR UPDATE OF up SKIP LOCKED`, [limit]);
    let n = 0;
    for (const up of rows) {
      if (!up.on_sale || up.venue_currency !== up.currency) continue;
      const nx = (await c.query(
        `INSERT INTO user_plans(plan_id, venue_id, user_id, kind, name, price_cents, currency, discount_bp, duration_days, resource_ids, includes, auto_renew, renews_id)
         VALUES ($1,$2,$3,'membership',$4,$5,$6,$7,$8,$9,$10,true,$11) RETURNING id`,
        [up.plan_id, up.venue_id, up.user_id, up.name, up.new_price, up.currency, up.new_discount, up.new_days, up.resource_ids, up.includes, up.id])).rows[0];
      await notify(c, up.user_id, {
        kind: 'plan_renewal', title: `Renew ${up.name}`, dedupe_key: `plan_renewal:${up.id}`,
        body: `Your ${up.name} at ${up.venue_name} ends on ${up.expires_at.toISOString().slice(0, 10)}. Renewal: ${money(up.new_price, up.currency)} — pay it to keep your ${up.discount_bp / 100}% off without a gap.`,
        data: { venue_id: up.venue_id, user_plan_id: nx.id } });
      n++;
    }
    return n;
  });
}
