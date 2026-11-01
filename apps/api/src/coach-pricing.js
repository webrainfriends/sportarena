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

// ---- series (block) pricing: the one function the preview, the booking and a re-quote after a date drops out all use ----
/** Split `total` across `weights` so the parts are whole minor units that add up to exactly `total` (largest remainder). */
export function allocate(total, weights) {
  const sum = weights.reduce((n, w) => n + w, 0);
  if (!weights.length) return [];
  if (sum <= 0) { const even = Math.floor(total / weights.length); const out = weights.map(() => even); out[0] += total - even * weights.length; return out; }
  const raw = weights.map((w) => (total * w) / sum), out = raw.map(Math.floor);
  let left = total - out.reduce((n, x) => n + x, 0);
  raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).forEach(([, i]) => { if (left-- > 0) out[i]++; });
  return out;
}

/**
 * Price a block of dates. `lists` = the undiscounted price of each bookable date. The coach's block discount (on the rate card,
 * `block_discount_pct` once `block_min_sessions` dates are booked) comes off the whole block and is shared out across the dates
 * so each date's share is a whole number and the shares add up to the total. Intro / trial offers are never discounted.
 */
export function seriesQuote(card, lists) {
  const list_total = lists.reduce((n, x) => n + x, 0);
  const pct = card && !card.is_intro && lists.length >= Number(card.block_min_sessions ?? 0) ? Number(card.block_discount_pct ?? 0) : 0;
  const discount = Math.min(list_total, Math.round((list_total * pct) / 100));
  const shares = allocate(discount, lists), per_date = lists.map((l, i) => l - shares[i]);
  return { list_total_cents: list_total, discount_pct: discount ? pct : 0, discount_cents: discount, total_cents: list_total - discount, per_date_cents: per_date };
}

/** Which ways a block may be paid for: always once; per date unless the coach switched it off on the card. */
export const payModesFor = (card) => (card && card.allow_pay_per_date === false ? ['once'] : ['once', 'per_date']);
