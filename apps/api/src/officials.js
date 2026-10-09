// Shared invariants for fixture officials: eligibility + double-booking checks used by create, reschedule, invite and accept.
import { badRequest, conflict } from './errors.js';

export const OFFICIAL_ROLES = ['referee', 'umpire', 'linesman', 'scorer'];
const OPEN = ['invited', 'accepted'];

/** Serialise all assignment decisions for one official (released at commit/rollback). */
export const lockOfficial = (c, userId) => c.query("SELECT pg_advisory_xact_lock(hashtextextended('official:' || $1::text, 0))", [userId]);

export async function recordHistory(c, foId, actor, from, to, reason) {
  await c.query('INSERT INTO fixture_official_history(fixture_official_id, actor_id, from_status, to_status, reason) VALUES ($1,$2,$3,$4,$5)', [foId, actor, from, to, reason ?? null]);
}

/** Sport credential + (when `checkClash`) no overlap with the official's other confirmed work. Call after lockOfficial. */
export async function assertOfficialEligible(c, { sportId, fixtureId, userId, role, start, durationMin, checkClash = true }) {
  if (role !== 'scorer') {
    const ok = await c.query("SELECT 1 FROM sport_profiles WHERE user_id=$1 AND role='referee' AND sport_id=$2", [userId, sportId]);
    if (!ok.rowCount) throw badRequest('That person is not a referee for this sport');
  }
  if (!checkClash) return;
  const end = new Date(new Date(start).getTime() + durationMin * 60000).toISOString();
  const clash = await c.query(
    `SELECT 1 FROM fixtures f
      WHERE f.status IN ('scheduled','live') AND ($4::uuid IS NULL OR f.id <> $4)
        AND (f.referee_id=$1 OR EXISTS (SELECT 1 FROM fixture_officials fo WHERE fo.fixture_id=f.id AND fo.user_id=$1 AND fo.status='accepted'))
        AND f.scheduled_at < $3 AND f.scheduled_at + f.duration_min * interval '1 minute' > $2 LIMIT 1`,
    [userId, start, end, fixtureId ?? null]);
  if (clash.rowCount) throw conflict('Official already has a game in that window');
}

/** Close an open assignment, keep history, drop the referee projection and any mirrored game association. */
export async function closeOfficial(c, fo, actor, to, reason) {
  await c.query('UPDATE fixture_officials SET status=$2, reason=$3, ended_at=now(), responded_at=coalesce(responded_at, now()) WHERE id=$1', [fo.id, to, reason ?? null]);
  await recordHistory(c, fo.id, actor, fo.status, to, reason);
  if (fo.role === 'referee') await c.query('UPDATE fixtures SET referee_id=NULL WHERE id=$1 AND referee_id=$2', [fo.fixture_id, fo.user_id]);
  await c.query("UPDATE associations SET status='ended', ended_at=now() WHERE user_id=$1 AND role=$2 AND target_type='game' AND status='active' AND target_id IN (SELECT id FROM games WHERE fixture_id=$3)", [fo.user_id, fo.role, fo.fixture_id]);
}

export { OPEN };
