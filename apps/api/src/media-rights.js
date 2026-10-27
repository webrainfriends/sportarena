// Sports Media, Broadcast & Rights Management (#482): the rules every media-rights capability shares. A media partner is an organisation; events, fixtures,
// users, teams, venue media, sponsorships, agreements and invoices are referenced, never copied. Rights are always read live: a licence past its end date is
// already "expired" to everyone, so nothing depends on the sweep having run. Nothing is deleted; closing is a status and every step lands in `mr_log`.
import { pool } from './db.js';
import { forbidden, notFound } from './errors.js';
import { isAdmin } from './helpers.js';
import { hasOrgGrant, orgRole } from './org-access.js';
import { hasConsent } from './youth.js';

export const RIGHTS = {
  live_video: 'Live video', delayed_video: 'Delayed / replay video', highlights: 'Highlights', short_form: 'Short-form clips', audio: 'Audio / radio commentary',
  photography: 'Photography', press: 'Press & news access', data_feed: 'Official data & statistics feed', archive: 'Archive footage', social: 'Social / digital publication',
};
export const RIGHT_KEYS = Object.keys(RIGHTS);
export const PLATFORMS = ['linear_tv', 'ott', 'web', 'mobile_app', 'social', 'radio', 'in_venue', 'print'];
export const PARTNER_KINDS = ['broadcaster', 'streaming_platform', 'radio', 'press', 'photo_agency', 'production_company', 'data_licensee', 'digital_platform', 'other'];
export const CREW_ROLES = ['producer', 'director', 'camera_operator', 'commentator', 'analyst', 'photographer', 'audio_engineer', 'technical_crew', 'reporter', 'other'];
export const RESTRICTED_ZONES = ['locker_room', 'athlete_area', 'officials_room', 'medical_area', 'team_bench'];
export const ZONES = ['media_centre', 'mixed_zone', 'press_box', 'broadcast_compound', 'field_of_play', ...RESTRICTED_ZONES];
export const STREAM_PROVIDERS = {
  youtube: 'YouTube Live', twitch: 'Twitch', vimeo: 'Vimeo Live', facebook: 'Facebook Live', mux: 'Mux', cloudflare_stream: 'Cloudflare Stream', aws_ivs: 'Amazon IVS', custom_hls: 'Your own HLS / RTMP endpoint', other_external: 'Another external provider',
};
/** Rights that can be exercised while a game is on; every other right is "after the fact" and so follows the package's delay. */
export const LIVE_RIGHTS = ['live_video', 'audio', 'photography', 'press', 'data_feed'];
export const WRITE_ROLES = ['owner', 'admin', 'manager', 'legal', 'approver'];

/** A licence is in force right now: active, inside its dates, the package still offered and the partner not suspended. */
export const IN_FORCE = (l = 'l', p = 'p', m = 'm') => `(${l}.stage='active' AND ${l}.effective_from <= now() AND ${l}.effective_to > now() AND ${p}.status <> 'withdrawn' AND ${m}.status='active')`;
/** The stage everyone is shown today (an active licence past its end date reads as expired without waiting for a sweep). */
export const LIC_STAGE = (l = 'l') => `CASE WHEN ${l}.stage IN ('active','suspended') AND ${l}.effective_to <= now() THEN 'expired' ELSE ${l}.stage END`;

export const logMr = (c, eventId, type, subjectId, action, { actor = null, detail = {} } = {}) =>
  c.query('INSERT INTO mr_log(event_id, subject_type, subject_id, action, actor_id, detail) VALUES ($1,$2,$3,$4,$5,$6)', [eventId, type, subjectId, action, actor, JSON.stringify(detail)]);

export const historyOf = async (type, subjectId, c = pool) => (await c.query(
  'SELECT l.action, l.at, l.detail, u.display_name AS actor_name FROM mr_log l LEFT JOIN users u ON u.id=l.actor_id WHERE l.subject_type=$1 AND l.subject_id=$2 ORDER BY l.at, l.id', [type, subjectId])).rows;

// ------------------------------------------------------------------ authority
export async function eventOf(eventId, c) {
  const ev = (await (c ?? pool).query('SELECT * FROM events WHERE id=$1', [eventId])).rows[0];
  if (!ev) throw notFound('Event');
  return ev;
}
export const isOrganiserOf = async (user, ev, c) => !!user && (isAdmin(user) || user.id === ev.organizer_id || await hasOrgGrant(user, ev.organisation_id, ['owner', 'admin'], c ?? pool));

/** The partner organisations the user belongs to (any active role), with whether that role can act for the partner. */
export async function myPartners(user, c) {
  if (!user) return [];
  const rows = (await (c ?? pool).query(
    `SELECT m.id AS partner_id, m.kind, m.status, o.id AS organisation_id, o.name, om.role
       FROM media_partners m JOIN organisations o ON o.id=m.organisation_id
       JOIN organisation_members om ON om.organisation_id=o.id AND om.user_id=$1 AND om.status='active'
      WHERE o.status='active' ORDER BY o.name`, [user.id])).rows;
  return rows.map((r) => ({ ...r, can_act: WRITE_ROLES.includes(r.role) }));
}
/** A partner the caller belongs to. 404 for outsiders, 403 when the role cannot act and `write` is asked. */
export async function partnerFor(user, partnerId, { write = false, c: client } = {}) {
  const c = client ?? pool;
  const p = (await c.query('SELECT m.*, o.name, o.status AS org_status FROM media_partners m JOIN organisations o ON o.id=m.organisation_id WHERE m.id=$1', [partnerId])).rows[0];
  const role = p ? await orgRole(user, p.organisation_id, c) : null;
  if (!p || !role) throw notFound('Media partner');
  if (write && !WRITE_ROLES.includes(role)) throw forbidden('Your role in this organisation cannot act for the media partner');
  if (write && (p.status !== 'active' || p.org_status !== 'active')) throw forbidden('This media partner is not active');
  return { ...p, role };
}
export const partnerAdmins = async (c, partnerId) => (await c.query(
  "SELECT om.user_id FROM media_partners m JOIN organisation_members om ON om.organisation_id=m.organisation_id AND om.status='active' AND om.role = ANY($2) WHERE m.id=$1 ORDER BY (om.role='owner') DESC, (om.role='admin') DESC, om.user_id", [partnerId, WRITE_ROLES])).rows.map((r) => r.user_id);
export const eventOrganisers = async (c, ev) => [...new Set([ev.organizer_id, ...(ev.organisation_id ? (await c.query("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role IN ('owner','admin')", [ev.organisation_id])).rows.map((r) => r.user_id) : [])])];

// ------------------------------------------------------------------ scope arithmetic (packages, licences and assets all use the same shapes)
const inter = (a, b) => a.some((x) => b.includes(x));
/** Do two territories share any country? `worldwide` shares with everything; two exclusions always overlap; an inclusion overlaps an exclusion unless it lies wholly inside it. */
export function territoriesOverlap(a, b) {
  if (a.mode === 'worldwide' || b.mode === 'worldwide') return true;
  if (a.mode === 'include' && b.mode === 'include') return inter(a.countries, b.countries);
  if (a.mode === 'exclude' && b.mode === 'exclude') return true;
  const inc = a.mode === 'include' ? a : b, exc = a.mode === 'include' ? b : a;
  return inc.countries.some((x) => !exc.countries.includes(x));
}
/** Is territory `inner` fully inside `outer`? (a licence may only narrow its package.) */
export function territoryWithin(inner, outer) {
  if (outer.mode === 'worldwide') return true;
  if (outer.mode === 'include') return inner.mode === 'include' && inner.countries.every((x) => outer.countries.includes(x));
  // outer excludes some countries: inner must not reach them
  return inner.mode === 'include' ? !inter(inner.countries, outer.countries) : inner.mode === 'exclude' && outer.countries.every((x) => inner.countries.includes(x));
}
export const terr = (r) => ({ mode: r.territory_mode, countries: r.countries ?? [] });
/** Empty platforms mean "every platform". */
export const platformsOverlap = (a, b) => !a.length || !b.length || inter(a, b);
export const platformsWithin = (inner, outer) => !outer.length || (inner.length > 0 && inner.every((x) => outer.includes(x)));
export const windowsOverlap = (a, b) => new Date(a.from) < new Date(b.to) && new Date(b.from) < new Date(a.to);
/** Do two packages cover any of the same games? An event-wide package covers everything of that event. */
export function scopesOverlap(a, b) {
  if (a.event_id !== b.event_id) return false;
  if (a.scope_kind === 'event' || b.scope_kind === 'event') return true;
  if (a.scope_kind === 'fixture' && b.scope_kind === 'fixture') return a.fixture_id === b.fixture_id;
  return true;   // a collection may hold any game's material, so it is treated as overlapping
}

/** Existing approved/active licences that clash with `lic` on an exclusive package. Empty list = no conflict. */
export async function exclusivityConflicts(c, lic, pkg) {
  const rows = (await c.query(
    `SELECT l.id, l.licence_no, l.approved_rights, l.approved_platforms, l.territory_mode, l.countries, l.effective_from, l.effective_to, p.exclusivity, p.event_id, p.scope_kind, p.fixture_id, o.name AS partner_name
       FROM mr_licences l JOIN mr_packages p ON p.id=l.package_id JOIN media_partners m ON m.id=l.partner_id JOIN organisations o ON o.id=m.organisation_id
      WHERE p.event_id=$1 AND l.id <> $2 AND l.stage = 'active' AND l.effective_to > now()`, [pkg.event_id, lic.id])).rows;
  return rows.filter((o) => (pkg.exclusivity === 'exclusive' || o.exclusivity === 'exclusive')
    && scopesOverlap(pkg, o) && inter(lic.approved_rights, o.approved_rights) && platformsOverlap(lic.approved_platforms, o.approved_platforms)
    && territoriesOverlap(terr(lic), terr(o)) && windowsOverlap({ from: lic.effective_from, to: lic.effective_to }, { from: o.effective_from, to: o.effective_to }))
    .map((o) => ({ licence_id: o.id, licence_no: o.licence_no, partner: o.partner_name }));
}

// ------------------------------------------------------------------ entitlements and asset visibility
/** The licences in force for the user's partner organisations, narrowed to one event when given. */
export async function entitlementsFor(user, { eventId = null, c = pool } = {}) {
  if (!user) return [];
  return (await c.query(
    `SELECT l.id AS licence_id, l.partner_id, l.approved_rights, l.approved_platforms, l.territory_mode, l.countries, l.effective_from, l.effective_to,
            p.id AS package_id, p.event_id, p.scope_kind, p.fixture_id, p.collection_id, p.embargo_minutes, p.sublicensing, p.name AS package_name
       FROM mr_licences l JOIN mr_packages p ON p.id=l.package_id JOIN media_partners m ON m.id=l.partner_id
       JOIN organisation_members om ON om.organisation_id=m.organisation_id AND om.user_id=$1 AND om.status='active'
      WHERE ${IN_FORCE()} AND ($2::uuid IS NULL OR p.event_id=$2)`, [user.id, eventId])).rows;
}

const ASSET_COLS = `a.*, (SELECT f.finished_at FROM fixtures f WHERE f.id=a.fixture_id) AS fixture_finished_at,
  EXISTS (WITH RECURSIVE up AS (SELECT p.id, p.parent_asset_id, p.status FROM mr_assets p WHERE p.id=a.parent_asset_id
            UNION ALL SELECT p.id, p.parent_asset_id, p.status FROM mr_assets p JOIN up ON p.id=up.parent_asset_id)
          SELECT 1 FROM up WHERE status IN ('withdrawn','taken_down')) AS source_blocked,
  (SELECT count(*)::int FROM mr_asset_subjects s WHERE s.asset_id=a.id AND s.removed_at IS NULL) AS subject_count`;
export { ASSET_COLS };

/** What stands between an asset and its audience today: nothing (`live`), or the first thing that blocks it. Youth consent is re-read here, on every view. */
export async function assetState(a, c = pool) {
  if (a.status === 'taken_down') return 'taken_down';
  if (a.status === 'withdrawn') return 'withdrawn';
  if (a.status === 'draft') return 'draft';
  if (a.source_blocked) return 'source_withdrawn';
  const now = Date.now();
  if (a.expires_at && new Date(a.expires_at) <= now) return 'expired';
  if (a.embargo_until && new Date(a.embargo_until) > now) return 'embargoed';
  if (a.publish_at && new Date(a.publish_at) > now) return 'scheduled';
  const subs = (await c.query('SELECT user_id FROM mr_asset_subjects WHERE asset_id=$1 AND removed_at IS NULL AND user_id IS NOT NULL', [a.id])).rows;
  for (const s of subs) if (!(await hasConsent(s.user_id, 'media', c))) return 'consent_lapsed';
  return 'live';
}

/** May a licensee with these entitlements receive this (otherwise live) asset? Scope, right, platform, territory and the package's delay all have to line up. */
export function licenceCovers(a, e, inCollection) {
  if (e.event_id !== a.event_id) return false;
  if (e.scope_kind === 'fixture' && e.fixture_id !== a.fixture_id) return false;
  if (e.scope_kind === 'collection' && !(inCollection ?? []).includes(e.collection_id)) return false;
  if (!e.approved_rights.includes(a.right_kind)) return false;
  if (!platformsOverlap(a.platforms ?? [], e.approved_platforms)) return false;
  if (!territoriesOverlap(terr(a), terr(e))) return false;
  if (!LIVE_RIGHTS.includes(a.right_kind) && e.embargo_minutes > 0 && a.fixture_id) {
    if (!a.fixture_finished_at || new Date(a.fixture_finished_at).getTime() + e.embargo_minutes * 60000 > Date.now()) return false;
  }
  return true;
}
