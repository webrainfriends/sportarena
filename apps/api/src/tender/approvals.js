// Approvals engine: publish, award, material changes, disqualification, late submissions and deadline decisions each need distinct human
// approvers (never the requester). A decision executes inside the same transaction as the final vote. No AI step can approve anything.
import { badRequest, forbidden, conflict, notFound } from '../errors.js';
import { auditLog, buyerRoles, can, lockProject, tellUsers, buyerIds } from './core.js';

const handlers = new Map();
export const onApproved = (kind, fn) => handlers.set(kind, fn);
export const onRejected = (kind, fn) => handlers.set(`${kind}:rejected`, fn);

/** Approvals needed: one, plus the organisation's extra approvals when the amount reaches its threshold in the same currency. */
export async function requiredApprovals(c, p, kind, amountMinor) {
  if (!p.organisation_id || !['publish', 'award'].includes(kind)) return 1;
  const pol = (await c.query('SELECT * FROM proc_policies WHERE organisation_id=$1', [p.organisation_id])).rows[0];
  if (!pol || pol.currency !== p.currency) return 1;
  const th = kind === 'publish' ? pol.publish_threshold_minor : pol.award_threshold_minor;
  return th !== null && amountMinor !== null && amountMinor !== undefined && Number(amountMinor) >= Number(th) ? 1 + pol.extra_approvals : 1;
}

export async function requestApproval(c, p, user, kind, payload = {}, reason = null, amountMinor = null) {
  const pending = (await c.query("SELECT id FROM proc_approvals WHERE project_id=$1 AND kind=$2 AND status='pending' AND payload @> $3::jsonb", [p.id, kind, JSON.stringify(payload.subject ? { subject: payload.subject } : {})])).rows[0];
  if (pending) throw conflict('That decision is already waiting for approval');
  const required = await requiredApprovals(c, p, kind, amountMinor);
  const a = (await c.query('INSERT INTO proc_approvals(project_id, kind, payload, required, requested_by, reason) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [p.id, kind, payload, required, user.id, reason])).rows[0];
  await auditLog(c, p.id, user.id, 'approval_requested', { approval_id: a.id, kind, required });
  await tellUsers(c, await buyerIds(p, ['approver']), p, 'tender_approval', 'Approval needed', `Tender ${p.ref} needs your decision (${kind.replace(/_/g, ' ')}).`, a.id);
  return a;
}

export async function castVote(c, user, approvalId, decision, reason) {
  const a0 = (await c.query('SELECT * FROM proc_approvals WHERE id=$1', [approvalId])).rows[0];
  if (!a0) throw notFound('Approval');
  const p = await lockProject(c, a0.project_id);
  const roles = await buyerRoles(user, p, c);
  if (!roles.length) throw notFound('Approval');
  if (!can(roles, 'approve')) throw forbidden('Only an approver on this tender can decide');
  const a = (await c.query('SELECT * FROM proc_approvals WHERE id=$1 FOR UPDATE', [approvalId])).rows[0];
  if (a.status !== 'pending') throw conflict(`This request was already ${a.status}`);
  if (a.requested_by === user.id) throw forbidden('You cannot approve your own request');
  if (a.payload?.subject_user === user.id) throw forbidden('You cannot decide a matter about yourself');
  if (decision === 'reject' && !reason) throw badRequest('Say why you are rejecting');
  await c.query('INSERT INTO proc_approval_votes(approval_id, user_id, decision, reason) VALUES ($1,$2,$3,$4) ON CONFLICT (approval_id, user_id) DO NOTHING', [a.id, user.id, decision, reason ?? null]);
  const votes = (await c.query('SELECT decision FROM proc_approval_votes WHERE approval_id=$1', [a.id])).rows;
  await auditLog(c, p.id, user.id, `approval_${decision}`, { approval_id: a.id, kind: a.kind, reason: reason ?? null });
  if (votes.some((v) => v.decision === 'reject')) {
    await c.query("UPDATE proc_approvals SET status='rejected', decided_at=now() WHERE id=$1", [a.id]);
    await handlers.get(`${a.kind}:rejected`)?.(c, { ...a, status: 'rejected' }, p, user);
    return { ...a, status: 'rejected', votes: votes.length };
  }
  if (votes.filter((v) => v.decision === 'approve').length >= a.required) {
    await c.query("UPDATE proc_approvals SET status='approved', decided_at=now() WHERE id=$1", [a.id]);
    await handlers.get(a.kind)?.(c, { ...a, status: 'approved' }, p, user);
    return { ...a, status: 'approved', votes: votes.length };
  }
  return { ...a, votes: votes.length };
}
