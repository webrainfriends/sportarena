// Memberships and multi-session passes: activate on payment, give sessions back when what they paid is voided or refunded, expire.
import { query, tx } from '../db.js';
import { notify } from '../notify.js';
import { toMajor } from '../currency.js';

/** Payment confirmed: the plan starts. A renewal starts when the current membership ends. */
export async function activateUserPlan(c, id) {
  const p = (await c.query("SELECT * FROM user_plans WHERE id=$1 AND status='awaiting_payment' FOR UPDATE", [id])).rows[0];
  if (!p) return false;
  // a renewal starts when the current membership ends (same venue, or same enrolment for an academy plan)
  const queued = p.kind === 'membership'
    ? (await c.query(
      `SELECT max(expires_at) AS e FROM user_plans WHERE user_id=$1 AND kind='membership' AND status='active' AND expires_at > now()
          AND (($2::uuid IS NOT NULL AND venue_id=$2) OR ($3::uuid IS NOT NULL AND enrolment_id=$3))`, [p.user_id, p.venue_id, p.enrolment_id])).rows[0].e
    : null;
  const u = (await c.query(
    `UPDATE user_plans SET status='active', starts_at = coalesce($2::timestamptz, now()),
            expires_at = coalesce($2::timestamptz, now()) + CASE WHEN duration_months IS NOT NULL THEN make_interval(months => duration_months) ELSE make_interval(days => duration_days) END
      WHERE id=$1 RETURNING starts_at, expires_at`, [id, queued])).rows[0];
  const place = p.venue_id ? (await c.query('SELECT id, name FROM venues WHERE id=$1', [p.venue_id])).rows[0] : (await c.query('SELECT id, name FROM organisations WHERE id=$1', [p.organisation_id])).rows[0];
  const until = u.expires_at.toISOString().slice(0, 10);
  await notify(c, p.user_id, {
    kind: 'plan_active', title: `${p.name} is active ✓`,
    body: p.kind === 'membership' ? (p.discount_bp ? `${p.discount_bp / 100}% off every booking at ${place.name} until ${until}.` : `Active at ${place.name} until ${until}.`) : `${p.sessions_total} sessions at ${place.name}, use them by ${until}.`,
    data: p.venue_id ? { venue_id: place.id } : { organisation_id: place.id } });
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
      `SELECT up.*, p.price_cents AS new_price, p.active AS on_sale, p.duration_days AS new_days, p.duration_months AS new_months, p.discount_bp AS new_discount,
              coalesce(v.name, o.name) AS place_name, coalesce(v.currency, p.currency) AS place_currency, e.status AS enrolment_status, pr.ends_on AS programme_ends
         FROM user_plans up JOIN venue_plans p ON p.id=up.plan_id LEFT JOIN venues v ON v.id=up.venue_id LEFT JOIN organisations o ON o.id=up.organisation_id
         LEFT JOIN org_enrolments e ON e.id=up.enrolment_id LEFT JOIN academy_programmes pr ON pr.id=e.programme_id
        WHERE up.kind='membership' AND up.auto_renew AND up.status='active' AND up.expires_at > now() AND up.expires_at <= now() + interval '7 days'
          AND NOT EXISTS (SELECT 1 FROM user_plans nx WHERE nx.renews_id=up.id)
          AND NOT EXISTS (SELECT 1 FROM user_plans o2 WHERE o2.user_id=up.user_id AND o2.kind='membership' AND o2.id<>up.id
                            AND ((up.venue_id IS NOT NULL AND o2.venue_id=up.venue_id) OR (up.enrolment_id IS NOT NULL AND o2.enrolment_id=up.enrolment_id))
                            AND (o2.status='awaiting_payment' OR (o2.status='active' AND o2.expires_at > up.expires_at)))
        ORDER BY up.expires_at LIMIT $1 FOR UPDATE OF up SKIP LOCKED`, [limit]);
    let n = 0;
    for (const up of rows) {
      if (!up.on_sale || up.place_currency !== up.currency) continue;
      if (up.organisation_id && (up.enrolment_status !== 'enrolled' || (up.programme_ends && new Date(up.programme_ends) <= new Date(up.expires_at)))) continue; // an academy fee stops when the person leaves or the programme ends
      const nx = (await c.query(
        `INSERT INTO user_plans(plan_id, venue_id, organisation_id, enrolment_id, user_id, kind, name, price_cents, currency, discount_bp, duration_days, duration_months, resource_ids, includes, auto_renew, renews_id)
         VALUES ($1,$2,$3,$4,$5,'membership',$6,$7,$8,$9,$10,$11,$12,$13,true,$14) RETURNING id`,
        [up.plan_id, up.venue_id, up.organisation_id, up.enrolment_id, up.user_id, up.name, up.new_price, up.currency, up.new_discount, up.new_days, up.new_months, up.resource_ids, up.includes, up.id])).rows[0];
      if (up.organisation_id) await (await import('../academy.js')).raiseRenewalCharge(c, up, nx.id);   // the money side of an academy period is an academy charge
      await notify(c, up.user_id, {
        kind: 'plan_renewal', title: `Renew ${up.name}`, dedupe_key: `plan_renewal:${up.id}`,
        body: `Your ${up.name} at ${up.place_name} ends on ${up.expires_at.toISOString().slice(0, 10)}. Renewal: ${money(up.new_price, up.currency)} — pay it to keep your place without a gap.`,
        data: up.venue_id ? { venue_id: up.venue_id, user_plan_id: nx.id } : { organisation_id: up.organisation_id, user_plan_id: nx.id } });
      n++;
    }
    return n;
  });
}
