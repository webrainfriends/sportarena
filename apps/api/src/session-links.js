// Coaching and training sessions as one shape, and the venue booking lines they are attached to.
// A session is a coach hire or a training-plan session; both have a coach, an athlete (or the booker), a start and an end.
import { pool } from './db.js';

export const SESSION_SQL = `
  SELECT 'coach_hire' AS type, h.id, h.starts_at, h.starts_at + h.duration_min * interval '1 minute' AS ends_at, h.duration_min, h.coach_id, h.hirer_id AS athlete_id, h.sport_id,
         h.status IN ('requested','confirmed') AS active, h.status, h.audience, h.participants, h.team_id, NULL::text AS title
    FROM coach_hires h
  UNION ALL
  SELECT 'training_session', t.id, t.starts_at, t.starts_at + t.duration_min * interval '1 minute', t.duration_min, p.coach_id, p.athlete_id, p.sport_id,
         t.status = 'scheduled', t.status, 'individual', 1, NULL::uuid, t.title
    FROM training_sessions t JOIN training_plans p ON p.id = t.plan_id`;

const LIVE_LINK = `
  LEFT JOIN LATERAL (
    SELECT l.id AS link_id, l.booking_id, l.reservation_id, b.status AS booking_status, b.starts_at AS venue_starts_at, b.ends_at AS venue_ends_at,
           r.name AS resource_name, v.id AS venue_id, v.name AS venue_name, v.city AS venue_city, v.timezone AS venue_timezone
      FROM session_venue_links l JOIN bookings b ON b.id = l.booking_id JOIN resources r ON r.id = b.resource_id JOIN venues v ON v.id = r.venue_id
     WHERE l.session_type = s.type AND l.session_id = s.id AND l.released_at IS NULL
  ) lk ON true`;

const NAMES = `
  JOIN users uc ON uc.id = s.coach_id JOIN users ua ON ua.id = s.athlete_id LEFT JOIN sports sp ON sp.id = s.sport_id LEFT JOIN teams tm ON tm.id = s.team_id`;
const COLS = `s.*, uc.display_name AS coach_name, ua.display_name AS athlete_name, sp.name AS sport, sp.slug AS sport_slug, sp.emoji AS sport_emoji, tm.name AS team_name, lk.*`;

/** Sessions by reference, keyed `type:id`, with their live venue link (if any). */
export async function loadSessions(refs, db = pool) {
  const hires = refs.filter((r) => r.type === 'coach_hire').map((r) => r.id), plans = refs.filter((r) => r.type === 'training_session').map((r) => r.id);
  const { rows } = await db.query(`SELECT ${COLS} FROM (${SESSION_SQL}) s ${NAMES} ${LIVE_LINK} WHERE (s.type = 'coach_hire' AND s.id = ANY($1::uuid[])) OR (s.type = 'training_session' AND s.id = ANY($2::uuid[]))`, [hires, plans]);
  return new Map(rows.map((r) => [`${r.type}:${r.id}`, r]));
}

/** Upcoming sessions the user takes part in (as coach or athlete), each with its venue if one is held. */
export async function sessionsOf(userId, { days = 90, db = pool } = {}) {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM (${SESSION_SQL}) s ${NAMES} ${LIVE_LINK}
      WHERE (s.coach_id = $1 OR s.athlete_id = $1) AND s.active AND s.ends_at > now() AND s.starts_at < now() + make_interval(days => $2)
      ORDER BY s.starts_at, s.id`, [userId, days]);
  return rows;
}

/** Sessions attached to the lines of a reservation (shown to the booker and to the venue team). */
export async function linkedForReservation(reservationId, db = pool) {
  const { rows } = await db.query(
    `SELECT l.id AS link_id, l.booking_id, s.type, s.id AS session_id, s.starts_at, s.ends_at, s.status, s.audience, s.participants, s.title, uc.display_name AS coach_name, ua.display_name AS athlete_name, sp.name AS sport, tm.name AS team_name
       FROM session_venue_links l JOIN (${SESSION_SQL}) s ON s.type = l.session_type AND s.id = l.session_id
       JOIN users uc ON uc.id = s.coach_id JOIN users ua ON ua.id = s.athlete_id LEFT JOIN sports sp ON sp.id = s.sport_id LEFT JOIN teams tm ON tm.id = s.team_id
      WHERE l.reservation_id = $1 AND l.released_at IS NULL ORDER BY s.starts_at`, [reservationId]);
  return rows;
}

export const isParty = (userId, s) => s.coach_id === userId || s.athlete_id === userId;
/** Held = the link is live and the booking line it points at is still confirmed. */
export const hasVenue = (s) => !!s.link_id && s.booking_status === 'confirmed';

/** SQL for "Venue · Court" of a session's held booking, as a column named `venue` (null when none). */
export const venueText = (type, idExpr) => `(SELECT v.name || ' · ' || r.name FROM session_venue_links l JOIN bookings b ON b.id = l.booking_id AND b.status = 'confirmed' JOIN resources r ON r.id = b.resource_id JOIN venues v ON v.id = r.venue_id WHERE l.session_type = '${type}' AND l.session_id = ${idExpr} AND l.released_at IS NULL LIMIT 1) AS venue`;
