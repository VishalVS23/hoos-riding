// Hoos Riding service worker.
// 1. If the phone has no connection when the app opens, show a friendly offline page
//    instead of the browser's error screen. It never saves bus data (stale positions would mislead).
// 2. Leave-now notifications: shows the notifications our server sends (server/push.js),
//    and opens HooMaps when you tap one.

const CACHE = 'hoos-riding-v2'; // bump when offline.html changes (v2: renamed to HooMaps)
const OFFLINE_FILES = ['/offline.html', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(OFFLINE_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Delete caches from older versions of this file.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Opening the app (a page load): try the network, fall back to the offline page.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/offline.html')));
    return;
  }

  // The offline page's icon.
  if (OFFLINE_FILES.includes(new URL(request.url).pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
  }
  // Everything else (bus data, Google Maps) goes straight to the network as normal.
});

// ---------- Notifications ----------

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'HooMaps', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag, // a newer reminder for the same class replaces the older one
      renotify: false, // ...quietly (no second buzz), on phones that support it
      data: { url: data.url || '/' },
    }),
  );
});

// Tap a notification: bring HooMaps to the front (or open it) at the notification's page.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        // The app is already open: ask it to show the trip (no reload), and bring it to the front.
        open.postMessage({ type: 'open-url', url });
        return open.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
