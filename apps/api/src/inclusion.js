// Inclusive & adaptive academy programmes (#808): the rules shared by every inclusion capability.
// Principles: no diagnosis is ever asked for, stored or shown. A programme states what it offers; an athlete (or a verified guardian for a young person)
// shares only the operational needs they choose, with a named audience and an expiry, and can withdraw them at any moment. Staff see only the flags
// shared with them; directors see counts. Clinical detail stays in the Health workflow. Para classification (#488) is linked, never duplicated.
import { AppError, badRequest, conflict, forbidden, notFound } from './errors.js';
import { isYouth, guardianLink } from './youth.js';
import { encrypt, decrypt } from './crypto.js';
import { screen, MIN_GROUP, suppress, actingFor, enrolled } from './wellbeing.js';

export { AppError, badRequest, conflict, forbidden, notFound, suppress, MIN_GROUP, actingFor, enrolled };

/** What an athlete can ask for, by type. Reference vocabulary (not data): every key is a code the UI translates and the server validates. */
export const NEED_TYPES = {
  access: ['step_free_route', 'lift_access', 'accessible_changing', 'accessible_toilet', 'accessible_parking', 'quiet_entry', 'tactile_guidance'],
  equipment: ['sport_wheelchair', 'prosthetic_support', 'adaptive_kit', 'guide_equipment', 'adapted_ball_or_implement', 'pool_hoist'],
  support_person: ['support_person', 'sighted_guide', 'tapper', 'personal_assistant'],
  transport: ['accessible_transport', 'door_to_door_pickup'],
  communication: ['captioned_video', 'sign_interpreter', 'plain_language_briefing', 'written_instructions', 'screen_reader_materials'],
  schedule: ['extra_transition_time', 'rest_breaks', 'flexible_start', 'quiet_room'],
};
export const NEED_KEYS = Object.values(NEED_TYPES).flat();
export const typeOfNeed = (k) => Object.keys(NEED_TYPES).find((t) => NEED_TYPES[t].includes(k));
/** Venue features a session can require; a need maps onto the features that satisfy it. */
export const VENUE_FEATURES = ['step_free_route', 'lift', 'accessible_changing', 'accessible_toilet', 'accessible_parking', 'pool_hoist', 'tactile_markings', 'hearing_loop', 'quiet_room'];
export const NEED_TO_FEATURE = { step_free_route: 'step_free_route', lift_access: 'lift', accessible_changing: 'accessible_changing', accessible_toilet: 'accessible_toilet', accessible_parking: 'accessible_parking', pool_hoist: 'pool_hoist', tactile_guidance: 'tactile_markings', quiet_room: 'quiet_room' };
export const NEEDS_SUPPORT = ['support_person', 'sighted_guide', 'tapper', 'personal_assistant'];
export const ELIGIBILITY = ['open', 'class_optional', 'class_required', 'mixed_ability'];
export const VARIANTS = ['standard', 'adapted', 'age_flexible'];
export const LEVELS = ['emerging', 'developing', 'secure', 'exceeding'];
export const AUDIENCE_ROLES = ['coach', 'venue'];
export const SHARE_MONTHS_MAX = 18;

/**
 * Sport adaptation templates: the starting adjustments, venue features and class schemes for a sport family. A programme may use several. Sports without a
 * native template are served by `generic`, which says so (`fallback: true`) wherever it appears instead of silently defaulting.
 */
export const SPORT_TEMPLATES = {
  wheelchair_basketball: { sports: ['wheelchair-basketball'], needs: ['sport_wheelchair', 'lift_access', 'step_free_route', 'accessible_changing', 'support_person'], features: ['lift', 'step_free_route', 'accessible_changing'], schemes: ['wheelchair_basketball_1_4_5'] },
  wheelchair_tennis: { sports: ['wheelchair-tennis'], needs: ['sport_wheelchair', 'step_free_route', 'accessible_changing', 'accessible_parking'], features: ['step_free_route', 'accessible_changing'], schemes: ['open_quad'] },
  para_swimming: { sports: ['swimming', 'para-swimming'], needs: ['pool_hoist', 'tapper', 'support_person', 'accessible_changing', 'captioned_video'], features: ['pool_hoist', 'accessible_changing', 'lift'], schemes: ['s1_s14', 'sb', 'sm'] },
  para_athletics: { sports: ['athletics', 'para-athletics'], needs: ['sport_wheelchair', 'prosthetic_support', 'guide_equipment', 'sighted_guide', 'step_free_route'], features: ['step_free_route', 'accessible_changing', 'tactile_markings'], schemes: ['t11_t13', 't20', 't33_t38', 't40_t47', 't51_t54'] },
  para_football: { sports: ['football', 'para-football'], needs: ['prosthetic_support', 'adaptive_kit', 'sighted_guide', 'plain_language_briefing', 'step_free_route'], features: ['step_free_route', 'accessible_changing'], schemes: ['cp_football', 'b1_blind', 'amputee_football'] },
  goalball_boccia: { sports: ['goalball', 'boccia'], needs: ['tactile_guidance', 'support_person', 'adapted_ball_or_implement', 'step_free_route'], features: ['tactile_markings', 'step_free_route', 'hearing_loop'], schemes: ['b1_b3', 'bc1_bc4'] },
  para_cycling: { sports: ['cycling', 'para-cycling'], needs: ['adaptive_kit', 'sighted_guide', 'accessible_transport', 'accessible_parking'], features: ['accessible_parking', 'step_free_route'], schemes: ['c1_c5', 'h1_h5', 't1_t2', 'b'] },
  sitting_volleyball: { sports: ['sitting-volleyball', 'volleyball'], needs: ['adaptive_kit', 'step_free_route', 'accessible_changing', 'support_person'], features: ['step_free_route', 'accessible_changing'], schemes: ['mvd_vd'] },
  para_racket: { sports: ['badminton', 'table-tennis', 'para-badminton', 'para-table-tennis'], needs: ['sport_wheelchair', 'adapted_ball_or_implement', 'step_free_route', 'accessible_toilet'], features: ['step_free_route', 'accessible_toilet'], schemes: ['wh1_wh2', 'sl_su', 'ttc'] },
  generic: { sports: [], needs: ['step_free_route', 'support_person', 'accessible_transport', 'written_instructions', 'rest_breaks'], features: ['step_free_route'], schemes: [], fallback: true },
};
export const SCHEMES = [...new Set(Object.values(SPORT_TEMPLATES).flatMap((t) => t.schemes))];

export const catalogue = () => ({
  need_types: NEED_TYPES, venue_features: VENUE_FEATURES, eligibility_modes: ELIGIBILITY, pathway_variants: VARIANTS, descriptor_levels: LEVELS, audience_roles: AUDIENCE_ROLES,
  class_schemes: SCHEMES, share_months_max: SHARE_MONTHS_MAX,
  sport_templates: Object.entries(SPORT_TEMPLATES).map(([key, t]) => ({ key, sports: t.sports, needs: t.needs, venue_features: t.features, class_schemes: t.schemes, fallback: !!t.fallback })),
});

export const checkNeeds = (keys) => { for (const k of keys) if (!NEED_KEYS.includes(k)) throw badRequest(`Unknown adjustment: ${k}`); return [...new Set(keys)]; };

// ------------------------------------------------------------------------------------------------------------------ note
export const sealNote = (text, field) => (text ? encrypt(screen(text), `academy_accommodation_shares.${field}`) : null);
export const unsealNote = (enc, field) => (enc ? decrypt(enc, `academy_accommodation_shares.${field}`) : null);

// ------------------------------------------------------------------------------------------------------------------ log
export const log = (c, orgId, athleteId, kind, actorId, ref = {}, detail = null) =>
  c.query('INSERT INTO academy_inclusion_events(organisation_id, athlete_id, kind, actor_id, ref_type, ref_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)', [orgId, athleteId, kind, actorId ?? null, ref.type ?? null, ref.id ?? null, detail]);

// ------------------------------------------------------------------------------------------------------------------ liveness
/** A share is live when it is not revoked or expired AND the authority behind it still stands: a guardian's grant lapses with the guardian link or the athlete's youth. */
export async function shareIsLive(c, s) {
  if (s.revoked_at || new Date(s.expires_at) <= new Date()) return false;
  if (s.granted_as === 'guardian') {
    if (!(await isYouth(s.athlete_id, c))) return false;
    return !!(await guardianLink(s.granted_by, s.athlete_id, c));
  }
  return !(await isYouth(s.athlete_id, c));
}
export const liveShares = async (c, orgId, athleteId) => {
  const rows = (await c.query('SELECT * FROM academy_accommodation_shares WHERE organisation_id=$1 AND athlete_id=$2 AND revoked_at IS NULL AND expires_at > now() ORDER BY expires_at, id', [orgId, athleteId])).rows;
  const out = [];
  for (const r of rows) if (await shareIsLive(c, r)) out.push(r);
  return out;
};

/** May this person see this share: named in it, or holding a role it names that applies to the given session (coach on the session, manager of its venue). */
export async function inAudience(c, s, userId, session) {
  if (s.audience_users.includes(userId)) return true;
  if (!session) return false;
  if (s.audience_roles.includes('coach')) {
    const r = await c.query("SELECT 1 FROM academy_session_staff WHERE session_id=$1 AND user_id=$2 AND status IN ('assigned','confirmed') UNION SELECT 1 FROM org_cohorts WHERE id=$3 AND coach_id=$2", [session.id, userId, session.cohort_id]);
    if (r.rowCount) return true;
  }
  if (s.audience_roles.includes('venue')) {
    const r = await c.query("SELECT 1 FROM session_venue_links l JOIN bookings b ON b.id=l.booking_id JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id WHERE l.session_type='academy_session' AND l.session_id=$1 AND l.released_at IS NULL AND v.owner_id=$2", [session.id, userId]);
    if (r.rowCount) return true;
  }
  return false;
}

export { guardianLink, isYouth };
