// Recurring monthly coaching (issue #659) - one capability definition per action; REST, OpenAPI and MCP share it.
// The offer is a coach_rate_cards row with unit 'month'. Each month is a user_plans row paid through canonical payments (see ../coach-subscriptions.js).
// Authorisation, guardian consent and live revocation are enforced here: a stranger gets a 404, a young athlete is paid for by a verified guardian.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { config } from '../config.js';
import { notify } from '../notify.js';
import { audit } from '../helpers.js';
import { paymentsEnabled } from '../payments/service.js';
import { guardianLink, guardiansOf, hasConsent, isYouth } from '../youth.js';
import { raisePeriod, raiseNext, tellPayers } from '../coach-subscriptions.js';

const TAG = 'Coaching subscriptions';
const COACH = ['coach'];
const PAY = { purpose_type: 'coach_subscription_period' };

/** Who the coaching is for: the caller, or a young person the caller is a verified guardian of. Anyone else gets a 404. */
async function athleteFor(c, user, athleteId) {
  if (!athleteId || athleteId === user.id) {
    if (await isYouth(user.id, c)) {
      if ((await guardiansOf(user.id, c)).length) throw forbidden('A guardian subscribes for you. Ask them to do it under Family & guardians.');
    }
    return user.id;
  }
  if (!(await guardianLink(user.id, athleteId, c))) throw notFound('Athlete');
  if (!(await hasConsent(athleteId, 'coaching', c))) throw conflict('A verified guardian has not given current consent for coaching. Allow it under Family & guardians.', { code: 'guardian_consent_required', purpose: 'coaching' });
  return athleteId;
}

/** The people who may manage a subscription: whoever pays, the athlete (an adult), or a verified guardian. Others get a 404. */
async function mineOr404(c, user, subId, { coachToo = false } = {}) {
  const s = (await c.query('SELECT * FROM coach_subscriptions WHERE id=$1 FOR UPDATE', [subId])).rows[0];
  if (!s) throw notFound('Subscription');
  const isPayer = s.payer_id === user.id;
  const isAthlete = s.athlete_id === user.id && !((await isYouth(s.athlete_id, c)) && (await guardiansOf(s.athlete_id, c)).length);
  const isGuardian = s.athlete_id !== user.id && !!(await guardianLink(user.id, s.athlete_id, c));
  const isCoach = coachToo && s.coach_id === user.id;
  if (!(isPayer || isAthlete || isGuardian || isCoach)) throw notFound('Subscription');
  return s;
}

const VIEW = `s.id, s.coach_id, s.rate_card_id, s.athlete_id, s.payer_id, s.title, s.price_cents, s.currency, s.sessions_per_period, s.rollover_max, s.grace_days, s.status, s.cancel_at_period_end, s.paused_at, s.lapsed_at, s.cancelled_at, s.created_at`;
const PERIODS = `(SELECT coalesce(json_agg(json_build_object('id', p.id, 'period_no', p.period_no, 'status', p.status, 'due_on', p.due_on::text, 'starts_at', p.starts_at, 'expires_at', p.expires_at, 'sessions_total', p.sessions_total, 'sessions_left', p.sessions_left, 'carried_sessions', p.carried_sessions, 'price_cents', p.price_cents) ORDER BY p.period_no DESC), '[]'::json) FROM (SELECT * FROM user_plans WHERE subscription_id=s.id ORDER BY period_no DESC LIMIT 6) p)`;

cap({
  name: 'subscribe_to_coach', method: 'POST', path: '/coach-subscriptions', tag: TAG, status: 201,
  summary: 'Subscribe to a coach\'s monthly rate card (unit "month"). Creates the agreement and its first month, waiting for payment: pay it with create_payment (purpose_type "coach_subscription_period", purpose_id = the returned period id). Each following month is raised a week before the current one ends and paid the same way; nothing is charged without a payment you complete. For a young athlete a verified guardian subscribes and pays (`athlete_id`).',
  input: z.object({ rate_card_id: id, athlete_id: id.optional().describe('a young person you are a verified guardian of (default: you)') }),
  handler: ({ user }, i) => tx(async (c) => {
    if (!paymentsEnabled()) throw conflict('Online payments are not set up yet, so a subscription cannot be started');
    const card = (await c.query("SELECT * FROM coach_rate_cards WHERE id=$1 AND archived_at IS NULL AND active AND unit='month'", [i.rate_card_id])).rows[0];
    if (!card) throw notFound('Monthly rate card');
    if (card.coach_id === user.id) throw badRequest('You cannot subscribe to yourself');
    if ((await c.query('SELECT accepting FROM coach_profiles WHERE user_id=$1', [card.coach_id])).rows[0]?.accepting === false) throw badRequest('This coach is not taking new athletes right now');
    const athleteId = await athleteFor(c, user, i.athlete_id);
    if (athleteId === card.coach_id) throw badRequest('A coach cannot subscribe to themselves');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`coachsub:${card.id}:${athleteId}`]);
    if ((await c.query("SELECT 1 FROM coach_subscriptions WHERE rate_card_id=$1 AND athlete_id=$2 AND status IN ('active','paused','past_due')", [card.id, athleteId])).rowCount) throw conflict('There is already a subscription to this coach\'s card');
    const sub = (await c.query(
      `INSERT INTO coach_subscriptions(coach_id, rate_card_id, athlete_id, payer_id, title, price_cents, currency, sessions_per_period, rollover_max, grace_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [card.coach_id, card.id, athleteId, user.id, card.title, card.price_cents, config.payments.currency, card.sessions_included ?? 0, card.rollover_max, card.grace_days])).rows[0];
    const period = await raisePeriod(c, sub, 1, new Date().toISOString().slice(0, 10));
    const who = (await c.query('SELECT display_name FROM users WHERE id=$1', [athleteId])).rows[0].display_name;
    await notify(c, card.coach_id, { kind: 'coach_sub_new', title: `${who} wants to subscribe`, body: `${card.title}. Waiting for their first payment.`, data: { subscription_id: sub.id, for_coach: true }, dedupe_key: `coach_sub_new:${sub.id}` });
    return { subscription: sub, period: { id: period.id, period_no: 1, price_cents: Number(period.price_cents), currency: period.currency, status: period.status }, pay: { ...PAY, purpose_id: period.id } };
  }),
});

cap({
  name: 'my_coach_subscriptions', method: 'GET', path: '/me/coach-subscriptions', tag: TAG,
  summary: 'Your monthly coaching subscriptions, and those of young people you are a verified guardian of: status, the last months with sessions left, and the open payment (if any) to pay with create_payment.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT ${VIEW}, cu.display_name AS coach_name, au.display_name AS athlete_name, ${PERIODS} AS periods,
              (SELECT p.id FROM user_plans p WHERE p.subscription_id=s.id AND p.status='awaiting_payment' AND s.status IN ('active','past_due') ORDER BY p.period_no DESC LIMIT 1) AS open_period_id,
              (s.payer_id=$1) AS i_pay
         FROM coach_subscriptions s JOIN users cu ON cu.id=s.coach_id JOIN users au ON au.id=s.athlete_id
        WHERE s.payer_id=$1 OR s.athlete_id=$1 OR EXISTS (SELECT 1 FROM guardian_links l WHERE l.guardian_id=$1 AND l.child_id=s.athlete_id AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()))
        ORDER BY (s.status IN ('active','past_due','paused')) DESC, s.created_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
    return rows.map((r) => ({ ...r, sessions_left: (r.periods.find((p) => p.status === 'active' && new Date(p.expires_at) > new Date())?.sessions_left) ?? 0 }));
  },
});

cap({
  name: 'pause_coach_subscription', method: 'POST', path: '/coach-subscriptions/:id/pause', tag: TAG,
  summary: 'Pause billing. The month already paid stays usable to its end; no new month is raised until you resume. Data is kept.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await mineOr404(c, user, i.id);
    if (s.status !== 'active') throw conflict(s.status === 'past_due' ? 'Pay the open month first, then pause' : `A ${s.status} subscription cannot be paused`);
    const r = (await c.query("UPDATE coach_subscriptions SET status='paused', paused_at=now() WHERE id=$1 RETURNING *", [s.id])).rows[0];
    await audit(c, user.id, 'pause_coach_subscription', 'coach_subscriptions', s.id);
    await notify(c, s.coach_id, { kind: 'coach_sub_paused', title: 'A subscriber paused', body: s.title, data: { subscription_id: s.id, for_coach: true }, dedupe_key: `coach_sub_paused:${s.id}:${Date.now()}` });
    return r;
  }),
});

cap({
  name: 'resume_coach_subscription', method: 'POST', path: '/coach-subscriptions/:id/resume', tag: TAG,
  summary: 'Resume a paused subscription. If the paid month is over, a new month is raised now, waiting for payment (see my_coach_subscriptions open_period_id).',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await mineOr404(c, user, i.id);
    if (s.status !== 'paused') throw conflict('Only a paused subscription can be resumed');
    const r = (await c.query("UPDATE coach_subscriptions SET status='active', paused_at=NULL WHERE id=$1 RETURNING *", [s.id])).rows[0];
    await c.query("UPDATE user_plans SET due_on = greatest(due_on, current_date) WHERE subscription_id=$1 AND status='awaiting_payment'", [s.id]);   // the clock for the open month restarts
    await raiseNext(c, r, { resumed: true });
    await audit(c, user.id, 'resume_coach_subscription', 'coach_subscriptions', s.id);
    return r;
  }),
});
cap({
  name: 'cancel_coach_subscription', method: 'POST', path: '/coach-subscriptions/:id/cancel', tag: TAG,
  summary: 'Cancel at the end of the paid month (you keep the sessions you paid for; nothing renews). A month that is still unpaid is dropped straight away. The subscriber or a verified guardian or the coach may cancel. Nothing is deleted.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await mineOr404(c, user, i.id, { coachToo: true });
    if (['cancelled', 'lapsed'].includes(s.status)) return s;
    const last = (await c.query('SELECT * FROM user_plans WHERE subscription_id=$1 ORDER BY period_no DESC LIMIT 1 FOR UPDATE', [s.id])).rows[0];
    let r;
    if (!last || last.status === 'awaiting_payment') {
      if (last) await c.query("UPDATE user_plans SET status='cancelled' WHERE id=$1", [last.id]);
      r = (await c.query("UPDATE coach_subscriptions SET status='cancelled', cancelled_at=now(), cancelled_by=$2 WHERE id=$1 RETURNING *", [s.id, user.id])).rows[0];
    } else {
      r = (await c.query('UPDATE coach_subscriptions SET cancel_at_period_end=true, cancelled_by=$2 WHERE id=$1 RETURNING *', [s.id, user.id])).rows[0];
    }
    await audit(c, user.id, 'cancel_coach_subscription', 'coach_subscriptions', s.id);
    const other = user.id === s.coach_id ? await tellPayers(c, s) : [s.coach_id];
    for (const u of other) await notify(c, u, { kind: 'coach_sub_cancelled', title: `${s.title} will end`, body: r.status === 'cancelled' ? 'It has ended.' : 'It will not renew after the current month.', data: { subscription_id: s.id, for_coach: user.id !== s.coach_id }, dedupe_key: `coach_sub_cancel:${s.id}:${u}` });
    return r;
  }),
});

cap({
  name: 'coach_subscribers', method: 'GET', path: '/coach/subscriptions', tag: TAG, auth: COACH,
  summary: 'Coach: your monthly subscribers and recurring revenue. MRR counts subscribers who have paid and will be billed again (active or in grace, not paused, not cancelling), per currency, never added across currencies. `revenue` reconciles the periods that were paid against the canonical payments recorded for them.',
  input: z.object({ status: z.enum(['live', 'all']).default('live'), ...page }),
  async handler({ user }, i) {
    const live = ['active', 'past_due', 'paused'];
    const items = await many(
      `SELECT ${VIEW}, au.display_name AS athlete_name, ${PERIODS} AS periods
         FROM coach_subscriptions s JOIN users au ON au.id=s.athlete_id
        WHERE s.coach_id=$1 AND ($2::text = 'all' OR s.status = ANY($3)) ORDER BY (s.status='past_due') DESC, s.created_at DESC LIMIT $4 OFFSET $5`, [user.id, i.status, live, i.limit, i.offset]);
    const mrr = await many(
      `SELECT currency, coalesce(sum(price_cents),0)::bigint AS mrr_cents, count(*)::int AS subscribers
         FROM coach_subscriptions s WHERE coach_id=$1 AND status IN ('active','past_due') AND NOT cancel_at_period_end AND EXISTS (SELECT 1 FROM user_plans p WHERE p.subscription_id=s.id AND p.starts_at IS NOT NULL) GROUP BY currency ORDER BY currency`, [user.id]);
    const counts = Object.fromEntries((await many('SELECT status, count(*)::int AS n FROM coach_subscriptions WHERE coach_id=$1 GROUP BY 1', [user.id])).map((r) => [r.status, r.n]));
    const revenue = await many(
      `SELECT up.currency,
              coalesce(sum(up.price_cents) FILTER (WHERE up.starts_at IS NOT NULL),0)::bigint AS billed_cents,
              coalesce(sum(p.amount_cents),0)::bigint AS paid_cents,
              count(DISTINCT up.id) FILTER (WHERE up.starts_at IS NOT NULL)::int AS periods_paid
         FROM user_plans up LEFT JOIN payments p ON p.purpose_type='coach_subscription_period' AND p.purpose_id=up.id AND p.status='paid'
        WHERE up.coach_id=$1 AND up.subscription_id IS NOT NULL AND up.starts_at IS NOT NULL GROUP BY up.currency ORDER BY up.currency`, [user.id]);
    return { items, counts, mrr, revenue: revenue.map((r) => ({ ...r, reconciled: String(r.billed_cents) === String(r.paid_cents) })) };
  },
});
