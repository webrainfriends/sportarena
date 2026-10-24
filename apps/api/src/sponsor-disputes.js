// Sponsorship disputes, complaints and risk controls (#308). A dispute is a canonical support case (cases.js) plus a sponsorship_disputes row
// saying what it is about. Opening one never changes a due, a payment, a delivery or any evidence: the disputed record is only marked
// "contested". A resolution that moves money does it through the canonical obligation (conceded_cents), never a parallel ledger.
import { encrypt } from './crypto.js';
import { ORG_TARGETS } from './sponsor-beneficiaries.js';
import { forbidden, notFound } from './errors.js';
import { concede } from './sponsor-termination.js';
import { logHistory, settleMoney } from './sponsor-agreements.js';

export const LIVE = ['open', 'under_review', 'appealed'];
export const FLAG_KINDS = ['amount_mismatch', 'suspected_fraud', 'duplicate_claim', 'evidence_concern', 'consent_concern', 'other'];
export const APPEAL_DAYS = 14;
const num = (v) => Number(v ?? 0);

/** What the dispute's creator sees on the case: a short subject line. */
export const SUBJECT_LABEL = { agreement: 'Agreement', payment: 'Payment', goods: 'Goods delivery', evidence: 'Endorsement evidence' };

/**
 * The caller's standing on a dispute: `side` is 'sponsor' | 'recipient' | 'reviewer'. Sponsor staff need the dispute permissions of their live
 * role (an evaluator never sees disputes); an organisation recipient must be its owner/admin; a platform admin sees a dispute only while an
 * assigned reviewer. Everything else is "not found" so ids cannot be probed.
 */
export async function standing(c, ctx, dispute, user, { write = false } = {}) {
  if (ctx.role === 'sponsor') { ctx.need(write ? 'dispute' : 'dispute_read', write ? 'act on a dispute' : 'read disputes'); return 'sponsor'; }
  if (ctx.role === 'recipient') {
    if (ORG_TARGETS.includes(ctx.d.target_type) && !ctx.beneficiary?.representative) throw forbidden('Only an owner or admin of the organisation can handle disputes');
    return 'recipient';
  }
  if (dispute && (await c.query('SELECT 1 FROM sponsorship_dispute_reviewers WHERE dispute_id=$1 AND user_id=$2 AND removed_at IS NULL', [dispute.id, user.id])).rowCount) return 'reviewer';
  throw notFound('Dispute');
}

/** May a platform team member work this case? Cases that are not sponsorship disputes keep the existing rule; a dispute needs an assigned review. */
export async function staffMayOpenCase(c, userId, caseId) {
  const d = (await c.query('SELECT id FROM sponsorship_disputes WHERE case_id=$1', [caseId])).rows[0];
  if (!d) return true;
  return (await c.query('SELECT 1 FROM sponsorship_dispute_reviewers WHERE dispute_id=$1 AND user_id=$2 AND removed_at IS NULL', [d.id, userId])).rowCount > 0;
}
export const isDisputeCase = async (c, caseId) => (await c.query('SELECT 1 FROM sponsorship_disputes WHERE case_id=$1', [caseId])).rowCount > 0;

/** The record a dispute is about, checked to belong to this agreement; returns the columns to store and the money ceiling (never client supplied). */
export async function resolveSubject(c, deal, i) {
  const need = (v, what) => { if (!v) throw notFound(what); return v; };
  if (i.subject_type === 'agreement') {
    const out = { obligation_id: null, ceiling: null, link: { type: 'sponsorship', id: deal.id } };
    if (i.obligation_id) {
      const o = need((await c.query("SELECT id, kind, currency, amount_cents FROM sponsorship_obligations WHERE id=$1 AND sponsorship_id=$2 AND status <> 'cancelled'", [i.obligation_id, deal.id])).rows[0], 'Obligation');
      Object.assign(out, { obligation_id: o.id, link: { type: 'sponsorship_obligation', id: o.id } });
    }
    return out;
  }
  if (i.subject_type === 'payment') {
    const p = need((await c.query('SELECT x.*, o.sponsorship_id FROM sponsorship_payments x JOIN sponsorship_obligations o ON o.id=x.obligation_id WHERE x.id=$1 AND o.sponsorship_id=$2', [i.subject_id, deal.id])).rows[0], 'Payment');
    return { payment_id: p.id, obligation_id: p.obligation_id, ceiling: { cents: num(p.amount_cents), currency: p.currency }, link: { type: 'sponsorship_payment', id: p.id } };
  }
  if (i.subject_type === 'goods') {
    const x = need((await c.query('SELECT x.* FROM sponsorship_deliveries x JOIN sponsorship_obligations o ON o.id=x.obligation_id WHERE x.id=$1 AND o.sponsorship_id=$2', [i.subject_id, deal.id])).rows[0], 'Delivery');
    return { delivery_id: x.id, obligation_id: x.obligation_id, ceiling: null, link: { type: 'sponsorship_delivery', id: x.id } };
  }
  const s = need((await c.query('SELECT s.* FROM sponsorship_submissions s JOIN sponsorship_obligations o ON o.id=s.obligation_id WHERE s.id=$1 AND o.sponsorship_id=$2', [i.subject_id, deal.id])).rows[0], 'Evidence');
  return { submission_id: s.id, obligation_id: s.obligation_id, ceiling: null, link: { type: 'sponsorship_submission', id: s.id } };
}

/** What a due still owes: committed, minus net confirmed payments, minus anything already conceded. */
export async function outstanding(c, o) {
  const paid = num((await c.query("SELECT coalesce(sum(amount_cents - refunded_cents),0) AS s FROM sponsorship_payments WHERE obligation_id=$1 AND status='confirmed'", [o.id])).rows[0].s);
  return Math.max(0, num(o.amount_cents) - paid - num(o.conceded_cents));
}

/**
 * Apply a concession to the canonical obligation. The caller holds the agreement and the dispute locked. The amount can never exceed what the
 * due still owes or the disputed amount, and is in the due's own currency. Returns the adjustment row.
 */
export async function applyConcession(c, dispute, { obligation_id, amount_cents }, round, actorId) {
  const o = (await c.query('SELECT * FROM sponsorship_obligations WHERE id=$1 AND sponsorship_id=$2 FOR UPDATE', [obligation_id, dispute.sponsorship_id])).rows[0];
  if (!o || o.kind !== 'money' || o.status === 'cancelled') return { error: 'Choose a money due of this agreement that is still open' };
  if (dispute.currency && dispute.currency !== o.currency) return { error: `This dispute is in ${dispute.currency}; the due is in ${o.currency}` };
  if (dispute.disputed_cents && amount_cents > num(dispute.disputed_cents)) return { error: 'A concession cannot be more than the disputed amount' };
  const left = await outstanding(c, o);
  if (amount_cents > left) return { error: `Only ${left} ${o.currency} is still owed on that due` };
  await concede(c, o.id, amount_cents);
  const row = (await c.query('INSERT INTO sponsorship_dispute_adjustments(dispute_id, round, obligation_id, amount_cents, currency, applied_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [dispute.id, round, o.id, amount_cents, o.currency, actorId])).rows[0];
  await settleMoney(c, { ...o, conceded_cents: num(o.conceded_cents) + amount_cents });
  await logHistory(c, dispute.sponsorship_id, o.version, actorId, 'dispute_concession', `${amount_cents} ${o.currency}`);
  return { adjustment: row };
}

export const enc = (body) => encrypt(body, 'case_messages.body');
