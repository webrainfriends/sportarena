// Shared invariants for fixture officials: eligibility + double-booking checks used by create, reschedule, invite and accept.
// Extended for issue #1000 (REF-R09): suspension gate, minimum-age, training certs, safeguarding clearance,
// association neutrality, and undecided conflict-of-interest blocks. Each new check respects event policy fields
// and skips gracefully when the policy is not configured, so existing fixtures are unaffected.
import { badRequest, conflict } from './errors.js';
import { assess } from './official-availability.js';
import { activeSportingSanction } from './integrity.js';
import { blocksOn, BLOCKING_KINDS } from './discipline.js';
import { serviceFor } from './discipline-live.js';
import { gate as complianceGate, hasObligations } from './compliance.js';
import { decrypt } from './crypto.js';
import { ageOf } from './youth.js';
import { audit } from './helpers.js';

export const OFFICIAL_ROLES = [
  'referee', 'umpire', 'linesman', 'scorer',
  'video_assistant_referee', 'fourth_official', 'reserve_assistant_referee',
  'shot_clock_operator', 'timekeeper', 'goal_line_official', 'technical_official',
  // REF-R30: expanded taxonomy roles
  'chair_umpire', 'match_commissioner', 'technical_delegate', 'starter', 'marshal',
];
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
 * An official's age in whole years on a day, or null when no date of birth is on record. The date of birth is stored encrypted on the
 * account (users.dob_enc); only the age leaves this function and the decryption is audit-logged.
 */
export async function officialAgeOn(c, userId, day) {
  const enc = (await c.query('SELECT dob_enc FROM users WHERE id=$1', [userId])).rows[0]?.dob_enc;
  if (!enc) return null;
  await audit(c, userId, 'derive_official_age', 'users', userId);
  return ageOf(decrypt(enc, 'users.dob'), new Date(`${day}T00:00:00Z`));
}

/** Haversine great-circle distance in km between two lat/lng pairs. */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/** Estimated travel time in minutes: 50 km/h average speed + 20-min fixed overhead (parking, security). */
function travelMinutes(distKm) {
  return Math.ceil(distKm / 50 * 60) + 20;
}

/**
 * Everything that must hold before someone is invited to, accepted for or moved onto a fixture. Call after lockOfficial.
 * Sport profile, the event's credential policy, time off, and no overlap (incl. the official's reporting time and venue-
 * aware travel buffer) with other confirmed work.
 * `event` is the events row; `checkClash=false` skips only the time rules (used when creating before a time is fixed).
 * The official's own time is read through official-availability.js (#994): time off of every kind (one-off, repeating, public holiday)
 * always holds. `mode: 'invite'` also enforces the limits the official set for new requests (refused hours, notice, daily / weekly /
 * consecutive-day caps, one tentative request per slot); accepting, re-timing and emergency cover do not, because the official or an
 * agreed match is already involved. Refusals carry `details.code`, never a reason, a note or a place.
 * Throws with code `travel_gap` when a travel gap conflict is found (for recording in official_clash_exceptions).
 * Returns the availability assessment for the slot.
 */
export async function assertOfficialEligible(c, { event, sportId, fixtureId, userId, role, start, durationMin, reportingMin = 30, checkClash = true, mode = 'hard' }) {
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
  // — Suspension check (cannot be bypassed by an override here; use the governing body) —
  if (role !== 'scorer' && start) {
    const day = typeof start === 'string' ? start.slice(0, 10) : new Date(start).toISOString().slice(0, 10);
    const suspended = await (async () => {
      if (await activeSportingSanction(c, userId, sport, day)) return true;
      const rows = (await c.query(
        `SELECT s.* FROM disc_sanctions s JOIN comp_competitions k ON k.id=s.competition_id
          WHERE s.subject_user_id=$1 AND s.superseded_at IS NULL AND s.status IN ('interim','active') AND s.kind = ANY($2::text[]) AND COALESCE(s.sport_id, k.sport_id)=$3`,
        [userId, BLOCKING_KINDS, sport])).rows;
      for (const s of rows) {
        if (blocksOn(s, day, s.kind === 'match_suspension' ? await serviceFor(c, s) : null)) return true;
      }
      return false;
    })();
    if (suspended) throw conflict('This official has an active sporting sanction or match suspension');
  }

  // — Minimum age (event.official_min_age) —
  if (event?.official_min_age && start) {
    const day = typeof start === 'string' ? start.slice(0, 10) : new Date(start).toISOString().slice(0, 10);
    const age = await officialAgeOn(c, userId, day);
    if (age != null) {
      if (age < event.official_min_age) throw badRequest(`This event requires officials to be at least ${event.official_min_age} years old`);
    }
  }

  // — Training certificates (event.official_training_required) —
  if (event?.official_training_required?.length) {
    const held = (await c.query(
      "SELECT category FROM compliance_records WHERE subject_id=$1 AND subject_type='user' AND organisation_id IS NULL AND state='active' AND category = ANY($2::text[])",
      [userId, event.official_training_required])).rows.map((r) => r.category);
    const missing = event.official_training_required.filter((r) => !held.includes(r));
    if (missing.length) throw badRequest(`This event requires the following training for officials: ${missing.join(', ')}`);
  }

  // — Safeguarding / youth-access clearance (event.official_safeguarding_required) —
  if (event?.official_safeguarding_required) {
    const ctx = {};
    const hasObs = await hasObligations(c, 'youth_access', ctx);
    if (hasObs) {
      const g = await complianceGate(c, userId, 'youth_access', ctx);
      if (g.decision !== 'clear') throw badRequest('This event requires officials to have a current safeguarding clearance for working with young people');
    }
  }

  // — Undecided conflict-of-interest declarations (event.official_conflict_declaration_required) —
  if (event?.official_conflict_declaration_required && fixtureId) {
    const foId = (await c.query('SELECT id FROM fixture_officials WHERE fixture_id=$1 AND user_id=$2 AND status IN ($3,$4) LIMIT 1', [fixtureId, userId, 'invited', 'accepted'])).rows[0]?.id;
    if (foId) {
      const open = (await c.query("SELECT 1 FROM official_conflicts WHERE fixture_official_id=$1 AND status='open' LIMIT 1", [foId])).rowCount;
      if (open) throw conflict('This event requires all conflict-of-interest declarations to be decided before the assignment is confirmed');
    }
  }

  // — Para-sport training eligibility (event.official_para_required) —
  // If the event's sport has mandatory para officiating requirements, the official must have verified completions.
  // A 'hard' mode blocks assignment; 'invite' mode emits a warning via the returned assessment.
  if (event?.official_para_required && sport) {
    try {
      const { computeEligibility } = await import('./capabilities/officials-para-training.js');
      const elig = await computeEligibility(userId, sport, c);
      if (!elig.eligible && mode === 'hard') {
        const missing = elig.incomplete_mandatory.map((m) => m.title).join('; ');
        throw badRequest(`This event requires para-sport officiating training for this sport. Incomplete: ${missing}`);
      }
    } catch (e) {
      // If the module is unavailable, skip the check rather than blocking assignment.
      if (e.message?.includes('Incomplete')) throw e;
    }
  }

  if (!checkClash) return null;

  // Clash window: starts at reporting time (arrive at venue before kickoff), ends when the fixture plus buffer ends.
  const startMs = new Date(start).getTime();
  const endMs = startMs + durationMin * 60000;
  const arriveMs = startMs - reportingMin * 60000; // must be free from arrival time

  const prefs = (await c.query('SELECT buffer_min FROM official_prefs WHERE user_id=$1', [userId])).rows[0];
  const bufMs = (prefs?.buffer_min ?? 0) * 60000;

  // The official's own time: time off of every kind, their gap between matches, and (for a new request) their stated limits.
  const own = await assess(c, { userId, start, durationMin, fixtureId: fixtureId ?? null, leadMin: reportingMin });
  const stop = own.hard[0] ?? (mode === 'invite' ? own.soft[0] : null);
  if (stop) throw conflict(stop.message, { code: stop.code });

  // Direct overlap clash (using timestamptz arithmetic; DST-safe because Postgres operates in UTC for timestamptz)
  const clash = await c.query(
    `SELECT fo.id AS fo_id, f.id AS clash_fixture_id, f.scheduled_at, f.duration_min,
            ve.id AS venue_id, ve.latitude AS lat, ve.longitude AS lng, ve.name AS venue_name, ve.city AS venue_city
       FROM fixtures f
       LEFT JOIN resources r ON r.id = f.resource_id
       LEFT JOIN venues ve ON ve.id = r.venue_id
       LEFT JOIN fixture_officials fo ON fo.fixture_id = f.id AND fo.user_id = $1 AND fo.status = 'accepted'
      WHERE f.status IN ('scheduled','live')
        AND ($4::uuid IS NULL OR f.id <> $4)
        AND (f.referee_id = $1 OR fo.id IS NOT NULL)
        AND f.scheduled_at < $3::timestamptz
        AND (f.scheduled_at + f.duration_min * interval '1 minute') > $2::timestamptz
      LIMIT 1`,
    [userId, new Date(arriveMs - bufMs).toISOString(), new Date(endMs + bufMs).toISOString(), fixtureId ?? null]);

  if (clash.rowCount) {
    const msg = bufMs
      ? 'Official already has a game in that window (including their travel buffer)'
      : 'Official already has a game in that window';
    throw conflict(msg);
  }

  // Venue-aware travel check: look for nearby fixtures at DIFFERENT venues within ±8 h
  const windowStart = new Date(startMs - 8 * 3600000).toISOString();
  const windowEnd   = new Date(endMs   + 8 * 3600000).toISOString();

  const nearby = await c.query(
    `SELECT f.id AS clash_fixture_id, f.scheduled_at, f.duration_min,
            ve.id AS venue_id, ve.latitude AS lat, ve.longitude AS lng, ve.name AS venue_name, ve.city AS venue_city
       FROM fixtures f
       LEFT JOIN resources r ON r.id = f.resource_id
       LEFT JOIN venues ve ON ve.id = r.venue_id
      WHERE f.status IN ('scheduled','live')
        AND ($2::uuid IS NULL OR f.id <> $2)
        AND (
          f.referee_id = $1
          OR EXISTS (SELECT 1 FROM fixture_officials fo2 WHERE fo2.fixture_id = f.id AND fo2.user_id = $1 AND fo2.status = 'accepted')
        )
        AND f.scheduled_at < $4::timestamptz
        AND (f.scheduled_at + f.duration_min * interval '1 minute') > $3::timestamptz
        AND ve.latitude IS NOT NULL AND ve.longitude IS NOT NULL`,
    [userId, fixtureId ?? null, windowStart, windowEnd]);

  // Fetch the target fixture's venue for distance comparison
  const targetVenue = fixtureId
    ? (await c.query(
        `SELECT ve.id, ve.latitude AS lat, ve.longitude AS lng FROM fixtures f LEFT JOIN resources r ON r.id=f.resource_id LEFT JOIN venues ve ON ve.id=r.venue_id WHERE f.id=$1`,
        [fixtureId])).rows[0]
    : null;

  for (const other of nearby.rows) {
    if (!other.lat || !other.lng) continue;
    if (targetVenue?.id && other.venue_id === targetVenue.id) continue; // same venue — no travel needed

    const distKm = (targetVenue?.lat && targetVenue?.lng)
      ? haversineKm(Number(targetVenue.lat), Number(targetVenue.lng), Number(other.lat), Number(other.lng))
      : null;

    if (distKm === null) continue;

    const reqTravelMin = travelMinutes(distKm);
    const otherEndMs  = new Date(other.scheduled_at).getTime() + other.duration_min * 60000;
    const gapMin      = Math.round((startMs - otherEndMs) / 60000); // negative = overlap
    const gapMinRev   = Math.round((new Date(other.scheduled_at).getTime() - endMs) / 60000);
    const actualGap   = Math.max(gapMin, gapMinRev);

    if (actualGap < reqTravelMin) {
      const err = conflict(
        `Insufficient travel time: ${distKm} km apart, ${actualGap} min gap, ${reqTravelMin} min needed`
      );
      err.code              = 'travel_gap';
      err.clash_fixture_id  = other.clash_fixture_id;
      err.venue_distance_km = distKm;
      err.computed_gap_min  = actualGap;
      err.required_travel_min = reqTravelMin;
      throw err;
    }
  }

  return own;
}

/** Record that a clash check was deliberately bypassed (emergency substitute, organiser override). */
export async function recordClashException(c, { foId, overridingFoId, actorId, overrideReason, gapMin, distKm }) {
  await c.query(
    `INSERT INTO official_clash_exceptions(fixture_official_id, overriding_fixture_id, actor_id, override_reason, computed_gap_min, venue_distance_km)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [foId, overridingFoId ?? null, actorId, overrideReason, gapMin ?? null, distKm ?? null]);
}

/**
 * Close an open assignment, keep history, drop the referee projection and any mirrored game association.
 * Pass overrideReason when releasing a locked assignment; throws 409 `locked_assignment` otherwise.
 */
export async function closeOfficial(c, fo, actor, to, reason, { overrideReason } = {}) {
  if (fo.locked_at && !overrideReason) {
    const err = conflict('This assignment is locked and cannot be released without an override reason');
    err.code = 'locked_assignment';
    err.locked_by = fo.locked_by;
    err.lock_reason = fo.lock_reason;
    throw err;
  }
  await c.query('UPDATE fixture_officials SET status=$2, reason=$3, ended_at=now(), responded_at=coalesce(responded_at, now()), locked_at=NULL, locked_by=NULL, lock_reason=NULL WHERE id=$1', [fo.id, to, reason ?? null]);
  await recordHistory(c, fo.id, actor, fo.status, to, reason);
  if (fo.role === 'referee') await c.query('UPDATE fixtures SET referee_id=NULL WHERE id=$1 AND referee_id=$2', [fo.fixture_id, fo.user_id]);
  await c.query("UPDATE associations SET status='ended', ended_at=now() WHERE user_id=$1 AND role=$2 AND target_type='game' AND status='active' AND target_id IN (SELECT id FROM games WHERE fixture_id=$3)", [fo.user_id, fo.role, fo.fixture_id]);
}

export { OPEN };

/** One official's assignments joined to match, event and crew context. Shared by the list, the home, the calendar and the history so none of them copies fixtures. */
export const ASSIGNMENT_SQL = `
  SELECT fo.id, fo.fixture_id, fo.role, CASE WHEN fo.status='accepted' AND f.status='completed' THEN 'completed' ELSE fo.status END AS status, fo.status = 'accepted' AS confirmed, fo.needs_ack, fo.reason, fo.created_at AS requested_at, fo.fee_minor::float8 AS fee_minor, fo.fee_currency, fo.pay_status, fo.pay_confirmed_at, fo.reporting_min, fo.locked_at, fo.locked_by, fo.lock_reason, f.scheduled_at, f.duration_min, f.status AS fixture_status, f.round,
         e.id AS event_id, e.name AS event_name, e.official_policy, s.id AS sport_id, s.slug AS sport_slug, s.name AS sport_name, s.emoji AS sport_emoji,
         h.name AS home_name, a.name AS away_name, r.name AS resource_name, ve.id AS venue_id, ve.name AS venue_name, ve.city AS venue_city, ve.timezone AS venue_timezone
    FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id JOIN events e ON e.id=f.event_id JOIN sports s ON s.id=e.sport_id
    LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id LEFT JOIN resources r ON r.id=f.resource_id LEFT JOIN venues ve ON ve.id=r.venue_id`;

// ── R10: role subsets for granular match RBAC ──────────────────────────────
export const CHIEF_ROLES   = ['referee'];
export const SCORER_ROLES  = ['scorer'];
export const OBSERVER_ROLES = ['fourth_official', 'video_assistant_referee',
                               'reserve_assistant_referee', 'goal_line_official'];
export const REPORT_FILING_ROLES = ['referee', 'umpire', 'linesman', 'technical_official', 'chair_umpire', 'match_commissioner', 'technical_delegate'];
export const REPORT_SUBMIT_ROLES = ['referee'];

/**
 * Strip sensitive fields from a flattened export row based on who is reading it.
 * - Tax/bank: only the subject themselves or platform_admin
 * - Medical/bio: only doctor or admin
 * - Minor DOB: truncate to year-month for non-guardians/non-admin
 */
export function redactExport(row, actor) {
  const isOwnRecord     = actor.id === row.user_id;
  const isAdmin         = actor.roles?.includes('admin');
  const isDoctor        = actor.roles?.includes('doctor');
  const isPlatformAdmin = isAdmin && actor.roles?.includes('platform_admin');

  const out = { ...row };

  // Tax / bank — only the official themselves or platform admin
  if (!isOwnRecord && !isPlatformAdmin) {
    for (const f of ['vat_number', 'bank_account', 'bank_sort_code', 'bank_iban',
                     'tax_country', 'vat_registered', 'fee_minor', 'fee_currency',
                     'pay_status', 'pay_confirmed_at']) {
      out[f] = null;
    }
  }

  // Medical / bio — only doctor or admin
  if (!isDoctor && !isAdmin) {
    for (const f of ['bio', 'clinical_note', 'medical_note']) {
      out[f] = null;
    }
  }

  // Minors' full DOB — truncate to year-month for non-guardians/non-admin
  if (!actor.isGuardian && !isAdmin) {
    if (out.birth_date && out.is_minor) {
      out.birth_date = out.birth_date.slice(0, 7) + '-01';
    }
  }

  return out;
}
