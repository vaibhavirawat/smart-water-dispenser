// Keeps the dashboard shell available when the server cannot be reached, so the page can open in
// "offline demo" mode. API calls are never cached or intercepted.
const CACHE = 'swd-shell-v1';
const SHELL = ['/', '/login.html', '/app.js', '/sample.js', '/style.css', '/theme.js', '/login.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first (so upgrades show up immediately), falling back to the cached copy after 4 s or on failure.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith((async () => {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 4000);
    try {
      const res = await fetch(e.request, { signal: ctl.signal });
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    } catch {
      return (await caches.match(e.request, { ignoreSearch: true })) ||
        (e.request.mode === 'navigate' ? await caches.match('/') : undefined) || Response.error();
    } finally { clearTimeout(t); }
  })());
});
