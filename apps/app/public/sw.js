// Service worker: shows push notifications for the web app and opens the right screen when one is tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch { p = { title: 'SportArena', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(p.title || 'SportArena', {
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
