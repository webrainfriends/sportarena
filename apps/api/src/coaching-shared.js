import { many } from './db.js';

// What a coach has deliberately shared with an athlete, read the same way for the athlete and for a young person's verified guardian.
// For a young person it is shown only while a guardian's current 'coaching' consent is in force: withdrawing it hides the shared items
// everywhere (they are kept, never deleted) and allowing it again brings them back.
export const CONSENT_OK = (col) => `(NOT EXISTS (SELECT 1 FROM users yu WHERE yu.id=${col} AND yu.youth_until IS NOT NULL AND yu.youth_until > current_date)
  OR EXISTS (SELECT 1 FROM youth_consents yc WHERE yc.child_id=${col} AND yc.purpose='coaching' AND yc.revoked_at IS NULL AND yc.expires_at > now()
       AND EXISTS (SELECT 1 FROM guardian_links gl WHERE gl.guardian_id=yc.granted_by AND gl.child_id=yc.child_id AND gl.status='active' AND gl.revoked_at IS NULL AND (gl.expires_at IS NULL OR gl.expires_at > now()))))`;

export const sharedNotes = (athleteId, { limit, offset }) => many(
  `SELECT o.id, o.obs_type, o.skill_tag, o.note, o.visibility, o.observed_at, o.team_id, u.display_name AS coach_name
     FROM coaching_observations o JOIN users u ON u.id=o.coach_id
    WHERE ${CONSENT_OK('$1::uuid')} AND ((o.visibility='player' AND o.athlete_id=$1)
       OR (o.visibility='team' AND EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=o.team_id AND m.user_id=$1 AND m.status='active')))
    ORDER BY o.observed_at DESC, o.id LIMIT $2 OFFSET $3`, [athleteId, limit, offset]);

export const sharedGoals = (athleteId, { limit, offset }) => many(
  `SELECT g.id, g.title, g.category, g.athlete_text AS text, g.status, g.review_on, u.display_name AS coach_name FROM coaching_goals g JOIN users u ON u.id=g.coach_id
    WHERE ${CONSENT_OK('$1::uuid')} AND g.athlete_id=$1 AND g.athlete_text IS NOT NULL AND g.status IN ('planned','active','achieved') ORDER BY g.review_on NULLS LAST, g.id LIMIT $2 OFFSET $3`, [athleteId, limit, offset]);

export const sharedActions = (athleteId, { limit, offset }) => many(
  `SELECT a.id, a.title, a.detail, a.due_at, a.priority, a.status, a.completion_note, a.row_version, u.display_name AS coach_name FROM coaching_actions a JOIN users u ON u.id=a.coach_id
    WHERE ${CONSENT_OK('$1::uuid')} AND a.owner_id=$1 AND a.athlete_id=$1 AND a.shared ORDER BY (a.status IN ('open','in_progress')) DESC, a.due_at NULLS LAST, a.id LIMIT $2 OFFSET $3`, [athleteId, limit, offset]);

export const sharedSummaries = (athleteId, { limit, offset }) => many(
  `SELECT * FROM (
     SELECT r.id AS session_record_id, r.title, coalesce(r.started_at, r.scheduled_at, r.created_at) AS at, 'player' AS kind, s.summary, u.display_name AS coach_name
       FROM coaching_player_summaries s JOIN coaching_session_records r ON r.id=s.session_record_id JOIN users u ON u.id=r.coach_id WHERE s.athlete_id=$1 AND s.shared
     UNION ALL
     SELECT r.id, r.title, coalesce(r.started_at, r.scheduled_at, r.created_at), 'team', r.team_summary, u.display_name
       FROM coaching_session_records r JOIN users u ON u.id=r.coach_id JOIN coaching_session_participants p ON p.session_record_id=r.id AND p.athlete_id=$1 WHERE r.team_summary_shared AND r.team_summary IS NOT NULL) x
   WHERE ${CONSENT_OK('$1::uuid')} ORDER BY at DESC, session_record_id, kind LIMIT $2 OFFSET $3`, [athleteId, limit, offset]);

/** Newest published version per report for one audience ('athlete' or 'guardian'). */
export const sharedReports = (athleteId, audience, { limit, offset }) => many(
  `SELECT * FROM (SELECT DISTINCT ON (r.id) r.id AS report_id, v.version, r.title, r.kind, v.published_at, u.display_name AS coach_name FROM coaching_reports r JOIN coaching_report_versions v ON v.report_id=r.id JOIN users u ON u.id=r.coach_id
      WHERE r.athlete_id=$1 AND v.audience=$2 AND ${CONSENT_OK('r.athlete_id')} ORDER BY r.id, v.version DESC) x ORDER BY published_at DESC, report_id LIMIT $3 OFFSET $4`, [athleteId, audience, limit, offset]);
