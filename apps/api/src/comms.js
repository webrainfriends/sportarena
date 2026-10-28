// Omnichannel planning for India: given a stored notification, decide whether it also goes out as an approved WhatsApp Business / SMS
// template, to whom, and with which (validated) variables. This hooks into notify.js `deliver()`, so there is ONE entry point for every
// module (academy, teams, venues, events, coaches, sponsors, tenders): they call notify() exactly as before.
//
// A message is queued (status 'pending') only when every gate passes: recipient is an adult with a verified, not-opted-out number and the
// channel switched on; the category is not muted (unless essential); a provider account and an active template exist; every template
// variable resolves from system data; the organisation is within its quota (unless essential). Gates are checked again at send time.
import { config } from './config.js';
import { blindIndex, decrypt, encrypt } from './crypto.js';
import { query } from './db.js';
import { CHANNELS, LOCALE_CODES, USE_CASES, formatVars, useCaseForKind } from './comms-catalogue.js';
import { adapterFor } from './comms-providers.js';

export const VARS_CTX = 'notification_deliveries.vars';
export const CONTACT_TABLE = { whatsapp: 'whatsapp_contacts', sms: 'sms_contacts' };
const BRAND = 'Gotmygame';
const TZ = 'Asia/Kolkata';
const dbOf = (db) => db ?? { query };

// ---------------------------------------------------------------- provider accounts
/** The provider account in force for a channel: the organisation's own if it has one, else the platform's. Effective-dated. */
export async function activeProvider(db, channel, orgId) {
  return (await dbOf(db).query(
    `SELECT * FROM comm_providers WHERE channel=$1 AND (organisation_id = $2 OR organisation_id IS NULL) AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
      ORDER BY organisation_id IS NULL LIMIT 1`, [channel, orgId ?? null])).rows[0] ?? null;
}
export const providerConfig = (row) => JSON.parse(decrypt(row.config_enc, 'comm_providers.config'));

// ---------------------------------------------------------------- consent, opt-out and suppression
/** Append one row to the consent evidence log (never updated or deleted). */
export const recordConsent = (db, userId, channel, action, source, { basis = 'consent', phoneIdx = null, note = null } = {}) =>
  dbOf(db).query('INSERT INTO comm_consents(user_id, channel, action, source, basis, phone_idx, note) VALUES ($1,$2,$3,$4,$5,$6,$7)', [userId, channel, action, source, basis, phoneIdx, note]);

/** A fresh, verified opt-in clears a STOP suppression on that number (the person proved control of it again). Hard provider blocks stay. */
export const liftStopSuppression = (db, phoneIdx, channel) =>
  dbOf(db).query("UPDATE comm_suppressions SET lifted_at=now() WHERE phone_idx=$1 AND channel=$2 AND lifted_at IS NULL AND reason='stop'", [phoneIdx, channel]);

/**
 * Opt a person out of a channel, effective immediately: the number is flagged, the switch goes off, a consent row is logged, queued messages
 * for that channel are suppressed, and (for STOP / provider blocks) the number is suppressed platform-wide.
 */
export async function optOut(db, userId, channel, { source, suppress = null, note = null }) {
  const d = dbOf(db), t = CONTACT_TABLE[channel];
  const contact = (await d.query(`UPDATE ${t} SET opted_out_at=coalesce(opted_out_at, now()), updated_at=now() WHERE user_id=$1 RETURNING phone_idx`, [userId])).rows[0];
  await d.query(`INSERT INTO notification_prefs(user_id, ${channel}) VALUES ($1,false) ON CONFLICT (user_id) DO UPDATE SET ${channel}=false`, [userId]);
  await recordConsent(d, userId, channel, 'opt_out', source, { phoneIdx: contact?.phone_idx ?? null, note });
  if (contact && suppress) await suppressNumber(d, contact.phone_idx, channel, suppress, source);
  await d.query(
    `UPDATE notification_deliveries d SET status='suppressed', last_error='opted_out', claimed_at=NULL FROM notifications n
      WHERE n.id=d.notification_id AND n.user_id=$1 AND d.channel=$2 AND d.provider IS NOT NULL AND d.status='pending'`, [userId, channel]);
}

export const suppressNumber = (db, phoneIdx, channel, reason, source) =>
  dbOf(db).query('INSERT INTO comm_suppressions(phone_idx, channel, reason, source) VALUES ($1,$2,$3,$4) ON CONFLICT (phone_idx, channel) WHERE lifted_at IS NULL DO NOTHING', [phoneIdx, channel, reason, source]);

/**
 * May this person get a message on this channel right now? Adults only; verified number; not opted out (STOP and removal bind every
 * message, essential or not); channel switched on; number not suppressed; and, unless essential, the category not muted.
 */
export async function eligible(db, userId, channel, { essential = false, category = null } = {}) {
  const d = dbOf(db);
  const row = (await d.query(
    `SELECT c.phone_idx, c.verified_at, c.opted_out_at, coalesce(p.${channel}, false) AS on_, coalesce(p.comm_categories_off, '{}') AS off, coalesce(p.comm_locale, 'en-IN') AS locale,
            u.display_name, (u.youth_until IS NOT NULL AND u.youth_until > current_date) AS youth
       FROM ${CONTACT_TABLE[channel]} c JOIN users u ON u.id=c.user_id LEFT JOIN notification_prefs p ON p.user_id=c.user_id WHERE c.user_id=$1`, [userId])).rows[0];
  if (!row) return { ok: false, reason: 'no_number' };
  if (row.youth) return { ok: false, reason: 'youth' }; // minors are never messaged directly; a guardian is notified as themselves
  if (!row.verified_at) return { ok: false, reason: 'unverified' };
  if (row.opted_out_at) return { ok: false, reason: 'opted_out' };
  if (!row.on_) return { ok: false, reason: 'switched_off' };
  if (!essential && category && row.off.includes(category)) return { ok: false, reason: 'category_off' };
  if ((await d.query('SELECT 1 FROM comm_suppressions WHERE phone_idx=$1 AND channel=$2 AND lifted_at IS NULL', [row.phone_idx, channel])).rowCount) return { ok: false, reason: 'suppressed' };
  return { ok: true, first_name: String(row.display_name ?? '').split(/\s+/)[0] || null, locale: LOCALE_CODES.includes(row.locale) ? row.locale : 'en-IN', phone_idx: row.phone_idx };
}

// ---------------------------------------------------------------- quotas and usage
const MONTH_START = `date_trunc('month', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'`;

/** The monthly allowance in force for an organisation and channel: its own row, else the platform default. null limit = unlimited. */
export async function quotaFor(db, orgId, channel) {
  return (await dbOf(db).query(
    `SELECT monthly_limit, addon_key, organisation_id FROM comm_quotas WHERE channel=$1 AND (organisation_id = $2 OR organisation_id IS NULL) AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
      ORDER BY organisation_id IS NULL LIMIT 1`, [channel, orgId ?? null])).rows[0] ?? null;
}
/** Messages this calendar month that were (or will be) handed to the provider. Failed, suppressed and fallbacks that never left do not count. */
export async function usedThisMonth(db, orgId, channel) {
  return (await dbOf(db).query(
    `SELECT count(*)::int AS n FROM notification_deliveries WHERE provider IS NOT NULL AND channel=$1 AND organisation_id IS NOT DISTINCT FROM $2
        AND status IN ('pending','sent','delivered','read') AND created_at >= ${MONTH_START}`, [channel, orgId ?? null])).rows[0].n;
}
/** Essential messages ignore the allowance, but not without limit: they stop at twice the allowance, so a runaway "urgent" flag cannot spend without bound. */
async function withinQuota(db, orgId, channel, essential) {
  if (!orgId) return true; // platform-level messages are not metered per organisation
  const q = await quotaFor(db, orgId, channel);
  return !q || q.monthly_limit == null || (await usedThisMonth(db, orgId, channel)) < q.monthly_limit * (essential ? 2 : 1);
}

// ---------------------------------------------------------------- variables (system-resolved, never caller free text)
/** The in-app destination a link opens, derived from ids on the notification. Same `?open=` mechanism the push notifications use. */
export function deepTarget(data = {}) {
  if (data.reservation_id) return `reservation:${data.reservation_id}`;
  if (data.open_game_id) return `open-game:${data.open_game_id}`;
  if (data.sponsorship_id) return `sponsorship:${data.sponsorship_id}`;
  if (data.project_id) return `tender:${data.project_id}`;
  if (data.event_id) return `event:${data.event_id}`;
  if (data.venue_id) return `venue:${data.venue_id}`;
  if (data.organisation_id) return `organisation:${data.organisation_id}`;
  return 'notifications';
}
export const deepLink = (data) => (config.appUrl ? `${String(config.appUrl).replace(/\/$/, '')}/?open=${encodeURIComponent(deepTarget(data))}` : null);

/** Raw values for the variables a template needs. Each is read from system tables by id; a missing source simply leaves the value out. */
async function resolveRaw(db, names, { userId, firstName, notification }) {
  const d = dbOf(db), data = notification.data ?? {};
  const cache = {};
  const once = (key, fn) => (key in cache ? cache[key] : (cache[key] = fn()));
  const orgName = () => once('org', async () => {
    const orgId = data.organisation_id ?? (data.event_id ? (await d.query('SELECT organisation_id FROM events WHERE id=$1', [data.event_id])).rows[0]?.organisation_id : null);
    return orgId ? (await d.query('SELECT name FROM organisations WHERE id=$1', [orgId])).rows[0]?.name ?? BRAND : BRAND;
  });
  const charge = () => once('charge', async () => data.charge_id
    ? (await d.query('SELECT currency, due_on::text AS due_on, amount_minor - settled_minor - adjusted_minor AS balance FROM academy_charges WHERE id=$1 AND organisation_id IS NOT DISTINCT FROM $2', [data.charge_id, data.organisation_id ?? null])).rows[0] ?? null
    : null);
  // a booking is only described to the person it belongs to; venue staff get the same notification data but not a customer-style message
  const booking = () => once('booking', async () => {
    if (data.booking_id) return (await d.query('SELECT b.starts_at, v.name AS venue_name FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id WHERE b.id=$1 AND b.user_id=$2', [data.booking_id, userId])).rows[0] ?? null;
    if (data.reservation_id) return (await d.query("SELECT b.starts_at, v.name AS venue_name FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id JOIN reservations rs ON rs.id=b.reservation_id WHERE b.reservation_id=$1 AND rs.user_id=$2 AND b.status<>'cancelled' ORDER BY b.starts_at LIMIT 1", [data.reservation_id, userId])).rows[0] ?? null;
    return null;
  });
  const out = {};
  for (const n of names) {
    if (n === 'first_name') out[n] = firstName;
    else if (n === 'org_name') out[n] = await orgName();
    else if (n === 'link') out[n] = deepLink(data);
    else if (n === 'amount') { const ch = await charge(); if (ch && Number(ch.balance) > 0) out[n] = { minor: Number(ch.balance), currency: ch.currency }; }
    else if (n === 'due_date') out[n] = (await charge())?.due_on;
    else if (n === 'venue_name') out[n] = (await booking())?.venue_name;
    else if (n === 'starts_at') out[n] = (await booking())?.starts_at;
    else if (n === 'event_name') out[n] = data.event_id ? (await d.query('SELECT name FROM events WHERE id=$1', [data.event_id])).rows[0]?.name : null;
    else if (n === 'team_name') out[n] = data.team_id ? (await d.query('SELECT name FROM teams WHERE id=$1', [data.team_id])).rows[0]?.name : null;
  }
  return out;
}

// ---------------------------------------------------------------- planning
/**
 * Build one channel's delivery for a notification, or say why not. `record` = worth showing the organisation (a configured, consenting
 * recipient was held back for an operational reason: no template, missing data or quota). Opt-outs and switches are the person's choice, not events.
 */
const CUSTOMER_ONLY = new Set(['venue_booking', 'venue_change', 'venue_cancellation', 'session_reminder']);

/** Booking messages are written to the customer: the same notification also goes to venue staff, who must never get a customer-style text. */
async function ownsBooking(d, userId, data) {
  if (data.booking_id) return !!(await d.query('SELECT 1 FROM bookings WHERE id=$1 AND user_id=$2', [data.booking_id, userId])).rowCount;
  if (data.reservation_id) return !!(await d.query('SELECT 1 FROM reservations WHERE id=$1 AND user_id=$2', [data.reservation_id, userId])).rowCount;
  return false;
}

/** The organisation a notification belongs to: named on it, else the one that owns its event or team. Decides the provider account, the quota and the activity list. */
export async function orgOf(db, data = {}) {
  if (data.organisation_id) return data.organisation_id;
  const d = dbOf(db);
  if (data.event_id) return (await d.query('SELECT organisation_id FROM events WHERE id=$1', [data.event_id])).rows[0]?.organisation_id ?? null;
  if (data.team_id) return (await d.query('SELECT organisation_id FROM teams WHERE id=$1', [data.team_id])).rows[0]?.organisation_id ?? null;
  return null;
}

export async function prepareChannel(db, { userId, notification, useCase, essential, channel, orgId }) {
  const d = dbOf(db), uc = USE_CASES[useCase];
  if (CUSTOMER_ONLY.has(useCase) && !(await ownsBooking(d, userId, notification.data ?? {}))) return { ok: false, reason: 'not_the_customer' };
  const provider = await activeProvider(d, channel, orgId);
  if (!provider) return { ok: false, reason: 'no_provider' };
  const who = await eligible(d, userId, channel, { essential, category: uc.category });
  if (!who.ok) return { ok: false, reason: who.reason };
  const held = (reason) => ({ ok: false, reason, record: { provider, orgId, locale: who.locale, reason } });
  const tpl = (await d.query(
    `SELECT * FROM comm_templates WHERE use_case=$1 AND channel=$2 AND state='active' AND (organisation_id = $3 OR organisation_id IS NULL) AND locale = ANY($4::text[])
      ORDER BY array_position($4::text[], locale), organisation_id IS NULL LIMIT 1`, [useCase, channel, orgId ?? null, [who.locale, 'en-IN', 'en']])).rows[0];
  if (!tpl) return held('no_template');
  if (!(await withinQuota(d, orgId, channel, essential))) return held('quota_exceeded');
  let vars;
  try { vars = formatVars(tpl.variables, await resolveRaw(d, tpl.variables.map((v) => v.name), { userId, firstName: who.first_name, notification })); }
  catch (e) { return held(`${e.kind === 'invalid' ? 'invalid' : 'missing'}_variable: ${String(e.variable ?? 'unknown').slice(0, 40)}`); }
  return { ok: true, provider, template: tpl, vars, locale: tpl.locale, orgId };
}

export async function insertDelivery(db, { notificationId, channel, useCase, essential, orgId, prepared, status = 'pending', reason = null, fallbackOf = null }) {
  const p = prepared;
  return (await dbOf(db).query(
    `INSERT INTO notification_deliveries(notification_id, channel, status, provider, template_id, use_case, essential, vars_enc, organisation_id, last_error, fallback_of, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL) ON CONFLICT (notification_id, channel) WHERE provider IS NOT NULL DO NOTHING RETURNING id`,
    [notificationId, channel, status, p.provider.kind, p.template?.id ?? null, useCase, essential, p.vars ? encrypt(JSON.stringify(p.vars), VARS_CTX) : null, orgId ?? null, reason, fallbackOf])).rows[0] ?? null;
}

/**
 * Called from notify() after the notification row exists. Returns { whatsappCloud } so the legacy free-text OpenWA path is skipped when a
 * template send was queued (no double WhatsApp). Never throws into the caller's transaction (the caller wraps it in a savepoint).
 */
export async function planComms(db, userId, n, msg) {
  const useCase = msg.comm?.use_case && USE_CASES[msg.comm.use_case] && !USE_CASES[msg.comm.use_case].system ? msg.comm.use_case : useCaseForKind(msg.kind);
  if (!useCase) return { whatsappCloud: false, blockLegacyWhatsapp: false };
  const essential = msg.comm?.essential ?? USE_CASES[useCase].essential ?? false;
  const orgId = await orgOf(db, msg.data);
  const notification = { id: n.id, kind: n.kind, data: msg.data ?? {} };
  // the legacy free-text WhatsApp path must honour the same switches: a muted category or a suppressed number is not messaged there either
  const legacy = await eligible(db, userId, 'whatsapp', { essential, category: USE_CASES[useCase].category });
  const blockLegacyWhatsapp = !legacy.ok && ['category_off', 'suppressed', 'opted_out'].includes(legacy.reason);
  for (const channel of CHANNELS) {
    const p = await prepareChannel(db, { userId, notification, useCase, essential, channel, orgId });
    if (p.ok) { await insertDelivery(db, { notificationId: n.id, channel, useCase, essential, orgId, prepared: p }); return { whatsappCloud: channel === 'whatsapp', blockLegacyWhatsapp }; }
    if (p.record) await insertDelivery(db, { notificationId: n.id, channel, useCase, essential, orgId, prepared: { provider: p.record.provider }, status: 'suppressed', reason: p.record.reason });
  }
  return { whatsappCloud: false, blockLegacyWhatsapp };
}

/**
 * Guard for the one-time code that proves a person controls a number. A number a provider has blocked or reported invalid is never texted;
 * and no number is sent more than 3 codes in 24 hours across all accounts (so nobody can be spammed through the verification form).
 */
export async function guardVerificationTarget(db, channel, digits) {
  const d = dbOf(db), idx = blindIndex(digits);
  if ((await d.query("SELECT 1 FROM comm_suppressions WHERE phone_idx=$1 AND channel=$2 AND lifted_at IS NULL AND reason <> 'stop'", [idx, channel])).rowCount) return { ok: false, reason: 'blocked' };
  const tag = `code:${channel}:${idx.slice(0, 24)}`;
  if ((await d.query("SELECT count(*)::int AS n FROM audit_log WHERE action='send_code' AND entity=$1 AND at > now() - interval '24 hours'", [tag])).rows[0].n >= 3) return { ok: false, reason: 'too_many' };
  await d.query("INSERT INTO audit_log(actor_id, action, entity, entity_id) VALUES (NULL,'send_code',$1,NULL)", [tag]);
  return { ok: true };
}

// ---------------------------------------------------------------- direct system messages (number verification)
/** Send a one-off system template (e.g. the verification code) straight through the active provider. Returns false when no provider / template is available. */
export async function sendSystem(db, { channel, digits, useCase, values, locale = 'en-IN' }) {
  const provider = await activeProvider(db, channel, null);
  if (!provider) return false;
  const tpl = (await dbOf(db).query(
    `SELECT * FROM comm_templates WHERE use_case=$1 AND channel=$2 AND state='active' AND organisation_id IS NULL AND locale = ANY($3::text[]) ORDER BY array_position($3::text[], locale) LIMIT 1`, [useCase, channel, [locale, 'en-IN', 'en']])).rows[0];
  if (!tpl) return false;
  const formatted = formatVars(tpl.variables, values);
  const text = tpl.body.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, k) => formatted[k] ?? '');
  await adapterFor(provider.kind).send({ cfg: providerConfig(provider), to: digits, template: tpl, formatted, text, reference: `sys:${useCase}:${Date.now()}` });
  return true;
}
