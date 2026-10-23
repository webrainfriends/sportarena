// Notifications: in-app inbox (instant) + email queue (sent by the dispatcher through a webhook you configure).
// Callers pass their transaction client so a rolled-back booking never leaves a stray notification behind.
import { pool, query, many, one, tx } from './db.js';
import { logger } from './logger.js';
import { recordStep } from './metrics.js';
import { backoffMs, enqueue, recordDead, requeueHooks, runJobs } from './jobs.js';
import { config } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import { audit } from './helpers.js';

export const DEFAULT_PREFS = { in_app: true, email: true, push: true, whatsapp: false, reminder_hours: 24, muted_kinds: [] };

/**
 * Notify one user. An optional `dedupe_key` (e.g. `billboard_response:<id>:owner`) makes the call idempotent per recipient. Respects their channel switches and muted kinds.
 * Inside a caller's transaction the writes run in a SAVEPOINT: if the notification cannot be stored, only the notification is
 * rolled back (the money / hold / booking change commits) and a durable `notify.retry` job is written to try again later.
 */
export async function notify(c, userId, msg) {
  if (!c) return deliver(pool, null, userId, msg);
  await c.query('SAVEPOINT notify_sp');
  try {
    const n = await deliver(c, c, userId, msg);
    await c.query('RELEASE SAVEPOINT notify_sp');
    return n;
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT notify_sp'); // throws (and aborts the caller) only if the connection itself is broken
    logger.warn('notification deferred to retry job', { kind: msg.kind, error: String(e.message).slice(0, 200) });
    await c.query('SAVEPOINT notify_job_sp');
    try { await enqueue(c, { category: 'notify', kind: 'notify.retry', payload: { user_id: userId, ...msg }, maxAttempts: 8 }); await c.query('RELEASE SAVEPOINT notify_job_sp'); }
    catch (e2) { await c.query('ROLLBACK TO SAVEPOINT notify_job_sp'); logger.error('could not defer notification', { error: String(e2.message).slice(0, 200) }); }
    return null;
  }
}

async function deliver(db, c, userId, { kind, title, body, data = {}, dedupe_key = null }) {
  const prefs = (await db.query('SELECT * FROM notification_prefs WHERE user_id=$1', [userId])).rows[0] ?? DEFAULT_PREFS;
  if (prefs.muted_kinds.includes(kind) || (!prefs.in_app && !prefs.email && prefs.push === false && !prefs.whatsapp)) return null;
  const n = (await db.query('INSERT INTO notifications(user_id, kind, title, body, data, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING *', [userId, kind, title, body, data, dedupe_key])).rows[0];
  if (!n) return null; // same business event already notified for this recipient
  if (prefs.email) await db.query("INSERT INTO notification_deliveries(notification_id, channel) VALUES ($1,'email')", [n.id]);
  if (!prefs.in_app) await db.query('UPDATE notifications SET read_at=now() WHERE id=$1', [n.id]); // no in-app channel: keep the inbox clean
  // push goes straight to the person's phones / browsers, as soon as the data is committed
  if (prefs.push !== false && (await db.query('SELECT 1 FROM push_devices WHERE user_id=$1 AND disabled_at IS NULL LIMIT 1', [userId])).rowCount) {
    await db.query("INSERT INTO notification_deliveries(notification_id, channel) VALUES ($1,'push')", [n.id]);
    const kick = () => import('./push.js').then((m) => m.dispatchPush()).catch((e) => console.error('[push]', e.message));
    if (c?.afterCommit) c.afterCommit(kick); else setImmediate(kick);
  }
  // WhatsApp is opt-in (verified number + switch) and limited to an allow-list of kinds; the worker sends it paced
  if (prefs.whatsapp && await (await import('./whatsapp.js')).whatsappEligible(db, userId, kind)) await db.query("INSERT INTO notification_deliveries(notification_id, channel) VALUES ($1,'whatsapp')", [n.id]);
  return n;
}

/**
 * Security email (verification link, password reset, alerts). Always sent: ignores mute and channel preferences, and is marked
 * read so it never shows as an unread inbox item. A one-time secret is kept encrypted in data.secret_enc and substituted for
 * {{secret}} only when the email is dispatched, then erased - the plaintext secret is never stored in the outbox.
 */
export async function notifySecurity(userId, { kind, title, body, secret = null }) {
  const data = secret ? { secret_enc: encrypt(secret, 'notifications.secret') } : {};
  const n = (await query('INSERT INTO notifications(user_id, kind, title, body, data, read_at) VALUES ($1,$2,$3,$4,$5, now()) RETURNING id', [userId, kind, title, body, data])).rows[0];
  await query("INSERT INTO notification_deliveries(notification_id, channel) VALUES ($1,'email')", [n.id]);
  setImmediate(() => dispatchPending().catch(() => {})); // deliver promptly when a webhook is configured
  return n.id;
}

/** Everyone who runs a venue: owner + staff. */
export async function venueTeam(c, venueId) {
  const { rows } = await (c ?? pool).query('SELECT owner_id AS user_id FROM venues WHERE id=$1 UNION SELECT user_id FROM venue_staff WHERE venue_id=$1 AND removed_at IS NULL', [venueId]);
  return rows.map((r) => r.user_id);
}

/** Tell the venue team (if the venue wants that), skipping the person who did it themselves. */
export async function notifyVenueTeam(c, venue, exceptUserId, msg) {
  if (!venue.notify_owner) return;
  for (const u of await venueTeam(c, venue.id)) if (u !== exceptUserId) await notify(c, u, msg);
}

/**
 * Queue reminders for bookings starting within each user's reminder window. Rows are locked (SKIP LOCKED, so several instances
 * never double-send) and `reminded_at` is set in the SAME transaction as the notification: a crash before commit leaves the
 * booking un-reminded (retried), never marked-but-unsent. A notification that cannot be stored becomes a durable retry job
 * (see notify()), so the reminder is still accounted for.
 */
export async function queueReminders({ limit = 200 } = {}) {
  return tx(async (c) => {
    const { rows } = await c.query(
      `SELECT b.id, b.user_id, b.starts_at, r.name AS resource_name, v.name AS venue_name, v.id AS venue_id, b.reservation_id
         FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id JOIN reservations rs ON rs.id=b.reservation_id
         LEFT JOIN notification_prefs p ON p.user_id = rs.user_id
        WHERE b.status='confirmed' AND b.reminded_at IS NULL
          AND b.starts_at > now() AND b.starts_at <= now() + make_interval(hours => coalesce(p.reminder_hours, 24))
        ORDER BY b.starts_at LIMIT $1 FOR UPDATE OF b SKIP LOCKED`, [limit]);
    for (const b of rows) {
      await notify(c, b.user_id, {
        kind: 'booking_reminder', title: `Coming up: ${b.resource_name} at ${b.venue_name}`,
        body: `Your booking starts ${b.starts_at.toISOString()}. Need to change plans? Modify or cancel in the app.`,
        data: { booking_id: b.id, reservation_id: b.reservation_id, venue_id: b.venue_id },
      });
      await c.query('UPDATE bookings SET reminded_at = now() WHERE id=$1', [b.id]);
    }
    return rows.length;
  });
}

const EMAIL_LEASE = "interval '5 minutes'";

/**
 * Send queued emails via NOTIFY_WEBHOOK_URL (your SES/Sendgrid/n8n bridge). Without it they simply stay queued.
 * Deliveries are claimed with FOR UPDATE SKIP LOCKED plus a lease (a crashed sender's claim expires), failures back off
 * exponentially, and a delivery that runs out of attempts is dead-lettered (visible to admins, requeueable).
 */
export async function dispatchPending({ limit = 50 } = {}) {
  const url = config.notifyWebhook.url;
  const pending = Number((await one("SELECT count(*) AS n FROM notification_deliveries WHERE status='pending' AND channel='email'")).n);
  if (!url) return { configured: false, pending, sent: 0, failed: 0 };
  let sent = 0, failed = 0;
  const { rows } = await query(
    `WITH due AS (
       SELECT id FROM notification_deliveries
        WHERE status='pending' AND channel='email' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          AND (claimed_at IS NULL OR claimed_at < now() - ${EMAIL_LEASE})
        ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED),
     claimed AS (UPDATE notification_deliveries d SET attempts=d.attempts+1, claimed_at=now() FROM due WHERE d.id=due.id RETURNING d.id, d.attempts, d.notification_id)
     SELECT c.id, c.attempts, n.id AS notification_id, n.kind, n.title, n.body, n.data, n.user_id, u.email_enc
       FROM claimed c JOIN notifications n ON n.id=c.notification_id JOIN users u ON u.id=n.user_id ORDER BY n.created_at`, [limit]);
  for (const d of rows) {
    try {
      await audit(null, null, 'dispatch_email', 'notifications', d.notification_id);
      const res = await fetch(url, {
        method: 'POST', signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json', ...(config.notifyWebhook.secret ? { authorization: `Bearer ${config.notifyWebhook.secret}` } : {}) },
        body: JSON.stringify({ channel: 'email', to: decrypt(d.email_enc, 'users.email'), subject: d.title, text: d.data?.secret_enc ? d.body.replaceAll('{{secret}}', decrypt(d.data.secret_enc, 'notifications.secret')) : d.body, kind: d.kind, data: { ...d.data, secret_enc: undefined }, notification_id: d.notification_id }),
      });
      if (!res.ok) throw new Error(`webhook answered ${res.status}`);
      await query("UPDATE notification_deliveries SET status='sent', sent_at=now(), last_error=NULL WHERE id=$1", [d.id]);
      if (d.data?.secret_enc) await query("UPDATE notifications SET data = data - 'secret_enc', body = replace(body, '{{secret}}', '[sent by email]') WHERE id=$1", [d.notification_id]);
      sent++;
    } catch (e) {
      failed++;
      await failDelivery('email', d, e);
    }
  }
  return { configured: true, pending: pending - sent, sent, failed };
}

export const DELIVERY_MAX_ATTEMPTS = 5;

/** Record a failed email/push delivery: back off, or after the last attempt mark it failed and dead-letter it. */
export async function failDelivery(channel, d, error, maxAttempts = DELIVERY_MAX_ATTEMPTS) {
  const msg = String(error?.message ?? error).slice(0, 300);
  const dead = d.attempts >= maxAttempts;
  await query(
    `UPDATE notification_deliveries SET last_error=$2, claimed_at=NULL, status=CASE WHEN $3::boolean THEN 'failed' ELSE 'pending' END,
            next_attempt_at=CASE WHEN $3::boolean THEN NULL ELSE now() + make_interval(secs => $4::float8) END WHERE id=$1`,
    [d.id, msg, dead, backoffMs(d.attempts, { baseMs: 20_000, capMs: 1_800_000 }) / 1000]);
  if (dead) await recordDead(null, { category: channel, kind: `${channel}.delivery`, dedupeKey: d.id, payload: { delivery_id: d.id, notification_id: d.notification_id }, error: msg, attempts: d.attempts });
}

// A dead delivery goes back to pending with a fresh attempt budget.
for (const channel of ['email', 'push', 'whatsapp']) {
  requeueHooks[`${channel}.delivery`] = async ({ delivery_id }) => {
    await query("UPDATE notification_deliveries SET status='pending', attempts=0, claimed_at=NULL, next_attempt_at=NULL WHERE id=$1 AND status='failed'", [delivery_id]);
  };
}

/** Retry a notification that could not be stored inside its originating transaction. */
export const notifyHandlers = {
  'notify.retry': async ({ user_id, ...msg }) => { await notify(null, user_id, msg); },
};

/**
 * Health reminders, atomically claimed (safe on several instances). Wording is generic on purpose: email and push leave the
 * system in clear text, so they never say what the appointment or follow-up is about. Users' mute settings still apply (notify()).
 * As with booking reminders, the sent-marker is committed together with the notification.
 */
export async function queueHealthReminders({ limit = 200 } = {}) {
  const appts = await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT a.id, a.athlete_id, a.provider_id, a.starts_at FROM appointments a JOIN users u ON u.id = a.athlete_id
         LEFT JOIN notification_prefs p ON p.user_id = u.id
        WHERE a.status = 'confirmed' AND a.reminded_at IS NULL AND a.starts_at > now()
          AND a.starts_at <= now() + make_interval(hours => coalesce(p.reminder_hours, 24))
        ORDER BY a.starts_at LIMIT $1 FOR UPDATE OF a SKIP LOCKED`, [limit]);
    for (const a of rows) {
      for (const uid of [a.athlete_id, a.provider_id]) await notify(c, uid, { kind: 'appointment_reminder', title: 'Appointment coming up', body: `You have an appointment on ${a.starts_at.toISOString()}.`, data: { appointment_id: a.id } });
      await c.query('UPDATE appointments SET reminded_at = now() WHERE id=$1', [a.id]);
    }
    return rows.length;
  });
  const fups = await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT f.id, f.athlete_id FROM appointment_followups f JOIN users u ON u.id = f.athlete_id LEFT JOIN notification_prefs p ON p.user_id = u.id
        WHERE f.status = 'due' AND f.reminder_sent_at IS NULL AND f.due_on <= current_date + ceil(coalesce(p.reminder_hours, 24) / 24.0)::int
        ORDER BY f.due_on LIMIT $1 FOR UPDATE OF f SKIP LOCKED`, [limit]);
    for (const f of rows) {
      await notify(c, f.athlete_id, { kind: 'followup_reminder', title: 'Follow-up due', body: 'You have a follow-up coming up. Open Health to book it.', data: { followup_id: f.id } });
      await c.query('UPDATE appointment_followups SET reminder_sent_at = now() WHERE id=$1', [f.id]);
    }
    return rows.length;
  });
  return appts + fups;
}

/** Run one step so its failure cannot stop the next one. */
export async function isolated(category, fn, fallback = null) {
  const t0 = performance.now();
  try { const value = await fn(); recordStep(category, { ok: true, ms: performance.now() - t0 }); return { ok: true, value }; }
  catch (e) {
    const error = String(e.message).slice(0, 300);
    recordStep(category, { ok: false, ms: performance.now() - t0, error });
    logger.error('maintenance step failed', { category, error });
    return { ok: false, error, value: fallback };
  }
}

/** One tick of the background worker. Reminders, retries, push and email are independent: one failing never blocks the rest. */
export async function notificationCycle() {
  const { dispatchPush } = await import('./push.js');
  const reminders = await isolated('reminders', async () => (await queueReminders()) + (await queueHealthReminders()), 0);
  const coaching = await isolated('coaching', async () => (await import('./coaching-notify.js')).queueCoachingReminders(), 0);
  const retries = await isolated('notify', () => runJobs('notify', notifyHandlers), null);
  const push = await isolated('push', () => dispatchPush(), null);
  const whatsapp = await isolated('whatsapp', async () => (await import('./whatsapp.js')).dispatchWhatsapp(), { configured: false, pending: 0, sent: 0, failed: 0 });
  const email = await isolated('email', () => dispatchPending(), { configured: !!config.notifyWebhook.url, pending: 0, sent: 0, failed: 0 });
  const errors = Object.fromEntries(Object.entries({ reminders, coaching, notify: retries, push, whatsapp, email }).filter(([, r]) => !r.ok).map(([k, r]) => [k, r.error]));
  return { reminders: reminders.value, push: push.value, whatsapp: whatsapp.value, ...email.value, ...(Object.keys(errors).length ? { errors } : {}) };
}

export const inbox = (userId, { unread, limit, offset }) =>
  many('SELECT * FROM notifications WHERE user_id=$1 AND ($2 = false OR read_at IS NULL) ORDER BY created_at DESC LIMIT $3 OFFSET $4', [userId, unread, limit, offset]);
