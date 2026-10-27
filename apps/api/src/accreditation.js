// Event accreditation (#481): the rules behind credentials, kept apart from the capability definitions so every access surface (REST, MCP, the
// gate scanner) judges a badge the same way. People are never copied: eligibility is read live from the canonical engagements of the event.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pool } from './db.js';
import { blindIndex } from './crypto.js';
import { isOrganiser } from './capabilities/event-departments.js';
import { hasConsent, isYouth } from './youth.js';

export const ENGAGEMENTS = {
  athlete: { label: 'Athlete', description: 'Accepted entry, or a place on an accepted team' },
  team_staff: { label: 'Team staff', description: 'Coach, manager, physio or owner of an accepted team' },
  official: { label: 'Official', description: 'Referee, umpire, linesman, scorer, assessor' },
  medical: { label: 'Medical', description: 'Doctor, physio, first aid' },
  volunteer: { label: 'Volunteer', description: 'Volunteer or marshal' },
  security: { label: 'Security', description: 'Security and access control' },
  media: { label: 'Media', description: 'Media, photographers, broadcasters' },
  vendor: { label: 'Vendor', description: 'Retail, catering and other stalls' },
  sponsor: { label: 'Sponsor', description: 'Sponsor and partner hospitality' },
  hospitality: { label: 'Hospitality', description: 'Hospitality and VIP care' },
  operations: { label: 'Operations', description: 'Operations, logistics, tech and ceremonies' },
  guest: { label: 'Guest', description: 'Invited by the organiser, with no other role at the event' },
};
export const ZONE_KINDS = {
  field_of_play: 'Field of play', athlete_area: 'Athlete area', locker_room: 'Locker room', officials_room: 'Officials room', media_centre: 'Media centre',
  mixed_zone: 'Mixed zone', hospitality: 'Hospitality', operations: 'Operations', loading_service: 'Loading and service area', medical: 'Medical', custom: 'Custom zone',
};
export const OPEN_STATUSES = ['draft', 'submitted', 'under_review', 'approved'];
export const SCAN_RESULTS = ['valid', 'invalid', 'expired', 'not_yet_valid', 'revoked', 'suspended', 'replaced', 'wrong_event', 'wrong_zone', 'outside_hours', 'not_eligible'];

const STAFF_TO_ENGAGEMENT = { referee: 'official', umpire: 'official', linesman: 'official', scorer: 'official', assessor: 'official', doctor: 'medical', physio: 'medical', medic: 'medical', volunteer: 'volunteer', security: 'security', retail: 'vendor', catering: 'vendor', vendor: 'vendor', other: 'operations' };
const DEPARTMENT_TO_ENGAGEMENT = { media: 'media', officials: 'official', medical: 'medical', security: 'security', volunteers: 'volunteer', hospitality: 'hospitality' };
const VENDOR_TO_ENGAGEMENT = { sponsor: 'sponsor', retail: 'vendor', catering: 'vendor', other: 'vendor' };
const TEAM_STAFF_ROLES = ['coach', 'manager', 'physio'];

/** What the person is at this event, read live from the canonical records. Nothing here is stored on the credential. */
export async function engagementsOf(c, ev, userId) {
  const out = new Set();
  const add = (rows, key) => rows.forEach((r) => { const k = typeof key === 'function' ? key(r) : key; if (k) out.add(k); });
  add((await c.query("SELECT r.role FROM event_staff_assignments a JOIN event_staff_roles r ON r.id=a.role_id WHERE a.event_id=$1 AND a.user_id=$2 AND a.status='accepted'", [ev.id, userId])).rows, (r) => STAFF_TO_ENGAGEMENT[r.role] ?? 'operations');
  add((await c.query("SELECT 1 FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id WHERE f.event_id=$1 AND fo.user_id=$2 AND fo.status='accepted' LIMIT 1", [ev.id, userId])).rows, 'official');
  add((await c.query("SELECT kind FROM event_vendors WHERE event_id=$1 AND vendor_user_id=$2 AND status='accepted'", [ev.id, userId])).rows, (r) => VENDOR_TO_ENGAGEMENT[r.kind]);
  add((await c.query("SELECT 1 FROM event_entries WHERE event_id=$1 AND user_id=$2 AND status='accepted' LIMIT 1", [ev.id, userId])).rows, 'athlete');
  add((await c.query(
    `SELECT m.role FROM event_entries en JOIN team_members m ON m.team_id=en.team_id
      WHERE en.event_id=$1 AND en.status='accepted' AND m.user_id=$2 AND m.status='active'`, [ev.id, userId])).rows, (r) => (TEAM_STAFF_ROLES.includes(r.role) ? 'team_staff' : 'athlete'));
  add((await c.query("SELECT 1 FROM event_entries en JOIN teams t ON t.id=en.team_id WHERE en.event_id=$1 AND en.status='accepted' AND t.owner_id=$2 LIMIT 1", [ev.id, userId])).rows, 'team_staff');
  add((await c.query("SELECT d.kind FROM event_department_members m JOIN event_departments d ON d.id=m.department_id WHERE m.event_id=$1 AND m.user_id=$2 AND m.status='active' AND d.status='active'", [ev.id, userId])).rows, (r) => DEPARTMENT_TO_ENGAGEMENT[r.kind] ?? 'operations');
  if (ev.organizer_id === userId) out.add('operations');
  return out;
}

/** Eligible when the person holds one of the category's engagements; an organiser invitation covers the 'guest' engagement. */
export const eligibleFor = (cat, engagements, { invited = false } = {}) => (invited && cat.eligible.includes('guest')) || cat.eligible.some((e) => e !== 'guest' && engagements.has(e));

/** Gate operators: the organiser, accepted security staff, and active members of security or operations departments. */
export async function isGateOperator(user, ev, c = pool) {
  if (await isOrganiser(user, ev, c)) return true;
  if ((await c.query("SELECT 1 FROM event_staff_assignments a JOIN event_staff_roles r ON r.id=a.role_id WHERE a.event_id=$1 AND a.user_id=$2 AND a.status='accepted' AND r.role='security' LIMIT 1", [ev.id, user.id])).rowCount) return true;
  return !!(await c.query("SELECT 1 FROM event_department_members m JOIN event_departments d ON d.id=m.department_id WHERE m.event_id=$1 AND m.user_id=$2 AND m.status='active' AND d.status='active' AND d.kind IN ('security','operations') LIMIT 1", [ev.id, user.id])).rowCount;
}

// ---- the QR token -------------------------------------------------------------------------------------------------------------------------
// GA1.<serial>.<version>.<mac>: no name, no id, nothing personal. The mac proves the server issued it; the version invalidates old copies.
const mac = (serial, version) => blindIndex(`accreditation:${serial}:${version}`).slice(0, 20);
export const tokenFor = (serial, version) => `GA1.${serial}.${version}.${mac(serial, version)}`;
export function parseToken(raw) {
  const m = /^GA1\.(ACR-[A-Z0-9]{10})\.(\d{1,6})\.([0-9a-f]{20})$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const want = Buffer.from(mac(m[1], m[2])), got = Buffer.from(m[3]);
  return want.length === got.length && timingSafeEqual(want, got) ? { serial: m[1], version: Number(m[2]) } : null;
}
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newSerial = () => `ACR-${Array.from(randomBytes(10), (b) => ALPHABET[b & 31]).join('')}`;

/** The category with its zones, and the event dates it falls back on. */
export async function categoryOf(c, categoryId) {
  const k = (await c.query('SELECT * FROM accreditation_categories WHERE id=$1', [categoryId])).rows[0];
  if (!k) return null;
  k.zone_ids = (await c.query('SELECT zone_id FROM accreditation_category_zones WHERE category_id=$1 AND removed_at IS NULL', [categoryId])).rows.map((r) => r.zone_id);
  return k;
}

/** Final validity window, always read live: the category's own, else the event's first to last day in the category's time zone. Needs aliases k (category) and e (event). */
export const WINDOW_SQL = `coalesce(k.valid_from, (e.starts_on)::timestamp AT TIME ZONE k.timezone) AS valid_from,
  coalesce(k.valid_to, ((coalesce(e.ends_on, e.starts_on) + 1))::timestamp AT TIME ZONE k.timezone) AS valid_to`;

/** The consent purpose a young holder's credential depends on. */
export const purposeOf = (cat) => (cat.eligible.length === 1 && cat.eligible[0] === 'media' ? 'media' : 'participation');

/** What stops this person being accredited in this category, or null. Applications that fail this are refused, nobody can override it. */
export async function blocker(c, ev, cat, userId, { invited = false } = {}) {
  if (cat.status !== 'active') return 'This category is closed';
  if (['completed', 'cancelled'].includes(ev.status)) return `The event is ${ev.status}`;
  if (!eligibleFor(cat, await engagementsOf(c, ev, userId), { invited })) return 'Not eligible: this category is for people with a matching role at this event';
  if (cat.requires_verification) {
    const ok = (await c.query("SELECT 1 FROM verification_cases WHERE subject_type='user' AND subject_id=$1 AND type=$2 AND status='approved' AND expires_at > now() LIMIT 1", [userId, cat.requires_verification])).rowCount;
    if (!ok) return `Needs a current ${cat.requires_verification} verification`;
  }
  if (await isYouth(userId, c) && !(await hasConsent(userId, purposeOf(cat), c))) return 'A verified guardian has not given current consent';
  return null;
}

export const record = (c, accId, actor, kind, from, to, version, reason) =>
  c.query('INSERT INTO accreditation_history(accreditation_id, actor_id, kind, from_status, to_status, credential_version, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)', [accId, actor, kind, from ?? null, to ?? null, version ?? null, reason ?? null]);

const FLAG = { draft: 'requested', submitted: 'requested', under_review: 'requested', approved: 'issued', revoked: 'revoked', rejected: 'none', withdrawn: 'none' };
/** Keep the department roster's badge flag in step so the roster shows the real state (the flag is a projection, not a second source). */
export const syncRosterFlag = (c, acc) =>
  c.query("UPDATE event_department_members SET accreditation=$3 WHERE event_id=$1 AND user_id=$2 AND status IN ('invited','active')", [acc.event_id, acc.holder_id, FLAG[acc.status] ?? 'none']);

/** Effective state of a credential right now: what a holder or operator should see. */
export function effectiveStatus(a, now = new Date()) {
  if (a.status !== 'approved') return a.status;
  if (a.access === 'suspended') return 'suspended';
  if (a.valid_to && new Date(a.valid_to) < now) return 'expired';
  if (a.valid_from && new Date(a.valid_from) > now) return 'not_yet_valid';
  return 'approved';
}

/** One scan, judged deterministically against live data. Returns { result, accreditation?, zone? } (never throws for a bad badge). */
export async function judge(c, ev, token, zoneId) {
  const t = parseToken(token);
  if (!t) return { result: 'invalid' };
  const a = (await c.query(
    `SELECT a.*, ${WINDOW_SQL}, k.name AS category, k.colour, k.requires_photo, k.eligible, k.venue_id AS category_venue_id, k.escort_required, k.vehicle_access, k.equipment_access, k.daily_from, k.daily_to, k.timezone,
            u.display_name, u.handle, u.avatar_emoji, u.avatar_color, u.avatar_url
       FROM accreditations a JOIN accreditation_categories k ON k.id=a.category_id JOIN events e ON e.id=a.event_id JOIN users u ON u.id=a.holder_id WHERE a.serial=$1`, [t.serial])).rows[0];
  if (!a) return { result: 'invalid' };
  const out = (result, extra = {}) => ({ result, accreditation: a, ...extra });
  if (a.event_id !== ev.id) return out('wrong_event');
  if (a.credential_version !== t.version) return out('replaced');
  if (a.status === 'revoked') return out('revoked');
  if (a.status !== 'approved') return out('invalid');
  if (a.access === 'suspended') return out('suspended');
  const now = new Date();
  if (a.valid_from && new Date(a.valid_from) > now) return out('not_yet_valid');
  if (a.valid_to && new Date(a.valid_to) < now) return out('expired');
  if (a.daily_from) {
    const local = (await c.query('SELECT (now() AT TIME ZONE $1)::time AS t', [a.timezone])).rows[0].t;
    const inside = a.daily_from <= a.daily_to ? local >= a.daily_from && local <= a.daily_to : local >= a.daily_from || local <= a.daily_to;
    if (!inside) return out('outside_hours');
  }
  if (a.origin !== 'invitation' || !a.eligible.includes('guest')) {
    if (!eligibleFor({ eligible: a.eligible }, await engagementsOf(c, ev, a.holder_id))) return out('not_eligible'); // the role behind it has ended
  }
  if (await isYouth(a.holder_id, c) && !(await hasConsent(a.holder_id, purposeOf({ eligible: a.eligible }), c))) return out('not_eligible'); // guardian consent withdrawn
  const zones = (await c.query('SELECT z.id, z.name, z.kind, z.venue_id FROM accreditation_category_zones cz JOIN accreditation_zones z ON z.id=cz.zone_id WHERE cz.category_id=$1 AND cz.removed_at IS NULL AND z.archived_at IS NULL ORDER BY z.name', [a.category_id])).rows;
  if (zoneId) {
    const z = zones.find((x) => x.id === zoneId);
    if (!z || (a.category_venue_id && z.venue_id && z.venue_id !== a.category_venue_id)) return out('wrong_zone', { zones });
  }
  return out('valid', { zones });
}

/** What a gate operator may see of the person: just enough to match the badge to the face. Photos only where policy allows. */
export async function gateView(r) {
  const a = r.accreditation;
  if (!a || ['invalid', 'wrong_event', 'replaced'].includes(r.result)) return { result: r.result };
  const showPhoto = r.result === 'valid' && a.requires_photo && !(await isYouth(a.holder_id));
  return {
    result: r.result,
    credential_id: a.serial,
    holder: { display_name: a.display_name, avatar_emoji: a.avatar_emoji, avatar_color: a.avatar_color, avatar_url: showPhoto ? a.avatar_url : null },
    category: { name: a.category, colour: a.colour },
    ...(r.result === 'valid' ? { zones: (r.zones ?? []).map((z) => ({ id: z.id, name: z.name, kind: z.kind })), escort_required: a.escort_required, vehicle_access: a.vehicle_access, equipment_access: a.equipment_access, valid_to: a.valid_to } : {}),
  };
}
