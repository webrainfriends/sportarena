// The Smart Attendance & Access layer (#510). One engine, four domains, every capture method.
//
//   capture method  : rotating QR (personal pass or site code) | geofence | RFID/NFC credential | front desk (manual) | self
//   domain adapter  : academy_session -> academy_attendance, team_event -> team_attendance, venue_access -> bookings, event_gate -> accreditation_scans
//   hardware        : access-providers.js (gate / turnstile / smart-lock adapters)
//
// A capture is *evidence*: one append-only access_captures row per presentation, whatever the outcome. The canonical record (the attendance
// row, the booking arrival, the accreditation scan) is still written by the same code that always wrote it. Every decision is judged live
// from the canonical data: nothing is copied into a whitelist, so a cancelled booking or a revoked accreditation stops working at once.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { pool, one } from './db.js';
import { blindIndex, encrypt, decrypt } from './crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound } from './errors.js';
import { isYouth, requireGuardian } from './youth.js';
import { canManage } from './booking/engine.js';
import { canManageTeam } from './capabilities/teams.js';
import { eligible as onAcademyRoster, markAttendance, LATE_AFTER_MIN, PRESENT } from './capabilities/academy-attendance.js';
import { sessionFor } from './academy-ops.js';
import { isGateOperator, judge, tokenFor } from './accreditation.js';
import { providerOf } from './access-providers.js';

export const DOMAINS = ['academy_session', 'team_event', 'venue_access', 'event_gate'];
export const METHODS = ['qr', 'geo', 'rfid', 'nfc', 'manual', 'self'];
export const MANUAL_REASONS = ['roster_tap', 'device_failure', 'network_failure', 'forgot_credential', 'guardian_present', 'correction', 'other'];
const REASON_CTX = 'access_captures.reason';
const OFFLINE_MAX_AGE_MS = 72 * 3600_000;
const REPEAT_MS = 120_000;     // the same person scanned twice within this is reported as a rapid repeat
const CONCURRENT_MS = 60_000;  // arriving at two places inside this is reported as concurrent use

export const MESSAGES = {
  qr_invalid: 'This code is not valid.', qr_expired: 'This code has expired. Ask for a fresh one.', qr_wrong_subject: 'This code is for a different session, team or door.',
  qr_replay: 'This code was already used. Ask the person to open a fresh one.', credential_unknown: 'This card or tag is not registered to anyone.',
  credential_inactive: 'This card or tag has been suspended or revoked.', credential_expired: 'This card or tag has expired.',
  not_eligible: 'This person is not on the roster for this.', outside_window: 'Outside the check-in window. Staff can still record it by hand.',
  session_not_open: 'This session is not open for attendance.', guardian_required: 'A parent or guardian checks a young person in.',
  guardian_drop_off_required: 'A guardian has not dropped this young person off yet.', pickup_authorisation_required: 'A young person leaves only with a guardian or an authorised pickup. Choose who is collecting.',
  self_checkin_off: 'Self check-in is not switched on here.', geo_not_enabled: 'Location check-in is not switched on here.',
  geo_unavailable: 'Location was not available, so staff need to confirm this.', geofence_mismatch: 'The device was not near the venue, so staff need to confirm this.',
  staff_mark_exists: 'Staff already set a mark that differs, so staff need to confirm this.', not_checked_in: 'Not checked in, so there is nothing to check out.',
  already_recorded: 'Already recorded.', no_current_booking: 'No booking or membership that is valid right now.', booking_cancelled: 'The booking for this time was cancelled.',
  membership_inactive: 'The membership is not active.', no_accreditation: 'No accreditation for this event.', accreditation_cancelled: 'This accreditation was revoked or suspended.',
  provider_unavailable: 'The door controller could not be reached. Nothing was opened.', provider_rejected: 'The door controller declined to open.',
  offline_too_old: 'This offline scan is too old to accept.', revoked: 'This accreditation was revoked.', suspended: 'This accreditation is suspended.', expired: 'This accreditation has expired.',
  not_yet_valid: 'This accreditation is not valid yet.', replaced: 'This badge was replaced by a newer one.', wrong_zone: 'Not allowed in this zone.', wrong_event: 'This badge is for a different event.',
  outside_hours: 'Outside the hours of this accreditation.', invalid: 'This badge is not valid.',
};

// ------------------------------------------------------------------------------------------------------------------ rotating QR tokens
// GQ1.<P|S>.<domain>.<subject>.<user|->.<window>.<mac>. P = a person's own pass (30 s steps), S = the site code shown at the door (60 s steps).
// The mac is keyed per subject, so a code only means something for one session / team event / door, and it dies within minutes.
const CODE = { academy_session: 'a', team_event: 't', venue_access: 'v', event_gate: 'e' };
const DOMAIN_OF = Object.fromEntries(Object.entries(CODE).map(([d, k]) => [k, d]));
const STEP = { P: 30, S: 60 };
const SKEW = { P: [1, 2], S: [1, 3] };   // windows accepted ahead of / behind the current one
export const subjectKey = (domain, ref) => blindIndex(`access-key|${domain}|${ref}`);
export const macOf = (key, type, userId, w) => createHmac('sha256', key).update(`${type}|${userId ?? ''}|${w}`).digest('hex').slice(0, 24);
export const windowOf = (type, at = new Date()) => Math.floor(at.getTime() / 1000 / STEP[type]);

export function mintToken(domain, ref, { type, userId = null, at = new Date() }) {
  const w = windowOf(type, at);
  return { token: `GQ1.${type}.${CODE[domain]}.${ref}.${userId ?? '-'}.${w}.${macOf(subjectKey(domain, ref), type, userId, w)}`, step_s: STEP[type], expires_at: new Date((w + SKEW[type][1] + 1) * STEP[type] * 1000), refresh_in_s: STEP[type] };
}
const TOKEN_RE = /^GQ1\.([PS])\.([atve])\.([0-9a-f_-]{36,80})\.(-|[0-9a-f-]{36})\.(\d{1,10})\.([0-9a-f]{24})$/;
export function readToken(raw) {
  const m = TOKEN_RE.exec(String(raw ?? '').trim());
  return m ? { type: m[1], domain: DOMAIN_OF[m[2]], ref: m[3], userId: m[4] === '-' ? null : m[4], w: Number(m[5]), mac: m[6] } : null;
}
/** 'ok' | 'invalid' (not issued by us) | 'expired' (issued by us, outside its window). Pure: also what an offline scanner runs with the pack key. */
export function checkToken(t, at, key = subjectKey(t.domain, t.ref)) {
  const want = Buffer.from(macOf(key, t.type, t.userId, t.w)), got = Buffer.from(t.mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return 'invalid';
  const d = windowOf(t.type, at) - t.w;
  return d >= -SKEW[t.type][0] && d <= SKEW[t.type][1] ? 'ok' : 'expired';
}
const tokenHash = (t) => createHash('sha256').update(`${t.type}.${t.domain}.${t.ref}.${t.userId}.${t.w}.${t.mac}`).digest('hex');

// ------------------------------------------------------------------------------------------------------------------ geofence
const rad = (d) => (d * Math.PI) / 180;
export function distanceM(a, b) {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
/** 'inside' | 'outside' | 'unavailable'. Coordinates are used for this one comparison and are never stored or logged. */
export function geoVerdict(policy, geo) {
  if (!geo || !Number.isFinite(geo.lat) || !Number.isFinite(geo.lng)) return 'unavailable';
  if (policy.lat == null || policy.lng == null) return 'unavailable';
  const acc = Number.isFinite(geo.accuracy_m) ? geo.accuracy_m : 50;
  if (acc > 500) return 'unavailable';   // too coarse to say anything
  return distanceM({ lat: policy.lat, lng: policy.lng }, geo) <= policy.radius_m + Math.min(acc, 100) ? 'inside' : 'outside';
}

// ------------------------------------------------------------------------------------------------------------------ domain adapters
const swallow = (e, ...codes) => { if (e instanceof AppError && codes.includes(e.status)) return false; throw e; };
const hasStaff = async (c, venueId, userId) => !!(await c.query('SELECT 1 FROM venues WHERE id=$1 AND owner_id=$2 UNION ALL SELECT 1 FROM venue_staff WHERE venue_id=$1 AND user_id=$2 AND removed_at IS NULL', [venueId, userId])).rowCount;
const SOURCE = { qr: 'qr', rfid: 'rfid', nfc: 'nfc', geo: 'geo', manual: 'staff' };

/** Who may collect a young person: verified guardians and delegates that are live right now. Names only. */
export async function releaseCandidates(c, childId) {
  const g = (await c.query("SELECT l.guardian_id AS user_id, u.display_name, 'guardian' AS relation FROM guardian_links l JOIN users u ON u.id=l.guardian_id WHERE l.child_id=$1 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())", [childId])).rows;
  const d = (await c.query("SELECT d.delegate_user_id AS user_id, u.display_name, 'delegate' AS relation FROM pickup_delegates d JOIN users u ON u.id=d.delegate_user_id WHERE d.child_id=$1 AND d.delegate_user_id IS NOT NULL AND d.revoked_at IS NULL AND d.valid_from <= now() AND d.expires_at > now()", [childId])).rows;
  return [...g, ...d];
}
const mayCollect = async (c, childId, collectorId) => !!collectorId && (await releaseCandidates(c, childId)).some((r) => r.user_id === collectorId);

const academy = {
  async load(c, ref) {
    const s = (await c.query('SELECT s.*, k.name AS cohort_name, k.coach_id AS cohort_coach_id FROM academy_sessions s JOIN org_cohorts k ON k.id=s.cohort_id WHERE s.id=$1', [ref])).rows[0];
    if (!s) throw notFound('Session');
    const v = (await c.query(
      `SELECT v.id, v.latitude, v.longitude FROM session_venue_links l JOIN bookings b ON b.id=l.booking_id AND b.status='confirmed' JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id
        WHERE l.session_type='academy_session' AND l.session_id=$1 AND l.released_at IS NULL LIMIT 1`, [s.id])).rows[0];
    return {
      domain: 'academy_session', ref: s.id, label: s.title, organisation_id: s.organisation_id, venue_id: v?.id ?? null, raw: s, self_allowed: s.self_checkin,
      window: { opens: new Date(new Date(s.starts_at).getTime() - 60 * 60000), closes: new Date(s.ends_at) },
      geo: { enabled: s.geo_checkin, radius_m: s.geo_radius_m, lat: v?.latitude ?? null, lng: v?.longitude ?? null },
    };
  },
  operator: async (user, sub, c) => sessionFor(user, sub.ref, 'attendance', { write: true, c }).then(() => true, (e) => swallow(e, 403, 404)),
  async eligibility(c, sub, personId) { return (await onAcademyRoster(c, sub.raw, personId)) ? null : 'not_eligible'; },
  async youth(c, sub, personId, direction, ctx) {
    if (direction === 'out' && !(await mayCollect(c, personId, ctx.releasedTo))) return { verdict: 'denied', reason: 'pickup_authorisation_required', release_candidates: await releaseCandidates(c, personId) };
    return null;
  },
  async apply(c, sub, personId, direction, ctx) {
    const s = sub.raw;
    const cur = (await c.query('SELECT id, status FROM academy_attendance WHERE session_id=$1 AND user_id=$2', [s.id, personId])).rows[0];
    const key = ctx.key ? `${ctx.key}:${personId}` : null;
    const source = ctx.method === 'self' ? (ctx.actorKind === 'guardian' ? 'guardian' : 'self') : SOURCE[ctx.method];
    try {
      if (direction === 'in') {
        if (cur && PRESENT.includes(cur.status)) return { changed: false, reason: 'already_recorded', ref: `academy_attendance:${cur.id}`, status: cur.status };
        if (cur && !['expected'].includes(cur.status) && ctx.method !== 'manual') return { hold: 'staff_mark_exists', status: cur.status };
        const status = ctx.at.getTime() > new Date(s.starts_at).getTime() + LATE_AFTER_MIN * 60000 ? 'late' : 'present';
        const r = await markAttendance(c, s, personId, status, { source, actor: ctx.actorId, key, reason: ctx.reasonText ?? `${ctx.method} check-in`, at: ctx.at });
        return { changed: r.changed, ref: `academy_attendance:${r.row.id}`, status: r.row.status };
      }
      if (!cur || !PRESENT.includes(cur.status)) return { deny: 'not_checked_in' };
      if (ctx.at.getTime() < new Date(s.ends_at).getTime() - 10 * 60000 && cur.status !== 'left_early') {
        const r = await markAttendance(c, s, personId, 'left_early', { source, actor: ctx.actorId, key, reason: ctx.reasonText ?? `${ctx.method} check-out`, at: ctx.at });
        return { changed: r.changed, ref: `academy_attendance:${r.row.id}`, status: r.row.status };
      }
      await c.query('UPDATE academy_attendance SET left_at=coalesce(left_at,$3), row_version=row_version+1 WHERE session_id=$1 AND user_id=$2', [s.id, personId, ctx.at]);
      await c.query('INSERT INTO academy_attendance_log(session_id, user_id, from_status, to_status, source, actor_id, reason) VALUES ($1,$2,$3,$3,$4,$5,$6)', [s.id, personId, cur.status, source, ctx.actorId, 'check-out']);
      return { changed: true, ref: `academy_attendance:${cur.id}`, status: cur.status };
    } catch (e) { if (e instanceof AppError && (e.status === 409 || e.status === 400)) return { deny: 'session_not_open', message: e.message }; throw e; }
  },
};

const team = {
  async load(c, ref) {
    const m = /^([0-9a-f-]{36})_([ef])_([0-9a-f-]{36})$/.exec(ref);
    if (!m) throw badRequest('A team subject looks like <team id>_e_<event id> or <team id>_f_<fixture id>');
    const t = (await c.query('SELECT * FROM teams WHERE id=$1', [m[1]])).rows[0];
    if (!t) throw notFound('Team');
    const ids = [t.id, t.parent_team_id].filter(Boolean);
    let ev, fx = null, window;
    if (m[2] === 'f') {
      fx = (await c.query('SELECT * FROM fixtures WHERE id=$1', [m[3]])).rows[0];
      if (!fx || (!ids.includes(fx.home_team_id) && !ids.includes(fx.away_team_id))) throw notFound('Fixture');
      ev = (await c.query('SELECT * FROM events WHERE id=$1', [fx.event_id])).rows[0];
      const at = new Date(fx.scheduled_at ?? Date.now());
      window = { opens: new Date(at.getTime() - 3 * 3600_000), closes: new Date(at.getTime() + 8 * 3600_000) };
    } else {
      ev = (await c.query('SELECT * FROM events WHERE id=$1', [m[3]])).rows[0];
      if (!ev) throw notFound('Event');
      window = { opens: new Date(`${(ev.starts_on?.toISOString?.() ?? String(ev.starts_on ?? '1970-01-01')).slice(0, 10)}T00:00:00Z`), closes: new Date(new Date(`${(ev.ends_on ?? ev.starts_on)?.toISOString?.().slice(0, 10) ?? '2999-12-31'}T00:00:00Z`).getTime() + 86400000) };
    }
    return { domain: 'team_event', ref, label: ev?.name ?? t.name, organisation_id: t.organisation_id ?? null, team_id: t.id, event_id: ev?.id ?? null, raw: { team: t, event: ev, fixture: fx, event_id: ev?.id ?? null, fixture_id: fx?.id ?? null }, self_allowed: true, window, geo: { enabled: false } };
  },
  operator: async (user, sub) => canManageTeam(user, sub.raw.team),
  async eligibility(c, sub, personId) { return (await c.query("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active'", [sub.team_id, personId])).rowCount ? null : 'not_eligible'; },
  async youth(c, sub, personId, direction) {
    if (direction === 'out') return { verdict: 'denied', reason: 'pickup_authorisation_required', release_candidates: await releaseCandidates(c, personId) };
    const dropped = (await c.query("SELECT kind FROM youth_checkins WHERE child_id=$1 AND team_id=$2 AND at > now() - interval '24 hours' ORDER BY at DESC, id DESC LIMIT 1", [personId, sub.team_id])).rows[0];
    return dropped?.kind === 'drop_off' ? null : { verdict: 'denied', reason: 'guardian_drop_off_required' };
  },
  async apply(c, sub, personId, direction, ctx) {
    const { event_id, fixture_id } = sub.raw;
    const cur = (await c.query('SELECT id, checked_in_at, checked_out_at FROM team_attendance WHERE team_id=$1 AND event_id IS NOT DISTINCT FROM $2 AND fixture_id IS NOT DISTINCT FROM $3 AND user_id=$4', [sub.team_id, event_id, fixture_id, personId])).rows[0];
    if (direction === 'in') {
      if (cur?.checked_in_at && !cur.checked_out_at) return { changed: false, reason: 'already_recorded', ref: `team_attendance:${cur.id}`, status: 'present' };
      const r = (await c.query(
        `INSERT INTO team_attendance(team_id, event_id, fixture_id, user_id, checked_in_at, checked_in_by) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (team_id, event_id, fixture_id, user_id) DO UPDATE SET checked_in_at=EXCLUDED.checked_in_at, checked_in_by=EXCLUDED.checked_in_by, checked_out_at=NULL, checked_out_by=NULL RETURNING id`,
        [sub.team_id, event_id, fixture_id, personId, ctx.at, ctx.actorId])).rows[0];
      return { changed: true, ref: `team_attendance:${r.id}`, status: 'present' };
    }
    if (!cur?.checked_in_at || cur.checked_out_at) return { deny: 'not_checked_in' };
    await c.query('UPDATE team_attendance SET checked_out_at=$2, checked_out_by=$3 WHERE id=$1', [cur.id, ctx.at, ctx.actorId]);
    return { changed: true, ref: `team_attendance:${cur.id}`, status: 'left' };
  },
};

const venueAccess = {
  async load(c, ref) {
    const p = (await c.query("SELECT p.*, v.latitude, v.longitude, v.organisation_id FROM access_points p JOIN venues v ON v.id=p.venue_id WHERE p.id=$1 AND p.status='active'", [ref])).rows[0];
    if (!p) throw notFound('Access point');
    return { domain: 'venue_access', ref: p.id, label: p.name, point: p, venue_id: p.venue_id, organisation_id: p.organisation_id, raw: p, self_allowed: true, window: null, geo: { enabled: p.geo_checkin, radius_m: p.geo_radius_m, lat: p.latitude, lng: p.longitude } };
  },
  operator: (user, sub, c) => canManage(user, sub.venue_id, c),
  /** Entitled when there is a confirmed booking at this venue around now, an active membership, or the person is on the venue team. */
  async eligibility(c, sub, personId, ctx) {
    const at = ctx.at, early = sub.point.early_min;
    const b = (await c.query(
      `SELECT b.id FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN reservations rs ON rs.id=b.reservation_id
        WHERE r.venue_id=$1 AND rs.user_id=$2 AND b.status='confirmed' AND rs.status='confirmed' AND b.starts_at - ($4 * interval '1 minute') <= $3 AND b.ends_at + interval '30 minutes' >= $3 ORDER BY b.starts_at LIMIT 1`,
      [sub.venue_id, personId, at, early])).rows[0];
    if (b) { ctx.basis = { type: 'booking', id: b.id }; return null; }
    if ((await c.query("SELECT 1 FROM user_plans WHERE venue_id=$1 AND user_id=$2 AND kind='membership' AND status='active' AND expires_at > $3 LIMIT 1", [sub.venue_id, personId, at])).rowCount) { ctx.basis = { type: 'membership' }; return null; }
    if (await hasStaff(c, sub.venue_id, personId)) { ctx.basis = { type: 'staff' }; return null; }
    if ((await c.query(
      `SELECT 1 FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN reservations rs ON rs.id=b.reservation_id WHERE r.venue_id=$1 AND rs.user_id=$2 AND (b.status='cancelled' OR rs.status='cancelled') AND b.starts_at - ($4 * interval '1 minute') <= $3 AND b.ends_at + interval '30 minutes' >= $3 LIMIT 1`,
      [sub.venue_id, personId, at, early])).rowCount) return 'booking_cancelled';
    if ((await c.query("SELECT 1 FROM user_plans WHERE venue_id=$1 AND user_id=$2 AND kind='membership' AND status IN ('expired','cancelled') LIMIT 1", [sub.venue_id, personId])).rowCount) return 'membership_inactive';
    return 'no_current_booking';
  },
  async youth(c, sub, personId, direction, ctx) {
    if (direction === 'out' && !(await mayCollect(c, personId, ctx.releasedTo))) return { verdict: 'denied', reason: 'pickup_authorisation_required', release_candidates: await releaseCandidates(c, personId) };
    return null;
  },
  provider: (sub) => sub.point,
  async apply(c, sub, personId, direction, ctx) {
    if (ctx.basis?.type !== 'booking') return { changed: true, ref: null, status: direction === 'in' ? 'admitted' : 'left' };
    const col = direction === 'in' ? 'checked_in_at' : 'checked_out_at';
    const r = (await c.query(`UPDATE bookings SET ${col}=coalesce(${col}, $2) WHERE id=$1 RETURNING id`, [ctx.basis.id, ctx.at])).rows[0];
    return { changed: true, ref: `bookings:${r.id}`, status: direction === 'in' ? 'admitted' : 'left' };
  },
};

const eventGate = {
  async load(c, ref) {
    const p = (await c.query("SELECT p.*, e.organizer_id FROM access_points p JOIN events e ON e.id=p.event_id WHERE p.id=$1 AND p.status='active'", [ref])).rows[0];
    if (!p) throw notFound('Access point');
    const ev = (await c.query('SELECT * FROM events WHERE id=$1', [p.event_id])).rows[0];
    return { domain: 'event_gate', ref: p.id, label: p.name, point: p, event_id: p.event_id, organisation_id: ev.organisation_id ?? null, raw: { point: p, event: ev }, self_allowed: false, window: null, geo: { enabled: false } };
  },
  operator: (user, sub, c) => isGateOperator(user, sub.raw.event, c),
  /** The accreditation engine judges it, live. Returns the verdict code when it is not 'valid'. */
  async eligibility(c, sub, personId, ctx) {
    const rows = (await c.query("SELECT serial, credential_version, status FROM accreditations WHERE event_id=$1 AND holder_id=$2 AND serial IS NOT NULL AND status IN ('approved','revoked','withdrawn') ORDER BY (status='approved') DESC, issued_at DESC NULLS LAST", [sub.event_id, personId])).rows;
    if (!rows.length) return 'no_accreditation';
    if (rows[0].status !== 'approved') return { reason: rows[0].status === 'revoked' ? 'revoked' : 'accreditation_cancelled', anomaly: 'accreditation_cancelled' };
    const v = await judge(c, sub.raw.event, tokenFor(rows[0].serial, rows[0].credential_version), sub.point.zone_id);
    ctx.accreditation = v.accreditation;
    return v.result === 'valid' ? null : (['revoked', 'suspended'].includes(v.result) ? { reason: v.result, anomaly: 'accreditation_cancelled' } : v.result);
  },
  async youth() { return null; },   // accreditation already requires current guardian consent for a young holder (judge)
  provider: (sub) => sub.point,
  async apply(c, sub, personId, direction, ctx) {
    const a = ctx.accreditation;
    const operator = ctx.actorId ?? sub.point.created_by;   // a signed device is recorded under the person who set the access point up
    const s = (await c.query('INSERT INTO accreditation_scans(event_id, accreditation_id, serial, zone_id, operator_id, direction, result) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [sub.event_id, a?.id ?? null, a?.serial ?? null, sub.point.zone_id, operator, direction, 'valid'])).rows[0];
    return { changed: true, ref: `accreditation_scans:${s.id}`, status: direction === 'in' ? 'admitted' : 'left' };
  },
};

export const ADAPTERS = { academy_session: academy, team_event: team, venue_access: venueAccess, event_gate: eventGate };
export const loadSubject = (c, domain, ref) => { if (!ADAPTERS[domain]) throw badRequest('Unknown access domain'); return ADAPTERS[domain].load(c, ref); };
export const isOperator = (user, sub, c) => (user ? ADAPTERS[sub.domain].operator(user, sub, c) : false);

// ------------------------------------------------------------------------------------------------------------------ capture
const scopeCols = (sub) => [sub.organisation_id ?? null, sub.venue_id ?? null, sub.event_id ?? null, sub.team_id ?? null, sub.point?.id ?? null];

async function insertCapture(c, sub, r) {
  const row = (await c.query(
    `INSERT INTO access_captures(domain, subject_ref, organisation_id, venue_id, event_id, team_id, access_point_id, user_id, actor_id, actor_kind, method, direction, verdict, reason_code, verified, offline, geo_result, canonical_ref, reason_enc, flags, device_id, token_idx, idempotency_key, captured_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
    [sub.domain, sub.ref, ...scopeCols(sub), r.personId ?? null, r.actorId ?? null, r.actorKind, r.method, r.direction, r.verdict, r.reason ?? null, r.verified, !!r.offline, r.geo_result ?? 'not_required', r.canonical_ref ?? null, r.reasonText ? encrypt(r.reasonText, REASON_CTX) : null, r.flags ?? [], r.device_id ?? null, r.token_idx ?? null, r.key ?? null, r.at])).rows[0];
  return row;
}
async function anomaly(c, sub, row, kind) {
  await c.query('INSERT INTO access_anomalies(capture_id, domain, subject_ref, organisation_id, venue_id, event_id, team_id, user_id, kind) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [row.id, sub.domain, sub.ref, sub.organisation_id ?? null, sub.venue_id ?? null, sub.event_id ?? null, sub.team_id ?? null, row.user_id, kind]);
}

/** What goes back to the caller (and into lists). Coordinates never exist here; for a young person the geofence outcome is not shown to staff either. */
export async function viewOf(c, row, extra = {}) {
  const person = row.user_id ? (await c.query('SELECT id, display_name, avatar_emoji, avatar_color, (youth_until IS NOT NULL AND youth_until > current_date) AS youth FROM users WHERE id=$1', [row.user_id])).rows[0] : null;
  return {
    id: row.id, domain: row.domain, subject_ref: row.subject_ref, method: row.method, direction: row.direction, verdict: row.verdict, reason_code: row.reason_code, message: row.reason_code ? MESSAGES[row.reason_code] ?? null : null,
    verified: row.verified, offline: row.offline, geo_result: person?.youth ? 'not_shown' : row.geo_result, canonical_ref: row.canonical_ref, flags: row.flags, captured_at: row.captured_at, received_at: row.received_at,
    person: person ? { user_id: person.id, display_name: person.display_name, avatar_emoji: person.avatar_emoji, avatar_color: person.avatar_color, youth: person.youth } : null, ...extra,
  };
}

/**
 * Judge one presentation and record it. `req`: { user (null for a signed device), device, domain, subject_ref, method, direction, token, credential, provider, user_id,
 * athlete_id, released_to_user_id, geo, reason_code, note, idempotency_key, offline, captured_at, device_id }. Throws only for things that are not a capture at all
 * (no authority, unknown subject); every judged outcome, good or bad, is a recorded capture row.
 */
export async function capture(c, req) {
  const { user = null, device = false, domain, subject_ref: ref, method } = req;
  const direction = req.direction ?? 'in';
  const ad = ADAPTERS[domain];
  if (!ad) throw badRequest('Unknown access domain');
  if (!METHODS.includes(method)) throw badRequest('Unknown capture method');
  if (!user && !device) throw forbidden();
  if (req.idempotency_key) {
    const prior = (await c.query('SELECT * FROM access_captures WHERE actor_id IS NOT DISTINCT FROM $1 AND idempotency_key=$2', [user?.id ?? null, req.idempotency_key])).rows[0];
    if (prior) return { replayed: true, capture: await viewOf(c, prior) };
  }
  const offline = !!req.offline;
  const at = offline && req.captured_at ? new Date(req.captured_at) : new Date();
  if (offline && +at > Date.now() + 120_000) throw badRequest('captured_at is in the future');
  const sub = await ad.load(c, ref);
  const isOp = device || (user ? await ad.operator(user, sub, c) : false);
  const ctx = { method, at, key: req.idempotency_key ?? null, releasedTo: req.released_to_user_id ?? null, actorId: user?.id ?? null };
  const rec = { method, direction, key: req.idempotency_key ?? null, offline, device_id: req.device_id ?? null, at, actorId: user?.id ?? null, actorKind: device ? 'device' : 'operator', verified: true, flags: offline ? ['offline'] : [] };
  const anomalies = [];
  const finish = async (verdict, reason, extra = {}) => {
    const row = await insertCapture(c, sub, { ...rec, verdict, reason, ...extra });
    for (const k of new Set([...anomalies, ...(offline && verdict === 'denied' && !['already_recorded', 'qr_replay'].includes(reason) ? ['offline_conflict'] : [])])) await anomaly(c, sub, row, k);
    return { capture: await viewOf(c, row, { release_candidates: extra.release_candidates, status: extra.status, basis: extra.basis }), replayed: false };
  };
  if (offline && Date.now() - +at > OFFLINE_MAX_AGE_MS) return finish('denied', 'offline_too_old');

  // ---- who is presenting, and who is the person
  let personId = null, tokenIdx = null;
  const selfFlow = () => { rec.actorKind = 'self'; };
  if (method === 'manual') {
    if (!isOp || device) throw forbidden('Only the staff of this session, team or door can record this by hand');
    if (!MANUAL_REASONS.includes(req.reason_code)) throw badRequest('Say why you are recording this by hand', { reasons: MANUAL_REASONS });
    if (!req.user_id) throw badRequest('Choose the person');
    personId = req.user_id; rec.reasonText = [req.reason_code, req.note].filter(Boolean).join(': '); rec.reason = null; ctx.reasonText = rec.reasonText;
  } else if (method === 'qr') {
    const t = readToken(req.token);
    if (!t) return finish('denied', 'qr_invalid');
    if (t.domain !== domain || t.ref !== ref) return finish('denied', 'qr_wrong_subject');
    const state = checkToken(t, at);
    if (state !== 'ok') return finish('denied', state === 'invalid' ? 'qr_invalid' : 'qr_expired');
    if (t.type === 'P') {
      if (!isOp) throw forbidden('Only staff can scan a personal pass');
      personId = t.userId; tokenIdx = tokenHash(t);
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`qr:${tokenIdx}`]);
      if ((await c.query('SELECT 1 FROM access_captures WHERE token_idx=$1', [tokenIdx])).rowCount) {
        anomalies.push('qr_replay'); rec.personId = personId;
        return finish('denied', 'qr_replay', { personId });
      }
    } else {
      if (!user || device) throw forbidden('A site code is scanned by the person arriving');
      personId = req.athlete_id ?? user.id; selfFlow();
    }
  } else if (method === 'rfid' || method === 'nfc') {
    if (!isOp) throw forbidden('Only staff or a registered reader can present a card or tag');
    const idx = blindIndex(`${req.provider ?? 'generic'}:${req.credential ?? ''}`);
    const cred = req.credential ? (await c.query('SELECT * FROM access_credentials WHERE provider=$1 AND credential_idx=$2 AND status IN (\'active\',\'suspended\') ORDER BY created_at DESC LIMIT 1', [req.provider ?? 'generic', idx])).rows[0] : null;
    if (!cred) { anomalies.push('unknown_credential'); return finish('denied', 'credential_unknown'); }
    personId = cred.user_id;
    if (cred.status !== 'active') { anomalies.push('credential_inactive'); return finish('denied', 'credential_inactive', { personId }); }
    if (cred.expires_at && new Date(cred.expires_at) < at) { anomalies.push('credential_inactive'); return finish('denied', 'credential_expired', { personId }); }
  } else {            // 'geo' and 'self': the person on their own device
    if (!user || device) throw forbidden('Self check-in is done by the person arriving or their guardian');
    personId = req.athlete_id ?? user.id; selfFlow();
    if (method === 'geo' && !sub.geo.enabled) return finish('denied', 'geo_not_enabled', { personId });
  }
  rec.personId = personId;
  if (rec.actorKind === 'self' && personId !== user.id) { await requireGuardian(user, personId, c); rec.actorKind = 'guardian'; }
  const youth = await isYouth(personId, c);
  if (rec.actorKind === 'self' && youth) return finish('denied', 'guardian_required', { personId });
  if (rec.actorKind !== 'operator' && rec.actorKind !== 'device' && !sub.self_allowed) return finish('denied', 'self_checkin_off', { personId });

  // ---- is it the right time, and is the person entitled right now (read live from the canonical data)
  if (method !== 'manual' && sub.window && (at < sub.window.opens || at > sub.window.closes)) { anomalies.push('outside_window'); return finish('denied', 'outside_window', { personId }); }
  const why = await ad.eligibility(c, sub, personId, ctx);
  if (why) {
    const reason = typeof why === 'string' ? why : why.reason;
    const kind = typeof why === 'string' ? ({ booking_cancelled: 'booking_cancelled', membership_inactive: 'membership_inactive', accreditation_cancelled: 'accreditation_cancelled' })[why] : why.anomaly;
    if (kind) anomalies.push(kind);
    return finish('denied', reason, { personId });
  }
  if (youth && (direction === 'out' || method !== 'manual')) {
    const y = await ad.youth(c, sub, personId, direction, ctx);
    if (y) return finish(y.verdict, y.reason, { personId, release_candidates: y.release_candidates });
  }

  // ---- the geofence, only where the organisation switched it on and only for a person using their own device
  let geo_result = 'not_required';
  if (sub.geo.enabled && (rec.actorKind === 'self' || rec.actorKind === 'guardian') && ['qr', 'geo', 'self'].includes(method)) {
    geo_result = geoVerdict(sub.geo, req.geo);
    if (geo_result !== 'inside') {
      if (geo_result === 'outside') anomalies.push('geofence_mismatch');
      return finish('pending_review', geo_result === 'outside' ? 'geofence_mismatch' : 'geo_unavailable', { personId, geo_result });   // staff can confirm by hand
    }
  }

  // ---- anomalies worth reporting (never blocking)
  const dup = (await c.query("SELECT 1 FROM access_captures WHERE user_id=$1 AND domain=$2 AND subject_ref=$3 AND direction=$4 AND verdict IN ('granted','recorded') AND received_at > $5", [personId, domain, ref, direction, new Date(Date.now() - REPEAT_MS)])).rowCount;
  if (dup) anomalies.push('rapid_repeat');
  if (direction === 'in' && (await c.query("SELECT 1 FROM access_captures WHERE user_id=$1 AND direction='in' AND verdict IN ('granted','recorded') AND (domain, subject_ref) <> ($2, $3) AND received_at > $4", [personId, domain, ref, new Date(Date.now() - CONCURRENT_MS)])).rowCount) anomalies.push('concurrent_use');

  // ---- hardware: only after the person is judged entitled, and never faked
  let providerRef = null;
  const point = ad.provider?.(sub);
  const adapter = point ? providerOf(point.provider) : null;
  if (adapter?.hardware && !offline) {
    const out = await adapter.open(point, { direction, reference: `cap_${personId.slice(0, 8)}_${Date.now()}` });
    if (out.outcome === 'unavailable') { anomalies.push('provider_unavailable'); return finish('provider_unavailable', 'provider_unavailable', { personId, geo_result }); }
    if (out.outcome === 'rejected') return finish('denied', 'provider_rejected', { personId, geo_result });
    providerRef = out.ref;
  }

  // ---- the canonical write
  const done = await ad.apply(c, sub, personId, direction, { ...ctx, actorKind: rec.actorKind });
  if (done.deny) return finish('denied', done.deny, { personId, geo_result });
  if (done.hold) return finish('pending_review', done.hold, { personId, geo_result, status: done.status });
  if (done.reason === 'already_recorded') return finish('recorded', 'already_recorded', { personId, geo_result, canonical_ref: done.ref, token_idx: tokenIdx, status: done.status });
  const isGate = domain === 'venue_access' || domain === 'event_gate';
  return finish(isGate ? 'granted' : 'recorded', null, { personId, geo_result, canonical_ref: done.ref, token_idx: tokenIdx, status: done.status, basis: ctx.basis?.type, flags: [...rec.flags, ...(providerRef ? ['provider_confirmed'] : [])] });
}

/** Staff decide a held capture (a geofence miss, no location, a differing staff mark). Accepting records it by hand with the reason; rejecting keeps the evidence only. */
export async function reviewCapture(c, user, captureId, decision, reasonText) {
  const row = (await c.query('SELECT * FROM access_captures WHERE id=$1 FOR UPDATE', [captureId])).rows[0];
  if (!row) throw notFound('Capture');
  const sub = await loadSubject(c, row.domain, row.subject_ref).catch((e) => swallow(e, 404));
  if (!sub || !(await ADAPTERS[row.domain].operator(user, sub, c))) throw notFound('Capture');
  if (row.verdict !== 'pending_review') throw conflict('Only a held capture can be reviewed');
  if ((await c.query('SELECT 1 FROM access_capture_reviews WHERE capture_id=$1', [row.id])).rowCount) throw conflict('This capture was already reviewed');
  let result = null;
  if (decision === 'accepted') {
    const out = await capture(c, { user, domain: row.domain, subject_ref: row.subject_ref, method: 'manual', direction: row.direction, user_id: row.user_id, reason_code: 'correction', note: `review of a held capture: ${reasonText}` });
    if (out.capture.verdict === 'denied') throw conflict(out.capture.message ?? 'That cannot be accepted any more', { reason: out.capture.reason_code });
    result = out.capture.id;
  }
  await c.query('INSERT INTO access_capture_reviews(capture_id, decision, actor_id, reason_enc, result_capture_id) VALUES ($1,$2,$3,$4,$5)', [row.id, decision, user.id, encrypt(reasonText, REASON_CTX), result]);
  await c.query("UPDATE access_anomalies SET status='reviewed', reviewed_by=$2, reviewed_at=now() WHERE capture_id=$1 AND status='open'", [row.id, user.id]);
  return { capture_id: row.id, decision, result_capture_id: result };
}
export const openReason = (enc) => (enc ? decrypt(enc, REASON_CTX) : null);

// ------------------------------------------------------------------------------------------------------------------ pass / site code / offline pack
/** A person's rotating pass for one subject. Young people's passes are held by their guardian. */
export async function passFor(c, user, domain, ref, athleteId) {
  const sub = await loadSubject(c, domain, ref);
  const personId = athleteId ?? user.id;
  if (personId !== user.id) await requireGuardian(user, personId, c);
  else if (await isYouth(personId, c)) throw forbidden('A parent or guardian holds a young person\'s pass');
  if (domain === 'academy_session' || domain === 'team_event') { if (await ADAPTERS[domain].eligibility(c, sub, personId, {})) throw notFound('Session'); }
  return { ...mintToken(domain, ref, { type: 'P', userId: personId }), subject: { domain, ref, label: sub.label } };
}
export async function siteCodeFor(c, user, domain, ref) {
  const sub = await loadSubject(c, domain, ref);
  if (!(await ADAPTERS[domain].operator(user, sub, c))) throw notFound('Subject');
  if (!sub.self_allowed) throw conflict('Self check-in is not switched on here');
  return { ...mintToken(domain, ref, { type: 'S' }), subject: { domain, ref, label: sub.label }, geo_required: !!sub.geo.enabled };
}
/** What a staff device needs to keep scanning without a connection: the key for this one subject, valid until shortly after it ends. Results stay unverified until synced. */
export async function offlinePackFor(c, user, domain, ref) {
  const sub = await loadSubject(c, domain, ref);
  if (!(await ADAPTERS[domain].operator(user, sub, c))) throw notFound('Subject');
  const now = Date.now();
  const until = Math.min((sub.window?.closes ? +sub.window.closes : now) + 2 * 3600_000, now + 12 * 3600_000);
  if (domain === 'venue_access' || domain === 'event_gate') throw conflict('Gates need a live server check, so there is no offline pack for them');
  return { domain, subject_ref: ref, label: sub.label, key: subjectKey(domain, ref), valid_until: new Date(until), steps: STEP, skew: SKEW,
    note: 'Scans made with this key are provisional and labelled offline until they sync. The server re-checks each one then.', created_at: new Date(now) };
}

// ------------------------------------------------------------------------------------------------------------------ grants that follow their source
export { revokeGrantsForSource, settleRevocations, sweepAccessGrants } from './access-grants.js';
export async function issueGrant(c, user, point, { source_type, source_id }) {
  const adapter = providerOf(point.provider);
  if (!adapter?.hardware) throw conflict('This access point has no hardware adapter, so it cannot hold temporary credentials');
  let who, from, to;
  if (source_type === 'booking') {
    const b = (await c.query("SELECT b.id, b.starts_at, b.ends_at, rs.user_id FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN reservations rs ON rs.id=b.reservation_id WHERE b.id=$1 AND r.venue_id=$2 AND b.status='confirmed' AND rs.status='confirmed' AND b.ends_at > now()", [source_id, point.venue_id])).rows[0];
    if (!b) throw notFound('Booking'); who = b.user_id; from = new Date(+new Date(b.starts_at) - point.early_min * 60000); to = new Date(+new Date(b.ends_at) + 30 * 60000);
  } else if (source_type === 'locker_assignment') {
    const a = (await c.query("SELECT user_id, starts_at, ends_at FROM locker_assignments WHERE id=$1 AND venue_id=$2 AND status='active' AND ends_at > now()", [source_id, point.venue_id])).rows[0];
    if (!a) throw notFound('Locker assignment'); who = a.user_id; from = a.starts_at; to = a.ends_at;
  } else {
    const a = (await c.query("SELECT a.holder_id, k.valid_to, coalesce(k.valid_from, now()) AS valid_from FROM accreditations a JOIN accreditation_categories k ON k.id=a.category_id WHERE a.id=$1 AND a.event_id=$2 AND a.status='approved' AND a.access='active'", [source_id, point.event_id])).rows[0];
    if (!a) throw notFound('Accreditation'); who = a.holder_id; from = new Date(a.valid_from); to = a.valid_to ? new Date(a.valid_to) : new Date(Date.now() + 86400000);
  }
  const out = await adapter.provision(point, { reference: `${source_type}:${source_id}`, valid_from: from.toISOString(), valid_to: to.toISOString() });
  if (out.outcome !== 'ok') throw new AppError(502, 'provider_unavailable', out.message ?? 'The door controller did not confirm, so nothing was issued');
  return (await c.query('INSERT INTO access_grants(access_point_id, user_id, source_type, source_id, provider_ref, valid_from, valid_to, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [point.id, who, source_type, source_id, out.ref, from, to, user.id])).rows[0];
}
export const pointOf = (id) => one('SELECT * FROM access_points WHERE id=$1', [id]);

/** A staff correction that undoes an earlier check-in (the canonical row is changed by the caller). Evidence only: who, why, when. */
export async function recordCorrection(c, user, sub, personId, { direction = 'out', reasonText }) {
  const row = await insertCapture(c, sub, { personId, actorId: user.id, actorKind: 'operator', method: 'manual', direction, verdict: 'recorded', reason: 'correction', verified: true, flags: ['undo'], reasonText, at: new Date() });
  return viewOf(c, row);
}
