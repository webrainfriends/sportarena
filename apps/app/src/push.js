// Switching push on for this device: browsers use a service worker + Web Push, phones use Expo push tokens.
import { Platform } from 'react-native';
import { api, storage } from './api';

const KEY = 'pushDevice';
const b64ToBytes = (s) => { const pad = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...raw].map((ch) => ch.charCodeAt(0))); };

/** Can this device receive push at all, and if not, why. */
export async function pushSupport() {
  if (Platform.OS === 'web') {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') return { ok: false, reason: "This browser doesn't support push notifications." };
    if (!window.isSecureContext) return { ok: false, reason: 'Browser push needs the secure (https) version of the app.' };
    const cfg = await api.get('/push/config').catch(() => null);
    if (!cfg?.web_public_key) return { ok: false, reason: "Browser push isn't switched on for this server." };
    return { ok: true, webKey: cfg.web_public_key, denied: Notification.permission === 'denied' };
  }
  return { ok: true };
}

export const currentDevice = () => storage.get(KEY);

/** Ask permission, subscribe, and register this device with the server. Returns the device. */
export async function enablePush() {
  const sup = await pushSupport();
  if (!sup.ok) throw new Error(sup.reason);
  let device;
  if (Platform.OS === 'web') {
    if (Notification.permission === 'denied') throw new Error('Notifications are blocked for this site — allow them in your browser settings.');
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if ((await Notification.requestPermission()) !== 'granted') throw new Error('Permission was not granted.');
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(sup.webKey) }));
    const j = sub.toJSON();
    device = await api.post('/me/push-devices', { provider: 'webpush', platform: 'web', token: j.endpoint, keys: j.keys, label: navigator.userAgent.slice(0, 50) });
  } else {
    const Notifications = await import('expo-notifications');
    const Constants = (await import('expo-constants')).default;
    let perm = await Notifications.getPermissionsAsync();
    if (perm.status !== 'granted') perm = await Notifications.requestPermissionsAsync();
    if (perm.status !== 'granted') throw new Error('Permission was not granted — enable notifications in your phone settings.');
    if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('default', { name: 'Bookings & updates', importance: Notifications.AndroidImportance.HIGH });
    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) throw new Error('This build has no Expo project id, so the phone cannot get a push token (set extra.eas.projectId and rebuild).');
    const t = await Notifications.getExpoPushTokenAsync({ projectId });
    device = await api.post('/me/push-devices', { provider: 'expo', platform: Platform.OS, token: t.data, label: Platform.OS });
  }
  await storage.set(KEY, device.id);
  return device;
}

/** Stop push on this device (and tell the server). */
export async function disablePush(deviceId) {
  await api.del(`/me/push-devices/${deviceId}`).catch(() => {});
  if (Platform.OS === 'web' && 'serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe().catch(() => {});
  }
  await storage.del(KEY);
}

/** Where a tapped notification should land: [screen, params] or null. */
export function targetFor(data = {}) {
  if (data.reservation_id) return ['Reservation', { id: data.reservation_id }];
  if (data.venue_id && data.date) return ['BookFlow', { venueId: data.venue_id, resourceId: data.resource_id, date: data.date }];
  if (data.venue_id) return ['Venue', { id: data.venue_id }];
  return ['Notifications', {}];
}

export function parseTarget(t) {
  const [kind, id] = String(t ?? '').split(':');
  if (kind === 'reservation' && id) return ['Reservation', { id }];
  if (kind === 'venue' && id) return ['Venue', { id }];
  return ['Notifications', {}];
}
