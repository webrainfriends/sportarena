// Team & delegation travel operations (#485), part 3: transport segments, accommodation and rooming, equipment consignments and the link to
// supplier orders (#458). Every booking reference is labelled for what it is: typed by the team (external) or taken from a supplier order. SportArena
// has no airline or hotel inventory adapter, so nothing here is ever "verified" or implies live availability.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, pool, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { buyerAccess } from '../svc/access.js';
import { YOUTH_SQL, guardianLink } from '../youth.js';
import { LIVE_PARTICIPANT, assertOpen, assertPoint, placeFields, assertZoneMatches, audienceOf, isZone, localText, record, stale, tripCtx, youthIdsAmong } from '../trips.js';

const TAG = 'Team travel';
const dt = z.string().datetime({ offset: true });
const zone = z.string().min(1).max(64).refine(isZone, 'Not a valid IANA time zone, e.g. Asia/Kolkata');
const DAY = 864e5;

export const referenceLabel = (r) => (r.reference_source === 'supplier_order'
  ? { source: 'supplier_order', verified: false, label: `Supplier order ${r.order_number ?? ''}${r.travel_confirmation === 'supplier_booking_confirmed' ? ': the supplier confirmed the booking' : r.travel_confirmation === 'third_party_reference_recorded' ? ': third-party reference recorded by the supplier' : ''}. Not a live availability check.`.replace(' :', ':') }
  : { source: 'external', verified: false, label: r.reference ? 'Reference typed by the team or taken from the provider. SportArena has not verified it.' : 'No reference recorded yet.' });

/** An accepted supplier order for travel/accommodation that the caller may act on as a buyer. The order itself is never copied. */
async function orderFor(c, user, orderId, category = null) {
  const o = (await c.query(
    `SELECT o.*, r.scope->>'category' AS category FROM svc_orders o LEFT JOIN svc_rfqs r ON r.id=o.rfq_id WHERE o.id=$1`, [orderId])).rows[0];
  if (!o) throw notFound('Supplier order');
  await buyerAccess(user, o.buyer_id, null, c);
  if (!['confirmed', 'in_progress', 'completed'].includes(o.status)) throw conflict('Only an order the supplier has confirmed can feed the itinerary');
  if (category && o.category !== category) throw badRequest(`That order is not a ${category} order`);
  return o;
}

const within = (trip, a, b) => { if (Date.parse(a) < Date.parse(trip.depart_at) - 2 * DAY || Date.parse(b) > Date.parse(trip.return_at) + 2 * DAY) throw badRequest('That falls outside the trip window (two days of slack are allowed). Change the trip dates first.'); };

const livePassengers = async (c, trip, ids) => {
  if (!ids.length) return [];
  const rows = (await c.query('SELECT id, user_id FROM trip_participants WHERE trip_id=$1 AND status = ANY($2) AND id = ANY($3::uuid[])', [trip.id, LIVE_PARTICIPANT, ids])).rows;
  if (rows.length !== new Set(ids).size) throw badRequest('Everyone on a segment must be a current traveller on this trip');
  return rows;
};
const setPassengers = async (c, segId, ids) => {
  await c.query('UPDATE trip_segment_passengers SET removed_at=now() WHERE segment_id=$1 AND removed_at IS NULL AND NOT (participant_id = ANY($2::uuid[]))', [segId, ids]);
  for (const p of ids) await c.query('INSERT INTO trip_segment_passengers(segment_id, participant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [segId, p]);
};
const segShape = (s, ctx, pax) => ({
  id: s.id, mode: s.mode, mode_label: s.mode_label, provider: s.provider, reference: s.reference, reference_info: referenceLabel(s), origin: s.origin, origin_country: s.origin_country, origin_lat: s.origin_lat, origin_lng: s.origin_lng, destination: s.destination, destination_country: s.destination_country, destination_lat: s.destination_lat, destination_lng: s.destination_lng,
  depart_at: s.depart_at, depart_tz: s.depart_tz, depart_local: localText(s.depart_at, s.depart_tz), arrive_at: s.arrive_at, arrive_tz: s.arrive_tz, arrive_local: localText(s.arrive_at, s.arrive_tz),
  meeting_point: s.meeting_point, baggage_ref: s.baggage_ref, status: s.status, svc_order_id: s.svc_order_id, note: s.note, row_version: s.row_version, passengers: pax,
});

const SEG = z.object({
  mode: z.enum(['air', 'rail', 'coach', 'car', 'ferry', 'local_transfer', 'other']), mode_label: z.string().trim().max(60).optional(), provider: z.string().trim().max(120).optional(), reference: z.string().trim().max(80).optional(),
  origin: z.string().trim().min(1).max(160), ...placeFields('origin_'), destination: z.string().trim().min(1).max(160), ...placeFields('destination_'), depart_at: dt, depart_tz: zone, arrive_at: dt, arrive_tz: zone,
  meeting_point: z.string().trim().max(200).optional(), baggage_ref: z.string().trim().max(120).optional(), status: z.enum(['planned', 'booked', 'delayed', 'cancelled', 'completed']),
  svc_order_id: id.optional().describe('an accepted supplier order (#458) that provides this leg'), note: z.string().trim().max(500).optional(), passenger_ids: z.array(id).max(300),
});
const SEG_FIELDS = SEG.partial({ mode_label: true, provider: true, reference: true, meeting_point: true, baggage_ref: true, status: true, svc_order_id: true, note: true, passenger_ids: true });

function checkSegment(trip, s) {
  assertPoint(s, 'origin_'); assertPoint(s, 'destination_');
  assertZoneMatches(s.depart_at, s.depart_tz, 'Departure'); assertZoneMatches(s.arrive_at, s.arrive_tz, 'Arrival');
  if (Date.parse(s.arrive_at) <= Date.parse(s.depart_at)) throw badRequest('Arrival must be after departure, compared as real instants (not clock times)');
  if (s.mode === 'other' && !s.mode_label) throw badRequest('Name the mode of transport');
  within(trip, s.depart_at, s.arrive_at);
}

cap({
  name: 'add_trip_segment', method: 'POST', path: '/trips/:id/segments', tag: TAG, status: 201,
  summary: 'Trip staff: add a transport leg (air, rail, coach, car, ferry, local transfer or other). Times carry their own UTC offset and IANA zone and are checked against each other; the reference is labelled external unless it comes from a supplier order. Assign the travellers on it.',
  input: z.object({ id, ...SEG_FIELDS.shape, status: SEG.shape.status.default('planned'), passenger_ids: SEG.shape.passenger_ids.default([]) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.ops) throw forbidden('Only trip staff can edit the itinerary');
      assertOpen(ctx.trip); checkSegment(ctx.trip, i);
      let ref = i.reference ?? null, src = 'external';
      if (i.svc_order_id) { const o = await orderFor(c, user, i.svc_order_id, 'travel'); src = 'supplier_order'; ref = ref ?? o.third_party_ref ?? o.number; }
      const pax = await livePassengers(c, ctx.trip, i.passenger_ids);
      const s = (await c.query(
        `INSERT INTO trip_segments(trip_id, mode, mode_label, provider, reference, reference_source, origin, destination, depart_at, depart_tz, arrive_at, arrive_tz, meeting_point, baggage_ref, status, svc_order_id, note, created_by, origin_country, origin_lat, origin_lng, destination_country, destination_lat, destination_lng)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
        [ctx.trip.id, i.mode, i.mode_label ?? null, i.provider ?? null, ref, src, i.origin, i.destination, i.depart_at, i.depart_tz, i.arrive_at, i.arrive_tz, i.meeting_point ?? null, i.baggage_ref ?? null, i.status, i.svc_order_id ?? null, i.note ?? null, user.id, i.origin_country ?? null, i.origin_lat ?? null, i.origin_lng ?? null, i.destination_country ?? null, i.destination_lat ?? null, i.destination_lng ?? null])).rows[0];
      await setPassengers(c, s.id, pax.map((p) => p.id));
      await record(c, ctx.trip, user.id, { entity: 'segment', entityId: s.id, action: 'added', version: 1, snapshot: { mode: s.mode, origin: s.origin, destination: s.destination, depart_at: s.depart_at, status: s.status }, affected: await audienceOf(c, ctx.trip, pax.map((p) => p.id)),
        title: 'A leg was added to your itinerary', body: `${ctx.trip.name}: ${s.origin} → ${s.destination}, ${localText(s.depart_at, s.depart_tz)}` });
      return segShape(s, ctx, pax.length);
    });
  },
});

cap({
  name: 'update_trip_segment', method: 'PATCH', path: '/trips/:id/segments/:segment_id', tag: TAG,
  summary: 'Trip staff: change a leg (times, provider, reference, status delayed / cancelled, passengers) with the current row_version and a change note. The previous version stays in the history and only the travellers on that leg, their guardians and the manager are told. A fixture is never edited from here.',
  input: z.object({ id, segment_id: id, row_version: z.number().int(), change_note: z.string().trim().min(2).max(500), ...SEG.partial().shape }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.ops) throw forbidden('Only trip staff can edit the itinerary');
      assertOpen(ctx.trip);
      const s0 = (await c.query('SELECT * FROM trip_segments WHERE id=$1 AND trip_id=$2 AND archived_at IS NULL FOR UPDATE', [i.segment_id, ctx.trip.id])).rows[0];
      if (!s0) throw notFound('Segment');
      stale(s0, i.row_version);
      const { id: _a, segment_id, row_version, change_note, passenger_ids, ...ch } = i;
      const next = { ...s0, ...Object.fromEntries(Object.entries(ch).filter(([, v]) => v !== undefined)) };
      for (const k of ['depart_at', 'arrive_at']) next[k] = new Date(next[k]).toISOString();
      // re-check the whole leg when any time or zone moved: the offset in the string must still match the zone
      if (ch.depart_at || ch.arrive_at || ch.depart_tz || ch.arrive_tz) {
        const dOff = ch.depart_at ?? null, aOff = ch.arrive_at ?? null;
        if ((dOff || ch.depart_tz) && !dOff) throw badRequest('Send the departure time again with its UTC offset when its zone changes');
        if ((aOff || ch.arrive_tz) && !aOff) throw badRequest('Send the arrival time again with its UTC offset when its zone changes');
        if (dOff) assertZoneMatches(dOff, next.depart_tz, 'Departure');
        if (aOff) assertZoneMatches(aOff, next.arrive_tz, 'Arrival');
        if (Date.parse(next.arrive_at) <= Date.parse(next.depart_at)) throw badRequest('Arrival must be after departure');
        within(ctx.trip, next.depart_at, next.arrive_at);
      }
      if (next.mode === 'other' && !next.mode_label) throw badRequest('Name the mode of transport');
      assertPoint(next, 'origin_'); assertPoint(next, 'destination_');
      let src = s0.reference_source;
      if (ch.svc_order_id) { const o = await orderFor(c, user, ch.svc_order_id, 'travel'); src = 'supplier_order'; if (ch.reference === undefined) next.reference = o.third_party_ref ?? o.number; }
      const cols = ['mode', 'mode_label', 'provider', 'reference', 'origin', 'origin_country', 'origin_lat', 'origin_lng', 'destination', 'destination_country', 'destination_lat', 'destination_lng', 'depart_at', 'depart_tz', 'arrive_at', 'arrive_tz', 'meeting_point', 'baggage_ref', 'status', 'svc_order_id', 'note'];
      const before = Object.fromEntries(cols.map((k) => [k, s0[k]])), after = Object.fromEntries(cols.map((k) => [k, next[k]]));
      const s = (await c.query(`UPDATE trip_segments SET ${cols.map((k, n) => `${k}=$${n + 2}`).join(', ')}, reference_source=$${cols.length + 2}, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`, [s0.id, ...cols.map((k) => next[k]), src])).rows[0];
      const oldPax = (await c.query('SELECT participant_id FROM trip_segment_passengers WHERE segment_id=$1 AND removed_at IS NULL', [s.id])).rows.map((r) => r.participant_id);
      let pax = oldPax;
      if (passenger_ids) { await livePassengers(c, ctx.trip, passenger_ids); await setPassengers(c, s.id, passenger_ids); pax = passenger_ids; }
      const people = [...new Set([...oldPax, ...pax])];
      const verb = s.status !== s0.status && ['delayed', 'cancelled'].includes(s.status) ? s.status : 'changed';
      await record(c, ctx.trip, user.id, { entity: 'segment', entityId: s.id, action: verb, version: s.row_version, snapshot: { before, after }, note: change_note, affected: await audienceOf(c, ctx.trip, people),
        title: verb === 'changed' ? 'Your itinerary changed' : `A leg is ${verb}`, body: `${ctx.trip.name}: ${s.origin} → ${s.destination}. ${change_note}` });
      return segShape(s, ctx, pax.length);
    });
  },
});

cap({
  name: 'get_trip_itinerary', method: 'GET', path: '/trips/:id/itinerary', tag: TAG,
  summary: 'The transport itinerary in order, each end shown in its own time zone. Trip staff see every leg and who is on it; a traveller (or guardian) sees only the legs they are on. Booking references are labelled external or supplier-order, never verified.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await tripCtx(user, i.id);
    const segs = await many(
      `SELECT s.*, o.number AS order_number, o.travel_confirmation FROM trip_segments s LEFT JOIN svc_orders o ON o.id=s.svc_order_id WHERE s.trip_id=$1 AND s.archived_at IS NULL ORDER BY s.depart_at, s.created_at`, [ctx.trip.id]);
    const pax = await many(`SELECT sp.segment_id, p.id AS participant_id, p.user_id, p.role, u.display_name FROM trip_segment_passengers sp JOIN trip_participants p ON p.id=sp.participant_id JOIN users u ON u.id=p.user_id WHERE sp.removed_at IS NULL AND sp.segment_id = ANY($1::uuid[])`, [segs.map((s) => s.id)]);
    const youth = new Set(await youthIdsAmong(pool, pax.map((p) => p.user_id)));
    const mine = new Set([ctx.mine?.id, ...ctx.wards.map((w) => w.id)].filter(Boolean));
    return segs.filter((s) => ctx.ops || pax.some((p) => p.segment_id === s.id && mine.has(p.participant_id))).map((s) => {
      const on = pax.filter((p) => p.segment_id === s.id);
      return { ...segShape(s, ctx, on.length), reference_info: referenceLabel(s), travellers: ctx.ops ? on.map((p) => ({ participant_id: p.participant_id, display_name: p.display_name, role: p.role, young: youth.has(p.user_id) })) : on.filter((p) => mine.has(p.participant_id)).map((p) => ({ participant_id: p.participant_id, display_name: p.display_name, role: p.role })) };
    });
  },
});

// ---------------------------------------------------------------- accommodation and rooming

const STAY = z.object({
  property_name: z.string().trim().min(1).max(160), address: z.string().trim().max(300).optional(), ...placeFields(''), reference: z.string().trim().max(80).optional(),
  check_in_at: dt, check_out_at: dt, tz: zone, status: z.enum(['planned', 'booked', 'changed', 'cancelled', 'completed']),
  svc_order_id: id.optional(), note: z.string().trim().max(500).optional(),
});
const stayShape = (s) => ({ ...s, check_in_local: localText(s.check_in_at, s.tz), check_out_local: localText(s.check_out_at, s.tz), reference_info: referenceLabel(s) });

cap({
  name: 'add_trip_stay', method: 'POST', path: '/trips/:id/stays', tag: TAG, status: 201,
  summary: 'Trip staff: add an accommodation booking (property, check-in / check-out in the property\'s zone, reference or accepted supplier order). The reference is labelled external unless it comes from a supplier order; it is not proof of live room availability.',
  input: z.object({ id, ...STAY.shape, status: STAY.shape.status.default('planned') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.ops) throw forbidden('Only trip staff can edit accommodation');
      assertOpen(ctx.trip);
      assertPoint(i, '');
      assertZoneMatches(i.check_in_at, i.tz, 'Check-in'); assertZoneMatches(i.check_out_at, i.tz, 'Check-out');
      if (Date.parse(i.check_out_at) <= Date.parse(i.check_in_at)) throw badRequest('Check-out must be after check-in');
      within(ctx.trip, i.check_in_at, i.check_out_at);
      let ref = i.reference ?? null, src = 'external';
      if (i.svc_order_id) { const o = await orderFor(c, user, i.svc_order_id, 'accommodation'); src = 'supplier_order'; ref = ref ?? o.third_party_ref ?? o.number; }
      const s = (await c.query('INSERT INTO trip_stays(trip_id, property_name, address, reference, reference_source, check_in_at, check_out_at, tz, status, svc_order_id, note, created_by, country, lat, lng) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *',
        [ctx.trip.id, i.property_name, i.address ?? null, ref, src, i.check_in_at, i.check_out_at, i.tz, i.status, i.svc_order_id ?? null, i.note ?? null, user.id, i.country ?? null, i.lat ?? null, i.lng ?? null])).rows[0];
      await record(c, ctx.trip, user.id, { entity: 'stay', entityId: s.id, action: 'added', version: 1, snapshot: { property_name: s.property_name, check_in_at: s.check_in_at, check_out_at: s.check_out_at } });
      return stayShape(s);
    });
  },
});

cap({
  name: 'update_trip_stay', method: 'PATCH', path: '/trips/:id/stays/:stay_id', tag: TAG,
  summary: 'Trip staff: change an accommodation booking (dates, property, status changed / cancelled) with the current row_version and a change note. The history keeps the previous values; everyone with a room there, and their guardians, is told.',
  input: z.object({ id, stay_id: id, row_version: z.number().int(), change_note: z.string().trim().min(2).max(500), ...STAY.partial().shape }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.ops) throw forbidden('Only trip staff can edit accommodation');
      assertOpen(ctx.trip);
      const s0 = (await c.query('SELECT * FROM trip_stays WHERE id=$1 AND trip_id=$2 AND archived_at IS NULL FOR UPDATE', [i.stay_id, ctx.trip.id])).rows[0];
      if (!s0) throw notFound('Stay');
      stale(s0, i.row_version);
      const { id: _a, stay_id, row_version, change_note, ...ch } = i;
      const next = { ...s0, ...Object.fromEntries(Object.entries(ch).filter(([, v]) => v !== undefined)) };
      if (ch.check_in_at || ch.check_out_at || ch.tz) {
        if (!ch.check_in_at || !ch.check_out_at) throw badRequest('Send both check-in and check-out, each with its UTC offset, when the dates or zone change');
        assertZoneMatches(ch.check_in_at, next.tz, 'Check-in'); assertZoneMatches(ch.check_out_at, next.tz, 'Check-out');
        if (Date.parse(ch.check_out_at) <= Date.parse(ch.check_in_at)) throw badRequest('Check-out must be after check-in');
        within(ctx.trip, ch.check_in_at, ch.check_out_at);
      }
      let src = s0.reference_source;
      if (ch.svc_order_id) { const o = await orderFor(c, user, ch.svc_order_id, 'accommodation'); src = 'supplier_order'; if (ch.reference === undefined) next.reference = o.third_party_ref ?? o.number; }
      assertPoint(next, '');
      const cols = ['property_name', 'address', 'country', 'lat', 'lng', 'reference', 'check_in_at', 'check_out_at', 'tz', 'status', 'svc_order_id', 'note'];
      const s = (await c.query(`UPDATE trip_stays SET ${cols.map((k, n) => `${k}=$${n + 2}`).join(', ')}, reference_source=$${cols.length + 2}, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`, [s0.id, ...cols.map((k) => next[k]), src])).rows[0];
      const housed = (await c.query('SELECT DISTINCT a.participant_id FROM trip_room_assignments a JOIN trip_rooms r ON r.id=a.room_id WHERE r.stay_id=$1 AND a.released_at IS NULL', [s.id])).rows.map((r) => r.participant_id);
      await record(c, ctx.trip, user.id, { entity: 'stay', entityId: s.id, action: s.status === 'cancelled' ? 'cancelled' : 'changed', version: s.row_version, snapshot: { before: Object.fromEntries(cols.map((k) => [k, s0[k]])), after: Object.fromEntries(cols.map((k) => [k, s[k]])) }, note: change_note,
        affected: await audienceOf(c, ctx.trip, housed), title: 'Your accommodation changed', body: `${ctx.trip.name}: ${s.property_name}. ${change_note}` });
      return stayShape(s);
    });
  },
});

cap({
  name: 'add_trip_room', method: 'POST', path: '/trips/:id/stays/:stay_id/rooms', tag: TAG, status: 201,
  summary: 'Trip staff: add rooms from the delegation\'s block (type, optional room number, capacity). Add several at once with count.',
  input: z.object({ id, stay_id: id, room_type: z.enum(['single', 'double', 'twin', 'triple', 'quad', 'family', 'dorm', 'other']), capacity: z.number().int().min(1).max(20), label: z.string().trim().max(40).optional(), count: z.number().int().min(1).max(100).default(1) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.ops) throw forbidden('Only trip staff can edit accommodation');
      assertOpen(ctx.trip);
      if (!(await c.query('SELECT 1 FROM trip_stays WHERE id=$1 AND trip_id=$2 AND archived_at IS NULL', [i.stay_id, ctx.trip.id])).rowCount) throw notFound('Stay');
      if (i.count > 1 && i.label) throw badRequest('Room numbers are set one room at a time');
      const out = [];
      for (let n = 0; n < i.count; n++) out.push((await c.query('INSERT INTO trip_rooms(stay_id, room_type, label, capacity) VALUES ($1,$2,$3,$4) RETURNING id, stay_id, room_type, label, capacity', [i.stay_id, i.room_type, i.label ?? null, i.capacity])).rows[0]);
      await record(c, ctx.trip, user.id, { entity: 'room', entityId: out[0].id, action: 'added', snapshot: { stay_id: i.stay_id, room_type: i.room_type, rooms: i.count, capacity: i.capacity } });
      return out;
    });
  },
});

cap({
  name: 'assign_trip_room', method: 'POST', path: '/trips/:id/rooms/:room_id/assign', tag: TAG,
  summary: 'Trip staff: put a traveller in a room, or release them (release: true). A room never exceeds its capacity, a traveller has one room per stay, and a young traveller can share only with other young travellers or their own verified guardian. Only the people concerned are told, and never their roommates.',
  input: z.object({ id, room_id: id, participant_id: id, release: z.boolean().default(false) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.ops) throw forbidden('Only trip staff can allocate rooms');
      assertOpen(ctx.trip);
      const room = (await c.query('SELECT r.*, s.trip_id, s.status AS stay_status FROM trip_rooms r JOIN trip_stays s ON s.id=r.stay_id WHERE r.id=$1 AND r.archived_at IS NULL FOR UPDATE OF r', [i.room_id])).rows[0];
      if (!room || room.trip_id !== ctx.trip.id) throw notFound('Room');
      const p = (await c.query('SELECT * FROM trip_participants WHERE id=$1 AND trip_id=$2 AND status = ANY($3)', [i.participant_id, ctx.trip.id, LIVE_PARTICIPANT])).rows[0];
      if (!p) throw notFound('Traveller');
      if (i.release) {
        if (!(await c.query('UPDATE trip_room_assignments SET released_at=now() WHERE room_id=$1 AND participant_id=$2 AND released_at IS NULL RETURNING id', [room.id, p.id])).rowCount) throw notFound('Allocation');
        await record(c, ctx.trip, user.id, { entity: 'room', entityId: room.id, action: 'released', snapshot: { participant_id: p.id }, affected: await audienceOf(c, ctx.trip, [p.id]), title: 'Your room allocation changed', body: ctx.trip.name });
        return { ok: true };
      }
      if (room.stay_status === 'cancelled') throw conflict('That stay is cancelled');
      const here = (await c.query(`SELECT p2.id, p2.user_id, p2.role, p2.guardian_of, (${YOUTH_SQL.replaceAll('u.', 'u2.')}) AS youth FROM trip_room_assignments a JOIN trip_participants p2 ON p2.id=a.participant_id JOIN users u2 ON u2.id=p2.user_id WHERE a.room_id=$1 AND a.released_at IS NULL`, [room.id])).rows;
      if (here.some((h) => h.id === p.id)) return { ok: true, unchanged: true };
      if (here.length >= room.capacity) throw conflict('That room is full');
      if ((await c.query('SELECT 1 FROM trip_room_assignments a JOIN trip_rooms r ON r.id=a.room_id WHERE r.stay_id=$1 AND a.participant_id=$2 AND a.released_at IS NULL', [room.stay_id, p.id])).rowCount) throw conflict('That traveller already has a room in this stay. Release it first.');
      const pYouth = (await youthIdsAmong(c, [p.user_id])).length > 0;
      for (const h of here) {
        if (pYouth !== h.youth) {
          const adult = pYouth ? h : p, kid = pYouth ? p : h;
          const guardsKid = adult.role === 'guardian' && adult.guardian_of === kid.user_id && (await guardianLink(adult.user_id, kid.user_id, c));
          if (!guardsKid) throw conflict('Safeguarding: a young traveller can share a room only with other young travellers or their own verified guardian', { code: 'safeguarding_room' });
        }
      }
      await c.query('INSERT INTO trip_room_assignments(room_id, participant_id, assigned_by) VALUES ($1,$2,$3)', [room.id, p.id, user.id]);
      await record(c, ctx.trip, user.id, { entity: 'room', entityId: room.id, action: 'assigned', snapshot: { participant_id: p.id }, affected: await audienceOf(c, ctx.trip, [p.id]), title: 'You have a room', body: `${ctx.trip.name}: open Stay to see it.` });
      return { ok: true };
    });
  },
});

cap({
  name: 'get_trip_rooming', method: 'GET', path: '/trips/:id/rooming', tag: TAG,
  summary: 'Accommodation and rooming, scoped to who is asking. Trip staff see the full rooming list. An adult traveller sees their stay, their room and adult roommates. A young traveller sees only the property and room type; their verified guardian sees their room and adult roommates. Room numbers and roommate details of young travellers are never shown to other travellers.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await tripCtx(user, i.id);
    const stays = await many('SELECT * FROM trip_stays WHERE trip_id=$1 AND archived_at IS NULL ORDER BY check_in_at', [ctx.trip.id]);
    const rows = await many(`SELECT r.id AS room_id, r.stay_id, r.room_type, r.label, r.capacity, a.participant_id, p.user_id, p.role, u.display_name FROM trip_rooms r LEFT JOIN trip_room_assignments a ON a.room_id=r.id AND a.released_at IS NULL LEFT JOIN trip_participants p ON p.id=a.participant_id LEFT JOIN users u ON u.id=p.user_id WHERE r.archived_at IS NULL AND r.stay_id = ANY($1::uuid[]) ORDER BY r.label NULLS LAST, r.created_at`, [stays.map((s) => s.id)]);
    const youth = new Set(await youthIdsAmong(pool, rows.filter((r) => r.user_id).map((r) => r.user_id)));
    const viewerYouth = ctx.mine ? youth.has(ctx.mine.user_id) || (await youthIdsAmong(pool, [user.id])).length > 0 : false;
    const myIds = new Set([ctx.mine?.id, ...ctx.wards.map((w) => w.id)].filter(Boolean));
    const byRoom = new Map();
    for (const r of rows) { const o = byRoom.get(r.room_id) ?? { room_id: r.room_id, stay_id: r.stay_id, room_type: r.room_type, label: r.label, capacity: r.capacity, occupants: [] }; if (r.participant_id) o.occupants.push(r); byRoom.set(r.room_id, o); }
    return stays.map((s) => {
      let rooms = [...byRoom.values()].filter((r) => r.stay_id === s.id);
      if (!ctx.ops) {
        rooms = rooms.filter((r) => r.occupants.some((o) => myIds.has(o.participant_id)));
        rooms = rooms.map((r) => {
          const selfYouthOnly = viewerYouth && !ctx.wards.length;
          return { room_id: r.room_id, stay_id: r.stay_id, room_type: r.room_type, capacity: r.capacity, label: selfYouthOnly ? null : r.label,
            occupants: selfYouthOnly ? [] : r.occupants.filter((o) => myIds.has(o.participant_id) || !youth.has(o.user_id)).map((o) => ({ participant_id: o.participant_id, display_name: o.display_name, role: o.role })) };
        });
      } else rooms = rooms.map((r) => ({ ...r, occupants: r.occupants.map((o) => ({ participant_id: o.participant_id, display_name: o.display_name, role: o.role, young: youth.has(o.user_id) })) }));
      const visible = ctx.ops || rooms.length;
      return visible ? { ...stayShape(s), rooms } : null;
    }).filter(Boolean);
  },
});

// ---------------------------------------------------------------- equipment and baggage

const GEAR_STATES = ['planned', 'packed', 'loaded', 'in_transit', 'unloaded', 'received', 'missing', 'damaged'];
cap({
  name: 'add_trip_gear', method: 'POST', path: '/trips/:id/gear', tag: TAG, status: 201,
  summary: 'Trip staff: record an equipment / baggage consignment for the trip: category, quantity, responsible person, the transport leg it rides, an optional canonical resource and a logistics reference. This tracks the movement; it does not duplicate stock.',
  input: z.object({ id, category: z.enum(['kit', 'equipment', 'medical', 'technical', 'food', 'personal', 'other']), description: z.string().trim().min(1).max(200), quantity: z.number().int().min(1).max(100000), responsible_id: id.optional().describe('user id of a traveller'), segment_id: id.optional(), resource_id: id.optional(), logistics_ref: z.string().trim().max(80).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.ops) throw forbidden('Only trip staff can record equipment');
      assertOpen(ctx.trip);
      await checkGearRefs(c, ctx.trip, i);
      const g = (await c.query('INSERT INTO trip_gear(trip_id, category, description, quantity, responsible_id, segment_id, resource_id, logistics_ref, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [ctx.trip.id, i.category, i.description, i.quantity, i.responsible_id ?? null, i.segment_id ?? null, i.resource_id ?? null, i.logistics_ref ?? null, user.id])).rows[0];
      await c.query("INSERT INTO trip_gear_log(gear_id, state, actor_id) VALUES ($1,'planned',$2)", [g.id, user.id]);
      await record(c, ctx.trip, user.id, { entity: 'gear', entityId: g.id, action: 'added', version: 1, snapshot: { category: g.category, quantity: g.quantity } });
      return g;
    });
  },
});
async function checkGearRefs(c, trip, i) {
  if (i.responsible_id && !(await c.query('SELECT 1 FROM trip_participants WHERE trip_id=$1 AND user_id=$2 AND status = ANY($3)', [trip.id, i.responsible_id, LIVE_PARTICIPANT])).rowCount) throw badRequest('The responsible person must be on the trip');
  if (i.segment_id && !(await c.query('SELECT 1 FROM trip_segments WHERE id=$1 AND trip_id=$2 AND archived_at IS NULL', [i.segment_id, trip.id])).rowCount) throw badRequest('That transport leg is not on this trip');
  if (i.resource_id && !(await c.query('SELECT 1 FROM resources WHERE id=$1', [i.resource_id])).rowCount) throw notFound('Resource');
}

cap({
  name: 'update_trip_gear', method: 'PATCH', path: '/trips/:id/gear/:gear_id', tag: TAG,
  summary: 'Move a consignment through packed → loaded → in transit → unloaded → received, or flag it missing / damaged, with the checkpoint where it happened. Trip staff or the person responsible can do this; every checkpoint is kept.',
  input: z.object({ id, gear_id: id, row_version: z.number().int(), state: z.enum(GEAR_STATES).optional(), checkpoint: z.string().trim().max(120).optional(), note: z.string().trim().max(300).optional(), quantity: z.number().int().min(1).max(100000).optional(), responsible_id: id.nullable().optional(), segment_id: id.nullable().optional(), logistics_ref: z.string().trim().max(80).nullable().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      assertOpen(ctx.trip);
      const g0 = (await c.query('SELECT * FROM trip_gear WHERE id=$1 AND trip_id=$2 AND archived_at IS NULL FOR UPDATE', [i.gear_id, ctx.trip.id])).rows[0];
      if (!g0) throw notFound('Consignment');
      const mine = g0.responsible_id === user.id;
      if (!ctx.ops && !(mine && Object.keys(i).every((k) => ['id', 'gear_id', 'row_version', 'state', 'checkpoint', 'note'].includes(k)))) throw forbidden('Only trip staff, or the person responsible for this item, can update it');
      stale(g0, i.row_version);
      if (i.responsible_id || i.segment_id) await checkGearRefs(c, ctx.trip, i);
      const next = { quantity: i.quantity ?? g0.quantity, responsible_id: i.responsible_id === undefined ? g0.responsible_id : i.responsible_id, segment_id: i.segment_id === undefined ? g0.segment_id : i.segment_id, logistics_ref: i.logistics_ref === undefined ? g0.logistics_ref : i.logistics_ref, state: i.state ?? g0.state };
      const g = (await c.query('UPDATE trip_gear SET quantity=$2, responsible_id=$3, segment_id=$4, logistics_ref=$5, state=$6, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [g0.id, next.quantity, next.responsible_id, next.segment_id, next.logistics_ref, next.state])).rows[0];
      if (i.state || i.checkpoint || i.note) await c.query('INSERT INTO trip_gear_log(gear_id, state, checkpoint, note, actor_id) VALUES ($1,$2,$3,$4,$5)', [g.id, g.state, i.checkpoint ?? null, i.note ?? null, user.id]);
      const bad = i.state && ['missing', 'damaged'].includes(i.state) && i.state !== g0.state;
      await record(c, ctx.trip, user.id, { entity: 'gear', entityId: g.id, action: i.state && i.state !== g0.state ? `state_${i.state}` : 'updated', version: g.row_version, snapshot: { from: g0.state, to: g.state, checkpoint: i.checkpoint ?? null }, note: i.note,
        affected: bad ? [ctx.trip.manager_id, g.responsible_id] : [], title: bad ? `Equipment ${i.state}` : undefined, body: `${ctx.trip.name}: ${g.quantity} × ${g.description}` });
      return g;
    });
  },
});

cap({
  name: 'list_trip_gear', method: 'GET', path: '/trips/:id/gear', tag: TAG,
  summary: 'Equipment and baggage consignments with their last checkpoint. Trip staff see all; a traveller sees only the items they are responsible for.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await tripCtx(user, i.id);
    return many(
      `SELECT g.id, g.category, g.description, g.quantity, g.state, g.logistics_ref, g.segment_id, g.resource_id, g.responsible_id, ru.display_name AS responsible_name, g.row_version,
              (SELECT json_build_object('checkpoint', l.checkpoint, 'note', l.note, 'at', l.at) FROM trip_gear_log l WHERE l.gear_id=g.id ORDER BY l.at DESC, l.id DESC LIMIT 1) AS last_checkpoint
         FROM trip_gear g LEFT JOIN users ru ON ru.id=g.responsible_id WHERE g.trip_id=$1 AND g.archived_at IS NULL AND ($2 OR g.responsible_id=$3) ORDER BY g.created_at`, [ctx.trip.id, ctx.ops, user.id]);
  },
});

// ---------------------------------------------------------------- supplier / procurement hand-off

cap({
  name: 'link_trip_supplier', method: 'POST', path: '/trips/:id/suppliers', tag: TAG, status: 201,
  summary: 'Hand a travel / accommodation need to supplier services (#458/#460): link an existing RFQ or an accepted supplier order you can act on as a buyer. The RFQ, quote and order stay in supplier services, so nothing is duplicated; accepted orders can then feed segments and stays by svc_order_id.',
  input: z.object({ id, purpose: z.enum(['travel', 'accommodation', 'local_transfer', 'equipment_freight', 'other']), rfq_id: id.optional(), order_id: id.optional() }),
  async handler({ user }, i) {
    if (!!i.rfq_id === !!i.order_id) throw badRequest('Give either an RFQ or an order');
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.manager) throw forbidden('Only the trip manager can link supplier sourcing');
      assertOpen(ctx.trip);
      if (i.rfq_id) {
        const r = (await c.query('SELECT * FROM svc_rfqs WHERE id=$1', [i.rfq_id])).rows[0];
        if (!r) throw notFound('RFQ');
        await buyerAccess(user, r.buyer_id, null, c);
      } else await orderFor(c, user, i.order_id);
      const l = (await c.query('INSERT INTO trip_supplier_links(trip_id, purpose, rfq_id, order_id, linked_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *', [ctx.trip.id, i.purpose, i.rfq_id ?? null, i.order_id ?? null, user.id])).rows[0];
      if (!l) throw conflict('Already linked to this trip');
      await record(c, ctx.trip, user.id, { entity: 'supplier_link', entityId: l.id, action: 'linked', snapshot: { purpose: i.purpose, rfq_id: i.rfq_id ?? null, order_id: i.order_id ?? null } });
      return l;
    });
  },
});

cap({
  name: 'unlink_trip_supplier', method: 'POST', path: '/trips/:id/suppliers/:link_id/unlink', tag: TAG,
  summary: 'Remove a supplier link from the trip (the RFQ / order itself is untouched; the link stays in the history).',
  input: z.object({ id, link_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.manager) throw forbidden('Only the trip manager can unlink suppliers');
      const l = (await c.query('UPDATE trip_supplier_links SET unlinked_at=now() WHERE id=$1 AND trip_id=$2 AND unlinked_at IS NULL RETURNING *', [i.link_id, ctx.trip.id])).rows[0];
      if (!l) throw notFound('Link');
      await record(c, ctx.trip, user.id, { entity: 'supplier_link', entityId: l.id, action: 'unlinked' });
      return { ok: true };
    });
  },
});

cap({
  name: 'list_trip_suppliers', method: 'GET', path: '/trips/:id/suppliers', tag: TAG,
  summary: 'Supplier sourcing linked to the trip with its status in supplier services, and the supplier contact through the approved channel (the order in supplier services), never a private phone or email. Trip staff only.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await tripCtx(user, i.id);
    if (!ctx.ops) throw forbidden('Only trip staff can see supplier sourcing');
    return many(
      `SELECT l.id, l.purpose, l.rfq_id, l.order_id, l.linked_at, r.title AS rfq_title, r.status AS rfq_status, o.number AS order_number, o.status AS order_status, o.fulfilment, o.travel_confirmation, o.third_party_ref, o.currency, o.gross_minor::float8 AS gross_minor,
              coalesce(sp.trading_name, sp.legal_name) AS supplier_name
         FROM trip_supplier_links l LEFT JOIN svc_rfqs r ON r.id=l.rfq_id LEFT JOIN svc_orders o ON o.id=l.order_id LEFT JOIN svc_profiles sp ON sp.id=o.profile_id
        WHERE l.trip_id=$1 AND l.unlinked_at IS NULL ORDER BY l.linked_at`, [ctx.trip.id]);
  },
});
