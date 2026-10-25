// Approval policy and the registry of what an approved decision does. The approver must differ from the requester (also a database CHECK).
import { forbidden, conflict, notFound } from '../errors.js';

export const handlers = new Map();           // subject_type -> async (c, approval, actor) => result   (registered by the module that owns the subject)
export const onReject = new Map();           // subject_type -> async (c, approval, actor) => void

/** Does spending `amount` (in `currency`) need a separate approver under this buyer's policy and the caller's own limit? */
export function approvalNeeded(buyer, access, amount, currency, { exception = false } = {}) {
  if (exception) return true;                                   // matching exceptions and over-limit changes always need an authorised approver
  const policy = buyer.approval_policy ?? {};
  const th = (policy.thresholds ?? []).map((t) => Number(t.above_minor)).sort((a, b) => a - b);
  if (currency !== buyer.currency && th.length) return true;    // cannot compare across currencies: be conservative
  if (th.length && amount > th[0]) return true;
  const lim = access.limits?.purchaser;
  return lim !== null && lim !== undefined && amount > lim && currency === buyer.currency;
}
export async function canApprove(c, approverAccess, approval) {
  if (!approverAccess.roles.has('approver')) throw forbidden('Only a delegated approver can decide this');
  if (approverAccess.limits.approver !== null && approverAccess.limits.approver !== undefined && Number(approval.amount_minor) > approverAccess.limits.approver) throw forbidden('This is above your approval limit');
}
export async function decide(c, user, approvalId, approve, note, accessOf) {
  const a = (await c.query('SELECT * FROM svc_approvals WHERE id=$1 FOR UPDATE', [approvalId])).rows[0];
  if (!a) throw notFound('Approval');
  const acc = await accessOf(a.buyer_id);
  if (a.status !== 'pending') throw conflict(`This approval is already ${a.status}`);
  if (a.requested_by === user.id) throw forbidden('You cannot approve your own request');
  await canApprove(c, acc, a);
  const status = approve ? 'approved' : 'rejected';
  const row = (await c.query('UPDATE svc_approvals SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1 RETURNING *', [a.id, status, user.id, note ?? null])).rows[0];
  const h = (approve ? handlers : onReject).get(a.subject_type);
  const result = h ? await h(c, row, user) : null;
  return { approval: row, result };
}
