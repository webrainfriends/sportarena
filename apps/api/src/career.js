// Career & membership timeline helpers (issue #311). Kept free of capability imports so teams.js can call the roster hook.
import { query } from './db.js';

export const LEVELS = ['grassroots', 'school', 'club', 'academy', 'regional', 'national', 'international', 'professional'];
export const EVIDENCE_KINDS = ['club_letter', 'registration_card', 'roster_listing', 'competition_record', 'other'];

/** Append a snapshot of the row as it now stands. Corrections and former values are never lost. */
export const snapshot = async (c, membershipId, action, actorId, reason) => (await c.query(
  `INSERT INTO career_membership_revisions(membership_id, row_version, action, snapshot, reason, actor_id)
   SELECT m.id, m.row_version, $2, to_jsonb(m) - 'idempotency_key', $3, $4 FROM career_memberships m WHERE m.id=$1 RETURNING id`, [membershipId, action, reason ?? null, actorId ?? null])).rows[0];

/** Roster hook: a player added to a team's roster opens a stint; re-joining after leaving opens a new one (team_members itself only keeps one row). */
export async function openRosterStint(c, team, userId, role, jerseyNo, position, actorId) {
  if (!['player', 'captain'].includes(role) || team.kind !== 'master') return null;
  const db = c ?? { query };
  if ((await db.query("SELECT 1 FROM career_memberships WHERE user_id=$1 AND team_id=$2 AND source='roster' AND ends_on IS NULL AND archived_at IS NULL", [userId, team.id])).rowCount) return null;
  const ins = await db.query(
    `INSERT INTO career_memberships(user_id, sport_id, team_id, starts_on, jersey_no, position, source, created_by) VALUES ($1,$2,$3,current_date,$4,$5,'roster',$6)
     ON CONFLICT DO NOTHING RETURNING id`, [userId, team.sport_id, team.id, jerseyNo ?? null, position ?? null, actorId ?? userId]);
  let mid = ins.rows[0]?.id;
  if (!mid) { // left and re-joined on the same day: re-open that stint instead of duplicating it
    mid = (await db.query("UPDATE career_memberships SET ends_on=NULL, row_version=row_version+1, updated_at=now() WHERE id=(SELECT id FROM career_memberships WHERE user_id=$1 AND team_id=$2 AND source='roster' AND starts_on=current_date AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1) RETURNING id", [userId, team.id])).rows[0]?.id;
  }
  if (mid) await snapshot(db, mid, 'roster_opened', actorId ?? userId);
  return mid ?? null;
}

/** Roster hook: leaving a team closes the open stint (it stays on the timeline as a former membership). */
export async function closeRosterStint(c, teamId, userId, actorId) {
  const db = c ?? { query };
  const rows = (await db.query("UPDATE career_memberships SET ends_on=greatest(starts_on, current_date), row_version=row_version+1, updated_at=now() WHERE user_id=$1 AND team_id=$2 AND source='roster' AND ends_on IS NULL AND archived_at IS NULL RETURNING id", [userId, teamId])).rows;
  for (const r of rows) await snapshot(db, r.id, 'roster_closed', actorId ?? userId);
  return rows.length;
}

/**
 * Entries confirmed from an outside source are shown only while they may be: for a young person that means a guardian's current participation consent
 * (read live, so revoking it hides them everywhere at once: timeline, passport links, exports, graph). The rows themselves are kept.
 */
export const extVisible = (a = 'c') => `(${a}.external_record_id IS NULL
  OR NOT EXISTS (SELECT 1 FROM users yu WHERE yu.id = ${a}.user_id AND yu.youth_until IS NOT NULL AND yu.youth_until > current_date)
  OR EXISTS (SELECT 1 FROM youth_consents yc WHERE yc.child_id = ${a}.user_id AND yc.purpose = 'participation' AND yc.revoked_at IS NULL AND yc.expires_at > now()
        AND EXISTS (SELECT 1 FROM guardian_links gl WHERE gl.guardian_id = yc.granted_by AND gl.child_id = yc.child_id AND gl.status = 'active' AND gl.revoked_at IS NULL AND (gl.expires_at IS NULL OR gl.expires_at > now()))))`;

/** The shape shown on the passport / export: canonical names resolved, no evidence, no review notes. */
export const CAREER_VIEW_SQL = `
  SELECT c.id, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji,
         coalesce(t.name, o.name, c.club_name) AS club, (c.team_id IS NULL AND c.organisation_id IS NULL) AS unlisted,
         c.team_id, coalesce(c.organisation_id, t.organisation_id) AS organisation_id, c.season_label, c.starts_on::text AS starts_on, c.ends_on::text AS ends_on, (c.ends_on IS NULL) AS current,
         c.position, c.competition_level, c.jersey_no, c.source, c.verification_status, c.verified_at, c.org_season_id, c.row_version,
         c.verified_via, (c.external_record_id IS NOT NULL) AS external,
         (SELECT es.name FROM external_history_records er JOIN external_feed_sources es ON es.id = er.source_id WHERE er.id = c.external_record_id) AS external_source
    FROM career_memberships c JOIN sports s ON s.id = c.sport_id
    LEFT JOIN teams t ON t.id = c.team_id LEFT JOIN organisations o ON o.id = c.organisation_id`;

export async function publicCareer(userId, client) {
  return (await (client ?? { query }).query(
    `${CAREER_VIEW_SQL} WHERE c.user_id=$1 AND c.archived_at IS NULL AND c.verification_status <> 'rejected' AND ${extVisible()} ORDER BY c.starts_on DESC, c.id LIMIT 200`, [userId])).rows;
}
