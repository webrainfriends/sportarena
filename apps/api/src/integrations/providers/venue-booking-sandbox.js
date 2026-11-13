// Venue booking sandbox — full mock provider for development and test.
// All capabilities enabled; no real bookings made; deterministic responses.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const PROVIDER_KEY = 'venue_booking_sandbox';

export const MOCK_VENUES = [
  {
    id: 'sandbox-venue-001',
    name: 'GotMyGame Arena (Sandbox)',
    address: '1 Stadium Drive',
    city: 'Singapore',
    country: 'SG',
    lat: 1.3049,
    lng: 103.8745,
    sports: ['badminton', 'tennis', 'squash', 'basketball', 'volleyball'],
    courts: 8,
    hourly_rate_minor: 3500,
    currency: 'SGD',
    availability_status: 'live_confirmed',
    indoor: true,
    surface: 'Synthetic wood',
    amenities: ['Changing rooms', 'Equipment rental', 'Café', 'Parking'],
    booking_lead_days: 7,
    cancellation_hours: 24,
    tax_rate: 0.09,
  },
  {
    id: 'sandbox-venue-002',
    name: 'Sandbox Sports Hub',
    address: '45 Sports Boulevard',
    city: 'Singapore',
    country: 'SG',
    lat: 1.2994,
    lng: 103.8761,
    sports: ['football', 'futsal', 'hockey', 'cricket', 'rugby'],
    courts: 4,
    hourly_rate_minor: 6000,
    currency: 'SGD',
    availability_status: 'price_indicative',
    indoor: false,
    surface: 'Natural grass / synthetic turf',
    amenities: ['Floodlights', 'Scoreboard', 'Grandstand (500 seats)', 'Parking'],
    booking_lead_days: 14,
    cancellation_hours: 48,
    tax_rate: 0.09,
  },
  {
    id: 'sandbox-venue-003',
    name: 'Elite Academy Sandbox Centre',
    address: '10 Academy Way',
    city: 'Melbourne',
    country: 'AU',
    lat: -37.8136,
    lng: 144.9631,
    sports: ['tennis', 'squash', 'badminton', 'table_tennis', 'volleyball'],
    courts: 12,
    hourly_rate_minor: 4500,
    currency: 'AUD',
    availability_status: 'live_confirmed',
    indoor: true,
    surface: 'Hard court / carpet',
    amenities: ['Physio suite', 'Video analysis suite', 'Gym', 'Café', 'Accommodation'],
    booking_lead_days: 3,
    cancellation_hours: 12,
    tax_rate: 0.10,
  },
];

export function searchVenues({ sport_keys = [], city = '', courts = 1 } = {}) {
  return MOCK_VENUES.filter((v) => {
    const sportMatch = !sport_keys.length || sport_keys.some((s) => v.sports.includes(s));
    const cityMatch = !city || v.city.toLowerCase().includes(city.toLowerCase());
    const courtMatch = v.courts >= courts;
    return sportMatch && cityMatch && courtMatch;
  }).map((v) => ({ ...v, source: 'external_partner', provider_key: PROVIDER_KEY }));
}

export function mockQuote({ venue_id, starts_at, ends_at, courts = 1 } = {}) {
  const venue = MOCK_VENUES.find((v) => v.id === venue_id);
  if (!venue) return null;
  const ms = ends_at && starts_at ? (new Date(ends_at) - new Date(starts_at)) : 3600000;
  const hours = ms / 3600000;
  const base = Math.round(venue.hourly_rate_minor * hours * courts);
  const tax = Math.round(base * venue.tax_rate);
  return {
    venue_id,
    provider_key: PROVIDER_KEY,
    courts_requested: courts,
    starts_at: starts_at ?? new Date(Date.now() + 86400000).toISOString(),
    ends_at: ends_at ?? new Date(Date.now() + 90000000).toISOString(),
    price_minor: base,
    tax_minor: tax,
    fee_minor: 0,
    total_minor: base + tax,
    currency: venue.currency,
    availability_status: venue.availability_status,
    quote_expires_at: new Date(Date.now() + 900000).toISOString(),
    quote_fetched_at: new Date().toISOString(),
    cancellation_policy: `Cancel ${venue.cancellation_hours}h before for full refund`,
  };
}

const hmacOk = (secret, raw, sig) => {
  const want = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(String(sig ?? '').replace(/^sha256=/, ''));
  return want.length === got.length && timingSafeEqual(want, got);
};

export const inbound = {
  verify: (secret, raw, headers) => hmacOk(secret, raw, headers['x-sportarena-signature']),
  parse: (json) => {
    const events = Array.isArray(json?.events) ? json.events : [json];
    return events
      .filter((e) => e && e.dedup_key && e.type)
      .map((e) => ({
        id: String(e.dedup_key).slice(0, 120),
        kind: String(e.type).slice(0, 60),
        data: {
          venue_id: e.venue_id,
          booking_reference: e.booking_reference,
          status: e.status,
          starts_at: e.starts_at,
          ends_at: e.ends_at,
          price_minor: e.price_minor,
          currency: e.currency,
          note: e.note ? String(e.note).slice(0, 300) : undefined,
        },
      }));
  },
};

export async function test() {
  return { ok: true, message: `Sandbox ready — ${MOCK_VENUES.length} mock venues available. No real bookings are made.` };
}
