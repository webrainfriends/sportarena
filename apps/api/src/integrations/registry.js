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

export const CATEGORIES = ['payments', 'sso', 'calendar', 'email_sms', 'wearables', 'video', 'federation_feed', 'accounting', 'ticket_scanner', 'sports_data', 'travel'];

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

// Integrations that already have their own console. Listed so one catalogue shows everything; install is refused with a pointer, not duplicated.
export const MANAGED = [
  { key: 'payments_stripe_paypal', category: 'payments', name: 'Payments (Stripe, PayPal)', managed_in: 'PaymentsSetup' },
  { key: 'sso_oidc_saml', category: 'sso', name: 'Single sign-on and SCIM', managed_in: 'EnterpriseIdentity' },
  { key: 'comms_whatsapp_sms', category: 'email_sms', name: 'WhatsApp and SMS', managed_in: 'Communications' },
];

export const providerOf = (key) => PROVIDERS[key] ?? null;
export const describe = (key, p) => ({ key, category: p.category, name: p.name, version: p.version, auth: p.auth, sandbox: p.sandbox, capabilities: p.capabilities, scopes: p.scopes, credential_fields: p.secrets, fields: Object.keys(p.fields.shape), sync: typeof p.pull === 'function', inbound_webhook: !!p.inbound, managed_in: null });
