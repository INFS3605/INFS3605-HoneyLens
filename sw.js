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

// v5: startup-tracing/production-safeguard changes (index.html) plus a
// controlled update flow — a new version reaches "waiting" and stays there
// until the tester explicitly presses "Reload and update" (see
// js/sw-register.js). The "stuck on an old version forever" failure mode
// found while testing this is fixed a different way: updateViaCache:'none'
// on registration plus a periodic registration.update() call make the
// browser actually notice a new sw.js promptly, instead of silently going
// stale — not by skipping the tester's consent to update. Authentication
// state itself is never cached by this service worker (see the fetch
// handler below) — only the STATIC SCRIPT FILES implementing it are.
//
// v6: confirmed live (via Cache Storage inspection) that a browser with an
// already-activated worker for a given CACHE_VERSION keeps serving that
// version's cached JS indefinitely — reload or not — because the update
// check only fires on a byte change to sw.js itself. Editing the cached
// files without bumping this constant is a no-op for anyone already
// running the app: this shipped the QR-generation and session-ID-sync
// fixes, and the debug tracing added while diagnosing that. Same
// cache-first fetch strategy and controlled (tester-consented) activation
// as v5 — only the version string changed.
//
// v7: ships the auth false-positive fix — assertNotAccidentalDemo() (in
// index.html) no longer infers Demo Mode from state.tester.name (a real
// Supabase profile can legitimately be named "Ana Tupou"), only from the
// explicit state.authMode/isDemoModeSession() signals — plus the [AUTH
// TRACE] logging added while diagnosing it. Same controlled, tester-
// consented activation as v5/v6 — only the version string changed.
//
// v8: ships js/sync-service.js's device-registration fix (session_events.
// device_id has a foreign key to devices(id) that nothing previously ever
// satisfied) and js/backend-adapter.js's authMode trace field — both are
// CORE_ASSETS, so without this bump a browser already on v7 would keep
// running the pre-fix sync-service.js indefinitely (see the v6 note above
// for why). Requires supabase/migrations/002_fix_session_event_version_
// baseline.sql to also be applied to the project — that's a database
// change, entirely separate from this cache version and not something
// this file can do. Same controlled, tester-consented activation as
// every version above — only the version string changed.
//
// v9: ships the version-baseline correction (client unaffected — server-
// only, migrations 003/004) and js/sync-service.js's already_applied
// handling + cross-tab Web Locks mutex, plus index.html's
// already_running_elsewhere toast. Same reasoning as v8: both changed
// files are CORE_ASSETS, so a browser already on v8 would otherwise keep
// running the pre-fix sync-service.js indefinitely. Requires
// supabase/migrations/003_correct_version_baseline_convention.sql and
// 004_handle_identical_stale_events.sql to also be applied to the
// project — a database change, separate from this cache version. Same
// controlled, tester-consented activation as every version above.
//
// v10: ships js/sync-service.js's fill-null-only merge support
// (merged_missing_fields status handling) and the 50s periodic reconnect
// sync retry. Requires supabase/migrations/005_fill_null_only_merge.sql
// to also be applied to the project — a database change, separate from
// this cache version. Same controlled, tester-consented activation as
// every version above — only the version string changed.
//
// v11: tester-app stabilisation pass (fix/tester-app-stabilization) — 7
// fixes: (1) dropdowns silently pre-selecting a real answer instead of a
// genuine blank placeholder, (2) required fields now marked with an
// asterisk + inline validation highlight, (3) the hard-coded "Offline"
// badge replaced with real navigator.onLine state, (4) a persistent,
// always-reachable sync-status pill + "Sync now" (previously only
// reachable from a finalised Dispense screen), (5) sync-service.js's
// pending/failed double-counting corrected, with a new disjoint Syncing
// bucket, (6) a "Show latest QR" retrieval action (Search Client), no
// new event/store, and (7) the active festival now shown explicitly and
// kept in sync when switched, with an unsynced-records warning before
// switching away from one. No schema/migration change required for any
// of this. Same controlled, tester-consented activation as every
// version above.
//
// v12: sequential multi-device QR handover fix (see the sync-conflict
// investigation for session 4da8558f-813e-4369-9668-aea395047117). A
// real station-to-station handover now confirms sync before generating
// the QR when possible, marks it clearly when it can't, and locks the
// sending device from further edits until explicitly reopened; a scanned
// QR is checked against the server (when reachable) before being treated
// as current; a rejected sync now corrects this device's local copy
// immediately instead of repeating the same failure on every later save.
// index.html and js/sync-service.js both changed — both are CORE_ASSETS,
// so this bump is required for the fix to actually reach a browser
// already on v11 (see the v6 note above for why). No schema/migration
// change required — client-side only. Same controlled, tester-consented
// activation as every version above.
//
// v13: fixes v12 treating EVERY station save as a handover, including
// Distance -> Near (same station — STEP_STATION.Near='Distance'), which
// wrongly locked the sending device out of a step it should have
// continued into directly. finishStationTask() now calls the new
// isCrossStationHandover() — compares the station actually active right
// now against the station the NEXT required step needs (the same
// STEP_STATION mapping getRequiredStation() already used) — instead of
// treating "not individual mode" alone as reason enough to lock. Only
// index.html changed. No schema/migration change required. Same
// controlled, tester-consented activation as every version above.
//
// v14: Exit is not a physical station. Route "none" (Distance pass +
// Near pass) sends the next required step straight to 'Exit', which
// still carries its own STEP_STATION entry for other purposes (station
// picker, read-only review after completion) — but for the ACTIVE
// same-device-continues decision, both isCrossStationHandover() and
// canActiveTesterOpenSession() now special-case next==='Exit' so it's
// never treated as a handover target and never blocked by the station-
// role check either. STEP_STATION and DE.canOpenStep() themselves are
// untouched — this is a narrow exemption in the two wrapper functions
// that already owned this decision, not a change to the clinical
// decision engine. Only index.html changed. No schema/migration change
// required. Same controlled, tester-consented activation as every
// version above.
//
// v15: Honey Rewards audit fix. Every clinical save (Registration,
// Distance, Near, Wheel, Paddle) used to call awardHoney() directly via
// finishStationTask(), so a client passing through Distance THEN Near
// earned two separate rewards for one physical station — the same bug
// class as v13's handover lock, just in the reward system instead. Honey
// is now only ever granted through the single awardStationHoney(session,
// step) function: it checks isStationResponsibilityComplete() (same
// STEP_STATION mapping as isCrossStationHandover() — Near shares
// Distance's station) and a persisted (client, station, tester) dedup set
// (state.honeyAwards / localStorage 'hl_honey_awards', independent of the
// daily/monthly counters so it never expires on a day rollover) before
// incrementing anything. QR generation, reopening, rescanning, sync
// retries, refreshes, and corrections all recompute the same key and hit
// the same guard, so none of them can grant a second reward. Exit awards
// nothing of its own (the Distance station's reward already covers it,
// same as v14's handover fix). Individual Testing mode is unaffected in
// principle (one reward per physical station the same tester completes)
// — this file only changed because index.html did. No schema/migration
// change required — this is a client-side, local-dedup fix only; the
// confirmed Supabase honey_events total is a known, separate, unfixed gap
// documented in the delivery report, not silently addressed here. Same
// controlled, tester-consented activation as every version above.
//
// v16: closes v15's known server-side gap. supabase/migrations/
// 011_station_based_honey_rewards.sql corrects apply_session_event() to
// award Honey once per (session, station, tester) — the same rule as
// v15's client-side fix — instead of once per honey-eligible event, so
// Distance+Near no longer create two confirmed honey_events rows.
// js/backend-adapter.js's HONEY_ELIGIBLE_EVENT_TYPES drops
// 'exit_completed' to match (Exit never independently confirms Honey
// server-side any more, same as it never does locally). Requires
// 011_station_based_honey_rewards.sql to also be applied to the Supabase
// project — a database change, separate from this cache version, not
// something this file can do; the tester app keeps working correctly
// offline/locally either way, per the existing local-first design. Same
// controlled, tester-consented activation as every version above.
//
// v17: simplifies the tester-facing sync pill and Sync screen — no more
// raw "conflict"/"retry needed"/"pending" breakdown. Every locally-queued
// item that hasn't safely reached Supabase (pending, retry-needed, OR an
// unresolved conflict — see waitingToSyncCount()) is now shown as one
// plain count: "N items waiting to sync", "Syncing…", "Offline · N
// saved", or "Synced". getSyncStatus() in js/sync-service.js, conflict
// detection, retry/backoff, and server-snapshot reconciliation are all
// completely unchanged — this is a rendering-only simplification;
// sync_conflicts and the real technical picture remain fully intact and
// reviewable directly in Supabase. Same controlled, tester-consented
// activation as every version above.
// v18: fixes v17's own bug. waitingToSyncCount() included
// conflictedCount, but a conflicted event is `pendingEvents.remove()`d
// and moved into the separate `conflicts` IndexedDB store the moment
// pushEvent() classifies it (js/sync-service.js) — runSyncLoop() only
// ever reads pendingEvents, never conflicts, and nothing calls
// conflicts.remove(). So a device with only historical conflicts and no
// genuinely queued work showed e.g. "6 items waiting to sync" even
// though pressing "Sync now" could never change that number — confirmed
// live against the real IndexedDB store, not just in theory. Now
// waitingToSyncCount() = pendingCount + retryCount only; conflicts are
// still fully preserved (never deleted) but no longer drive this
// operational, tester-facing count. Only index.html changed. No
// schema/migration change. Same controlled, tester-consented activation
// as every version above.
// v19: fixes manual "Sync now" doing nothing when every queued event is
// within its automatic-retry backoff window. Root cause: runSyncLoop()'s
// `due` filter applied the same nextRetryAt check to every trigger — the
// tester pressing "Sync now" was silently subject to the exact same
// bounded-exponential-backoff timer as a background retry, so if a prior
// transient failure had just set a ~20s backoff, pressing Sync now
// filtered those events out before pushEvent() was ever called ("2 items
// waiting to sync" -> press Sync now -> "0 records synced", reproduced
// live against real IndexedDB with a stubbed network layer). syncNow()/
// runSyncLoop() now take {manual:true} (only index.html's
// manualSyncNow() passes it) — a manual run ignores nextRetryAt entirely
// and, on a transient failure, blocks only THAT session's later events
// (preserving per-session order) while continuing to attempt every other
// independent session's due events, instead of aborting the whole run on
// the first failure like an automatic run still correctly does. No
// change to conflict handling, ordering, or any automatic trigger. Only
// index.html and js/sync-service.js changed. No schema/migration change.
// Same controlled, tester-consented activation as every version above.
// v20: adds visible reward feedback for every normal (non-milestone)
// Honey award. Root cause of the missing bee: honeyAfterSave() only
// ever called toast('+1 ...') for a plain reward (no bee/drop animation
// at all — that visual language existed ONLY inside showHoneyMilestone(),
// gated behind badgeUp), and even that toast was deferred until the
// handover QR's "Done" callback fired, not the moment the station was
// actually completed. New showHoneyPop() fires synchronously inside
// awardStationHoney() — the same place the reward itself is granted, on
// the same `awarded` boolean, so it can never fire for a restored/
// already-rewarded/reopened/corrected/resynced item — BEFORE
// finishStationTask() goes on to open the handover QR. It reuses the
// existing bee/honey-drop SVGs from showHoneyMilestone but is a
// separate, non-scrim overlay (no backdrop, nothing to dismiss,
// pointer-events:none, z-index above .scrim) so it renders on top of a
// QR opening moments later instead of being destroyed by scrim()'s own
// closeScrim() call, and survives screen navigation (attached to #phone,
// not #screen). Auto-removes itself after ~2.1s. showHoneyMilestone()
// itself is completely unchanged — still its own blocking celebration
// for actual daily-badge crossings. Only index.html changed. No
// schema/migration change, no change to the station-reward accounting
// logic itself. Same controlled, tester-consented activation as every
// version above.
// v21 — the "+1 Honey" reward pop (showHoneyPop(), v20 above) was
// centered near the top of #phone, which visually collided with the
// handover QR modal's centered .scrim — the pop could render over part
// of the QR code, making it harder to scan right when a tester needed
// it most. Repositioned to a compact badge pinned to the top-right
// corner of #phone (below the header's connectivity/sync badges)
// instead of centered — .scrim always centers its .modal, so a
// corner-pinned pop sits outside that footprint on any tablet/desktop
// width, and a narrower @media (max-width:560px) variant keeps it
// compact on phones. pointer-events:none, z-index, dedup, and the
// ~2.1s auto-dismiss timing are unchanged — only CSS positioning/sizing
// and the pop's internal layout markup changed, not when or why it
// fires. No change to award/dedup logic, QR payload, handover locking,
// clinical routing, sync, or Supabase.
// v22 — Design-system Phase 2A: added css/ooxii-design-system.css, a new
// same-origin stylesheet of shared OOXii tokens (colour, radius, spacing,
// type-scale, shadow) now linked from index.html's <head>-equivalent
// section and consumed via var() aliases inside index.html's own :root
// block. It is a new CORE_ASSET (see above) so it precaches and works
// offline exactly like the existing js/*.js entries — a browser already
// on v21 would otherwise 404 on it forever. Purely additive: every
// existing --teal/--amber/--green/etc. custom property still resolves to
// the exact same colour it did before, just via the shared file instead
// of a hardcoded literal — no visual change expected from this version
// bump alone. No change to any clinical, sync, QR, Honey-award, or auth
// logic; presentation-only, same as v20/v21 above.
// v23 — Design-system Phase 2B: Home screen hierarchy refinement
// (index.html only). Replaced the four equal-weight gradient nav tiles
// with one context-aware PRIMARY WORK card (New Client at Registration /
// "Continue at <Station> station" with a live ready-count elsewhere /
// "Continue individual testing" / Eye Festival Mode's station picker when
// no station is chosen yet), a quiet SECONDARY WORK row (Search Client),
// and Individual Testing demoted to a clearly-alternate dashed row (hidden
// entirely once already in individual mode, since the sidebar already
// covers switching back to festival stations). Every onclick target
// (homeNewClient(), pickStation(), enterIndividualMode(), go(ScreenFestival)
// /go(ScreenSearchClient)) is pre-existing and unchanged — this reuses the
// exact station/mode state ScreenHome already read before, it just decides
// which single existing action to foreground. No routing, mode, station-
// gating, clinical, sync, QR, Honey-award, or auth logic touched.
// v24 — Design-system Phase 2C: clinical field-row visual refinement
// (index.html only). .frow (used by fieldSelect/fieldSeg/fieldNumber/
// roFieldSelect/roFieldSeg — Intake, Distance, Near, Wheel, Paddle,
// Dispense, Search, Festival, Exit) no longer renders each field as its
// own bordered/backgrounded/rounded card; it's now one continuous list
// separated by a hairline divider, same icon chip, label, required-mark,
// and min-height:64px touch target as before. .vfield (the stacked
// vision-test question block used by fieldEyeLine/fieldLetters on
// Distance/Near/Wheel/Paddle) keeps its tinted surface but drops the
// outlined border. markFieldInvalid()'s red-outline/message behaviour is
// untouched (it targets the control and appends a message node, not the
// row's own border) — verified live by leaving required Intake fields
// blank. No change to any clinical decision logic, validation rules,
// required-field enforcement, blank-dropdown defaults, station routing,
// QR handover, sync, Honey rewards, or auth.
// v25 — Design-system Phase 2D: aligned index.html's shared input/select
// radius to the same --ooxii-radius-sm token admin/index.html now uses
// (11px -> 10px, a 1px value change for cross-app consistency, not a
// layout change). The Insights Portal's own Phase 2D changes
// (admin/index.html, admin/js/admin-app.js) are separate, non-CORE_ASSET
// files this service worker never caches (the portal is online-only, no
// offline requirement, cache-busted via its own ?v= convention instead —
// see admin/index.html's script tags). No change to clinical, sync, QR,
// Honey-award, or auth logic.
const CACHE_VERSION = 'v25';
const CACHE_NAME = `ooxii-app-shell-${CACHE_VERSION}`;
const CACHE_PREFIX = 'ooxii-app-shell-';

// Mandatory — install fails (visibly, in both the SW lifecycle and the
// console) if any of these can't be fetched. Every locally-hosted script
// index.html loads, plus the two vendored QR libraries, plus the shared
// OOXii design-tokens stylesheet (css/ooxii-design-system.css) added
// alongside the rest of index.html's own inline styling — same
// same-origin, same precache-then-cache-first treatment as everything
// else here. No local fonts/icons (icons are inline SVG generated in JS).
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/css/ooxii-design-system.css',
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
  // Deliberately NO self.skipWaiting() here. A newly-installed worker sits
  // in "waiting" — the app must never silently swap a tester onto new code
  // mid-workflow. The earlier version of this comment removed this
  // guarantee after finding a real "stuck on an old version forever" bug;
  // that bug is fixed properly now (see js/sw-register.js's registration
  // options and periodic registration.update() call, both of which make
  // the browser actually notice a new version promptly, instead of relying
  // on skipWaiting to paper over never checking for updates). The tester
  // decides when it's safe via the "Reload and update" button — see the
  // `message` handler below, which only ever runs in response to that.
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
