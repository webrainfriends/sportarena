// Academics & school integration (#783): who may see which academic data, consent resolution, grade-scale handling and the sport-study clash
// check that sits in the academy's pre-publish gate. Nothing here copies a school or an athlete: a link points at the canonical institution
// organisation and the enrolment, and every read decides, per caller, how much of the data they may see.
import { pool } from './db.js';
import { forbidden, notFound, badRequest } from './errors.js';
import { isAdmin } from './helpers.js';
import { opsAccess } from './academy-ops.js';
import { guardianLink, guardianCan, isYouth } from './youth.js';
import { encrypt, decrypt } from './crypto.js';

export const ITEM_KINDS = ['class_block', 'exam', 'tutoring', 'school_event', 'holiday', 'deadline'];
export const SOURCES = ['manual_verified', 'partner_import', 'partner_api', 'athlete_entered'];
export const SNAPSHOT_SOURCES = ['school_report', 'partner_import', 'partner_api', 'manual_verified', 'self_reported'];
export const BANDS = ['on_track', 'watch', 'support_needed'];
export const SCOPES = ['timetable', 'attendance', 'attainment'];
export const SCHOOL_KINDS = ['school', 'college', 'university'];
const SCHOOL_ROLES = ['owner', 'admin', 'coach', 'staff'];
const MAX_CONSENT_DAYS = 366;
const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);
export const ymd = (d) => (d == null ? null : typeof d === 'string' ? d.slice(0, 10) : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10));
export const sealJson = (v, ctx) => encrypt(JSON.stringify(v), ctx);
export const openJson = (s, ctx) => (s ? JSON.parse(decrypt(s, ctx)) : null);

// ---------------------------------------------------------------------------- consent
/** The live grant for a party (academy or school), or null: not revoked and not past its end date. */
export const consentFor = async (c, athleteId, partyOrgId) => (await (c ?? pool).query(
  'SELECT *, expires_on::text AS expires_on FROM academic_consents WHERE athlete_id=$1 AND party_org_id=$2 AND revoked_at IS NULL AND expires_on >= CURRENT_DATE', [athleteId, partyOrgId])).rows[0] ?? null;
export const covers = (grant, scope) => !!grant && grant.scopes.includes(scope);
export const maxExpiry = () => addDays(today(), MAX_CONSENT_DAYS);

/** Who may grant for this athlete: themselves if an adult; a verified guardian with consent authority if a minor (a minor cannot grant). */
export async function grantor(c, user, athleteId, orgId) {
  const youth = await isYouth(athleteId, c);
  if (!youth) { if (user.id === athleteId) return 'athlete'; }
  else { const link = await guardianLink(user.id, athleteId, c); if (link && (await guardianCan(link, 'consent', orgId, c))) return 'guardian'; if (user.id === athleteId) throw forbidden('A young athlete\'s guardian grants or withdraws academic consent'); }
  return null;
}

// ---------------------------------------------------------------------------- what a caller may see of one link
/**
 * Resolve the caller's view of an academic link. Returns { side, timetable, attendance, attainment, record, manage } where
 *   timetable:  none | blocks (kind + time only) | full (adds the subject text)
 *   attendance: none | flag (only whether it is below the floor) | summary (the numbers)
 *   attainment: none | band (progress band only) | detail (subject-level values)
 * Athlete and guardian see everything of their own; the school sees what it may record for athletes who granted it; the academy only sees what
 * the athlete granted it AND what the staff member's own academic permission allows. No other audience exists.
 */
export async function viewOf(c, user, link) {
  const q = c ?? pool, none = { side: null, timetable: 'none', attendance: 'none', attainment: 'none', record: false, manage: false };
  if (user.id === link.athlete_id) return { ...none, side: 'athlete', timetable: 'full', attendance: 'summary', attainment: 'detail', record: false, manage: false, own: true };
  const gl = await guardianLink(user.id, link.athlete_id, q);
  if (gl) return { ...none, side: 'guardian', timetable: 'full', attendance: 'summary', attainment: 'detail', record: false, manage: false, own: true };
  // the school: a member of the linked institution, for what the athlete granted that school
  const sm = (await q.query("SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [link.school_org_id, user.id])).rows[0];
  if (sm && SCHOOL_ROLES.includes(sm.role)) {
    const g = await consentFor(q, link.athlete_id, link.school_org_id);
    if (g && link.status === 'active') return { ...none, side: 'school', timetable: covers(g, 'timetable') ? 'full' : 'none', attendance: covers(g, 'attendance') ? 'summary' : 'none', attainment: covers(g, 'attainment') ? 'detail' : 'none', record: true, grant: g };
  }
  // the academy
  let a = null;
  try { a = await opsAccess(user, link.organisation_id, { c: q }); } catch { return none; }
  const g = await consentFor(q, link.athlete_id, link.organisation_id);
  const lead = a.has('academics'), detailOk = a.has('academics_detail');
  const out = { ...none, side: 'academy', manage: lead, record: lead, grant: g, lead, detailOk };
  if (!g) return out;
  if (covers(g, 'timetable')) out.timetable = lead && g.detail === 'detail' ? 'full' : a.has('schedule') || lead || a.has('attendance') ? 'blocks' : 'none';
  if (covers(g, 'attendance')) out.attendance = lead ? 'summary' : a.has('attendance') || a.has('roster') ? 'flag' : 'none';
  if (covers(g, 'attainment')) out.attainment = detailOk && g.detail === 'detail' ? 'detail' : lead || a.has('roster') || a.has('attendance') ? 'band' : 'none';
  return out;
}

export async function linkFor(c, id) {
  const l = (await (c ?? pool).query("SELECT l.*, l.starts_on::text AS starts_on, l.ends_on::text AS ends_on, sc.name AS school_name, sc.kind AS school_kind, sc.approval_status AS school_approval, u.display_name AS athlete_name FROM academic_links l JOIN organisations sc ON sc.id=l.school_org_id JOIN users u ON u.id=l.athlete_id WHERE l.id=$1", [id])).rows[0];
  if (!l) throw notFound('Academic link');
  return l;
}
/** The link the caller may see at all, else 404 (existence is not leaked). */
export async function visibleLink(c, user, id) {
  const l = await linkFor(c, id), v = await viewOf(c, user, l);
  if (!v.side || (v.side === 'academy' && !v.manage && v.timetable === 'none' && v.attendance === 'none' && v.attainment === 'none')) {
    if (!(isAdmin(user))) throw notFound('Academic link');
  }
  return { l, v: v.side ? v : { ...v, side: 'academy', manage: true, record: true } };
}

export const logRead = (c, athleteId, orgId, user, side, scope, detail = 'summary') =>
  (c ?? pool).query('INSERT INTO academic_access_log(athlete_id, organisation_id, actor_id, actor_side, scope, detail) VALUES ($1,$2,$3,$4,$5,$6)', [athleteId, orgId ?? null, user.id, side ?? 'academy', scope, detail]);

// ---------------------------------------------------------------------------- scales
const LETTER = { A: 95, B: 80, C: 65, D: 50, E: 35, F: 20, U: 10 };
const CBSE = { A1: 95, A2: 88, B1: 80, B2: 72, C1: 64, C2: 56, D: 48, E1: 35, E2: 25 };
export const SCALES = {
  percent: { label: 'Percentage (0–100)', check: (v) => Number.isFinite(+v) && +v >= 0 && +v <= 100, norm: (v) => +v },
  letter_a_e: { label: 'Letter grade (A–E, F, U)', options: Object.keys(LETTER), check: (v) => v in LETTER, norm: (v) => LETTER[v] },
  numeric_1_9: { label: 'Numeric 9–1 (GCSE style)', check: (v) => Number.isInteger(+v) && +v >= 1 && +v <= 9, norm: (v) => (+v / 9) * 100 },
  numeric_1_7: { label: 'IB 1–7', check: (v) => Number.isInteger(+v) && +v >= 1 && +v <= 7, norm: (v) => (+v / 7) * 100 },
  gpa_4: { label: 'GPA (0–4)', check: (v) => Number.isFinite(+v) && +v >= 0 && +v <= 4, norm: (v) => (+v / 4) * 100 },
  cbse_grade: { label: 'CBSE grade (A1–E2)', options: Object.keys(CBSE), check: (v) => v in CBSE, norm: (v) => CBSE[v] },
  custom: { label: 'Custom bands', check: () => true, norm: () => 50 },
};
export function normalise(scale, bands, value) {
  if (scale === 'custom') { const i = (bands ?? []).indexOf(value); return i < 0 || bands.length < 2 ? null : 100 - (i * 100) / (bands.length - 1); }
  return SCALES[scale].norm(value);
}
export function checkValue(fw, value) {
  if (fw.scale === 'custom') { if (!(fw.bands ?? []).includes(String(value))) throw badRequest(`"${value}" is not one of this framework's bands`); return String(value); }
  if (!SCALES[fw.scale].check(String(value).toUpperCase() in LETTER || String(value).toUpperCase() in CBSE ? String(value).toUpperCase() : value)) throw badRequest(`"${value}" is not valid on the ${SCALES[fw.scale].label} scale`);
  return ['letter_a_e', 'cbse_grade'].includes(fw.scale) ? String(value).toUpperCase() : value;
}
/** A suggested progress band from the average normalised value; the person recording confirms or changes it (it is a human judgement). */
export function suggestBand(fw, rows) {
  const n = rows.map((r) => normalise(fw.scale, fw.bands, r.value)).filter((x) => x != null);
  if (!n.length) return 'watch';
  const avg = n.reduce((a, b) => a + b, 0) / n.length;
  return avg < (fw.support_below ?? 45) ? 'support_needed' : avg < (fw.watch_below ?? 60) ? 'watch' : 'on_track';
}

// ---------------------------------------------------------------------------- recurring items
function localParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(date);
  const g = (t) => f.find((p) => p.type === t).value;
  return { day: `${g('year')}-${g('month')}-${g('day')}`, minutes: +g('hour') * 60 + +g('minute'), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')) };
}
const mins = (t) => { const [h, m] = String(t).split(':'); return +h * 60 + +m; };
/** Does the item overlap [start, end)? One-off items by instant; weekly items by local weekday, date range and time of day in the item's own zone. */
export function overlaps(item, start, end) {
  if (item.starts_at) return new Date(item.starts_at) < end && new Date(item.ends_at) > start;
  const a = localParts(start, item.timezone), b = localParts(new Date(end.getTime() - 1), item.timezone);
  const days = a.day === b.day ? [[a.day, a.weekday, a.minutes, b.minutes + 1]] : [[a.day, a.weekday, a.minutes, 1440], [b.day, b.weekday, 0, b.minutes + 1]];
  const from = ymd(item.from_on), to = item.to_on ? ymd(item.to_on) : '9999-12-31';
  return days.some(([d, wd, s, e]) => item.weekdays.includes(wd) && d >= from && d <= to && s < mins(item.end_time) && e > mins(item.start_time));
}

// ---------------------------------------------------------------------------- the clash check used by the publication gate
const LABEL = { exam: 'a school exam', class_block: 'school lessons', tutoring: 'a tutoring session', school_event: 'a school event' };
/**
 * Athletes in the session's group whose consented school timetable overlaps it. Only items that block sport count; holidays never block.
 * Staff see the athlete, the kind of commitment and the time, never the subject: the clash is reported from blocks only.
 */
export async function academicClashes(c, s) {
  const rows = (await c.query(
    `SELECT l.id AS link_id, l.athlete_id, u.display_name FROM academic_links l JOIN org_enrolments e ON e.id=l.enrolment_id JOIN users u ON u.id=l.athlete_id
      WHERE e.cohort_id=$1 AND e.status='enrolled' AND l.status='active' AND l.organisation_id=$2
        AND EXISTS (SELECT 1 FROM academic_consents g WHERE g.athlete_id=l.athlete_id AND g.party_org_id=l.organisation_id AND g.revoked_at IS NULL AND g.expires_on >= CURRENT_DATE AND 'timetable' = ANY(g.scopes))`,
    [s.cohort_id, s.organisation_id])).rows;
  if (!rows.length) return [];
  const items = (await c.query("SELECT i.*, i.from_on::text AS from_on, i.to_on::text AS to_on, i.start_time::text AS start_time, i.end_time::text AS end_time FROM academic_items i WHERE i.link_id = ANY($1) AND i.status='active' AND i.blocks_sport AND i.kind IN ('exam','class_block','tutoring','school_event')", [rows.map((r) => r.link_id)])).rows;
  const start = new Date(s.starts_at), end = new Date(s.ends_at), out = [];
  const holidays = (await c.query("SELECT i.link_id, i.starts_at, i.ends_at, i.weekdays, i.start_time::text AS start_time, i.end_time::text AS end_time, i.from_on::text AS from_on, i.to_on::text AS to_on, i.timezone FROM academic_items i WHERE i.link_id = ANY($1) AND i.status='active' AND i.kind='holiday'", [rows.map((r) => r.link_id)])).rows;
  const onHoliday = (linkId) => holidays.some((h) => h.link_id === linkId && overlaps(h, start, end));
  for (const it of items) {
    if (!overlaps(it, start, end)) continue;
    if (it.kind === 'class_block' && onHoliday(it.link_id)) continue;   // lessons do not run on a school holiday
    const who = rows.find((r) => r.link_id === it.link_id);
    out.push({ kind: 'academic', code: it.kind === 'exam' ? (it.high_stakes ? 'school_exam_high_stakes' : 'school_exam_clash') : `school_${it.kind}_clash`, message: `${who.display_name} has ${LABEL[it.kind]} at that time${it.high_stakes ? ' (high-stakes exam)' : ''}`, user_id: who.athlete_id, source_type: 'academic_item', source_id: it.id, link_id: it.link_id });
  }
  return out;
}

// ---------------------------------------------------------------------------- the academic section of the academy's Athlete 360
/**
 * One section for get_academy_athlete_360, in the same { access, source, origin, data } shape as the sport sections, so sport and academic progress
 * are displayed side by side but never merged. It carries only what this caller may see: bands and flags, never subject-level grades.
 */
export async function academicSection(c, user, orgId, athleteId) {
  const l = (await c.query(
    `SELECT l.*, sc.name AS school_name, sc.kind AS school_kind, sc.approval_status AS school_approval, u.display_name AS athlete_name FROM academic_links l JOIN organisations sc ON sc.id=l.school_org_id JOIN users u ON u.id=l.athlete_id
      WHERE l.organisation_id=$1 AND l.athlete_id=$2 AND l.status='active' ORDER BY l.created_at DESC LIMIT 1`, [orgId, athleteId])).rows[0];
  const source = 'academic_snapshots / academic_attendance / academic_items (supplied by the school, shared by the athlete)';
  if (!l) return { access: 'none', reason: 'Not linked to a school', source };
  const v = await viewOf(c, user, l);
  if (v.side !== 'academy' || (v.timetable === 'none' && v.attendance === 'none' && v.attainment === 'none')) {
    return { access: v.side === 'academy' && !v.grant ? 'no_consent' : 'forbidden', reason: v.side === 'academy' && !v.grant ? 'The athlete or guardian has not shared academic information with the academy' : 'Your role does not include this section', source, data: { school: { name: l.school_name, year_group: l.year_group } } };
  }
  const data = { school: { id: l.school_org_id, name: l.school_name, verified: l.school_approval === 'approved', year_group: l.year_group, curriculum: l.curriculum }, view: { timetable: v.timetable, attendance: v.attendance, attainment: v.attainment }, note: 'Subject-level grades are never part of this overview.' };
  if (v.attainment !== 'none') {
    const s = (await c.query("SELECT s.term_label, s.progress_band, s.version, s.source_kind, s.verified_at, o.name AS source_name FROM academic_snapshots s LEFT JOIN organisations o ON o.id=s.source_org_id WHERE s.link_id=$1 AND NOT EXISTS (SELECT 1 FROM academic_snapshots n WHERE n.supersedes_id=s.id) ORDER BY s.created_at DESC LIMIT 1", [l.id])).rows[0];
    data.band = s ? { term: s.term_label, band: s.progress_band, version: s.version, source_kind: s.source_kind, source_name: s.source_name, verified: !!s.verified_at } : null;
  }
  if (v.attendance !== 'none') {
    const a = (await c.query("SELECT x.sessions_total, x.present, x.period_to::text AS period_to FROM academic_attendance x WHERE x.link_id=$1 AND NOT EXISTS (SELECT 1 FROM academic_attendance n WHERE n.supersedes_id=x.id) ORDER BY x.period_to DESC LIMIT 1", [l.id])).rows[0];
    const floor = (await c.query('SELECT coalesce(min(attendance_floor_pct), 90)::int AS f FROM academic_frameworks WHERE organisation_id=$1 AND archived_at IS NULL', [orgId])).rows[0].f;
    const pct = a?.sessions_total ? Math.round((a.present / a.sessions_total) * 1000) / 10 : null;
    data.attendance = a ? { period_to: a.period_to, below_floor: pct < floor, ...(v.attendance === 'summary' ? { pct } : {}) } : null;
  }
  if (v.timetable !== 'none') {
    const x = (await c.query("SELECT i.starts_at, i.high_stakes FROM academic_items i WHERE i.link_id=$1 AND i.status='active' AND i.kind='exam' AND i.starts_at > now() ORDER BY i.starts_at LIMIT 1", [l.id])).rows[0];
    data.next_exam = x ? { starts_at: x.starts_at, high_stakes: x.high_stakes } : null;
  }
  await logRead(c, athleteId, orgId, user, 'academy', 'attainment', v.attainment === 'none' ? 'summary' : v.attainment === 'detail' ? 'summary' : v.attainment);
  return { access: 'ok', source, origin: 'school_reported', data };
}
