// Live reads of sporting discipline for the eligibility engine (#479 / #563): the person's blocking sanctions are READ at evaluation time, never copied
// into a squad or a registration, so stale squad data can never bypass a suspension. Served matches are derived from completed fixtures, not from a counter.
import { serviceOf, blocksOn } from './discipline.js';

/** The first sanction that blocks `userId` on `day` in the competition behind `event` (scope 'competition') or in the sport (scope 'sport'). */
export async function blockingSanction(db, userId, event, day) {
  const comp = (await db.query('SELECT competition_id FROM comp_seasons WHERE event_id=$1', [event.id])).rows[0]?.competition_id ?? null;
  const rows = (await db.query(
    `SELECT s.* FROM disc_sanctions s
      WHERE s.subject_user_id=$1 AND s.superseded_at IS NULL AND s.status IN ('interim','active') AND s.kind IN ('match_suspension','date_suspension','competition_ban','role_suspension')
        AND ((s.scope='competition' AND s.competition_id=$2) OR (s.scope='sport' AND coalesce(s.sport_id, (SELECT sport_id FROM comp_competitions WHERE id=s.competition_id))=$3))
      ORDER BY s.decided_at, s.id`, [userId, comp, event.sport_id])).rows;
  for (const s of rows) {
    let service = null;
    if (s.kind === 'match_suspension') service = await serviceFor(db, s);
    if (blocksOn(s, day, service)) return { id: s.id, kind: s.kind, case_id: s.case_id, valid_until: s.ends_on ?? null, remaining: service?.remaining ?? null };
  }
  return null;
}

/** Served / remaining for one match suspension: the sanctioned team's fixtures across the competition's seasons. */
export async function serviceFor(db, s) {
  const fx = (await db.query(
    `SELECT f.id, f.status, f.scheduled_at FROM fixtures f JOIN comp_seasons cs ON cs.event_id=f.event_id
      WHERE cs.competition_id=$1 AND (f.home_team_id=$2 OR f.away_team_id=$2) AND f.scheduled_at::date >= $3::date`, [s.competition_id, s.team_id, s.starts_on])).rows;
  return serviceOf(s, fx);
}

/**
 * A canonical match event was corrected or voided: every disciplinary case raised from it (or from its fixture's result) is FLAGGED for re-evaluation.
 * Decisions are never deleted or silently rewritten; a person must review and either confirm or amend them.
 */
export async function flagSourceCorrection(db, { sourceType = 'match_event', sourceId = null, fixtureId = null, reason, actorId = null }) {
  const rows = (await db.query(
    `UPDATE gov_cases SET needs_review=true, review_reason=left($4,300), row_version=row_version+1, updated_at=now()
      WHERE status NOT IN ('withdrawn','dismissed') AND needs_review=false
        AND ((source->>'type'=$1 AND source->>'id'=$2::text) OR ($3::uuid IS NOT NULL AND fixture_id=$3::uuid)) RETURNING id, row_version, status`,
    [sourceType, sourceId, fixtureId, reason])).rows;
  for (const r of rows) await db.query("INSERT INTO gov_case_events(case_id,version,action,from_status,to_status,actor_id,detail) VALUES ($1,$2,'flagged',$3,$3,$4,$5)", [r.id, r.row_version, r.status, actorId, { reason }]);
  return rows.length;
}
