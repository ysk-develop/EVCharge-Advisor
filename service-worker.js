// Keep APP_VERSION in sync with js/version.js
const APP_VERSION = '18';
const CACHE_NAME = `ev-charge-advisor-v${APP_VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/storage.js',
  './js/price-master.js',
  './js/price-engine.js',
  './js/price-editor-ui.js',
  './js/gemini-api.js',
  './js/geo.js',
  './js/charger-price.js',
  './js/route-model.js',
  './js/route-research.js',
  './js/charger-lookup.js',
  './js/charger-catalog.js',
  './js/charge-areas.js',
  './js/area-search.js',
  './js/app-pricing.js',
  './js/toll-calc.js',
  './js/energy.js',
  './js/climate.js',
  './js/spot-catalog.js',
  './data/chargers-jp.json',
  './data/tolls-kyushu.json',
  './data/spots/manifest.json',
  './data/spots/kyushu.json',
  './js/route-ui.js',
  './js/notice.js',
  './js/version.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function isNavigationRequest(request) {
  return request.mode === 'navigate' ||
    (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'));
}

function isVersionCritical(url) {
  const path = url.pathname || '';
  return (
    path.endsWith('/') ||
    path.endsWith('/index.html') ||
    path.endsWith('/service-worker.js') ||
    path.endsWith('/js/version.js') ||
    path.endsWith('/manifest.json')
  );
}

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res && res.ok && request.method === 'GET') {
      const clone = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw new Error('offline');
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res && res.ok && request.method === 'GET') {
    const clone = res.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (isNavigationRequest(req) || isVersionCritical(url) || url.pathname.includes('/data/spots/')) {
    event.respondWith(networkFirst(req));
    return;
  }

  event.respondWith(cacheFirst(req));
});
