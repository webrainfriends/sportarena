// Memberships and multi-session passes: activate on payment, give sessions back when what they paid is voided or refunded, expire.
import { query } from '../db.js';
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
