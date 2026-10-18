/* Guildwise service worker: installable shell, offline page, Web Push. Served from the web root (scope /).
 * It never caches /api, /ws or HTML: pages always come from the network; only the hashed build assets are kept. */
const VERSION = 'v1';
const SHELL = `guildwise-shell-${VERSION}`;
const ASSETS = `guildwise-assets-${VERSION}`;
const OFFLINE_URL = '/offline.html';
const PRECACHE = [OFFLINE_URL, '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  // No automatic skipWaiting: the page shows "Update available" and asks for it (message below).
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, ASSETS]);
      for (const key of await caches.keys())
        if (key.startsWith('guildwise-') && !keep.has(key)) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Live data and sockets are never cached.
  if (url.pathname.startsWith('/api/') || url.pathname === '/api' || url.pathname.startsWith('/ws')) return;

  if (req.mode === 'navigate') {
    // Network first; a failed navigation shows the offline page.
    event.respondWith(fetch(req).catch(async () => (await caches.match(OFFLINE_URL)) || Response.error()));
    return;
  }
  // Hashed build assets never change under their name: cache first.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(ASSETS).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
  }
});

function safeUrl(raw) {
  try {
    const u = new URL(raw || '/', self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search + u.hash : '/';
  } catch (e) {
    return '/';
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Guildwise';
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,
    // A newer notice with the same tag replaces the old one on the lock screen and still alerts.
    renotify: !!data.tag,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: safeUrl(data.url) },
  };
  const tasks = [self.registration.showNotification(title, options)];
  if (typeof data.badge === 'number' && self.navigator && 'setAppBadge' in self.navigator) {
    tasks.push(
      (data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()).catch(
        () => undefined,
      ),
    );
  }
  event.waitUntil(Promise.all(tasks));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((c) => c.url.startsWith(self.location.origin)) || null;
      if (existing) {
        try {
          const focused = await existing.focus();
          if (focused && 'navigate' in focused) {
            await focused.navigate(target);
            return;
          }
        } catch (e) {
          /* fall through to a new window */
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
