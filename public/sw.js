/* sake-collection App Shell Service Worker */

const CACHE_VERSION = '__SAKE_CACHE_VERSION__';
const PRECACHE_URLS = [];

function isStaticAssetPath(pathname) {
  return (
    pathname === '/manifest.webmanifest' ||
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/icons/')
  );
}

function shouldBypassServiceWorker(requestUrl, method, currentOrigin) {
  if (typeof method !== 'string' || method.toUpperCase() !== 'GET') {
    return true;
  }

  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    return true;
  }

  if (url.origin !== currentOrigin) {
    return true;
  }

  if (url.pathname === '/api/sync-config' || url.pathname.startsWith('/api/')) {
    return true;
  }

  if (url.pathname.startsWith('/cdn-cgi/')) {
    return true;
  }

  if (url.pathname === '/sw.js') {
    return true;
  }

  return false;
}

function isCacheableHtmlResponse(status, redirected, responseType, contentType) {
  if (status !== 200 || redirected || responseType !== 'basic') {
    return false;
  }

  if (!contentType) {
    return false;
  }

  return contentType.toLowerCase().includes('text/html');
}

function isCacheableStaticAssetResponse(pathname, status, redirected, responseType, contentType) {
  if (!isStaticAssetPath(pathname)) {
    return false;
  }

  if (status !== 200 || redirected || responseType !== 'basic') {
    return false;
  }

  if (!contentType) {
    return false;
  }

  const mime = (contentType.toLowerCase().split(';')[0] || '').trim();
  if (!mime || mime.includes('text/html')) {
    return false;
  }

  const lowerPath = pathname.toLowerCase();
  if (lowerPath.endsWith('.js') || lowerPath.endsWith('.mjs')) {
    return mime === 'application/javascript' || mime === 'text/javascript';
  }
  if (lowerPath.endsWith('.css')) {
    return mime === 'text/css';
  }
  if (lowerPath.endsWith('.png')) {
    return mime === 'image/png';
  }
  if (lowerPath.endsWith('.svg')) {
    return mime === 'image/svg+xml';
  }
  if (lowerPath.endsWith('.webmanifest')) {
    return mime === 'application/manifest+json' || mime === 'application/json';
  }

  return false;
}

async function handleNavigationRequest(request) {
  try {
    const networkResponse = await fetch(request);
    if (
      isCacheableHtmlResponse(
        networkResponse.status,
        networkResponse.redirected,
        networkResponse.type,
        networkResponse.headers.get('content-type')
      )
    ) {
      const cache = await caches.open(CACHE_VERSION);
      await cache.put('/', networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const cache = await caches.open(CACHE_VERSION);
    const cachedIndex = (await cache.match('/')) || (await cache.match('/index.html'));
    if (cachedIndex) {
      return cachedIndex;
    }
    return new Response('オフラインです。アプリを読み込めませんでした。', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function handleStaticAssetRequest(request, pathname) {
  const cache = await caches.open(CACHE_VERSION);
  const cachedResponse = await cache.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }

  const networkResponse = await fetch(request);
  if (
    isCacheableStaticAssetResponse(
      pathname,
      networkResponse.status,
      networkResponse.redirected,
      networkResponse.type,
      networkResponse.headers.get('content-type')
    )
  ) {
    await cache.put(request, networkResponse.clone());
  }
  return networkResponse;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      if (PRECACHE_URLS.length > 0) {
        const cache = await caches.open(CACHE_VERSION);
        await Promise.all(
          PRECACHE_URLS.map(async (assetUrl) => {
            const request = new Request(assetUrl, { cache: 'reload' });
            const response = await fetch(request);
            const isHtml = assetUrl === '/' || assetUrl === '/index.html';
            const cacheable = isHtml
              ? isCacheableHtmlResponse(
                  response.status,
                  response.redirected,
                  response.type,
                  response.headers.get('content-type')
                )
              : isCacheableStaticAssetResponse(
                  assetUrl,
                  response.status,
                  response.redirected,
                  response.type,
                  response.headers.get('content-type')
                );
            if (cacheable) {
              if (assetUrl === '/') {
                await cache.put('/', response.clone());
                await cache.put('/index.html', response);
              } else {
                await cache.put(assetUrl, response);
              }
            }
          })
        );
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_VERSION)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (shouldBypassServiceWorker(request.url, request.method, self.location.origin)) {
    return;
  }

  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigationRequest(request));
    return;
  }

  if (isStaticAssetPath(url.pathname)) {
    event.respondWith(handleStaticAssetRequest(request, url.pathname));
  }
});
