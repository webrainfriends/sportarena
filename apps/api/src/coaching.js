import { many } from './db.js';
import { forbidden } from './errors.js';
import { canSeeYouth, hiddenYouth, isYouth } from './youth.js';

/**
 * Explicit, current coaching relationships (never public search or an unaccepted request).
 * Each entry says why the coach may work with the athlete: a confirmed/completed hire, a shared team where the coach
 * is an active coach member, an enrolled cohort the coach leads, or a plan the athlete has accepted and not closed.
 */
export const RELATIONSHIP_SQL = `
  SELECT h.hirer_id AS athlete_id, h.coach_id, 'hire' AS source, h.sport_id, h.id::text AS source_id
    FROM coach_hires h WHERE h.status IN ('confirmed','completed')
  UNION ALL
  SELECT a.user_id, c.user_id, 'team', t.sport_id, t.id::text
    FROM team_members c JOIN teams t ON t.id=c.team_id JOIN team_members a ON a.team_id=c.team_id
   WHERE c.role='coach' AND c.status='active' AND a.status='active' AND a.role IN ('player','captain') AND a.user_id <> c.user_id
  UNION ALL
  SELECT e.user_id, k.coach_id, 'cohort', t.sport_id, k.id::text
    FROM org_cohorts k JOIN org_enrolments e ON e.cohort_id=k.id AND e.status='enrolled' LEFT JOIN teams t ON t.id=k.team_id
   WHERE k.status='active' AND k.coach_id IS NOT NULL
  UNION ALL
  SELECT p.athlete_id, p.coach_id, 'plan', p.sport_id, p.id::text
    FROM training_plans p WHERE p.status='active' AND p.accepted_rev IS NOT NULL`;

export const relationships = (coachId, athleteId) => many(
  `SELECT source, sport_id, source_id FROM (${RELATIONSHIP_SQL}) r WHERE coach_id=$1 AND athlete_id=$2`, [coachId, athleteId]);

/** Throws unless `coach` currently has an authorised relationship with the athlete (and may see them, if a young person). */
export async function requireRelationship(coach, athleteId, sourceTypes) {
  const rels = (await relationships(coach.id, athleteId)).filter((r) => !sourceTypes || sourceTypes.includes(r.source));
  if (!rels.length) throw forbidden('You have no active coaching relationship with this athlete');
  if ((await isYouth(athleteId)) && !(await canSeeYouth(coach, athleteId))) throw forbidden('A guardian has not allowed this');
  return rels;
}

export { hiddenYouth };
export const sessionKinds = ['skill', 'tactical', 'conditioning', 'strength', 'recovery', 'mobility'];
