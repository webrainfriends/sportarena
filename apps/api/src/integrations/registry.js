// Provider adapters for the Integration Hub (#597). A provider is data plus three small functions; the framework (installs, credentials,
// scopes, sync health, webhooks, usage, rotation) is shared, so adding a provider never needs a new module, table or screen.
//   fields    zod schema of the settings a tenant supplies (all encrypted at rest, never returned)
//   secrets   names of fields that are credentials (shown once as a hint, rotatable)
//   scopes    the data the connection can touch, shown to the person before they connect
//   test(cfg)          cheap connectivity check -> { ok, message }
//   pull(cfg, ctx)     scheduled/manual sync -> { summary }            (omit when the provider only pushes)
//   inbound            { verify(cfg, rawBody, headers), parse(json) -> [{ id, kind }] }   (omit when the provider is never called back)
// `managed` entries are integrations that already exist as their own console; the catalogue lists them and points there (no duplicate).
import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { fetchIcs, parseBusy } from '../ics.js';
import { send } from './http.js';

export const CATEGORIES = ['payments', 'sso', 'calendar', 'email_sms', 'wearables', 'video', 'federation_feed', 'accounting', 'ticket_scanner', 'sports_data', 'travel', 'venue_booking', 'event_source'];

const hmacOk = (secret, raw, sig) => {
  const want = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(String(sig ?? '').replace(/^sha256=/, ''));
  return want.length === got.length && timingSafeEqual(want, got);
};
const urlField = z.string().url().max(500);

// Partner callbacks about a booking we hold: { id, type: 'booking.changed'|'booking.cancelled', partner_ref, starts_at?, ends_at?, price_minor?, note? }.
const parseTravel = (json) => (Array.isArray(json?.events) ? json.events : [json]).filter((e) => e && e.id && e.partner_ref && /^booking\.(changed|cancelled)$/.test(String(e.type)))
  .map((e) => ({ id: String(e.id).slice(0, 120), kind: String(e.type), data: { partner_ref: String(e.partner_ref).slice(0, 120), starts_at: e.starts_at, ends_at: e.ends_at, price_minor: e.price_minor, note: e.note ? String(e.note).slice(0, 300) : undefined } }));

export const PROVIDERS = {
  calendar_ics: {
    category: 'calendar', name: 'Calendar feed (iCalendar)', version: '1.0', auth: 'none', sandbox: false,
    capabilities: ['pull', 'busy_blocks'],
    scopes: [{ key: 'calendar.busy.read', label: 'Read busy times', description: 'Reads when you are busy. Event titles and details are not stored.' }],
    fields: z.object({ url: urlField }).strict(), secrets: ['url'],
    async test(cfg) { const text = await fetchIcs(cfg.url); parseBusy(text, { tz: 'UTC', winStart: Date.now(), winEnd: Date.now() + 864e5 * 30 }); return { ok: true, message: 'Calendar readable' }; },
    async pull(cfg) { const text = await fetchIcs(cfg.url); const { busy } = parseBusy(text, { tz: 'UTC', winStart: Date.now(), winEnd: Date.now() + 864e5 * 60 }); return { summary: { busy_blocks: busy.length } }; },
  },
  sports_data_json: {
    category: 'sports_data', name: 'Sports data feed (JSON over HTTPS)', version: '1.0', auth: 'api_key', sandbox: true,
    capabilities: ['pull', 'sandbox', 'external_ids'],
    scopes: [{ key: 'sports_data.read', label: 'Read fixtures and results', description: 'Pulls fixture and result records from the provider. Nothing is sent to it.' }],
    fields: z.object({ url: urlField, api_key: z.string().min(8).max(500), sandbox_url: urlField.optional() }).strict(), secrets: ['api_key'],
    target: (cfg, mode) => (mode === 'sandbox' && cfg.sandbox_url ? cfg.sandbox_url : cfg.url),
    async call(cfg, mode) {
      const r = await send('GET', this.target(cfg, mode), { headers: { accept: 'application/json', authorization: `Bearer ${cfg.api_key}` } });
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error('The provider rejected the API key'), { permanent: true });
      if (r.status !== 200) throw new Error(`The provider answered ${r.status}`);
      let json; try { json = JSON.parse(r.text); } catch { throw Object.assign(new Error('The provider did not return JSON'), { permanent: true }); }
      return Array.isArray(json) ? json : (Array.isArray(json?.items) ? json.items : []);
    },
    async test(cfg, ctx) { const items = await this.call(cfg, ctx.mode); return { ok: true, message: `Reached the feed (${items.length} records)` }; },
    async pull(cfg, ctx) { const items = await this.call(cfg, ctx.mode); return { summary: { records: items.length } }; },
  },
  ticket_scanner_webhook: {
    category: 'ticket_scanner', name: 'Ticket scanner (signed webhook)', version: '1.0', auth: 'api_key', sandbox: true,
    capabilities: ['inbound_webhook', 'hmac_sha256', 'replay_protection'],
    scopes: [{ key: 'ticket_scans.write', label: 'Receive scan results', description: 'Accepts signed scan events from your scanner system. It cannot read anything back.' }],
    fields: z.object({ device_label: z.string().max(80).optional() }).strict(), secrets: [], generatesWebhookSecret: true,
    async test() { return { ok: true, message: 'Waiting for the first signed delivery' }; },
    inbound: {
      verify: (secret, raw, headers) => hmacOk(secret, raw, headers['x-sportarena-signature']),
      parse: (json) => (Array.isArray(json?.events) ? json.events : [json]).filter((e) => e && e.id).map((e) => ({ id: String(e.id).slice(0, 120), kind: String(e.type ?? 'scan').slice(0, 60) })),
    },
  },
  travel_sandbox: {
    category: 'travel', name: 'Travel partner sandbox (no real bookings)', version: '1.0', auth: 'api_key', sandbox: true,
    capabilities: ['hotel_search', 'flight_search', 'hold', 'book', 'cancel', 'inbound_webhook'],
    scopes: [{ key: 'travel.book', label: 'Search, hold and book travel', description: 'Sends the minimum booking details (names, and dates of birth for flights) of travellers who agreed. Passport numbers are never sent.' }],
    fields: z.object({}).strict(), secrets: [], generatesWebhookSecret: true,
    async test() { return { ok: true, message: 'Sandbox partner ready. Nothing real is booked.' }; },
    inbound: { verify: (secret, raw, headers) => hmacOk(secret, raw, headers['x-sportarena-signature']), parse: parseTravel },
  },
  travel_partner_https: {
    category: 'travel', name: 'Hotel and flight partner (JSON over HTTPS)', version: '1.0', auth: 'api_key', sandbox: true,
    capabilities: ['hotel_search', 'flight_search', 'hold', 'book', 'cancel', 'inbound_webhook', 'sandbox'],
    scopes: [{ key: 'travel.book', label: 'Search, hold and book travel', description: 'Sends the minimum booking details (names, and dates of birth for flights) of travellers who agreed. Passport numbers are never sent.' }],
    fields: z.object({ url: urlField, api_key: z.string().min(8).max(500), sandbox_url: urlField.optional() }).strict(), secrets: ['api_key'], generatesWebhookSecret: true,
    async test(cfg, ctx) {
      const base = (ctx.mode === 'sandbox' && cfg.sandbox_url ? cfg.sandbox_url : cfg.url).replace(/\/$/, '');
      const r = await send('GET', `${base}/health`, { headers: { accept: 'application/json', authorization: `Bearer ${cfg.api_key}` } });
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error('The partner rejected the API key'), { permanent: true });
      if (r.status !== 200) throw new Error(`The partner answered ${r.status}`);
      return { ok: true, message: 'Partner reachable' };
    },
    inbound: { verify: (secret, raw, headers) => hmacOk(secret, raw, headers['x-sportarena-signature']), parse: parseTravel },
  },
};

// ---- Athlete Performance Integration Hub (#583): wearable / performance providers. The organisation is authorised through the usual
// access gate; each athlete then connects their own account and owns the consent (see capabilities/wearables.js). Adapters: wearables/normalise.js.
const WEAR_SCOPES = [{ key: 'wearables.metrics.read', label: 'Read daily summaries', description: 'Heart rate, HRV, sleep, steps, distance, energy and training load as daily totals. Never location, messages or medical diagnoses.' }];
const wearable = (name, extra = {}) => ({
  category: 'wearables', name, version: '1.0', auth: 'oauth', sandbox: false, athlete_scoped: true, capabilities: ['athlete_consent', 'daily_metrics', 'unit_normalisation'],
  scopes: WEAR_SCOPES, fields: z.object({ base_url: urlField.optional() }).strict(), secrets: [], async test() { return { ok: true, message: 'Each athlete connects their own account' }; }, ...extra,
});
const GPS_SCOPES = [{ key: 'wearables.metrics.read', label: 'Read GPS and performance data', description: 'Sprint distance, max speed, training load and position data as daily totals. Never medical diagnoses.' }];
Object.assign(PROVIDERS, {
  oura: wearable('Oura'), whoop: wearable('WHOOP'), garmin: wearable('Garmin'), fitbit: wearable('Fitbit'), strava: wearable('Strava'),
  device_push: wearable('Apple Health / Health Connect (from the device app)', { auth: 'api_key', capabilities: ['athlete_consent', 'daily_metrics', 'unit_normalisation', 'device_push'] }),
  // Elite-academy providers added in #583 elite extensions
  polar: wearable('Polar (AccessLink v3)', { capabilities: ['athlete_consent', 'daily_metrics', 'unit_normalisation', 'sleep_quality', 'exercise_data'] }),
  catapult_opf: wearable('Catapult OpenField (GPS)', { scopes: GPS_SCOPES, capabilities: ['athlete_consent', 'daily_metrics', 'unit_normalisation', 'gps_tracking', 'sprint_data'] }),
});

// ---- Venue Booking Connectors (#1134): approved external venue booking partners.
// Each adapter is redirect/link-out only until a formal partner API agreement is in place.
import { buildLinkoutUrl as activeSgLinkout } from './providers/activesg.js';
import * as activeSgProvider from './providers/activesg.js';
import * as bmsProvider from './providers/bookmyshow.js';
import { inbound as sandboxInbound, test as sandboxTest, searchVenues, mockQuote } from './providers/venue-booking-sandbox.js';
Object.assign(PROVIDERS, {
  activesg_sg: {
    category: 'venue_booking', name: 'ActiveSG (Sport Singapore)', version: '1.0',
    auth: 'none', sandbox: false, country: 'SG',
    capabilities: ['redirect.out'],
    scopes: [{ key: 'venue.linkout', label: 'Open ActiveSG venue search', description: 'Provides a convenience link to ActiveSG for venue search and booking. No data is shared with ActiveSG automatically.' }],
    fields: z.object({}).strict(), secrets: [],
    linkout: activeSgLinkout,
    disclaimer: activeSgProvider.DISCLAIMER,
    async test() { return activeSgProvider.test(); },
  },
  bookmyshow_in: {
    category: 'venue_booking', name: 'BookMyShow (India sports events)', version: '1.0',
    auth: 'none', sandbox: false, country: 'IN',
    capabilities: ['redirect.out'],
    scopes: [{ key: 'venue.linkout', label: 'Open BookMyShow sports events', description: 'Provides a convenience link to BookMyShow sport event listings. No venue rental support.' }],
    fields: z.object({}).strict(), secrets: [],
    linkout: bmsProvider.buildLinkoutUrl,
    disclaimer: bmsProvider.DISCLAIMER,
    capability_note: bmsProvider.CAPABILITY_NOTE,
    async test() { return bmsProvider.test(); },
  },
  venue_booking_sandbox: {
    category: 'venue_booking', name: 'Venue Booking Sandbox (no real bookings)', version: '1.0',
    auth: 'api_key', sandbox: true, country: '',
    capabilities: ['redirect.out', 'venue.search', 'venue.availability.read', 'venue.price.quote', 'venue.hold', 'venue.book', 'venue.cancel', 'booking.status.read', 'booking.webhook'],
    scopes: [{ key: 'venue.book', label: 'Search, hold and book venues (sandbox)', description: 'Sandbox mock — searches synthetic venues, generates mock quotes and simulates webhooks. Nothing real is booked.' }],
    fields: z.object({}).strict(), secrets: [], generatesWebhookSecret: true,
    searchVenues, mockQuote,
    async test() { return sandboxTest(); },
    inbound: sandboxInbound,
  },
});

// ---- Event Source Connectors (#1135): providers that describe an event created outside GotMyGame.
// link_mode: what the connection can do (reference_only | read_sync | file_import).
// trust: the default trust level assigned to links made via this provider.
// SSRF: all URL fields go through checkTarget() before any outbound fetch; private/loopback IPs are always rejected.
Object.assign(PROVIDERS, {
  event_source_generic_url: {
    category: 'event_source', name: 'External event URL (reference only)', version: '1.0',
    auth: 'none', sandbox: false, link_mode: 'reference_only', trust: 'organiser_attested',
    capabilities: ['reference_link', 'manual_metadata'],
    scopes: [{ key: 'event_source.reference', label: 'Store a reference link', description: 'Saves the HTTPS link as an organiser-attested reference. No data is fetched from the URL automatically.' }],
    fields: z.object({}).strict(), secrets: [],
    async test() { return { ok: true, message: 'Reference link stored — no outbound connection is made.' }; },
  },
  event_source_bookmyshow_in: {
    category: 'event_source', name: 'BookMyShow India (event reference)', version: '1.0',
    auth: 'none', sandbox: false, country: 'IN', link_mode: 'reference_only', trust: 'organiser_attested',
    capabilities: ['reference_link', 'manual_metadata', 'linkout'],
    url_pattern: /^https:\/\/(in\.)?bookmyshow\.com\//,
    scopes: [{ key: 'event_source.reference', label: 'Store a BookMyShow event reference', description: 'Saves the BookMyShow sports event link as an organiser-attested reference. No data is scraped; ticket sales, attendee lists and refund policy remain with BookMyShow.' }],
    fields: z.object({}).strict(), secrets: [],
    disclaimer: 'BookMyShow is an independent platform. GotMyGame does not access BookMyShow's data APIs, participant records, or ticket inventory. The event organiser is responsible for ensuring they have authority over the event being linked.',
    async test() { return { ok: true, message: 'BookMyShow reference ready — no outbound connection required.' }; },
  },
  event_source_ics_feed: {
    category: 'event_source', name: 'Calendar / ICS feed', version: '1.0',
    auth: 'none', sandbox: false, link_mode: 'file_import', trust: 'organiser_attested',
    capabilities: ['ics_import', 'manual_metadata'],
    scopes: [{ key: 'event_source.ics', label: 'Import from an ICS calendar feed', description: 'Reads event details from an iCalendar feed URL or uploaded .ics file. Only the specified event is imported; personal calendar data is never stored.' }],
    fields: z.object({ url: urlField.optional() }).strict(), secrets: [],
    async test(cfg) {
      if (cfg.url) { const text = await fetchIcs(cfg.url); if (!text || text.length < 10) throw new Error('ICS feed returned no content'); }
      return { ok: true, message: 'ICS feed readable' };
    },
    async pull(cfg) {
      if (!cfg.url) return { summary: { events: 0 } };
      const text = await fetchIcs(cfg.url);
      const lines = text.split('\n').filter((l) => l.startsWith('VEVENT') || l.startsWith('BEGIN:VEVENT')).length;
      return { summary: { events: lines } };
    },
  },
  event_source_federation_xml: {
    category: 'event_source', name: 'Federation / league data feed', version: '1.0',
    auth: 'api_key', sandbox: true, link_mode: 'read_sync', trust: 'verified_source',
    capabilities: ['pull', 'read_sync', 'external_ids', 'sandbox'],
    scopes: [
      { key: 'event_source.read', label: 'Read event metadata', description: 'Pulls event title, dates, sport and venue from the federation or league feed. No participant personal data is imported.' },
      { key: 'event_source.fixtures', label: 'Read fixtures and schedule', description: 'Imports fixture schedule and published results when the organiser has governing rights.' },
    ],
    fields: z.object({ url: urlField, api_key: z.string().min(8).max(500), sandbox_url: urlField.optional() }).strict(), secrets: ['api_key'],
    target: (cfg, mode) => (mode === 'sandbox' && cfg.sandbox_url ? cfg.sandbox_url : cfg.url),
    async test(cfg, ctx) {
      const r = await send('GET', this.target(cfg, ctx?.mode ?? 'live'), { headers: { accept: 'application/json', authorization: `Bearer ${cfg.api_key}` } });
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error('The feed rejected the API key'), { permanent: true });
      if (r.status !== 200) throw new Error(`The feed answered ${r.status}`);
      return { ok: true, message: 'Federation feed reachable' };
    },
    async pull(cfg, ctx) {
      const r = await send('GET', this.target(cfg, ctx?.mode ?? 'live'), { headers: { accept: 'application/json', authorization: `Bearer ${cfg.api_key}` } });
      if (r.status !== 200) throw new Error(`Feed answered ${r.status}`);
      let json; try { json = JSON.parse(r.text); } catch { throw Object.assign(new Error('Feed did not return JSON'), { permanent: true }); }
      const events = Array.isArray(json) ? json : (Array.isArray(json?.events) ? json.events : []);
      return { summary: { events: events.length } };
    },
  },
  event_source_manual: {
    category: 'event_source', name: 'Manual / document reference', version: '1.0',
    auth: 'none', sandbox: false, link_mode: 'reference_only', trust: 'organiser_attested',
    capabilities: ['manual_metadata'],
    scopes: [{ key: 'event_source.manual', label: 'Manual event reference', description: 'All fields are entered manually by the organiser. No external system is connected; all data is organiser-attested.' }],
    fields: z.object({}).strict(), secrets: [],
    async test() { return { ok: true, message: 'Manual reference — no connectivity required.' }; },
  },
});

// Integrations that already have their own console. Listed so one catalogue shows everything; install is refused with a pointer, not duplicated.
export const MANAGED = [
  { key: 'payments_stripe_paypal', category: 'payments', name: 'Payments (Stripe, PayPal)', managed_in: 'PaymentsSetup' },
  { key: 'sso_oidc_saml', category: 'sso', name: 'Single sign-on and SCIM', managed_in: 'EnterpriseIdentity' },
  { key: 'comms_whatsapp_sms', category: 'email_sms', name: 'WhatsApp and SMS', managed_in: 'Communications' },
];

export const providerOf = (key) => PROVIDERS[key] ?? null;
export const describe = (key, p) => ({ key, category: p.category, name: p.name, version: p.version, auth: p.auth, sandbox: p.sandbox, country: p.country ?? null, capabilities: p.capabilities, scopes: p.scopes, credential_fields: p.secrets, fields: Object.keys(p.fields.shape), sync: typeof p.pull === 'function', inbound_webhook: !!p.inbound, managed_in: null, disclaimer: p.disclaimer ?? null, capability_note: p.capability_note ?? null });
