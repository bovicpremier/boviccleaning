// Service worker for the installable Bovic app (Add to Home Screen).
// Pages: always fetched fresh from the network, with the last copy used only when offline.
// Scripts & styles under /assets/: network first. Images & fonts: from cache, refreshed in the background.
// Never touches /api/ (bookings, payments, prices) or the admin portal.
const VERSION = 'bovic-v4';
const PAGE_CACHE = VERSION + '-pages';
const ASSET_CACHE = VERSION + '-assets';
const PRECACHE = ['/index.html', '/book.html', '/pricing.html', '/contact.html'];

const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>You're offline</title><style>body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:#172a54;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:16px}
a{display:inline-block;margin-top:14px;background:#d92f78;color:#fff;padding:12px 24px;border-radius:999px;font-weight:700;text-decoration:none}</style></head>
<body><div><h2>You're offline</h2><p>Connect to the internet to book or see prices.<br>Need us now? Call us.</p><a href="tel:+16787994634">Call 678-799-4634</a></div></body></html>`;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(PAGE_CACHE)
      .then(c => Promise.all(PRECACHE.map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin') || url.pathname === '/sw.js') return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(PAGE_CACHE).then(c => c.put(url.pathname === '/' ? '/index.html' : url.pathname, copy));
          }
          return res;
        })
        .catch(async () =>
          (await caches.match(url.pathname === '/' ? '/index.html' : url.pathname, { ignoreSearch: true })) ||
          new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
    );
    return;
  }

  if (url.pathname.startsWith('/assets/') && /\.(js|css)$/i.test(url.pathname)) {
    // Scripts & styles: fresh copy first so site updates show immediately; cache only as offline fallback
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(ASSET_CACHE).then(c => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    // Images & fonts: cache first, refreshed in the background
    event.respondWith(
      caches.open(ASSET_CACHE).then(async cache => {
        const cached = await cache.match(req);
        const network = fetch(req)
          .then(res => { if (res.ok && res.type === 'basic') cache.put(req, res.clone()); return res; })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});
