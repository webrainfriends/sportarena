// Delegated authority over a sponsor brand: ONE resolver (#347). A brand under a sponsor entity is run only by that entity's active
// representatives (#282); an organization sponsor's staff are mirrored into the same table (sponsor-team-sync.js), so there is no second
// source to consult. A brand with no entity yet (legacy / individual) is run by its owner. Representative role -> sponsor role:
// owner, admin and portfolio_manager act as manager; manager, approver, finance, legal, evaluator, auditor and viewer are themselves.
// Membership is read live on every call, so revoking a person removes read, write and export access at once.
import { pool } from './db.js';
import { conflict, forbidden } from './errors.js';
import { notify } from './notify.js';
import { ASSIGNED } from './sponsor-identity-access.js';

export const SPONSOR_ROLES = ['manager', 'evaluator', 'finance', 'legal', 'approver', 'auditor', 'viewer'];
/** Sponsor-side permission per action. Evaluators can never pay or put the brand's name to terms. */
export const SPONSOR_ACTIONS = {
  read: [...SPONSOR_ROLES, 'viewer'],
  propose: ['manager', 'approver'],
  withdraw: ['manager', 'approver'],
  end: ['manager', 'approver'],
  revise: ['manager', 'legal', 'approver'], // terms the brand commits to
  contract: ['manager', 'legal', 'approver'], // issue, void and send a sponsorship contract for signature (#295)
  sign_contract: ['manager', 'approver'], // put the brand's signature to a contract: only people who can bind the brand (#295)
  sign_off: ['manager', 'approver'], // accept the recipient's counteroffer: the brand is bound by it (#290)
  pay: ['manager', 'finance'], // report a payment, dispatch goods
  evaluate: ['manager', 'evaluator'], // objectives, reviews, endorsement checks
  performance: ['manager', 'evaluator', 'auditor'], // read an athlete's shared results
  export: ['manager', 'finance', 'auditor'],
  contacts: ['manager'],
  manage: ['manager'], // link the brand to an organisation
  program: ['manager', 'approver'], // run sponsorship programs and rounds, decide awards (#284)
  evaluation: ['manager', 'approver', 'evaluator', 'auditor'], // read the confidential scoring of applications (#288)
  award_approve: ['manager', 'approver'], // second approval of a large award (#289)
  award_finance: ['finance'], // finance sign-off of an award (#289)
  award_legal: ['legal'], // legal sign-off of an award (#289)
  budget_read: ['manager', 'finance', 'approver', 'auditor'], // see authorized budgets and their balances (#293)
  budget: ['manager', 'finance'], // authorize budgets, set the FX policy and rates (#293)
  pause: ['manager', 'approver'], // request, approve, withdraw or resume a pause of an agreement (#297)
  collaborate: ['manager', 'approver', 'legal', 'evaluator', 'finance'], // tasks, assignments and working notes on agreements and programs (#306)
  report: ['manager', 'finance', 'approver', 'auditor'], // portfolio dashboards: ageing, funnel, outcomes, fulfilment, renewals (#305)
  report_schedule: ['manager', 'finance'], // saved filters and scheduled delivery of those reports (#305)
  dispute: ['manager', 'finance', 'legal', 'approver'], // open, answer, flag and appeal a sponsorship dispute (#308); evaluators and viewers never see disputes
  dispute_read: ['manager', 'finance', 'legal', 'approver', 'auditor'], // read and export the disputes of the brand's agreements (#308)
  budget_approve: ['manager', 'approver', 'finance'], // second approval of an offer above a budget's threshold (#293)
};
// Representative role -> sponsor role. A portfolio manager acts as manager, but only on brands in an assigned portfolio.
export const FROM_REP = { owner: 'manager', admin: 'manager', portfolio_manager: 'manager', manager: 'manager', approver: 'approver', finance: 'finance', legal: 'legal', evaluator: 'evaluator', auditor: 'auditor', viewer: 'viewer' };
const REP_ROLES_FOR = (action, { brandWide = false } = {}) => Object.entries(FROM_REP).filter(([r, s]) => SPONSOR_ACTIONS[action].includes(s) && !(brandWide && r === 'portfolio_manager')).map(([r]) => r);
const repSql = (n, action, { brandWide = false } = {}) => `(sp.entity_id IS NOT NULL AND EXISTS (SELECT 1 FROM sponsor_representatives r WHERE r.entity_id=sp.entity_id AND r.user_id=$${n} AND r.status='active'
     AND r.role = ANY(ARRAY[${REP_ROLES_FOR(action, { brandWide }).map((r) => `'${r}'`).join(',')}]) AND (r.role<>'portfolio_manager' OR ${ASSIGNED}sp.id))
     AND ${brandWide ? 'r.department_id IS NULL' : '(r.department_id IS NULL OR r.department_id IS NOT DISTINCT FROM ss.department_id)'}))`;

/** The actions a sponsor role may take, for clients that hide what a role cannot use (the server still enforces). */
export const actionsFor = (role) => Object.keys(SPONSOR_ACTIONS).filter((a) => SPONSOR_ACTIONS[a].includes(role));

/**
 * The caller's live authority over a brand: `{ role, repRole, departmentId, owner, archived }` or null. `role` is the sponsor role that
 * SPONSOR_ACTIONS is keyed by; `repRole` is the representative role (the vocabulary the API and app show as `my_role`).
 * departmentId null means every department. A platform admin is not delegated authority (callers treat admins separately).
 */
export async function sponsorAccess(user, sponsor, c = pool) {
  if (!user || !sponsor) return null;
  // a brand under a sponsor entity is run by that entity's representatives, so the original creator keeps nothing once they leave
  if (sponsor.entity_id) {
    const rr = (await c.query(
      `SELECT r.role, r.department_id, o.status AS org_status FROM sponsor_representatives r JOIN sponsor_entities e ON e.id=r.entity_id LEFT JOIN organisations o ON o.id=e.organisation_id
        WHERE r.entity_id=$1 AND r.user_id=$2 AND r.status='active' AND (r.role<>'portfolio_manager' OR ${ASSIGNED}$3))`, [sponsor.entity_id, user.id, sponsor.id])).rows[0];
    return rr ? { role: FROM_REP[rr.role], repRole: rr.role, departmentId: rr.department_id, owner: rr.role === 'owner', archived: !!rr.org_status && rr.org_status !== 'active' } : null;
  }
  return user.id === sponsor.owner_id ? { role: 'manager', repRole: 'owner', departmentId: null, owner: true, archived: false } : null;
}

/** Throws unless the access may do the action (and, for a department-scoped member, only on that department). */
export function assertSponsorCan(access, action, { departmentId = null, what = 'do that for this brand' } = {}) {
  if (!access) throw forbidden(`You are not part of this brand`);
  if (!SPONSOR_ACTIONS[action].includes(access.role)) throw forbidden(`Your role (${access.repRole ?? access.role}) cannot ${what}`);
  if (access.departmentId && access.departmentId !== departmentId) throw forbidden('That belongs to another department');
  if (action !== 'read' && access.archived && !access.owner) throw conflict('This brand\'s organisation is archived and read-only');
  return access;
}

/** Everyone who should hear about something that needs the given sponsor action: the owner plus live staff with that role/scope. */
export async function sponsorRecipients(c, sponsor, action = 'read', departmentId = null) {
  const ids = new Set(sponsor.entity_id ? [] : [sponsor.owner_id]);
  if (sponsor.entity_id) {
    const { rows } = await c.query(
      `SELECT r.user_id FROM sponsor_representatives r JOIN sponsor_entities e ON e.id=r.entity_id LEFT JOIN organisations o ON o.id=e.organisation_id
        WHERE r.entity_id=$1 AND r.status='active' AND r.role = ANY($2) AND (o.id IS NULL OR o.status='active')
          AND (r.department_id IS NULL OR r.department_id IS NOT DISTINCT FROM $4)
          AND (r.role<>'portfolio_manager' OR EXISTS (SELECT 1 FROM sponsor_portfolio_assignments a JOIN sponsor_portfolio_brands b ON b.portfolio_id=a.portfolio_id AND b.removed_at IS NULL WHERE a.representative_id=r.id AND a.ended_at IS NULL AND b.sponsor_id=$3))`,
      [sponsor.entity_id, REP_ROLES_FOR(action), sponsor.id, departmentId]);
    for (const x of rows) ids.add(x.user_id);
  }
  return [...ids];
}

export async function notifySponsor(c, sponsor, action, msg, departmentId = null, except = null) {
  for (const uid of await sponsorRecipients(c, sponsor, action, departmentId)) if (uid !== except) await notify(c, uid, msg);
}

/**
 * SQL for "deals of brands this user runs" with department scope; $n is the user id, as `sp` = sponsors and `ss` = sponsorships.
 * Reads need a role in SPONSOR_ACTIONS.read, i.e. any sponsor role.
 */
export const sponsorStaffSql = (n, action = 'read') => `((sp.entity_id IS NULL AND sp.owner_id=$${n}) OR ${repSql(n, action)})`;

/** SQL for "brands this user runs for brand-wide work" (programs): `sp` = sponsors, $n the user id. Department-scoped members are excluded. */
export const sponsorBrandSql = (n, action = 'read') => `((sp.entity_id IS NULL AND sp.owner_id=$${n}) OR ${repSql(n, action, { brandWide: true })})`;
