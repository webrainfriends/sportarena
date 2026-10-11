// What a session costs from a rate card, and who it is for. One place so a direct booking, an accepted answer
// and the analytics all agree.
import { one } from './db.js';
import { badRequest, forbidden, notFound } from './errors.js';
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
