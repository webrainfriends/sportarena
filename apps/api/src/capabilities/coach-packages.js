// Redeemable coach session packages (issue #655) - one capability definition per action; REST, OpenAPI and MCP share it.
// The offer is a coach_rate_cards row with unit 'package'. A purchase is a prepaid balance paid through canonical payments (purpose 'coach_package')
// and spent by hire_coach { package_id } (see ../coach-packages.js). Ownership, guardian consent and live revocation are enforced here:
// a stranger gets a 404, a young athlete's package is bought by a verified guardian, refunds are audit-logged and reconcile to the payment.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { config } from '../config.js';
import { notify } from '../notify.js';
import { audit } from '../helpers.js';
import { paymentsEnabled, refundPartial } from '../payments/service.js';
import { guardianLink, isYouth, guardiansOf } from '../youth.js';
import { refundKey } from '../lifecycle.js';
import { tellPayers } from '../coach-subscriptions.js';
import { activateCoachPackage, LIVE_USED, leftOf } from '../coach-packages.js';
import { athleteFor } from './coach-subscriptions.js';

const TAG = 'Coach packages';
const COACH = ['coach'];
const PAY = { purpose_type: 'coach_package' };

const VIEW = `p.id, p.coach_id, p.rate_card_id, p.sport_id, p.athlete_id, p.payer_id, p.title, p.sessions_total, p.price_cents, p.currency, p.valid_days, p.status, p.activated_at, p.expires_at, p.refunded_cents, p.refunded_at, p.created_at`;
const HISTORY = `(SELECT coalesce(json_agg(json_build_object('hire_id', h.id, 'starts_at', h.starts_at, 'status', h.status, 'booked_at', r.created_at, 'counts', h.status NOT IN ('cancelled','expired')) ORDER BY h.starts_at DESC), '[]'::json)
                    FROM coach_package_redemptions r JOIN coach_hires h ON h.id=r.hire_id WHERE r.purchase_id=p.id)`;
// who may see a package: whoever pays, the athlete (an adult), or a verified guardian of a young athlete
const MINE = `(p.payer_id=$1 OR p.athlete_id=$1 OR EXISTS (SELECT 1 FROM guardian_links l WHERE l.guardian_id=$1 AND l.child_id=p.athlete_id AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())))`;

/** What is left, in plain numbers, from a row that carries `used`. */
const shape = (p) => ({ ...p, price_cents: Number(p.price_cents), refunded_cents: Number(p.refunded_cents), sessions_used: p.used, sessions_left: leftOf(p), state: p.status === 'active' && !leftOf(p) ? (p.expires_at && new Date(p.expires_at) <= new Date() ? 'expired' : 'used_up') : p.status });
/** Money still held for the unused part (pro rata): what a refund would give back right now. */
export const unusedValue = (p) => Math.floor((Number(p.price_cents) * Math.max(0, p.sessions_total - p.used)) / p.sessions_total);

cap({
  name: 'buy_coach_package', method: 'POST', path: '/coach-packages', tag: TAG, status: 201,
  summary: 'Buy a coach\'s session package (a rate card with unit "package", one-to-one). It stays awaiting payment until paid through create_payment with purpose_type "coach_package" and the returned id; then it activates, the sessions are yours and the validity (`valid_days`) starts. Free packages, or a platform without payments, activate immediately. Spend a session with hire_coach { package_id }. `athlete_id` buys for a young person you are a verified guardian of. Repeating the call while a purchase waits for payment returns that purchase.',
  input: z.object({ rate_card_id: id, athlete_id: id.optional().describe('a young person you are a verified guardian of (default: you)') }),
  handler: ({ user }, i) => tx(async (c) => {
    const card = (await c.query("SELECT * FROM coach_rate_cards WHERE id=$1 AND archived_at IS NULL AND active AND unit='package'", [i.rate_card_id])).rows[0];
    if (!card) throw notFound('Package');
    if (card.audience !== 'individual' || card.per_person || !card.sessions_included) throw badRequest('Only one-to-one packages with a number of sessions can be redeemed');
    if (card.coach_id === user.id) throw badRequest('You cannot buy your own package');
    if ((await c.query('SELECT accepting FROM coach_profiles WHERE user_id=$1', [card.coach_id])).rows[0]?.accepting === false) throw badRequest('This coach is not taking new athletes right now');
    const athleteId = await athleteFor(c, user, i.athlete_id);
    if (athleteId === card.coach_id) throw badRequest('A coach cannot buy their own package');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`coachpkg:${card.id}:${athleteId}:${user.id}`]);
    const waiting = (await c.query("SELECT id FROM coach_package_purchases WHERE rate_card_id=$1 AND athlete_id=$2 AND payer_id=$3 AND status='awaiting_payment' ORDER BY created_at DESC LIMIT 1", [card.id, athleteId, user.id])).rows[0];
    const price = Number(card.price_cents);
    const row = waiting ?? (await c.query(
      `INSERT INTO coach_package_purchases(coach_id, rate_card_id, sport_id, athlete_id, payer_id, title, sessions_total, price_cents, currency, valid_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [card.coach_id, card.id, card.sport_id, athleteId, user.id, card.title, card.sessions_included, price, config.payments.currency, card.valid_days])).rows[0];
    if (!waiting && (!paymentsEnabled() || price === 0)) await activateCoachPackage(c, row.id);
    const p = (await c.query(`SELECT ${VIEW}, ${LIVE_USED} AS used FROM coach_package_purchases p WHERE p.id=$1`, [row.id])).rows[0];
    return { package: shape(p), pay: p.status === 'awaiting_payment' ? { ...PAY, purpose_id: p.id } : null };
  }),
});

cap({
  name: 'my_coach_packages', method: 'GET', path: '/me/coach-packages', tag: TAG,
  summary: 'Your session packages, and those of young people you are a verified guardian of: sessions left, expiry, status, what a refund of the unused part would give back, and the history of the sessions spent. `pay` is set while a purchase waits for payment (pay it with create_payment).',
  input: z.object({ status: z.enum(['open', 'all']).default('all'), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT ${VIEW}, cu.display_name AS coach_name, au.display_name AS athlete_name, ${LIVE_USED} AS used, ${HISTORY} AS history, (p.payer_id=$1) AS i_pay,
              (SELECT s.slug FROM sports s WHERE s.id=p.sport_id) AS sport_slug, (SELECT s.name FROM sports s WHERE s.id=p.sport_id) AS sport
         FROM coach_package_purchases p JOIN users cu ON cu.id=p.coach_id JOIN users au ON au.id=p.athlete_id
        WHERE ${MINE} AND ($4 = 'all' OR p.status IN ('awaiting_payment','active'))
        ORDER BY (p.status IN ('active','awaiting_payment')) DESC, p.created_at DESC, p.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset, i.status]);
    return rows.map((r) => ({ ...shape(r), refund_estimate_cents: r.status === 'active' ? unusedValue(r) : 0, pay: r.status === 'awaiting_payment' && r.payer_id === user.id ? { ...PAY, purpose_id: r.id } : null }));
  },
});

cap({
  name: 'coach_package_buyers', method: 'GET', path: '/coach/packages', tag: TAG, auth: COACH,
  summary: 'Coach: the packages your athletes bought - balance left, expiry, status and the value still owed in sessions (unearned revenue) - plus totals.',
  input: z.object({ status: z.enum(['open', 'all']).default('all'), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT ${VIEW}, au.display_name AS athlete_name, ${LIVE_USED} AS used, ${HISTORY} AS history
         FROM coach_package_purchases p JOIN users au ON au.id=p.athlete_id
        WHERE p.coach_id=$1 AND p.status <> 'awaiting_payment' AND ($4 = 'all' OR p.status = 'active')
        ORDER BY (p.status='active') DESC, p.created_at DESC, p.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset, i.status]);
    const packages = rows.map((r) => ({ ...shape(r), unearned_cents: r.status === 'active' ? unusedValue(r) : 0, refund_estimate_cents: ['active', 'expired'].includes(r.status) ? unusedValue(r) : 0 }));
    return { packages, totals: { sold: packages.length, open: packages.filter((p) => p.state === 'active').length, sessions_left: packages.reduce((n, p) => n + p.sessions_left, 0), unearned_cents: packages.reduce((n, p) => n + p.unearned_cents, 0), currency: config.payments.currency } };
  },
});

cap({
  name: 'refund_coach_package', method: 'POST', path: '/coach-packages/:id/refund', tag: TAG,
  summary: 'Refund the unused part of a package, pro rata (price x unused sessions / total sessions), through the original payment. The person who paid (or a verified guardian) can do it while the package is active; the coach can also do it after it expired. Sessions already booked or done stay valid and are not refunded; the package stops accepting new bookings. Idempotent: a second call is refused, never a second refund. Audit-logged.',
  input: z.object({ id, reason: z.string().trim().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = (await c.query(`SELECT p.*, ${LIVE_USED} AS used FROM coach_package_purchases p WHERE p.id=$1 FOR UPDATE`, [i.id])).rows[0];
      const isCoach = p?.coach_id === user.id;
      const isMine = p && (p.payer_id === user.id || (p.athlete_id !== user.id && !!(await guardianLink(user.id, p.athlete_id, c))) || (p.athlete_id === user.id && !((await isYouth(p.athlete_id, c)) && (await guardiansOf(p.athlete_id, c)).length)));
      if (!p || !(isCoach || isMine)) throw notFound('Package');
      if (p.status === 'refunded') throw conflict('This package was already refunded');
      if (p.status === 'awaiting_payment') throw conflict('This package has not been paid yet - cancel it instead');
      if (p.status === 'cancelled') throw conflict('This package was cancelled');
      const expired = p.status === 'expired' || (p.expires_at && new Date(p.expires_at) <= new Date());
      if (expired && !isCoach) throw conflict('This package has expired. Ask the coach to refund the unused sessions.');
      const unused = Math.max(0, p.sessions_total - p.used);
      const amount = unusedValue(p);
      let given = 0;
      if (amount > 0) {
        const pay = (await c.query("SELECT * FROM payments WHERE purpose_type='coach_package' AND purpose_id=$1 AND status='paid' ORDER BY created_at, id LIMIT 1", [p.id])).rows[0];
        if (pay) given = await refundPartial(pay, amount, refundKey('coach_package', p.id));   // refused by the provider = nothing below runs and nothing changes
      }
      await c.query("UPDATE coach_package_purchases SET status='refunded', refunded_cents=$2, refunded_at=now(), refunded_by=$3 WHERE id=$1", [p.id, given, user.id]);
      await audit(c, user.id, 'refund_coach_package', 'coach_package_purchases', p.id);
      const other = isCoach ? await tellPayers(c, p) : [p.coach_id];
      for (const u of other) if (u !== user.id) await notify(c, u, { kind: 'coach_package_refunded', title: `${p.title}: unused sessions refunded`, body: `${unused} session${unused === 1 ? '' : 's'} · ${p.currency} ${(given / 100).toFixed(2)}${i.reason ? ` · ${i.reason}` : ''}`, data: { package_id: p.id, ...(isCoach ? {} : { for_coach: true }) }, dedupe_key: `coach_package_refunded:${p.id}:${u}` });
      return { id: p.id, status: 'refunded', sessions_refunded: unused, refunded_cents: given, currency: p.currency };
    });
  },
});

cap({
  name: 'cancel_unpaid_coach_package', method: 'POST', path: '/coach-packages/:id/cancel', tag: TAG,
  summary: 'Cancel a package purchase that has not been paid yet. A paid package is not cancelled here - refund its unused part with refund_coach_package.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one("UPDATE coach_package_purchases SET status='cancelled' WHERE id=$1 AND payer_id=$2 AND status='awaiting_payment' RETURNING id, status", [i.id, user.id]);
    if (!r) throw notFound('Package');
    return r;
  },
});
