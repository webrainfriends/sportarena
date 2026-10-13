// Service worker: makes the web app installable/fast (app shell cache), shows push notifications and opens the right screen when one is tapped.
// Only the static shell is cached; /api and /mcp always go to the network so data is never stale or served to the wrong user.
const SHELL = 'sa-shell-v1';
self.addEventListener('install', (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon-192.png'])).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== SHELL) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/mcp')) return;
  if (req.mode === 'navigate') {
    // newest page when online, the cached shell when offline
    event.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(SHELL).then((c) => c.put('/', copy)); return r; }).catch(() => caches.match('/')));
  } else if (url.pathname.startsWith('/_expo/static/') || /\.(png|webmanifest|woff2?|ttf)$/.test(url.pathname)) {
    // build output is content-hashed, so cache-first is safe
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); } return r; })));
  }
});

self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch { p = { title: 'Gotmygame', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(p.title || 'Gotmygame', {
    body: p.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: p.data && p.data.notification_id, data: p.data || {},
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const target = d.reservation_id ? `reservation:${d.reservation_id}` : d.venue_id ? `venue:${d.venue_id}` : 'notifications';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length) { all[0].postMessage({ type: 'open', target }); return all[0].focus(); }
    return self.clients.openWindow(`/?open=${encodeURIComponent(target)}`);
  })());
});
