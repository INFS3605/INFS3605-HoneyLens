# OOXii HoneyLens — backend implementation plan

This documents the existing prototype's data flow as the source of truth, then the
Supabase backend built on top of it, and exactly how the two connect.

## 1. Existing application, as found

Single file, `index.html` (~2,700 lines, vanilla HTML/CSS/JS, no build step). Everything
lives in one global `state` object and a set of render functions per screen.

### The session object (unchanged by this work)

`state.sessions[clientId]` — keyed by the anonymous client ID (e.g. `"A47-K"`), not a
UUID:

```js
{
  id, status, dir, time, path, version,
  intake:   { ageBand, gender, village, cataract, sessionType, notes },
  distance: { rightUnaided:{lineReached,bonusLetters,logmar}, leftUnaided:{...},
              hasGlasses, ownGlasses:{...}|null, testerId, deviceId, recordedAt },
  near:     { unaided:{...}, hasReading, ownGlasses:{...}|null, testerId, deviceId, recordedAt },
  wheel:    { pd, right:{lensType,spherePower,addOnUsed,addOnPower,colourTestResult,
              canReadLine9OrSmaller,visionImproved,toricUsed,toricPower,toricAxis,bestLens},
              left:{...}, testerId, deviceId, recordedAt },
  paddle:   { ageBand, suggestedPower, suggestionNote, clientPreference, selectedPower,
              preferenceOverrodeSuggestion, notes, testerId, deviceId, recordedAt },
  dispense: { glassesDispensed, frameSize, frameColour, testerId, deviceId, completedAt },
  exit:     { counsellingDone, glassesDispensed, testerId, deviceId, completedAt },
}
```

`state.queue` is an array of client IDs (display ordering for the various queue screens).

### Decision engine (unchanged by this work)

`DE.getNextRequiredStep(s)` is the single source of truth for "what happens next" —
`computeRoute()` (route table: `none|paddle_only|wheel_only|wheel_then_paddle`),
`getDistanceOutcome()`/`getNearOutcome()` (line-7/line-9 thresholds), `canEnterStep()`,
`canDispense()`. Every clinical screen calls `guardStep(step)` before rendering, which
calls into `DE`. See `CLAUDE.md` "Clinical decision engine" for the full contract.

### Station gating (unchanged by this work)

`getActiveTesterStation()`/`setActiveTesterStation()` read/write `state.role`, persisted
in `localStorage('hl_active_station')`. `canActiveTesterOpenSession(s)` is the single
gate every open-a-client path (`openQueueItem`, `simulateScan`→`handleScannedPayload`,
Search Client, direct navigation via `guardStep`) funnels through.

### QR payload (extended twice, never replaced)

```js
{ v:1, camp, cid, sid, fid, step, station, status, ver, ts, dev, rdev, tid, mode, eid, mac, snap }
```
First addition: `fid` (festival id) — a payload without it still validates (old QR
codes / demo mode keep working); a payload with a `fid` that doesn't match the
scanning device's active festival is rejected as "wrong festival".

Second addition — after a real two-device offline test surfaced that the payload
never carried actual clinical data (see "QR/sync architecture audit" below):
- `snap` — the session's actual field values (`intake`/`distance`/`near`/`wheel`/
  `paddle`/`dispense`/`exit`/`status`/`version`/`time`/`path`/`dir`). This is what
  makes a genuinely offline, never-synced handover between two devices possible at
  all — the QR *is* the only channel in that case.
- `sid` — the REAL `client_sessions.id` (`ensureServerId()`), replacing a placeholder
  `'uuid-'+cid` string, so a later sync from either device writes to the same server
  row instead of the receiving device accidentally creating a second one.
- `rdev` — the sending device's real, stable UUID (`newDeviceId()`), distinct from
  `dev` (the cosmetic station-role label like `"DIST-02"` already shown in the UI,
  kept unchanged for display).
- `mode` — `'festival'` or `'individual'`, so a receiving device can tell which
  gating rules produced this handover.
- `station` — the explicit next-required station (`getRequiredStation(s)`), rather
  than making the receiver re-derive it from `step` alone.
- `eid` — the id of the local event `recordBackendEvent` most recently queued for
  this session (`s._lastEventId`, set only once IndexedDB write + event queuing has
  actually resolved — see "local-first save ordering" below). Used purely for
  duplicate-import recognition; never required for the handover itself to work.

Nothing was removed — `dev`, `tid`, `mac` stay exactly as before for backward
compatibility with anything reading them, even though nothing in this codebase
currently reads a *received* payload's `dev`/`tid`/`mac`/`mode`/`station`/`rdev`
(they are write-side metadata / future-proofing, not load-bearing for `handleScannedPayload`
today except `cid`, `v`, `fid`, `snap`, `ver`, `eid`).

### Honey Rewards (unchanged by this work)

`awardHoney()`/`honeyAfterSave()` — participation/handover-based only, see
`CLAUDE.md`. Never touched by this backend work; `honey_events` mirrors it for the
synced, multi-device case (identical "never a clinical outcome" rule enforced again,
server-side, inside `apply_session_event`).

### Sign-in / Sync (replaced with real implementations)

Previously: `doSignIn()` accepted any non-empty email/password and set
`state.authed=true`; `ScreenSync()`/`simulateSync()` was a `setTimeout`-based fake
queue. Both are now real (see §3), with the previous behaviour kept as an explicit
`?demo=1` fallback so the prototype is still walkable with zero backend configured.

## 2. Integration decision — why the clinical screens were NOT rewritten

The clinical screens (`ScreenDistance`, `ScreenNear`, `ScreenWheel`, `ScreenPaddle`,
`ScreenDispense`, `ScreenExit`) and the decision engine they call were the highest-risk
part of the whole codebase to touch — a fully separate task hardened exactly this logic
immediately before this one. Rewriting them to be `async` (to await a network/IndexedDB
round-trip before allowing a save) would have meant re-testing every clinical rule from
scratch for no functional benefit.

Instead: **the screens stay 100% synchronous up to and including their own state
mutation.** Each `save*`/`confirm*` function keeps validating and mutating
`state.sessions[id]` exactly as before, then calls one line —
`recordBackendEvent(step, s, station)` — as the very last statement, AFTER its own
mutation and BEFORE handing off to `advance(s)` (which is what renders the QR
handover screen). `recordBackendEvent` itself still never touches the network
synchronously — it writes the session to IndexedDB, builds one sync event, queues
it, and (if online) kicks off a `syncNow()` in the background, uncoupled from the
save.

The 7 call sites now `await recordBackendEvent(...)` (the 7 functions are `async`)
so that step order is strictly: **(1)** decision-engine validation + mutation
→ **(2)** IndexedDB write of the session + the queued sync event (awaited) →
**(3)** UI advances / the handover QR is generated, now guaranteed to be able to
read `s._lastEventId` and a session already durably on disk. The perceptible delay
this adds is an IndexedDB write (single-digit milliseconds) — nothing here waits on
the network, and the decision engine itself is untouched. This closes a real gap
found during the QR/sync audit: previously the QR could be generated (and shown to
the tester to hand to the next station) before the write had actually landed in
IndexedDB.

The 7 hook points (identical pattern each time):

| Screen save function | step | event_type (SQL) |
|---|---|---|
| `saveIntake()` | `Registration` | `registration` |
| `saveDistance()` | `Distance` | `step_saved` |
| `saveNear()` | `Near` | `step_saved` |
| `saveWheel()` | `Wheel` | `step_saved` |
| `savePaddle()` | `Paddle` | `step_saved` |
| `confirmGlasses()` | `Dispense` | `dispense_completed` |
| `confirmExit()` | `Exit` | `exit_completed` |

There is now an 8th hook, not a screen save — `handleScannedPayload()` calls
`window.OOXII_BACKEND.recordEvent('QRImport', openedSession, station)` once, only
when a scan actually adopted or merged new data (never on a re-scan / no-op open).
`step='QRImport'` maps to `event_type='qr_imported'` and a full-field payload (see
"QR/sync architecture audit" below) — this is audit trail plus a canonical-row
safety net, not a clinical save, and is correctly excluded from `HONEY_ELIGIBLE_EVENT_TYPES`
on both sides (scanning a QR is not itself "work done").

## 3. New architecture

```
index.html (unchanged clinical engine + screens)
  │
  ├─ js/backend-adapter.js   ← the ONE boundary screens call (boot, recordEvent, search)
  │    ├─ js/session-repository.js  (IndexedDB read/write + event queue)
  │    ├─ js/sync-service.js        (push via RPC, pull snapshots, retry/backoff)
  │    ├─ js/auth-service.js        (Supabase auth + 30-day offline permit)
  │    └─ js/qr-service.js          (real camera scan, image fallback, generation)
  │         └─ js/indexed-db.js     (the only file touching the IndexedDB API)
  │         └─ js/supabase-client.js (the only file calling createClient())
  │
  └─ supabase/migrations/001_ooxii_backend.sql
       (profiles, festivals, festival_members, devices, client_sessions,
        session_events, honey_events, sync_conflicts; RLS on every table;
        apply_session_event() RPC — the only write path)
```

### Decision-engine mirror (SQL)

`apply_session_event()` must reject an out-of-order write even if a compromised or
buggy client sends one — RLS alone can't express "Distance must be recorded before
Near." `ooxii_distance_outcome()`, `ooxii_near_outcome()`, `ooxii_compute_route()`,
`ooxii_next_required_step()` mirror `getDistanceOutcome`/`getNearOutcome`/
`computeRoute`/`DE.getNextRequiredStep` — same line-7/line-9 thresholds, same route
table — reading the identical jsonb shape the browser already writes. This mirror is
deliberately narrow: it only re-implements what's needed to validate sequence, not the
LogMAR display math (that stays client-side only, where it's already correct and
tested).

### `apply_session_event(...)` — the only write path

Table-level `INSERT`/`UPDATE`/`DELETE` are revoked from `authenticated` on
`client_sessions`, `session_events`, and `honey_events` — the browser cannot write to
them directly no matter what the UI does. The function (`SECURITY DEFINER`) checks, in
order: authenticated + active profile → festival membership → station allowed (skipped
for `mode='individual'`, mirroring `canActiveTesterOpenSession`'s bypass) → duplicate
event id (idempotent no-op) → row lock → finalised-session guard → version match →
sequence validation via the mirror above → insert the immutable event → merge the
payload into the canonical row → award Honey (idempotent via
`unique(source_event_id)`).

### IndexedDB stores

`sessions`, `pending_events`, `synced_event_ids`, `imported_events`, `device`,
`context`, `sync_meta`, `conflicts`, `offline_permit` (`DB_VERSION` bumped 1→2 to add
`imported_events`; existing data in the other stores survives the upgrade — IndexedDB
version bumps only run `onupgradeneeded` to add what's missing, they don't wipe
anything) — see `js/indexed-db.js` header comment for exactly what each holds.
`synced_event_ids` and `imported_events` look similar but track opposite directions:
the former is this device's own outbox confirmed by the server; the latter is
handovers *received* from another device via QR, so a re-scan is recognised as a
no-op instead of being merged/recorded a second time.

## 3a. QR/sync architecture audit (this pass)

Prompted by a real-world test: register a client offline on a PC, then try to open it
at the Distance station on an offline phone by scanning the PC's QR code — this
failed, because at the time `qrPayloadFor()` only ever encoded routing metadata
(client id, next step, version number) and never the client's actual clinical field
values. That design was inherited from the original prototype, where "scanning a QR"
was simulated within one browser tab sharing one in-memory `state.sessions` object,
so it never needed to carry real data — the assumption was never revisited when real
camera scanning between separate physical devices was added. A follow-up fix added
`snap` (the actual field values) to the payload, which is what makes two devices that
have never synced able to hand a client off at all.

This pass is a deeper audit of that same handover path plus the sync path around it,
closing five further gaps:

1. **QR payload was still missing identity fields a real deployment needs** — a fake
   `sid`, no real device UUID, no explicit mode/station/event-id. Fixed (see the "QR
   payload" section above).
2. **No duplicate-import recognition.** Re-scanning the exact same handover (a
   tester shows the same QR twice, or scans a screen that wasn't dismissed) used to
   silently re-run the adopt/merge branch every time. Fixed with an `imported_events`
   IndexedDB store keyed by `eid` (or `cid:ver` when the sender has no event id yet)
   — `handleScannedPayload()` checks it first and just reopens the session if the
   import already happened.
3. **No explicit warning when a scanned QR is older than local data.** The
   "local wins if newer" rule already existed, but silently — a tester scanning a
   stale QR (e.g. from a screenshot, or a device that fell behind) got no signal
   anything was off. Now shows a toast: "That QR code is older than what's already on
   this device — kept the newer local data."
4. **No audit trail for QR-received data**, despite the schema already having a
   `qr_imported` `event_type`. Fixed — see the 8th hook point above.
5. **Local-first save ordering wasn't actually awaited** before the QR was shown to
   the tester. Fixed — see §2 above.

A sixth issue was found by reasoning through the RPC rather than by a live repro:
`apply_session_event()`'s canonical-row creation only ran for
`p_event_type = 'registration'`. In a genuinely offline, multi-hop deployment, the
registering device is not guaranteed to be the first one to ever reach the internet —
a later station's device (carrying a `qr_imported` event, or its own `step_saved`
event, with the client's full snapshot) could get online first. Under the old code
that device's sync would fail forever with `SESSION_NOT_FOUND`, because only a
`registration` event was allowed to create the row. Fixed in the migration: any event
type now creates the row if missing, using a race-safe
`insert ... on conflict (id) do nothing` + re-`select ... for update` — see
`supabase/migrations/001_ooxii_backend.sql`, `apply_session_event()` step 5.

**QR library vendoring.** `qrcodejs` and `html5-qrcode` were loaded from third-party
CDNs (`cdnjs.cloudflare.com`, `unpkg.com`). A festival's whole reason to run this app
is testing with zero connectivity — if either CDN were unreachable (network policy,
DNS, an outage) at the moment a tester tried to scan or show a QR, that would break
the one channel offline handover depends on, even though the rest of the app works
fine offline. Both libraries are now vendored as static files
(`js/vendor/qrcode.min.js`, `js/vendor/html5-qrcode.min.js`, same versions/bytes as
were previously fetched from the CDNs) and `index.html` loads them same-origin.

## 3b. Service worker — guaranteed offline reopening

Vendoring closed the "CDN unreachable at scan time" risk, but the app still had no
*guarantee* that its own JS files would still be available after a full close and
reopen with no connectivity — only the ordinary browser HTTP cache, which is not a
guarantee. `sw.js` (repo root, so its default scope is `/`, the whole site) plus
`js/sw-register.js` (registers it, handles the update prompt) close this gap:

- **App shell**: `cache.addAll([...])` on `install` covers every locally-hosted
  script `index.html` loads — `index.html`/`/` themselves, `js/supabase-client.js`,
  `js/indexed-db.js`, `js/auth-service.js`, `js/session-repository.js`,
  `js/sync-service.js`, `js/qr-service.js`, `js/backend-adapter.js`,
  `js/sw-register.js`, both vendored QR libraries, and `js/config.example.js`. There
  is no separate CSS file (all styling is inline in `index.html`) and no local
  fonts/icons (icons are inline SVG generated in JS), so that list is the complete
  app shell. `js/config.js` (gitignored, legitimately absent in demo/no-backend
  deployments) is cached best-effort *outside* `cache.addAll` — its absence must
  never fail the whole install, matching `index.html`'s own `onerror` fallback for
  the same file. `cache.addAll` failing on any MANDATORY asset fails installation
  visibly (both the SW lifecycle and a `console.error`) rather than activating a
  half-cached shell.
- **Never caches Supabase.** Every request to `*.supabase.co` (auth, REST, RPC) is
  routed network-only in the `fetch` handler, before it ever reaches the app-shell
  cache logic — confirmed empty of any Supabase URL after a full test pass (see
  `BACKEND_TEST_PLAN.md` #62). Non-GET requests are never intercepted at all.
- **Cache-first for the shell, network-first for navigation.** Same-origin static
  assets serve from cache immediately if present (falling back to network only on a
  cache miss); a full-page navigation tries the network first (so a normal online
  visit always gets the live `index.html`) and only falls back to the cached shell
  when the network genuinely fails.
- **Update flow deliberately does not auto-reload.** A new service worker installs
  and sits in `waiting` — `self.skipWaiting()` is never called automatically — so a
  tester mid-eye-test keeps running the already-cached app until they explicitly tap
  "Reload" on a small "Update available" toast (`js/sw-register.js`). Only then does
  the page post `{type:'SKIP_WAITING'}`, the new worker activates, deletes any stale
  `ooxii-app-shell-*` cache, calls `clients.claim()`, and the page reloads exactly
  once (`controllerchange` listener, guarded against firing twice).
- **Cache Storage and IndexedDB are unrelated systems.** The `activate` handler only
  ever calls `caches.delete(...)` on old cache *names* — nothing in this codebase
  ties a service-worker update to clearing IndexedDB; `wipeClinicalData()` remains
  an explicit, sign-out-only action.
- **`navigator.storage.persist()`** is requested best-effort at `js/indexed-db.js`
  load time (`requestPersistentStorage()`) — logs whether it was granted, never
  blocks anything if denied (most browsers deny it by default until the site is
  "installed" or heavily used, which is expected and handled).
- The app must load successfully online at least once, so the service worker itself
  can install and cache the shell, before offline reopening is guaranteed.

## 4. What currently disappears vs. persists

| Data | Persistence today |
|---|---|
| Clinical session data (distance/near/wheel/paddle/dispense/exit) | **IndexedDB** — survives refresh and browser restart |
| Pending sync events | **IndexedDB** — survives refresh/restart, retried on reconnect |
| Active station, tester mode | `localStorage` (unchanged from the earlier tablet-redesign work) |
| Honey daily/monthly counters | `localStorage` (unchanged — local-only; not yet mirrored from `honey_events`) |
| Signed-in auth context (for offline PIN unlock) | IndexedDB `context`/`offline_permit` stores |
| Supabase JWT/refresh token | `localStorage`, managed entirely by the Supabase SDK itself |
| Demo `seed()` clients | **In-memory only**, and only ever used when no real session has been persisted yet (see `demoSeedAllowed()`) |

Functions that will need IndexedDB (already using it) vs. still in-memory-only: nothing
clinical is in-memory-only anymore. The Profile page's Honey tier/achievement display
still reads local `state.honey` (in `localStorage`) rather than aggregating
`honey_events` from the server — flagged as a remaining gap in the completion report.

## 5. Integration status

All three screen-level integration gaps flagged in the first pass are now closed:

- **Eye Festival Mode** filters the station picker to the signed-in tester's real
  `festival_members.allowed_stations` (`allowedStationsForTester()`), blocks an
  unauthorised station both by hiding its card AND inside `pickStation()` itself (so
  a direct console call can't bypass the UI either), handles multiple festival
  memberships (a switcher appears when `ctx.festivals.length>1`), and shows a clear
  "no station assignment" screen when a tester has none. The RPC/RLS boundary that
  makes this a real security guarantee (not just a UI nicety) was already in place
  from the first pass — `apply_session_event`'s `p_station = any(allowed_stations)`
  check — and is unchanged here.
- **Search Client** (`OOXII_BACKEND.searchClient()`) is local-first (IndexedDB, then
  the in-memory demo fallback), enhanced with a festival-scoped online lookup,
  merges without duplicating, and never lets an older server snapshot overwrite
  newer unsynced local data (`localVersion >= serverVersion` wins, or `hasPending`
  wins outright). Results show one of five sync-status badges (Local only / Pending
  sync / Synced / Conflicted / Finalised). All of this lives in
  `js/backend-adapter.js` — the screen function in `index.html` only calls it and
  renders the result, no raw queries in the render path.
- **Honey Rewards** now merges confirmed `honey_events` (fetched using the
  *festival's* timezone, not the browser's, so it agrees with what the RPC computed
  server-side) with this device's still-pending local awards, with the two counted
  as strictly disjoint sets (an event is removed from the pending queue the instant
  it syncs, success or conflict) — so they can never double-count by construction.
  The existing honeycomb/tier visual design is completely unchanged; only the
  numbers feeding it now come from the real ledger when one is configured and
  reachable, falling back to the original local-only counters otherwise.

Testing this integration surfaced and fixed a genuine bug from the first pass:
`window.state` was used in two files to reach index.html's session data, but a
top-level `const state` in a classic `<script>` is never a `window` property —
`window.state` was always `undefined`, silently breaking Search Client's local-state
fallback and the "merge a synced update into the live UI" feature since they were
first written. Fixed by referencing the bare `state` identifier instead (safe, since
both call sites only ever run after index.html's inline script has already executed).
See `BACKEND_TEST_PLAN.md` for the full write-up and how it was caught.

Nothing here has been run against a live, migrated Supabase database by anyone but
you — see `SUPABASE_SETUP.md` for exactly what to run and `BACKEND_TEST_PLAN.md` for
what I could vs. couldn't verify myself.

## 6. Data-flow trace: a station form to a synced canonical row

The full path, station form to canonical server row, in the order it actually
executes — every numbered step names the exact function and file:

1. **Station form → decision validation.** A tester fills in `ScreenDistance` (etc.)
   and taps Save. `saveDistance()` (`index.html`) calls the unchanged decision engine
   (`chartResult`, `canCompleteStep`, `DE.*`) synchronously. If validation fails, the
   function returns early with a toast — nothing below this line runs.
2. **`state.sessions[id]` mutation.** Still inside `saveDistance()`: `s.distance = {...}`,
   `s.version++`. This is the same in-memory object every screen render reads from —
   the UI reflects this instantly, before any persistence has happened.
3. **`await recordBackendEvent('Distance', s, 'Distance')`** (`index.html`) →
   `window.OOXII_BACKEND.recordEvent()` (`js/backend-adapter.js`) → flattens
   `session.intake` onto the top level, resolves the current festival/user context,
   and calls `window.OOXII_SESSIONS.persistAndQueue()` (`js/session-repository.js`).
4. **IndexedDB session write.** `persistAndQueue()`'s first line:
   `await window.OOXII_DB.sessions.put(session)` (`js/indexed-db.js`, `sessions`
   store). This is the durable, local-first write — it survives a refresh, a crash,
   or the device staying offline indefinitely.
5. **Pending event created + queued.** Still in `persistAndQueue()`: builds an event
   object (`id: crypto.randomUUID()`, `sessionServerId: ensureServerId(session)`,
   `eventType:'step_saved'`, `payload` built from `PAYLOAD_KEYS.Distance`, `deviceId:
   newDeviceId()`, `baseVersion`), writes it to the `pending_events` IndexedDB store,
   bumps the pending-count in `sync_meta`, and — only if `navigator.onLine` — fires
   `window.OOXII_SYNC.syncNow()` in the background (not awaited; step 3's promise
   resolves without waiting for the network).
6. **`recordBackendEvent`'s promise resolves** back in `index.html`: sets
   `s._lastEventId = event.id` on the real session object. Only now does
   `saveDistance()` call `advance(s)`, which renders the next screen and (unless in
   Individual Testing mode) `showHandoverQR()`.
7. **QR generation.** `qrPayloadFor(s)` (`index.html`) reads the now-fully-persisted
   `s` — including `s._lastEventId` — builds the JSON payload (§"QR payload" above),
   and `window.OOXII_QR` (`js/qr-service.js`, backed by the vendored
   `js/vendor/qrcode.min.js`) renders it as an actual QR code image (text fallback if
   the library failed to load).
8. **Second device scans the QR.** Camera (`openCameraScanner()` →
   `window.OOXII_QR.startCameraScan()`, backed by vendored
   `js/vendor/html5-qrcode.min.js`) or image upload, both funnel into
   `handleScannedPayload(raw)` (`index.html`).
9. **Validation, dedup, then adopt/merge/preserve.** `handleScannedPayload()`
   (`index.html`): JSON + schema check → festival check → `imported_events` dedup
   check (`window.OOXII_DB.importedEvents.has(importKey)`) → if new: no local copy →
   adopt `p.snap` wholesale; local copy but `p.ver` is newer → merge; otherwise keep
   local and warn if the QR was older. The result is written to
   `state.sessions[cid]` (so the receiving device's UI reflects it immediately, same
   as step 2) AND to IndexedDB (`window.OOXII_DB.sessions.put`, same store as step 4
   — this is a second device's own local-first write, not a sync).
10. **`qr_imported` audit event.** If step 9 was a genuine new import (not a dedup
    no-op), marks `imported_events` with the dedup key, then calls
    `window.OOXII_BACKEND.recordEvent('QRImport', opened, station)` — same
    `persistAndQueue()` path as step 3–5, `eventType:'qr_imported'`, full-field
    payload (`PAYLOAD_KEYS.QRImport`).
11. **Background sync, either device, whenever it next has connectivity.**
    `js/sync-service.js`'s `syncNow()`: pulls all `pending_events` in
    `clientTimestamp` order, calls the `apply_session_event` RPC once per event
    (`js/supabase-client.js`'s client, never a raw table write).
12. **`apply_session_event()`** (`supabase/migrations/001_ooxii_backend.sql`): auth +
    festival-membership + station checks → duplicate event id → **row lock, creating
    the canonical `client_sessions` row on ANY event type if it doesn't exist yet**
    (the fix from this audit — previously registration-only, which would have
    stranded a session whose registering device never reconnects) → finalised-session
    guard → version match → sequence validation (skipped for
    `registration`/`correction`/`qr_produced`/`qr_imported`/`admin_task`, since those
    aren't a single "next clinical step") → insert the immutable `session_events` row
    → merge the payload into the canonical row → award Honey if eligible
    (`qr_imported` is correctly never eligible).
13. **Local cleanup on sync success.** Back in `sync-service.js`: the event is marked
    synced (`window.OOXII_DB.syncedEventIds.mark`), removed from `pending_events`, and
    — the earlier-fixed bug — if `state` (bare identifier, not `window.state`) has
    this session loaded, the confirmed server snapshot is merged into the live UI.

Steps 1–10 require zero connectivity and complete entirely on-device; step 11 onward
only runs once either device reaches the internet, in whatever order that happens —
by design, neither device has to be "first."
