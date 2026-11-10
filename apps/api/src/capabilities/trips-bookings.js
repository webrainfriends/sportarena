// Team & delegation travel (#485) + travel partner adapters (#704). Search, hold, book and cancel a flight or hotel through the organisation's connected
// travel partner (Integration Hub), or take rooms from an organiser's room block. The booking attaches to the trip's own itinerary / accommodation,
// reconciles into the trip cost summary (and optionally the event budget ledger) and keeps every partner change in an append-only history.
// This is integration, not a booking engine. Without a configured partner every call answers 409 travel_partner_not_configured and the typed
// references of the itinerary keep working. Personal data leaves the platform only for travellers who agreed, and a passport number never does.
import { z } from 'zod';
import { cap, id, money } from '../registry.js';
import { many, pool, tx } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { decrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { eventForOrganizer } from './events.js';
import { applyChange, bookingEvents } from '../travel/changes.js';
import { adapterFor, connectionByKey, connectionOfBooking, connectionsFor, publicConn } from '../travel/adapters.js';
import { LIVE_PARTICIPANT, assertOpen, audienceOf, isZone, localText, placeFields, record, stale, tripCtx } from '../trips.js';
import { costSummary } from '../trips-finance.js';
import { livePassengers, setPassengers, within } from './trips-logistics.js';
import { ledger } from './trips-money.js';

const TAG = 'Team travel';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dt = z.string().datetime({ offset: true });
const zone = z.string().min(1).max(64).refine(isZone, 'Not a valid IANA time zone, e.g. Asia/Kolkata');
const cur = z.string().regex(/^[A-Z]{3}$/);
const key = z.string().min(8).max(80);
const NOT_CONFIGURED = () => new AppError(409, 'travel_partner_not_configured', 'No travel partner serves this destination yet. Record the booking by hand (itinerary or accommodation), or ask the platform team to connect a partner for this region.');

const shape = (b, travellers = []) => ({ id: b.id, partner_label: b.partner_label ?? null, kind: b.kind, source: b.source, status: b.status, summary: b.summary, partner_ref: b.partner_ref, starts_at: b.starts_at, ends_at: b.ends_at, tz: b.tz, starts_local: localText(b.starts_at, b.tz), ends_local: localText(b.ends_at, b.tz),
  price_minor: Number(b.price_minor), currency: b.currency, rooms: b.rooms, terms: b.terms, cancel_by: b.cancel_by, segment_id: b.segment_id, stay_id: b.stay_id, room_block_id: b.room_block_id, budget_payment_id: b.budget_payment_id, row_version: b.row_version, traveller_ids: travellers,
  verified: b.source === 'partner' && ['booked', 'changed'].includes(b.status), created_at: b.created_at });

const loadBooking = async (c, trip, bookingId) => {
  const b = (await c.query('SELECT * FROM travel_bookings WHERE id=$1 AND trip_id=$2 FOR UPDATE', [bookingId, trip.id])).rows[0];
  if (!b) throw notFound('Booking');
  return b;
};

/** Everyone must have a live consent to share booking details with the partner (their own, or their verified guardian's for a young traveller). */
async function consented(c, trip, participantIds) {
  const pax = await livePassengers(c, trip, participantIds);
  const ok = new Set((await c.query('SELECT participant_id FROM trip_partner_consents WHERE trip_id=$1 AND revoked_at IS NULL AND participant_id = ANY($2::uuid[])', [trip.id, participantIds])).rows.map((r) => r.participant_id));
  const missing = participantIds.filter((p) => !ok.has(p));
  if (missing.length) throw new AppError(409, 'consent_required', 'Every traveller must agree to share their booking details with the travel partner first.', { participant_ids: missing });
  return pax;
}

cap({
  name: 'set_trip_partner_consent', method: 'POST', path: '/trips/:id/partner-consent', tag: TAG,
  summary: 'The traveller (or the verified guardian of a young traveller) agrees, or withdraws agreement, to share the minimum booking details (name, and date of birth for flights) with the travel partner for this trip. Staff cannot give it for someone else. Passport numbers are never shared. Withdrawing blocks new bookings; the history is kept.',
  input: z.object({ id, participant_id: id, granted: z.boolean() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      assertOpen(ctx.trip);
      const p = (await c.query('SELECT * FROM trip_participants WHERE id=$1 AND trip_id=$2 AND status = ANY($3)', [i.participant_id, ctx.trip.id, LIVE_PARTICIPANT])).rows[0];
      if (!p || !(ctx.mine?.id === p.id || ctx.wardIds.has(p.id))) throw p ? forbidden('Only the traveller, or a young traveller\'s verified guardian, can decide this') : notFound('Traveller');
      if (ctx.wardIds.has(p.id) && ctx.mine?.id !== p.id) { /* guardian acting for a ward: the live guardian link was already checked by tripCtx */ }
      if (i.granted) await c.query('INSERT INTO trip_partner_consents(trip_id, participant_id, granted_by) VALUES ($1,$2,$3) ON CONFLICT (participant_id) WHERE revoked_at IS NULL DO NOTHING', [ctx.trip.id, p.id, user.id]);
      else await c.query('UPDATE trip_partner_consents SET revoked_at=now() WHERE participant_id=$1 AND revoked_at IS NULL', [p.id]);
      await record(c, ctx.trip, user.id, { entity: 'consent', entityId: p.id, action: i.granted ? 'partner_share_granted' : 'partner_share_withdrawn', snapshot: { participant_id: p.id } });
      await audit(c, user.id, i.granted ? 'grant_travel_partner_consent' : 'withdraw_travel_partner_consent', 'trip_participants', p.id);
      return { participant_id: p.id, granted: i.granted };
    });
  },
});

cap({
  name: 'list_trip_bookings', method: 'GET', path: '/trips/:id/bookings', tag: TAG,
  summary: 'Partner and room-block bookings on the trip, whether a travel partner is connected (provider and live/sandbox mode, never credentials), who has agreed to share details, room blocks of the linked events with rooms left, and the booked cost per currency. Trip staff see everything; a traveller or guardian sees only bookings that include them.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await tripCtx(user, i.id);
    const partners = ctx.ops ? [...(await connectionsFor(pool, ctx.trip, { kind: 'stay' })), ...(await connectionsFor(pool, ctx.trip, { kind: 'air' }))].filter((x, n, a) => a.findIndex((y) => y.key === x.key) === n) : [];
    const mine = ctx.ops ? null : [ctx.mine?.id, ...ctx.wards.map((w) => w.id)].filter(Boolean);
    const rows = await many('SELECT b.*, COALESCE(array_agg(t.participant_id) FILTER (WHERE t.participant_id IS NOT NULL), \'{}\') AS pax FROM travel_bookings b LEFT JOIN travel_booking_travellers t ON t.booking_id=b.id WHERE b.trip_id=$1 GROUP BY b.id ORDER BY b.created_at DESC', [ctx.trip.id]);
    const visible = rows.filter((b) => !mine || b.pax.some((p) => mine.includes(p)));
    const blocks = ctx.ops ? await many(
      `SELECT k.*, k.rooms_total - COALESCE((SELECT sum(b.rooms) FROM travel_bookings b WHERE b.room_block_id=k.id AND b.status IN ('booked','changed')),0)::int AS rooms_left
         FROM event_room_blocks k WHERE k.archived_at IS NULL AND k.event_id IN (SELECT event_id FROM trip_events WHERE trip_id=$1 AND unlinked_at IS NULL) ORDER BY k.check_in_on`, [ctx.trip.id]) : [];
    const consents = ctx.ops ? (await many('SELECT participant_id FROM trip_partner_consents WHERE trip_id=$1 AND revoked_at IS NULL', [ctx.trip.id])).map((r) => r.participant_id)
      : (await many('SELECT participant_id FROM trip_partner_consents WHERE trip_id=$1 AND revoked_at IS NULL AND participant_id = ANY($2::uuid[])', [ctx.trip.id, mine])).map((r) => r.participant_id);
    return {
      partners: partners.map((x) => ({ ...publicConn(x), kinds: x.kinds })), partner_configured: partners.length > 0,
      bookings: visible.map((b) => shape(b, b.pax)), room_blocks: blocks.map((k) => ({ ...k, rate_minor: Number(k.rate_minor) })), consented_participant_ids: consents,
      costs: ctx.ops ? await costSummary(pool, ctx.trip) : [], can_manage: ctx.ops,
    };
  },
});

cap({
  name: 'get_trip_booking', method: 'GET', path: '/trips/:id/bookings/:booking_id', tag: TAG,
  summary: 'One booking with its append-only history of holds, bookings, changes and cancellations (including those made by the partner).',
  input: z.object({ id, booking_id: id }),
  async handler({ user }, i) {
    const ctx = await tripCtx(user, i.id);
    const b = (await pool.query('SELECT * FROM travel_bookings WHERE id=$1 AND trip_id=$2', [i.booking_id, ctx.trip.id])).rows[0];
    if (!b) throw notFound('Booking');
    const pax = (await pool.query('SELECT participant_id FROM travel_booking_travellers WHERE booking_id=$1', [b.id])).rows.map((r) => r.participant_id);
    const mine = [ctx.mine?.id, ...ctx.wards.map((w) => w.id)].filter(Boolean);
    if (!ctx.ops && !pax.some((p) => mine.includes(p))) throw notFound('Booking');
    return { ...shape(b, pax), history: await bookingEvents(b.id) };
  },
});

cap({
  name: 'search_trip_travel', method: 'POST', path: '/trips/:id/travel/search', tag: TAG,
  summary: 'Trip staff: search hotels (stay) or flights (air) across every travel partner that serves the destination (the organisation\'s own connection plus the platform\'s channel partners for that region) at once. Nothing is reserved. Offers come back cheapest first, each naming its partner; a partner that is down is reported in `partners` and never blocks the others. Flights need origin, destination and the zones of both ends; stays need a destination, dates and rooms. With no partner for the region this answers 409 travel_partner_not_configured and typed references remain.',
  input: z.object({
    id, kind: z.enum(['air', 'stay']), currency: cur.default('USD'),
    origin: z.string().trim().max(160).optional(), origin_tz: zone.optional(), destination: z.string().trim().min(1).max(160), destination_tz: zone.optional(), country: z.string().regex(/^[A-Z]{2}$/).optional(),
    depart_on: day.optional(), check_in_on: day.optional(), check_out_on: day.optional(), rooms: z.number().int().min(1).max(100).default(1), pax: z.number().int().min(1).max(300).default(1),
  }),
  async handler({ user }, i) {
    const ctx = await tripCtx(user, i.id);
    if (!ctx.ops) throw forbidden('Only trip staff can search travel');
    assertOpen(ctx.trip);
    if (i.kind === 'air' && !(i.origin && i.origin_tz && i.destination_tz && i.depart_on)) throw badRequest('Flights need an origin, a departure day and the time zone of both ends');
    if (i.kind === 'stay' && !(i.check_in_on && i.check_out_on)) throw badRequest('Stays need check-in and check-out days');
    if (i.kind === 'stay' && i.check_out_on <= i.check_in_on) throw badRequest('Check-out must be after check-in');
    const conns = await connectionsFor(pool, ctx.trip, { kind: i.kind, country: i.country ?? null });
    if (!conns.length) throw NOT_CONFIGURED();
    const q = { ...i, tz: i.destination_tz ?? ctx.trip.timezone };
    const results = await Promise.all(conns.map(async (cn) => {
      try { const a = await adapterFor(cn); if (!a) return { cn, error: 'not connected' }; return { cn, offers: await a.search(q) }; }
      catch (e) { return { cn, error: e.message }; }
    }));
    const offers = results.flatMap((r) => (r.offers ?? []).map((o) => ({ ...o, partner: publicConn(r.cn) }))).sort((a, b) => a.price_minor - b.price_minor);
    if (!offers.length && results.every((r) => r.error)) throw new AppError(503, 'travel_partner_unavailable', 'No travel partner could be reached right now. Record the booking by hand instead.');
    await audit(null, user.id, 'search_trip_travel', 'trips', ctx.trip.id);
    return { mode: conns.some((x) => x.mode === 'live') ? 'live' : 'sandbox', offers, partners: results.map((r) => ({ ...publicConn(r.cn), ok: !r.error, offers: r.offers?.length ?? 0, ...(r.error ? { error: r.error } : {}) })) };
  },
});

const OFFER = z.object({ summary: z.string().trim().min(1).max(300), property_name: z.string().trim().max(160).optional(), starts_at: dt, ends_at: dt, tz: zone, arrive_tz: zone.optional() });

cap({
  name: 'hold_trip_booking', method: 'POST', path: '/trips/:id/bookings', tag: TAG, status: 201,
  summary: 'Trip staff: hold an offer found by search_trip_travel for travellers who agreed to share their details. The partner\'s price and cancellation terms replace the search estimate. A planned leg or stay is added to the itinerary (marked partner, not yet booked) so the team sees it; book_trip_booking confirms it. Same idempotency_key returns the same booking.',
  input: z.object({ id, kind: z.enum(['air', 'stay']), partner_key: z.string().regex(/^(channel|install):[0-9a-f-]{36}$/).describe('the partner named on the offer'), offer_ref: z.string().min(1).max(500), offer: OFFER, origin: z.string().trim().max(160).optional(), ...placeFields('origin_'), destination: z.string().trim().min(1).max(160), ...placeFields('destination_'), rooms: z.number().int().min(1).max(100).optional(), traveller_ids: z.array(id).min(1).max(300), idempotency_key: key }),
  async handler({ user }, i) {
    const pre = await tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.ops) throw forbidden('Only trip staff can book travel');
      assertOpen(ctx.trip);
      const dup = (await c.query('SELECT * FROM travel_bookings WHERE trip_id=$1 AND idempotency_key=$2', [ctx.trip.id, i.idempotency_key])).rows[0];
      if (dup) return { dup };
      if (Date.parse(i.offer.ends_at) <= Date.parse(i.offer.starts_at)) throw badRequest('The offer ends before it starts');
      if (i.kind === 'air' && !(i.origin && i.offer.arrive_tz)) throw badRequest('A flight needs its origin and the arrival time zone');
      within(ctx.trip, i.offer.starts_at, i.offer.ends_at);
      const pax = await consented(c, ctx.trip, [...new Set(i.traveller_ids)]);
      const conn = await connectionByKey(c, ctx.trip, i.partner_key, { kind: i.kind, country: i.destination_country ?? null });
      if (!conn) throw NOT_CONFIGURED();
      const travellers = [];
      for (const p of pax) {                                               // the minimum the partner needs; a date of birth only for flights, and every read is audited
        const u = (await c.query('SELECT display_name, dob_enc FROM users WHERE id=$1', [p.user_id])).rows[0];
        const t = { name: u.display_name };
        if (i.kind === 'air' && u.dob_enc) { await audit(c, user.id, 'share_dob_with_travel_partner', 'users', p.user_id); t.date_of_birth = decrypt(u.dob_enc, 'users.dob'); }
        travellers.push(t);
      }
      return { trip: ctx.trip, conn, pax, travellers };
    });
    if (pre.dup) { const t = await many('SELECT participant_id FROM travel_booking_travellers WHERE booking_id=$1', [pre.dup.id]); return shape(pre.dup, t.map((r) => r.participant_id)); }
    const adapter = await adapterFor(pre.conn);
    if (!adapter) throw NOT_CONFIGURED();
    const held = await adapter.hold(i.offer_ref, { travellers: pre.travellers });          // outside the transaction: no lock is held across a network call
    const currency = held.currency ?? (held.offer?.currency) ?? i.currency ?? 'USD';
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      assertOpen(ctx.trip);
      const dup = (await c.query('SELECT * FROM travel_bookings WHERE trip_id=$1 AND idempotency_key=$2', [ctx.trip.id, i.idempotency_key])).rows[0];
      if (dup) return shape(dup, i.traveller_ids);
      const o = i.offer;
      let segmentId = null, stayId = null;
      if (i.kind === 'air') {
        segmentId = (await c.query(`INSERT INTO trip_segments(trip_id, mode, provider, reference, reference_source, origin, destination, depart_at, depart_tz, arrive_at, arrive_tz, status, created_by, origin_country, origin_lat, origin_lng, destination_country, destination_lat, destination_lng)
          VALUES ($1,'air',$2,$3,'partner',$4,$5,$6,$7,$8,$9,'planned',$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
          [ctx.trip.id, pre.conn.label, held.partner_ref, i.origin, i.destination, o.starts_at, o.tz, o.ends_at, o.arrive_tz, user.id, i.origin_country ?? null, i.origin_lat ?? null, i.origin_lng ?? null, i.destination_country ?? null, i.destination_lat ?? null, i.destination_lng ?? null])).rows[0].id;
        await setPassengers(c, segmentId, pre.pax.map((p) => p.id));
      } else {
        stayId = (await c.query(`INSERT INTO trip_stays(trip_id, property_name, reference, reference_source, check_in_at, check_out_at, tz, status, created_by, country, lat, lng)
          VALUES ($1,$2,$3,'partner',$4,$5,$6,'planned',$7,$8,$9,$10) RETURNING id`,
          [ctx.trip.id, o.property_name ?? i.destination, held.partner_ref, o.starts_at, o.ends_at, o.tz, user.id, i.destination_country ?? null, i.destination_lat ?? null, i.destination_lng ?? null])).rows[0].id;
      }
      const b = (await c.query(`INSERT INTO travel_bookings(trip_id, kind, source, install_id, channel_partner_id, partner_label, partner_ref, offer_ref, status, summary, starts_at, ends_at, tz, price_minor, currency, rooms, terms, cancel_by, segment_id, stay_id, idempotency_key, created_by)
        VALUES ($1,$2,'partner',$3,$19,$20,$4,$5,'held',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [ctx.trip.id, i.kind, pre.conn.scope === 'install' ? pre.conn.id : null, held.partner_ref, i.offer_ref.slice(0, 120), o.summary, o.starts_at, o.ends_at, o.tz, held.price_minor, currency, i.kind === 'stay' ? (i.rooms ?? 1) : null, held.terms ?? {}, held.cancel_by ?? held.terms?.free_cancel_until ?? null, segmentId, stayId, i.idempotency_key, user.id, pre.conn.scope === 'channel' ? pre.conn.id : null, pre.conn.label])).rows[0];
      for (const p of pre.pax) await c.query('INSERT INTO travel_booking_travellers(booking_id, participant_id) VALUES ($1,$2)', [b.id, p.id]);
      await c.query("INSERT INTO travel_booking_events(booking_id, actor, actor_id, action, detail) VALUES ($1,'user',$2,'held',$3)", [b.id, user.id, { price_minor: Number(b.price_minor), currency, terms: b.terms }]);
      await record(c, ctx.trip, user.id, { entity: 'travel_booking', entityId: b.id, action: 'held', version: 1, snapshot: { kind: b.kind, summary: b.summary, price_minor: Number(b.price_minor), currency }, affected: await audienceOf(c, ctx.trip, pre.pax.map((p) => p.id)),
        title: 'Travel held for you', body: `${ctx.trip.name}: ${b.summary}` });
      await audit(c, user.id, 'hold_trip_booking', 'travel_bookings', b.id);
      return shape(b, pre.pax.map((p) => p.id));
    });
  },
});

cap({
  name: 'book_trip_booking', method: 'POST', path: '/trips/:id/bookings/:booking_id/book', tag: TAG, scope: 'payment',
  summary: 'Trip manager: confirm a held booking with the partner. The linked leg or stay becomes booked, the price counts in the trip cost summary, and with budget_line_id (an expense line of a linked event you organise) it is also posted to the canonical event budget ledger.',
  input: z.object({ id, booking_id: id, row_version: z.number().int(), budget_line_id: id.optional() }),
  async handler({ user }, i) {
    const pre = await tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.manager) throw forbidden('Only the trip manager can confirm a booking');
      assertOpen(ctx.trip);
      const b = await loadBooking(c, ctx.trip, i.booking_id);
      stale(b, i.row_version);
      if (b.status !== 'held') throw conflict(`Only a held booking can be confirmed (this one is ${b.status})`);
      return { b, conn: await connectionOfBooking(c, b) };
    });
    const adapter = await adapterFor(pre.conn, { existing: true });
    if (!adapter) throw NOT_CONFIGURED();
    await adapter.book(pre.b.partner_ref, {});
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      const b0 = await loadBooking(c, ctx.trip, i.booking_id);
      if (b0.status !== 'held') return shape(b0);
      const led = await ledger(c, user, ctx.trip, i.budget_line_id, Number(b0.price_minor), b0.partner_ref, `Travel booking: ${b0.summary}`);
      const b = (await c.query("UPDATE travel_bookings SET status='booked', budget_payment_id=$2, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [b0.id, led.budget_payment_id])).rows[0];
      if (b.segment_id) await c.query("UPDATE trip_segments SET status='booked', row_version=row_version+1, updated_at=now() WHERE id=$1 AND status='planned'", [b.segment_id]);
      if (b.stay_id) await c.query("UPDATE trip_stays SET status='booked', row_version=row_version+1, updated_at=now() WHERE id=$1 AND status='planned'", [b.stay_id]);
      await c.query("INSERT INTO travel_booking_events(booking_id, actor, actor_id, action, detail) VALUES ($1,'user',$2,'booked',$3)", [b.id, user.id, { price_minor: Number(b.price_minor), currency: b.currency, ledger: led.source }]);
      const pax = (await c.query('SELECT participant_id FROM travel_booking_travellers WHERE booking_id=$1', [b.id])).rows.map((r) => r.participant_id);
      await record(c, ctx.trip, user.id, { entity: 'travel_booking', entityId: b.id, action: 'booked', version: b.row_version, snapshot: { kind: b.kind, summary: b.summary, price_minor: Number(b.price_minor), currency: b.currency },
        affected: await audienceOf(c, ctx.trip, pax), title: 'Your travel is booked', body: `${ctx.trip.name}: ${b.summary}` });
      await audit(c, user.id, 'book_trip_booking', 'travel_bookings', b.id);
      return shape(b, pax);
    });
  },
});

cap({
  name: 'cancel_trip_booking', method: 'POST', path: '/trips/:id/bookings/:booking_id/cancel', tag: TAG, scope: 'payment',
  summary: 'Trip manager: cancel a held or booked booking with the partner (or release room-block rooms). The booking, the leg or stay and the history are kept, marked cancelled, and the travellers and their guardians are told. Cancellation terms (refundable or not) are recorded as the partner gave them.',
  input: z.object({ id, booking_id: id, row_version: z.number().int(), reason: z.string().trim().min(2).max(300) }),
  async handler({ user }, i) {
    const pre = await tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.manager) throw forbidden('Only the trip manager can cancel a booking');
      const b = await loadBooking(c, ctx.trip, i.booking_id);
      stale(b, i.row_version);
      if (b.status === 'cancelled') throw conflict('That booking is already cancelled');
      return { b, conn: await connectionOfBooking(c, b) };
    });
    if (pre.b.source === 'partner') {
      const adapter = await adapterFor(pre.conn, { existing: true });
      if (!adapter) throw NOT_CONFIGURED();
      await adapter.cancel(pre.b.partner_ref);
    }
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      const b0 = await loadBooking(c, ctx.trip, i.booking_id);
      if (b0.status === 'cancelled') return shape(b0);
      const b = await applyChange(c, ctx.trip, b0, { actor: 'user', actorId: user.id, action: 'cancelled', note: i.reason });
      await audit(c, user.id, 'cancel_trip_booking', 'travel_bookings', b.id);
      return shape(b);
    });
  },
});

// ---------------------------------------------------------------- organiser room blocks (stay-to-play)

const BLOCK = z.object({
  property_name: z.string().trim().min(1).max(160), address: z.string().trim().max(300).optional(), country: z.string().regex(/^[A-Z]{2}$/).optional(),
  check_in_on: day, check_out_on: day, rooms_total: z.number().int().min(1).max(2000), rate_minor: money, currency: cur, cut_off_on: day.optional(), terms: z.string().trim().max(1000).optional(), reference: z.string().trim().max(80).optional(),
});

cap({
  name: 'create_event_room_block', method: 'POST', path: '/events/:event_id/room-blocks', tag: TAG, status: 201,
  summary: 'Event organiser: publish a room block (stay-to-play) for the event with the property, dates, number of rooms, nightly rate, cut-off date and terms. Teams linked to the event can take rooms from it; GotMyGame records and allocates, the contract stays between the organiser and the hotel.',
  input: z.object({ event_id: id, ...BLOCK.shape }),
  async handler({ user }, i) {
    await eventForOrganizer(user, i.event_id, pool);
    if (i.check_out_on <= i.check_in_on) throw badRequest('Check-out must be after check-in');
    const { event_id, ...b } = i;
    const r = (await pool.query(`INSERT INTO event_room_blocks(event_id, property_name, address, country, check_in_on, check_out_on, rooms_total, rate_minor, currency, cut_off_on, terms, reference, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [event_id, b.property_name, b.address ?? null, b.country ?? null, b.check_in_on, b.check_out_on, b.rooms_total, b.rate_minor, b.currency, b.cut_off_on ?? null, b.terms ?? null, b.reference ?? null, user.id])).rows[0];
    return { ...r, rate_minor: Number(r.rate_minor), rooms_left: r.rooms_total };
  },
});

cap({
  name: 'list_event_room_blocks', method: 'GET', path: '/events/:event_id/room-blocks', tag: TAG,
  summary: 'Event organiser: the event\'s room blocks with rooms left.',
  input: z.object({ event_id: id }),
  async handler({ user }, i) {
    await eventForOrganizer(user, i.event_id, pool);
    return (await many(`SELECT k.*, k.rooms_total - COALESCE((SELECT sum(b.rooms) FROM travel_bookings b WHERE b.room_block_id=k.id AND b.status IN ('booked','changed')),0)::int AS rooms_left
      FROM event_room_blocks k WHERE k.event_id=$1 AND k.archived_at IS NULL ORDER BY k.check_in_on`, [i.event_id])).map((k) => ({ ...k, rate_minor: Number(k.rate_minor) }));
  },
});

cap({
  name: 'archive_event_room_block', method: 'POST', path: '/events/:event_id/room-blocks/:block_id/archive', tag: TAG,
  summary: 'Event organiser: withdraw a room block from new bookings. Existing bookings and the block itself are kept.',
  input: z.object({ event_id: id, block_id: id }),
  async handler({ user }, i) {
    await eventForOrganizer(user, i.event_id, pool);
    const r = await pool.query('UPDATE event_room_blocks SET archived_at=now() WHERE id=$1 AND event_id=$2 AND archived_at IS NULL RETURNING id', [i.block_id, i.event_id]);
    if (!r.rowCount) throw notFound('Room block');
    return { ok: true };
  },
});

cap({
  name: 'book_trip_room_block', method: 'POST', path: '/trips/:id/bookings/room-block', tag: TAG, status: 201, scope: 'payment',
  summary: 'Trip manager: take rooms from an organiser\'s room block of an event the trip is linked to, for travellers who agreed. Rooms are counted under a lock so the block is never over-booked; the stay is added with the organiser\'s dates and the cost joins the trip cost summary (and the event ledger with budget_line_id). The cut-off date is enforced.',
  input: z.object({ id, room_block_id: id, rooms: z.number().int().min(1).max(100), traveller_ids: z.array(id).min(1).max(300), tz: zone.optional(), budget_line_id: id.optional(), idempotency_key: key }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.manager) throw forbidden('Only the trip manager can take rooms');
      assertOpen(ctx.trip);
      const dup = (await c.query('SELECT * FROM travel_bookings WHERE trip_id=$1 AND idempotency_key=$2', [ctx.trip.id, i.idempotency_key])).rows[0];
      if (dup) return shape(dup, i.traveller_ids);
      const k = (await c.query('SELECT * FROM event_room_blocks WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [i.room_block_id])).rows[0];
      if (!k || !(await c.query('SELECT 1 FROM trip_events WHERE trip_id=$1 AND event_id=$2 AND unlinked_at IS NULL', [ctx.trip.id, k.event_id])).rowCount) throw notFound('Room block');
      if (k.cut_off_on && new Date(k.cut_off_on).toISOString().slice(0, 10) < new Date().toISOString().slice(0, 10)) throw conflict('The cut-off date for this room block has passed');
      const taken = Number((await c.query("SELECT COALESCE(sum(rooms),0) AS n FROM travel_bookings WHERE room_block_id=$1 AND status IN ('booked','changed')", [k.id])).rows[0].n);
      if (taken + i.rooms > k.rooms_total) throw new AppError(409, 'room_block_full', `Only ${k.rooms_total - taken} room(s) are left in this block`, { rooms_left: k.rooms_total - taken });
      const pax = await consented(c, ctx.trip, [...new Set(i.traveller_ids)]);
      const tz = i.tz ?? ctx.trip.timezone;
      const inAt = new Date(`${k.check_in_on.toISOString?.().slice(0, 10) ?? k.check_in_on}T14:00:00Z`).toISOString(), outAt = new Date(`${k.check_out_on.toISOString?.().slice(0, 10) ?? k.check_out_on}T11:00:00Z`).toISOString();
      within(ctx.trip, inAt, outAt);
      const nights = Math.round((Date.parse(outAt) - Date.parse(inAt)) / 864e5);
      const price = Number(k.rate_minor) * i.rooms * Math.max(1, nights);
      const stay = (await c.query(`INSERT INTO trip_stays(trip_id, property_name, address, reference, reference_source, check_in_at, check_out_at, tz, status, created_by, country)
        VALUES ($1,$2,$3,$4,'room_block',$5,$6,$7,'booked',$8,$9) RETURNING id`, [ctx.trip.id, k.property_name, k.address, k.reference, inAt, outAt, tz, user.id, k.country])).rows[0];
      const led = await ledger(c, user, ctx.trip, i.budget_line_id, price, k.reference, `Room block: ${k.property_name}`);
      const b = (await c.query(`INSERT INTO travel_bookings(trip_id, kind, source, room_block_id, status, summary, starts_at, ends_at, tz, price_minor, currency, rooms, terms, cancel_by, stay_id, budget_payment_id, idempotency_key, created_by)
        VALUES ($1,'stay','room_block',$2,'booked',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [ctx.trip.id, k.id, `${k.property_name}: ${i.rooms} room(s) from the event block`, inAt, outAt, tz, price, k.currency, i.rooms, { refundable: null, note: k.terms ?? 'Terms are set by the event organiser.' }, k.cut_off_on, stay.id, led.budget_payment_id, i.idempotency_key, user.id])).rows[0];
      for (const p of pax) await c.query('INSERT INTO travel_booking_travellers(booking_id, participant_id) VALUES ($1,$2)', [b.id, p.id]);
      await c.query("INSERT INTO travel_booking_events(booking_id, actor, actor_id, action, detail) VALUES ($1,'user',$2,'booked',$3)", [b.id, user.id, { room_block_id: k.id, rooms: i.rooms, price_minor: price }]);
      await record(c, ctx.trip, user.id, { entity: 'room_block', entityId: b.id, action: 'booked', version: 1, snapshot: { property_name: k.property_name, rooms: i.rooms, price_minor: price, currency: k.currency }, affected: await audienceOf(c, ctx.trip, pax.map((p) => p.id)),
        title: 'Your accommodation was booked', body: `${ctx.trip.name}: ${k.property_name}` });
      return shape(b, pax.map((p) => p.id));
    });
  },
});
