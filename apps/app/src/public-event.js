// The public event a signed-out visitor opened from the landing page. On the web the address (?event=…) carries it; on iOS, iPadOS and
// Android there is no address bar, so it is held here and App shows the same public event screen inside the app instead of a browser page.
import { useSyncExternalStore } from 'react';

let current = null;
const listeners = new Set();

export function showPublicEvent(id) {
  current = id ?? null;
  listeners.forEach((fn) => fn());
}

export function usePublicEvent() {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => current, () => null);
}
