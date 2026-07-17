/*
  sw.js — offline app-shell service worker for OOXii HoneyLens (repo root,
  registered with scope '/' so it controls the whole static site — see
  js/sw-register.js). Caches ONLY the static local assets needed to reopen
  the app and perform a QR handover with zero connectivity; never caches
  anything under *.supabase.co (auth/REST/RPC) or any non-GET request. See
  BACKEND_IMPLEMENTATION_PLAN.md, "Service worker / offline app shell", for
  the design rationale.

  The app must load successfully online at least once (so this file itself
  can install and the app shell can be cached) before offline reopening is
  guaranteed.
*/
'use strict';

// Bumped for the auth-bootstrap fix (js/auth-service.js, js/session-
// repository.js) — both are cache-first same-origin assets, so another
// version bump is what actually gets an already-installed service worker to
// re-fetch them, rather than serving stale copies forever. Authentication
// state itself is never cached by this service worker (see the fetch
// handler below) — only the STATIC SCRIPT FILES implementing it are.
const CACHE_VERSION = 'v4';
const CACHE_NAME = `ooxii-app-shell-${CACHE_VERSION}`;
const CACHE_PREFIX = 'ooxii-app-shell-';

// Mandatory — install fails (visibly, in both the SW lifecycle and the
// console) if any of these can't be fetched. Every locally-hosted script
// index.html loads, plus the two vendored QR libraries. There is no
// separate CSS file (all styling is inline in index.html) and no local
// fonts/icons (icons are inline SVG generated in JS) — confirmed against
// every <script src="..."> in index.html pointing same-origin.
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/js/config.example.js',
  '/js/supabase-client.js',
  '/js/indexed-db.js',
  '/js/auth-service.js',
  '/js/session-repository.js',
  '/js/sync-service.js',
  '/js/qr-service.js',
  '/js/backend-adapter.js',
  '/js/sw-register.js',
  '/js/vendor/qrcode.min.js',
  '/js/vendor/html5-qrcode.min.js',
  '/js/vendor/fflate.min.js',
];

// Optional — js/config.js is gitignored and legitimately absent in demo/
// no-backend deployments (index.html's own <script> tag already has an
// onerror fallback for exactly this case). A missing optional asset must
// NOT fail the whole install.
const OPTIONAL_ASSETS = ['/js/config.js'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      // Fetch each core asset with cache:'reload' — bypasses the browser's
      // ordinary HTTP cache (a layer entirely separate from this Cache
      // Storage bucket). cache.addAll()'s default fetch mode does NOT do
      // this, and can silently precache an already-stale ambient HTTP-cache
      // response for a file whose content changed but whose URL didn't —
      // confirmed happening during testing of this exact fix. A version
      // bump must always get the real, current bytes.
      await Promise.all(CORE_ASSETS.map(async (url) => {
        const res = await fetch(url, { cache: 'reload' });
        if (!res.ok) throw new Error('Failed to fetch ' + url + ': ' + res.status);
        await cache.put(url, res);
      }));
    } catch (err) {
      console.error('[OOXii SW] Install failed — a mandatory offline asset could not be cached. Offline reopening will NOT work until this succeeds.', err);
      throw err; // fail installation visibly — never activate a half-cached shell
    }
    await Promise.all(OPTIONAL_ASSETS.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (res && res.ok) await cache.put(url, res);
      } catch (err) {
        // Expected in demo/no-backend deployments — not fatal.
        console.info('[OOXii SW] Optional asset not cached (normal without a configured backend):', url);
      }
    }));
  })());
  // Deliberately NO self.skipWaiting() here. A tab that's already open keeps
  // running the OLD service worker (and its already-cached files stay
  // valid) until the tester explicitly accepts the "Update available"
  // prompt (see js/sw-register.js) — a tester mid-eye-test is never
  // silently switched onto new app code.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => caches.delete(name))
    );
    // Cache Storage and IndexedDB are separate systems — deleting an old
    // *cache* here never touches IndexedDB (state.sessions/pending_events/
    // etc.), which is where all clinical data actually lives.
    await self.clients.claim();
  })());
});

// The page (js/sw-register.js) posts this only after the tester explicitly
// accepts the "Update available" prompt.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isSupabaseRequest(url) {
  return /(^|\.)supabase\.co$/.test(url.hostname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only ever intercept GET — never cache or interfere with a write.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Supabase auth/REST/RPC: always network-only. Never cached, under any
  // circumstance — this is exactly the traffic that must never be served
  // stale or retained (session tokens, clinical data responses).
  if (isSupabaseRequest(url)) {
    event.respondWith(fetch(req));
    return;
  }

  // Any other cross-origin request (e.g. the Supabase JS SDK's CDN script)
  // is left entirely to the browser's normal handling — this service
  // worker only manages the app's own same-origin shell.
  if (url.origin !== self.location.origin) return;

  // Full-page navigations: try the network first (a normal online visit
  // always gets the live index.html), fall back to the cached shell only
  // when there is genuinely no connectivity.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch (err) {
        const cache = await caches.open(CACHE_NAME);
        const shell = await cache.match('/index.html');
        return shell || Response.error();
      }
    })());
    return;
  }

  // Same-origin static assets: cache-first. This cache is explicitly
  // versioned via CACHE_NAME — a new deploy ships a new CACHE_VERSION and
  // its own cache, it never mutates v1's entries in place.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        cache.put(req, res.clone()).catch((err) => {
          console.warn('[OOXii SW] Could not cache a newly-fetched asset:', req.url, err);
        });
      }
      return res;
    } catch (err) {
      return cached || Response.error();
    }
  })());
});
