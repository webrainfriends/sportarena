// Parent carpool coordination (gaps audit, feature 2).
// Privacy model: departure_location_enc is NEVER returned publicly — only area_label (non-identifying)
// is shown until a passenger is confirmed. Full address surfaces only in the manifest (driver) or
// confirmed-booking response (passenger), and that decrypt is audit-logged.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { decrypt, encrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';

const TAG = 'Carpool';

cap({
  name: 'offer_carpool', method: 'POST', path: '/events/:event_id/carpool-offers', tag: TAG,
  summary: 'Offer a carpool ride for an event',
  auth: 'user',
  input: z.object({
    event_id: id,
    departure_location: z.string().min(2).max(500),
    area_label: z.string().min(2).max(100),
    departure_time: z.string().datetime(),
    seats_available: z.number().int().min(1).max(8),
    return_offered: z.boolean().default(false),
    return_time: z.string().datetime().optional(),
    vehicle_type: z.enum(['car','minivan','van','other']).optional(),
    notes: z.string().max(500).optional(),
    recurring_rule: z.string().max(200).optional(),
  }),
  handler: async ({ user }, { event_id, departure_location, area_label, departure_time, seats_available, return_offered, return_time, vehicle_type, notes, recurring_rule }) => {
    const event = await one('SELECT id FROM events WHERE id=$1', [event_id]);
    if (!event) throw notFound('Event');
    const existing = await one('SELECT id FROM carpool_offers WHERE event_id=$1 AND driver_id=$2 AND archived_at IS NULL', [event_id, user.id]);
    if (existing) throw conflict('You already have an offer for this event');
    const offer = await one(
      `INSERT INTO carpool_offers(event_id,driver_id,departure_location_enc,area_label,departure_time,seats_available,return_offered,return_time,vehicle_type,notes_enc,recurring_rule)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [event_id, user.id, encrypt(departure_location), area_label, departure_time, seats_available,
       return_offered, return_time ?? null, vehicle_type ?? null, notes ? encrypt(notes) : null, recurring_rule ?? null]
    );
    return { offer: { ...offer, departure_location_enc: undefined, notes_enc: undefined } };
  },
});

cap({
  name: 'list_event_carpools', method: 'GET', path: '/events/:event_id/carpool-offers', tag: TAG,
  summary: 'List carpool offers for an event (area labels only, no addresses)',
  auth: 'user',
  input: z.object({ event_id: id }),
  handler: async ({ user }, { event_id }) => {
    const offers = await many(
      `SELECT o.id, o.area_label, o.departure_time, o.seats_available, o.return_offered, o.return_time,
              o.vehicle_type, o.driver_licence_verified, o.status, o.recurring_rule,
              u.display_name AS driver_name, u.avatar_url AS driver_avatar, u.avatar_emoji AS driver_emoji, u.avatar_color AS driver_color,
              COUNT(b.id) FILTER(WHERE b.status='confirmed') AS confirmed_count,
              (o.driver_id = $2) AS is_my_offer,
              (SELECT AVG(b2.driver_rating) FROM carpool_bookings b2 JOIN carpool_offers o2 ON o2.id=b2.offer_id WHERE o2.driver_id=o.driver_id AND b2.driver_rating IS NOT NULL) AS driver_avg_rating
       FROM carpool_offers o
       JOIN users u ON u.id=o.driver_id
       LEFT JOIN carpool_bookings b ON b.offer_id=o.id
       WHERE o.event_id=$1 AND o.archived_at IS NULL AND o.status IN ('open','full')
       GROUP BY o.id, u.id ORDER BY o.departure_time`,
      [event_id, user.id]
    );
    // include user's own booking status
    const myBookings = await many(
      'SELECT b.offer_id, b.status AS my_booking_status FROM carpool_bookings b JOIN carpool_offers o ON o.id=b.offer_id WHERE o.event_id=$1 AND b.passenger_id=$2',
      [event_id, user.id]
    );
    const bookingMap = Object.fromEntries(myBookings.map(b => [b.offer_id, b.my_booking_status]));
    return { offers: offers.map(o => ({ ...o, my_booking_status: bookingMap[o.id] ?? null })) };
  },
});

cap({
  name: 'request_carpool_seat', method: 'POST', path: '/carpool-offers/:id/bookings', tag: TAG,
  summary: 'Request a seat in a carpool',
  auth: 'user',
  input: z.object({
    id,
    for_child_id: id.optional(),
    pickup_area_label: z.string().max(100).optional(),
    pickup_location: z.string().max(500).optional(),
  }),
  handler: async ({ user }, { id: offerId, for_child_id, pickup_area_label, pickup_location }) => {
    const offer = await one('SELECT * FROM carpool_offers WHERE id=$1 AND archived_at IS NULL', [offerId]);
    if (!offer) throw notFound('Offer');
    if (offer.driver_id === user.id) throw badRequest('Cannot request your own offer');
    if (offer.status !== 'open') throw badRequest('This offer is no longer accepting requests');
    if (for_child_id) {
      const child = await one('SELECT id FROM users WHERE id=$1 AND managed_by_guardian_id=$2', [for_child_id, user.id]);
      if (!child) throw forbidden('Not a managed child of this guardian');
    }
    const existing = await one('SELECT id FROM carpool_bookings WHERE offer_id=$1 AND passenger_id=$2', [offerId, user.id]);
    if (existing) throw conflict('Already requested this offer');
    const confirmed = await one('SELECT COUNT(*) AS n FROM carpool_bookings WHERE offer_id=$1 AND status=\'confirmed\'', [offerId]);
    if (Number(confirmed.n) >= offer.seats_available) throw badRequest('No seats remaining');
    const booking = await one(
      `INSERT INTO carpool_bookings(offer_id,passenger_id,for_child_id,pickup_location_enc,pickup_area_label)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [offerId, user.id, for_child_id ?? null,
       pickup_location ? encrypt(pickup_location) : null, pickup_area_label ?? null]
    );
    await notify(offer.driver_id, {
      title: 'New carpool request',
      body: `${user.display_name} requested a seat from ${offer.area_label}`,
      data: { type: 'carpool_request', offer_id: offerId, booking_id: booking.id },
    });
    return { booking: { ...booking, pickup_location_enc: undefined } };
  },
});

cap({
  name: 'respond_carpool_request', method: 'PATCH', path: '/carpool-bookings/:id', tag: TAG,
  summary: 'Confirm or decline a carpool booking request (driver only)',
  auth: 'user',
  input: z.object({ id, decision: z.enum(['confirmed','declined']) }),
  handler: async ({ user }, { id: bookingId, decision }) => {
    const booking = await one(
      `SELECT b.*, o.driver_id, o.seats_available, o.departure_time, o.departure_location_enc
       FROM carpool_bookings b JOIN carpool_offers o ON o.id=b.offer_id WHERE b.id=$1`,
      [bookingId]
    );
    if (!booking) throw notFound('Booking');
    if (booking.driver_id !== user.id) throw forbidden('Not your offer');
    if (booking.status !== 'requested') throw badRequest('Booking is not in requested status');
    await one('UPDATE carpool_bookings SET status=$1 WHERE id=$2 RETURNING id', [decision, bookingId]);
    if (decision === 'confirmed') {
      const filled = await one('SELECT COUNT(*) AS n FROM carpool_bookings WHERE offer_id=$1 AND status=\'confirmed\'', [booking.offer_id]);
      if (Number(filled.n) >= booking.seats_available) {
        await one('UPDATE carpool_offers SET status=\'full\' WHERE id=$1', [booking.offer_id]);
      }
      // The driver's address is released to the passenger only through get_my_carpool_bookings (audit-logged there).
      await audit(null, user.id, 'carpool_booking_confirmed', 'carpool_bookings', bookingId);
    }
    await notify(booking.passenger_id, {
      title: decision === 'confirmed' ? 'Carpool confirmed!' : 'Carpool request update',
      body: decision === 'confirmed' ? 'Your seat is confirmed. See the full pickup details in the app.' : 'Your carpool request was not taken forward.',
      data: { type: 'carpool_decision', booking_id: bookingId, decision },
    });
    return { decision };
  },
});

cap({
  name: 'cancel_carpool_seat', method: 'POST', path: '/carpool-bookings/:id/cancel', tag: TAG,
  summary: 'Cancel your carpool seat (passenger)',
  auth: 'user',
  input: z.object({ id }),
  handler: async ({ user }, { id: bookingId }) => {
    const booking = await one(
      `SELECT b.*, o.driver_id, o.departure_time FROM carpool_bookings b JOIN carpool_offers o ON o.id=b.offer_id WHERE b.id=$1`,
      [bookingId]
    );
    if (!booking) throw notFound('Booking');
    if (booking.passenger_id !== user.id) throw forbidden('Not your booking');
    if (!['requested','confirmed'].includes(booking.status)) throw badRequest('Cannot cancel in current status');
    const late = (new Date(booking.departure_time) - Date.now()) < 2 * 60 * 60 * 1000;
    await one('UPDATE carpool_bookings SET status=\'cancelled\', late_cancel=$1 WHERE id=$2 RETURNING id', [late, bookingId]);
    if (booking.status === 'confirmed') {
      await one('UPDATE carpool_offers SET status=\'open\' WHERE id=$1 AND status=\'full\'', [booking.offer_id]);
    }
    await notify(booking.driver_id, {
      title: 'Carpool cancellation',
      body: `${user.display_name} cancelled their seat${late ? ' (late cancellation)' : ''}`,
      data: { type: 'carpool_cancel', booking_id: bookingId, late_cancel: late },
    });
    return { cancelled: true, late_cancel: late };
  },
});

cap({
  name: 'cancel_carpool_offer', method: 'POST', path: '/carpool-offers/:id/cancel', tag: TAG,
  summary: 'Cancel your carpool offer and notify all confirmed passengers (driver)',
  auth: 'user',
  input: z.object({ id }),
  handler: async ({ user }, { id: offerId }) => {
    const offer = await one('SELECT * FROM carpool_offers WHERE id=$1 AND archived_at IS NULL', [offerId]);
    if (!offer) throw notFound('Offer');
    if (offer.driver_id !== user.id) throw forbidden('Not your offer');
    await one('UPDATE carpool_offers SET status=\'cancelled\' WHERE id=$1', [offerId]);
    const passengers = await many('SELECT passenger_id FROM carpool_bookings WHERE offer_id=$1 AND status=\'confirmed\'', [offerId]);
    for (const p of passengers) {
      await notify(p.passenger_id, {
        title: 'Carpool cancelled',
        body: 'The driver has cancelled this carpool. Please arrange alternative transport.',
        data: { type: 'carpool_offer_cancelled', offer_id: offerId },
      });
    }
    return { cancelled: true };
  },
});

cap({
  name: 'get_carpool_manifest', method: 'GET', path: '/carpool-offers/:id/manifest', tag: TAG,
  summary: 'Get full passenger manifest with decrypted pickup locations (driver only)',
  auth: 'user',
  input: z.object({ id }),
  handler: async ({ user }, { id: offerId }) => {
    const offer = await one('SELECT * FROM carpool_offers WHERE id=$1', [offerId]);
    if (!offer) throw notFound('Offer');
    if (offer.driver_id !== user.id) throw forbidden('Not your offer');
    const bookings = await many(
      `SELECT b.*, u.display_name, u.avatar_url, u.avatar_emoji, u.avatar_color
       FROM carpool_bookings b JOIN users u ON u.id=b.passenger_id
       WHERE b.offer_id=$1 AND b.status='confirmed'`,
      [offerId]
    );
    await audit(null, user.id, 'carpool_manifest_viewed', 'carpool_offers', offerId);
    return {
      manifest: bookings.map(b => ({
        ...b,
        pickup_location: b.pickup_location_enc ? decrypt(b.pickup_location_enc) : null,
        pickup_location_enc: undefined,
      })),
    };
  },
});

cap({
  name: 'rate_carpool', method: 'POST', path: '/carpool-bookings/:id/rate', tag: TAG,
  summary: 'Rate a carpool after the event',
  auth: 'user',
  input: z.object({
    id,
    rating: z.number().int().min(1).max(5),
    note: z.string().max(500).optional(),
    perspective: z.enum(['driver','passenger']),
  }),
  handler: async ({ user }, { id: bookingId, rating, note, perspective }) => {
    const booking = await one(
      `SELECT b.*, o.driver_id, o.departure_time FROM carpool_bookings b JOIN carpool_offers o ON o.id=b.offer_id WHERE b.id=$1`,
      [bookingId]
    );
    if (!booking) throw notFound('Booking');
    if (perspective === 'passenger' && booking.passenger_id !== user.id) throw forbidden('Not your booking');
    if (perspective === 'driver' && booking.driver_id !== user.id) throw forbidden('Not your offer');
    if (new Date(booking.departure_time) > new Date()) throw badRequest('Cannot rate before the event');
    const field = perspective === 'driver' ? 'passenger_rating' : 'driver_rating';
    const noteField = perspective === 'driver' ? 'passenger_rating_note_enc' : 'driver_rating_note_enc';
    await one(`UPDATE carpool_bookings SET ${field}=$1, ${noteField}=$2 WHERE id=$3 RETURNING id`, [rating, note ? encrypt(note) : null, bookingId]);
    return { rated: true };
  },
});

cap({
  name: 'get_my_carpool_bookings', method: 'GET', path: '/me/carpool-bookings', tag: TAG,
  summary: 'Get my carpool offers and bookings',
  auth: 'user',
  input: z.object({}),
  handler: async ({ user }) => {
    const offers = await many(
      `SELECT o.*, e.name AS event_name, e.starts_on,
              COUNT(b.id) FILTER(WHERE b.status='confirmed') AS confirmed_count
       FROM carpool_offers o JOIN events e ON e.id=o.event_id
       LEFT JOIN carpool_bookings b ON b.offer_id=o.id
       WHERE o.driver_id=$1 AND o.archived_at IS NULL
       GROUP BY o.id, e.id ORDER BY o.departure_time DESC`,
      [user.id]
    );
    const bookings = await many(
      `SELECT b.*, o.area_label, o.departure_time, o.return_offered, o.vehicle_type, o.departure_location_enc,
              u.display_name AS driver_name, u.avatar_url AS driver_avatar,
              e.name AS event_name
       FROM carpool_bookings b JOIN carpool_offers o ON o.id=b.offer_id
       JOIN users u ON u.id=o.driver_id JOIN events e ON e.id=o.event_id
       WHERE b.passenger_id=$1 ORDER BY o.departure_time DESC`,
      [user.id]
    );
    // Full pickup address of the driver is released only for a confirmed seat, and the decrypt is audit-logged.
    for (const b of bookings.filter(x => x.status === 'confirmed' && x.departure_location_enc)) {
      await audit(null, user.id, 'carpool_address_shared_on_confirm', 'carpool_bookings', b.id);
    }
    return {
      offers: offers.map(o => ({ ...o, departure_location_enc: undefined, notes_enc: undefined })),
      bookings: bookings.map(b => ({
        ...b,
        departure_location: b.status === 'confirmed' && b.departure_location_enc ? decrypt(b.departure_location_enc) : null,
        departure_location_enc: undefined, pickup_location_enc: undefined,
        driver_rating_note_enc: undefined, passenger_rating_note_enc: undefined,
      })),
    };
  },
});
