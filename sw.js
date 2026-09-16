/* ======================================================================
   Echo Nexus — service worker.  v48 (16 Sep 2026)

   Its one job: make the apps open instantly, and open at all with no
   signal. It caches the SHELL (the pages, icons, manifests). It never caches
   clinic data — the apps keep their own copy of that, read through the relay.

   OPEN FROM THE SAVED COPY, UPDATE BEHIND IT (v48). Until v47 the page was
   fetched network-first: a fresh upload showed on the very next open, but
   every open waited on the network before anything appeared - on a weak
   signal, seconds of white. Now the saved page is shown at once and a fresh
   copy is fetched in the background for next time.

   The trade: an upload shows on the SECOND open after it, not the first.
   (Close the app and open it again to see a new version straight away.)

   EACH PAGE IS ITS OWN PAGE (v47, kept). lite.html and admin.html are cached
   under their own paths; asking for one never returns the other.

   Bump CACHE_VERSION whenever this file or the icons change. The old cache
   is deleted on activate, so nothing accumulates on the phone.
   ====================================================================== */
const CACHE_VERSION = 'echo-nexus-v48';  // v48: saved copy first, both apps on the relay

const SHELL = [
  './lite.html',
  './admin.html',
  './admin.webmanifest',
  './lite.webmanifest',
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

  /* Anything from another origin - the relay on script.google.com above
     all - is never touched. Clinic data must come live from the relay, and a
     cached answer could show one key's data after the key had changed. */
  if(url.origin !== self.location.origin) return;

  const isPage = req.mode === 'navigate'
    || (req.destination === 'document')
    || url.pathname.endsWith('.html')
    || url.pathname.endsWith('/');

  if(isPage){
    /* Keyed by the page's own path; the #relay=... setup part of a link is
       never sent to the server, so it does not split the cache. */
    const pageKey = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(pageKey);
      const fresh = fetch(req).then(res => {
        if(res && res.ok) cache.put(pageKey, res.clone());
        return res;
      }).catch(() => null);
      if(cached){
        event.waitUntil(fresh);   // update for next time, without making this open wait
        return cached;
      }
      /* Never opened here before: wait for the network this once. */
      const res = await fresh;
      if(res) return res;
      return new Response(
        '<h1>Echo Nexus</h1><p>No connection, and no saved copy of this page yet. '
        + 'Open it once with a signal and it will work offline afterwards.</p>',
        { headers: { 'Content-Type': 'text/html' }, status: 503 });
    })());
    return;
  }

  /* Icons and manifests: cache first, then network. */
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
