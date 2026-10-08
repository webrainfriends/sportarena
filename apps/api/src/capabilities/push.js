// Push notification devices: register a phone (Expo token) or a browser (Web Push subscription), list, remove, test.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { encrypt } from '../crypto.js';
import { config } from '../config.js';
import { notify } from '../notify.js';
import { webPushConfigured } from '../push.js';

const TAG = 'Notifications';
// The server POSTs to a browser's push endpoint, so only the real push services are accepted (no arbitrary URLs).
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com', 'push.apple.com', 'notify.windows.com'];
export const allowedPushEndpoint = (raw) => {
  try { const u = new URL(raw); return u.protocol === 'https:' && PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`)); } catch { return false; }
};

cap({
  name: 'get_push_config', method: 'GET', path: '/push/config', tag: TAG, auth: 'public',
  summary: 'What the app needs to switch push on: whether phone push (Expo) is available and the Web Push public key (null when browsers cannot receive push on this server).',
  handler: () => ({ expo: true, web_public_key: webPushConfigured() ? config.push.vapid.publicKey : null }),
});

cap({
  name: 'register_push_device', method: 'POST', path: '/me/push-devices', tag: TAG, status: 201,
  summary: 'Register this phone or browser for push notifications. Phones: provider "expo" with the Expo push token. Browsers: provider "webpush" with the PushSubscription endpoint and keys. Registering the same token again just refreshes it (and moves it to you).',
  input: z.object({
    provider: z.enum(['expo', 'webpush']), platform: z.enum(['ios', 'android', 'web']), token: z.string().min(10).max(600).describe('Expo push token, or the Web Push endpoint URL'),
    keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }).optional(), label: z.string().max(60).optional(),
  }),
  async handler({ user }, i) {
    if (i.provider === 'expo' && !/^Expo(nent)?PushToken\[[^\]]+\]$/.test(i.token)) throw badRequest('That is not an Expo push token');
    if (i.provider === 'webpush') {
      if (!i.keys) throw badRequest('Web Push needs the subscription keys');
      if (!allowedPushEndpoint(i.token)) throw badRequest('That is not a supported browser push endpoint');
      if (!webPushConfigured()) throw badRequest('Browser push is not enabled on this server');
    }
    const keys = i.keys ? encrypt(JSON.stringify(i.keys), 'push_devices.keys') : null;
    return one(
      `INSERT INTO push_devices(user_id, provider, platform, token, keys_enc, label) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (provider, token) DO UPDATE SET user_id=$1, platform=$3, keys_enc=coalesce($5, push_devices.keys_enc), label=coalesce($6, push_devices.label), last_seen_at=now(), disabled_at=NULL, disabled_reason=NULL
       RETURNING id, provider, platform, label, created_at, last_seen_at`, [user.id, i.provider, i.platform, i.token, keys, i.label ?? null]);
  },
});

cap({
  name: 'list_push_devices', method: 'GET', path: '/me/push-devices', tag: TAG, summary: 'Your phones and browsers that receive push notifications.',
  handler: ({ user }) => many('SELECT id, provider, platform, label, created_at, last_seen_at FROM push_devices WHERE user_id=$1 AND disabled_at IS NULL ORDER BY last_seen_at DESC', [user.id]),
});

cap({
  name: 'remove_push_device', method: 'DELETE', path: '/me/push-devices/:id', tag: TAG, summary: 'Stop sending push to one device (it is switched off, not erased).', input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one("UPDATE push_devices SET disabled_at=now(), disabled_reason='removed by the user' WHERE id=$1 AND user_id=$2 AND disabled_at IS NULL RETURNING id", [i.id, user.id]);
    if (!r) throw notFound('Device');
    return { ok: true };
  },
});

cap({
  name: 'send_test_push', method: 'POST', path: '/me/push-test', tag: TAG, summary: 'Send yourself a test notification (in-app, plus push to your registered devices).',
  async handler({ user }) {
    const devices = (await one('SELECT count(*)::int AS n FROM push_devices WHERE user_id=$1 AND disabled_at IS NULL', [user.id])).n;
    await notify(null, user.id, { kind: 'test', title: 'Push is working 🎉', body: 'This is a test notification from SportArena.', data: {} });
    return { devices };
  },
});
