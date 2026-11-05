// Academy wellbeing & personal development (#795): the rules shared by every capability. Nothing here stores a student, a clinical fact or a safeguarding
// narrative: students, guardians, staff, safety events and care-network providers stay in their canonical tables and are only read. This module decides
// who may see or change the wellbeing record, keeps counselling-type content out of Academy notes, and suppresses small groups in the aggregates.
import { AppError, badRequest, conflict, forbidden, notFound } from './errors.js';
import { isYouth, guardianLink, guardiansOf, guardianCan } from './youth.js';
import { notify } from './notify.js';
import { encrypt, decrypt } from './crypto.js';

export const SCOPES = ['tracks', 'mentoring', 'checkins', 'goals', 'guardian_updates', 'referrals'];
export const CATEGORIES = ['values', 'leadership', 'life_skills', 'nutrition_education', 'study_skills'];
export const TOPICS = ['training_load_and_rest', 'school_and_study', 'sleep_and_routine', 'nutrition_and_hydration', 'team_and_friendships', 'travel_and_being_away_from_home', 'confidence_and_goals', 'leadership_and_values', 'other'];
export const SETTINGS = ['academy_room', 'training_venue', 'video_with_guardian_aware', 'phone_with_guardian_aware'];
export const SPECIALTIES = ['sports_psychology', 'counselling', 'nutrition', 'sports_medicine', 'physiotherapy', 'learning_support', 'other_specialist'];
export const REASONS = ['performance_pressure', 'load_and_recovery', 'nutrition_support', 'school_balance', 'general_wellbeing', 'transition_support', 'other'];
export const UPDATE_TEMPLATES = ['track_progress', 'goal_outcome', 'checkin_rhythm', 'thank_you', 'review_invitation'];
/** Smallest group an aggregate may describe. Anything smaller is returned as null so a figure can never point at one child. */
export const MIN_GROUP = 5;
export const CONSENT_MONTHS = 12;

export const suppress = (n) => (n >= MIN_GROUP ? n : null);

// ------------------------------------------------------------------------------------------------------------------ restricted content
const RESTRICTED = /\b(diagnos\w*|prescri\w*|medicat\w*|psychiatr\w*|self[- ]?harm\w*|suicid\w*|abus(?:e|ed|ive)|assault\w*|disclos\w*|trauma\w*|depress\w*|\w*disorder\w*|anxi(?:ety|ous)|adhd|autis\w*|bulimi\w*|anorex\w*|panic attack\w*|therapy|therapist|counsell?ing (?:session|note)\w*)\b/i;
/** Counselling, diagnosis, psychiatric and confidential safeguarding content has no home in an Academy note. Refuse it and say where it goes. */
export function screen(text) {
  if (text && RESTRICTED.test(text)) throw new AppError(422, 'restricted_content', 'This looks like counselling, clinical or safeguarding content, which does not belong in an Academy note. Raise a concern for safeguarding staff, or suggest a specialist, instead.', { where: ['concern', 'referral'] });
  return text ?? null;
}
export const seal = (text, field) => (text ? encrypt(screen(text), `academy_wellbeing_checkins.${field}`) : null);
export const unseal = (enc, field) => (enc ? decrypt(enc, `academy_wellbeing_checkins.${field}`) : null);

// ------------------------------------------------------------------------------------------------------------------ people
export const enrolled = async (c, orgId, athleteId) => !!(await c.query(
  "SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.user_id=$2 AND e.status IN ('enrolled','paused') LIMIT 1", [orgId, athleteId])).rowCount;
export const mustBeEnrolled = async (c, orgId, athleteId) => { if (!(await enrolled(c, orgId, athleteId))) throw notFound('Athlete'); };
export const nameOf = async (c, id) => (await c.query('SELECT display_name FROM users WHERE id=$1', [id])).rows[0]?.display_name ?? null;

/** Coarse age from the stored birth year (no date of birth is decrypted). The real age is this or one less. */
export async function ageBand(c, athleteId) {
  const y = (await c.query('SELECT birth_year FROM users WHERE id=$1', [athleteId])).rows[0]?.birth_year;
  if (!y) return null;
  const a = new Date().getUTCFullYear() - y;
  return [a - 1, a];
}
export function fitsAge(band, track) {
  if (!band) return track.age_max >= 18;
  return band[1] >= track.age_min && band[0] <= track.age_max;
}

// ------------------------------------------------------------------------------------------------------------------ consent
/** The live consent for this academy, or null. A guardian's grant lapses the moment that guardian is no longer verified or the athlete is no longer a young person. */
export async function liveConsent(c, orgId, athleteId) {
  const r = (await c.query('SELECT * FROM academy_wellbeing_consents WHERE organisation_id=$1 AND athlete_id=$2 AND revoked_at IS NULL AND expires_at > now()', [orgId, athleteId])).rows[0];
  if (!r) return null;
  if (r.granted_as === 'guardian') {
    if (!(await isYouth(athleteId, c))) return null;
    const l = await c.query("SELECT 1 FROM guardian_links l WHERE l.guardian_id=$1 AND l.child_id=$2 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())", [r.granted_by, athleteId]);
    if (!l.rowCount) return null;
  } else if (await isYouth(athleteId, c)) return null;       // a young person's own grant is never enough
  return r;
}
export const hasScope = async (c, orgId, athleteId, scope) => !!(await liveConsent(c, orgId, athleteId))?.scopes.includes(scope);
export async function requireScope(c, orgId, athleteId, scope) {
  if (!(await hasScope(c, orgId, athleteId, scope))) throw conflict(`The athlete (or their guardian) has not given current consent for this (${scope}). Ask them under Wellbeing.`, { code: 'wellbeing_consent_required', scope });
}

/** Who is acting for the athlete on their own wellbeing record: the adult themself, or a verified guardian holding the 'consent' scope. */
export async function actingFor(c, user, athleteId, scope = 'consent') {
  const young = await isYouth(athleteId, c);
  if (athleteId === user.id && !young) return 'self';
  const link = await guardianLink(user.id, athleteId, c);
  if (link) { if (!(await guardianCan(link, scope, null, c))) throw new AppError(403, 'guardian_scope_required', `Your guardian authority for this young person does not cover this (${scope})`, { scope }); return 'guardian'; }
  if (athleteId === user.id) throw forbidden('A young person\'s guardian does this for them');
  throw notFound('Person');
}
/** May this person read the athlete's own wellbeing record: the athlete, or any verified guardian. */
export async function familyOf(c, user, athleteId) {
  if (athleteId === user.id) return 'self';
  if (await guardianLink(user.id, athleteId, c)) return 'guardian';
  return null;
}

// ------------------------------------------------------------------------------------------------------------------ log + tell
export const log = (c, orgId, athleteId, kind, actorId, ref, detail = null) => {
  ref = ref ?? {};
  return c.query('INSERT INTO academy_wellbeing_events(organisation_id, athlete_id, kind, actor_id, ref_type, ref_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)', [orgId, athleteId, kind, actorId ?? null, ref.type ?? null, ref.id ?? null, detail]);
};

/** Tell the people responsible for the athlete (the guardians of a young person, otherwise the athlete). Generic text only: details are read in the app, by the right person. */
export async function tellFamily(c, athleteId, { kind, title, body, key, data = {} }) {
  const to = (await isYouth(athleteId, c)) ? await guardiansOf(athleteId, c) : [athleteId];
  for (const u of to) await notify(c, u, { kind, title, body, data: { ...data, child_id: athleteId }, dedupe_key: `${key}:${u}` });
  return to.length;
}

export { AppError, badRequest, conflict, forbidden, notFound };

// ------------------------------------------------------------------------------------------------------------------ SQL: the same consent rule, for lists
const LIVE = (org, ath) => `wc.organisation_id=${org} AND wc.athlete_id=${ath} AND wc.revoked_at IS NULL AND wc.expires_at > now()
       AND ((wc.granted_as='self' AND (cu.youth_until IS NULL OR cu.youth_until <= current_date))
         OR (wc.granted_as='guardian' AND cu.youth_until > current_date AND EXISTS (SELECT 1 FROM guardian_links l WHERE l.guardian_id=wc.granted_by AND l.child_id=wc.athlete_id AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()))))`;
/** EXISTS(...) true when the athlete (SQL expression) has a live consent in the organisation (SQL expression) covering `scope`. Mirrors liveConsent(). */
export const consentSql = (org, ath, scope) => {
  if (!SCOPES.includes(scope)) throw new Error(`unknown wellbeing scope ${scope}`);
  return `EXISTS (SELECT 1 FROM academy_wellbeing_consents wc JOIN users cu ON cu.id=wc.athlete_id WHERE '${scope}' = ANY(wc.scopes) AND ${LIVE(org, ath)})`;
};
/** A scalar subquery: the scopes of the live consent (null when there is none). */
export const scopesSql = (org, ath) => `(SELECT wc.scopes FROM academy_wellbeing_consents wc JOIN users cu ON cu.id=wc.athlete_id WHERE ${LIVE(org, ath)})`;

// ------------------------------------------------------------------------------------------------------------------ staff
/** Is this person an eligible mentor for this athlete? A member holding the wellbeing permission (owner/admin included), cleared by the academy's youth-access obligations. */
export async function mentorEligible(c, orgId, mentorId, athleteId) {
  if (mentorId === athleteId) return false;
  const m = (await c.query("SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [orgId, mentorId])).rows[0];
  if (!m) return false;
  if (!['owner', 'admin'].includes(m.role)) {
    const e = (await c.query("SELECT 1 FROM org_staff_engagements WHERE organisation_id=$1 AND user_id=$2 AND state='active' AND 'wellbeing' = ANY(permissions) AND (ends_on IS NULL OR ends_on >= current_date)", [orgId, mentorId])).rowCount;
    if (!e) return false;
  }
  if (await isYouth(athleteId, c)) { const { mayAccessYouth } = await import('./compliance.js'); if (!(await mayAccessYouth(c, mentorId, athleteId))) return false; }
  return true;
}
export const mentorOf = async (c, orgId, athleteId, { includePaused = true } = {}) =>
  (await c.query(`SELECT * FROM academy_mentor_assignments WHERE organisation_id=$1 AND athlete_id=$2 AND status ${includePaused ? "<> 'ended'" : "= 'active'"}`, [orgId, athleteId])).rows[0] ?? null;
