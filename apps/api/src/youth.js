// Youth accounts: age policy, guardian authority and purpose-specific consent (issue #70).
// Rules live here so every capability (REST, OpenAPI, MCP) enforces the same thing. Nothing in this file claims legal
// compliance: policies are configuration an operator reviews for their jurisdiction.
import { one, many, query } from './db.js';
import { conflict, forbidden } from './errors.js';
import { decrypt } from './crypto.js';
import { audit, isAdmin } from './helpers.js';

export const PURPOSES = ['participation', 'medical', 'media', 'contact'];
export const RELATIONSHIPS = ['parent', 'legal_guardian', 'foster_carer', 'other'];

/** Built-in policy used when no row exists for a jurisdiction. Operators override it with set_age_policy (a new version each time). */
export const DEFAULT_POLICY = { jurisdiction: 'default', version: 1, independent_age: 18, max_guardians: 2, link_valid_days: 730, consent_max_days: 365, retention_days: 365, notes: null };

/** SQL fragments for a users row aliased `u`. youth_until is derived from the encrypted DOB and is never projected. */
export const YOUTH_SQL = '(u.youth_until IS NOT NULL AND u.youth_until > current_date)';
export const NOT_YOUTH_SQL = '(u.youth_until IS NULL OR u.youth_until <= current_date)';

export async function getPolicy(jurisdiction = 'default', client) {
  const db = client ?? { query };
  const row = (await db.query('SELECT * FROM age_policies WHERE jurisdiction=$1 ORDER BY version DESC LIMIT 1', [jurisdiction])).rows[0]
    ?? (jurisdiction === 'default' ? null : (await db.query("SELECT * FROM age_policies WHERE jurisdiction='default' ORDER BY version DESC LIMIT 1")).rows[0]);
  return row ?? DEFAULT_POLICY;
}

export const ageOf = (dob, now = new Date()) => {
  const d = new Date(dob);
  if (isNaN(d)) return null;
  let a = now.getUTCFullYear() - d.getUTCFullYear();
  if (now < new Date(Date.UTC(now.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))) a--;
  return a;
};

/** The date a person reaches the independence age (YYYY-MM-DD). */
export function independentOn(dob, independentAge) {
  const d = new Date(dob);
  if (isNaN(d)) return null;
  const t = new Date(Date.UTC(d.getUTCFullYear() + independentAge, d.getUTCMonth(), d.getUTCDate()));
  if (t.getUTCMonth() !== d.getUTCMonth()) t.setUTCDate(0); // 29 Feb -> 28 Feb
  return t.toISOString().slice(0, 10);
}

/** Recompute youth_until from the stored (encrypted) DOB. Decryption is audit-logged. Called when a DOB is saved and by the backfill. */
export async function refreshYouth(userId, actor, client) {
  const db = client ?? { query };
  const u = (await db.query('SELECT dob_enc, jurisdiction FROM users WHERE id=$1', [userId])).rows[0];
  if (!u) return null;
  let until = null;
  if (u.dob_enc) {
    await audit(client ?? null, actor ?? null, 'derive_youth_status', 'users', userId);
    const dob = decrypt(u.dob_enc, 'users.dob');
    until = independentOn(dob, (await getPolicy(u.jurisdiction, client)).independent_age);
  }
  await db.query('UPDATE users SET youth_until=$2, youth_checked_at=now() WHERE id=$1', [userId, until]);
  return until;
}

/** Existing accounts that have a DOB but were never evaluated. Idempotent; runs after migrations. */
export async function backfillYouth() {
  const { rows } = await query('SELECT id FROM users WHERE dob_enc IS NOT NULL AND youth_checked_at IS NULL');
  for (const r of rows) await refreshYouth(r.id, null);
  return rows.length;
}

export const isYouth = async (userId, client) => !!(await (client ?? { query }).query(`SELECT 1 FROM users u WHERE u.id=$1 AND ${YOUTH_SQL}`, [userId])).rows.length;

/** The live link, if `guardianId` is currently a verified, unexpired, unrevoked guardian of a child who is still youth. */
export const guardianLink = async (guardianId, childId, client) => (await (client ?? { query }).query(
  `SELECT l.* FROM guardian_links l JOIN users u ON u.id = l.child_id
    WHERE l.guardian_id=$1 AND l.child_id=$2 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) AND ${YOUTH_SQL}`, [guardianId, childId])).rows[0] ?? null;

export async function requireGuardian(user, childId, client) {
  if (isAdmin(user)) return null;
  const l = await guardianLink(user.id, childId, client);
  if (!l) throw forbidden('You are not a verified guardian of this young person');
  return l;
}

export const guardiansOf = async (childId, client) => (await (client ?? { query }).query(
  `SELECT l.guardian_id FROM guardian_links l WHERE l.child_id=$1 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) ORDER BY l.created_at, l.id`, [childId])).rows.map((r) => r.guardian_id);

/** Is there a current (granted, not revoked, not expired) consent from a currently verified guardian? Adults need none. */
export async function hasConsent(childId, purpose, client) {
  const db = client ?? { query };
  if (!(await isYouth(childId, client))) return true;
  return !!(await db.query(
    `SELECT 1 FROM youth_consents c WHERE c.child_id=$1 AND c.purpose=$2 AND c.revoked_at IS NULL AND c.expires_at > now()
        AND EXISTS (SELECT 1 FROM guardian_links l WHERE l.guardian_id=c.granted_by AND l.child_id=c.child_id AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()))`,
    [childId, purpose])).rows.length;
}

/** Block a new action for a young person unless a guardian currently consents to this purpose. Existing records are never touched. */
export async function requireConsent(childId, purpose, what, client) {
  if (!(await hasConsent(childId, purpose, client))) {
    throw conflict(`A verified guardian has not given current consent for ${what}. Ask a guardian to allow it under Family & guardians.`, { code: 'guardian_consent_required', purpose });
  }
}

/** May `viewer` see a young person's profile? Self, platform team, verified guardians, and managers of a team they currently play on with consent. */
export async function canSeeYouth(viewer, childId) {
  if (!viewer) return false;
  if (viewer.id === childId || isAdmin(viewer)) return true;
  if (await guardianLink(viewer.id, childId)) return true;
  if (!(await hasConsent(childId, 'participation'))) return false;
  return !!(await one(
    `SELECT 1 FROM team_members m JOIN teams t ON t.id=m.team_id
      WHERE m.user_id=$1 AND m.status='active' AND (t.owner_id=$2 OR EXISTS (SELECT 1 FROM team_members c WHERE c.team_id=t.id AND c.user_id=$2 AND c.status='active' AND c.role IN ('coach','manager','captain')))`, [childId, viewer.id]));
}

/** Ids among `ids` that are youth the viewer may not see. */
export async function hiddenYouth(viewer, ids) {
  if (!ids.length) return new Set();
  const youth = (await many(`SELECT u.id FROM users u WHERE u.id = ANY($1::uuid[]) AND ${YOUTH_SQL}`, [ids])).map((r) => r.id);
  const hidden = new Set();
  for (const y of youth) if (!(await canSeeYouth(viewer, y))) hidden.add(y);
  return hidden;
}
