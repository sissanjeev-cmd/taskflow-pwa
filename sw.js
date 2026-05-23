const CACHE  = 'taskflow-v21';
const ASSETS = ['./', './index.html', './app.js', './styles.css', './manifest.json', './firebase-config.js', './icon-192.png', './icon-512.png'];

// ── In-memory timer map (taskId → timerId) ─────────────────────────────────
const pendingTimers = new Map();

// ── IndexedDB helpers ──────────────────────────────────────────────────────
function openAlarmsDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('tf-alarms', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('alarms', { keyPath: 'id' });
    req.onsuccess = e => res(e.target.result);
    req.onerror   = () => rej(req.error);
  });
}

async function persistAlarms(alarms) {
  const db = await openAlarmsDB();
  const tx = db.transaction('alarms', 'readwrite');
  const st = tx.objectStore('alarms');
  st.clear();
  alarms.forEach(a => st.put(a));
  return new Promise(res => { tx.oncomplete = res; tx.onerror = res; });
}

async function loadPersistedAlarms() {
  const db = await openAlarmsDB();
  const tx = db.transaction('alarms', 'readonly');
  return new Promise((res, rej) => {
    const req = tx.objectStore('alarms').getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror   = () => rej(req.error);
  });
}

// ── Alarm scheduling ───────────────────────────────────────────────────────
function scheduleAlarm(alarm) {
  const delay = new Date(alarm.dueAt) - Date.now();
  if (delay <= 0 || delay > 7 * 24 * 60 * 60 * 1000) return; // skip past or >7 days out
  if (pendingTimers.has(alarm.id)) clearTimeout(pendingTimers.get(alarm.id));

  const tid = setTimeout(async () => {
    pendingTimers.delete(alarm.id);
    try {
      await self.registration.showNotification('⏰ TaskFlow', {
        body: alarm.title + (alarm.description ? '\n' + alarm.description : ''),
        icon:  './icon-192.png',
        badge: './icon-192.png',
        tag:   `tf-alarm-${alarm.id}`,
        requireInteraction: true,
        data:  { url: self.location.origin },
      });
    } catch(e) { console.error('[sw] showNotification failed', e); }
  }, delay);

  pendingTimers.set(alarm.id, tid);
}

// ── SW lifecycle ───────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    // Clear old caches
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();

    // Restore alarm timers that were persisted before SW was killed
    const saved = await loadPersistedAlarms().catch(() => []);
    saved.forEach(a => scheduleAlarm(a));
  })());
});

self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') { self.skipWaiting(); return; }

  if (e.data?.type === 'SCHEDULE_ALARMS') {
    const alarms = e.data.alarms || [];
    // Clear existing timers then reschedule
    pendingTimers.forEach(clearTimeout);
    pendingTimers.clear();
    // Persist to IDB so alarms survive SW restarts
    persistAlarms(alarms).catch(() => {});
    alarms.forEach(a => scheduleAlarm(a));
  }
});

// ── Notification click — open / focus the app ─────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.startsWith(self.location.origin));
      return existing ? existing.focus() : clients.openWindow(e.notification.data?.url || self.location.origin);
    })
  );
});

// ── Fetch (same-origin only: network-first with forced revalidation) ──────
self.addEventListener('fetch', e => {
  if (!e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(new Request(e.request, { cache: 'no-cache' }))
      .then(response => {
        if (response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(e.request))
  );
});
