import { one, many } from './db.js';
import { sponsorTeamSql } from './sponsor-identity-access.js';

export const published = (alias = 't') => `${alias}.status = 'published' AND ${alias}.visibility = 'public'`;

export const aggregate = (subjectType, subjectId) =>
  one(`SELECT round(avg(t.rating), 2) AS avg, count(*)::int AS n, count(*) FILTER (WHERE t.verification = 'verified_interaction')::int AS verified FROM testimonials t WHERE t.subject_type = $1 AND t.subject_id = $2 AND ${published()}`, [subjectType, subjectId]);

export const aggregateByRole = (subjectType, subjectId) =>
  many(`SELECT t.author_role, round(avg(t.rating), 2) AS avg, count(*)::int AS n FROM testimonials t WHERE t.subject_type = $1 AND t.subject_id = $2 AND ${published()} GROUP BY t.author_role`, [subjectType, subjectId]);

export const recomputeAggregate = (subjectType, subjectId) =>
  aggregate(subjectType, subjectId);

export async function manages(user, type, id) {
  switch (type) {
    case 'user':        return id === user.id;
    case 'team':        return Boolean(await one("SELECT 1 FROM teams t WHERE t.id=$2 AND (t.owner_id=$1 OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.user_id=$1 AND m.status='active' AND m.role IN ('captain','manager')))", [user.id, id]));
    case 'event':       return Boolean(await one('SELECT 1 FROM events WHERE id=$2 AND organizer_id=$1', [user.id, id]));
    case 'sponsor':     return Boolean(await one(`SELECT 1 FROM sponsors sp WHERE sp.id=$2 AND ${sponsorTeamSql('$1')}`, [user.id, id]));
    case 'product':     return Boolean(await one('SELECT 1 FROM shop_products WHERE id=$2 AND seller_id=$1', [user.id, id]));
    case 'institution': return Boolean(await one("SELECT 1 FROM organisation_members WHERE organisation_id=$2 AND user_id=$1 AND status='active' AND role IN ('owner','admin')", [user.id, id]));
    case 'programme':   return Boolean(await one("SELECT 1 FROM programmes p JOIN organisation_members m ON m.organisation_id=p.organisation_id AND m.user_id=$1 AND m.status='active' AND m.role IN ('owner','admin') WHERE p.id=$2", [user.id, id]));
    case 'official':    return Boolean(await one("SELECT 1 FROM fixture_officials fo WHERE fo.user_id=$1 AND fo.fixture_id=$2::uuid", [user.id, id])) ||
                               Boolean(await one("SELECT 1 FROM event_staff es WHERE es.user_id=$1 AND es.event_id=$2 AND es.role IN ('referee','umpire','official')", [user.id, id]));
    case 'volunteer':   return Boolean(await one("SELECT 1 FROM team_volunteer_applications va WHERE va.user_id=$1 AND va.position_id IN (SELECT id FROM team_volunteer_positions WHERE team_id=$2) AND va.status='accepted'", [user.id, id]));
    default:            return false;
  }
}

export async function eligibleFor(user, contextType, contextId) {
  const policy = await one('SELECT * FROM feedback_policies WHERE context_type=$1 AND active=true LIMIT 1', [contextType]);
  if (!policy) return { eligible: false, reason: 'No policy configured for this interaction type' };
  const checks = {
    hire:                  "SELECT h.id FROM coach_hires h WHERE h.id=$2 AND h.hirer_id=$1 AND h.status='completed'",
    appointment:           "SELECT a.id FROM appointments a WHERE a.id=$2 AND a.patient_id=$1 AND a.status='completed'",
    booking:               "SELECT b.id FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE b.id=$2 AND b.user_id=$1 AND b.status='confirmed' AND b.ends_at < now()",
    event_participation:   "SELECT er.id FROM event_registrations er WHERE er.event_id=$2 AND er.user_id=$1 AND er.status IN ('confirmed','attended')",
    order:                 "SELECT so.id FROM shop_orders so WHERE so.id=$2 AND so.buyer_id=$1 AND so.status='delivered'",
    sponsorship:           "SELECT sp.id FROM sponsorships sp WHERE sp.id=$2 AND sp.sponsor_user_id=$1 AND sp.status='active'",
    programme_enrolment:   "SELECT e.id FROM enquiries e WHERE e.id=$2 AND e.athlete_id=$1 AND e.status IN ('admitted','enrolled')",
    fixture_assignment:    "SELECT fo.id FROM fixture_officials fo WHERE fo.fixture_id=$2 AND fo.user_id!=$1 LIMIT 1",
    volunteer_assignment:  "SELECT va.id FROM team_volunteer_applications va WHERE va.id=$2 AND va.status='accepted'",
  };
  const sql = checks[contextType];
  if (!sql) return { eligible: false, reason: 'Interaction type not supported' };
  const interaction = await one(sql, [user.id, contextId]);
  if (!interaction) return { eligible: false, reason: 'No qualifying interaction found', policy };
  const windowCutoff = new Date(Date.now() - policy.window_days * 86400000).toISOString();
  return { eligible: true, evidence_type: contextType, context_id: contextId, policy, verification: 'verified_interaction', window_cutoff: windowCutoff };
}
