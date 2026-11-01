// Federation governance at scale (#525): maker-checker (four eyes). A body (or any body above it) can require a second person for a high-impact action.
// The maker asks (`request_federation_approval`), a different, entitled person decides, and the maker then repeats the original action with the approval id.
// An approval covers exactly one request (a hash of what was asked), is used once, expires, and is never edited: decisions and use are append-only facts.
import { createHash } from 'node:crypto';
import { pool } from './db.js';
import { conflict, forbidden } from './errors.js';
import { authority, can, lineage, logFed } from './federation.js';

/** Action → what it covers, which federation permission a checker needs, and what the approval is about. */
export const APPROVAL_ACTIONS = {
  affiliation_approve: { label: 'Approve an affiliation', perm: 'affiliations', subject: 'affiliation' },
  affiliation_suspend: { label: 'Suspend an affiliation', perm: 'affiliations', subject: 'affiliation' },
  eligibility_override: { label: 'Approve over a failed requirement (eligibility override)', perm: 'affiliations', subject: 'affiliation' },
  credential_exception: { label: 'Issue a licence over a failed requirement (credential exception)', perm: 'licences', subject: 'licence' },
  sanction_approve: { label: 'Sanction a competition', perm: 'sanctions', subject: 'sanction' },
  policy_publish: { label: 'Publish a requirement version', perm: 'governance', subject: 'policy' },
  bulk_export: { label: 'Export a report as a file', perm: 'reports', subject: 'report' },
};

/** Stable hash of a request, so an approval for one set of terms cannot be used for another. */
export const hashOf = (obj) => createHash('sha256').update(JSON.stringify(obj, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v))).digest('hex');

/**
 * Is four-eyes required for `action` on this body? A rule set on any body above it binds everything below: a child can ask for more, never for less.
 * Returns the node that set it (provenance) or null.
 */
export async function ruleFor(bodyId, action, c = pool) {
  const chain = await lineage(bodyId, c);
  const r = await c.query(
    `SELECT DISTINCT ON (r.body_id) r.body_id, r.required, r.set_at, r.reason FROM fed_approval_rules r WHERE r.body_id = ANY($1) AND r.action=$2 ORDER BY r.body_id, r.set_at DESC`, [chain, action]);
  const hit = r.rows.filter((x) => x.required).sort((a, b) => chain.indexOf(b.body_id) - chain.indexOf(a.body_id))[0];   // the highest node wins as the stated source
  return hit ? { body_id: hit.body_id, set_at: hit.set_at, reason: hit.reason } : null;
}

/** All rules in force for a body, with where each comes from. */
export async function rulesFor(bodyId, c = pool) {
  const out = {};
  for (const action of Object.keys(APPROVAL_ACTIONS)) out[action] = await ruleFor(bodyId, action, c);
  return out;
}

/** How a person is entitled to decide `perm` on this body: their own role/admin, a delegation, or a role on a body above it (central oversight). Null if not. */
export async function checkerAuthority(user, bodyId, perm, c = pool) {
  const auth = await authority(user, bodyId, { c, optional: true });
  if (auth && can(auth, perm)) return auth.admin ? 'admin' : auth.roles.some((r) => r.delegated && PERMS_OF(perm).includes(r.role)) ? 'delegation' : 'role';
  const above = (await lineage(bodyId, c)).filter((x) => x !== bodyId);
  if (!above.length) return null;
  for (const b of above) {
    const a = await authority(user, b, { c, optional: true });
    if (a && !a.viaAncestor && can(a, perm)) return 'ancestor';
  }
  return null;
}
const PERMS_OF = (perm) => ({ affiliations: ['registrar'], licences: ['licensing'], sanctions: ['sanctioner'], governance: ['secretary'], reports: ['auditor', 'compliance', 'registrar', 'licensing', 'sanctioner', 'secretary'] }[perm] ?? []);

/**
 * The gate each guarded action calls inside its own transaction. With no rule it returns null (nothing changes). With a rule it needs an approved,
 * unused, unexpired approval that this person asked for, for exactly this action, subject and request; it marks the approval used and returns it.
 */
export async function gate(c, user, { bodyId, actions, subjectType, subjectId, request, approvalId }) {
  // `actions` lists the rule keys that could govern this step, most specific first; the first one that has a rule in force is the one that applies.
  let action = null, rule = null;
  for (const k of actions) { rule = await ruleFor(bodyId, k, c); if (rule) { action = k; break; } }
  if (!rule) return null;
  if (!approvalId) throw conflict(`${APPROVAL_ACTIONS[action].label} needs a second person's approval first. Ask for it, then repeat this action with the approval id.`, { code: 'approval_required', action, rule_body_id: rule.body_id });
  const a = (await c.query('SELECT * FROM fed_approvals WHERE id=$1 FOR UPDATE', [approvalId])).rows[0];
  const bad = (why) => conflict(`That approval cannot be used: ${why}`, { code: 'approval_invalid' });
  if (!a || a.body_id !== bodyId || a.action !== action || a.subject_type !== subjectType || a.subject_id !== subjectId) throw bad('it is for something else');
  if (a.requested_by !== user.id) throw forbidden('Only the person who asked for the approval can use it');
  if (a.status !== 'approved') throw bad(`it is ${a.status}`);
  if (a.consumed_at) throw bad('it has already been used');
  if (new Date(a.expires_at) < new Date()) throw bad('it has expired');
  if (a.payload_hash !== hashOf(request)) throw bad('the request differs from the one that was approved');
  await c.query('UPDATE fed_approvals SET consumed_at=now(), consumed_by=$2 WHERE id=$1', [a.id, user.id]);
  await logFed(c, bodyId, 'approval', a.id, 'used', { actor: user.id, detail: { action, subject_type: subjectType, subject_id: subjectId, approved_by: a.decided_by } });
  return a;
}
