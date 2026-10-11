// Venue bookings and coaching sessions together. Either the coach or the athlete can book a court and attach the
// session(s) to it — one session, a recurring series, a bulk selection or a custom list of dates.
//   book_session_venue      pick sessions + a court -> one reservation with a line per session, each session linked to its line
//   attach_sessions_to_booking   link sessions to a reservation you already made (matched by time)
//   book_recurring_venue    a weekly/custom pattern of court bookings, optionally attaching the sessions that fall on them
// A line that cannot be booked is reported, and either skipped or the whole thing refused (`on_conflict`). Nothing is deleted:
// a link that stops applying is released.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin, mustFind } from '../helpers.js';
import { notify, notifyVenueTeam } from '../notify.js';
import { placeBasket, Rollback } from './reservations.js';
import { reservationView } from '../booking/engine.js';
import { expandDates, patternFields } from '../recurrence.js';
import { fromLocal, hhmm } from '../booking/time.js';
import { config } from '../config.js';
import { hasVenue, isParty, loadSessions, sessionsOf } from '../session-links.js';

const TAG = 'Venue sessions';
const ref = z.object({ type: z.enum(['coach_hire', 'training_session']), id, resource_id: id.optional().describe('a different court for this session') });
const basketExtras = { promo_codes: z.array(z.string().min(1).max(30)).max(5).default([]), note: z.string().max(300).optional(), team_id: id.optional(), on_conflict: z.enum(['skip', 'fail']).default('skip') };

const releaseStale = (c, type, sid) => c.query("UPDATE session_venue_links SET released_at=now(), release_reason='venue booking cancelled' WHERE session_type=$1 AND session_id=$2 AND released_at IS NULL", [type, sid]);
const link = (c, { reservationId, bookingId, s, userId }) => c.query('INSERT INTO session_venue_links(reservation_id, booking_id, session_type, session_id, linked_by) VALUES ($1,$2,$3,$4,$5)', [reservationId, bookingId, s.type, s.id, userId]);
const label = (s, userId) => (s.title ?? (s.audience !== 'individual' && s.team_name ? `${s.team_name} coaching` : `Session with ${s.coach_id === userId ? s.athlete_name : s.coach_name}`));

/** Tell the other side of each session where it will be held. One message per person. */
async function tellOthers(c, user, placed) {
  const by = new Map();
  for (const { s, venue, resource, starts_at } of placed) {
    const other = s.coach_id === user.id ? s.athlete_id : s.coach_id;
    if (other === user.id) continue;
    by.set(other, [...(by.get(other) ?? []), { s, venue, resource, starts_at }]);
  }
  for (const [who, list] of by) {
    const first = list[0];
    await notify(c, who, { kind: 'session_venue_set', title: list.length === 1 ? `${user.display_name} booked ${first.venue}` : `${user.display_name} booked a venue for ${list.length} sessions`, body: `${first.resource} at ${first.venue}, ${first.starts_at.toISOString().slice(0, 16).replace('T', ' ')} UTC${list.length > 1 ? ` and ${list.length - 1} more` : ''}.`, data: { reservation_id: first.reservationId, session_id: first.s.id } });
  }
}

/** The confirmation people expect after any booking (the same one create_reservation sends). */
async function announce(c, user, view, venueIds) {
  const owed = view.totals.map((t) => `${t.currency} ${(t.payable_cents / 100).toFixed(2)}`).join(' + ');
  await notify(c, user.id, { kind: 'reservation_confirmed', title: `Booked: ${view.code}`, body: `${view.bookings.length} slot(s). To pay: ${owed}.`, data: { reservation_id: view.id, code: view.code } });
  for (const vid of venueIds) {
    const v = (await c.query('SELECT * FROM venues WHERE id=$1', [vid])).rows[0];
    await notifyVenueTeam(c, v, user.id, { kind: 'new_booking', title: `New booking ${view.code}`, body: `${user.display_name} booked ${view.bookings.filter((b) => b.venue_id === vid).length} slot(s), some for coaching sessions.`, data: { reservation_id: view.id, venue_id: vid } });
  }
}

/**
 * Place `items` as one reservation. `meta[k]` describes item k (for messages). Lines that fail are reported with their meta;
 * with on_conflict 'fail' any failure refuses everything. `commit:false` prices and checks, then rolls back.
 * `after(c, made, placed)` runs inside the transaction once lines exist (linking sessions).
 */
async function execute(user, i, items, meta, { commit, after }) {
  let out;
  try {
    out = await tx(async (c) => {
      const made = await placeBasket(c, user, { items, promo_codes: i.promo_codes, note: i.note, team_id: i.team_id }, { collect: true });
      const failed = new Set(made.problems.filter((p) => p.index != null).map((p) => p.index));
      const problems = made.problems.map((p) => (p.index != null ? { ...meta[p.index], message: p.message, code: p.code } : { message: p.message, code: p.code }));
      const placedIdx = items.map((_, k) => k).filter((k) => !failed.has(k));
      if (!placedIdx.length || (i.on_conflict === 'fail' && made.problems.length)) throw conflict(placedIdx.length ? 'Some slots cannot be booked, so nothing was booked' : 'None of these slots can be booked', { problems });
      const view = await reservationView(c, made.reservationId);
      const placed = placedIdx.map((k, n) => ({ k, line: made.lines[n], meta: meta[k] }));
      const res = { made, view, problems, placed, extra: {} };
      if (commit) {
        await announce(c, user, view, made.venueIds);
        if (after) res.extra = await after(c, res);
        res.view = await reservationView(c, made.reservationId);
      } else if (after) res.extra = await after(c, res);
      if (!commit) throw Object.assign(new Rollback(), { res });
      return res;
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    out = e.res;
  }
  return out;
}

const summarise = (out, commit) => {
  const { view, problems, placed } = out;
  const byBooking = new Map(view.bookings.map((b) => [b.id, b]));
  return {
    booked: commit, ok: problems.length === 0, reservation_id: commit ? view.id : null, code: commit ? view.code : null,
    lines_placed: placed.length, problems, currency: view.currency, totals: view.totals, total_cents: view.total_cents, payable_cents: view.payable_cents,
    awaiting_payment: view.awaiting_payment, pay_within_minutes: out.made.payment_deadline ? config.holdMinutes : null,
    lines: placed.map(({ line, meta }) => { const b = byBooking.get(line.id) ?? line; return { ...meta, booking_id: line.id, starts_at: b.starts_at, ends_at: b.ends_at, price_cents: b.price_cents ?? null, resource_name: b.resource_name, venue_name: b.venue_name }; }),
    ...out.extra,
  };
};

// ----------------------------------------------------------------------------------------------- the board
cap({
  name: 'training_venue_board', method: 'GET', path: '/training/venues/board', tag: TAG,
  summary: 'Your upcoming coaching and training sessions (as coach or athlete, next 90 days by default) split into those that still need a venue and those with a court held. Each session carries its time, counterpart, audience and, when held, the venue, court and booking.',
  input: z.object({ days: z.coerce.number().int().min(1).max(365).default(90) }),
  async handler({ user }, i) {
    const rows = await sessionsOf(user.id, { days: i.days });
    const shape = (s) => ({
      type: s.type, id: s.id, starts_at: s.starts_at, ends_at: s.ends_at, duration_min: s.duration_min, status: s.status, audience: s.audience, participants: s.participants, sport: s.sport, sport_slug: s.sport_slug, sport_emoji: s.sport_emoji,
      title: label(s, user.id), i_am_coach: s.coach_id === user.id, coach_name: s.coach_name, athlete_name: s.athlete_name, team_name: s.team_name,
      venue: hasVenue(s) ? { link_id: s.link_id, reservation_id: s.reservation_id, booking_id: s.booking_id, venue_id: s.venue_id, venue_name: s.venue_name, city: s.venue_city, resource_name: s.resource_name, starts_at: s.venue_starts_at, ends_at: s.venue_ends_at, timezone: s.venue_timezone } : null,
    });
    const all = rows.map(shape);
    return { needs_venue: all.filter((s) => !s.venue), has_venue: all.filter((s) => s.venue) };
  },
});

// ----------------------------------------------------------------------------------------------- book a venue for sessions
const sessionVenueInput = z.object({
  sessions: z.array(ref).min(1).max(60), resource_id: id.optional().describe('the court for every session without its own'),
  buffer_before_min: z.number().int().min(0).max(120).default(0).describe('book the court this long before each session (warm-up, setting up)'), buffer_after_min: z.number().int().min(0).max(120).default(0),
  ...basketExtras,
});

async function planSessions(user, i) {
  const sessions = await loadSessions(i.sessions);
  const items = [], meta = [], pre = [];
  for (const r of i.sessions) {
    const s = sessions.get(`${r.type}:${r.id}`);
    const m = { session_type: r.type, session_id: r.id };
    if (!s) { pre.push({ ...m, message: 'Session not found' }); continue; }
    if (!isParty(user.id, s) && !isAdmin(user)) throw forbidden('You are not part of one of these sessions');
    const base = { ...m, title: label(s, user.id), session_starts_at: s.starts_at };
    if (!s.active) { pre.push({ ...base, message: 'This session is no longer active' }); continue; }
    if (new Date(s.starts_at) <= new Date()) { pre.push({ ...base, message: 'This session has already started' }); continue; }
    if (hasVenue(s)) { pre.push({ ...base, message: `Already held at ${s.venue_name} (${s.resource_name})` }); continue; }
    const resource_id = r.resource_id ?? i.resource_id;
    if (!resource_id) throw badRequest('Choose a court for every session');
    items.push({ resource_id, starts_at: new Date(+s.starts_at - i.buffer_before_min * 60_000).toISOString(), ends_at: new Date(+s.ends_at + i.buffer_after_min * 60_000).toISOString(), quantity: 1 });
    meta.push({ ...base, s });
  }
  if (!items.length) throw conflict('None of these sessions can be booked', { problems: pre });
  return { items, meta, pre };
}

async function bookSessions(user, i, commit) {
  const { items, meta, pre } = await planSessions(user, i);
  if (i.on_conflict === 'fail' && pre.length) throw conflict('Some sessions cannot get a venue, so nothing was booked', { problems: pre });
  const out = await execute(user, i, items, meta.map(({ s, ...m }) => m), {
    commit,
    after: async (c, { made, view, placed }) => {
      const venueOf = new Map(view.bookings.map((b) => [b.id, b]));
      const done = [];
      if (commit) {
        for (const { k, line } of placed) {
          const s = meta[k].s, b = venueOf.get(line.id);
          await releaseStale(c, s.type, s.id);
          await link(c, { reservationId: made.reservationId, bookingId: line.id, s, userId: user.id });
          done.push({ s, venue: b.venue_name, resource: b.resource_name, starts_at: s.starts_at, reservationId: made.reservationId });
        }
        await tellOthers(c, user, done);
      }
      return { linked: placed.length };
    },
  });
  const sum = summarise(out, commit);
  return { ...sum, problems: [...pre, ...sum.problems], sessions_requested: i.sessions.length };
}

cap({
  name: 'quote_session_venue', method: 'POST', path: '/training/venues/quote', tag: TAG,
  summary: 'Check and price a court for one or many coaching/training sessions without booking: per-session problems (court taken, outside opening hours, off the slot grid, session already has a venue), the total and what is payable. Runs the real booking logic and rolls it back.',
  input: sessionVenueInput,
  handler: ({ user }, i) => bookSessions(user, i, false),
});

cap({
  name: 'book_session_venue', method: 'POST', path: '/training/venues/book', tag: TAG, status: 201,
  summary: 'Book a court for one or many sessions — a single session, a whole recurring series, a bulk selection or a custom list — as one reservation with a line per session (plus optional set-up/clean-up buffers), and attach each session to its line. Either the coach or the athlete can do it; the other is told. Sessions whose court is taken are skipped (default) or, with on_conflict "fail", nothing is booked. You pay the venue as for any booking.',
  input: sessionVenueInput,
  handler: ({ user }, i) => bookSessions(user, i, true),
});

// ----------------------------------------------------------------------------------------------- attach to an existing booking
async function attach(c, user, rs, refs) {
  const lines = (await c.query(
    `SELECT b.id, b.starts_at, b.ends_at, r.name AS resource_name, v.name AS venue_name FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id
      WHERE b.reservation_id=$1 AND b.status='confirmed' ORDER BY b.starts_at`, [rs.id])).rows;
  const explicit = !!refs;
  let sessions;
  if (explicit) sessions = [...(await loadSessions(refs, c)).values()];
  else sessions = (await sessionsOf(user.id, { days: 400, db: c })).filter((s) => !hasVenue(s));
  const by = new Map(refs?.map((r) => [`${r.type}:${r.id}`, r]) ?? []);
  const linked = [], skipped = [], placed = [];
  for (const s of sessions) {
    const r = by.get(`${s.type}:${s.id}`);
    const m = { session_type: s.type, session_id: s.id, title: label(s, user.id), starts_at: s.starts_at };
    if (!isParty(user.id, s) && !isAdmin(user)) { if (explicit) throw forbidden('You are not part of one of these sessions'); continue; }
    if (!s.active) { if (explicit) skipped.push({ ...m, message: 'This session is no longer active' }); continue; }
    if (hasVenue(s)) { if (explicit) skipped.push({ ...m, message: `Already held at ${s.venue_name}` }); continue; }
    const line = lines.find((b) => (r?.booking_id ? b.id === r.booking_id : true) && +new Date(b.starts_at) <= +new Date(s.starts_at) && +new Date(b.ends_at) >= +new Date(s.ends_at));
    if (!line) { if (explicit) skipped.push({ ...m, message: 'The booked time does not cover this session' }); continue; }
    await releaseStale(c, s.type, s.id);
    await link(c, { reservationId: rs.id, bookingId: line.id, s, userId: user.id });
    linked.push({ ...m, booking_id: line.id, venue_name: line.venue_name, resource_name: line.resource_name });
    placed.push({ s, venue: line.venue_name, resource: line.resource_name, starts_at: s.starts_at, reservationId: rs.id });
  }
  await tellOthers(c, user, placed);
  return { linked, skipped };
}

cap({
  name: 'attach_sessions_to_booking', method: 'POST', path: '/training/venues/attach', tag: TAG,
  summary: 'Attach coaching/training sessions to a reservation you already made. Without `sessions`, every upcoming session of yours without a venue whose time falls inside one of the reservation\'s lines is attached. With `sessions` you choose (optionally the exact `booking_id`). A session must fit inside the booked time. The other party is told.',
  input: z.object({ reservation_id: id, sessions: z.array(ref.extend({ booking_id: id.optional() })).min(1).max(60).optional() }),
  async handler({ user }, i) {
    const out = await tx(async (c) => {
      const rs = (await c.query('SELECT * FROM reservations WHERE id=$1 FOR UPDATE', [i.reservation_id])).rows[0];
      if (!rs) throw notFound('Reservation');
      if (rs.user_id !== user.id && !isAdmin(user)) throw forbidden('Only the person who booked can attach sessions');
      return attach(c, user, rs, i.sessions);
    });
    if (i.sessions && !out.linked.length) throw conflict('Nothing could be attached', out);
    return out;
  },
});

cap({
  name: 'release_session_venue', method: 'DELETE', path: '/training/venues/links/:id', tag: TAG,
  summary: 'Detach a session from its venue booking (the coach, the athlete or the person who booked). The booking itself stays — cancel it separately if you no longer need the court. The link is kept as history.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const l = await mustFind('session_venue_links', i.id);
    if (l.released_at) throw conflict('Already detached');
    const s = (await loadSessions([{ type: l.session_type, id: l.session_id }])).get(`${l.session_type}:${l.session_id}`);
    const rs = await one('SELECT user_id FROM reservations WHERE id=$1', [l.reservation_id]);
    if (!isAdmin(user) && rs.user_id !== user.id && !(s && isParty(user.id, s))) throw forbidden();
    return one("UPDATE session_venue_links SET released_at=now(), release_reason='detached' WHERE id=$1 RETURNING id, released_at", [l.id]);
  },
});

// ----------------------------------------------------------------------------------------------- recurring venue bookings
const recurringInput = z.object({
  resource_id: id, start: z.string().describe('HH:MM venue-local start of each booking'), end: z.string().describe('HH:MM venue-local end (24:00 allowed)'),
  ...patternFields, ...basketExtras, attach_sessions: z.boolean().default(false).describe('also attach your upcoming coaching sessions that fall inside the new bookings'),
});

async function bookRecurring(user, i, commit) {
  const res = await one('SELECT r.id, r.name, v.timezone, v.name AS venue_name FROM resources r JOIN venues v ON v.id=r.venue_id WHERE r.id=$1', [i.resource_id]);
  if (!res) throw notFound('Bookable area');
  const a = hhmm(i.start), b = hhmm(i.end);
  if (Number.isNaN(a) || Number.isNaN(b) || a >= b || a >= 1440) throw badRequest('Each booking needs a start before its end (HH:MM)');
  const dates = expandDates(i);
  const items = dates.map((d) => ({ resource_id: i.resource_id, starts_at: fromLocal(d, a, res.timezone).toISOString(), ends_at: fromLocal(d, b, res.timezone).toISOString(), quantity: 1 }));
  const out = await execute(user, i, items, dates.map((date) => ({ date })), {
    commit,
    after: i.attach_sessions ? async (c, { made }) => {
      const rs = (await c.query('SELECT * FROM reservations WHERE id=$1', [made.reservationId])).rows[0];
      const r = await attach(c, user, rs, undefined);
      return { sessions_attached: r.linked.length, attached: r.linked };
    } : undefined,
  });
  const sum = summarise(out, commit);
  return { ...sum, venue_name: res.venue_name, resource_name: res.name, timezone: res.timezone, dates_requested: dates.length, dates };
}

cap({
  name: 'quote_recurring_venue', method: 'POST', path: '/reservations/recurring/quote', tag: TAG,
  summary: 'Check and price a recurring or custom set of bookings for one court: a weekly pattern (weekdays, every N weeks, until a date or a number of times), extra dates and dates to skip, all at the same venue-local time. Reports each date that cannot be booked. Nothing is booked.',
  input: recurringInput,
  handler: ({ user }, i) => bookRecurring(user, i, false),
});

cap({
  name: 'book_recurring_venue', method: 'POST', path: '/reservations/recurring', tag: TAG, status: 201,
  summary: 'Book a recurring or custom set of dates on one court as a single reservation (up to 60 dates). Dates that cannot be booked are skipped (default) or, with on_conflict "fail", nothing is booked. `attach_sessions` links your coaching sessions that fall inside the new bookings.',
  input: recurringInput,
  handler: ({ user }, i) => bookRecurring(user, i, true),
});
