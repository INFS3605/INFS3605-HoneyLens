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

### QR payload (extended, not replaced)

```js
{ v:1, camp, cid, sid, step, status, ver, ts, dev, tid, mac, fid }
```
`fid` (festival id) is the only addition — a payload without it still validates (old
QR codes / demo mode keep working); a payload with a `fid` that doesn't match the
scanning device's active festival is now rejected as "wrong festival".

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

Instead: **the screens stay 100% synchronous.** Each `save*`/`confirm*` function keeps
validating and mutating `state.sessions[id]` exactly as before, then calls one new line —
`recordBackendEvent(step, s, station)` — as the very last statement, AFTER its own
mutation. That function is fire-and-forget: it writes the session to IndexedDB, builds
one sync event, queues it, and (if online) kicks off a background sync — never awaited,
never blocking the UI. This is "local-first" exactly as specified: the UI has already
updated by the time persistence even starts.

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

`sessions`, `pending_events`, `synced_event_ids`, `device`, `context`, `sync_meta`,
`conflicts`, `offline_permit` — see `js/indexed-db.js` header comment for exactly what
each holds.

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
