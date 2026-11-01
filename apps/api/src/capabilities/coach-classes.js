// Coach-published group classes (issue #656). A coach turns a `group` rate card into a dated class with a seat count; athletes join until it
// is full, the rest wait. One capability set, so REST, OpenAPI and MCP share it. It extends what exists instead of copying it: the price and
// headcount come from the coach's rate card (coach-pricing.js), the coach calendar from hires and commitments, the venue is a canonical
// booking linked through session_venue_links, seats and waitlist follow the open-games model (open-games.js), money moves only through
// canonical payments and refunds, and the youth/guardian rules are the shared ones (youth.js). A class is not an academy session: an
// academy session belongs to an organisation's cohort programme with enrolled athletes; a coach class is one coach selling single seats.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin, PUBLIC_USER, sportBySlugOrId } from '../helpers.js';
import { notify } from '../notify.js';
import { requireConsent, requireGuardian } from '../youth.js';
import { cardFor } from '../coach-pricing.js';
import { CURRENCIES } from '../currency.js';
import { config } from '../config.js';
import {
  LEVELS, LIVE, TAKES_SEAT, assertCanAttend, assertCoachFree, cancelClass, checkTerms, endOf, grantSeat, lockClass,
  notifySeat, promoteWaitlist, refundSeat, seatPrice,
} from '../coach-classes.js';

const TAG = 'Coach classes';
const COACH = ['coach'];
const dt = z.string().datetime({ offset: true });
const level = z.enum(LEVELS);

const COLS = `k.id, k.coach_id, k.rate_card_id, k.sport_id, k.title, k.starts_at, k.duration_min, k.venue_id, k.min_participants, k.max_participants, k.price_cents, k.currency,
  k.skill_min, k.skill_max, k.audience, k.min_age, k.max_age, k.visibility, k.cancel_before_hours, k.min_cutoff_hours, k.payment_window_min, k.notes, k.status, k.cancelled_reason,
  (k.online_url IS NOT NULL) AS is_online, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji, v.name AS venue_name, v.city AS venue_city, v.latitude AS lat, v.longitude AS lng,
  (SELECT count(*)::int FROM coach_class_seats z WHERE z.class_id=k.id AND z.status IN ('held','confirmed')) AS taken,
  (SELECT count(*)::int FROM coach_class_seats z WHERE z.class_id=k.id AND z.status='waitlisted') AS waitlist,
  ${PUBLIC_USER.replace(/u\./g, 'h.').split(', ').map((x) => (/ AS (\w+)$/.test(x) ? x.replace(/ AS (\w+)$/, ' AS coach_$1') : `${x} AS coach_${x.slice(2)}`)).join(', ')}`;
const FROM = 'FROM coach_classes k JOIN sports s ON s.id=k.sport_id JOIN users h ON h.id=k.coach_id LEFT JOIN venues v ON v.id=k.venue_id';

const skillLabel = (lo, hi) => (!lo && !hi ? 'All levels' : lo && hi ? (lo === hi ? lo : `${lo} to ${hi}`) : lo ? `${lo}+` : `up to ${hi}`);

/** Public shape: seat counts only, the coach as a public user. Never a participant's name, calendar, contact or the online link. */
function shape(r, me) {
  const { coach_id, coach_handle, coach_display_name, coach_roles, coach_bio, coach_avatar_emoji, coach_avatar_color, coach_avatar_url, lat, lng, ...rest } = r;
  const seats_left = Math.max(0, r.max_participants - r.taken);
  return {
    ...rest, price_cents: Number(r.price_cents), seats_left, is_full: seats_left === 0, is_last_seats: seats_left > 0 && seats_left <= 2,
    needs_participants: Math.max(0, r.min_participants - r.taken), will_run: r.taken >= r.min_participants,
    coach: { id: coach_id, handle: coach_handle, display_name: coach_display_name, avatar_emoji: coach_avatar_emoji, avatar_color: coach_avatar_color, avatar_url: coach_avatar_url },
    place: r.venue_id ? { venue_id: r.venue_id, name: r.venue_name, city: r.venue_city, latitude: lat, longitude: lng } : null,
    skill: { min: r.skill_min, max: r.skill_max, label: skillLabel(r.skill_min, r.skill_max) },
    is_mine: me ? coach_id === me.id : false,
  };
}

const seatView = (m, extra = {}) => ({ seat_id: m.id, class_id: m.class_id, status: m.status, payment_status: m.payment_status, amount_cents: Number(m.amount_cents), hold_expires_at: m.hold_expires_at, attendance: m.attendance, late_cancel: m.late_cancel, ...extra });

async function getDetail(classId, user) {
  const r = await one(`SELECT ${COLS} ${FROM} WHERE k.id=$1`, [classId]);
  if (!r) throw notFound('Class');
  const card = shape(r, user);
  const mine = user ? await many('SELECT * FROM coach_class_seats WHERE class_id=$1 AND (user_id=$2 OR applied_by=$2) ORDER BY created_at', [r.id, user.id]) : [];
  const isCoach = !!user && (r.coach_id === user.id || isAdmin(user));
  const out = { ...card, my: mine.map((m) => seatView(m)) };
  // the online link is for the people who hold a seat (and the coach), not for browsers
  if (r.is_online && (isCoach || mine.some((m) => m.status === 'confirmed'))) out.online_url = (await one('SELECT online_url FROM coach_classes WHERE id=$1', [r.id])).online_url;
  if (isCoach) {
    out.can_manage = true;
    out.seats = await many(
      `SELECT z.id AS seat_id, z.status, z.payment_status, z.amount_cents, z.attendance, z.late_cancel, z.created_at, z.user_id, (z.applied_by IS NOT NULL) AS applied_by_guardian,
              u.display_name, u.handle, u.avatar_emoji, u.avatar_color, EXISTS (SELECT 1 FROM guardian_links gl WHERE gl.child_id=u.id AND gl.status='active') AS is_youth
         FROM coach_class_seats z JOIN users u ON u.id=z.user_id WHERE z.class_id=$1 AND z.status <> 'declined' ORDER BY z.created_at, z.id`, [r.id])
      .then((rows) => rows.map(({ handle, display_name, avatar_emoji, avatar_color, is_youth, ...s }) => ({ ...s, amount_cents: Number(s.amount_cents), person: is_youth ? { display_name, is_youth: true } : { handle, display_name, avatar_emoji, avatar_color, is_youth: false } })));
  }
  return out;
}

// ---------------------------------------------------------------- publishing

cap({
  name: 'publish_coach_class', method: 'POST', path: '/coach/classes', tag: TAG, auth: COACH, status: 201,
  summary: 'Coach: publish a dated class from one of your group rate cards with a seat count. Headcount defaults come from the card; the seat price is fixed now from the card (per-person cards charge their price per seat, a flat group price is split across the seats). Needs a venue or an https online link. min_participants is the run/cancel threshold: under it min_cutoff_hours before the start, the class is cancelled and everyone refunded. Your calendar is checked against hires, commitments and other classes. Link a confirmed venue booking with booking_id (book it first); a class never holds a court by itself.',
  input: z.object({
    rate_card_id: id, title: z.string().trim().min(2).max(120).optional(), starts_at: dt, duration_minutes: z.number().int().min(15).max(720).optional(),
    sport: z.string().optional().describe('slug or id; only needed when the rate card has no sport'),
    venue_id: id.optional(), booking_id: id.optional().describe('your confirmed booking that covers the class; linked, not copied'), online_url: z.string().url().max(500).startsWith('https://').optional(),
    min_participants: z.number().int().min(1).max(500).optional(), max_participants: z.number().int().min(1).max(500).optional(),
    skill_min: level.nullable().optional(), skill_max: level.nullable().optional(),
    audience: z.enum(['adults', 'all_ages', 'youth']).default('adults'), min_age: z.number().int().min(0).max(120).nullable().optional(), max_age: z.number().int().min(0).max(120).nullable().optional(),
    visibility: z.enum(['public', 'link']).default('public'), cancel_before_hours: z.number().int().min(0).max(720).default(12), min_cutoff_hours: z.number().int().min(0).max(720).default(12),
    payment_window_minutes: z.number().int().min(5).max(2880).default(60), notes: z.string().trim().max(500).nullable().optional(),
  }),
  async handler({ user }, i) {
    if (Date.parse(i.starts_at) <= Date.now()) throw badRequest('The class must start in the future');
    if (!i.venue_id && !i.online_url) throw badRequest('Say where: pick a venue or give an online link', { code: 'place_required' });
    const card = await cardFor(user.id, i.rate_card_id, { audience: 'group' });
    const sport = card.sport_id ? { id: card.sport_id } : i.sport ? await sportBySlugOrId(i.sport) : null;
    if (!sport) throw badRequest('Choose the sport: this rate card has none', { code: 'sport_required' });
    if (i.online_url && card.delivery === 'in_person') throw badRequest('This rate card is for in-person delivery');
    if (i.venue_id && card.delivery === 'online') throw badRequest('This rate card is for online delivery');
    const mins = i.duration_minutes ?? card.duration_min ?? 60;
    const max = i.max_participants ?? card.max_participants;
    if (!max) throw badRequest('Give max_participants: the rate card has no limit');
    const min = i.min_participants ?? card.min_participants;
    if (card.max_participants && max > card.max_participants) throw badRequest(`This rate card covers up to ${card.max_participants} participants`);
    if (min < card.min_participants) throw badRequest(`This rate card needs at least ${card.min_participants} participants`);
    checkTerms({ ...i, min_participants: min, max_participants: max });
    const currency = config.payments.currency;
    if (!Object.hasOwn(CURRENCIES, currency)) throw badRequest('Unsupported currency');
    const price = seatPrice(card, mins, max);
    return tx(async (c) => {
      if (i.venue_id && !(await c.query('SELECT 1 FROM venues WHERE id=$1 AND active', [i.venue_id])).rows[0]) throw notFound('Venue');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`coach_calendar:${user.id}`]); // serialise this coach's calendar so two publishes cannot both pass the clash check
      await assertCoachFree(c, user.id, i.starts_at, mins);
      const sportName = (await c.query('SELECT name FROM sports WHERE id=$1', [sport.id])).rows[0].name;
      const k = (await c.query(
        `INSERT INTO coach_classes(coach_id, rate_card_id, sport_id, title, starts_at, duration_min, venue_id, online_url, min_participants, max_participants, price_cents, currency, skill_min, skill_max,
            audience, min_age, max_age, visibility, cancel_before_hours, min_cutoff_hours, payment_window_min, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
        [user.id, card.id, sport.id, i.title ?? (card.title.toLowerCase().includes(sportName.toLowerCase()) ? card.title : `${sportName}: ${card.title}`), i.starts_at, mins, i.venue_id ?? null, i.online_url ?? null, min, max, price, currency, i.skill_min ?? null, i.skill_max ?? null,
          i.audience, i.min_age ?? null, i.max_age ?? null, i.visibility, i.cancel_before_hours, i.min_cutoff_hours, i.payment_window_minutes, i.notes ?? null])).rows[0];
      if (i.booking_id) await linkBooking(c, user, k, i.booking_id);
      return k;
    }).then((k) => getDetail(k.id, user));
  },
});

/** A venue booking can host a class when it is the coach's own, confirmed, and covers the class time. Many classes may share one line (a group at one court). */
async function linkBooking(c, user, k, bookingId) {
  const b = (await c.query('SELECT b.*, rs.id AS reservation_id, r.venue_id AS r_venue FROM bookings b JOIN resources r ON r.id=b.resource_id LEFT JOIN reservations rs ON rs.id=b.reservation_id WHERE b.id=$1', [bookingId])).rows[0];
  if (!b) throw notFound('Booking');
  if (b.user_id !== user.id && !isAdmin(user)) throw forbidden('That booking is not yours');
  if (b.status !== 'confirmed') throw conflict('That booking is not confirmed', { code: 'booking_not_confirmed' });
  if (new Date(b.starts_at) > new Date(k.starts_at) || new Date(b.ends_at) < endOf(k)) throw conflict('The booking does not cover the whole class', { code: 'booking_window' });
  if (!b.reservation_id) throw badRequest('That booking has no reservation to link');
  if (k.venue_id && k.venue_id !== b.r_venue) throw badRequest('The booking is at a different venue');
  if (!k.venue_id) await c.query('UPDATE coach_classes SET venue_id=$2 WHERE id=$1', [k.id, b.r_venue]);
  await c.query('INSERT INTO session_venue_links(reservation_id, booking_id, session_type, session_id, linked_by) VALUES ($1,$2,$3,$4,$5)', [b.reservation_id, b.id, 'coach_class', k.id, user.id]);
}

cap({
  name: 'get_coach_class', method: 'GET', path: '/coach/classes/:id', tag: TAG, auth: 'public',
  summary: 'One class: when/where, seats left (counts only, never who has joined), level, price per seat, the coach and your own seat. The coach also sees the seat list; the online link is shown only to seat holders and the coach.',
  input: z.object({ id }), handler: ({ user }, i) => getDetail(i.id, user),
});

cap({
  name: 'list_coach_classes', method: 'GET', path: '/coach/classes', tag: TAG, auth: 'public',
  summary: 'Open coach classes with live seat counts, soonest first. Filter by coach, sport, dates or free seats; mine=true lists the classes you coach or hold a seat in. Public listing: no personal data, seat counts only. Link-only classes appear only to their coach and seat holders.',
  input: z.object({
    coach_id: id.optional(), sport: z.string().optional(), from: dt.optional(), to: dt.optional(), has_seats: z.coerce.boolean().optional(), mine: z.coerce.boolean().optional(),
    status: z.enum(['open', 'cancelled', 'completed']).default('open'), ...page,
  }),
  async handler({ user }, i) {
    if (i.mine && !user) throw forbidden('Sign in to see your classes');
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    const p = [];
    const arg = (v) => (p.push(v), `$${p.length}`);
    const where = [`k.status=${arg(i.status)}`];
    if (i.status === 'open') where.push('k.starts_at > now()');
    if (i.mine) { const u = arg(user.id); where.push(`(k.coach_id=${u} OR EXISTS (SELECT 1 FROM coach_class_seats z WHERE z.class_id=k.id AND (z.user_id=${u} OR z.applied_by=${u}) AND z.status = ANY(${arg(LIVE)}::text[])))`); }
    else where.push(user ? `(k.visibility='public' OR k.coach_id=${arg(user.id)} OR EXISTS (SELECT 1 FROM coach_class_seats z WHERE z.class_id=k.id AND z.user_id=$${p.length}))` : "k.visibility='public'");
    if (i.coach_id) where.push(`k.coach_id=${arg(i.coach_id)}`);
    if (sport) where.push(`k.sport_id=${arg(sport.id)}`);
    if (i.from) where.push(`k.starts_at >= ${arg(i.from)}`);
    if (i.to) where.push(`k.starts_at < ${arg(i.to)}`);
    if (i.has_seats) where.push("(SELECT count(*) FROM coach_class_seats z WHERE z.class_id=k.id AND z.status IN ('held','confirmed')) < k.max_participants");
    // a class for young people or adults only is shown to anyone, but joining is checked on the server; seat counts are all the public sees
    const rows = await many(`SELECT ${COLS} ${FROM} WHERE ${where.join(' AND ')} ORDER BY k.starts_at, k.id LIMIT ${arg(i.limit)} OFFSET ${arg(i.offset)}`, p);
    return rows.map((r) => shape(r, user));
  },
});

// ---------------------------------------------------------------- joining

cap({
  name: 'join_coach_class', method: 'POST', path: '/coach/classes/:id/join', tag: TAG, status: 201,
  summary: 'Take a seat in a class. A free class confirms straight away; a paid class holds your seat for the payment window while you pay (start checkout with purpose_type coach_class_seat and the returned seat_id). A full class puts you on the waitlist: when a seat frees the next person in order is offered it, with a payment window. A guardian joins for a young person with on_behalf_of; a young person asking for themselves waits for a guardian\'s approval. Send an idempotency_key so a retry never takes a second seat.',
  input: z.object({ id, on_behalf_of: id.optional(), idempotency_key: z.string().min(8).max(80).optional() }),
  async handler({ user }, i) {
    const subject = i.on_behalf_of ?? user.id;
    return tx(async (c) => {
      const k = await lockClass(c, i.id);
      if (!k) throw notFound('Class');
      if (subject !== user.id) await requireGuardian(user, subject, c);
      if (subject === k.coach_id) throw badRequest('You are the coach of this class');
      const prior = (await c.query('SELECT * FROM coach_class_seats WHERE class_id=$1 AND user_id=$2 FOR UPDATE', [k.id, subject])).rows[0];
      if (prior && LIVE.includes(prior.status)) return seatView(prior, { replayed: true });
      if (k.status !== 'open') throw conflict('This class is closed', { code: 'class_closed' });
      if (new Date(k.starts_at) <= new Date()) throw conflict('This class has already started', { code: 'class_started' });
      if (prior?.status === 'declined') throw conflict('The guardian declined this class', { code: 'declined' });
      const { youth } = await assertCanAttend(c, k, subject, user);
      let seat = prior;
      const f = [k.id, subject, subject === user.id ? null : user.id, i.idempotency_key ?? null];
      if (seat) seat = (await c.query("UPDATE coach_class_seats SET status='waitlisted', applied_by=$3, idempotency_key=$4, created_at=now(), cancelled_at=NULL, cancelled_by=NULL, late_cancel=false, attendance=NULL, hold_expires_at=NULL, payment_status='none', amount_cents=0, updated_at=now() WHERE class_id=$1 AND user_id=$2 RETURNING *", f)).rows[0];
      else seat = (await c.query("INSERT INTO coach_class_seats(class_id, user_id, applied_by, idempotency_key, status) VALUES ($1,$2,$3,$4,'waitlisted') RETURNING *", f)).rows[0];

      if (youth && subject === user.id) { // a young person asking for themselves: their guardians decide first
        const guardians = (await c.query("SELECT guardian_id FROM guardian_links WHERE child_id=$1 AND status='active' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", [subject])).rows;
        if (!guardians.length) throw conflict('A verified guardian must be linked to your account before you can join classes', { code: 'guardian_required' });
        seat = (await c.query("UPDATE coach_class_seats SET status='guardian_pending' WHERE id=$1 RETURNING *", [seat.id])).rows[0];
        for (const gl of guardians) await notify(c, gl.guardian_id, { kind: 'coach_class_guardian_request', title: 'Approve a class?', body: `A young person you look after asked to join "${k.title}". Open the app to approve or decline.`, data: { class_id: k.id, seat_id: seat.id }, dedupe_key: `cc_guardian:${seat.id}:${gl.guardian_id}` });
        return seatView(seat);
      }
      if (youth) await requireConsent(subject, 'participation', 'taking part in a class', c);
      seat = await place(c, k, seat);
      await notifySeat(c, seat, seat.status === 'waitlisted'
        ? { kind: 'coach_class_waitlisted', title: 'You are on the waitlist', body: `"${k.title}" is full. You are offered a seat automatically if one frees.`, key: `cc_self:${seat.id}:waitlisted` }
        : { kind: 'coach_class_joined', title: seat.status === 'held' ? 'Seat held' : 'You are in!', body: seat.status === 'held' ? `Pay within ${k.payment_window_min} minutes to keep your seat in "${k.title}".` : `Your seat in "${k.title}" is confirmed.`, key: `cc_self:${seat.id}:${seat.status}` }, k);
      return seatView(seat);
    });
  },
});

/** Seat if one is free, else stay on the waitlist (the class row is locked by the caller, so the count cannot move under us). */
async function place(c, k, seat) {
  if ((await c.query("SELECT count(*)::int AS n FROM coach_class_seats WHERE class_id=$1 AND status IN ('held','confirmed')", [k.id])).rows[0].n >= k.max_participants) return seat.status === 'waitlisted' ? seat : (await c.query("UPDATE coach_class_seats SET status='waitlisted', updated_at=now() WHERE id=$1 RETURNING *", [seat.id])).rows[0];
  // free seats go first to people already waiting (strict order), so a newcomer cannot jump the queue
  const ahead = (await c.query("SELECT 1 FROM coach_class_seats WHERE class_id=$1 AND status='waitlisted' AND id <> $2 AND (created_at, id) < ($3, $2) LIMIT 1", [k.id, seat.id, seat.created_at])).rows[0];
  if (ahead) return seat;
  return grantSeat(c, k, seat);
}

/** Give up a seat. Paid seats are refunded unless it is later than the class's cut-off (then it is a factual late cancel). Frees the seat for the waitlist. */
async function leave(c, k, seat, by) {
  const held = TAKES_SEAT.includes(seat.status);
  const late = held && by === 'member' && Date.now() > +new Date(k.starts_at) - k.cancel_before_hours * 36e5;
  let pay = seat.payment_status;
  if (seat.payment_status === 'paid') pay = late ? 'not_refundable' : await refundSeat(c, seat);
  else if (seat.payment_status === 'unpaid') pay = 'none';
  const row = (await c.query("UPDATE coach_class_seats SET status='cancelled', cancelled_at=now(), cancelled_by=$2, late_cancel=$3, payment_status=$4, hold_expires_at=NULL, updated_at=now() WHERE id=$1 RETURNING *", [seat.id, by, late, pay])).rows[0];
  if (held) await promoteWaitlist(c, k);
  return row;
}

cap({
  name: 'leave_coach_class', method: 'POST', path: '/coach/classes/:id/leave', tag: TAG,
  summary: 'Give up your seat, waitlist place or request (a guardian can for a young person). A paid seat is refunded unless you leave after the class\'s cancellation cut-off, which is recorded as a factual late cancellation. The next person on the waitlist is offered the seat in order. Safe to repeat.',
  input: z.object({ id, on_behalf_of: id.optional() }),
  async handler({ user }, i) {
    const subject = i.on_behalf_of ?? user.id;
    return tx(async (c) => {
      const k = await lockClass(c, i.id);
      if (!k) throw notFound('Class');
      if (subject !== user.id) await requireGuardian(user, subject, c);
      const seat = (await c.query('SELECT * FROM coach_class_seats WHERE class_id=$1 AND user_id=$2 FOR UPDATE', [k.id, subject])).rows[0];
      if (!seat) throw notFound('Seat in this class');
      if (!LIVE.includes(seat.status)) return seatView(seat, { replayed: true });
      if (new Date(k.starts_at) <= new Date() && TAKES_SEAT.includes(seat.status)) throw conflict('The class has started; ask the coach to record attendance', { code: 'class_started' });
      const row = await leave(c, k, seat, 'member');
      if (TAKES_SEAT.includes(seat.status)) await notify(c, k.coach_id, { kind: 'coach_class_left', title: 'A participant dropped out', body: `Someone left "${k.title}"${row.late_cancel ? ' after the cancellation cut-off' : ''}.`, data: { class_id: k.id, seat_id: seat.id }, dedupe_key: `cc_left:${seat.id}:${row.cancelled_at.getTime()}` });
      return seatView(row, { late_cancel: row.late_cancel });
    });
  },
});

cap({
  name: 'guardian_decide_coach_class_join', method: 'POST', path: '/coach/classes/:id/seats/:seat_id/guardian-decision', tag: TAG,
  summary: 'Guardian: approve or decline a young person\'s request to join a class. Approving needs your current consent for taking part; the child then follows the normal seat and waitlist rules.',
  input: z.object({ id, seat_id: id, decision: z.enum(['approve', 'decline']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const k = await lockClass(c, i.id);
      if (!k) throw notFound('Class');
      const seat = (await c.query('SELECT * FROM coach_class_seats WHERE id=$1 AND class_id=$2 FOR UPDATE', [i.seat_id, k.id])).rows[0];
      if (!seat) throw notFound('Request');
      await requireGuardian(user, seat.user_id, c);
      if (seat.status !== 'guardian_pending') return seatView(seat, { replayed: true });
      if (i.decision === 'decline') return seatView((await c.query("UPDATE coach_class_seats SET status='declined', updated_at=now() WHERE id=$1 RETURNING *", [seat.id])).rows[0]);
      await requireConsent(seat.user_id, 'participation', 'taking part in a class', c);
      if (k.status !== 'open' || new Date(k.starts_at) <= new Date()) throw conflict('This class is closed');
      return seatView(await place(c, k, seat));
    });
  },
});

// ---------------------------------------------------------------- running it

cap({
  name: 'cancel_coach_class', method: 'POST', path: '/coach/classes/:id/cancel', tag: TAG, auth: COACH,
  summary: 'Coach: cancel a class. Everyone holding a seat or a place is released, paid seats are refunded in full through canonical payments, and everyone is told. If a refund is refused nothing is cancelled. Safe to repeat.',
  input: z.object({ id, reason: z.string().trim().min(2).max(300) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const k = await lockClass(c, i.id);
      if (!k || (k.coach_id !== user.id && !isAdmin(user))) throw notFound('Class');
      if (k.status === 'cancelled') return { id: k.id, status: 'cancelled', replayed: true };
      if (k.status === 'completed') throw conflict('This class is complete', { code: 'completed' });
      const released = await cancelClass(c, k, { reason: i.reason, by: 'coach' });
      await c.query("UPDATE session_venue_links SET released_at=now(), release_reason='class cancelled' WHERE session_type='coach_class' AND session_id=$1 AND released_at IS NULL", [k.id]);
      return { id: k.id, status: 'cancelled', released };
    });
  },
});

cap({
  name: 'record_coach_class_attendance', method: 'POST', path: '/coach/classes/:id/seats/:seat_id/attendance', tag: TAG, auth: COACH,
  summary: 'Coach: record that a seat holder attended or did not show, once the class has started. A factual record; nothing is labelled automatically. It appears in the coaching journal for the class without changing who can see it.',
  input: z.object({ id, seat_id: id, attendance: z.enum(['attended', 'no_show']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const k = await lockClass(c, i.id);
      if (!k || (k.coach_id !== user.id && !isAdmin(user))) throw notFound('Class');
      if (k.status === 'cancelled') throw conflict('This class was cancelled');
      if (new Date(k.starts_at) > new Date()) throw conflict('The class has not started yet', { code: 'not_started' });
      const seat = (await c.query("SELECT * FROM coach_class_seats WHERE id=$1 AND class_id=$2 AND status='confirmed' FOR UPDATE", [i.seat_id, k.id])).rows[0];
      if (!seat) throw notFound('Seat holder');
      if (seat.attendance === i.attendance) return seatView(seat, { replayed: true });
      const row = (await c.query('UPDATE coach_class_seats SET attendance=$2, attendance_by=$3, updated_at=now() WHERE id=$1 RETURNING *', [seat.id, i.attendance, user.id])).rows[0];
      await mirrorAttendance(c, k, row);
      if (i.attendance === 'no_show') await notifySeat(c, row, { kind: 'coach_class_no_show', title: 'Marked as not attended', body: `The coach recorded that you did not attend "${k.title}".`, key: `cc_noshow:${seat.id}` }, k);
      return seatView(row);
    });
  },
});

/** If the coach has opened this class in Performance Studio, the attendance lands on that session's roster (one fact, written once, here). */
async function mirrorAttendance(c, k, seat) {
  const rec = (await c.query("SELECT id FROM coaching_session_records WHERE coach_id=$1 AND source_type='coach_class' AND source_id=$2", [k.coach_id, k.id])).rows[0];
  if (!rec) return;
  await c.query(
    `UPDATE coaching_session_participants SET attendance=$3, arrived_at=CASE WHEN $3='present' THEN coalesce(arrived_at, now()) ELSE NULL END, updated_at=now() WHERE session_record_id=$1 AND athlete_id=$2`,
    [rec.id, seat.user_id, seat.attendance === 'attended' ? 'present' : 'absent']);
}

cap({
  name: 'complete_coach_class', method: 'POST', path: '/coach/classes/:id/complete', tag: TAG, auth: COACH,
  summary: 'Coach: mark a class that has started as complete. Seat holders you did not mark are left unrecorded rather than labelled. Safe to repeat.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const k = await lockClass(c, i.id);
      if (!k || (k.coach_id !== user.id && !isAdmin(user))) throw notFound('Class');
      if (k.status === 'completed') return { id: k.id, status: 'completed', replayed: true };
      if (k.status === 'cancelled') throw conflict('This class was cancelled');
      if (new Date(k.starts_at) > new Date()) throw conflict('The class has not started yet', { code: 'not_started' });
      await c.query("UPDATE coach_classes SET status='completed', row_version=row_version+1, updated_at=now() WHERE id=$1", [k.id]);
      return { id: k.id, status: 'completed' };
    });
  },
});
