// Product-analytics telemetry (#73). Fire-and-forget and consent-first: nothing is sent unless the person switched analytics on in their account
// (the server enforces this again and never records young people), and a failure here never reaches the screen. Each occurrence carries its own
// dedupe key, kept across retries, so a repeated delivery is counted once by the server.
// Events are the closed set in the API's definitions (GET /analytics/events/definitions): names, ids and closed enums only; never free text, names or
// anything about health, insurance, legal or young people.
import { Platform } from 'react-native';
import { api } from './api';

let granted = null;                  // null = not yet known
let loading = null;
const queue = [];
let timer = null;

const key = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
const knowConsent = () => (loading ??= api.get('/analytics/consent').then((c) => { granted = !!c.granted; }).catch(() => { granted = false; }).finally(() => { loading = null; }));

/** Called by the account sheet when the person changes their choice, so the very next event follows it. */
export function setTrackingConsent(on) {
  granted = !!on;
  if (!on) queue.length = 0;
}

async function flush() {
  timer = null;
  if (!queue.length) return;
  const batch = queue.splice(0, 50);
  try { await api.post('/analytics/events', { events: batch }); } catch { if (granted) queue.unshift(...batch.slice(0, 20)); }   // one gentle retry on the next event
}

/**
 * @param {string} event one of the registered event keys
 * @param {{entityType?:string, entityId?:string, sportId?:string, properties?:object}} [o]
 */
export async function track(event, o = {}) {
  try {
    if (granted === null) await knowConsent();
    if (!granted) return;
    queue.push({
      event_key: event, dedupe_key: key(), occurred_at: new Date().toISOString(), platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web',
      ...(o.entityType ? { entity_type: o.entityType, entity_id: o.entityId } : {}), ...(o.sportId ? { sport_id: o.sportId } : {}), properties: o.properties ?? {},
    });
    if (!timer) timer = setTimeout(flush, 1500);
  } catch { /* telemetry must never break a screen */ }
}
