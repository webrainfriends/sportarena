// Travel partner adapters (#704). One small interface over a hotel / flight partner, reached through an Integration Hub install
// (credentials, sandbox/live mode, rate limit and webhooks are the hub's). This is integration, not a booking engine: GotMyGame never holds
// inventory. Silence, a timeout, a non-2xx or a malformed answer is "unavailable" and never a booking; the trip keeps its typed references.
//   search(q)            -> [offer]            offer = { offer_ref, kind, summary, starts_at, ends_at, tz, price_minor, currency, terms, rooms? }
//   hold(offer_ref, ctx) -> { partner_ref, price_minor, currency, terms, cancel_by }
//   book(partner_ref, ctx) -> { partner_ref, status }
//   cancel(partner_ref)  -> { status, refund_minor? }
// `ctx.travellers` carries only what the booking needs (name, date of birth for air) for people who consented; never a document number.
import { createHash, randomBytes } from 'node:crypto';
import { decrypt } from '../crypto.js';
import { query } from '../db.js';
import { AppError } from '../errors.js';
import { send } from '../integrations/http.js';
import { allowCall, countFailure, loadConfig, scrub } from '../integrations/engine.js';
import { providerOf } from '../integrations/registry.js';

const DAY = 864e5;
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const dec = (s) => { try { return JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8')); } catch { throw new AppError(400, 'bad_request', 'That offer is not valid. Search again.'); } };
const unavailable = (why = 'The travel partner is not reachable right now. Record the booking by hand instead.') => new AppError(503, 'travel_partner_unavailable', why);

// ---- deterministic sandbox partner: no network, no stored fixtures. Prices come from the parameters, so a tampered offer_ref cannot lower a price.
const nights = (a, b) => Math.max(1, Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY));
const hash = (s) => parseInt(createHash('sha256').update(s).digest('hex').slice(0, 6), 16);
const stubFor = (variant = 0) => ({
  async search(q) {
    if (q.kind === 'stay') {
      const n = nights(q.check_in_on, q.check_out_on), seed = hash(`${q.destination}|${q.country ?? ''}`);
      const base = Math.round((450000 + (seed % 900000)) * (1 + variant));                                   // minor units per room-night
      return [['Flexible rate', base, true], ['Saver rate (non-refundable)', Math.round(base * 0.82), false]].map(([label, rate, refundable], k) => {
        const p = { v: 1, kind: 'stay', k, destination: q.destination, country: q.country ?? null, check_in_on: q.check_in_on, check_out_on: q.check_out_on, rooms: q.rooms, tz: q.tz, currency: q.currency, rate, refundable, label };
        return { offer_ref: enc(p), kind: 'stay', summary: `${q.destination} stay, ${label}`, property_name: `${q.destination} ${k ? 'Lodge' : 'Hotel'}`, starts_at: localTo(q.check_in_on, '14:00', q.tz), ends_at: localTo(q.check_out_on, '11:00', q.tz), tz: q.tz, price_minor: rate * n * q.rooms, currency: q.currency, rooms: q.rooms, terms: termsOf(refundable, q.check_in_on, q.tz) };
      });
    }
    const seed = hash(`${q.origin}|${q.destination}`), fare = Math.round((350000 + (seed % 900000)) * (1 + variant)), hours = 2 + (seed % 9);
    return [['Flexible fare', Math.round(fare * 1.25), true, '08:30'], ['Saver fare (non-refundable)', fare, false, '13:10']].map(([label, per, refundable, at], k) => {
      const starts = localTo(q.depart_on, at, q.origin_tz), ends = new Date(Date.parse(starts) + hours * 36e5).toISOString();
      const p = { v: 1, kind: 'air', k, origin: q.origin, destination: q.destination, depart_on: q.depart_on, origin_tz: q.origin_tz, destination_tz: q.destination_tz, pax: q.pax, currency: q.currency, per, refundable, label, starts, ends };
      return { offer_ref: enc(p), kind: 'air', summary: `${q.origin} → ${q.destination}, ${label}`, starts_at: starts, ends_at: ends, tz: q.origin_tz, arrive_tz: q.destination_tz, price_minor: per * q.pax, currency: q.currency, terms: termsOf(refundable, q.depart_on, q.origin_tz) };
    });
  },
  async hold(offer_ref) {
    const p = dec(offer_ref); if (p.v !== 1) throw new AppError(400, 'bad_request', 'That offer is not valid. Search again.');
    const price = p.kind === 'stay' ? p.rate * nights(p.check_in_on, p.check_out_on) * p.rooms : p.per * p.pax;
    return { partner_ref: `SBX-${randomBytes(4).toString('hex').toUpperCase()}`, price_minor: price, currency: p.currency, terms: termsOf(p.refundable, p.kind === 'stay' ? p.check_in_on : p.depart_on, p.kind === 'stay' ? p.tz : p.origin_tz), offer: p };
  },
  async book(partner_ref) { return { partner_ref, status: 'booked' }; },
  async cancel() { return { status: 'cancelled' }; },
});
function localTo(day, hhmm, tz) {                                                 // a wall-clock time in an IANA zone -> UTC instant
  const guess = Date.parse(`${day}T${hhmm}:00Z`);
  const off = (t) => { const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t)); const g = Object.fromEntries(f.map((x) => [x.type, x.value])); return Date.UTC(g.year, g.month - 1, g.day, g.hour, g.minute, g.second) - t; };
  return new Date(guess - off(guess - off(guess))).toISOString();
}
function termsOf(refundable, day, tz) {
  return refundable ? { refundable: true, free_cancel_until: new Date(Date.parse(localTo(day, '00:00', tz)) - 2 * DAY).toISOString(), note: 'Free cancellation until 48 hours before.' }
    : { refundable: false, free_cancel_until: null, note: 'Non-refundable. Changes are not allowed.' };
}

// ---- generic HTTPS partner (affiliate or API). JSON in, JSON out, bearer key from the install; paths are fixed.
const call = (cfg, mode, path, body) => async () => {
  const base = (mode === 'sandbox' && cfg.sandbox_url ? cfg.sandbox_url : cfg.url).replace(/\/$/, '');
  let r;
  try { r = await send('POST', `${base}${path}`, { headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${cfg.api_key}` }, body: JSON.stringify(body) }); }
  catch (e) { throw unavailable(scrub(e.message, cfg)); }
  if (r.status === 401 || r.status === 403) throw unavailable('The travel partner rejected our credentials. Ask an organisation admin to rotate them.');
  if (r.status < 200 || r.status >= 300) throw unavailable(`The travel partner answered ${r.status}.`);
  try { return JSON.parse(r.text); } catch { throw unavailable('The travel partner sent an unreadable answer.'); }
};
const https = (cfg, mode) => ({
  async search(q) { const j = await call(cfg, mode, '/search', q)(); return (Array.isArray(j?.offers) ? j.offers : []).map(cleanOffer).filter(Boolean); },
  async hold(offer_ref, ctx) {
    const j = await call(cfg, mode, '/hold', { offer_ref, travellers: ctx.travellers })();
    if (!j?.partner_ref || !Number.isInteger(j.price_minor) || !/^[A-Z]{3}$/.test(j.currency ?? '')) throw unavailable('The travel partner did not confirm the hold.');
    return { partner_ref: String(j.partner_ref).slice(0, 120), price_minor: j.price_minor, currency: j.currency, terms: j.terms ?? {}, cancel_by: j.cancel_by ?? null };
  },
  async book(partner_ref) { const j = await call(cfg, mode, '/book', { partner_ref })(); if (j?.status !== 'booked') throw unavailable('The travel partner did not confirm the booking.'); return { partner_ref, status: 'booked' }; },
  async cancel(partner_ref) { const j = await call(cfg, mode, '/cancel', { partner_ref })(); if (j?.status !== 'cancelled') throw unavailable('The travel partner did not confirm the cancellation.'); return { status: 'cancelled' }; },
});
function cleanOffer(o) {
  if (!o || typeof o.offer_ref !== 'string' || !Number.isInteger(o.price_minor) || !/^[A-Z]{3}$/.test(o.currency ?? '') || Number.isNaN(Date.parse(o.starts_at)) || Number.isNaN(Date.parse(o.ends_at))) return null;
  return { offer_ref: o.offer_ref.slice(0, 500), kind: o.kind === 'air' ? 'air' : 'stay', summary: String(o.summary ?? '').slice(0, 300), property_name: o.property_name ? String(o.property_name).slice(0, 160) : undefined, starts_at: o.starts_at, ends_at: o.ends_at, tz: String(o.tz ?? 'UTC'), arrive_tz: o.arrive_tz ? String(o.arrive_tz) : undefined, price_minor: o.price_minor, currency: o.currency, rooms: o.rooms, terms: o.terms && typeof o.terms === 'object' ? o.terms : {} };
}

// ---- who we can talk to --------------------------------------------------------------------------------------------------------------------
// A "connection" is either the organisation's own Integration Hub install (scope 'install') or a channel partner the platform admin connected for
// regions (scope 'channel'). Both speak the same adapter interface; `key` is how an offer or booking points back at it.
export const PRESETS = {
  booking_com: { name: 'Booking.com', kinds: ['stay'] }, makemytrip: { name: 'MakeMyTrip', kinds: ['stay', 'air'] }, trip_com: { name: 'Trip.com', kinds: ['stay', 'air'] },
  agoda: { name: 'Agoda', kinds: ['stay'] }, expedia: { name: 'Expedia Group', kinds: ['stay', 'air'] }, other: { name: 'Other channel partner', kinds: ['stay', 'air'] }, sandbox: { name: 'Sandbox (no real bookings)', kinds: ['stay', 'air'] },
};
// Per-site translators. The generic HTTPS adapter speaks the GotMyGame JSON contract (docs/team-travel.md). A named site whose own API differs is plugged in
// here as { search, hold, book, cancel, parseWebhook } without touching the trip code; none is shipped because each needs that site's agreement and credentials.
export const MAPPERS = {};

const channelConn = (r) => ({ scope: 'channel', key: `channel:${r.id}`, id: r.id, provider_key: r.provider_key, preset: r.preset, label: r.label, mode: r.mode, status: r.status, kinds: r.kinds, regions: r.regions, priority: r.priority, rate: r.rate_per_minute, row: r });
const installConn = (r) => ({ scope: 'install', key: `install:${r.id}`, id: r.id, provider_key: r.provider_key, preset: r.provider_key === 'travel_sandbox' ? 'sandbox' : 'other', label: r.label, mode: r.mode, status: r.status, kinds: ['stay', 'air'], regions: [], priority: 0, rate: r.rate_per_minute, row: r });
export const publicConn = (cn) => ({ key: cn.key, label: cn.label, preset: cn.preset, scope: cn.scope, mode: cn.mode });

const windows = new Map();                                                      // channel partners: a one-minute window per partner (per process)
const allowChannel = (cn) => { const m = Math.floor(Date.now() / 60000), w = windows.get(cn.id); if (!w || w.m !== m) { windows.set(cn.id, { m, n: 1 }); return true; } return ++w.n <= cn.rate; };

/** The adapter for one connection, or null when it is not connected. */
export async function adapterFor(cn, { existing = false } = {}) {
  if (!cn) return null;
  const okStatus = cn.scope === 'install' ? cn.status === 'connected' : (cn.status === 'active' || (existing && cn.status === 'paused'));
  if (!okStatus) return null;
  const p = providerOf(cn.provider_key);
  if (!p || p.category !== 'travel') return null;
  const allowed = cn.scope === 'install' ? await allowCall(cn.row) : allowChannel(cn);
  if (!allowed) throw new AppError(429, 'rate_limited', `The travel connection "${cn.label}" is over its rate limit. Try again in a minute.`);
  const mapper = MAPPERS[cn.preset];
  const base = cn.provider_key === 'travel_sandbox' ? stubFor(cn.scope === 'channel' ? (hash(cn.label) % 15) / 100 : 0) : (mapper ?? https(cn.scope === 'install' ? await loadConfig(cn.row) : JSON.parse(decrypt(cn.row.config_enc, CHANNEL_CTX)), cn.mode));
  const fail = async (e) => {
    if (e.code !== 'travel_partner_unavailable') return;
    if (cn.scope === 'install') await countFailure(cn.id); else await query('UPDATE travel_channel_partners SET last_error=$2, updated_at=now() WHERE id=$1', [cn.id, String(e.message).slice(0, 300)]);
  };
  return Object.fromEntries(Object.entries(base).map(([k, f]) => [k, async (...x) => { try { return await f(...x); } catch (e) { await fail(e); throw e; } }]));
}
export const CHANNEL_CTX = 'travel_channel_partners.config';
export const CHANNEL_HOOK_CTX = 'travel_channel_partners.webhook_secret';

const tripCountry = (trip) => trip.destination_country ?? null;
const org = async (c, trip) => trip.organisation_id ?? (trip.team_id ? (await c.query('SELECT organisation_id FROM teams WHERE id=$1', [trip.team_id])).rows[0]?.organisation_id : null);

/** Every connection that can serve this trip for this kind and destination: the organisation's own travel connection, then the platform's channel partners for the region. */
export async function connectionsFor(c, trip, { kind, country = null } = {}) {
  const out = [];
  const o = await org(c, trip);
  if (o) {
    const i = (await c.query(
      `SELECT i.* FROM integration_installs i WHERE i.organisation_id=$1 AND i.category='travel' AND i.status='connected'
          AND (i.event_id IS NULL OR i.event_id IN (SELECT event_id FROM trip_events WHERE trip_id=$2 AND unlinked_at IS NULL))
        ORDER BY (i.event_id IS NOT NULL) DESC, i.created_at DESC LIMIT 1`, [o, trip.id])).rows[0];
    if (i) out.push(installConn(i));
  }
  const cc = country ?? tripCountry(trip);
  const rows = (await c.query(
    `SELECT * FROM travel_channel_partners WHERE status='active' AND archived_at IS NULL AND $1 = ANY(kinds)
        AND (cardinality(regions) = 0 OR ($2::text IS NOT NULL AND $2 = ANY(regions))) ORDER BY priority, label`, [kind, cc])).rows;
  return [...out, ...rows.map(channelConn)];
}

/** Re-load a connection named by an offer's key, and check it still serves this kind and destination. Throws 404 style errors as null. */
export async function connectionByKey(c, trip, key, { kind, country = null } = {}) {
  return (await connectionsFor(c, trip, { kind, country })).find((x) => x.key === key) ?? null;
}

/** The connection behind an existing booking (also when its channel partner has since been paused: the booking must still be confirmable and cancellable). */
export async function connectionOfBooking(c, b) {
  if (b.channel_partner_id) { const r = (await c.query('SELECT * FROM travel_channel_partners WHERE id=$1', [b.channel_partner_id])).rows[0]; return r ? channelConn(r) : null; }
  if (b.install_id) { const r = (await c.query('SELECT * FROM integration_installs WHERE id=$1', [b.install_id])).rows[0]; return r ? installConn(r) : null; }
  return null;
}
