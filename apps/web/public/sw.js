// Ultra Family OS PWA shell.
// Private API responses are intentionally never cached. The first public version
// requires connectivity; offline navigation gets an honest status page.
const CACHE = 'ufos-shell-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(['/', OFFLINE_URL, '/icon.svg', '/manifest.webmanifest'])),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Only the public landing page may enter the shell cache.
          if (url.pathname === '/' && response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put('/', copy));
          }
          return response;
        })
        .catch(async () => {
          if (url.pathname === '/') {
            return (await caches.match('/')) || (await caches.match(OFFLINE_URL));
          }
          return (
            (await caches.match(OFFLINE_URL)) ||
            new Response('Offline', {
              status: 503,
              headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            })
          );
        }),
    );
    return;
  }

  if (
    url.origin === self.location.origin &&
    /\.(?:svg|png|jpg|jpeg|webp|woff2?|css|js)$/.test(url.pathname)
  ) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
  }
});
