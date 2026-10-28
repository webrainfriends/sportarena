// Team & delegation travel operations (#485): shared rules. A trip is an operational layer over canonical events, teams, organisations,
// supplier orders and guardian links; this module holds who may see what, the append-only change log, time-zone safety and readiness.
import { z } from 'zod';
import { pool } from './db.js';
import { isAdmin } from './helpers.js';
import { hasOrgGrant } from './org-access.js';
import { YOUTH_SQL } from './youth.js';
import { badRequest, conflict, notFound } from './errors.js';
import { notify } from './notify.js';
import { canManageTeam } from './capabilities/teams.js';

export const PARTY_ROLES = ['athlete', 'coach', 'staff', 'official', 'medical', 'manager', 'chaperone', 'guest', 'guardian'];
export const OPS_ROLES = ['manager', 'chaperone'];
export const LIVE_PARTICIPANT = ['invited', 'confirmed'];
export const TERMINAL = ['completed', 'cancelled'];

// ---- time zones ---------------------------------------------------------------------------------------------------------------------------
export const isZone = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return typeof tz === 'string' && tz.length > 0; } catch { return false; } };

/** Offset of `tz` from UTC at the instant `date`, in minutes. */
export function offsetMinutes(tz, date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** The offset written in an ISO string ("+05:30", "Z") must be the offset the stated zone really has at that instant, so a wrong zone is caught on entry. */
export function assertZoneMatches(iso, tz, label) {
  const m = /(Z|[+-]\d{2}:\d{2})$/.exec(iso);
  if (!m) throw badRequest(`${label}: include the UTC offset`);
  if (m[1] === 'Z') return; // an instant in UTC is unambiguous; only a written local offset can disagree with the zone
  const written = m[1] === 'Z' ? 0 : (m[1][0] === '-' ? -1 : 1) * (Number(m[1].slice(1, 3)) * 60 + Number(m[1].slice(4, 6)));
  const real = offsetMinutes(tz, new Date(iso));
  if (written !== real) throw badRequest(`${label}: the time says UTC${m[1]} but ${tz} is UTC${real >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(real) / 60)).padStart(2, '0')}:${String(Math.abs(real) % 60).padStart(2, '0')} at that moment. Pick the matching zone.`);
}

export const localText = (iso, tz) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)) : null);
export const localDay = (iso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
/** Whole calendar days a trip covers in its own zone (depart day and return day both count). */
export function tripDays(trip) {
  const a = Date.parse(`${localDay(trip.depart_at, trip.timezone)}T00:00:00Z`), b = Date.parse(`${localDay(trip.return_at, trip.timezone)}T00:00:00Z`);
  return Math.round((b - a) / 864e5) + 1;
}
export const addMonths = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

// ---- who may do what ----------------------------------------------------------------------------------------------------------------------
export async function isTripManager(user, trip, c = pool) {
  if (isAdmin(user) || trip.manager_id === user.id) return true;
  if (trip.team_id) {
    const team = (await c.query('SELECT * FROM teams WHERE id=$1', [trip.team_id])).rows[0];
    if (team && (await canManageTeam(user, team))) return true;
  }
  return trip.organisation_id ? hasOrgGrant(user, trip.organisation_id, ['owner', 'admin'], c) : false;
}

/** May this person approve the trip (and a per-diem policy)? The owning team's owner or the organisation's owner/admin, or the platform team. */
export async function canApproveTrip(user, trip, c = pool) {
  if (isAdmin(user)) return true;
  if (trip.team_id && (await c.query('SELECT 1 FROM teams WHERE id=$1 AND owner_id=$2', [trip.team_id, user.id])).rowCount) return true;
  return trip.organisation_id ? hasOrgGrant(user, trip.organisation_id, ['owner', 'admin'], c) : false;
}

/**
 * Load a trip the caller may see, with their standing on it. Outsiders get 404 (existence is not leaked).
 *  - manager: runs the trip.  ops: manager or a confirmed manager/chaperone on the party.  mine: their own party row.  wards: young travellers they guard (live link).
 */
export async function tripCtx(user, id, c = pool, { lock = false } = {}) {
  const trip = (await c.query(`SELECT * FROM trips WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  if (!trip) throw notFound('Trip');
  const manager = await isTripManager(user, trip, c);
  const mine = (await c.query(`SELECT * FROM trip_participants WHERE trip_id=$1 AND user_id=$2 AND status = ANY($3) ORDER BY created_at DESC LIMIT 1`, [id, user.id, LIVE_PARTICIPANT])).rows[0] ?? null;
  const wards = (await c.query(
    `SELECT p.* FROM trip_participants p JOIN users u ON u.id=p.user_id
      WHERE p.trip_id=$1 AND p.status = ANY($2) AND ${YOUTH_SQL}
        AND EXISTS (SELECT 1 FROM guardian_links l WHERE l.guardian_id=$3 AND l.child_id=p.user_id AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()))`,
    [id, LIVE_PARTICIPANT, user.id])).rows;
  if (!manager && !mine && !wards.length) throw notFound('Trip');
  const ops = manager || (mine?.status === 'confirmed' && OPS_ROLES.includes(mine.role));
  return { trip, manager, ops, mine, wards, wardIds: new Set(wards.map((w) => w.id)) };
}

export const youthIdsAmong = async (c, userIds) => (userIds.length ? (await c.query(`SELECT u.id FROM users u WHERE u.id = ANY($1::uuid[]) AND ${YOUTH_SQL}`, [userIds])).rows.map((r) => r.id) : []);

/** Live guardians of these young people. */
export const guardiansOfMany = async (c, childIds) => (childIds.length ? (await c.query(
  `SELECT DISTINCT l.guardian_id FROM guardian_links l WHERE l.child_id = ANY($1::uuid[]) AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())`, [childIds])).rows.map((r) => r.guardian_id) : []);

// ---- history + notifications --------------------------------------------------------------------------------------------------------------
/** Append to the trip's history and tell only the people the change affects (never the actor). Snapshots and messages carry no document numbers. */
export async function record(c, trip, actor, { entity, entityId = null, action, version = null, snapshot = {}, note = null, affected = [], title, body, kind = 'trip_change' }) {
  const who = [...new Set(affected)].filter((u) => u && u !== actor);
  await c.query('INSERT INTO trip_changes(trip_id, entity, entity_id, action, version, snapshot, note, actor_id, affected_user_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [trip.id, entity, entityId, action, version, snapshot, note, actor, who]);
  if (title) for (const u of who) await notify(c, u, { kind, title, body: body ?? trip.name, data: { trip_id: trip.id, entity, entity_id: entityId }, dedupe_key: `trip:${entity}:${entityId ?? trip.id}:${action}:${version ?? 0}:${u}` });
}

/** Users to tell when something touching these participants changes: the traveller, the trip manager, and a young traveller's live guardians. */
export async function audienceOf(c, trip, participantIds) {
  const rows = participantIds.length ? (await c.query('SELECT user_id FROM trip_participants WHERE id = ANY($1::uuid[])', [participantIds])).rows.map((r) => r.user_id) : [];
  const youth = await youthIdsAmong(c, rows);
  return [...rows, trip.manager_id, ...(await guardiansOfMany(c, youth))];
}

export const stale = (row, version) => { if (row.row_version !== version) throw conflict('This changed since you opened it. Reload and try again.', { code: 'stale_version', current_version: row.row_version }); };

// ---- readiness ----------------------------------------------------------------------------------------------------------------------------
export const ISSUE_LABEL = {
  unconfirmed: 'Has not confirmed the invitation', guardian_travel_consent: 'Needs trip-specific guardian consent', no_chaperone: 'Young travellers need an approved chaperone',
  passport_missing: 'Passport status not recorded as held', passport_expiry: 'Passport expires too soon after the return', visa_pending: 'Visa not yet approved or marked not required',
  no_transport: 'Not on any transport segment', no_room: 'No room allocated',
};

/** Readiness per live participant. Derived on read from the records, never stored, so it cannot drift from them. */
export async function readiness(c, trip) {
  const parts = (await c.query(`SELECT p.*, u.display_name, (${YOUTH_SQL}) AS youth FROM trip_participants p JOIN users u ON u.id=p.user_id WHERE p.trip_id=$1 AND p.status = ANY($2) ORDER BY p.created_at`, [trip.id, LIVE_PARTICIPANT])).rows;
  const docs = (await c.query("SELECT participant_id, kind, status, to_char(expires_on,'YYYY-MM-DD') AS expires_on FROM trip_documents WHERE trip_id=$1", [trip.id])).rows;
  const consents = new Set((await c.query(
    `SELECT t.participant_id FROM trip_consents t WHERE t.trip_id=$1 AND t.revoked_at IS NULL AND t.expires_at > now()
        AND EXISTS (SELECT 1 FROM guardian_links l WHERE l.guardian_id=t.guardian_id AND l.child_id=t.child_id AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()))`, [trip.id])).rows.map((r) => r.participant_id));
  const onSeg = new Set((await c.query(`SELECT DISTINCT sp.participant_id FROM trip_segment_passengers sp JOIN trip_segments s ON s.id=sp.segment_id WHERE s.trip_id=$1 AND s.archived_at IS NULL AND s.status<>'cancelled' AND sp.removed_at IS NULL`, [trip.id])).rows.map((r) => r.participant_id));
  const segCount = (await c.query(`SELECT count(*)::int AS n FROM trip_segments WHERE trip_id=$1 AND archived_at IS NULL AND status<>'cancelled'`, [trip.id])).rows[0].n;
  const roomed = new Set((await c.query(`SELECT DISTINCT a.participant_id FROM trip_room_assignments a JOIN trip_rooms r ON r.id=a.room_id JOIN trip_stays s ON s.id=r.stay_id WHERE s.trip_id=$1 AND a.released_at IS NULL AND r.archived_at IS NULL`, [trip.id])).rows.map((r) => r.participant_id));
  const roomCount = (await c.query(`SELECT count(*)::int AS n FROM trip_rooms r JOIN trip_stays s ON s.id=r.stay_id WHERE s.trip_id=$1 AND r.archived_at IS NULL AND s.archived_at IS NULL AND s.status<>'cancelled'`, [trip.id])).rows[0].n;
  const returnDay = localDay(trip.return_at, trip.timezone);
  const adultsLeading = parts.some((p) => !p.youth && p.status === 'confirmed' && OPS_ROLES.includes(p.role));
  const anyYouth = parts.some((p) => p.youth && p.role !== 'guardian');
  const out = new Map();
  for (const p of parts) {
    const issues = [];
    if (p.status === 'invited') issues.push('unconfirmed');
    if (p.youth && p.role !== 'guardian') {
      if (!consents.has(p.id)) issues.push('guardian_travel_consent');
      if (!adultsLeading) issues.push('no_chaperone');
    }
    if (trip.documents_required && p.role !== 'guardian') {
      const pass = docs.find((d) => d.participant_id === p.id && d.kind === 'passport'), visa = docs.find((d) => d.participant_id === p.id && d.kind === 'visa');
      if (pass?.status !== 'held') issues.push('passport_missing');
      else if (pass.expires_on && pass.expires_on < addMonths(returnDay, trip.passport_min_months)) issues.push('passport_expiry');
      if (!visa || !['not_required', 'approved'].includes(visa.status)) issues.push('visa_pending');
    }
    if (segCount && !onSeg.has(p.id)) issues.push('no_transport');
    if (roomCount && !roomed.has(p.id)) issues.push('no_room');
    out.set(p.id, { participant: p, issues, ready: issues.length === 0, youth: p.youth });
  }
  return { byId: out, anyYouth, adultsLeading };
}

export const assertOpen = (trip) => { if (TERMINAL.includes(trip.status)) throw conflict(`This trip is ${trip.status} and read-only`); };
/** Display name for a traveller: young travellers are shown by name only to the trip's operations staff, themselves and their guardians. */
export const maskParty = (rows, ctx, youthSet) => rows.map((p) => {
  const hide = youthSet.has(p.user_id) && !ctx.ops && p.user_id !== ctx.mine?.user_id && !ctx.wardIds.has(p.id);
  return hide ? { id: p.id, role: p.role === 'guardian' ? 'guardian' : 'athlete', status: p.status, display_name: 'Young traveller', masked: true } : { ...p, young: youthSet.has(p.user_id) };
});

// ---- places: a name plus an optional ISO country and map point (picked from a dropdown, a Google / Apple Maps link or the device location) ----
export const isCountry = (code) => { try { const n = new Intl.DisplayNames(['en'], { type: 'region' }).of(code); return !!n && n !== code && !/Unknown Region/i.test(n); } catch { return /^[A-Z]{2}$/.test(code); } };
const countryCode = z.string().regex(/^[A-Z]{2}$/, 'Use a two-letter country code').refine(isCountry, 'Not a country');
/** Zod fields for a place called `prefix` (origin, destination, ...): country, latitude, longitude. A point needs both coordinates. */
export const placeFields = (prefix) => ({
  [`${prefix}country`]: countryCode.nullable().optional(),
  [`${prefix}lat`]: z.number().min(-90).max(90).nullable().optional(),
  [`${prefix}lng`]: z.number().min(-180).max(180).nullable().optional(),
});
export function assertPoint(o, prefix) {
  const a = o[`${prefix}lat`], b = o[`${prefix}lng`];
  if ((a === null || a === undefined) !== (b === null || b === undefined)) throw badRequest('A map point needs both latitude and longitude');
}

/** Download check for a branded trip report PDF: still within its 24 h life, and the person may still see this trip in this audience (checked live). */
export async function canReadTripReport(user, d) {
  const audience = String(d.source_type).split(':')[1];
  if (Date.now() > new Date(d.created_at).getTime() + 24 * 36e5) throw notFound('Document');
  const ctx = await tripCtx(user, d.source_id).catch(() => { throw notFound('Document'); });
  if (audience === 'traveller') { if (d.generated_by !== user.id) throw notFound('Document'); } else if (!ctx.ops) throw notFound('Document');
}
