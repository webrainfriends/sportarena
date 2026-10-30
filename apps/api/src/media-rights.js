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
export const PLATFORM_NAMES = { linear_tv: 'TV', ott: 'streaming (OTT)', web: 'web', mobile_app: 'mobile app', social: 'social', radio: 'radio', in_venue: 'in venue', print: 'print' };
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

// ------------------------------------------------------------------ the rights check (#590): one place that decides whether an asset may be published, exported or handed on
export const RIGHTS_PURPOSES = ['publish', 'export', 'distribute'];
/** Is this country inside the territory? `worldwide` and an unnamed country (nothing to test) pass. */
export const countryIn = (t, cc) => !cc || t.mode === 'worldwide' || (t.mode === 'include' ? t.countries.includes(cc) : !t.countries.includes(cc));

/** The first reason a licence does not cover an asset for this use, in plain words; null when it does. Mirrors `licenceCovers`, which stays the yes/no used for visibility. */
export function whyNotCovered(a, e, inCollection, { platform = null, country = null } = {}) {
  if (e.event_id !== a.event_id) return 'The licence is for a different event';
  if (e.scope_kind === 'fixture' && e.fixture_id !== a.fixture_id) return 'The licence only covers another game';
  if (e.scope_kind === 'collection' && !(inCollection ?? []).includes(e.collection_id)) return 'The asset is not in the licensed collection';
  if (!e.approved_rights.includes(a.right_kind)) return `The licence does not include the ${RIGHTS[a.right_kind] ?? a.right_kind} right`;
  if (!platformsOverlap(a.platforms ?? [], e.approved_platforms)) return 'The asset and the licence share no platform';
  if (platform && !((a.platforms ?? []).length === 0 || a.platforms.includes(platform))) return `The asset is not released for ${(PLATFORM_NAMES[platform] ?? platform)}`;
  if (platform && !(e.approved_platforms.length === 0 || e.approved_platforms.includes(platform))) return `The licence does not include ${(PLATFORM_NAMES[platform] ?? platform)}`;
  if (!territoriesOverlap(terr(a), terr(e))) return 'The asset and the licence share no territory';
  if (!countryIn(terr(a), country)) return `The asset is not released in ${country}`;
  if (!countryIn(terr(e), country)) return `The licence does not include ${country}`;
  if (!LIVE_RIGHTS.includes(a.right_kind) && e.embargo_minutes > 0 && a.fixture_id && (!a.fixture_finished_at || new Date(a.fixture_finished_at).getTime() + e.embargo_minutes * 60000 > Date.now())) return `The licence delay (${e.embargo_minutes} minutes after full time) has not passed`;
  return null;
}

/** The licence in force with this id, in the shape `entitlementsFor` returns (used when the organiser or owner checks a hand-over on a partner's behalf). */
export async function entitlementById(c, licenceId) {
  return (await c.query(
    `SELECT l.id AS licence_id, l.partner_id, l.approved_rights, l.approved_platforms, l.territory_mode, l.countries, l.effective_from, l.effective_to,
            p.id AS package_id, p.event_id, p.scope_kind, p.fixture_id, p.collection_id, p.embargo_minutes, p.sublicensing, p.name AS package_name
       FROM mr_licences l JOIN mr_packages p ON p.id=l.package_id JOIN media_partners m ON m.id=l.partner_id WHERE l.id=$1 AND ${IN_FORCE()}`, [licenceId])).rows[0] ?? null;
}

/** The chain an asset was cut from, oldest source last, with who owns each link: provenance travels with every check. */
export async function provenanceOf(c, a) {
  const chain = (await c.query(
    `WITH RECURSIVE up AS (SELECT p.id, p.parent_asset_id, p.title, p.owner_kind, p.owner_name, p.status, 1 AS depth FROM mr_assets p WHERE p.id=$1
       UNION ALL SELECT p.id, p.parent_asset_id, p.title, p.owner_kind, p.owner_name, p.status, up.depth+1 FROM mr_assets p JOIN up ON p.id=up.parent_asset_id WHERE up.depth < 20)
     SELECT id, title, owner_kind, owner_name, status FROM up ORDER BY depth`, [a.parent_asset_id ?? a.id])).rows;
  const owner = a.owner_partner_id ? (await c.query('SELECT o.name FROM media_partners m JOIN organisations o ON o.id=m.organisation_id WHERE m.id=$1', [a.owner_partner_id])).rows[0]?.name : null;
  return { owner_kind: a.owner_kind, owner_name: owner ?? a.owner_name ?? null, credit: a.credit, created_by: a.creator_id, source_kind: a.source_kind, sha256: a.sha256 ?? null, cut_from: a.parent_asset_id ? chain : [] };
}

/**
 * Judge one use of an asset. Every rule is listed with its outcome so the answer is explainable; `allowed` is true only when none failed.
 *  publish    → the draft may go out to its audience (file, source, consent, expiry)
 *  export     → someone takes a copy or link out of the platform (the asset is live, the audience allows it, the licence covers it)
 *  distribute → the organiser or owner hands it to a partner (same rules, judged against that partner's licence)
 */
export async function evaluateRights(c, a, { purpose, viewer, ent = null, platform = null, country = null }) {
  const rules = [];
  const add = (rule, ok, label, detail = null, extra = {}) => rules.push({ rule, ok, label, detail: ok ? null : detail, ...extra });
  const now = Date.now();
  if (purpose === 'publish') add('status', a.status === 'draft', 'Ready to publish', 'Only a draft can be published');
  else add('status', a.status === 'published', 'Published', a.status === 'draft' ? 'It has not been published yet' : `It is ${a.status.replace('_', ' ')}`);
  if (purpose === 'publish' && a.source_kind === 'upload') add('file', !!a.stored_file, 'File uploaded', 'Upload the file first', { code: 'file_required' });
  add('source', !a.source_blocked, 'Source still available', 'The asset this was cut from has been withdrawn or taken down');
  const subs = (await c.query('SELECT user_id FROM mr_asset_subjects WHERE asset_id=$1 AND removed_at IS NULL AND user_id IS NOT NULL', [a.id])).rows;
  const lapsed = [];
  for (const s of subs) if (!(await hasConsent(s.user_id, 'media', c))) lapsed.push(s.user_id);
  add('consent', !lapsed.length, subs.length ? 'Guardian media consent current for everyone shown' : 'Nobody identifiable needs consent', 'A verified guardian has not given current media consent for a young person in this asset', { code: 'guardian_consent_required', count: lapsed.length });
  add('expiry', !(a.expires_at && new Date(a.expires_at) <= now), 'Not past its expiry date', 'It is past its expiry date');
  if (purpose !== 'publish') {
    add('embargo', !(a.embargo_until && new Date(a.embargo_until) > now), 'Embargo lifted', `Under embargo until ${new Date(a.embargo_until).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
    add('schedule', !(a.publish_at && new Date(a.publish_at) > now), 'Publish time reached', 'It is scheduled for later');
    const outsider = !viewer.organiser && !viewer.owner;
    add('audience', a.audience !== 'private' || !outsider, 'Released beyond its owner', 'It is private to its owner and the organiser');
    if (platform) add('platform_asset', (a.platforms ?? []).length === 0 || a.platforms.includes(platform), `Released for ${(PLATFORM_NAMES[platform] ?? platform)}`, `Not released for ${(PLATFORM_NAMES[platform] ?? platform)}`);
    if (country) add('territory_asset', countryIn(terr(a), country), `Released in ${country}`, `Not released in ${country}`);
    if (ent || outsider) {
      const why = ent ? whyNotCovered(a, ent, viewer.inColl, { platform, country }) : 'No licence in force covers this asset';
      add('licence', !why, ent ? 'A licence in force covers this use' : 'Covered by a licence', why);
    }
  }
  return { purpose, allowed: rules.every((r) => r.ok), rules, provenance: await provenanceOf(c, a) };
}

/** Write the check down for good: who asked, for what, what each rule said. Append-only. */
export async function recordRightsCheck(c, a, { user, purpose, licenceId = null, platform = null, country = null, result }) {
  const row = (await c.query(
    `INSERT INTO mr_rights_checks(event_id, asset_id, licence_id, user_id, purpose, platform, country, outcome, rules, provenance) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, checked_at`,
    [a.event_id, a.id, licenceId, user?.id ?? null, purpose, platform, country, result.allowed ? 'allowed' : 'blocked', JSON.stringify(result.rules), JSON.stringify(result.provenance)])).rows[0];
  await logMr(c, a.event_id, 'asset', a.id, `rights_check_${result.allowed ? 'allowed' : 'blocked'}`, { actor: user?.id ?? null, detail: { purpose, check_id: row.id, licence_id: licenceId, failed: result.rules.filter((r) => !r.ok).map((r) => r.rule) } });
  return row;
}

// ------------------------------------------------------------------ crew badge (#590): the real accreditation of #481, read live
/** The person's open accreditation for the crew row's event (alias `c`). An approved, active credential reads 'issued', an approved but suspended one 'suspended', one in review 'pending'.
 *  Only when the person has none does the older department flag speak, so badges issued before accreditation existed keep their meaning. */
export const CREW_ACCRED_PICK = `SELECT a.* FROM accreditations a WHERE a.event_id=c.event_id AND a.holder_id=c.user_id AND a.status IN ('approved','submitted','under_review') ORDER BY (a.status='approved') DESC, a.submitted_at DESC LIMIT 1`;
export const CREW_ACCRED = `coalesce((SELECT CASE WHEN p.status='approved' AND p.access='active' THEN 'issued' WHEN p.status='approved' THEN 'suspended' ELSE 'pending' END FROM (${CREW_ACCRED_PICK}) p),
  (SELECT m.accreditation FROM event_department_members m WHERE m.id=c.department_member_id), 'none')`;
