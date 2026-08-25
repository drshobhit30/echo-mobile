/* ======================================================================
   Echo Nexus — service worker.

   Its one job: make the app open instantly, and open at all with no signal.
   It caches the SHELL (the page, its icons, its manifest). It never caches
   clinic data — that always comes from Drive, live, so the figures on screen
   are never quietly out of date.

   THE TRAP THIS AVOIDS
   A service worker that serves the page from cache first is the classic way
   to ship an app that cannot be updated: you upload a new index.html, and
   the phone keeps showing last month's build because it never asks the
   network. So the page itself is fetched NETWORK-FIRST — a fresh upload
   appears on the very next open while there is signal — and only falls back
   to the cache when the network fails. The cost is one quick request per
   open; the benefit is that a fix is never invisible on the device that
   needs it.

   Everything else same-origin (icons, manifest) is cache-first, since those
   change only when CACHE_VERSION changes.

   Bump CACHE_VERSION whenever the shell changes. The old cache is deleted on
   activate, so nothing accumulates on the phone.
   ====================================================================== */
const CACHE_VERSION = 'echo-nexus-v28';  // v14: clinic mark in the loading overlay

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    /* addAll fails the whole install if any one file 404s. Each is added
       individually instead: a missing icon should not leave the app with no
       offline support at all. */
    await Promise.all(SHELL.map(url =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
    ));
    /* Take over as soon as the new worker is ready rather than waiting for
       every tab to close — on a phone, "every tab closed" may be days away,
       and a fix should not wait that long. */
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map(n => n === CACHE_VERSION ? null : caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if(req.method !== 'GET') return;

  const url = new URL(req.url);

  /* Google's sign-in and the Drive API must NEVER be touched. Caching an
     authenticated response would risk showing one account's clinic data
     after a different sign-in, and a cached 401 would wedge the app out of
     its own session. Let them go straight to the network. */
  if(url.origin !== self.location.origin) return;

  /* The page: network first, cache as the safety net. This is what keeps a
     new upload from being invisible on the phone. */
  const isPage = req.mode === 'navigate'
    || (req.destination === 'document')
    || url.pathname.endsWith('/index.html')
    || url.pathname.endsWith('/');

  if(isPage){
    event.respondWith((async () => {
      try{
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_VERSION);
        cache.put('./index.html', fresh.clone());
        return fresh;
      }catch(e){
        const cached = await caches.match('./index.html');
        if(cached) return cached;
        return new Response(
          '<h1>Echo Nexus</h1><p>No connection, and no saved copy of the app yet. '
          + 'Open this once with a signal and it will work offline afterwards.</p>',
          { headers: { 'Content-Type': 'text/html' }, status: 503 });
      }
    })());
    return;
  }

  /* Everything else from this origin: cache first, then network, and store
     what the network gives so the next open is instant. */
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if(cached) return cached;
    try{
      const fresh = await fetch(req);
      if(fresh && fresh.status === 200 && fresh.type === 'basic'){
        const cache = await caches.open(CACHE_VERSION);
        cache.put(req, fresh.clone());
      }
      return fresh;
    }catch(e){
      return new Response('', { status: 504 });
    }
  })());
});
