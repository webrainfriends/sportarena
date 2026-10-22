// Delegated authority over a sponsor brand (#283). The brand owner is always its manager, so an individual sponsor is unchanged.
// A brand linked to an organisation (sponsors.organisation_id) is also run by that organisation's staff, through the existing
// organisation_members roles: owner/admin act as manager; manager, evaluator, finance, legal, approver and auditor are the
// sponsor-specific roles. Membership is read live on every call, so revoking a person removes read, write and export access at once.
import { pool } from './db.js';
import { conflict, forbidden } from './errors.js';
import { notify } from './notify.js';

export const SPONSOR_ROLES = ['manager', 'evaluator', 'finance', 'legal', 'approver', 'auditor'];
/** Sponsor-side permission per action. Evaluators can never pay or put the brand's name to terms. */
export const SPONSOR_ACTIONS = {
  read: SPONSOR_ROLES,
  propose: ['manager', 'approver'],
  withdraw: ['manager', 'approver'],
  end: ['manager', 'approver'],
  revise: ['manager', 'legal', 'approver'], // terms the brand commits to
  pay: ['manager', 'finance'], // report a payment, dispatch goods
  evaluate: ['manager', 'evaluator'], // objectives, reviews, endorsement checks
  performance: ['manager', 'evaluator', 'auditor'], // read an athlete's shared results
  export: ['manager', 'finance', 'auditor'],
  contacts: ['manager'],
  manage: ['manager'], // link the brand to an organisation
};
// organisation role -> sponsor role (a coach has no part in sponsorship)
const FROM_ORG = { owner: 'manager', admin: 'manager', manager: 'manager', finance: 'finance', evaluator: 'evaluator', legal: 'legal', approver: 'approver', auditor: 'auditor' };
const ORG_ROLES_FOR = (action) => Object.entries(FROM_ORG).filter(([, s]) => SPONSOR_ACTIONS[action].includes(s)).map(([o]) => o);

/** The actions a sponsor role may take, for clients that hide what a role cannot use (the server still enforces). */
export const actionsFor = (role) => Object.keys(SPONSOR_ACTIONS).filter((a) => SPONSOR_ACTIONS[a].includes(role));

/**
 * The caller's live authority over a brand: `{ role, departmentId, owner, archived }` or null.
 * departmentId null means every department. A platform admin is not delegated authority (callers treat admins separately).
 */
export async function sponsorAccess(user, sponsor, c = pool) {
  if (!user || !sponsor) return null;
  if (user.id === sponsor.owner_id) return { role: 'manager', departmentId: null, owner: true, archived: false };
  if (!sponsor.organisation_id) return null;
  const r = (await c.query(
    `SELECT m.role, m.department_id, o.status FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id
      WHERE m.organisation_id=$1 AND m.user_id=$2 AND m.status='active'`, [sponsor.organisation_id, user.id])).rows[0];
  const role = r && FROM_ORG[r.role];
  return role ? { role, departmentId: r.department_id, owner: false, archived: r.status !== 'active' } : null;
}

/** Throws unless the access may do the action (and, for a department-scoped member, only on that department). */
export function assertSponsorCan(access, action, { departmentId = null, what = 'do that for this brand' } = {}) {
  if (!access) throw forbidden(`You are not part of this brand`);
  if (!SPONSOR_ACTIONS[action].includes(access.role)) throw forbidden(`Your role (${access.role}) cannot ${what}`);
  if (access.departmentId && access.departmentId !== departmentId) throw forbidden('That belongs to another department');
  if (action !== 'read' && access.archived && !access.owner) throw conflict('This brand\'s organisation is archived and read-only');
  return access;
}

/** Everyone who should hear about something that needs the given sponsor action: the owner plus live staff with that role/scope. */
export async function sponsorRecipients(c, sponsor, action = 'read', departmentId = null) {
  const ids = new Set([sponsor.owner_id]);
  if (sponsor.organisation_id) {
    const { rows } = await c.query(
      `SELECT m.user_id FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id
        WHERE m.organisation_id=$1 AND m.status='active' AND o.status='active' AND m.role = ANY($2) AND (m.department_id IS NULL OR m.department_id IS NOT DISTINCT FROM $3)`,
      [sponsor.organisation_id, ORG_ROLES_FOR(action), departmentId]);
    for (const x of rows) ids.add(x.user_id);
  }
  return [...ids];
}

export async function notifySponsor(c, sponsor, action, msg, departmentId = null, except = null) {
  for (const uid of await sponsorRecipients(c, sponsor, action, departmentId)) if (uid !== except) await notify(c, uid, msg);
}

/**
 * SQL for "deals of brands this user runs" with department scope; $n is the user id, as `sp` = sponsors and `ss` = sponsorships.
 * Reads need a role in SPONSOR_ACTIONS.read, i.e. any sponsor role (coaches are excluded).
 */
export const sponsorStaffSql = (n, action = 'read') => `(sp.owner_id=$${n} OR EXISTS (
  SELECT 1 FROM organisation_members sm JOIN organisations so ON so.id=sm.organisation_id
   WHERE sm.organisation_id=sp.organisation_id AND sm.user_id=$${n} AND sm.status='active' AND sm.role = ANY(ARRAY[${ORG_ROLES_FOR(action).map((r) => `'${r}'`).join(',')}])
     AND (sm.department_id IS NULL OR sm.department_id IS NOT DISTINCT FROM ss.department_id)))`;
