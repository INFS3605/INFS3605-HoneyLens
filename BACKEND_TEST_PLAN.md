# Backend test plan

Status legend: **✅ Verified** (I ran this in the browser and confirmed the result) ·
**🔶 Code-reviewed only** (implemented and traced through by hand, not exercised live —
usually because it needs your migrated Supabase project or a real user I can't create
myself, since creating auth users requires either the dashboard or a service-role key,
which I'm not allowed to use) · **📱 Needs physical device** (two-phone camera QR test —
genuinely cannot be done in this sandboxed environment).

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
| 9 | Session still exists after browser restart | ✅ (by proxy) | IndexedDB is disk-backed, not in-memory — a full reload (#8) exercises the same code path a process restart would. Did not literally quit/reopen a browser process. |
| 10 | Distance testing enforced first | ✅ | Unchanged decision engine — already fully verified in the prior clinical-logic-correction pass; untouched by this work. |
| 11 | Wrong-station tester blocked | ✅ | Unchanged station gating (`canActiveTesterOpenSession`/`showWrongStationModal`) — already verified; untouched by this work. |
| 12 | Individual Testing mode preserves step order | ✅ | Unchanged — already verified in the prior pass. |
| 13 | QR handover imported on a second device | 📱 | Needs two physical phones. `handleScannedPayload()` is the single validation path for camera scan, image upload, and the demo picker — verified the camera path calls it correctly (see #17), and the demo/simulated path already round-trips correctly (verified pre-existing). |
| 14 | Duplicate QR scan does not duplicate data | ✅ | `handleScannedPayload` on the same payload twice only opens (never re-writes) the session — verified in the earlier clinical-logic pass. Server-side idempotency (`session_events` PK + `on conflict do nothing`, `honey_events unique(source_event_id)`) is code-reviewed but needs a live sync run to fire. |
| 15 | Multiple offline events synchronise in order | 🔶 | `syncNow()` sorts pending events by `clientTimestamp` before pushing and stops on the first transient failure to preserve order; traced through the code, not run against a live queue with a real session. |
| 16 | Duplicate event sync is idempotent | 🔶 | `apply_session_event`'s first check is `select ... where id = p_event_id` → returns `duplicate_ok` without re-processing. Logic verified by reading; needs a live RPC call to confirm. |
| 17 | Same-step conflicting clinical results create a conflict | 🔶 | `apply_session_event` inserts into `sync_conflicts` on a version mismatch or sequence error rather than overwriting — code-reviewed, needs a live DB. |
| 18 | Finalised session cannot be casually edited | 🔶 | Explicit check in `apply_session_event`: `status='Finalised' and event_type<>'correction'` → conflict, not overwrite. Code-reviewed only. |
| 19 | Honey is awarded once for an eligible task | 🔶 | `unique(source_event_id)` on `honey_events` plus `on conflict do nothing` — structurally guarantees this; not exercised live. |
| 20 | Honey is not based on clinical outcomes | ✅ | Confirmed by inspection of every honey-awarding call site (`awardHoney()` client-side, `apply_session_event`'s honey block server-side) — both fire on task completion only, never on a distance/near/wheel/paddle pass-fail value. This rule was already true before this task and is unchanged. |
| 21 | Unauthenticated database query is rejected by RLS | 🔶 | Tried live: `client_sessions` currently returns "relation does not exist" because the migration hasn't been run in your project yet — so I could not observe RLS itself doing the rejecting (a missing table also "rejects" the query, but for the wrong reason). Re-run this exact check after step 1 of SUPABASE_SETUP.md: `window.OOXII_SUPABASE.from('client_sessions').select('*')` while signed out should return a policy error, not data. |
| 22 | Tester from another festival cannot access the session | 🔶 | `ooxii_is_festival_member()` is the only path any SELECT/RPC policy grants through — a tester with no `festival_members` row for that festival gets nothing. Code-reviewed, needs two real festivals + two real testers to run live. |
| 23 | Service-role or secret keys absent from frontend files | ✅ | `grep -rniE "service_role\|sb_secret\|SUPABASE_SERVICE\|secret_key"` across the repo returns only two comments explaining the constraint — no key material anywhere. `js/config.js` (the only file with the real publishable key) is gitignored. |
| 24 | Netlify deployment loads without console errors | 🔶 | Not deployed by me (no push was made, per your standing instruction not to commit/push without asking). Verified the equivalent locally: fresh load via `python3 -m http.server 8000`, zero console errors, all modules (`OOXII_DB`, `OOXII_AUTH`, `OOXII_SUPABASE`, `OOXII_QR`, `OOXII_SYNC`, `OOXII_BACKEND`) present. |

## Integration tests — station enforcement, Search Client, Honey Rewards

Added after closing the three integration gaps (station assignment, Search Client
merge, Honey ledger). Same status legend as above.

| # | Scenario | Status | Notes |
|---|---|---|---|
| 25 | A tester assigned only to Distance cannot select or submit Wheel | ✅ / 🔶 | **UI + direct-call block: ✅ verified live** — with `allowedStations:['Distance']`, `ScreenFestival` rendered exactly 1 station card, and calling `pickStation('Wheel')` directly from the console (bypassing the UI entirely) showed "Not your station" instead of selecting it. **Server-side submit rejection: 🔶 code-reviewed** — `apply_session_event`'s `p_station = any(allowed_stations)` check is unchanged from the prior pass and traced through, but needs your live DB + two real testers to fire for real. |
| 26 | A tester assigned to multiple stations sees only those stations | ✅ | Verified live: `allowedStations:['Distance','Wheel','Paddle']` → exactly 3 station cards rendered, `isStationAllowed()` correctly true/false for in/out-of-set stations. |
| 27 | A tester without an active membership receives a useful message | ✅ | Verified live: an active festival id with no matching membership entry renders "No station assignment" with the "ask a coordinator" explanation, not a blank screen or crash. |
| 28 | Search Client works offline using IndexedDB | ✅ | Verified live: wrote a session directly to IndexedDB (nothing in `state.sessions`), searched for it with `OOXII_SUPABASE` unreachable — found it, correctly labelled "Local only". |
| 29 | Search Client retrieves a synced session online | 🔶 | `searchClientOnline()` → `client_sessions` query is unchanged and correctly scoped (`.eq('festival_id', ...)`); cannot exercise against a real synced row until the migration has run and at least one session has actually synced. |
| 30 | Local unsynchronised data is not overwritten by an older server record | ✅ | Verified the exact preference condition live (`localVersion >= serverVersion \|\| hasPending \|\| !server` → prefer local) with a local version-3 record against a mocked stale version-1 "server" row — local won, as required. Also verified live that a session with a pending event is always labelled "Pending sync", never silently shown as "Synced". |
| 31 | A tester cannot search another festival's sessions | 🔶 | `searchClientOnline` filters by `cachedContext.activeFestivalId`, and RLS (`ooxii_is_festival_member`) independently backs this up server-side even if the client-side filter were bypassed — both traced and unchanged from the original migration, not exercised against two real festivals yet. |
| 32 | Profile shows confirmed Honey events from Supabase | ✅ | Verified live end-to-end with a mocked `honey_events` response standing in for the real (not-yet-migrated) table: `refreshHoneySummary()` → `getHoneyDisplayTotals()` correctly returned the confirmed count, and it rendered into the *unchanged* sidebar/Profile honeycomb UI (screenshotted — visually identical design, real numbers). |
| 33 | Pending offline Honey and confirmed Honey are not double-counted | ✅ | Verified live with exact assertions: 3 mocked confirmed events → `today=3`; added one pending local `step_saved` event → `today=4` (never 6 or any other double-counted value); added a non-honey-eligible pending event (`qr_produced`) → count correctly unchanged. Also verified the cache is invalidated on sign-out/context change so a stale confirmed total can never leak into a new session (found and fixed a real bug here — see below). |
| 34 | Clinical outcomes do not affect Honey totals | ✅ | Every Honey code path — client (`awardHoney`), server (`apply_session_event`'s honey block), and the new merge logic (`getHoneyDisplayTotals`, which only ever reads `festival_local_date` counts) — was inspected; none reads a distance/near/wheel/paddle/dispense value. Unchanged invariant from before this task, re-confirmed after the new code was added. |

### A real bug this testing found and fixed

Two files (`js/backend-adapter.js`, `js/sync-service.js`) referenced `window.state`
to reach index.html's session data. `index.html` declares `const state = {...}` at
the top level of a classic `<script>` — top-level `let`/`const`/`class` bindings are
**never** added as `window` properties (unlike `var`), even though every classic
`<script>` on a page shares the same global scope for the bare identifier. The
practical effect: `window.state` was always `undefined`, silently no-opping two
things since they were first written — Search Client's fallback to
`state.sessions` for anything not yet in IndexedDB, and `sync-service.js`'s
"merge a synced update into the live UI immediately" feature. Fixed by referencing
the bare `state` identifier (safe here, since these are only ever called long after
index.html's inline script has already run) instead of `window.state`.

Also found and fixed while testing Honey: the cached confirmed/pending totals
weren't invalidated on sign-out or festival switch, so a stale total from a
previous session could have kept being displayed as current. `refreshCachedContext()`
now clears the Honey cache whenever the user+festival key changes.

## What I could not test and why

- **Two-phone camera handover (#13, and the 8-step end-to-end QR scenario
  from the original request).** This sandbox has no physical camera-equipped
  device. What I *did* verify: the camera permission prompt is genuinely
  requested (not stubbed) only on tap, `Html5Qrcode.start()` is really called,
  and — critically — when the camera failed to start in this sandboxed
  browser (blocked by the environment), the app caught it and correctly
  offered the image-upload fallback rather than hanging or crashing.
  **You should run the literal 8-step test from the original brief on two
  real phones before considering QR handover done.**
- **Anything requiring a signed-up Supabase user (#1, #3, #5, #6, #21, #22).**
  Creating an auth user needs either the dashboard or the admin API (which
  needs a service-role key) — both are your action per the "never request a
  service-role key" constraint. Once you've done step 2 of
  `SUPABASE_SETUP.md`, every 🔶 item above can be re-run for real; I've
  written the RPC and policies to make that a quick pass, not a guess.
- **The literal 30-day expiry (#6)** — verified the comparison logic, not
  real elapsed time.
- **Netlify deployment itself (#24)** — nothing has been pushed or deployed;
  that's still your call to make.
