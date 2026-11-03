// Shared helpers of the coaching workspace: who sees what of a coaching session, whatever it came from (class, booking, academy session, game, team session).
import { one, many } from './db.js';
import { CONSENT_OK } from './coaching-shared.js';

/** The participants of a record the viewer may see: themselves, and the young people they are an active guardian of. */
export const visibleParticipants = (user, recordId) => many(
  `SELECT p.athlete_id, p.attendance, u.display_name FROM coaching_session_participants p JOIN users u ON u.id=p.athlete_id
    WHERE p.session_record_id=$1 AND (p.athlete_id=$2 OR p.athlete_id IN (SELECT child_id FROM guardian_links WHERE guardian_id=$2 AND status='active' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())))
    ORDER BY (p.athlete_id=$2) DESC, u.display_name`, [recordId, user.id]);

/**
 * What the coach chose to share from one coaching record with this viewer: the shared plan version (never coach notes, groups or scopes), the viewer's
 * own attendance, summaries written for them (a young person's only under a guardian's coaching consent) and evaluations the coach has shared.
 * Returns null when the viewer is not part of the session, so callers answer 404 and never reveal that it exists.
 */
export async function sharedOutputs(user, rec) {
  const mine = await visibleParticipants(user, rec.id);
  if (!mine.length) return null;
  const people = [];
  for (const m of mine) {
    const sum = await one(`SELECT s.summary FROM coaching_player_summaries s WHERE s.session_record_id=$1 AND s.athlete_id=$2 AND s.shared AND ${CONSENT_OK('$2::uuid')}`, [rec.id, m.athlete_id]);
    people.push({ user_id: m.athlete_id, name: m.athlete_id === user.id ? null : m.display_name, attendance: m.attendance, summary: sum?.summary ?? null });
  }
  const evaluations = await many(
    `SELECT e.id, e.title, e.status, e.athlete_id, e.shared_at FROM coaching_evaluations e
      WHERE e.session_record_id=$1 AND e.status IN ('shared','responded','closed') AND e.athlete_id = ANY($2::uuid[]) AND ${CONSENT_OK('e.athlete_id')} ORDER BY e.shared_at DESC`, [rec.id, mine.map((m) => m.athlete_id)]);
  const base = { record_id: rec.id, source_type: rec.source_type, source_id: rec.source_id, title: rec.title, scheduled_at: rec.scheduled_at, people, evaluations };
  if (rec.plan_shared_version == null) return { ...base, shared: false };
  const v = await one('SELECT blocks FROM coaching_session_plan_versions WHERE session_record_id=$1 AND version=$2', [rec.id, rec.plan_shared_version]);
  const blocks = (v?.blocks ?? []).map(({ coach_notes, scope, unit, ...b }) => b);
  return { ...base, shared: true, version: rec.plan_shared_version, shared_at: rec.plan_shared_at, objective: rec.objective, blocks };
}
