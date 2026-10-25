// Player funding workspace (#334): who may see an athlete's funding picture, and how a funding need is covered.
// Nothing here is a second ledger. Applications, awards, agreements, dues and payments stay in the sponsorship tables and are read live; a
// need only says "this much, for this, by then" and which of those items cover it. Access is never cached: it is re-derived on every read from
// the athlete (or a verified guardian), or from a share plus the coach's live relationship and, for a young person, a guardian's current consent.
import { query } from './db.js';
import { notFound } from './errors.js';
import { guardianLink } from './youth.js';
import { accessBlock } from './wellness-sharing.js';

export const CATEGORIES = ['equipment', 'travel', 'coaching', 'competition_fees', 'medical_rehab', 'education', 'living_training', 'other'];
export const SECTIONS = ['needs', 'applications', 'support', 'dues'];
export const PURPOSES = ['funding_planning', 'application_support', 'paperwork'];
/** Agreement statuses in which the money is committed (matches the sponsor/recipient summary). */
export const SECURED_DEAL = ['active', 'paused', 'ended', 'term_expired', 'completed'];

const db = (c) => c ?? { query };

/** The athlete themself, or a verified guardian of a young athlete. Anyone else gets 404: the workspace's existence is not revealed. */
export async function requireOwner(c, user, athleteId) {
  if (user.id === athleteId) return 'self';
  if (await guardianLink(user.id, athleteId, c)) return 'guardian';
  throw notFound('Funding workspace');
}

/**
 * How `user` may see `athleteId`'s workspace right now: { role, sections, can_export, shares }.
 * A coach needs a live (unrevoked, unexpired) share AND a current coaching relationship AND, for a young person, a guardian's current consent;
 * all three are checked on every call so a revocation, a lapsed relationship or withdrawn consent applies on the next read.
 */
export async function resolveAccess(c, user, athleteId) {
  if (user.id === athleteId || (await guardianLink(user.id, athleteId, c))) {
    return { role: user.id === athleteId ? 'self' : 'guardian', sections: [...SECTIONS], can_export: true, shares: [] };
  }
  const shares = (await db(c).query('SELECT * FROM funding_shares WHERE athlete_id=$1 AND recipient_id=$2 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at, id', [athleteId, user.id])).rows;
  if (shares.length && !(await accessBlock(db(c), athleteId, user.id, 'coach'))) {
    return { role: 'staff', sections: SECTIONS.filter((s) => shares.some((x) => x.sections.includes(s))), can_export: shares.some((x) => x.can_export), shares };
  }
  throw notFound('Funding workspace');
}

/** Why a share row cannot currently be used, or null. */
export async function shareBlock(c, s) {
  if (s.revoked_at) return 'revoked';
  if (new Date(s.expires_at) <= new Date()) return 'expired';
  return accessBlock(db(c), s.athlete_id, s.recipient_id, 'coach');
}
export const shareState = (s) => (s.revoked_at ? 'revoked' : new Date(s.expires_at) <= new Date() ? 'expired' : 'active');

export const shareEvent = (c, s, actor, action, detail = {}) =>
  c.query('INSERT INTO funding_share_events(share_id, athlete_id, recipient_id, actor_id, action, detail) VALUES ($1,$2,$3,$4,$5,$6)', [s.id, s.athlete_id, s.recipient_id, actor, action, detail]);

/**
 * Live coverage of needs. Each link is read through the item it points to: a submitted application or an unaccepted offer is `pending`,
 * an accepted award or a committed agreement is `secured`, anything that fell through is `lapsed` and covers nothing. The amount counted for a
 * link never exceeds what the item can actually give (the request, the award, or the committed cash of the agreement in that currency).
 */
export async function linksFor(c, needIds) {
  if (!needIds.length) return [];
  return (await db(c).query(
    `SELECT k.id, k.need_id, k.application_id, k.sponsorship_id, k.allocated_cents, k.created_at, k.released_at,
            CASE WHEN k.application_id IS NOT NULL THEN
                   CASE WHEN a.status='submitted' THEN 'pending'
                        WHEN a.status='awarded' THEN CASE aw.status WHEN 'accepted' THEN 'secured' WHEN 'issued' THEN 'pending' ELSE 'lapsed' END
                        ELSE 'lapsed' END
                 ELSE CASE WHEN s.status = ANY($2) THEN 'secured' WHEN s.status='proposed' THEN 'pending' ELSE 'lapsed' END END AS state,
            CASE WHEN k.application_id IS NOT NULL THEN
                   LEAST(k.allocated_cents, CASE WHEN a.status='awarded' THEN coalesce(aw.amount_cents, a.awarded_cents, 0) ELSE a.requested_cents END)
                 ELSE LEAST(k.allocated_cents, coalesce(cash.total, 0)) END AS counted_cents,
            CASE WHEN k.application_id IS NOT NULL THEN pr.name || ' · ' || psp.name ELSE coalesce(s.agreement_ref, 'Agreement') || ' · ' || ssp.name END AS label,
            coalesce(a.currency, cash.currency) AS currency
       FROM athlete_funding_links k
       LEFT JOIN sponsorship_applications a ON a.id=k.application_id
       LEFT JOIN sponsorship_programs pr ON pr.id=a.program_id LEFT JOIN sponsors psp ON psp.id=pr.sponsor_id
       LEFT JOIN LATERAL (SELECT w.status, w.amount_cents FROM sponsorship_awards w WHERE w.application_id=a.id AND w.status IN ('issued','accepted','declined','expired') ORDER BY w.created_at DESC, w.id LIMIT 1) aw ON true
       LEFT JOIN sponsorships s ON s.id=k.sponsorship_id LEFT JOIN sponsors ssp ON ssp.id=s.sponsor_id
       LEFT JOIN LATERAL (SELECT l.currency, sum(coalesce(l.total_cents, l.amount_cents * l.instalments))::bigint AS total FROM sponsorship_lines l
                           WHERE l.sponsorship_id=s.id AND l.version=coalesce(s.accepted_version, s.terms_version) AND l.kind='money' AND l.currency=(SELECT currency FROM athlete_funding_needs WHERE id=k.need_id) GROUP BY l.currency) cash ON true
      WHERE k.need_id = ANY($1::uuid[]) AND k.released_at IS NULL ORDER BY k.created_at, k.id`, [needIds, SECURED_DEAL])).rows;
}

/** Secured / pending / gap of one need from its (already counted) links. Lapsed links count for nothing. */
export function coverage(need, links) {
  const sum = (state) => links.filter((l) => l.state === state).reduce((s, l) => s + Number(l.counted_cents), 0);
  const secured = sum('secured');
  const pending = sum('pending');
  const amount = Number(need.amount_cents);
  return { secured_cents: secured, pending_cents: pending, gap_cents: Math.max(0, amount - secured - pending), met: secured >= amount };
}
