/* ======================================================================
   Echo Nexus — service worker.  v49 (16 Sep 2026)

   Its one job: make the apps open quickly, and open at all with no signal.
   It caches the SHELL (the pages, icons, manifests). It never caches clinic
   data — the apps keep their own copy of that, read through the relay.

   NETWORK FIRST AGAIN, WITH A SHORT FUSE (v49). v48 showed the saved page
   first and fetched the new one in the background, so an upload only
   appeared on the SECOND open - and felt slow to come live. Now:
     - the page is asked for fresh every open, bypassing the browser's own
       10-minute cache of GitHub's files (cache: 'no-cache'), so an upload
       shows on the very next open;
     - if the network has not answered within 2.5 seconds (weak signal), the
       saved copy is shown instead, so a bad signal never means a long white
       screen;
     - with no signal at all, the saved copy, as before.

   EACH PAGE IS ITS OWN PAGE (v47, kept). lite.html and admin.html are cached
   under their own paths; asking for one never returns the other.

   Bump CACHE_VERSION whenever this file or the icons change. The old cache
   is deleted on activate, so nothing accumulates on the phone.
   ====================================================================== */
const CACHE_VERSION = 'echo-nexus-v49';  // v49: network first, 2.5 s fuse, no stale browser cache
const PAGE_FUSE_MS = 2500;

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
    const pageKey = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      /* no-cache: always ask GitHub whether the page changed, instead of the
         browser quietly reusing its copy for up to ten minutes. */
      const fresh = fetch(new Request(req, { cache: 'no-cache' })).then(res => {
        if(res && res.ok) cache.put(pageKey, res.clone());
        return res;
      }).catch(() => null);
      const fuse = new Promise(resolve => setTimeout(() => resolve('timeout'), PAGE_FUSE_MS));
      const first = await Promise.race([fresh, fuse]);
      if(first && first !== 'timeout') return first;
      const cached = await cache.match(pageKey);
      if(cached){
        event.waitUntil(fresh);   // keep fetching for next time
        return cached;
      }
      /* Slow AND never saved: wait for the network after all. */
      const late = await fresh;
      if(late) return late;
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
