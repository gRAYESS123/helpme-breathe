/*
 * Service Worker for Help Me Breathe
 * -----------------------------------------------------------------------------
 * Strategy:
 *   - HTML navigations : network-first  (always try for fresh content, fall back
 *                        to cache, then to the offline page when fully offline)
 *   - CSS/JS/images     : stale-while-revalidate (instant from cache, refreshed
 *                        in the background)
 *   - Google Fonts      : stale-while-revalidate in a separate runtime cache
 *   - Analytics / ads / any other cross-origin : NOT intercepted (pass through)
 *
 * IMPORTANT: bump CACHE_VERSION on every deploy so returning visitors pick up
 * new CSS/JS/images. Changing this file is what triggers the SW update.
 */
const CACHE_VERSION = 'v1.0.0';
const STATIC_CACHE = `hmb-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `hmb-runtime-${CACHE_VERSION}`;

// App shell — must all exist, or install fails.
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/scripts.js',
  '/manifest.json',
  '/offline.html',
  '/images/icon-192.png',
  '/images/icon-512.png'
];

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = FONT_HOSTS.includes(url.hostname);

  // Let Google Analytics, AdSense, and any other third party go straight to the
  // network — caching them would break measurement and ad delivery.
  if (!sameOrigin && !isFont) return;

  // Fresh HTML on every visit, cache as offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match('/offline.html')))
    );
    return;
  }

  // Static assets + fonts: stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type !== 'opaque') {
            const copy = response.clone();
            const target = isFont ? RUNTIME_CACHE : STATIC_CACHE;
            caches.open(target).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});

// Allow the page to trigger an immediate update if desired.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
