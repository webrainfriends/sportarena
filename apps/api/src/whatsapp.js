// WhatsApp channel. Messages go out through a self-hosted OpenWA gateway (https://github.com/rmyndharis/OpenWA, REST API, X-API-Key).
// A WhatsApp message is a `notification_deliveries` row with channel 'whatsapp'. It is opt-in (verified number + switch), never
// carries security codes or health / insurance content (allow-list below), and is paced because bursts get numbers banned.
// OpenWA reaches WhatsApp through reverse-engineered clients, so email / push / the in-app inbox always stay as the fallback.
import { config } from './config.js';
import { decrypt } from './crypto.js';
import { many, one, query } from './db.js';
import { failDelivery } from './notify.js';
import { audit } from './helpers.js';

const MAX_ATTEMPTS = 5;

/**
 * Only these kinds ever go to WhatsApp (an allow-list, so a new kind is private by default): bookings, teams, events and
 * invitations. Security (`security_*`), health, insurance, legal, payouts and anything clinical are not on it.
 */
const ALLOWED = /^(booking_(modified|cancelled|reminder|expired)|reservation_confirmed|new_booking|waitlist_(offer|expired)|slot_available|team_(invite|announcement|selection|attendance_request|task_assigned)|event_(invitation|announcement|schedule|cancelled|paused|resumed|waitlist|staff)|official_assignment|department_invite|venue_staff_added|enquiry_(reply|message|broadcast)|collections_(reminder|retry)|academy_payment_(received|part))$/;
export const whatsappKind = (kind) => ALLOWED.test(kind);

/** "+91 98765-43210" -> "919876543210" (digits, country code included; 8-15 digits per E.164). Null when it cannot be a phone number. */
export function normalizePhone(raw) {
  const s = String(raw ?? '').trim();
  const digits = s.replace(/[^\d]/g, '');
  if (!s.startsWith('+') && !s.startsWith('00')) return null; // a country code is required: guessing one would message a stranger
  const d = s.startsWith('00') ? digits.slice(2) : digits;
  return /^[1-9]\d{7,14}$/.test(d) ? d : null;
}
export const chatIdOf = (digits) => `${digits}@c.us`;

async function call(method, path, body, headers = {}) {
  const { url, apiKey } = config.whatsapp;
  const res = await fetch(`${url.replace(/\/$/, '')}/api${path}`, {
    method, signal: AbortSignal.timeout(15_000),
    headers: { accept: 'application/json', 'x-api-key': apiKey ?? '', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(`OpenWA answered ${res.status}${json?.message ? `: ${[].concat(json.message).join(', ').slice(0, 120)}` : ''}`), { status: res.status });
  return json;
}

/** The OpenWA calls we use. Replaceable in tests, like the push `senders`. */
export const gateway = {
  configured: () => !!config.whatsapp.url,
  createSession: (name) => call('POST', '/sessions', { name }),
  start: (sessionId) => call('POST', `/sessions/${encodeURIComponent(sessionId)}/start`),
  session: (sessionId) => call('GET', `/sessions/${encodeURIComponent(sessionId)}`),
  qr: (sessionId) => call('GET', `/sessions/${encodeURIComponent(sessionId)}/qr`),
  /** `idempotencyKey` makes a retry after a timeout safe: the same delivery is never sent twice. */
  sendText: (sessionId, digits, text, idempotencyKey) =>
    call('POST', `/sessions/${encodeURIComponent(sessionId)}/messages/send-text`, { chatId: chatIdOf(digits), text }, idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
};

/** The number a message goes out from: the owner's dedicated number when a platform admin granted one, else the platform number. */
export async function resolveSender(scope, db = { query }) {
  if (scope?.kind && scope?.id) {
    const own = (await db.query('SELECT id, openwa_session FROM whatsapp_senders WHERE scope_kind=$1 AND scope_id=$2 AND revoked_at IS NULL', [scope.kind, scope.id])).rows[0];
    if (own) return own;
  }
  const platform = (await db.query("SELECT id, openwa_session FROM whatsapp_senders WHERE scope_kind='platform' AND revoked_at IS NULL")).rows[0];
  if (platform) return platform;
  return config.whatsapp.defaultSession ? { id: null, openwa_session: config.whatsapp.defaultSession } : null;
}

/** Does this person get this kind on WhatsApp? Verified, not opted out, switched on, adult (minors are never messaged directly). */
export async function whatsappEligible(db, userId, kind) {
  if (!whatsappKind(kind)) return false;
  return !!(await db.query(
    `SELECT 1 FROM whatsapp_contacts w JOIN users u ON u.id=w.user_id
      WHERE w.user_id=$1 AND w.verified_at IS NOT NULL AND w.opted_out_at IS NULL AND (u.youth_until IS NULL OR u.youth_until <= current_date)`, [userId])).rowCount;
}

const textOf = (n) => `*${n.title}*\n${n.body}`.slice(0, 1000) + '\n\n— Sportarena · change this in Notifications';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Send every pending WhatsApp message, a few per cycle with a pause between them. Safe from several instances (claim first). */
export async function dispatchWhatsapp({ limit = config.whatsapp.perCycle } = {}) {
  const pending = Number((await one("SELECT count(*) AS n FROM notification_deliveries WHERE status='pending' AND channel='whatsapp' AND provider IS NULL")).n);
  if (!gateway.configured()) return { configured: false, pending, sent: 0, failed: 0 };
  const todo = await many(
    `SELECT d.id, d.attempts, n.id AS notification_id, n.title, n.body, n.data, n.user_id
       FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id
      WHERE d.status='pending' AND d.channel='whatsapp' AND d.provider IS NULL AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= now())
        AND (d.claimed_at IS NULL OR d.claimed_at < now() - interval '5 minutes') ORDER BY d.created_at LIMIT $1`, [limit]);
  const out = { configured: true, pending, sent: 0, failed: 0 };
  let first = true;
  for (const d of todo) {
    const claimed = await one("UPDATE notification_deliveries SET attempts=attempts+1, claimed_at=now() WHERE id=$1 AND status='pending' AND attempts=$2 RETURNING id", [d.id, d.attempts]);
    if (!claimed) continue;
    try {
      const contact = await one('SELECT phone_enc FROM whatsapp_contacts WHERE user_id=$1 AND verified_at IS NOT NULL AND opted_out_at IS NULL', [d.user_id]);
      if (!contact) { // opted out (or removed their number) after it was queued: nothing to send, and not an error
        await query("UPDATE notification_deliveries SET status='sent', sent_at=now(), last_error='no active WhatsApp number', claimed_at=NULL WHERE id=$1", [d.id]);
        continue;
      }
      const sender = await resolveSender(d.data?.sender_scope);
      if (!sender) throw new Error('no WhatsApp sender is linked');
      if (!first && config.whatsapp.minGapMs) await sleep(config.whatsapp.minGapMs * (1 + Math.random())); // jitter: steady, human-like pacing
      first = false;
      await audit(null, null, 'dispatch_whatsapp', 'notifications', d.notification_id);
      await gateway.sendText(sender.openwa_session, decrypt(contact.phone_enc, 'whatsapp_contacts.phone'), textOf(d), d.id);
      await query("UPDATE notification_deliveries SET status='sent', sent_at=now(), last_error=NULL, claimed_at=NULL WHERE id=$1", [d.id]);
      out.sent++;
    } catch (e) {
      out.failed++;
      await failDelivery('whatsapp', { ...d, attempts: d.attempts + 1 }, e, MAX_ATTEMPTS);
    }
  }
  out.pending = pending - out.sent;
  return out;
}
