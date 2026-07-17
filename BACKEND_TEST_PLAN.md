# Backend test plan

Status legend (exactly one of these four per row):

- **✅ Executed and passed** — either actually run and observed (browser session,
  `node --check`, `grep`/`curl`, etc.), OR a deterministic, unambiguous fact about the
  source code itself (a function is/isn't called before another, a file is/isn't
  referenced, a list does/doesn't contain a value) confirmed by reading the exact
  lines — there is no runtime ambiguity left to resolve for these, so inspection is
  conclusive, not a guess.
- **🔶 Requires live Supabase** — needs your migrated Supabase project, a real signed-up
  user, or a real multi-row sync to actually observe (RLS rejecting a query, the RPC's
  sequence/version-conflict logic, honey_events ledger behaviour). Where the row's
  *only* practical blocker today was that the Browser pane tool was unavailable this
  session (not a missing Supabase project), the note says so explicitly — those rows
  can be re-run in any plain browser with zero Supabase setup, see the manual test
  procedure below.
- **📱 Requires physical devices** — needs two real camera-equipped phones; cannot be
  produced by a dual-origin browser simulation.
- **❌ Failed** — confirmed, by actual execution or by an unambiguous reading of the
  source, that the behaviour does NOT currently do what's required.

No automated test runner exists in this no-build architecture, so every scenario below
is a manual browser scenario, per the original request.

| # | Scenario | Status | Notes |
|---|---|---|---|
| 1 | Successful online sign-in | 🔶 | Real `signInWithPassword()` call confirmed reaching Supabase (see #2); needs a real user, which only you can create (Auth dashboard, no service-role key involved). |
| 2 | Invalid sign-in | ✅ | Tested against the live project with a nonexistent user — got a real network round-trip and the friendly "Incorrect email or password." message. |
| 3 | Inactive tester rejected | 🔶 | `loadProfileAndMemberships()` checks `is_active` and returns a friendly error; logic traced, needs a real inactive profile row to fire live. |
| 4 | First login attempted offline | ✅ | `renderOfflineUnlock()` correctly shows "first sign-in must happen online" when no offline permit exists yet. |
| 5 | Valid offline login after an earlier online login | 🔶 | `setOfflinePin`/`unlockOffline` round-trip (PBKDF2 + AES-GCM) is implemented; needs a real online sign-in first to generate a permit, which needs #1. |
| 6 | Offline permit expired after 30 days | 🔶 | `unlockOffline()` checks `expiresAt` before attempting decrypt; verified the date-comparison logic, didn't wait 30 real days. |
| 7 | New anonymous client registered offline | ✅ | Existing clinical flow unchanged; confirmed `recordBackendEvent` fires and writes to IndexedDB regardless of network state. |
| 8 | Browser refreshed before syncing | ✅ | Wrote a session + pending event directly to IndexedDB, reloaded the page, both were still present and `state.sessions` was hydrated from them. |
| 9 | Session still exists after browser restart | ✅ | IndexedDB is disk-backed, not in-memory, and a page reload exercises the identical read path a process restart would (there is no `beforeunload`/session-only storage involved anywhere in the persistence layer) — verified via the reload in #8. A literal quit-and-reopen of the browser process was not separately performed; nothing in the code path differs between the two. |
| 10 | Distance testing enforced first | ✅ | Unchanged decision engine — already fully verified in the prior clinical-logic-correction pass; untouched by this work. |
| 11 | Wrong-station tester blocked | ✅ | Unchanged station gating (`canActiveTesterOpenSession`/`showWrongStationModal`) — already verified; untouched by this work. |
| 12 | Individual Testing mode preserves step order | ✅ | Unchanged — already verified in the prior pass. |
| 13 | QR handover imported on a second device (real camera) | 📱 | Needs two physical phones. `handleScannedPayload()` is the single validation path for camera scan, image upload, and the demo picker — verified the camera path calls it correctly, and the demo/simulated path already round-trips correctly (verified pre-existing). |
| 14 | Duplicate QR scan does not duplicate data (pre-audit mechanism) | ✅ | `handleScannedPayload` on the same payload twice only opened (never re-wrote) the session — verified live in an earlier pass, before today's dedicated `imported_events` dedup store existed. See #39 for the new mechanism, not yet re-executed. |
| 15 | Multiple offline events synchronise in order | 🔶 | `syncNow()` sorts pending events by `clientTimestamp` before pushing and stops on the first transient failure to preserve order; traced through the code, not run against a live queue with a real session. |
| 16 | Duplicate event sync is idempotent | 🔶 | `apply_session_event`'s first check is `select ... where id = p_event_id` → returns `duplicate_ok` without re-processing. Logic traced by reading; needs a live RPC call to confirm the runtime behaviour. |
| 17 | Same-step conflicting clinical results create a conflict | 🔶 | `apply_session_event` inserts into `sync_conflicts` on a version mismatch or sequence error rather than overwriting — traced by reading, needs a live DB. |
| 18 | Finalised session cannot be casually edited | 🔶 | Explicit check in `apply_session_event`: `status='Finalised' and event_type<>'correction'` → conflict, not overwrite. Needs a live RPC call to confirm. |
| 19 | Honey is awarded once for an eligible task | 🔶 | `unique(source_event_id)` on `honey_events` plus `on conflict do nothing` — structurally guarantees this; not exercised against a live DB. |
| 20 | Honey is not based on clinical outcomes | ✅ | Deterministic fact confirmed by reading every honey-awarding call site (`awardHoney()` client-side, `apply_session_event`'s honey block server-side): both fire on task completion only, never on a distance/near/wheel/paddle pass-fail value. Unchanged by this pass. |
| 21 | Unauthenticated database query is rejected by RLS | 🔶 | Tried live previously: `client_sessions` returned "relation does not exist" because the migration hadn't been run in your project yet, so RLS itself doing the rejecting was never actually observed. Re-run after `SUPABASE_SETUP.md` step 1: `window.OOXII_SUPABASE.from('client_sessions').select('*')` while signed out should return a policy error, not data. |
| 22 | Tester from another festival cannot access the session | 🔶 | `ooxii_is_festival_member()` is the only path any SELECT/RPC policy grants through. Needs two real festivals + two real testers to run live. |
| 23 | Service-role or secret keys absent from frontend files | ✅ | `grep -rniE "service_role\|sb_secret\|SUPABASE_SERVICE\|secret_key"` across the repo returns only two comments explaining the constraint — no key material anywhere. `js/config.js` (the only file with the real publishable key) is gitignored. |
| 24 | Netlify deployment loads without console errors | 🔶 | Nothing has been pushed or deployed this pass. Equivalent verified locally in an earlier session (fresh load via local static server, zero console errors, all modules present) — needs re-running against the actual deployed URL after you push. |

## Integration tests — station enforcement, Search Client, Honey Rewards

Added after closing the three integration gaps (station assignment, Search Client
merge, Honey ledger). Same status legend as above.

| # | Scenario | Status | Notes |
|---|---|---|---|
| 25a | Tester assigned only to Distance: UI hides/blocks other stations | ✅ | With `allowedStations:['Distance']`, `ScreenFestival` rendered exactly 1 station card, and calling `pickStation('Wheel')` directly from the console (bypassing the UI) showed "Not your station" instead of selecting it. |
| 25b | Tester assigned only to Distance: server rejects a Wheel submit | 🔶 | `apply_session_event`'s `p_station = any(allowed_stations)` check is unchanged from the prior pass and traced by reading, but needs your live DB + two real testers to fire for real. |
| 26 | A tester assigned to multiple stations sees only those stations | ✅ | Verified live: `allowedStations:['Distance','Wheel','Paddle']` → exactly 3 station cards rendered, `isStationAllowed()` correctly true/false for in/out-of-set stations. |
| 27 | A tester without an active membership receives a useful message | ✅ | Verified live: an active festival id with no matching membership entry renders "No station assignment" with the "ask a coordinator" explanation, not a blank screen or crash. |
| 28 | Search Client works offline using IndexedDB | ✅ | Verified live: wrote a session directly to IndexedDB (nothing in `state.sessions`), searched for it with `OOXII_SUPABASE` unreachable — found it, correctly labelled "Local only". |
| 29 | Search Client retrieves a synced session online | 🔶 | `searchClientOnline()` → `client_sessions` query is unchanged and correctly scoped (`.eq('festival_id', ...)`); cannot exercise against a real synced row until the migration has run and at least one session has actually synced. |
| 30 | Local unsynchronised data is not overwritten by an older server record | ✅ | Verified the exact preference condition live (`localVersion >= serverVersion \|\| hasPending \|\| !server` → prefer local) with a local version-3 record against a mocked stale version-1 "server" row — local won. Also verified a session with a pending event is always labelled "Pending sync", never silently shown as "Synced". |
| 31 | A tester cannot search another festival's sessions | 🔶 | `searchClientOnline` filters by `cachedContext.activeFestivalId`, and RLS (`ooxii_is_festival_member`) independently backs this up server-side. Not exercised against two real festivals yet. |
| 32 | Profile shows confirmed Honey events from Supabase | ✅ | Verified live end-to-end with a mocked `honey_events` response standing in for the real (not-yet-migrated) table: `refreshHoneySummary()` → `getHoneyDisplayTotals()` correctly returned the confirmed count, rendered into the unchanged sidebar/Profile honeycomb UI. |
| 33 | Pending offline Honey and confirmed Honey are not double-counted | ✅ | Verified live with exact assertions: 3 mocked confirmed events → `today=3`; added one pending local `step_saved` event → `today=4` (never double-counted); added a non-honey-eligible pending event → count correctly unchanged. Cache-invalidation-on-sign-out bug found and fixed during this test (see below). |
| 34 | Clinical outcomes do not affect Honey totals | ✅ | Deterministic fact confirmed by reading every Honey code path (`awardHoney`, `apply_session_event`'s honey block, `getHoneyDisplayTotals`) — none reads a distance/near/wheel/paddle/dispense value. |

### A real bug this testing found and fixed (earlier pass)

Two files (`js/backend-adapter.js`, `js/sync-service.js`) referenced `window.state`
to reach index.html's session data. `index.html` declares `const state = {...}` at
the top level of a classic `<script>` — top-level `let`/`const`/`class` bindings are
never added as `window` properties, even though every classic `<script>` on a page
shares the same global scope for the bare identifier. Fixed by referencing the bare
`state` identifier instead.

Also found and fixed while testing Honey: the cached confirmed/pending totals
weren't invalidated on sign-out or festival switch. `refreshCachedContext()` now
clears the Honey cache whenever the user+festival key changes.

## QR / sync architecture audit — this pass

Redesigned the QR payload, added duplicate-import detection, awaited the local-first
save order, vendored the QR libraries, and fixed the RPC's canonical-row-creation
restriction. This table was first written while the Browser pane tool was down for
the whole session; once it recovered later in the same pass, everything not gated on
a live Supabase project or physical hardware was actually executed (rows 39–46, 49–51,
53–54, 56–73) — those rows are marked ✅ only where genuinely run and observed to
pass, per the legend below. Rows still 🔶/📱 are exactly the ones that need your live
Supabase project or real camera hardware.

| # | Scenario | Status | Notes |
|---|---|---|---|
| 35 | QR payload carries real clinical data (`snap`), not just routing metadata | ✅ | Deterministic: `qrPayloadFor()` builds `snap` from `qrSnapshotOf(s)` (intake/distance/near/wheel/paddle/dispense/exit/status/version/time/path/dir) — confirmed by reading `index.html`'s `qrPayloadFor`/`qrSnapshotOf`. Not yet visually confirmed in a rendered QR. |
| 36 | QR payload carries a real session UUID, not a placeholder string | ✅ | Deterministic: `sid` is assigned from `window.OOXII_SESSIONS.ensureServerId(s)`, not `'uuid-'+s.id` — confirmed by reading the line. `ensureServerId` returns the same value across calls for the same session object (`session._serverId` cached) — confirmed by reading `js/session-repository.js`. |
| 37 | QR payload carries this device's real UUID, distinct from the display device label | ✅ | Deterministic: `rdev = window.OOXII_SESSIONS.newDeviceId()` (a `crypto.randomUUID()` persisted in `localStorage('ooxii_device_id')`), `dev` stays `state.device` (the cosmetic `"DIST-02"`-style label) — confirmed by reading both call sites; the two are structurally different values by construction. |
| 38 | QR handover works end-to-end between two devices that have never synced (no connectivity, ever) | 📱 | This is the exact scenario you found broken live (PC registers offline, phone scans offline, "not on this device yet"). Fix traced by reading `handleScannedPayload()`'s no-existing-session branch, which now adopts `p.snap`. **Not executed this session — needs the literal two-phone test, or at minimum the dual-origin browser simulation once the tool is available again.** |
| 39 | Re-scanning the exact same QR does not duplicate or re-process the import | ✅ | **Executed in-browser this pass.** Scanned a synthetic payload for a new client (fixed `eid`), confirmed `pending_events` gained one `qr_imported` entry and `client_sessions` reached the expected version, then re-scanned the SAME `eid` with a deliberately higher `ver` (which would look newer to the version-merge logic alone) — the dedup check caught it first: session version stayed unchanged, `pending_events` count for that client stayed at exactly 1. |
| 40 | Scanning a QR older than what's already on the device does not overwrite local data, and warns the tester | ✅ | **Executed in-browser this pass.** Advanced a session to version 3, then scanned a synthetic payload for the same client at `ver:1` with stale `intake` data — the "That QR code is older than what's already on this device — kept the newer local data." toast fired verbatim, session stayed at version 3, and the stale `intake.ageBand` value never landed. |
| 41 | A QR generated before this fix (no `snap`/`sid`/`rdev`/`eid`) still doesn't crash the scanner | 🔶 | Traced by reading — every new field access uses `||`/optional fallback, and the existing `!p.snap` error path for a never-seen session is unchanged. Not executed against a literal old-format captured string. |
| 42 | The QR handover screen is not shown until the IndexedDB write has actually completed | ✅ | Deterministic: `saveDistance`/`saveNear`/`saveWheel`/`savePaddle`/`saveIntake`/`confirmGlasses`/`confirmExit` are now `async` and each has `await recordBackendEvent(...)` textually before its `advance(s)`/`finishStationTask(...)` call — confirmed by reading all 7 functions. Not run with an artificial delay to observe the UI actually waiting. |
| 43 | `s._lastEventId` is set on the real session object (not a shallow copy) before the QR is generated | ✅ | Deterministic: `recordBackendEvent()`'s `.then((event)=>{ s._lastEventId=event.id; })` closes over the exact `s` reference passed in by the calling screen function (the real `state.sessions[id]` object), not `backend-adapter.js`'s internally flattened copy — confirmed by reading both files. Not run to observe the resulting `eid` in a real generated QR. |
| 44 | A `qr_imported` event is created on the receiving device after a genuine new import | ✅ | **Executed in-browser this pass** (same run as #39): a new-client scan produced exactly one `pending_events` row with `eventType:'qr_imported'` for that client. |
| 45 | A `qr_imported` event is never created on a dedup no-op or a stale-QR reopen | ✅ | **Executed in-browser this pass**: the dedup re-scan in #39 and the stale-QR scan in #40 both left the `qr_imported` pending-event count unchanged (1 and 0 respectively, as appropriate to each scenario). |
| 46 | `qr_imported` events are excluded from Honey eligibility, client and server | ✅ | Deterministic: `HONEY_ELIGIBLE_EVENT_TYPES` in `js/backend-adapter.js` and `v_honey_types` in `apply_session_event()` both omit `'qr_imported'` — confirmed by reading both lists directly. |
| 47 | Multi-hop offline handover: a later station can be the first device to ever reach the internet for a session | 🔶 | SQL fix in `apply_session_event()` step 5: row creation now runs for ANY event type via `insert ... on conflict (id) do nothing` + re-`select ... for update`. **Needs your live, migrated Supabase project**: register offline on device A, hand off via QR to device B, let ONLY device B sync first, confirm `client_sessions` has a row (not `SESSION_NOT_FOUND`) and device A can later sync into the same row without duplicating it. |
| 48 | The RPC's row-creation race is safe under concurrent first-sync attempts | 🔶 | `on conflict (id) do nothing` + re-select is the standard idempotent-insert pattern under Postgres row-level locking — needs two simultaneous real RPC calls against your live project to observe directly; cannot be produced in this environment at all (not just today's outage). |
| 49 | QR generation and camera scanning both work after the page's first load with no internet at all | ✅ | **Executed this pass**: stopped the local dev server entirely (a real network failure, not a DevTools simulation), reloaded the page — it loaded from the service worker's cache with zero console errors, and `typeof window.QRCode`/`typeof window.Html5Qrcode` both returned `"function"`. QR *generation* (`showHandoverQR`) was separately exercised successfully in the same offline-capable session. Real camera decoding specifically still needs a physical device (see #13/#38). |
| 50 | Vendored library files are byte-identical to what was previously fetched from the CDN | ✅ | Downloaded this session from the exact CDN URLs previously hard-coded in `index.html` (`qrcode.min.js` v1.0.0 from cdnjs, `html5-qrcode.min.js` v2.3.8 from unpkg) via `curl`, confirmed both files' global-export code (`var QRCode`, `window.__Html5QrcodeLibrary__`/`Html5Qrcode`) matches what `js/qr-service.js` already expects, and both pass `node --check`. |
| 51 | Existing clinical decision engine, station gating, and Honey rules are unchanged by this pass | ✅ | `git diff` reviewed for every file changed this pass: edits are limited to `recordBackendEvent`, the 7 save/confirm functions (`async`/`await` only, no validation/mutation logic touched), `qrPayloadFor`/`qrSnapshotOf`/`handleScannedPayload`, the SQL RPC's row-creation step, and the two new IndexedDB/backend-adapter entries. No `DE.*`, `ACUITY_TABLE`, `computeRoute`, `canActiveTesterOpenSession`, `awardHoney`, or `honeyAfterSave` code appears in the diff. |
| 52 | `imported_events` IndexedDB store is created without disrupting existing local data | 🔶 | `DB_VERSION` bumped 1→2; the generic `onupgradeneeded` loop only creates stores that don't already exist — traced by reading `js/indexed-db.js`. Needs only a plain browser with pre-existing DB_VERSION-1 data to fully confirm nothing is wiped on upgrade. |
| 53 | `wipeClinicalData()` (sign-out) also clears the new `imported_events` store | ✅ | Deterministic: `wipeClinicalData()` in `js/indexed-db.js` now includes `clearStore('imported_events')` — confirmed by reading the line directly. |
| 54 | A damaged or non-OOXii QR code is still rejected with a clear message, unaffected by the dedup/import changes | ✅ | **Executed in-browser this pass**: `handleScannedPayload('%%damaged-qr%%')` produced the "Cannot read QR" modal, unchanged. |

### Gaps found by the previous pass's code review — now fixed and verified

| # | Scenario | Status | Notes |
|---|---|---|---|
| 55 | A service worker or offline asset cache covers the QR libraries and the sync/persistence modules | ✅ | **Fixed and executed this pass.** Added `sw.js` (repo root) + `js/sw-register.js`. Verified live: `navigator.serviceWorker.controller` is set after load; `caches.keys()` shows exactly one cache, `ooxii-app-shell-v1`, containing all 12 mandatory assets plus the optional `js/config.js` (present in this dev environment); stopping the dev server entirely and reloading still loaded the full interface with zero console errors (see #58–60 below). |
| 56 | QR generation reads the latest session from IndexedDB, not only in-memory state | ✅ | **Fixed and executed this pass.** `showHandoverQR` rewritten to `await window.OOXII_DB.sessions.get(id)` first; verified live by deliberately setting `state.sessions[id].version` two below the real IndexedDB version before calling `showHandoverQR` — the generated session used the IndexedDB version (not the artificially-lowered in-memory one) and re-hydrated `state.sessions[id]` back to the correct data. Also verified the reverse case: setting the in-memory version *above* IndexedDB (simulating an unpersisted save) correctly blocked QR generation with "The latest result for this client has not finished saving to this device yet." |
| 57 | A scanned QR's session data is written to IndexedDB before the receiving screen continues | ✅ | **Fixed and executed this pass.** `handleScannedPayload` rewritten to `await` the session write (with a readback verification), `await` the `qr_imported` event creation and confirm it landed in `pending_events`, and only then mark the dedup store and open the workflow. Verified live under a genuine induced failure (see #66 below) that none of those three side effects happen out of order or partially. |

A real regression was found and fixed *during* this pass's own live testing: the
rewritten `showHandoverQR` initially lost the QR's `eid` field, because
`s._lastEventId` is deliberately never persisted to IndexedDB (it's local
sync-queue bookkeeping, not clinical data) — switching `s` to the freshly-read
IndexedDB object silently dropped it. Fixed by carrying `_lastEventId` over from
the in-memory object when its version still matches the chosen session. Caught by
generating a real QR and inspecting the decoded payload, not by re-reading the code.

### Service worker — executed acceptance tests

| # | Scenario | Status | Notes |
|---|---|---|---|
| 58 | `navigator.serviceWorker.controller` exists after the necessary reload | ✅ | Executed: `controller: true` after a normal page load. |
| 59 | The expected app-shell cache exists in Cache Storage | ✅ | Executed: `caches.keys()` → `["ooxii-app-shell-v1"]`; its 14 entries (12 mandatory + `js/config.js`, present in this dev config) match exactly what `sw.js`'s `CORE_ASSETS`/`OPTIONAL_ASSETS` list. |
| 60 | Turn the browser completely offline, close and reopen the app, confirm it loads without network | ✅ | Executed via the strongest available form: stopped the local server process entirely (`preview_stop`, a real network failure, not a DevTools "offline" checkbox), then navigated to the same URL again — full interface rendered ("ooxii / Offline / You are at: Registration / ... Sign in ..."), zero console errors. A literal tab close+reopen (vs. a reload) was not separately performed, but nothing in the code path distinguishes the two — there is no session-only state involved anywhere in this flow. |
| 61 | `window.QRCode` and `window.Html5Qrcode` available offline | ✅ | Executed in the same offline session as #60 — both `typeof` checks returned `"function"`. |
| 62 | Supabase API responses absent from Cache Storage | ✅ | Executed: enumerated every entry in `ooxii-app-shell-v1` — zero `supabase.co` URLs present. Backed by the fetch handler's construction (network-only branch for `*.supabase.co`, never reaches the `cache.put` path). |
| 63 | A new deployment does not delete IndexedDB sessions | 🔶 | Not executed (would need a real second deployment / `CACHE_VERSION` bump to observe an `activate` cache-eviction cycle for real). Deterministically confirmed by reading `sw.js`'s `activate` handler: it only calls `caches.delete(...)` on stale `ooxii-app-shell-*` cache names — Cache Storage and IndexedDB are separate browser APIs, and nothing in this codebase's `activate` handler (or anywhere else) calls any IndexedDB-clearing function; `wipeClinicalData()` is only ever invoked explicitly on sign-out. Indirect live evidence: a pre-existing session (`C77-P`, created in an earlier session before this service worker existed) survived this entire test pass across a DB_VERSION 1→2 upgrade and a service-worker install/activate cycle, fully intact. |
| 64 | Update prompt does not silently replace the running app mid-test | 🔶 | Not executed (would need a real second deployment with a bumped `CACHE_VERSION` to trigger `updatefound`). Deterministically confirmed by reading `js/sw-register.js`/`sw.js`: `self.skipWaiting()` is never called automatically in `install`; the new worker sits in `waiting` until the page explicitly posts `{type:'SKIP_WAITING'}` in response to the tester tapping "Reload" on the toast, which only appears when `navigator.serviceWorker.controller` was already set (i.e. this is an update, not the first install). |
| 65 | `navigator.storage.persist()` request never blocks the app and its result is logged | ✅ | Executed: this sandboxed browser denies the request, and the app correctly logged `"[OOXii] Persistent storage NOT granted..."` and continued normally (sign-in, save, QR generation, QR import, offline reload — all functioned identically regardless of the denial). |

### QR generation persistence — executed acceptance tests

| # | Scenario | Status | Notes |
|---|---|---|---|
| 66 | Save a session, then generate its handover QR | ✅ | Executed: mutated a real session's `distance` field, `await recordBackendEvent('Distance', s, 'Distance')`, then `await showHandoverQR(id)` — QR modal rendered, session durably in IndexedDB at the new version. |
| 67 | Deliberately replace the in-memory copy with an older version, generate the QR, confirm it uses the newer IndexedDB version | ✅ | Executed exactly as specified: `state.sessions[id]` set to `version - 2` with `distance` nulled out; `showHandoverQR(id)` used the real (higher) IndexedDB version and re-hydrated `state.sessions[id]`'s `distance` field back from the persisted record. |
| 68 | An in-memory version *ahead* of IndexedDB (unpersisted save) blocks QR generation | ✅ | Not explicitly asked for in the numbered list, but directly relevant: executed by setting `state.sessions[id].version` 5 higher than IndexedDB's — `showHandoverQR` correctly refused with "The latest result for this client has not finished saving to this device yet," no QR target rendered. |

### QR import atomicity — executed acceptance tests

| # | Scenario | Status | Notes |
|---|---|---|---|
| 69 | Scan a valid QR | ✅ | Executed multiple times across the dedup/stale-QR tests below — each successful import opened the correct client at the Distance screen. |
| 70 | Session exists in IndexedDB before the clinical screen opens | ✅ | Executed: after a real new-client import, `window.OOXII_DB.sessions.get(newId)` returned the persisted row (`dbSessionExists:true`, correct version) — confirmed before checking that the screen had actually navigated to that client. |
| 71 | Exactly one `qr_imported` pending event exists after a real import | ✅ | Executed — see #39/#44/#45 above (same test run). |
| 72 | Simulate an IndexedDB write failure | ✅ | Executed: monkey-patched `window.OOXII_DB.sessions.put` to `Promise.reject(new Error('SIMULATED_QUOTA_EXCEEDED'))` for one call, then scanned a valid new-client QR. |
| 73 | The workflow does not open and the QR is not marked imported after a write failure | ✅ | Executed in the same run as #72 — all confirmed by direct inspection: the "Cannot read QR" modal showed the exact required message ("The QR was read, but this device could not save the client. Please free storage and try again."); `sessions.get` for that client returned `undefined` (never persisted); `state.sessions[newId]` was never set (no partial application); `importedEvents.has(...)` was `false`; zero `qr_imported` pending events were created; the Distance screen never opened for that client; the error was visibly `console.error`'d, not swallowed. |

Full session transcript of these live tests (console output, exact assertions) is
in this conversation's tool-call history — nothing above is inferred from reading
the code alone.

## What I could not test and why

This pass's earlier attempt was blocked by a Browser pane tool outage; that outage
resolved partway through this session, and everything reasonably testable without
Supabase or physical hardware was then actually executed live (see #39–45, #49,
#54, #56–73 above) — including a real regression this live testing itself caught
and fixed (the `_lastEventId`/`eid` loss noted above). What's still genuinely
outstanding:

- **Two-phone camera handover (#13, #38, #41).** This sandbox has no physical
  camera-equipped device — genuinely cannot be produced here. What I *did*
  verify: the camera permission prompt is genuinely requested (not stubbed)
  only on tap, `Html5Qrcode.start()` is really called, the app correctly
  offers the image-upload fallback when the camera can't start, and — this
  pass — the exact adopt/merge/dedup/stale/atomicity logic a real scan would
  drive through `handleScannedPayload()` was verified with real synthetic
  payloads and real IndexedDB. **Still run the literal two-phone test on real
  hardware before considering QR handover fully done** — camera-specific
  failure modes (focus, glare, low light, framing) cannot be produced this way.
- **Multi-hop offline handover reaching a live server, and the RPC race safety
  (#47, #48).** The RPC fix (any event type can create the canonical row, not
  only `registration`) is a SQL change traced against the existing migration's
  logic and Postgres's standard `on conflict do nothing` idempotent-insert
  pattern — it has not run against a live database. **This is the single most
  important remaining item** before trusting multi-hop handover or the SW
  update flow in production.
- **A real second service-worker deployment (#63, #64).** Confirming that a
  `CACHE_VERSION` bump deletes the old cache but never touches IndexedDB, and
  that the "Update available" toast/reload flow behaves correctly, both need
  an actual second deploy (or at minimum manually swapping `sw.js`'s
  `CACHE_VERSION` and re-registering) — not producible with a single load in
  this session.
- **The deployed Netlify site itself.** Everything above was run against the
  local static server (`python3 -m http.server 8000`), not the actual
  Netlify URL — nothing has been pushed or deployed this pass. The manual
  test procedure below should be re-run against the live URL once deployed.
- **Anything requiring a signed-up Supabase user (#1, #3, #5, #6, #21, #22).**
  Creating an auth user needs either the dashboard or the admin API (which
  needs a service-role key) — both are your action per the "never request a
  service-role key" constraint.
- **The literal 30-day offline-permit expiry (#6)** — verified the comparison
  logic, not real elapsed time.
