// Service Worker for Help Me Breathe - Optimized Performance
const CACHE_NAME = 'breathe-v1.1.0';
const STATIC_CACHE = 'breathe-static-v1.1';
const DYNAMIC_CACHE = 'breathe-dynamic-v1.1';
const AUDIO_CACHE = 'breathe-audio-v1';

// Files to cache immediately for offline functionality
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/scripts.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  // Google Fonts
  'https://fonts.googleapis.com/css2?family=Quicksand:wght@300;400;500;600&display=swap'
];

// Critical resources that must be cached
const CRITICAL_ASSETS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/scripts.js'
];

// Install event - cache static assets with performance optimization
self.addEventListener('install', (event) => {
  console.log('Service Worker installing...');
  
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(STATIC_CACHE);
        
        // Cache critical assets first
        await cache.addAll(CRITICAL_ASSETS);
        console.log('Critical assets cached');
        
        // Cache remaining assets
        const remainingAssets = STATIC_ASSETS.filter(asset => !CRITICAL_ASSETS.includes(asset));
        
        // Cache remaining assets with error handling
        const cachePromises = remainingAssets.map(async (asset) => {
          try {
            const response = await fetch(asset);
            if (response.ok) {
              await cache.put(asset, response);
            }
          } catch (error) {
            console.warn(`Failed to cache ${asset}:`, error);
          }
        });
        
        await Promise.allSettled(cachePromises);
        console.log('All static assets cached');
        
        // Skip waiting to activate immediately
        await self.skipWaiting();
        
      } catch (error) {
        console.error('Cache installation failed:', error);
      }
    })()
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('Service Worker activating...');
  
  event.waitUntil(
    (async () => {
      try {
        const cacheNames = await caches.keys();
        const validCaches = [STATIC_CACHE, DYNAMIC_CACHE, AUDIO_CACHE];
        
        // Delete old caches
        const deletePromises = cacheNames
          .filter(cacheName => !validCaches.includes(cacheName))
          .map(cacheName => {
            console.log(`Deleting old cache: ${cacheName}`);
            return caches.delete(cacheName);
          });
        
        await Promise.all(deletePromises);
        
        // Take control of all clients
        await self.clients.claim();
        console.log('Service Worker activated and ready');
        
      } catch (error) {
        console.error('Activation failed:', error);
      }
    })()
  );
});

// Fetch event - intelligent caching strategy
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Handle different types of requests with specific strategies
  if (url.origin === location.origin) {
    // Same-origin requests - Cache First strategy for static assets
    if (isStaticAsset(url.pathname)) {
      event.respondWith(cacheFirstStrategy(request));
    } else {
      // Network First for dynamic content
      event.respondWith(networkFirstStrategy(request));
    }
  } else if (isGoogleFonts(url.href)) {
    // Google Fonts - Cache First with long expiration
    event.respondWith(googleFontsStrategy(request));
  } else if (isAnalytics(url.href)) {
    // Analytics - Network Only, don't cache
    event.respondWith(networkOnlyStrategy(request));
  } else {
    // External resources - Stale While Revalidate
    event.respondWith(staleWhileRevalidateStrategy(request));
  }
});

// Cache First Strategy - for static assets
async function cacheFirstStrategy(request) {
  try {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }

    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, networkResponse.clone());
    }
    
    return networkResponse;
  } catch (error) {
    console.warn('Cache first strategy failed:', error);
    return await handleOfflineFallback(request);
  }
}

// Network First Strategy - for dynamic content
async function networkFirstStrategy(request) {
  try {
    const networkResponse = await fetch(request);
    
    if (networkResponse.ok) {
      const cache = await caches.open(DYNAMIC_CACHE);
      cache.put(request, networkResponse.clone());
    }
    
    return networkResponse;
  } catch (error) {
    console.warn('Network first fallback to cache:', error);
    const cachedResponse = await caches.match(request);
    return cachedResponse || await handleOfflineFallback(request);
  }
}

// Google Fonts Strategy - aggressive caching
async function googleFontsStrategy(request) {
  try {
    let cachedResponse = await caches.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }

    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(STATIC_CACHE);
      // Cache for 1 year
      const responseWithHeaders = new Response(networkResponse.body, {
        status: networkResponse.status,
        statusText: networkResponse.statusText,
        headers: {
          ...Object.fromEntries(networkResponse.headers.entries()),
          'Cache-Control': 'public, max-age=31536000'
        }
      });
      cache.put(request, responseWithHeaders.clone());
      return responseWithHeaders;
    }
    
    return networkResponse;
  } catch (error) {
    return await caches.match(request);
  }
}

// Network Only Strategy - for analytics
async function networkOnlyStrategy(request) {
  try {
    return await fetch(request);
  } catch (error) {
    // Fail silently for analytics
    return new Response('', { status: 200 });
  }
}

// Stale While Revalidate Strategy - for external resources
async function staleWhileRevalidateStrategy(request) {
  const cache = await caches.open(DYNAMIC_CACHE);
  const cachedResponse = await cache.match(request);
  
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => cachedResponse);

  return cachedResponse || await fetchPromise;
}

// Offline fallback handling
async function handleOfflineFallback(request) {
  if (request.mode === 'navigate') {
    // Return cached index.html for navigation requests
    const cachedIndex = await caches.match('/index.html');
    if (cachedIndex) {
      return cachedIndex;
    }
    
    // Fallback offline page
    return new Response(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Offline - Help Me Breathe</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { 
            font-family: system-ui, sans-serif; 
            margin: 0; 
            padding: 2rem; 
            text-align: center; 
            background: linear-gradient(180deg, #1e1b4b 0%, #312e81 50%, #4338ca 100%);
            color: white;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .container { max-width: 400px; }
          .circle { 
            width: 100px; 
            height: 100px; 
            border-radius: 50%; 
            background: radial-gradient(circle, #c7d2fe 0%, #8b5cf6 70%);
            margin: 0 auto 2rem;
            animation: pulse 3s ease-in-out infinite;
          }
          @keyframes pulse {
            0%, 100% { transform: scale(1); opacity: 0.8; }
            50% { transform: scale(1.1); opacity: 1; }
          }
          button {
            background: rgba(255,255,255,0.1);
            color: white;
            border: 1px solid rgba(255,255,255,0.3);
            padding: 0.75rem 1.5rem;
            border-radius: 25px;
            cursor: pointer;
            margin-top: 1rem;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="circle"></div>
          <h1>🌙 You're Offline</h1>
          <p>No worries! You can still practice breathing exercises.<br>Your calm doesn't depend on connection.</p>
          <button onclick="location.reload()">Try Again</button>
        </div>
      </body>
      </html>
    `, {
      headers: { 'Content-Type': 'text/html' }
    });
  }
  
  return new Response('Offline', { status: 503 });
}

// Utility functions
function isStaticAsset(pathname) {
  return /\.(js|css|png|jpg|jpeg|svg|ico|woff|woff2|ttf)$/.test(pathname) ||
         pathname === '/' || pathname === '/index.html';
}

function isGoogleFonts(url) {
  return url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com');
}

function isAnalytics(url) {
  return url.includes('google-analytics.com') || 
         url.includes('googletagmanager.com') ||
         url.includes('googlesyndication.com');
}

// Background sync for analytics when online
self.addEventListener('sync', (event) => {
  if (event.tag === 'analytics-sync') {
    event.waitUntil(sendQueuedAnalytics());
  }
});

// Push notifications for breathing reminders
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const options = {
    body: data.body || 'Time for your breathing exercise! 🌙',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    tag: 'breathing-reminder',
    requireInteraction: false,
    actions: [
      {
        action: 'start-breathing',
        title: 'Start Now',
        icon: '/icon-192.png'
      },
      {
        action: 'remind-later',
        title: 'Later',
        icon: '/icon-192.png'
      }
    ],
    data: {
      url: data.url || '/?auto-start=true',
      technique: data.technique || '478'
    }
  };

  event.waitUntil(
    self.registration.showNotification('Help Me Breathe', options)
  );
});

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const urlToOpen = new URL(event.notification.data.url || '/', self.location.origin);

  if (event.action === 'start-breathing') {
    urlToOpen.searchParams.set('auto-start', 'true');
  } else if (event.action === 'remind-later') {
    // Schedule another reminder in 30 minutes
    scheduleReminder(30 * 60 * 1000);
    return;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        // Check if app is already open
        for (const client of clientList) {
          if (client.url === urlToOpen.href && 'focus' in client) {
            return client.focus();
          }
        }
        
        // Open new window
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen.href);
        }
      })
  );
});

// Performance monitoring
self.addEventListener('message', (event) => {
  if (event.data && event.data.type) {
    switch (event.data.type) {
      case 'PERFORMANCE_MARK':
        console.log('Performance mark:', event.data.mark);
        break;
      case 'SKIP_WAITING':
        self.skipWaiting();
        break;
      case 'GET_VERSION':
        event.ports[0].postMessage({ version: CACHE_NAME });
        break;
    }
  }
});

// Cache cleanup - run periodically
async function cleanupOldCaches() {
  try {
    const dynamicCache = await caches.open(DYNAMIC_CACHE);
    const requests = await dynamicCache.keys();
    
    // Remove old entries (keep last 50)
    if (requests.length > 50) {
      const toDelete = requests.slice(0, requests.length - 50);
      await Promise.all(toDelete.map(request => dynamicCache.delete(request)));
      console.log(`Cleaned up ${toDelete.length} old cache entries`);
    }
  } catch (error) {
    console.warn('Cache cleanup failed:', error);
  }
}

// Utility functions for notifications
async function sendQueuedAnalytics() {
  // Implementation for sending queued analytics data
  try {
    const queuedData = await getQueuedAnalytics();
    if (queuedData.length > 0) {
      // Send queued data when online
      await Promise.all(queuedData.map(data => sendAnalyticsData(data)));
      await clearQueuedAnalytics();
    }
  } catch (error) {
    console.warn('Failed to send queued analytics:', error);
  }
}

async function getQueuedAnalytics() {
  // Get analytics data from IndexedDB or localStorage
  return [];
}

async function sendAnalyticsData(data) {
  // Send individual analytics event
  return fetch('/analytics', {
    method: 'POST',
    body: JSON.stringify(data),
    headers: { 'Content-Type': 'application/json' }
  });
}

async function clearQueuedAnalytics() {
  // Clear queued analytics data
}

function scheduleReminder(delay) {
  // Schedule a reminder notification
  setTimeout(() => {
    self.registration.showNotification('Breathing Reminder', {
      body: 'Time for another mindful breathing session 🌿',
      icon: '/icon-192.png',
      tag: 'scheduled-reminder'
    });
  }, delay);
}

// Run cleanup on activation
self.addEventListener('activate', () => {
  cleanupOldCaches();
});

console.log('Service Worker loaded successfully');
