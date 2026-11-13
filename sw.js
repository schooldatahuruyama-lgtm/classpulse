// 通信が切れたときの画面だけを助ける。取れた応答は、常にネットワークのものを使う
const CACHE_NAME = 'classpulse-v1';

function shouldHandle(request) {
  return request.method === 'GET' && new URL(request.url).origin === self.location.origin;
}

function shouldCache(response) {
  return response.status === 200 && response.type !== 'opaque';
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    // 同じ origin のほかのアプリのキャッシュは消さない
    await Promise.all(names.filter((name) => name.startsWith('classpulse-') && name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!shouldHandle(request)) return;
  event.respondWith((async () => {
    let response;
    try {
      try {
        // navigate の Request に init を付けると例外になるブラウザがある
        response = request.mode === 'navigate'
          ? await fetch(request.url, { cache: 'no-cache', credentials: 'same-origin', redirect: 'follow' })
          : await fetch(request, { cache: 'no-cache' });
      } catch {
        // init 付きの取得が失敗しても、キャッシュより先に通常の取得を 1 回試す
        response = await fetch(request);
      }
    } catch (error) {
      const cache = await caches.open(CACHE_NAME);
      const saved = await cache.match(request);
      if (saved) return saved;
      if (request.mode === 'navigate') {
        const index = await cache.match(new URL('index.html', self.registration.scope).href);
        if (index) return index;
      }
      throw error;
    }
    // 保存の失敗を通信の失敗と混ぜない。200 以外の応答も、そのまま返す
    if (shouldCache(response)) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {}));
    }
    return response;
  })());
});
