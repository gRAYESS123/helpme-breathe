/*
 * Service Worker for Help Me Breathe
 * -----------------------------------------------------------------------------
 * Strategy:
 *   - HTML navigations        : network-first, cache as offline fallback, then
 *                               /offline.html when there is nothing cached
 *   - same-origin assets      : stale-while-revalidate
 *   - /api/* and cross-origin : never intercepted, never cached
 *
 * Bump CACHE_NAME on every deploy that changes CSS, JS or the app shell.
 * Webfonts are cross-origin: never precached, never intercepted.
 * Changing this file is what triggers the service-worker update.
 */
const CACHE_NAME = 'hmb-v10-landing-2026-09-16';
// The clean URL, never '/offline.html': under cleanUrls Vercel answers the
// .html path with a 308, and a redirected response cannot be served for a
// navigation (Chrome fails the request instead of showing the page).
const OFFLINE_URL = '/offline';

/**
 * Caches this worker must NOT purge on activate. The Pro soundscape pack lives
 * in its own cache (js/pro/soundscapes.js), roughly 4MB a paying customer chose
 * to download for offline use. Purging every non-shell cache on every deploy
 * wiped it, which broke "audio plays with the device offline after activation"
 * for anyone whose first post-deploy load happened offline.
 *
 * Keep this name in step with AUDIO_CACHE in js/pro/soundscapes.js.
 */
const AUDIO_CACHE = 'hmb-audio';
const KEEP_CACHES = new Set([CACHE_NAME, AUDIO_CACHE]);

// App shell. Install does NOT fail when one entry 404s (a page can ship later);
// each URL is fetched independently and failures are skipped.
const PRECACHE_URLS = [
  '/',
  '/timer',
  '/offline',
  '/css/styles.css',
  '/js/app.js',
  '/js/stage.js',
  '/js/techniques.js',
  '/js/storage.js',
  '/js/analytics.js',
  '/js/entitlements.js',
  '/js/consent.js',
  '/js/config.js',
  '/js/checkout.js',
  '/js/pro/index.js',
  '/js/pro/preview.js',
  '/js/auth.js',
  '/css/account.css',
  '/js/pro/patterns.js',
  '/js/pro/streaks.js',
  '/js/pro/paywall.js',
  '/js/pro/capture.js',
  '/js/pro/night.js',
  '/js/pro/soundscapes.js',
  '/css/pro.css',
  '/manifest.json',
  '/favicon.svg',
  '/favicon-32.png',
  '/favicon-16.png',
  '/images/logo.svg',
  '/images/icon-192.png',
  '/images/icon-512.png',
  '/images/apple-touch-icon.png'
];

async function precache() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.allSettled(
    PRECACHE_URLS.map(async (url) => {
      try {
        const response = await fetch(new Request(url, { cache: 'reload' }));
        if (response && response.ok) await cache.put(url, response);
      } catch (error) {
        // A missing or unreachable entry must never block installation.
      }
    })
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => !KEEP_CACHES.has(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

/**
 * Never intercepted, never cached: the API, and the account surfaces, which
 * carry a person's sign-in state and must always come from the network.
 */
const NEVER_CACHE = new Set([
  '/account',
  '/account.html',
  '/signin',
  '/signin.html',
  '/auth/callback',
  '/auth/callback.html',
]);

function isCacheable(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api/')) return false;
  if (NEVER_CACHE.has(url.pathname)) return false;
  return true;
}

/**
 * A navigation worth keeping on disk. Anything carrying a query string is not:
 * /pro/thanks arrives with a checkout reservation id. Caching it would write
 * that id to CacheStorage keyed on the full URL. It still works; it simply
 * comes from the network every time.
 */
function isCacheableNavigation(url) {
  if (url.search) return false;
  if (url.pathname === '/pro/thanks' || url.pathname === '/pro/thanks.html') return false;
  return true;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (error) {
    return;
  }

  // Cross-origin (fonts, analytics, ads) and the API go straight to the network.
  if (!isCacheable(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok && isCacheableNavigation(url)) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() =>
          caches
            // ignoreSearch: the installed app starts at /?source=pwa and its
            // shortcuts at /timer?t=…; the cached shell must answer them.
            .match(request, { ignoreSearch: true })
            .then((cached) => cached || caches.match(OFFLINE_URL))
            .then((cached) => cached || Response.error())
        )
    );
    return;
  }

  // Same-origin assets. Scripts and styles are network-first: the origin
  // answers a conditional request with a 304, so a deploy reaches the very
  // next page load and the cache is only the offline fallback — no hand-bumped
  // version can be forgotten. Images and audio stay stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type !== 'opaque') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached || Response.error());
      if (request.destination === 'script' || request.destination === 'style') return networkFetch;
      return cached || networkFetch;
    })
  );
});

// Let the page trigger an immediate update.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
