// Beneficiaries of a sponsorship (#291). A deal may be aimed at a canonical organisation or at a durable group (an organisation
// cohort, whose members come and go). Three roles are kept apart:
//   beneficiary    - who the support is for (the organisation / group, and any allocated teams)
//   representative - a LIVE owner/admin of that organisation: accepts the deal and sets the allocations
//   payee          - a LIVE owner/admin/finance member named per allocation: receives and confirms the money; frozen on the allocation row
// Membership is read live on every call. Nothing here exposes a roster, enrolment or member count.
import { notFound } from './errors.js';

export const ORG_TARGETS = ['organisation', 'group'];
export const PAYEE_ROLES = ['owner', 'admin', 'finance'];
export const REP_ROLES = ['owner', 'admin'];

/** SQL: the deal `a` is aimed at an organisation/group where user `u` is a live representative or a live payee. */
export const beneficiaryScopeSql = (u, a = 'ss') => `(${a}.target_type IN ('organisation','group') AND EXISTS (
  SELECT 1 FROM organisation_members m JOIN organisations bo ON bo.id=m.organisation_id
   WHERE m.user_id=${u} AND m.status='active' AND bo.status='active'
     AND m.organisation_id = CASE ${a}.target_type WHEN 'organisation' THEN ${a}.target_id ELSE (SELECT bc.organisation_id FROM org_cohorts bc WHERE bc.id=${a}.target_id) END
     AND (m.role IN ('owner','admin') OR (m.role IN ('owner','admin','finance') AND EXISTS (SELECT 1 FROM sponsorship_allocations al WHERE al.sponsorship_id=${a}.id AND al.status='active' AND al.payee_user_id=m.user_id)))))`;

/** The organisation a deal's target belongs to (null for event/team/athlete targets). */
export async function targetOrgId(c, type, targetId) {
  if (type === 'organisation') {
    const r = await c.query('SELECT id FROM organisations WHERE id=$1', [targetId]);
    if (!r.rows[0]) throw notFound('Organisation');
    return r.rows[0].id;
  }
  if (type === 'group') {
    const r = await c.query('SELECT organisation_id FROM org_cohorts WHERE id=$1', [targetId]);
    if (!r.rows[0]) throw notFound('Group');
    return r.rows[0].organisation_id;
  }
  return null;
}

/** Oldest active owner: the person notified for an organisation (never someone who left). */
export async function primaryContact(c, orgId) {
  const r = await c.query("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND role='owner' AND status='active' ORDER BY joined_at NULLS LAST, id LIMIT 1", [orgId]);
  return r.rows[0]?.user_id ?? null;
}

/** What the user is on this deal's beneficiary side: { orgId, representative, payee } or null for other target types. */
export async function beneficiaryAccess(c, userId, d) {
  const orgId = await targetOrgId(c, d.target_type, d.target_id).catch(() => null);
  if (!orgId) return null;
  const m = (await c.query("SELECT m.role FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id WHERE m.organisation_id=$1 AND m.user_id=$2 AND m.status='active' AND o.status='active'", [orgId, userId])).rows[0];
  const representative = !!m && REP_ROLES.includes(m.role);
  const payee = !!m && PAYEE_ROLES.includes(m.role) && (await c.query("SELECT 1 FROM sponsorship_allocations WHERE sponsorship_id=$1 AND status='active' AND payee_user_id=$2", [d.id, userId])).rowCount > 0;
  return { orgId, representative, payee, any: representative || payee };
}

/** The payees in force now, with each one's share of an amount (rounded down; the remainder is reported, never invented). */
export async function payeeSnapshot(c, sponsorshipId, amountCents) {
  const { rows } = await c.query("SELECT beneficiary_type, beneficiary_id, beneficiary_name, share_bp, payee_user_id, payee_name FROM sponsorship_allocations WHERE sponsorship_id=$1 AND status='active' ORDER BY created_at, id", [sponsorshipId]);
  if (!rows.length) return null;
  const allocations = rows.map((r) => ({ ...r, amount_cents: Math.floor((Number(amountCents) * r.share_bp) / 10000) }));
  return { allocations, unallocated_cents: Number(amountCents) - allocations.reduce((s, a) => s + a.amount_cents, 0) };
}
