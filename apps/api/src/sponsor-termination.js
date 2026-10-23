// Termination of a sponsorship agreement (#298). Hangs off the canonical `sponsorships` row, its dues, payments and deliveries (see
// sponsor-agreements.js); there is no second agreement or ledger. Ending stops only FUTURE dues nothing has happened to (the existing safe
// debt handling): delivered value and anything already due, part-paid, dispatched or submitted stays exactly as recorded. Returns and refunds
// are separate, agreed records that reference the canonical delivery / payment, and the final settlement exposes whatever is still unresolved.
import { cancelFutureObligations, logHistory, settleMoney } from './sponsor-agreements.js';
import { closePauseOnEnd } from './sponsor-pause.js';
import { notify } from './notify.js';
import { notifySponsor } from './sponsor-access.js';
import { ACTIVITY } from './sponsor-amendments.js';
import { conflict } from './errors.js';
import { tx } from './db.js';

export const REASONS = ['mutual', 'breach', 'non_performance', 'budget', 'other'];
export const LIVE = ['notice', 'agreed', 'ended'];
const num = (v) => Number(v ?? 0);

export const today = async (c) => (await c.query('SELECT current_date::text AS d')).rows[0].d;

/** Notifications never carry terms or amounts; the participant-scoped reads do. */
export const ping = (c, to, title, ctx) => {
  const msg = { kind: 'sponsorship_update', title, body: `Open the ${ctx.sp.name} agreement to see the termination.`, data: { sponsorship_id: ctx.d.id } };
  return to === 'sponsor' ? notifySponsor(c, ctx.sp, 'end', msg, ctx.d.department_id) : notify(c, to, msg);
};

/**
 * What ending now would do to the dues, before anyone gives notice: future dues nothing has happened to stop (`stopped`); everything else
 * stays (`kept`) with what is still owed on it. Currencies are never combined.
 */
export async function impactOf(c, d, effectiveOn) {
  const dues = (await c.query(
    `SELECT o.id, l.label, o.kind, o.due_on::text AS due_on, o.amount_cents, o.currency, o.quantity, o.status, o.conceded_cents,
            (o.status = 'scheduled' AND o.due_on > $2::date AND NOT ${ACTIVITY}) AS stopped,
            coalesce((SELECT sum(p.amount_cents - p.refunded_cents) FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status='confirmed'),0)::bigint AS confirmed_cents
       FROM sponsorship_obligations o JOIN sponsorship_lines l ON l.id=o.line_id WHERE o.sponsorship_id=$1 AND o.status <> 'cancelled' ORDER BY o.due_on, o.id`, [d.id, effectiveOn])).rows;
  const stopped = dues.filter((o) => o.stopped), kept = dues.filter((o) => !o.stopped);
  const cash = (list, f) => { const t = {}; for (const o of list) if (o.kind === 'money') t[o.currency] = (t[o.currency] ?? 0) + f(o); return t; };
  const owed = cash(kept.filter((o) => o.status === 'scheduled'), (o) => Math.max(0, num(o.amount_cents) - num(o.confirmed_cents) - num(o.conceded_cents)));
  const paid = cash(dues, (o) => num(o.confirmed_cents)), freed = cash(stopped, (o) => num(o.amount_cents));
  const currencies = [...new Set([...Object.keys(paid), ...Object.keys(owed), ...Object.keys(freed)])].sort();
  return {
    effective_on: effectiveOn, kept_count: kept.length, stopped_count: stopped.length,
    stopped: stopped.map((o) => ({ id: o.id, label: o.label, kind: o.kind, due_on: o.due_on, amount_cents: o.amount_cents == null ? null : num(o.amount_cents), currency: o.currency, quantity: o.quantity })),
    totals: currencies.map((currency) => ({ currency, paid_cents: paid[currency] ?? 0, still_owed_cents: owed[currency] ?? 0, stopped_cents: freed[currency] ?? 0 })),
  };
}

/** The agreement ends on its effective date. Runs inside the caller's transaction with the sponsorship row locked, so it can only apply once. */
export async function applyTermination(c, t, actorId) {
  const d = (await c.query('SELECT id, status FROM sponsorships WHERE id=$1 FOR UPDATE', [t.sponsorship_id])).rows[0];
  if (['active', 'paused'].includes(d.status)) {
    await c.query("UPDATE sponsorships SET status='ended', decision_reason=coalesce($2, decision_reason), decided_at=now(), decided_by=$3 WHERE id=$1", [d.id, t.reason, actorId ?? t.given_by]);
    await cancelFutureObligations(c, d.id);
    await closePauseOnEnd(c, d.id); // an open pause is closed and its held dues released, so a debt still owed stays payable
  }
  await c.query("UPDATE sponsorship_terminations SET status='ended', ended_at=now(), rev=rev+1, updated_at=now() WHERE id=$1 AND status IN ('notice','agreed')", [t.id]);
  await logHistory(c, d.id, t.base_version, actorId ?? null, 'ended', `${t.reason_code.replace(/_/g, ' ')}${t.reason ? `: ${t.reason}` : ''} (effective ${t.effective_on})`);
}

/** End now (the existing one-step "end deal"): records the notice and applies it at once. A notice already open is brought forward. */
export async function endNow(c, ctx, user, side, { reason_code = 'other', reason } = {}) {
  const live = (await c.query("SELECT * FROM sponsorship_terminations WHERE sponsorship_id=$1 AND status IN ('notice','agreed') FOR UPDATE", [ctx.d.id])).rows[0];
  const t = live ?? (await c.query(
    `INSERT INTO sponsorship_terminations(sponsorship_id, given_side, given_by, reason_code, reason, notice_on, effective_on, base_version, status)
     VALUES ($1,$2,$3,$4,$5,current_date,current_date,$6,'notice') RETURNING *`, [ctx.d.id, side, user.id, reason_code, reason ?? null, ctx.d.accepted_version ?? ctx.d.terms_version])).rows[0];
  await applyTermination(c, t, user.id);
  return t;
}

/** Agreements whose notice period is over end now (worker step, and before the agreement is read). Idempotent. */
export async function endDueTerminations({ sponsorshipId = null, limit = 200 } = {}) {
  let n = 0;
  const list = (await tx((c) => c.query("SELECT id FROM sponsorship_terminations WHERE status IN ('notice','agreed') AND effective_on <= current_date AND ($1::uuid IS NULL OR sponsorship_id=$1) ORDER BY effective_on, id LIMIT $2", [sponsorshipId, limit]))).rows;
  for (const { id } of list) {
    n += await tx(async (c) => {
      const t0 = (await c.query('SELECT sponsorship_id FROM sponsorship_terminations WHERE id=$1', [id])).rows[0];
      await c.query('SELECT 1 FROM sponsorships WHERE id=$1 FOR UPDATE', [t0.sponsorship_id]); // lock order: the agreement first
      const t = (await c.query("SELECT * FROM sponsorship_terminations WHERE id=$1 AND status IN ('notice','agreed') AND effective_on <= current_date FOR UPDATE", [id])).rows[0];
      if (!t) return 0;
      await applyTermination(c, t, null);
      const sp = (await c.query('SELECT s.id, s.name, s.owner_id, s.organisation_id, s.entity_id, x.department_id, x.id AS deal_id FROM sponsorships x JOIN sponsors s ON s.id=x.sponsor_id WHERE x.id=$1', [t.sponsorship_id])).rows[0];
      await notifySponsor(c, sp, 'end', { kind: 'sponsorship_update', title: 'A sponsorship agreement has ended', body: `The ${sp.name} agreement reached the end of its notice period.`, data: { sponsorship_id: sp.deal_id } }, sp.department_id).catch(() => {});
      return 1;
    });
  }
  return n;
}

/**
 * The final settlement as it stands: per currency what was committed, paid, refunded and conceded, and every item still unresolved.
 * `blocking` items must be resolved before the settlement can be finalised; the others (dues that are still owed) are carried forward
 * on record, never erased.
 */
export async function settlementOf(c, d, t) {
  const money = (await c.query(
    `SELECT o.currency,
            coalesce(sum(o.amount_cents) FILTER (WHERE o.status <> 'cancelled'),0)::bigint AS committed_cents,
            coalesce(sum(o.amount_cents) FILTER (WHERE o.status = 'cancelled'),0)::bigint AS stopped_cents,
            coalesce(sum(o.conceded_cents) FILTER (WHERE o.status <> 'cancelled'),0)::bigint AS conceded_cents
       FROM sponsorship_obligations o WHERE o.sponsorship_id=$1 AND o.kind='money' GROUP BY o.currency`, [d.id])).rows;
  const pay = (await c.query(
    `SELECT x.currency, coalesce(sum(x.amount_cents) FILTER (WHERE x.status='confirmed'),0)::bigint AS received_cents,
            coalesce(sum(x.refunded_cents),0)::bigint AS refunded_cents,
            coalesce(sum(x.amount_cents) FILTER (WHERE x.status IN ('reported','awaiting_payment')),0)::bigint AS unverified_cents
       FROM sponsorship_payments x JOIN sponsorship_obligations o ON o.id=x.obligation_id WHERE o.sponsorship_id=$1 GROUP BY x.currency`, [d.id])).rows;
  const dues = (await c.query(
    `SELECT o.id, l.label, o.kind, o.due_on::text AS due_on, o.amount_cents, o.currency, o.quantity, o.conceded_cents,
            coalesce((SELECT sum(p.amount_cents - p.refunded_cents) FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status='confirmed'),0)::bigint AS confirmed_cents,
            coalesce((SELECT sum(x.received_quantity) FROM sponsorship_deliveries x WHERE x.obligation_id=o.id AND x.status='received'),0)::int AS received_quantity
       FROM sponsorship_obligations o JOIN sponsorship_lines l ON l.id=o.line_id WHERE o.sponsorship_id=$1 AND o.status='scheduled' ORDER BY o.due_on, o.id`, [d.id])).rows;
  const items = [];
  for (const o of dues) {
    if (o.kind === 'money') {
      const left = num(o.amount_cents) - num(o.confirmed_cents) - num(o.conceded_cents);
      if (left > 0) items.push({ kind: 'due', blocking: false, ref: o.id, label: `${o.label} due ${o.due_on}`, amount_cents: left, currency: o.currency });
    } else if (o.kind === 'goods') {
      const left = num(o.quantity) - num(o.received_quantity);
      if (left > 0) items.push({ kind: 'due', blocking: false, ref: o.id, label: `${o.label} due ${o.due_on}`, quantity: left });
    } else items.push({ kind: 'due', blocking: false, ref: o.id, label: `${o.label} due ${o.due_on}` });
  }
  const lines = [
    ["SELECT x.id, x.amount_cents, x.currency, x.status FROM sponsorship_payments x JOIN sponsorship_obligations o ON o.id=x.obligation_id WHERE o.sponsorship_id=$1 AND x.status IN ('reported','awaiting_payment') ORDER BY x.created_at, x.id",
      (r) => ({ kind: 'payment', ref: r.id, label: r.status === 'reported' ? 'A reported payment is waiting for the recipient to confirm it' : 'An online checkout is still open', amount_cents: num(r.amount_cents), currency: r.currency })],
    ["SELECT x.id, x.quantity FROM sponsorship_deliveries x JOIN sponsorship_obligations o ON o.id=x.obligation_id WHERE o.sponsorship_id=$1 AND x.status='dispatched' ORDER BY x.created_at, x.id",
      (r) => ({ kind: 'delivery', ref: r.id, label: 'Goods were dispatched and their receipt is not confirmed', quantity: r.quantity })],
    ["SELECT s.id FROM sponsorship_submissions s JOIN sponsorship_obligations o ON o.id=s.obligation_id WHERE o.sponsorship_id=$1 AND s.status='submitted' ORDER BY s.created_at, s.id",
      (r) => ({ kind: 'evidence', ref: r.id, label: 'Endorsement evidence is waiting for review' })],
    ["SELECT r.id, r.quantity, r.status FROM sponsorship_returns r WHERE r.termination_id=$1 AND r.status IN ('requested','accepted') ORDER BY r.created_at, r.id",
      (r) => ({ kind: 'return', ref: r.id, label: r.status === 'requested' ? 'A return of goods is waiting for an answer' : 'Goods agreed to be returned have not arrived', quantity: r.quantity })],
    ["SELECT r.id, r.amount_cents, r.currency, r.status FROM sponsorship_refunds r WHERE r.termination_id=$1 AND r.status IN ('requested','approved') ORDER BY r.created_at, r.id",
      (r) => ({ kind: 'refund', ref: r.id, label: r.status === 'requested' ? 'A refund is waiting for an answer' : 'An approved refund has not been paid back yet', amount_cents: num(r.amount_cents), currency: r.currency })],
  ];
  for (const [sql, shape] of lines) for (const r of (await c.query(sql, [sql.includes('termination_id') ? t.id : d.id])).rows) items.push({ ...shape(r), blocking: true });
  if (t.disputed_at && !t.dispute_resolved_at) items.push({ kind: 'dispute', blocking: true, ref: t.id, label: 'The termination is disputed and the dispute is not resolved' });
  const currencies = [...new Set([...money.map((r) => r.currency), ...pay.map((r) => r.currency)])].sort();
  const per = currencies.map((currency) => {
    const m = money.find((r) => r.currency === currency), p = pay.find((r) => r.currency === currency);
    const committed = num(m?.committed_cents), received = num(p?.received_cents), refunded = num(p?.refunded_cents), conceded = num(m?.conceded_cents);
    const owed = items.filter((i) => i.kind === 'due' && i.currency === currency).reduce((s, i) => s + i.amount_cents, 0);
    return { currency, committed_cents: committed, stopped_cents: num(m?.stopped_cents), received_cents: received, refunded_cents: refunded, conceded_cents: conceded, net_received_cents: received - refunded, still_owed_cents: owed, unverified_cents: num(p?.unverified_cents) };
  });
  return { termination_id: t.id, status: t.status, currencies: per, items, blocking: items.filter((i) => i.blocking).length, carried: items.filter((i) => !i.blocking).length, can_finalise: t.status === 'ended' && !items.some((i) => i.blocking) };
}

/**
 * Goods that were actually received and can still go back: per delivery, received minus every return of it that was not declined.
 * A return can never exceed this; the database trigger enforces the same rule as a backstop.
 */
export async function returnableOf(c, d) {
  return (await c.query(
    `SELECT x.id AS delivery_id, o.id AS obligation_id, l.label, x.received_quantity,
            x.received_quantity - coalesce((SELECT sum(r.quantity) FROM sponsorship_returns r WHERE r.delivery_id=x.id AND r.status <> 'declined'),0)::int AS returnable_quantity
       FROM sponsorship_deliveries x JOIN sponsorship_obligations o ON o.id=x.obligation_id JOIN sponsorship_lines l ON l.id=o.line_id
      WHERE o.sponsorship_id=$1 AND x.status='received' AND x.received_quantity > 0 ORDER BY x.created_at, x.id`, [d.id])).rows;
}

/** Confirmed payments and how much of each can still be refunded: paid, minus refunded, minus refunds already asked for or approved. */
export async function refundableOf(c, d) {
  return (await c.query(
    `SELECT x.id AS payment_id, o.id AS obligation_id, l.label, x.amount_cents, x.currency, x.method, x.paid_on::text AS paid_on, x.refunded_cents,
            greatest(0, x.amount_cents - x.refunded_cents - coalesce((SELECT sum(r.amount_cents) FROM sponsorship_refunds r WHERE r.sponsorship_payment_id=x.id AND r.status IN ('requested','approved')),0))::bigint AS refundable_cents
       FROM sponsorship_payments x JOIN sponsorship_obligations o ON o.id=x.obligation_id JOIN sponsorship_lines l ON l.id=o.line_id
      WHERE o.sponsorship_id=$1 AND x.status='confirmed' ORDER BY x.created_at, x.id`, [d.id])).rows;
}

/**
 * Give the money back and record it against the canonical payment. Manual (bank / cash) money is confirmed as returned by the payee who approves the
 * refund; online money is refunded at the provider with an idempotent key. The due is conceded by the agreed amount, so a termination refund never
 * re-opens it as a debt. Called with the payment row locked.
 */
export async function settleRefundRow(c, r, p, actorId) {
  const got = Number(p.refunded_cents) + Number(r.amount_cents);
  await c.query("UPDATE sponsorship_payments SET refunded_cents=$2, status=CASE WHEN $2 >= amount_cents THEN 'reversed' ELSE status END, decided_at=CASE WHEN $2 >= amount_cents THEN now() ELSE decided_at END, decision_note=CASE WHEN $2 >= amount_cents THEN 'Refunded under a termination' ELSE decision_note END WHERE id=$1", [p.id, got]);
  await c.query("UPDATE sponsorship_refunds SET status='refunded', refunded_at=now() WHERE id=$1", [r.id]);
  const o = (await c.query('SELECT * FROM sponsorship_obligations WHERE id=$1 FOR UPDATE', [p.obligation_id])).rows[0];
  await settleMoney(c, o);
  await logHistory(c, o.sponsorship_id, o.version, actorId, 'refund_paid_back', `${r.amount_cents} ${r.currency}`);
}

/** The obligation is conceded by an approved refund (before it is paid back), so it stays settled. Idempotent per refund via the status transition. */
export async function concede(c, obligationId, cents) {
  await c.query('UPDATE sponsorship_obligations SET conceded_cents = conceded_cents + $2 WHERE id=$1', [obligationId, cents]);
}

export const stale = (msg = 'This termination changed; review it again') => conflict(msg, { code: 'stale_version' });
