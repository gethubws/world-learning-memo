// Only the public interface is cached. Records live in IndexedDB; legacy account APIs never enter this cache.
const CACHE = 'world-memo-shell-v2';
const permittedAsset = (url) =>
  url.origin === self.location.origin &&
  !/^\/(?:api|signin-with-chatgpt|signout-with-chatgpt|callback)(?:\/|$)/.test(
    url.pathname,
  ) &&
  /\.(js|css|png|webmanifest|woff2)$/.test(url.pathname);
async function remember(request) {
  const response = await fetch(request);
  if (response.ok && !response.redirected) {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}
self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all(
      [
        '/',
        '/manifest.webmanifest',
        '/icons/icon-192.png',
        '/icons/icon-512.png',
      ].map((path) => remember(path).catch(() => undefined)),
    ).then(() => self.skipWaiting()),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter(
                (key) => key.startsWith('world-memo-shell-') && key !== CACHE,
              )
              .map((key) => caches.delete(key)),
          ),
        ),
      self.clients.claim(),
    ]),
  );
});
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CACHE_APP' || !Array.isArray(event.data.urls))
    return;
  const urls = [...new Set(event.data.urls)].slice(0, 100).flatMap((value) => {
    try {
      const url = new URL(value);
      return permittedAsset(url) ? [url.href] : [];
    } catch {
      return [];
    }
  });
  event.waitUntil(
    Promise.all(urls.map((url) => remember(url).catch(() => undefined))),
  );
});
self.addEventListener('fetch', (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    /^\/(?:api|signin-with-chatgpt|signout-with-chatgpt|callback)(?:\/|$)/.test(
      url.pathname,
    )
  )
    return;
  if (request.mode === 'navigate' && url.pathname === '/') {
    const network = remember('/').catch(() => null);
    event.waitUntil(network);
    event.respondWith(
      (async () =>
        (await (await caches.open(CACHE)).match('/')) ||
        (await network) ||
        new Response(
          '请联网打开一次，完成页面缓存。本机笔记仍保留在此浏览器中。',
          {
            status: 503,
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          },
        ))(),
    );
  } else if (permittedAsset(url)) {
    event.respondWith(
      (async () =>
        (await (await caches.open(CACHE)).match(request)) ||
        (await remember(request)))(),
    );
  }
});
