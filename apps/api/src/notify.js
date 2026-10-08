// Notifications: in-app inbox (instant) + email queue (sent by the dispatcher through a webhook you configure).
// Callers pass their transaction client so a rolled-back booking never leaves a stray notification behind.
import { pool, query, many, one } from './db.js';
import { config } from './config.js';
import { decrypt } from './crypto.js';
import { audit } from './helpers.js';

export const DEFAULT_PREFS = { in_app: true, email: true, push: true, reminder_hours: 24, muted_kinds: [] };

/** Notify one user. Respects their channel switches and muted kinds. */
export async function notify(c, userId, { kind, title, body, data = {} }) {
  const db = c ?? pool;
  const prefs = (await db.query('SELECT * FROM notification_prefs WHERE user_id=$1', [userId])).rows[0] ?? DEFAULT_PREFS;
  if (prefs.muted_kinds.includes(kind) || (!prefs.in_app && !prefs.email && prefs.push === false)) return null;
  const n = (await db.query('INSERT INTO notifications(user_id, kind, title, body, data) VALUES ($1,$2,$3,$4,$5) RETURNING *', [userId, kind, title, body, data])).rows[0];
  if (prefs.email) await db.query("INSERT INTO notification_deliveries(notification_id, channel) VALUES ($1,'email')", [n.id]);
  if (!prefs.in_app) await db.query('UPDATE notifications SET read_at=now() WHERE id=$1', [n.id]); // no in-app channel: keep the inbox clean
  // push goes straight to the person's phones / browsers, as soon as the data is committed
  if (prefs.push !== false && (await db.query('SELECT 1 FROM push_devices WHERE user_id=$1 AND disabled_at IS NULL LIMIT 1', [userId])).rowCount) {
    await db.query("INSERT INTO notification_deliveries(notification_id, channel) VALUES ($1,'push')", [n.id]);
    const kick = () => import('./push.js').then((m) => m.dispatchPush()).catch((e) => console.error('[push]', e.message));
    if (c?.afterCommit) c.afterCommit(kick); else setImmediate(kick);
  }
  return n;
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

/** Queue reminders for bookings starting within each user's reminder window. Atomic claim, so safe on several instances. */
export async function queueReminders() {
  const { rows } = await pool.query(
    `UPDATE bookings b SET reminded_at = now()
      FROM resources r, venues v, reservations rs
      LEFT JOIN notification_prefs p ON p.user_id = rs.user_id
     WHERE b.status='confirmed' AND b.reminded_at IS NULL AND b.reservation_id = rs.id AND r.id=b.resource_id AND v.id=r.venue_id
       AND b.starts_at > now() AND b.starts_at <= now() + make_interval(hours => coalesce(p.reminder_hours, 24))
    RETURNING b.id, b.user_id, b.starts_at, b.ends_at, r.name AS resource_name, v.name AS venue_name, v.id AS venue_id, b.reservation_id`);
  for (const b of rows) {
    await notify(null, b.user_id, {
      kind: 'booking_reminder', title: `Coming up: ${b.resource_name} at ${b.venue_name}`,
      body: `Your booking starts ${b.starts_at.toISOString()}. Need to change plans? Modify or cancel in the app.`,
      data: { booking_id: b.id, reservation_id: b.reservation_id, venue_id: b.venue_id },
    });
  }
  return rows.length;
}

/** Send queued emails via NOTIFY_WEBHOOK_URL (your SES/Sendgrid/n8n bridge). Without it they simply stay queued. */
export async function dispatchPending({ limit = 50 } = {}) {
  const url = config.notifyWebhook.url;
  const pending = Number((await one("SELECT count(*) AS n FROM notification_deliveries WHERE status='pending' AND channel='email'")).n);
  if (!url) return { configured: false, pending, sent: 0, failed: 0 };
  let sent = 0, failed = 0;
  const { rows } = await query(
    `SELECT d.id, d.attempts, n.id AS notification_id, n.kind, n.title, n.body, n.data, n.user_id, u.email_enc
       FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id JOIN users u ON u.id=n.user_id
      WHERE d.status='pending' AND d.channel='email' ORDER BY d.created_at LIMIT $1`, [limit]);
  for (const d of rows) {
    // claim so two dispatchers never send the same email
    const claimed = await one("UPDATE notification_deliveries SET attempts=attempts+1 WHERE id=$1 AND status='pending' AND attempts=$2 RETURNING id", [d.id, d.attempts]);
    if (!claimed) continue;
    try {
      await audit(null, null, 'dispatch_email', 'notifications', d.notification_id);
      const res = await fetch(url, {
        method: 'POST', signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json', ...(config.notifyWebhook.secret ? { authorization: `Bearer ${config.notifyWebhook.secret}` } : {}) },
        body: JSON.stringify({ channel: 'email', to: decrypt(d.email_enc, 'users.email'), subject: d.title, text: d.body, kind: d.kind, data: d.data, notification_id: d.notification_id }),
      });
      if (!res.ok) throw new Error(`webhook answered ${res.status}`);
      await query("UPDATE notification_deliveries SET status='sent', sent_at=now(), last_error=NULL WHERE id=$1", [d.id]);
      sent++;
    } catch (e) {
      failed++;
      await query("UPDATE notification_deliveries SET last_error=$2, status=CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END WHERE id=$1", [d.id, String(e.message).slice(0, 300)]);
    }
  }
  return { configured: true, pending: pending - sent, sent, failed };
}

/** One tick of the background worker. */
export async function notificationCycle() {
  const reminders = await queueReminders();
  const { dispatchPush } = await import('./push.js');
  const push = await dispatchPush();
  return { reminders, push, ...(await dispatchPending()) };
}

export const inbox = (userId, { unread, limit, offset }) =>
  many('SELECT * FROM notifications WHERE user_id=$1 AND ($2 = false OR read_at IS NULL) ORDER BY created_at DESC LIMIT $3 OFFSET $4', [userId, unread, limit, offset]);
