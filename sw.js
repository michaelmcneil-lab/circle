// Lets Circle open without a connection. The page itself is fetched fresh when
// online (so updates arrive right away) and served from the cache when offline.
const CACHE = 'circle-v3';
const KEEP = [CACHE, 'circle-photos']; // photos are managed by the page and survive app updates
const SHELL = ['./', 'index.html', 'config.js', 'manifest.webmanifest',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => !KEEP.includes(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const library = url.hostname === 'cdn.jsdelivr.net';
  if (!sameOrigin && !library) return; // Supabase API calls go straight to the network

  // Libraries are pinned to exact versions, so a cached copy never goes stale.
  if (library) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  // 'no-cache' asks GitHub whether the file changed instead of trusting the
  // browser's copy, which GitHub Pages lets go stale for up to 10 minutes.
  e.respondWith(fetch(req, { cache: 'no-cache' }).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('index.html'))));
});
