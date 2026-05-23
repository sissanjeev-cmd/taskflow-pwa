const CACHE_NAME = 'taskflow-cache-v2';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.url.includes('/api/') || event.request.url.includes('firestore.googleapis.com')) {
    return;
  }
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      if (cachedResponse) return cachedResponse;
      return fetch(event.request).then(networkResponse => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, responseToCache);
        });
        return networkResponse;
      });
    }).catch(() => caches.match('./index.html'))
  );
});

// ── Background PWA Thread Alarm Management Engine ─────────────────────────────
self.activeAlarms = [];

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data && event.data.type === 'SCHEDULE_ALARMS') {
    const alarms = event.data.alarms;

    // Wipe out legacy references to prevent memory leaks or dual fires
    self.activeAlarms.forEach(timeoutId => clearTimeout(timeoutId));
    self.activeAlarms = [];

    const now = Date.now();
    alarms.forEach(alarm => {
      const targetTime = new Date(alarm.dueAt).getTime();
      const delay = targetTime - now;

      if (delay > 0) {
        const timeoutId = setTimeout(() => {
          self.registration.showNotification('⏰ TaskFlow Reminder', {
            body: alarm.title,
            tag: alarm.id,
            renotify: true,
            silent: false,
            vibrate: [300, 100, 300],
            data: { taskId: alarm.id }
          });
        }, delay);
        self.activeAlarms.push(timeoutId);
      }
    });
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      if (clientList.length > 0) {
        return clientList[0].focus();
      }
      return self.clients.openWindow('./');
    })
  );
});