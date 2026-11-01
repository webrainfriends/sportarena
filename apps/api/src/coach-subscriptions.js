// Recurring monthly coaching (issue #659). A subscription is an agreement (coach_subscriptions); each billing period is a user_plans row, paid through
// canonical payments (purpose 'coach_subscription_period'). One period, one row: (subscription_id, period_no) is unique, so a retry, a second sweep or a
// concurrent run can never raise - and so never charge - the same period twice. Nothing here deletes data: lapsing and cancelling only change status.
import { many, tx, one } from './db.js';
import { notify } from './notify.js';
import { logger } from './logger.js';
import { guardiansOf, isYouth } from './youth.js';

export const RAISE_DAYS = 7;          // the next period is raised this many days before the current one ends
export const FIRST_PAYMENT_DAYS = 3;  // an unpaid first period is dropped after this long

const money = (n, cur) => `${cur} ${(Number(n) / 100).toFixed(2)}`;

/** Who hears about money: the payer; for a young athlete a payer who is no longer a verified guardian is replaced by the current guardians. */
export async function tellPayers(c, sub) {
  if (!(await isYouth(sub.athlete_id, c)) || sub.payer_id === sub.athlete_id) return [sub.payer_id];
  const g = await guardiansOf(sub.athlete_id, c);
  return g.includes(sub.payer_id) ? [sub.payer_id] : g;
}
const tell = async (c, sub, msg) => { for (const u of await tellPayers(c, sub)) await notify(c, u, { ...msg, dedupe_key: msg.dedupe_key ? `${msg.dedupe_key}:${u}` : undefined }); };

/** Raise period `n` (waiting for payment). Idempotent: returns the new row, or null when that period already exists. */
export async function raisePeriod(c, sub, n, dueOn) {
  const r = await c.query(
    `INSERT INTO user_plans(coach_id, subscription_id, period_no, due_on, user_id, kind, name, price_cents, currency, sessions_total, sessions_left, duration_days, auto_renew)
     VALUES ($1,$2,$3,$4,$5,'pass',$6,$7,$8,$9,$9,30,true) ON CONFLICT (subscription_id, period_no) WHERE subscription_id IS NOT NULL DO NOTHING RETURNING *`,
    [sub.coach_id, sub.id, n, dueOn, sub.payer_id, sub.title, sub.price_cents, sub.currency, sub.sessions_per_period]);
  return r.rows[0] ?? null;
}

/** Move unused sessions of the previous period into this one (up to the card's rollover cap), once, when this period has started. */
export async function settleCarry(c, planId) {
  const p = (await c.query("SELECT * FROM user_plans WHERE id=$1 AND status='active' AND carry_settled_at IS NULL AND starts_at <= now() FOR UPDATE", [planId])).rows[0];
  if (!p) return 0;
  let carry = 0;
  if (p.period_no > 1) {
    const sub = (await c.query('SELECT rollover_max FROM coach_subscriptions WHERE id=$1', [p.subscription_id])).rows[0];
    const prev = (await c.query('SELECT id, sessions_left FROM user_plans WHERE subscription_id=$1 AND period_no=$2 FOR UPDATE', [p.subscription_id, p.period_no - 1])).rows[0];
    carry = prev ? Math.min(prev.sessions_left, sub.rollover_max) : 0;
    if (carry > 0) await c.query('UPDATE user_plans SET sessions_left = sessions_left - $2 WHERE id=$1', [prev.id, carry]);
  }
  await c.query('UPDATE user_plans SET carry_settled_at=now(), carried_sessions=$2, sessions_total=sessions_total+$2, sessions_left=sessions_left+$2 WHERE id=$1', [p.id, carry]);
  return carry;
}

/** Payment confirmed: the period starts where the last one ended (no gap, no overlap), and the subscription is in good standing. */
export async function activateCoachPeriod(c, planId) {
  const p = (await c.query("SELECT * FROM user_plans WHERE id=$1 AND subscription_id IS NOT NULL AND status='awaiting_payment' FOR UPDATE", [planId])).rows[0];
  if (!p) return false;
  const sub = (await c.query('SELECT * FROM coach_subscriptions WHERE id=$1 FOR UPDATE', [p.subscription_id])).rows[0];
  if (!sub || ['lapsed', 'cancelled'].includes(sub.status)) return false;           // too late: the payment is refunded by the caller
  const prev = p.period_no > 1 ? (await c.query('SELECT expires_at FROM user_plans WHERE subscription_id=$1 AND period_no=$2', [p.subscription_id, p.period_no - 1])).rows[0] : null;
  // continuous with the last period when paid early or inside the grace window; after a long pause it simply starts now
  const from = prev && Date.now() - +new Date(prev.expires_at) <= sub.grace_days * 864e5 ? prev.expires_at : null;
  await c.query(
    `UPDATE user_plans SET status='active', starts_at = coalesce($2::timestamptz, now()), expires_at = coalesce($2::timestamptz, now()) + interval '1 month' WHERE id=$1`, [p.id, from]);
  await c.query("UPDATE coach_subscriptions SET status = CASE WHEN status='past_due' THEN 'active' ELSE status END WHERE id=$1", [sub.id]);
  await settleCarry(c, p.id);
  const coach = (await c.query('SELECT display_name FROM users WHERE id=$1', [sub.coach_id])).rows[0];
  await tell(c, sub, { kind: 'coach_sub_active', title: `${sub.title} is active ✓`, body: `Paid for period ${p.period_no} with ${coach.display_name}. ${sub.sessions_per_period} session${sub.sessions_per_period === 1 ? '' : 's'} included.`, data: { subscription_id: sub.id }, dedupe_key: `coach_sub_active:${p.id}` });
  await notify(c, sub.coach_id, { kind: 'coach_sub_paid', title: `Subscription payment received`, body: `${sub.title} · period ${p.period_no}`, data: { subscription_id: sub.id, for_coach: true }, dedupe_key: `coach_sub_paid:${p.id}` });
  return true;
}

/** Spend one included session on a hire. The caller is inside the booking transaction. Throws a message string via { error } when it cannot. */
export async function redeemSubscriptionSession(c, { subscriptionId, hirerId, coachId, athleteId, hireId }) {
  const sub = (await c.query('SELECT * FROM coach_subscriptions WHERE id=$1 FOR UPDATE', [subscriptionId])).rows[0];
  if (!sub || sub.coach_id !== coachId || sub.athlete_id !== athleteId || ![sub.payer_id, sub.athlete_id].includes(hirerId)) return { error: 'notFound' };
  const p = (await c.query(
    `SELECT * FROM user_plans WHERE subscription_id=$1 AND status='active' AND starts_at <= now() AND sessions_left > 0
        AND (expires_at > now() OR ($2::text = 'past_due' AND expires_at + make_interval(days => $3) > now())) ORDER BY expires_at LIMIT 1 FOR UPDATE`,
    [sub.id, sub.status, sub.grace_days])).rows[0];
  if (!p) return { error: 'empty' };
  await c.query('UPDATE user_plans SET sessions_left = sessions_left - 1 WHERE id=$1', [p.id]);
  await c.query('INSERT INTO coach_subscription_redemptions(hire_id, user_plan_id) VALUES ($1,$2)', [hireId, p.id]);
  return { ok: true, sessions_left: p.sessions_left - 1, user_plan_id: p.id };
}

/** A cancelled hire gives its session back (once): to its own period while that is live, otherwise to the current period. */
export async function restoreSubscriptionSession(c, hireId) {
  const r = (await c.query('SELECT * FROM coach_subscription_redemptions WHERE hire_id=$1 AND restored_at IS NULL FOR UPDATE', [hireId])).rows[0];
  if (!r) return false;
  const own = (await c.query("SELECT id FROM user_plans WHERE id=$1 AND status='active' AND expires_at > now() FOR UPDATE", [r.user_plan_id])).rows[0]
    ?? (await c.query("SELECT cur.id FROM user_plans orig JOIN user_plans cur ON cur.subscription_id=orig.subscription_id AND cur.status='active' AND cur.expires_at > now() WHERE orig.id=$1 ORDER BY cur.expires_at DESC LIMIT 1 FOR UPDATE OF cur", [r.user_plan_id])).rows[0];
  if (own) await c.query('UPDATE user_plans SET sessions_left = sessions_left + 1, sessions_total = greatest(sessions_total, sessions_left + 1) WHERE id=$1', [own.id]);
  await c.query('UPDATE coach_subscription_redemptions SET restored_at=now() WHERE hire_id=$1', [hireId]);
  return !!own;
}

/** The next period of a live subscription, when it is time. Returns the new row or null. */
async function raiseNext(c, sub, { resumed = false } = {}) {
  const last = (await c.query('SELECT * FROM user_plans WHERE subscription_id=$1 ORDER BY period_no DESC LIMIT 1 FOR UPDATE', [sub.id])).rows[0];
  if (!last || last.status !== 'active') return null;                                          // unpaid or ended periods are handled by dunning
  if (new Date(last.expires_at) > new Date(Date.now() + RAISE_DAYS * 864e5)) return null;
  // after a pause the grace clock starts today, not at the old expiry
  const dueOn = new Date(Math.max(+new Date(last.expires_at), resumed ? Date.now() : 0)).toISOString().slice(0, 10);
  const nx = await raisePeriod(c, sub, last.period_no + 1, dueOn);
  if (nx) await tell(c, sub, { kind: 'coach_sub_renewal', title: `Pay ${sub.title}`, body: `Next month is ${money(sub.price_cents, sub.currency)}, due ${dueOn}. Pay it to keep your sessions without a gap.`, data: { subscription_id: sub.id, user_plan_id: nx.id }, dedupe_key: `coach_sub_due:${nx.id}` });
  return nx;
}
export { raiseNext };

/** One pass over every live subscription. Safe to repeat: each step is conditional on the row still being in the state it expects. */
export async function syncCoachSubscriptions() {
  let changed = 0;
  const fail = (what, id, e) => logger.error(`coach subscription ${what} failed`, { id, error: String(e.message).slice(0, 200) });

  for (const r of await many("SELECT id FROM user_plans WHERE subscription_id IS NOT NULL AND status='active' AND carry_settled_at IS NULL AND starts_at <= now() LIMIT 200")) {
    try { await tx(async (c) => { if (await settleCarry(c, r.id)) changed++; }); } catch (e) { fail('carry', r.id, e); }
  }

  for (const s of await many("SELECT id FROM coach_subscriptions WHERE status IN ('active','past_due') ORDER BY created_at LIMIT 500")) {
    try {
      await tx(async (c) => {
        const sub = (await c.query("SELECT * FROM coach_subscriptions WHERE id=$1 AND status IN ('active','past_due') FOR UPDATE", [s.id])).rows[0];
        if (!sub) return;
        const last = (await c.query('SELECT *, due_on::text AS due_s FROM user_plans WHERE subscription_id=$1 ORDER BY period_no DESC LIMIT 1 FOR UPDATE', [sub.id])).rows[0];
        if (!last) return;
        if (last.status === 'awaiting_payment') {
          const today = new Date().toISOString().slice(0, 10);
          if (last.period_no === 1) {                                                           // never paid: the offer simply lapses
            if (new Date(last.created_at) < new Date(Date.now() - FIRST_PAYMENT_DAYS * 864e5)) {
              await c.query("UPDATE user_plans SET status='cancelled' WHERE id=$1", [last.id]);
              await c.query("UPDATE coach_subscriptions SET status='cancelled', cancelled_at=now() WHERE id=$1", [sub.id]);
              changed++;
            }
            return;
          }
          const lateDays = Math.floor((Date.parse(today) - Date.parse(last.due_s)) / 864e5);
          if (lateDays > sub.grace_days) {                                                       // grace is over: the entitlement lapses, the data stays
            await c.query("UPDATE user_plans SET status='cancelled' WHERE id=$1 AND status='awaiting_payment'", [last.id]);
            await c.query("UPDATE coach_subscriptions SET status='lapsed', lapsed_at=now() WHERE id=$1", [sub.id]);
            await tell(c, sub, { kind: 'coach_sub_lapsed', title: `${sub.title} has lapsed`, body: 'The payment was not received in time, so your included sessions have ended. Your history is kept — subscribe again any time.', data: { subscription_id: sub.id }, dedupe_key: `coach_sub_lapsed:${sub.id}:${last.period_no}` });
            await notify(c, sub.coach_id, { kind: 'coach_sub_lapsed_coach', title: 'A subscriber lapsed', body: `${sub.title}: payment for period ${last.period_no} was not received.`, data: { subscription_id: sub.id, for_coach: true }, dedupe_key: `coach_sub_lapsed_c:${sub.id}:${last.period_no}` });
            changed++;
          } else if (lateDays >= 0) {
            if (sub.status === 'active') {
              await c.query("UPDATE coach_subscriptions SET status='past_due' WHERE id=$1 AND status='active'", [sub.id]);
              await notify(c, sub.coach_id, { kind: 'coach_sub_past_due_coach', title: 'A subscription payment is late', body: `${sub.title}: period ${last.period_no} is unpaid. Grace ends in ${sub.grace_days - lateDays} day(s).`, data: { subscription_id: sub.id, for_coach: true }, dedupe_key: `coach_sub_pd_c:${sub.id}:${last.period_no}` });
              changed++;
            }
            // the payer's reminders for a late month are sent once, by the collections engine (collections.js), which owns the case for this period
          }
          return;
        }
        if (last.status === 'active' && sub.cancel_at_period_end && new Date(last.expires_at) <= new Date()) {
          await c.query("UPDATE coach_subscriptions SET status='cancelled', cancelled_at=now() WHERE id=$1", [sub.id]);
          await tell(c, sub, { kind: 'coach_sub_ended', title: `${sub.title} has ended`, body: 'As you asked, it did not renew. Your history is kept.', data: { subscription_id: sub.id }, dedupe_key: `coach_sub_ended:${sub.id}` });
          changed++;
          return;
        }
        if (!sub.cancel_at_period_end && (await raiseNext(c, sub))) changed++;
      });
    } catch (e) { fail('billing', s.id, e); }
  }
  return changed;
}
