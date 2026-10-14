import { one } from './db.js';

/** The single inclusion rule for every public rating, count, distribution and listing: only published, public feedback counts.
 *  Hidden, withdrawn and private feedback must never reach an average, so every consumer builds its WHERE from this. */
export const published = (alias = 't') => `${alias}.status = 'published' AND ${alias}.visibility = 'public'`;

/** Mean (null — not zero — when there are no reviews) and count of the published feedback for one subject. */
export const aggregate = (subjectType, subjectId) =>
  one(`SELECT round(avg(t.rating), 2) AS avg, count(*)::int AS n, count(*) FILTER (WHERE t.verification = 'verified_interaction')::int AS verified FROM testimonials t WHERE t.subject_type = $1 AND t.subject_id = $2 AND ${published()}`, [subjectType, subjectId]);

/** Can this user act for the subject (own or manage it)? Used to block self- and conflict-of-interest reviews. */
export async function manages(user, type, id) {
  switch (type) {
    case 'user': return id === user.id;
    case 'team': return Boolean(await one("SELECT 1 FROM teams t WHERE t.id=$2 AND (t.owner_id=$1 OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.user_id=$1 AND m.status='active' AND m.role IN ('captain','manager')))", [user.id, id]));
    case 'event': return Boolean(await one('SELECT 1 FROM events WHERE id=$2 AND organizer_id=$1', [user.id, id]));
    case 'sponsor': return Boolean(await one('SELECT 1 FROM sponsors WHERE id=$2 AND owner_id=$1', [user.id, id]));
    case 'product': return Boolean(await one('SELECT 1 FROM shop_products WHERE id=$2 AND seller_id=$1', [user.id, id]));
    case 'institution': return Boolean(await one("SELECT 1 FROM organisation_members WHERE organisation_id=$2 AND user_id=$1 AND status='active' AND role IN ('owner','admin')", [user.id, id]));
    case 'programme': return Boolean(await one("SELECT 1 FROM programmes p JOIN organisation_members m ON m.organisation_id=p.organisation_id AND m.user_id=$1 AND m.status='active' AND m.role IN ('owner','admin') WHERE p.id=$2", [user.id, id]));
    default: return false;
  }
}
