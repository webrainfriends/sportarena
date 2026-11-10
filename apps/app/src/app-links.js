import { Platform } from 'react-native';

// A coach or scout opening a passport link (web) sees the athlete's CV without signing in.
export const PASSPORT_TOKEN = Platform.OS === 'web' && typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('passport') : null;
// A licence QR or shared card link (web): the public check, and a shared card, open without signing in.
const WEB_QUERY = Platform.OS === 'web' && typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
export const VERIFY_VALUE = WEB_QUERY?.get('verify') ?? null;
export const LICENCE_CARD_TOKEN = WEB_QUERY?.get('licence_card') ?? null;

// A shared event or game link (web): signed-out visitors see the public page; signed-in people are taken to the same screens inside the app.
export const PUBLIC_LINK = (() => {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const q = new URLSearchParams(window.location.search);
  const ok = (v) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : null);
  const event = ok(q.get('event')), fixture = ok(q.get('fixture')), clip = ok(q.get('clip'));
  return event || fixture || clip ? { event, fixture, clip } : null;
})();
