// Beneficiaries of a sponsorship (#291). A deal may be aimed at a canonical organisation or at a durable group (an organisation
// cohort, whose members come and go). Three roles are kept apart:
//   beneficiary    - who the support is for (the organisation / group, and any allocated teams)
//   representative - a LIVE owner/admin of that organisation: accepts the deal and sets the allocations
//   payee          - a LIVE owner/admin/finance member named per allocation: receives and confirms the money; frozen on the allocation row
// Membership is read live on every call. Nothing here exposes a roster, enrolment or member count.
import { badRequest, notFound } from './errors.js';

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

/**
 * Validate a proposed allocation set against the live organisation: every beneficiary belongs to this deal, no beneficiary twice, the total is
 * at most 100%, and every payee is a live owner/admin/finance member. Returns the rows to write with the names frozen on them.
 */
export async function resolveAllocations(c, d, orgId, allocations) {
  const seen = new Set(); let total = 0;
  const wanted = [];
  for (const a of allocations) {
    const key = `${a.beneficiary_type}:${a.beneficiary_id}`;
    if (seen.has(key)) throw badRequest('The same beneficiary is allocated twice');
    seen.add(key); total += a.share_bp;
    let name;
    if (a.beneficiary_type === 'organisation') {
      if (a.beneficiary_id !== orgId || d.target_type === 'group') throw badRequest('That organisation is not a beneficiary of this sponsorship');
      name = (await c.query('SELECT name FROM organisations WHERE id=$1', [orgId])).rows[0].name;
    } else if (a.beneficiary_type === 'group') {
      const g = (await c.query("SELECT name FROM org_cohorts WHERE id=$1 AND organisation_id=$2 AND status='active'", [a.beneficiary_id, orgId])).rows[0];
      if (!g || (d.target_type === 'group' && a.beneficiary_id !== d.target_id)) throw badRequest('That group is not a beneficiary of this sponsorship');
      name = g.name;
    } else {
      const t = d.target_type === 'organisation' ? (await c.query('SELECT name FROM teams WHERE id=$1 AND organisation_id=$2', [a.beneficiary_id, orgId])).rows[0] : null;
      if (!t) throw badRequest('That team is not a beneficiary of this sponsorship');
      name = t.name;
    }
    const payee = (await c.query("SELECT u.display_name FROM organisation_members m JOIN users u ON u.id=m.user_id WHERE m.organisation_id=$1 AND m.user_id=$2 AND m.status='active' AND m.role = ANY($3)", [orgId, a.payee_user_id, PAYEE_ROLES])).rows[0];
    if (!payee) throw badRequest('The payee must be a live owner, admin or finance member of the organisation');
    wanted.push({ ...a, key, beneficiary_name: name, payee_name: payee.display_name });
  }
  if (total > 10000) throw badRequest(`Allocations total ${total / 100}%; they cannot exceed 100%`);
  return { wanted, total };
}

/** Make `wanted` the live allocation set: rows that no longer match are released (never edited or deleted), new ones are added. Returns how many rows changed. */
export async function writeAllocations(c, d, wanted, userId) {
  const current = (await c.query("SELECT * FROM sponsorship_allocations WHERE sponsorship_id=$1 AND status='active'", [d.id])).rows;
  let changed = 0;
  for (const r of current) { // an unchanged row keeps its original payee snapshot and date
    const w = wanted.find((x) => x.key === `${r.beneficiary_type}:${r.beneficiary_id}`);
    if (w && w.share_bp === r.share_bp && w.payee_user_id === r.payee_user_id) { w.keep = true; continue; }
    await c.query("UPDATE sponsorship_allocations SET status='released', released_by=$2, released_at=now() WHERE id=$1", [r.id, userId]);
    changed++;
  }
  for (const w of wanted.filter((x) => !x.keep)) {
    await c.query('INSERT INTO sponsorship_allocations(sponsorship_id, beneficiary_type, beneficiary_id, beneficiary_name, share_bp, payee_user_id, payee_name, terms_version, set_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [d.id, w.beneficiary_type, w.beneficiary_id, w.beneficiary_name, w.share_bp, w.payee_user_id, w.payee_name, d.terms_version, userId]);
    changed++;
  }
  if (changed) await c.query('UPDATE sponsorships SET allocation_rev=allocation_rev+1 WHERE id=$1', [d.id]);
  return changed;
}
