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

   CACHE_VERSION is bumped WITH EVERY APP RELEASE (owner's call, v50), named
   for the app version it ships with - a new worker installing is a second,
   independent way for a phone to take the new pages.

   Bump CACHE_VERSION whenever this file or the icons change, too. The old cache
   is deleted on activate, so nothing accumulates on the phone.
   ====================================================================== */
const CACHE_VERSION = 'echo-nexus-4.38';  // one number across lite, admin and this file
const PAGE_FUSE_MS = 2500;
/* Which app this phone runs. lite.html and admin.html share one worker
   because they share a folder, so when a notification is tapped with no
   window open there is otherwise no way to know which page to open. The
   worker notes whichever page it last served and opens that one. */
const LAST_APP = '/__lastapp';
/* A CACHE OF ITS OWN, NOT THE VERSIONED ONE (v62). It was kept in the
   versioned cache, which `activate` deletes on every release - so after an
   update the worker forgot which app this phone runs, and a notification
   tapped before the app was next opened launched lite.html. On the owner's
   phone that is a setup screen, and worse, that launch then recorded
   lite.html as the answer for ever after. This cache is never deleted. */
const LAST_APP_CACHE = 'echo-nexus-lastapp';

const SHELL = [
  './lite.html',
  './admin.html',
  './admin.webmanifest',
  './lite.webmanifest',
  './icon-192.png',
  './icon-badge.png',
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
    await Promise.all(names.map(n => (n === CACHE_VERSION || n === LAST_APP_CACHE) ? null : caches.delete(n)));
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
    if(/admin\.html$|lite\.html$/.test(url.pathname)){
      event.waitUntil(caches.open(LAST_APP_CACHE).then(c =>
        c.put(LAST_APP, new Response(url.pathname.split('/').pop()))).catch(() => {}));
    }
    /* ?fresh=... is the app itself asking for the newest page (the version
       check, or the version tap). It waits for the network - no fuse - and
       whatever arrives becomes the saved copy. */
    const wantsFresh = url.searchParams.has('fresh');
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      /* A NEW ADDRESS EVERY TIME (v51). GitHub's servers and some internet
         providers keep a page for ~10 minutes; asking for the same address
         could be handed that older copy even with no-cache. A unique query
         can only be answered by the newest file. */
      const bust = url.pathname + '?_=' + Date.now();
      const fresh = fetch(bust, { cache: 'no-store', credentials: 'same-origin' }).then(res => {
        if(res && res.ok) cache.put(pageKey, res.clone());
        return res;
      }).catch(() => null);
      if(wantsFresh){
        const res = await fresh;
        return res || new Response('', { status: 504 });
      }
      const fuse = new Promise(resolve => setTimeout(() => resolve('timeout'), PAGE_FUSE_MS));
      const first = await Promise.race([fresh, fuse]);
      if(first && first !== 'timeout') return first;
      const cached = await cache.match(pageKey);
      if(cached){
        event.waitUntil(fresh);   // keep fetching for next time
        return cached;
      }
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

/* ======================================================================
   NOTIFICATIONS (v61)

   Nexus on the reception PC sends these directly, the instant a visit is
   marked. Everything the notification says is already inside the push - the
   worker does no reading of its own, so it is quick and works with the app
   closed and the phone locked.

   The payload is whatever Nexus put there: { title, body, date, pid, silent }.
   Nothing is ever shown without text, because a push that shows nothing is
   how a browser withdraws permission to push at all.
   ====================================================================== */
self.addEventListener('push', (event) => {
  let d = {};
  try{ d = event.data ? event.data.json() : {}; }catch(e){ d = {}; }
  const title = String(d.title || 'Echo Nexus');
  const body = String(d.body || 'A visit was marked at the desk.');
  const opts = {
    body: body,
    icon: './icon-192.png',
    /* A BADGE IS NOT A SMALL ICON (v50). This was icon-192.png - the full
       colour logo - where Android wants a monochrome silhouette it can tint
       and draw at about twenty pixels. Phones differ in whether they render
       the badge at all: the owner's two handsets showed the same
       notification, one with a single logo and one with the tooth drawn
       twice, which is what sent us looking. icon-badge.png is the tooth
       alone, as alpha, so the system colours it and it stays legible on a
       light status bar and a dark one. */
    badge: './icon-badge.png',
    /* One tag, so a busy morning replaces rather than stacks. */
    tag: String(d.tag || 'echo-visit'),
    renotify: true,
    silent: !!d.silent,
    timestamp: Date.now(),
    data: { date: String(d.date || ''), pid: String(d.pid || '') }
  };
  if(!d.silent) opts.vibrate = [40, 60, 40];
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const tail = d.date ? '#day=' + d.date + (d.pid ? '&pid=' + d.pid : '') : '';
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for(const c of open){
      if(/admin\.html|lite\.html/.test(c.url)){
        try{ await c.focus(); }catch(e){}
        try{ c.postMessage({ type: 'openVisit', date: d.date || '', pid: d.pid || '' }); }catch(e){}
        return;
      }
    }
    let page = 'lite.html';
    try{
      const cache = await caches.open(LAST_APP_CACHE);
      const hit = await cache.match(LAST_APP);
      if(hit) page = (await hit.text()) || page;
    }catch(e){}
    await self.clients.openWindow('./' + page + tail);
  })());
});

/* ======================================================================
   A SUBSCRIPTION THE BROWSER RETIRES (v62)

   Chrome and Safari may retire a push subscription on their own - after a
   long silence, or when storage is cleared - and they say so exactly once,
   here. Without this the phone kept a subscription it no longer had, the
   clinic went on sending to an address nobody was listening at, and the app
   only noticed the next time somebody opened it. Which is precisely the case
   notifications exist to cover.

   The new subscription is sent straight to the relay, using the setup this
   phone already holds. The worker cannot read the app's localStorage, so the
   address and key are kept in a small cache entry the app writes on each
   open (see notifRefresh).
   ====================================================================== */
const SETUP_KEY = '/__relay';

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try{
      const cache = await caches.open(LAST_APP_CACHE);
      const hit = await cache.match(SETUP_KEY);
      if(!hit) return;
      const setup = await hit.json();
      if(!setup || !setup.url || !setup.key) return;
      let sub = event.newSubscription || null;
      if(!sub && setup.pub){
        const raw = Uint8Array.from(atob(String(setup.pub).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
        sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
      }
      if(!sub) return;
      const j = sub.toJSON();
      const u = new URL(setup.url);
      u.searchParams.set('key', setup.key);
      u.searchParams.set('action', 'pushSub');
      u.searchParams.set('dev', setup.dev || '');
      u.searchParams.set('mode', setup.mode || 'on');
      u.searchParams.set('sub', JSON.stringify({ endpoint: j.endpoint, keys: j.keys }));
      await fetch(u.toString(), { cache: 'no-store' });
    }catch(e){}
  })());
});
