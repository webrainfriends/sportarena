// Verified recruiter & scout workspace (issue #313): the live access check every read, mutation, message and export goes through.
// Nothing here is cached. A grant is "live" only while ALL of these hold at the moment of the call:
//   the recruiter's verification is approved and unexpired, the request is approved, unrevoked and inside its window, and
//   for a young person a guardian's current 'recruitment' consent is in force (and 'contact' consent for messaging).
import { one, many } from './db.js';
import { decrypt } from './crypto.js';
import { audit } from './helpers.js';
import { badgesFor } from './verification.js';
import { SCOPED_FIELDS, visibleFields } from './athlete-profile.js';
import { publicCareer } from './career.js';
import { guardianLink, guardiansOf, hasConsent, isYouth } from './youth.js';
import { forbidden, notFound } from './errors.js';

export const GRANT_SCOPES = ['profile', 'measurements', 'career', 'contact', 'messages'];
export const SCOPE_LABELS = {
  profile: 'Playing profile (level, position, club, region, preferences)',
  measurements: 'Shared measurements',
  career: 'Career timeline',
  contact: 'Direct contact details',
  messages: 'Messages in the app',
};
export const PURPOSES = ['scouting', 'trial', 'scholarship', 'signing'];
export const STAGES = ['prospect', 'shortlist', 'contacted', 'trial', 'offer', 'passed'];
export const BASES = ['live_viewing', 'video', 'match_report', 'trial', 'profile_only'];
export const CRITERIA = ['technical', 'tactical', 'physical', 'mental', 'potential'];
export const MAX_WINDOW_DAYS = 180;

/** Is this person a recruiter whose verification is approved and unexpired right now? */
export const isVerifiedRecruiter = async (userId) => !!(await badgesFor('user', [userId])).get(userId)?.some((b) => b.type === 'recruiter');

export async function requireVerifiedRecruiter(user) {
  if (!(await isVerifiedRecruiter(user.id))) throw forbidden('Your recruiter verification is not current. Verify (or renew) first.');
}

/** Why a request is not usable, or null when it is live. `scopes` is what the recruiter may touch right now. */
export async function grantState(r) {
  if (r.status !== 'approved') return { live: false, reason: r.status, scopes: [] };
  if (new Date(r.expires_at) <= new Date()) return { live: false, reason: 'expired', scopes: [] };
  if (!(await isVerifiedRecruiter(r.recruiter_id))) return { live: false, reason: 'recruiter_unverified', scopes: [] };
  let scopes = [...r.granted_scopes];
  if (await isYouth(r.athlete_id)) {
    if (!(await hasConsent(r.athlete_id, 'recruitment'))) return { live: false, reason: 'guardian_consent_withdrawn', scopes: [] };
    scopes = scopes.filter((s) => s !== 'contact'); // a young person's direct details are never handed to a recruiter
    if (!(await hasConsent(r.athlete_id, 'contact'))) scopes = scopes.filter((s) => s !== 'messages');
  }
  return { live: scopes.length > 0, reason: scopes.length ? null : 'no_scope', scopes };
}

/** Mark requests whose window has passed as expired so they stop blocking a fresh request (the row and its history stay). */
export const sweepExpired = (c, where = 'TRUE', params = []) => c.query(
  `UPDATE recruiter_access_requests SET status='expired', row_version=row_version+1, updated_at=now() WHERE status IN ('requested','approved') AND expires_at <= now() AND ${where}`, params);

/** The recruiter's own request, 404 for anyone else (existence is not leaked). */
export async function ownRequest(user, requestId, client) {
  const q = client ? (t, p) => client.query(t, p).then((x) => x.rows[0]) : one;
  const r = await q('SELECT * FROM recruiter_access_requests WHERE id=$1 AND recruiter_id=$2', [requestId, user.id]);
  if (!r) throw notFound('Access request');
  return r;
}

/** A live grant with the wanted scope for the calling recruiter, or a precise refusal. */
export async function requireLive(user, requestId, scope, client) {
  const r = await ownRequest(user, requestId, client);
  const g = await grantState(r);
  if (!g.live || (scope && !g.scopes.includes(scope))) {
    const reason = g.live ? 'scope_not_granted' : g.reason;
    const e = forbidden(g.live ? `This athlete has not allowed ${scope} for you` : 'Access to this athlete is not active');
    e.details = { code: 'access_not_live', reason };
    throw e;
  }
  return { request: r, scopes: g.scopes };
}

/** Who may act for the athlete on a request? Adults for themselves; a verified guardian for a young person. A young person cannot decide alone. */
export async function athleteSide(user, athleteId, client) {
  if (user.id === athleteId) {
    if (await isYouth(athleteId, client)) return null;
    return 'athlete';
  }
  if (await guardianLink(user.id, athleteId, client)) return 'guardian';
  return null;
}

export const requireAthleteSide = async (user, athleteId, client) => {
  const side = await athleteSide(user, athleteId, client);
  if (!side) throw notFound('Access request');
  return side;
};

/** Everyone who should hear about a request: the athlete, or the guardians of a young person. */
export async function athleteAudience(athleteId, client) {
  return (await isYouth(athleteId, client)) ? guardiansOf(athleteId, client) : [athleteId];
}

export const REQUEST_SQL = `
  SELECT r.id, r.recruiter_id, r.athlete_id, r.sport_id, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji, r.scopes, r.granted_scopes, r.purpose, r.message, r.status,
         r.expires_at, r.decided_by, r.decided_at, r.decision_note, r.revoked_by, r.revoked_at, r.row_version, r.created_at, r.updated_at
    FROM recruiter_access_requests r JOIN sports s ON s.id = r.sport_id`;

/** Request row plus its live state, shaped for the API. */
export async function presentRequest(r) {
  const g = await grantState(r);
  return { ...r, live: g.live, live_scopes: g.scopes, not_live_reason: g.live ? null : g.reason };
}

/** What a recruiter may see of an athlete under a live grant: only the approved scopes, read at call time. */
export async function dossier(r, scopes, viewer) {
  const a = await one('SELECT id, handle, display_name, avatar_emoji, avatar_color, avatar_url FROM users WHERE id=$1', [r.athlete_id]);
  const youth = await isYouth(r.athlete_id);
  const out = { athlete: { ...a, is_youth: youth }, sport: r.sport_slug ?? null, scopes, purpose: r.purpose, expires_at: r.expires_at };
  const profile = await one(
    `SELECT p.id, p.level, p.position, p.jersey_no, p.club, p.region, p.experience_years, p.dominant_side, p.positions, p.play_prefs, p.field_scopes
       FROM active_sport_profiles p WHERE p.user_id=$1 AND p.sport_id=$2 AND p.role='athlete' ORDER BY p.is_default DESC, p.id LIMIT 1`, [r.athlete_id, r.sport_id]);
  if (scopes.includes('profile') && profile) {
    const { id: _id, dominant_side, positions, play_prefs, field_scopes, ...plain } = profile;
    // an adult's own field scopes still apply (private stays private); for a young person the guardian's approval of this scope is the decision
    const card = { dominant_side, positions, play_prefs, field_scopes: youth ? Object.fromEntries(SCOPED_FIELDS.map((f) => [f, 'recruiter'])) : field_scopes };
    out.profile = { ...plain, ...visibleFields(card, ['public', 'recruiter']) };
  }
  if (scopes.includes('measurements') && profile) {
    const rows = await many(
      `SELECT metric, unit, value_enc, to_char(measured_on,'YYYY-MM-DD') AS measured_on, source FROM athlete_measurements
        WHERE sport_profile_id=$1 AND revoked_at IS NULL AND ($2::boolean OR scope IN ('recruiter','public')) ORDER BY measured_on DESC, created_at DESC, id`, [profile.id, youth]);
    out.measurements = rows.map(({ value_enc, ...m }) => ({ ...m, value: Number(decrypt(value_enc, 'athlete_measurements.value')) }));
  }
  if (scopes.includes('career')) {
    out.career = (await publicCareer(r.athlete_id)).filter((m) => m.sport_slug === r.sport_slug).map(({ team_id, organisation_id, org_season_id, ...m }) => m);
  }
  out.verified = (await badgesFor('user', [r.athlete_id])).get(r.athlete_id) ?? [];
  await audit(null, viewer.id, 'read_recruiter_dossier', 'users', r.athlete_id);
  return out;
}

/** The scopes a viewer holds as a recruiter toward one athlete in one sport right now (empty when none is live). Used by the person card so the `recruiter` field tier means something. */
export async function recruiterScopes(viewerId, athleteId, sportId) {
  const r = await one("SELECT * FROM recruiter_access_requests WHERE recruiter_id=$1 AND athlete_id=$2 AND sport_id=$3 AND status='approved'", [viewerId, athleteId, sportId]);
  return r ? (await grantState(r)).scopes : [];
}
