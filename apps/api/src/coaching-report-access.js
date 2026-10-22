import { one } from './db.js';
import { isAdmin } from './helpers.js';
import { guardianLink } from './youth.js';

/**
 * May `user` read one published version of a coaching report? The author always can. Otherwise only the audience it was published for:
 * the athlete, a currently verified guardian, or an active coach of the team. Checked live on every read and download, so a revoked
 * guardian link or a coach who left the team loses access; a report already shared with the athlete stays theirs.
 * `v` needs report_id, audience and the report's coach_id, athlete_id and team_id.
 */
export async function canReadReportVersion(user, v) {
  if (!user) return false;
  if (v.coach_id === user.id || isAdmin(user)) return true;
  if (v.audience === 'athlete') return v.athlete_id === user.id;
  if (v.audience === 'guardian') return !!(v.athlete_id && (await guardianLink(user.id, v.athlete_id)));
  if (v.audience === 'team_staff') return !!(v.team_id && (await one("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active' AND role='coach'", [v.team_id, user.id])));
  return false;
}

/** One version of a report with the fields canReadReportVersion needs; the latest when `version` is omitted. */
export const reportVersionFor = (reportId, version) => one(
  `SELECT v.report_id, v.version, v.audience, v.snapshot, r.coach_id, r.athlete_id, r.team_id, r.title FROM coaching_report_versions v JOIN coaching_reports r ON r.id=v.report_id
    WHERE v.report_id=$1 AND v.version=coalesce($2::int, (SELECT max(version) FROM coaching_report_versions WHERE report_id=$1))`, [reportId, version ?? null]);
