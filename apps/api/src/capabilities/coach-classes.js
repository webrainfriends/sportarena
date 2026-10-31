// Coach-published group classes (issue #656). A coach publishes dated occurrences of a `group` rate card with a seat count; athletes
// (or a guardian for a young person) join, pay per seat, queue on a waitlist that promotes in order with a payment window, and the coach
// records attendance. Rules live in src/coach-classes.js; money moves through the canonical payments flow (create_payment with
// purpose_type 'coach_class_seat' and the seat id). Public views show seat counts only, never names.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin, PUBLIC_USER, sportBySlugOrId } from '../helpers.js';
import { config } from '../config.js';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { cardFor, priceFor } from '../coach-pricing.js';
import { expandDates, patternFields } from '../recurrence.js';
import { fromLocal, hhmm, validTimezone } from '../booking/time.js';
import { loadCoachSchedule } from '../coach-slots.js';
import { guardiansOf, NOT_YOUTH_SQL, requireConsent, requireGuardian } from '../youth.js';
import {
  LIVE, assertCanJoin, cancelClassTx, clashReason, endOf, lockClass, lockCoachCalendar, mirrorClassAttendance, notifySeat, payWindowMin,
  placeSeat, processRefunds, promoteWaitlist, seatsTaken,
} from '../coach-classes.js';

const TAG = 'Coach classes';
const COACH = ['coach'];
const dt = z.string().datetime({ offset: true });

const SEATS_SQL = `(SELECT count(*) FILTER (WHERE s.status IN ('held','confirmed'))::int FROM coach_class_seats s WHERE s.class_id=k.id) AS taken,
  (SELECT count(*) FILTER (WHERE s.status='confirmed')::int FROM coach_class_seats s WHERE s.class_id=k.id) AS confirmed,
  (SELECT count(*) FILTER (WHERE s.status='waitlisted')::int FROM coach_class_seats s WHERE s.class_id=k.id) AS waiting`;

/** The public shape of a class: seat counts, never names; the online link and roster are added only for people entitled to them. */
const classView = (r, extra = {}) => ({
  id: r.id, title: r.title, status: r.status, cancelled_reason: r.cancelled_reason, cancelled_by: r.cancelled_by, series_id: r.series_id,
  coach: { id: r.coach_id, handle: r.coach_handle, display_name: r.coach_name, avatar_emoji: r.coach_avatar_emoji, avatar_color: r.coach_avatar_color },
  sport: { id: r.sport_id, slug: r.sport_slug, name: r.sport_name, emoji: r.sport_emoji },
  starts_at: r.starts_at, ends_at: endOf(r), duration_min: r.duration_min, delivery: r.delivery, location: r.delivery === 'in_person' ? r.location : null,
  venue: r.venue_id ? { id: r.venue_id, name: r.venue_name, city: r.venue_city } : null, court_held: r.court_held,
  price_cents: Number(r.price_cents), currency: r.currency, audience: r.audience, min_age: r.min_age, max_age: r.max_age, notes: r.notes,
  min_participants: r.min_participants, max_participants: r.max_participants, cutoff_at: r.cutoff_at, rate_card_id: r.rate_card_id,
  seats: { max: r.max_participants, taken: r.taken, left: Math.max(0, r.max_participants - r.taken), waiting: r.waiting, confirmed: r.confirmed, min_met: r.confirmed >= r.min_participants },
  ...extra,
});

const BASE = `SELECT k.*, ${SEATS_SQL}, u.handle AS coach_handle, u.display_name AS coach_name, u.avatar_emoji AS coach_avatar_emoji, u.avatar_color AS coach_avatar_color,
    s.slug AS sport_slug, s.name AS sport_name, s.emoji AS sport_emoji, v.name AS venue_name, v.city AS venue_city,
    EXISTS (SELECT 1 FROM session_venue_links l JOIN bookings b ON b.id=l.booking_id AND b.status='confirmed' WHERE l.session_type='coach_class' AND l.session_id=k.id AND l.released_at IS NULL) AS court_held
  FROM coach_classes k JOIN users u ON u.id=k.coach_id JOIN sports s ON s.id=k.sport_id LEFT JOIN venues v ON v.id=k.venue_id`;

const loadView = async (classId) => { const r = await one(`${BASE} WHERE k.id=$1`, [classId]); return r && classView(r); };

const seatView = (s, extra = {}) => ({
  seat_id: s.id, class_id: s.class_id, status: s.status, payment_status: s.payment_status, price_cents: Number(s.price_cents), pay_by: s.pay_by,
  attendance: s.attendance, late_cancel: s.late_cancel, position: s.position ?? undefined, ...extra,
});
/** Seats a person may see: their own, ones they booked for someone, and those of young people they actively look after (so a guardian sees a child's request). */
const MINE_SQL = (p) => `(s.user_id=${p} OR s.applied_by=${p} OR EXISTS (SELECT 1 FROM guardian_links l WHERE l.guardian_id=${p} AND l.child_id=s.user_id AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())))`;
const waitPosition = async (c, s) => s.status !== 'waitlisted' ? undefined : Number((await c.query("SELECT count(*) AS n FROM coach_class_seats o JOIN coach_class_seats me ON me.id=$1 WHERE o.class_id=me.class_id AND o.status='waitlisted' AND (o.queued_at, o.id) <= (me.queued_at, me.id)", [s.id])).rows[0].n);   // compared in SQL: a JS Date would cut microseconds

// ---------------------------------------------------------------- coach: publish, change, cancel

async function publishOne(user, p, startsAt, mins, seriesId) {
  return tx(async (c) => {
    await lockCoachCalendar(c, user.id);
    const why = await clashReason(c, user.id, startsAt, mins);
    if (why) return { skipped: why };
    const k = (await c.query(
      `INSERT INTO coach_classes(coach_id, rate_card_id, sport_id, title, starts_at, duration_min, delivery, venue_id, location, online_link_enc, min_participants, max_participants,
                                 cutoff_at, price_cents, currency, audience, min_age, max_age, notes, series_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (coach_id, starts_at) WHERE status <> 'cancelled' DO NOTHING RETURNING id`,
      [user.id, p.card.id, p.sport.id, p.title, startsAt, mins, p.delivery, p.venue_id ?? null, p.location ?? null, p.link_enc, p.min, p.max,
        new Date(+startsAt - p.cutoff_hours * 36e5), p.price, config.payments.currency, p.audience, p.min_age ?? null, p.max_age ?? null, p.notes ?? null, seriesId])).rows[0];
    return k ? { id: k.id } : { skipped: 'You already run a class at that time' };
  });
}

cap({
  name: 'publish_coach_class', method: 'POST', path: '/coach/classes', tag: TAG, auth: COACH, status: 201,
  summary: 'Publish a dated class from one of your `group` rate cards: start, venue (or an online link), the seats (max_participants) and the minimum that must book by the cutoff, or the class is cancelled and everyone refunded. The price per seat comes from the card (a flat group price is split across the seats). Checks your calendar against your other classes, hires and commitments. Send `repeat` to publish a weekly series in one go (each date is its own class).',
  input: z.object({
    rate_card_id: id, sport: z.string().optional().describe('slug or id; required when the card is for any sport'), title: z.string().trim().min(2).max(120).optional(),
    starts_at: dt.optional().describe('start instant for a single class'),
    repeat: z.object({ start: z.string().describe('HH:MM local time of each class'), timezone: z.string().max(60).optional(), ...patternFields }).optional(),
    duration_min: z.number().int().min(15).max(1440).optional(), delivery: z.enum(['in_person', 'online']).default('in_person'),
    venue_id: id.optional(), location: z.string().trim().max(200).optional(), online_link: z.string().url().max(500).optional(),
    min_participants: z.number().int().min(1).max(500).optional(), max_participants: z.number().int().min(1).max(500).optional(),
    cutoff_hours: z.number().int().min(0).max(168).default(12).describe('hours before the start when the minimum is checked'),
    audience: z.enum(['all', 'adults', 'youth']).default('all'), min_age: z.number().int().min(0).max(120).optional(), max_age: z.number().int().min(0).max(120).optional(),
    notes: z.string().trim().max(1000).optional(), on_conflict: z.enum(['skip', 'fail']).default('skip'),
  }),
  async handler({ user }, i) {
    if (!i.starts_at === !i.repeat) throw badRequest('Send either starts_at (one class) or repeat (a series)');
    const card = await cardFor(user.id, i.rate_card_id);
    if (card.audience !== 'group') throw badRequest('Classes are published from a group rate card');
    if (card.delivery !== 'both' && card.delivery !== i.delivery) throw badRequest(`That rate card is for ${card.delivery.replace('_', '-')} delivery`);
    const sport = await sportBySlugOrId(i.sport ?? card.sport_id ?? '');
    if (!sport) throw badRequest('Choose a sport');
    if (card.sport_id && card.sport_id !== sport.id) throw badRequest('That rate card is for a different sport');
    if (!(await one("SELECT 1 FROM active_sport_profiles WHERE user_id=$1 AND sport_id=$2 AND role='coach'", [user.id, sport.id]))) throw badRequest('You do not coach this sport');
    const mins = card.unit === 'hour' ? i.duration_min ?? card.duration_min ?? 60 : card.duration_min ?? i.duration_min ?? 60;
    const max = i.max_participants ?? card.max_participants;
    if (!max) throw badRequest('Say how many seats the class has (max_participants)');
    const min = i.min_participants ?? card.min_participants;
    if (min > max) throw badRequest('The minimum cannot be more than the seats');
    if (min < card.min_participants || (card.max_participants && max > card.max_participants)) throw badRequest(`This rate card covers ${card.min_participants}${card.max_participants ? `–${card.max_participants}` : '+'} participants`);
    if (i.min_age != null && i.max_age != null && i.min_age > i.max_age) throw badRequest('min_age is above max_age');
    if (i.delivery === 'online' && !i.online_link) throw badRequest('Add the link people will use to join online');
    if (i.delivery === 'in_person') {
      if (!i.venue_id && !i.location) throw badRequest('Choose a venue or say where the class is');
      if (i.venue_id && !(await one('SELECT 1 FROM venues WHERE id=$1', [i.venue_id]))) throw notFound('Venue');
    }
    const one1 = priceFor(card, mins, 1);
    const price = card.per_person ? one1 : Math.ceil(one1 / max);
    const p = { card, sport, title: i.title ?? card.title, delivery: i.delivery, venue_id: i.venue_id, location: i.location, min, max, cutoff_hours: i.cutoff_hours, price, audience: i.audience, min_age: i.min_age, max_age: i.max_age, notes: i.notes, link_enc: i.online_link ? encrypt(i.online_link, 'coach_classes.online_link') : null };

    let starts;
    if (i.repeat) {
      const tz = i.repeat.timezone ?? (await loadCoachSchedule(user.id)).timezone;
      if (!validTimezone(tz)) throw badRequest('Unknown time zone');
      const startMin = hhmm(i.repeat.start);
      if (Number.isNaN(startMin) || startMin >= 1440) throw badRequest('start must be a time like 17:30');
      starts = expandDates(i.repeat).map((d) => fromLocal(d, startMin, tz));
    } else starts = [new Date(i.starts_at)];
    const now = Date.now();
    starts = starts.filter((s) => +s - i.cutoff_hours * 36e5 > now);
    if (!starts.length) throw badRequest('Those times are too soon: the cutoff would already have passed. Pick a later time or a shorter cutoff.');

    const seriesId = i.repeat ? crypto.randomUUID() : null;
    if (i.on_conflict === 'fail' && starts.length > 1) {
      const blocked = [];
      for (const s of starts) { const why = await tx((c) => clashReason(c, user.id, s, mins)); if (why) blocked.push({ starts_at: s.toISOString(), reason: why }); }
      if (blocked.length) throw conflict('Some dates clash with your calendar', { code: 'calendar_clash', dates: blocked });
    }
    const classes = [], skipped = [];
    for (const s of starts) {
      const r = await publishOne(user, p, s, mins, seriesId);
      if (r.skipped) { if (starts.length === 1) throw conflict(r.skipped, { code: 'calendar_clash' }); skipped.push({ starts_at: s.toISOString(), reason: r.skipped }); } else classes.push(await loadView(r.id));
    }
    return { classes, skipped };
  },
});

const ownClass = async (c, user, classId) => {
  const k = await lockClass(c, classId);
  if (!k || (k.coach_id !== user.id && !isAdmin(user))) throw notFound('Class');
  return k;
};

cap({
  name: 'update_coach_class', method: 'PATCH', path: '/coach/classes/:id', tag: TAG, auth: COACH,
  summary: 'Change a class you run: title, notes, where it is, the online link, the seats (raising them promotes the waitlist; they cannot go below the seats already taken), the minimum or the cutoff. The time, price and rate card stay fixed once published: cancel and republish to change them. Seat holders are told when the place changes.',
  input: z.object({
    id, title: z.string().trim().min(2).max(120).optional(), notes: z.string().trim().max(1000).nullable().optional(), location: z.string().trim().max(200).optional(), venue_id: id.nullable().optional(),
    online_link: z.string().url().max(500).optional(), min_participants: z.number().int().min(1).max(500).optional(), max_participants: z.number().int().min(1).max(500).optional(), cutoff_hours: z.number().int().min(0).max(168).optional(),
  }),
  async handler({ user }, i) {
    await tx(async (c) => {
      const k = await ownClass(c, user, i.id);
      if (k.status !== 'scheduled') throw conflict('This class is no longer open for changes');
      const max = i.max_participants ?? k.max_participants, min = i.min_participants ?? k.min_participants;
      if (min > max) throw badRequest('The minimum cannot be more than the seats');
      if (max < (await seatsTaken(c, k.id))) throw conflict('More seats are already taken than that', { code: 'seats_taken' });
      const card = (await c.query('SELECT min_participants, max_participants FROM coach_rate_cards WHERE id=$1', [k.rate_card_id])).rows[0];
      if (min < card.min_participants || (card.max_participants && max > card.max_participants)) throw badRequest(`This rate card covers ${card.min_participants}${card.max_participants ? `–${card.max_participants}` : '+'} participants`);
      const cutoff = i.cutoff_hours != null ? new Date(+new Date(k.starts_at) - i.cutoff_hours * 36e5) : new Date(k.cutoff_at);
      if (cutoff <= new Date()) throw badRequest('That cutoff has already passed');
      const placeChanged = i.location !== undefined || i.venue_id !== undefined || i.online_link !== undefined;
      const venueId = i.venue_id === undefined ? k.venue_id : i.venue_id;
      if (i.venue_id && !(await c.query('SELECT 1 FROM venues WHERE id=$1', [i.venue_id])).rowCount) throw notFound('Venue');
      const location = i.location ?? k.location;
      if (k.delivery === 'in_person' && !venueId && !location) throw badRequest('Choose a venue or say where the class is');
      await c.query(
        `UPDATE coach_classes SET title=$2, notes=$3, location=$4, venue_id=$5, online_link_enc=coalesce($6, online_link_enc), min_participants=$7, max_participants=$8, cutoff_at=$9, row_version=row_version+1, updated_at=now() WHERE id=$1`,
        [k.id, i.title ?? k.title, i.notes === undefined ? k.notes : i.notes, location, venueId, i.online_link ? encrypt(i.online_link, 'coach_classes.online_link') : null, min, max, cutoff]);
      const next = { ...k, max_participants: max, min_participants: min, row_version: k.row_version + 1 };
      if (placeChanged) for (const s of (await c.query("SELECT * FROM coach_class_seats WHERE class_id=$1 AND status IN ('held','confirmed','waitlisted')", [k.id])).rows) {
        await notifySeat(c, s, next, { kind: 'coach_class_changed', title: 'Class details changed', body: `"${next.title}" has a new place or link. Open the app to check it still works for you.`, key: `cc_changed:${k.id}:${next.row_version}:${s.id}` });
      }
      if (max > k.max_participants) await promoteWaitlist(c, next);
    });
    return loadView(i.id);
  },
});

cap({
  name: 'cancel_coach_class', method: 'POST', path: '/coach/classes/:id/cancel', tag: TAG, auth: COACH,
  summary: 'Call a class off. Every seat holder is told, paid seats are refunded in full through canonical payments, and unpaid holds and the waitlist simply end. Safe to repeat.',
  input: z.object({ id, reason: z.string().trim().max(200).optional() }),
  async handler({ user }, i) {
    const out = await tx(async (c) => {
      const k = await ownClass(c, user, i.id);
      if (k.status === 'cancelled') return { replay: true };
      if (k.status !== 'scheduled') throw conflict('This class is already over');
      const court = (await c.query("SELECT l.reservation_id FROM session_venue_links l JOIN bookings b ON b.id=l.booking_id AND b.status='confirmed' WHERE l.session_type='coach_class' AND l.session_id=$1 AND l.released_at IS NULL LIMIT 1", [k.id])).rows[0];
      const seats = await cancelClassTx(c, k, { by: k.coach_id === user.id ? 'coach' : 'admin', reason: i.reason });
      return { seats: seats.length, refunds: seats.filter((s) => s.payment_status === 'refund_due').length, ...(court ? { venue_booking_still_active: { reservation_id: court.reservation_id }, note: 'The court booking is still active. Cancel it with cancel_reservation if you no longer need it.' } : {}) };
    });
    const refunded = await processRefunds(i.id);
    return { ok: true, status: 'cancelled', ...out, refunded_now: refunded };
  },
});

cap({
  name: 'list_my_coach_classes', method: 'GET', path: '/coach/classes', tag: TAG, auth: COACH,
  summary: 'Classes you run, soonest first, with seat counts. `when`: upcoming (default), past, all.',
  input: z.object({ when: z.enum(['upcoming', 'past', 'all']).default('upcoming'), ...page }),
  async handler({ user }, i) {
    const rows = await many(`${BASE} WHERE k.coach_id=$1 AND ($2::text='all' OR ($2::text='upcoming' AND (k.starts_at + make_interval(mins => k.duration_min) > now()) AND k.status='scheduled') OR ($2::text='past' AND (k.status<>'scheduled' OR k.starts_at + make_interval(mins => k.duration_min) <= now())))
      ORDER BY extract(epoch FROM k.starts_at) * CASE WHEN $2::text='past' THEN -1 ELSE 1 END, k.id LIMIT $3 OFFSET $4`, [user.id, i.when, i.limit, i.offset]);
    return rows.map((r) => classView(r));
  },
});

// ---------------------------------------------------------------- discovery

const esc = (x) => (x ? x.replace(/[%_\\]/g, '\\$&') : null);

cap({
  name: 'list_coach_classes', method: 'GET', path: '/coach-classes', tag: TAG, auth: 'public',
  summary: 'Find coach-led group classes to join: filter by sport, coach, dates, delivery, city, price and free seats. Shows seat counts only (never who is in a class). Cancelled classes are not listed.',
  input: z.object({
    sport: z.string().optional(), coach_id: id.optional(), q: z.string().max(80).optional(), from: dt.optional(), to: dt.optional(), delivery: z.enum(['in_person', 'online']).optional(), city: z.string().max(80).optional(),
    max_price_cents: z.coerce.number().int().min(0).optional(), free_only: z.coerce.boolean().optional(), has_seats: z.coerce.boolean().optional(), ...page,
  }),
  async handler(_, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) return [];
    const rows = await many(
      `SELECT * FROM (${BASE} WHERE k.status='scheduled' AND ${NOT_YOUTH_SQL} AND k.starts_at > coalesce($6::timestamptz, now())
          AND ($1::uuid IS NULL OR k.sport_id=$1) AND ($2::uuid IS NULL OR k.coach_id=$2)
          AND ($3::text IS NULL OR k.title ILIKE '%'||$3||'%' OR u.display_name ILIKE '%'||$3||'%')
          AND ($4::text IS NULL OR v.city ILIKE $4) AND ($5::text IS NULL OR k.delivery=$5)
          AND ($7::timestamptz IS NULL OR k.starts_at < $7) AND ($8::bigint IS NULL OR k.price_cents <= $8) AND (NOT $9 OR k.price_cents = 0)) q
        WHERE (NOT $10 OR q.taken < q.max_participants) ORDER BY q.starts_at, q.id LIMIT $11 OFFSET $12`,
      [sport?.id ?? null, i.coach_id ?? null, esc(i.q), esc(i.city), i.delivery ?? null, i.from ?? null, i.to ?? null, i.max_price_cents ?? null, !!i.free_only, !!i.has_seats, i.limit, i.offset]);
    return rows.map((r) => classView(r));
  },
});

cap({
  name: 'get_coach_class', method: 'GET', path: '/coach-classes/:id', tag: TAG, auth: 'public',
  summary: 'One class with its seat counts. If you are signed in you also get your own seats (and those of young people you look after) and, once you hold a confirmed seat, the online link. The coach also gets the roster (audit-logged). Nobody else sees who is in a class.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one(`${BASE} WHERE k.id=$1`, [i.id]);
    if (!r) throw notFound('Class');
    const mine = user ? await many(`SELECT s.*, u.display_name AS for_name FROM coach_class_seats s JOIN users u ON u.id=s.user_id WHERE s.class_id=$1 AND ${MINE_SQL('$2')} ORDER BY s.created_at`, [i.id, user.id]) : [];
    const isCoach = !!user && (user.id === r.coach_id || isAdmin(user));
    if (r.status !== 'scheduled' && !isCoach && !mine.length) throw notFound('Class');
    const out = classView(r, { my_seats: [] });
    for (const s of mine) out.my_seats.push(seatView(s, { for_user: s.user_id === user.id ? null : { id: s.user_id, display_name: s.for_name }, position: await waitPosition(pool, s) }));
    if (r.online_link_enc && (isCoach || mine.some((s) => s.status === 'confirmed'))) out.online_link = decrypt(r.online_link_enc, 'coach_classes.online_link');
    if (isCoach) {
      await audit(null, user.id, 'read_class_roster', 'coach_classes', r.id);
      out.roster = await many(
        `SELECT s.id AS seat_id, s.status, s.payment_status, s.attendance, s.queued_at, s.price_cents, ${PUBLIC_USER}
           FROM coach_class_seats s JOIN users u ON u.id=s.user_id WHERE s.class_id=$1 AND s.status IN ('held','confirmed','waitlisted') ORDER BY s.status = 'waitlisted', s.queued_at, s.id`, [r.id]);
      out.pending_refunds = Number((await one("SELECT count(*) AS n FROM coach_class_seats WHERE class_id=$1 AND payment_status='refund_due'", [r.id])).n);
    }
    return out;
  },
});

// ---------------------------------------------------------------- athlete: join, leave, my seats

cap({
  name: 'join_coach_class', method: 'POST', path: '/coach-classes/:id/join', tag: TAG, status: 201,
  summary: 'Take a seat. A free class confirms you at once; a paid one holds your seat for a few minutes — pay it with create_payment (purpose_type coach_class_seat, purpose_id = the returned seat_id). A full class puts you on the waitlist and promotes you in order, with the same payment window. A guardian can join for a young person with on_behalf_of; a young person asking for themselves waits for a guardian. Safe to repeat: a retry replays your seat.',
  input: z.object({ id, on_behalf_of: id.optional(), idempotency_key: z.string().min(8).max(80).optional() }),
  async handler({ user }, i) {
    const subject = i.on_behalf_of ?? user.id;
    const out = await tx(async (c) => {
      const k = await lockClass(c, i.id);
      if (!k) throw notFound('Class');
      if (subject !== user.id) await requireGuardian(user, subject, c);
      if (subject === k.coach_id) throw badRequest('You are running this class');
      const prior = (await c.query('SELECT * FROM coach_class_seats WHERE class_id=$1 AND user_id=$2 FOR UPDATE', [k.id, subject])).rows[0];
      if (k.status !== 'scheduled' && !prior) throw notFound('Class');   // a called-off class is not visible to people who never held a seat
      if (prior && LIVE.includes(prior.status)) return seatView(prior, { replayed: true, position: await waitPosition(c, prior) });
      if (k.status !== 'scheduled') throw conflict('This class has been cancelled', { code: 'class_closed' });
      if (new Date(k.starts_at) <= new Date()) throw conflict('This class has already started', { code: 'class_started' });
      if (prior?.status === 'removed') throw conflict('The coach removed you from this class', { code: 'removed' });
      if (prior?.payment_status === 'refund_due') throw conflict('Your refund for this class is still being processed. Try again shortly.', { code: 'refund_pending' });
      if (prior?.payment_status === 'paid') throw conflict('You cancelled this seat after the cutoff, so it cannot be re-booked', { code: 'forfeited' });
      const { youth } = await assertCanJoin(c, k, subject, user);
      const fields = [k.id, subject, subject === user.id ? null : user.id, i.idempotency_key ?? null];
      let s = prior
        ? (await c.query("UPDATE coach_class_seats SET status='waitlisted', applied_by=$3, idempotency_key=$4, payment_status='not_required', pay_by=NULL, attendance=NULL, attendance_by=NULL, late_cancel=false, cancelled_at=NULL, queued_at=now(), updated_at=now() WHERE class_id=$1 AND user_id=$2 RETURNING *", fields)).rows[0]
        : (await c.query("INSERT INTO coach_class_seats(class_id, user_id, applied_by, idempotency_key, status, price_cents) VALUES ($1,$2,$3,$4,'waitlisted',$5) RETURNING *", [...fields, k.price_cents])).rows[0];
      if (youth && subject === user.id) { // a young person asking for themselves: their guardians decide first
        const guardians = await guardiansOf(subject, c);
        if (!guardians.length) throw conflict('A verified guardian must be linked to your account before you can join classes', { code: 'guardian_required' });
        s = (await c.query("UPDATE coach_class_seats SET status='guardian_pending' WHERE id=$1 RETURNING *", [s.id])).rows[0];
        for (const g of guardians) await notify(c, g, { kind: 'coach_class_guardian_request', title: 'Approve a class?', body: `A young person you look after asked to join "${k.title}". Open the app to approve or decline.`, data: { class_id: k.id, seat_id: s.id }, dedupe_key: `cc_guardian:${s.id}:${g}:${new Date(s.updated_at).getTime()}` });
        return seatView(s);
      }
      if (youth) await requireConsent(subject, 'participation', 'taking part in a class', c);
      s = await placeSeat(c, k, s);
      await notifySeat(c, s, k, s.status === 'confirmed'
        ? { kind: 'coach_class_confirmed', title: 'You are in!', body: `Your seat in "${k.title}" is confirmed.`, key: `cc_self:${s.id}:confirmed` }
        : s.status === 'held'
          ? { kind: 'coach_class_held', title: 'Seat held — pay to keep it', body: `Your seat in "${k.title}" is held for ${payWindowMin()} minutes. Pay to confirm it.`, key: `cc_self:${s.id}:held:${new Date(s.updated_at).getTime()}` }
          : { kind: 'coach_class_waitlisted', title: 'You are on the waitlist', body: `"${k.title}" is full. You move up automatically if a seat frees.`, key: `cc_self:${s.id}:waitlisted:${new Date(s.updated_at).getTime()}` });
      return seatView(s, { position: await waitPosition(c, s) });
    });
    return out;
  },
});

cap({
  name: 'leave_coach_class', method: 'POST', path: '/coach-classes/:id/leave', tag: TAG,
  summary: 'Give up your seat (or a young person\'s, as their guardian), your place on the waitlist or an unpaid hold. A paid seat is refunded in full if you leave before the class cutoff; after it the seat is not refunded. The oldest person on the waitlist is promoted. Safe to repeat.',
  input: z.object({ id, on_behalf_of: id.optional() }),
  async handler({ user }, i) {
    const subject = i.on_behalf_of ?? user.id;
    const out = await tx(async (c) => {
      const k = await lockClass(c, i.id);
      if (!k) throw notFound('Class');
      if (subject !== user.id) await requireGuardian(user, subject, c);
      const s = (await c.query('SELECT * FROM coach_class_seats WHERE class_id=$1 AND user_id=$2 FOR UPDATE', [k.id, subject])).rows[0];
      if (!s) throw notFound('Seat in this class');
      if (!LIVE.includes(s.status)) return seatView(s, { replayed: true });
      const wasSeat = s.status === 'held' || s.status === 'confirmed';
      const beforeCutoff = new Date() < new Date(k.cutoff_at);
      const row = (await c.query(
        `UPDATE coach_class_seats SET status='cancelled', cancelled_at=now(), pay_by=NULL, updated_at=now(),
                late_cancel = $2, payment_status = CASE WHEN payment_status='paid' AND $3 THEN 'refund_due' ELSE payment_status END WHERE id=$1 RETURNING *`,
        [s.id, wasSeat && !beforeCutoff && k.status === 'scheduled', beforeCutoff || k.status !== 'scheduled'])).rows[0];
      if (wasSeat && k.status === 'scheduled') await promoteWaitlist(c, k);
      return seatView(row);
    });
    if (out.payment_status !== 'refund_due') return out;
    await processRefunds(i.id);   // refund after commit; the provider call is idempotent and the sweep retries anything left
    return seatView(await one('SELECT * FROM coach_class_seats WHERE id=$1', [out.seat_id]));
  },
});

cap({
  name: 'guardian_decide_coach_class_join', method: 'POST', path: '/coach-class-seats/:seat_id/guardian-decision', tag: TAG,
  summary: 'A guardian approves or declines a young person\'s request to join a class. Approving needs the guardian\'s current participation consent, then the seat is placed like any other (confirmed, held for payment, or waitlisted).',
  input: z.object({ seat_id: id, approve: z.boolean() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const pre = (await c.query('SELECT class_id, user_id FROM coach_class_seats WHERE id=$1', [i.seat_id])).rows[0];
      if (!pre) throw notFound('Request');
      await requireGuardian(user, pre.user_id, c);
      const k = await lockClass(c, pre.class_id);
      const s = (await c.query('SELECT * FROM coach_class_seats WHERE id=$1 FOR UPDATE', [i.seat_id])).rows[0];
      if (s.status !== 'guardian_pending') return seatView(s, { replayed: true });
      if (!i.approve) return seatView((await c.query("UPDATE coach_class_seats SET status='cancelled', cancelled_at=now(), updated_at=now() WHERE id=$1 RETURNING *", [s.id])).rows[0]);
      if (k.status !== 'scheduled' || new Date(k.starts_at) <= new Date()) throw conflict('This class is closed', { code: 'class_closed' });
      await requireConsent(s.user_id, 'participation', 'taking part in a class', c);
      const row = await placeSeat(c, k, (await c.query("UPDATE coach_class_seats SET applied_by=coalesce(applied_by, $2), queued_at=now() WHERE id=$1 RETURNING *", [s.id, user.id])).rows[0]);
      await notifySeat(c, row, k, { kind: row.status === 'confirmed' ? 'coach_class_confirmed' : row.status === 'held' ? 'coach_class_held' : 'coach_class_waitlisted', title: row.status === 'waitlisted' ? 'On the waitlist' : 'Class seat approved', body: row.status === 'held' ? `The seat in "${k.title}" is held for ${payWindowMin()} minutes. Pay to confirm it.` : row.status === 'confirmed' ? `The seat in "${k.title}" is confirmed.` : `"${k.title}" is full; the waitlist moves up automatically.`, key: `cc_guardian_ok:${row.id}:${row.status}` });
      return seatView(row, { position: await waitPosition(c, row) });
    });
  },
});

cap({
  name: 'list_my_coach_class_seats', method: 'GET', path: '/me/coach-classes', tag: TAG,
  summary: 'Your class seats and those of young people you look after, with the class, your seat status, what is owed and the payment deadline. `when`: upcoming (default), past, all.',
  input: z.object({ when: z.enum(['upcoming', 'past', 'all']).default('upcoming'), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT s.*, u.display_name AS for_name, k.id AS kid FROM coach_class_seats s JOIN coach_classes k ON k.id=s.class_id JOIN users u ON u.id=s.user_id
        WHERE ${MINE_SQL('$1')} AND ($2::text='all' OR ($2::text='upcoming' AND k.starts_at + make_interval(mins => k.duration_min) > now() AND s.status IN ('guardian_pending','waitlisted','held','confirmed')) OR ($2::text='past' AND NOT (k.starts_at + make_interval(mins => k.duration_min) > now() AND s.status IN ('guardian_pending','waitlisted','held','confirmed'))))
        ORDER BY k.starts_at, s.id LIMIT $3 OFFSET $4`, [user.id, i.when, i.limit, i.offset]);
    const out = [];
    for (const s of rows) out.push({ ...seatView(s, { position: await waitPosition(pool, s) }), for_user: s.user_id === user.id ? null : { id: s.user_id, display_name: s.for_name }, class: await loadView(s.kid) });
    return out;
  },
});

// ---------------------------------------------------------------- attendance

cap({
  name: 'mark_coach_class_attendance', method: 'POST', path: '/coach/classes/:id/attendance', tag: TAG, auth: COACH,
  summary: 'Record who attended and who did not show, once the class has started. Only confirmed seats can be marked. Idempotent. The record is mirrored into the coach\'s Performance Studio session for the class, so coaching evidence and visibility rules stay as they are.',
  input: z.object({ id, entries: z.array(z.object({ seat_id: id, attendance: z.enum(['attended', 'no_show']) })).min(1).max(200) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const k = await ownClass(c, user, i.id);
      if (k.status === 'cancelled') throw conflict('This class was cancelled');
      if (new Date(k.starts_at) > new Date()) throw conflict('The class has not started yet', { code: 'not_started' });
      for (const e of i.entries) {
        const s = (await c.query("SELECT * FROM coach_class_seats WHERE id=$1 AND class_id=$2 AND status='confirmed' FOR UPDATE", [e.seat_id, k.id])).rows[0];
        if (!s) throw notFound('Seat holder');
        if (s.attendance === e.attendance) continue;
        const row = (await c.query('UPDATE coach_class_seats SET attendance=$2, attendance_by=$3, updated_at=now() WHERE id=$1 RETURNING *', [s.id, e.attendance, user.id])).rows[0];
        if (e.attendance === 'no_show') await notifySeat(c, row, k, { kind: 'coach_class_no_show', title: 'Marked as not attended', body: `The coach recorded that you did not attend "${k.title}".`, key: `cc_noshow:${row.id}` });
      }
      await mirrorClassAttendance(c, k.id);
      return (await c.query("SELECT id AS seat_id, status, attendance FROM coach_class_seats WHERE class_id=$1 AND status='confirmed' ORDER BY queued_at, id", [k.id])).rows;
    });
  },
});
