// Unified training and match load history (#328). One table (session_loads) stays the single source of load: manual logs, confirmed
// completed training sessions and verified match appearances all become rows there, so the acute:chronic ratio, readiness and shared
// workload views count each session exactly once. Minutes and RPE are always the athlete's own entry or confirmation, never inferred.
import { badRequest, conflict } from './errors.js';
import { encrypt, decrypt } from './crypto.js';
import { hasConsent } from './youth.js';

export const SOURCES = ['training_session', 'match'];
const VERIFIED_BASES = ['match_clock', 'staff_entry', 'official_sheet'];

export const LOAD_COLS = `l.id, l.session_date::text AS session_date, l.kind, l.minutes, l.rpe, l.load, l.source, l.training_session_id, l.appearance_id,
  l.minutes_basis, l.row_version, l.created_at, l.updated_at, l.archived_at,
  (SELECT count(*)::int FROM session_load_revisions r WHERE r.load_id=l.id AND r.action='corrected') AS corrections`;

export const snapshot = (l) => ({ session_date: l.session_date, kind: l.kind, minutes: l.minutes, rpe: l.rpe, source: l.source, minutes_basis: l.minutes_basis });

/** Append one revision. `c` is a transaction client so the change and its history commit together. */
export const revise = (c, l, actor, action, before, reason) => c.query(
  'INSERT INTO session_load_revisions(load_id, user_id, actor_id, action, row_version, before, after, reason_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
  [l.id, l.user_id, actor, action, l.row_version, before ? JSON.stringify(before) : null, JSON.stringify(snapshot(l)), encrypt(reason, 'session_load_revisions.reason')]);
export const reasonOf = (r) => decrypt(r, 'session_load_revisions.reason');

const TRAINING_KIND = { skill: 'training', tactical: 'training', conditioning: 'training', strength: 'gym', recovery: 'other', mobility: 'other' };
export const loadKindFor = (source, sessionKind) => (source === 'match' ? 'match' : TRAINING_KIND[sessionKind] ?? 'training');

/**
 * The confirmed, completed sources of `userId` in [from, to] (UTC dates). A training session counts once the athlete marked it completed; a
 * match counts once the athlete has a verified appearance as a starter or substitute who came on in a finished fixture. Archived loads free
 * their source again. `onlyId` narrows to one source for validation.
 */
export async function sourcesFor(c, userId, { from, to, source, sourceId, pendingOnly = true, includeMatches = true, includeTraining = true }) {
  const out = [];
  if (includeTraining && (!source || source === 'training_session')) {
    out.push(...(await c.query(
      `SELECT s.id, 'training_session' AS source, (s.starts_at AT TIME ZONE 'UTC')::date::text AS date, s.duration_min AS planned_minutes, NULL::float AS verified_minutes, s.kind AS session_kind,
              s.title, p.title AS context, s.athlete_rpe AS reported_rpe, s.completed_at,
              (SELECT l.id FROM session_loads l WHERE l.training_session_id=s.id AND l.archived_at IS NULL) AS load_id
         FROM training_sessions s JOIN training_plans p ON p.id=s.plan_id
        WHERE p.athlete_id=$1 AND s.status='completed' AND (s.starts_at AT TIME ZONE 'UTC')::date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR s.id=$4)
        ORDER BY s.starts_at DESC, s.id`, [userId, from, to, sourceId ?? null])).rows);
  }
  if (includeMatches && (!source || source === 'match')) {
    out.push(...(await c.query(
      `SELECT a.id, 'match' AS source, (f.scheduled_at AT TIME ZONE 'UTC')::date::text AS date, NULL::int AS planned_minutes,
              CASE WHEN a.minutes_played IS NOT NULL AND a.minutes_basis = ANY($5::text[]) THEN a.minutes_played::float END AS verified_minutes,
              'match' AS session_kind, coalesce(t.name, 'Match') AS title, ev.name AS context, NULL::int AS reported_rpe, f.scheduled_at AS completed_at,
              (SELECT l.id FROM session_loads l WHERE l.appearance_id=a.id AND l.archived_at IS NULL) AS load_id
         FROM match_appearances a JOIN fixtures f ON f.id=a.fixture_id LEFT JOIN events ev ON ev.id=f.event_id LEFT JOIN teams t ON t.id=a.team_id
        WHERE a.user_id=$1 AND a.archived_at IS NULL AND f.status IN ('finished','completed') AND a.status IN ('started','substitute_on')
          AND (f.scheduled_at AT TIME ZONE 'UTC')::date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR a.id=$4)
        ORDER BY f.scheduled_at DESC, a.id`, [userId, from, to, sourceId ?? null, VERIFIED_BASES])).rows);
  }
  const rows = out.sort((a, b) => b.date.localeCompare(a.date) || String(a.id).localeCompare(String(b.id)));
  return pendingOnly ? rows.filter((r) => !r.load_id) : rows;
}

/** Minutes a record may take from a source: the athlete's explicit entry, or a verified match clock; never a guess. */
export function resolveMinutes(src, entered) {
  if (entered !== undefined && entered !== null) {
    const verified = src.verified_minutes === null || src.verified_minutes === undefined ? null : Math.max(1, Math.round(src.verified_minutes));
    return { minutes: entered, basis: verified !== null && verified === entered && src.source === 'match' ? 'match_verified' : 'athlete_entered' };
  }
  if (src.source === 'match' && src.verified_minutes !== null && src.verified_minutes !== undefined) {
    const m = Math.round(src.verified_minutes);
    if (m < 1) throw badRequest('This match has under a minute of verified playing time; enter the minutes you played');
    return { minutes: m, basis: 'match_verified' };
  }
  throw badRequest(src.source === 'match' ? 'No verified playing time for this match: enter the minutes you actually played' : 'Enter the minutes you actually trained: the planned length is not assumed', { field: 'minutes' });
}

export function resolveRpe(src, entered) {
  const rpe = entered ?? src.reported_rpe ?? null;
  if (rpe === null) throw badRequest('Enter how hard it felt (RPE 1-10): effort is never inferred', { field: 'rpe' });
  return rpe;
}

/** Manual, unlinked loads on the same day and of a compatible kind: the ones that may already be this session. */
export async function manualCandidates(c, userId, date, kind) {
  return (await c.query(
    `SELECT id, session_date::text AS session_date, kind, minutes, rpe, load, row_version FROM session_loads
      WHERE user_id=$1 AND source='manual' AND archived_at IS NULL AND session_date=$2 AND ($3 <> 'match' OR kind IN ('match','other')) AND ($3 = 'match' OR kind <> 'match')
      ORDER BY created_at, id`, [userId, date, kind])).rows;
}

export const staleCheck = (row, expected) => {
  if (row.row_version !== expected) throw conflict('This record changed since you opened it; reload and try again', { code: 'stale_version', row_version: row.row_version });
};

/** Which source kinds this person may currently see: a young person needs a guardian's live consent for coaching (training) and participation (matches). */
export async function sourceAccess(userId, c) {
  return { training_session: await hasConsent(userId, 'coaching', c), match: await hasConsent(userId, 'participation', c) };
}
export const CONSENT_PURPOSE = { training_session: 'coaching', match: 'participation' };
