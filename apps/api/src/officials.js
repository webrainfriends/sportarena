// Shared invariants for fixture officials: eligibility + double-booking checks used by create, reschedule, invite and accept.
import { badRequest, conflict } from './errors.js';

export const OFFICIAL_ROLES = ['referee', 'umpire', 'linesman', 'scorer'];
const OPEN = ['invited', 'accepted'];

/** Serialise all assignment decisions for one official (released at commit/rollback). */
export const lockOfficial = (c, userId) => c.query("SELECT pg_advisory_xact_lock(hashtextextended('official:' || $1::text, 0))", [userId]);

export async function recordHistory(c, foId, actor, from, to, reason) {
  await c.query('INSERT INTO fixture_official_history(fixture_official_id, actor_id, from_status, to_status, reason) VALUES ($1,$2,$3,$4,$5)', [foId, actor, from, to, reason ?? null]);
}

/** What credential an official holds for a sport: a current referee verification, and their best active federation official licence. */
export async function credentialFor(c, userId, sportId) {
  const v = (await c.query(
    `SELECT decided_at AS verified_at, expires_at FROM verification_cases
      WHERE type='referee' AND subject_type='user' AND subject_id=$1 AND status='approved' AND expires_at > now() AND (sport_id IS NULL OR sport_id=$2)
      ORDER BY expires_at DESC LIMIT 1`, [userId, sportId])).rows[0] ?? null;
  const l = (await c.query(
    `SELECT t.grade, t.grade_rank, t.name AS licence_type, l.expires_on, b.abbreviation AS body_name
       FROM fed_licences l JOIN fed_licence_types t ON t.id=l.type_id JOIN governing_bodies b ON b.id=l.body_id
      WHERE l.holder_id=$1 AND l.status='active' AND l.expires_on >= current_date AND t.holder_role='official' AND t.sport_id=$2
      ORDER BY t.grade_rank DESC, l.expires_on DESC LIMIT 1`, [userId, sportId])).rows[0] ?? null;
  return { verified: v, licence: l };
}

/**
 * Everything that must hold before someone is invited to, accepted for or moved onto a fixture. Call after lockOfficial.
 * Sport profile, the event's credential policy, time off, and no overlap (incl. the official's own buffer) with other confirmed work.
 * `event` is the events row; `checkClash=false` skips only the time rules (used when creating before a time is fixed).
 */
export async function assertOfficialEligible(c, { event, sportId, fixtureId, userId, role, start, durationMin, checkClash = true }) {
  const sport = sportId ?? event?.sport_id;
  if (role !== 'scorer') {
    const ok = await c.query("SELECT 1 FROM active_sport_profiles WHERE user_id=$1 AND role='referee' AND sport_id=$2", [userId, sport]);
    if (!ok.rowCount) throw badRequest('That person is not a referee for this sport');
    const policy = event?.official_policy ?? 'optional';
    if (policy !== 'optional') {
      const cred = await credentialFor(c, userId, sport);
      if (policy === 'verified' && !cred.verified) throw badRequest('This competition only accepts officials with a current verified-official badge');
      if (policy === 'licensed') {
        if (!cred.licence) throw badRequest('This competition only accepts officials with a current federation licence for this sport');
        if (cred.licence.grade_rank < (event.official_min_grade_rank ?? 0)) throw badRequest(`This competition needs a licence of grade rank ${event.official_min_grade_rank} or higher`);
      }
    }
  }
  if (!checkClash) return;
  const startMs = new Date(start).getTime(), endMs = startMs + durationMin * 60000;
  const prefs = (await c.query('SELECT buffer_min FROM official_prefs WHERE user_id=$1', [userId])).rows[0];
  const bufMs = (prefs?.buffer_min ?? 0) * 60000;
  const off = await c.query(
    "SELECT 1 FROM official_availability WHERE user_id=$1 AND kind='blackout' AND archived_at IS NULL AND starts_at < $3 AND ends_at > $2 LIMIT 1",
    [userId, new Date(startMs).toISOString(), new Date(endMs).toISOString()]);
  if (off.rowCount) throw conflict('That official has marked this time as unavailable');
  const clash = await c.query(
    `SELECT 1 FROM fixtures f
      WHERE f.status IN ('scheduled','live') AND ($4::uuid IS NULL OR f.id <> $4)
        AND (f.referee_id=$1 OR EXISTS (SELECT 1 FROM fixture_officials fo WHERE fo.fixture_id=f.id AND fo.user_id=$1 AND fo.status='accepted'))
        AND f.scheduled_at < $3 AND f.scheduled_at + f.duration_min * interval '1 minute' > $2 LIMIT 1`,
    [userId, new Date(startMs - bufMs).toISOString(), new Date(endMs + bufMs).toISOString(), fixtureId ?? null]);
  if (clash.rowCount) throw conflict(bufMs ? 'Official already has a game in that window (including their travel buffer)' : 'Official already has a game in that window');
}

/** Close an open assignment, keep history, drop the referee projection and any mirrored game association. */
export async function closeOfficial(c, fo, actor, to, reason) {
  await c.query('UPDATE fixture_officials SET status=$2, reason=$3, ended_at=now(), responded_at=coalesce(responded_at, now()) WHERE id=$1', [fo.id, to, reason ?? null]);
  await recordHistory(c, fo.id, actor, fo.status, to, reason);
  if (fo.role === 'referee') await c.query('UPDATE fixtures SET referee_id=NULL WHERE id=$1 AND referee_id=$2', [fo.fixture_id, fo.user_id]);
  await c.query("UPDATE associations SET status='ended', ended_at=now() WHERE user_id=$1 AND role=$2 AND target_type='game' AND status='active' AND target_id IN (SELECT id FROM games WHERE fixture_id=$3)", [fo.user_id, fo.role, fo.fixture_id]);
}

export { OPEN };

/** One official's assignments joined to match, event and crew context. Shared by the list, the home, the calendar and the history so none of them copies fixtures. */
export const ASSIGNMENT_SQL = `
  SELECT fo.id, fo.fixture_id, fo.role, CASE WHEN fo.status='accepted' AND f.status='completed' THEN 'completed' ELSE fo.status END AS status, fo.status = 'accepted' AS confirmed, fo.needs_ack, fo.reason, fo.created_at AS requested_at, fo.fee_minor::float8 AS fee_minor, fo.fee_currency, fo.pay_status, fo.pay_confirmed_at, f.scheduled_at, f.duration_min, f.status AS fixture_status, f.round,
         e.id AS event_id, e.name AS event_name, e.official_policy, s.id AS sport_id, s.slug AS sport_slug, s.name AS sport_name, s.emoji AS sport_emoji,
         h.name AS home_name, a.name AS away_name, r.name AS resource_name, ve.name AS venue_name, ve.city AS venue_city, ve.timezone AS venue_timezone
    FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id JOIN events e ON e.id=f.event_id JOIN sports s ON s.id=e.sport_id
    LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id LEFT JOIN resources r ON r.id=f.resource_id LEFT JOIN venues ve ON ve.id=r.venue_id`;
