// What a session costs from a rate card, and who it is for. One place so a direct booking, an accepted answer
// and the analytics all agree.
import { one, many } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { isAdmin } from './helpers.js';
import { canManageTeam } from './capabilities/teams.js';

export const AUDIENCES = ['individual', 'group', 'team', 'event'];

/** Total in minor units. Hourly cards scale with the minutes; every other unit is a flat price; per-person cards scale with headcount. */
export function priceFor(card, mins, participants = 1) {
  const base = Number(card.price_cents);
  const one1 = card.unit === 'hour' ? Math.round((base * mins) / 60) : base;
  return card.per_person ? one1 * participants : one1;
}

/** The card must be the coach's own, live, and fit the audience and headcount. */
export async function cardFor(coachId, cardId, { audience, participants } = {}) {
  const card = await one('SELECT * FROM coach_rate_cards WHERE id=$1 AND coach_id=$2 AND archived_at IS NULL AND active', [cardId, coachId]);
  if (!card) throw notFound('Rate card');
  if (audience && card.audience !== audience) throw badRequest(`That rate card is for ${card.audience} bookings`);
  if (participants != null && (participants < card.min_participants || (card.max_participants && participants > card.max_participants))) {
    throw badRequest(`This rate card covers ${card.min_participants}${card.max_participants ? `–${card.max_participants}` : '+'} participants`);
  }
  return card;
}

/** Team or event the work is for, checked against who is asking. */
export async function clientFor(user, { audience, team_id, event_id }) {
  if (audience === 'team') {
    if (!team_id) throw badRequest('Choose the team this is for');
    const t = await one('SELECT * FROM teams WHERE id=$1', [team_id]);
    if (!t) throw notFound('Team');
    if (!(await canManageTeam(user, t))) throw forbidden('Only a team manager can book coaching for the team');
    return { team_id, event_id: null, name: t.name };
  }
  if (audience === 'event') {
    if (!event_id) throw badRequest('Choose the event this is for');
    const e = await one('SELECT id, name, organizer_id FROM events WHERE id=$1', [event_id]);
    if (!e) throw notFound('Event');
    if (e.organizer_id !== user.id && !isAdmin(user)) throw forbidden('Only the event organiser can book coaching for the event');
    return { team_id: null, event_id, name: e.name };
  }
  return { team_id: null, event_id: null, name: null };
}

// ---- intro / trial offers: one live intro per athlete per coach (or per sport, set on the card) -------------------
export const INTRO_USED = "You've used this coach's intro session";
const live = (a = '') => `${a}status IN ('requested','confirmed','completed') AND ${a}payment_status <> 'refunded' AND ${a}intro_counted`;

/** 'coach' | 'sport' when booking this card is an intro offer that counts, otherwise null. Only one-person cards are limited. */
export const introScopeOf = (card, audience = card?.audience) => (card?.is_intro && audience === 'individual' ? card.intro_scope ?? 'coach' : null);

const introUsed = (hire) => conflict(INTRO_USED, { code: 'intro_used', hire_id: hire?.id ?? null });

/** The athlete's live intro hire with this coach (for the sport when the card is per-sport), or null. Cancelled, expired and refunded hires do not count. */
export const usedIntro = (client, { coachId, athleteId, sportId, scope }) =>
  (client ?? { query: (q, a) => one(q, a).then((r) => ({ rows: r ? [r] : [] })) }).query(
    `SELECT id FROM coach_hires WHERE coach_id=$1 AND athlete_id=$2 AND intro_scope=$3 AND ${live()} AND ($3='coach' OR sport_id=$4) LIMIT 1`,
    [coachId, athleteId, scope, sportId]).then((r) => r.rows[0] ?? null);

/** Throws a 409 `intro_used` when the allowance is spent. The unique index is the atomic backstop (see mapIntroViolation). */
export async function assertIntroFree(client, args) {
  const used = await usedIntro(client, args);
  if (used) throw introUsed(used);
}

/** A concurrent second intro hits the partial unique index; report it exactly like the pre-check. */
export const mapIntroViolation = (e) => (e?.code === '23505' && /coach_hires_intro_/.test(e.constraint ?? '') ? introUsed(null) : e);

/** Per-card state for one athlete with one coach, so the app can show "used" before the booking is attempted. */
export async function introStatus(coachId, athleteId) {
  return many(
    `SELECT k.id AS rate_card_id, k.sport_id, k.intro_scope,
            h.id IS NULL AS available, h.id AS used_by_hire_id
       FROM coach_rate_cards k
       LEFT JOIN coach_hires h ON h.coach_id=k.coach_id AND h.athlete_id=$2 AND h.intro_scope=k.intro_scope
                              AND ${live('h.')}
                              AND (k.intro_scope='coach' OR h.sport_id=k.sport_id)
      WHERE k.coach_id=$1 AND k.is_intro AND k.audience='individual' AND k.archived_at IS NULL AND k.active`, [coachId, athleteId]);
}
