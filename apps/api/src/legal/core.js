// Shared rules for the legal-services module: pack approval state and who is currently entitled to practise where.
import { many, one } from '../db.js';
import { AppError, forbidden } from '../errors.js';
import { PACKS, PACK_VERSION, packView } from './packs.js';

/** Latest approval row per country (or a single country). */
export async function approvals(c, country) {
  const rows = (await (c ?? { query: (q, p) => many(q, p).then((rows) => ({ rows })) }).query(
    `SELECT DISTINCT ON (country) * FROM legal_pack_approvals ${country ? 'WHERE country = $1' : ''} ORDER BY country, id DESC`, country ? [country] : [])).rows;
  return Object.fromEntries(rows.map((r) => [r.country, r]));
}

export async function packFor(country, c) {
  if (!PACKS[country]) throw new AppError(400, 'bad_request', `Unsupported jurisdiction ${country}`);
  return packView(country, (await approvals(c, country))[country]);
}

/** Throws a 409 `jurisdiction_not_enabled` unless qualified local review has switched this workflow on for the country. */
export async function requireFeature(country, feature, c) {
  const p = await packFor(country, c);
  if (!p.enabled.includes(feature)) {
    throw new AppError(409, 'jurisdiction_not_enabled', `${p.name}: this workflow is switched off until qualified local counsel has approved the ${p.name} pack (${feature}). Informational search stays available.`, { country, feature, pack_version: PACK_VERSION });
  }
  return p;
}

/**
 * Credentials of a lawyer that count right now: an unarchived scope row AND an approved, unexpired, unrevoked `lawyer` verification
 * case for the same jurisdiction. Admission in one jurisdiction never counts in another.
 */
export async function verifiedCredentials(lawyerIds, { country, practiceArea } = {}, c) {
  const q = c ? (t, p) => c.query(t, p).then((r) => r.rows) : many;
  return q(
    `SELECT cr.*, v.decided_at AS verified_at, v.expires_at AS verified_until
       FROM legal_credentials cr
       JOIN LATERAL (SELECT decided_at, expires_at FROM verification_cases v WHERE v.type='lawyer' AND v.subject_type='user' AND v.subject_id=cr.user_id
                      AND v.status='approved' AND v.expires_at > now() AND upper(v.jurisdiction) = cr.jurisdiction ORDER BY decided_at DESC LIMIT 1) v ON true
      WHERE cr.user_id = ANY($1::uuid[]) AND cr.archived_at IS NULL
        AND ($2::text IS NULL OR cr.jurisdiction = $2) AND ($3::text IS NULL OR $3 = ANY(cr.practice_areas))`,
    [lawyerIds, country ?? null, practiceArea ?? null]);
}

export async function requireCredential(lawyerId, country, practiceArea, c) {
  const [cr] = await verifiedCredentials([lawyerId], { country, practiceArea }, c);
  if (!cr) throw forbidden(`This lawyer does not hold a current verified credential for ${practiceArea ? practiceArea.replace(/_/g, ' ') + ' in ' : ''}${country}. Admission in another jurisdiction does not count.`);
  return cr;
}

export const latestConflict = async (c, intakeId) => (await c.query('SELECT * FROM legal_conflict_checks WHERE intake_id=$1 ORDER BY id DESC LIMIT 1', [intakeId])).rows[0] ?? null;
export const norm = (s) => String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export { one };
