// Push delivery. Phone apps: Expo's push service (works for iOS and Android with one token). Browsers: Web Push (VAPID).
// A push is a `notification_deliveries` row with channel 'push'; it fans out to every active device of the person and
// devices the provider says are gone are switched off (soft), never deleted.
import { config } from './config.js';
import { decrypt } from './crypto.js';
import { many, one, query } from './db.js';

const MAX_ATTEMPTS = 5;
const payloadOf = (n) => ({ title: n.title.slice(0, 80), body: n.body.slice(0, 178), data: { kind: n.kind, notification_id: n.id, ...n.data } });

export const webPushConfigured = () => !!(config.push.vapid.publicKey && config.push.vapid.privateKey);

async function sendExpo(device, p) {
  const res = await fetch(config.push.expoUrl, {
    method: 'POST', signal: AbortSignal.timeout(10_000),
    headers: { accept: 'application/json', 'content-type': 'application/json', ...(config.push.expoToken ? { authorization: `Bearer ${config.push.expoToken}` } : {}) },
    body: JSON.stringify([{ to: device.token, title: p.title, body: p.body, data: p.data, sound: 'default', priority: 'high', channelId: 'default' }]),
  });
  if (!res.ok) return { error: `Expo push answered ${res.status}` };
  const t = (await res.json().catch(() => null))?.data?.[0];
  if (t?.status === 'ok') return { ok: true };
  if (t?.details?.error === 'DeviceNotRegistered') return { gone: true };
  return { error: t?.message ?? 'Expo push rejected the message' };
}

async function sendWeb(device, p) {
  if (!webPushConfigured()) return { error: 'Web Push is not configured on this server (VAPID keys)' };
  const webpush = (await import('web-push')).default;
  const keys = JSON.parse(decrypt(device.keys_enc, 'push_devices.keys'));
  try {
    await webpush.sendNotification({ endpoint: device.token, keys }, JSON.stringify(p), {
      TTL: 3600, urgency: 'high', vapidDetails: { subject: config.push.vapid.subject, publicKey: config.push.vapid.publicKey, privateKey: config.push.vapid.privateKey },
    });
    return { ok: true };
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) return { gone: true };
    return { error: `Web Push answered ${e.statusCode ?? e.message}` };
  }
}

/** Replaceable in tests. */
export const senders = { expo: sendExpo, webpush: sendWeb };

/** Send every pending push. Safe to call often and from several instances (each delivery is claimed first). */
export async function dispatchPush({ limit = 50 } = {}) {
  const todo = await many(
    `SELECT d.id, d.attempts, n.id AS notification_id, n.kind, n.title, n.body, n.data, n.user_id
       FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id
      WHERE d.status='pending' AND d.channel='push' ORDER BY d.created_at LIMIT $1`, [limit]);
  const out = { sent: 0, failed: 0, devices_disabled: 0 };
  for (const d of todo) {
    const claimed = await one("UPDATE notification_deliveries SET attempts=attempts+1 WHERE id=$1 AND status='pending' AND attempts=$2 RETURNING id", [d.id, d.attempts]);
    if (!claimed) continue;
    const devices = await many('SELECT * FROM push_devices WHERE user_id=$1 AND disabled_at IS NULL', [d.user_id]);
    const payload = payloadOf({ ...d, id: d.notification_id });
    let delivered = 0; const errors = [];
    for (const dev of devices) {
      let r;
      try { r = await senders[dev.provider](dev, payload); } catch (e) { r = { error: e.message }; }
      if (r.ok) { delivered++; await query('UPDATE push_devices SET last_seen_at=now() WHERE id=$1', [dev.id]); }
      else if (r.gone) { out.devices_disabled++; await query("UPDATE push_devices SET disabled_at=now(), disabled_reason='rejected by the push service' WHERE id=$1", [dev.id]); }
      else errors.push(r.error);
    }
    if (delivered || !errors.length) {
      // nobody left to push to (all devices gone) also counts as done: the in-app inbox still has it
      await query("UPDATE notification_deliveries SET status='sent', sent_at=now(), last_error=$2 WHERE id=$1", [d.id, delivered ? null : 'no active device']);
      out.sent++;
    } else {
      out.failed++;
      await query("UPDATE notification_deliveries SET last_error=$2, status=CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END WHERE id=$1", [d.id, errors[0].slice(0, 300), MAX_ATTEMPTS]);
    }
  }
  return out;
}
