# OOXii Offline Eye Camp App — project context (handoff for Claude Code)

This file gives Claude Code the context to continue an existing prototype. Read it first.

## What this is
A single-file, offline-first **prototype** web app for the OOXii eye-camp testing
workflow (trained lay testers running remote eye camps). Everything lives in `index.html`
(HTML + CSS + vanilla JS, no build step, no framework).

## Run / preview
- Open `index.html` directly in a browser, OR run a local server:
  `python3 -m http.server 8000` then open http://localhost:8000
- Uses one CDN script (qrcodejs) for QR codes, with a plain-text fallback if it can't load.

## Architecture (all inside index.html)
- **Config:** `SNELLEN`, `LINE_OPTS`, `PADDLE_POWERS`, `LENS_POWERS`, `VILLAGES`,
  `AGE_BANDS`, `DEVICES`, `FLOW`, `STEPPER`, `STEP_STATION`.
- **Anonymous IDs:** `newAnonId()` / `validId()` / `checkChar()` — format `[Letter][2 digits]-[check]` (e.g. A47-K).
- **Snellen:** `snellen(line, lettersNext)` → read-only result.
- **Decision engine `DE`:** `getNextRequiredStep`, `canDispense`, `canOpenStep` (station
  gating), `isDistanceComplete/isNearComplete/isWheelComplete/isPaddleComplete`,
  `distanceNeedsWheel`, `nearNeedsPaddle`.
- **Dispense helpers:** `buildRx(s)` (prescription), `clientContext(s)` (read-only client summary).
- **State:** in-memory `state` (sessions, queue, sync). `seed()` makes demo clients A47-K, B12-M, C09-T.
- **Icons:** `I(name,size,stroke)` inline SVG.
- **Illustrations:** `eyeCoverGraphic`, `bothEyesGraphic`, `nearPaddleGraphic`,
  `instructionCard` — OOXii-style flat figures on a teal square.
- **Screens:** `ScreenSignIn`, `ScreenHome`, `ScreenIntake`, `ScreenDistance`,
  `ScreenNear`, `ScreenWheel`, `ScreenPaddle`, `ScreenDispense`, `ScreenSync`,
  plus scanner / QR handover / wrong-station modals.
- **Field builders:** `fieldSelect`, `fieldSeg`, `fieldNumber`, `fieldEyeLine`,
  `fieldLetters`, `fieldReadout`, `stepper`.

## Design rules already baked in (do not regress)
- **Distance is tested first** and hard-gated; nothing else can start or dispense until it's done.
- **Near vision has no station of its own** — it's done at the Distance station (`STEP_STATION.Near = 'Distance'`).
- **Stepper is strictly position-based** — a step never shows complete ahead of the current step.
- **Paddle screen is single-purpose** (preferred reading power); it must NOT re-collect demographics.
- **Demographics entered once at Registration/intake;** later stations only *read* a summary
  (`clientContext`, shown at Dispense, with a cataract-history caution flag).
- **Eye colour convention:** Right eye = blue, Left eye = white, everywhere.
- **Privacy:** no names, no full DOB (use age band), no phone/email/address, anonymous IDs only.

## Tablet redesign & station gating (feature/tablet-home-redesign)
- **Home** is a landscape-tablet dashboard: persistent left sidebar (`sidebar()` — tester
  profile + Honey Rewards) + three nav cards (New Client / Search Client / Eye Festival Mode).
- **Active station** (`state.role`) is chosen in Eye Festival Mode (`ScreenFestival`),
  persisted in `localStorage('hl_active_station')`, changed only via `setActiveTesterStation()`
  with a confirmation dialog (`pickStation`/`confirmStationChange`). No Supervisor in the UI
  (the `DE.canOpenStep` branch remains for compatibility).
- **Central gating helpers** (single source of truth — never compare stations inline):
  `getActiveTesterStation`, `setActiveTesterStation`, `getRequiredStep`, `getRequiredStation`,
  `canActiveTesterOpenSession`, `getClientsForActiveStation`, `openSessionForActiveStation`,
  `showWrongStationModal`, `guardStep` (called at the top of every clinical screen — blocks
  direct navigation/deep links; wraps `canEnterStep`), `handleScannedPayload` (validates QR
  structure via `acceptableId` before gating), `qrPayloadFor` (single payload builder; added `tid`).
- **Exit / Counselling** (`ScreenExit`) is reached ONLY on route `"none"` (Distance pass + Near
  pass — see "Clinical decision engine" below); it is a genuine no-glasses path, not a generic
  post-dispense review screen. Dispensing routes finalise/review at `ScreenDispense` itself.
- **Individual Testing mode** (`state.mode='individual'`, persisted `localStorage('hl_mode')`,
  changed only via `setTesterMode()`): for testers working alone outside festival stations.
  One tester takes a client through every step themselves — `canActiveTesterOpenSession`
  waives the station gate, but the decision engine's step ORDER stays fully enforced by
  `guardStep`/`routeToStep` (distance-first, no early dispensing). Entry via the home card →
  confirm dialog (`enterIndividualMode`) → `ScreenIndividual` working area; picking any
  festival station (`pickStation`) confirms leaving the mode and restores station gating.
- **Queue assumption:** there is no separate queue data architecture — the station dashboard's
  "Ready for you"/"Completed here today" lists are derived from the existing in-memory
  `state.queue` sessions using DE completion checks.
- **Honey Rewards** are participation/handover-based only (registrations, handovers, admin
  task completion) — never linked to clinical outcomes. Do not change this.
  Daily progress (`state.honey`, persisted `localStorage('hl_honey')`, LOCAL-date day key)
  resets each festival day; monthly clients/session-days reset each month (`loadHoney()`).
  Config: `DAILY_TARGET`/`COMB_CELLS`/`DAILY_MILESTONES` (Bronze 10 / Silver 25 / Gold 40 /
  Platinum 60), `MONTHLY_LEVELS`, `ACHIEVEMENTS` (participation-only, on Profile).
  Earning goes through `awardHoney()` → `honeyAfterSave()`: a quiet toast per task; the
  animated bee popup (`showHoneyMilestone`) fires ONLY on a daily badge upgrade. The sidebar
  shows the horizontal honeycomb (`honeycombRow`) with streak-style "% of the comb" framing.
  In Individual Testing mode `finishStationTask()` skips the handover-QR modal (same tester
  continues) so a client can be tested end-to-end with no interruptions; festival mode keeps
  the QR handover between stations.
- Demo seed IDs (A47-K, B12-M, C09-T) predate the check-character rule; `acceptableId()`
  accepts known local sessions as well as check-valid IDs.

## Clinical decision engine (fix/ooxii-clinical-logic)
- **Sequence (binding):** Registration → Distance pre-test → Near pre-test → route calculated
  → Wheel and/or Paddle when the route requires it → Dispensing or Exit/Counselling → Complete.
  The route is **never** calculated until both pre-tests are done, and Wheel is **never** opened
  before Near — enforced centrally by `DE.getNextRequiredStep` / `canEnterStep`, not per-screen.
- **`ACUITY_TABLE`** (lines 0–11 → LogMAR/Snellen) is the one authoritative chart mapping;
  `calculateLogMAR(line, letters)` and `normaliseChartResult` are the only places thresholds/
  LogMAR math live — screens must never re-derive them. Both explicitly reject `null`/`''`
  input rather than relying on `Number(null)===0` (a real bug found and fixed here — an
  unanswered dropdown must never be silently treated as "line 0").
- **Thresholds:** Distance line ≥7 pass / ≤6 fail (`DISTANCE_PASS_LINE`), Near line ≥9 pass /
  ≤8 fail (`NEAR_PASS_LINE`). `getDistanceOutcome`/`getNearOutcome` are the only functions that
  compare these.
- **Route table** (`computeRoute` → one of `none|paddle_only|wheel_only|wheel_then_paddle`,
  mapped to required steps via `ROUTE_PATHS`): pass/pass → `none` (Exit only, no glasses,
  Wheel/Paddle/Dispense all blocked); pass/fail → `paddle_only`; fail/pass → `wheel_only`;
  fail/fail → `wheel_then_paddle` (Wheel before Paddle, both required before Dispense).
- **Own-glasses branching:** Distance and Near each require a separate own-glasses/reading-
  glasses result when the client answers "Yes" — `saveDistance`/`saveNear` reject the save
  (toast, no state change) until that result is recorded; unaided results are never overwritten
  by the with-glasses result.
- **Wheel** (`s.wheel.right`/`.left`, right=blue/left=white unchanged): per eye stores
  `lensType, spherePower, addOnUsed/addOnPower, toricUsed/toricPower/toricAxis,
  colourTestResult, canReadLine9OrSmaller, visionImproved, bestLens`. No invented cylinder,
  axis, material or frame values — `bestLensLabel`/`sphericalTotal` only ever display what a
  tester actually recorded. `buildRx()` was removed entirely.
- **Paddle** only ever opens because Near failed (never because of age). `suggestPaddlePower`
  gives age-band guidance only; the client's stated preference always overrides it, and the
  tester must always confirm a final `selectedPower` — `preferenceOverrodeSuggestion` is
  recorded for audit.
- **Dispensing** gate is route-specific (`DE.canDispense`) — never available on route `none`.
- Screens rewritten to this model: `ScreenDistance`, `ScreenNear`, `ScreenWheel`,
  `ScreenPaddle`, `ScreenDispense`, `ScreenExit`. All read/write the new `s.distance.*`/
  `s.near.*`/`s.wheel.*`/`s.paddle.*` shapes — do not reintroduce the old flat
  `rLine`/`lLine`/`owLine`/`rType`/`power` fields.
- **Unresolved clinical assumptions (flagged in-code, not fabricated):**
  `DISTANCE_AGGREGATION_MODE='either_eye_fail'` (right+left unaided combine into one Distance
  outcome — not defined in the supplied source, needs OOXii confirmation); the Paddle age-49
  boundary (45–49 vs 49–52) is intentionally left unresolved and surfaced to the tester rather
  than silently picked; there is no suggestion for clients under 45; the Wheel best-lens
  combination formula beyond "spherical total = sphere + add-on" is not specified anywhere and
  is deliberately not invented.

## Supabase backend (branch continues on fix/ooxii-clinical-logic)
- Offline-first: the clinical screens and decision engine above are **unchanged and stay
  fully synchronous** — `js/backend-adapter.js`'s `recordBackendEvent(step, s, station)`
  is called as the last line of each `save*`/`confirm*` function, fire-and-forget, and
  handles IndexedDB persistence + the sync queue as a side effect. See
  `BACKEND_IMPLEMENTATION_PLAN.md` §2 for why the screens were deliberately not rewritten
  to be async.
- `js/supabase-client.js` is the only file that calls `createClient()`;
  `js/indexed-db.js` is the only file touching the IndexedDB API directly. Every other
  screen/module goes through `js/backend-adapter.js`.
- `state.authed`/sign-in is now real Supabase auth (`js/auth-service.js`) with a 30-day
  encrypted offline PIN permit (Web Crypto, PBKDF2+AES-GCM) — never the account password.
  Demo/no-backend mode (`?demo=1`, or automatic when `js/config.js` is absent) keeps the
  original stub sign-in so the prototype stays walkable without a Supabase project.
- `supabase/migrations/001_ooxii_backend.sql` mirrors `DE.getNextRequiredStep`/
  `computeRoute` in SQL (`ooxii_next_required_step`, `ooxii_compute_route`) — used ONLY
  server-side, inside `apply_session_event()`, to reject out-of-order writes. The browser
  engine remains the single source of truth for the UI.
- `js/qr-service.js` adds real camera scanning (`html5-qrcode` CDN) and image-upload
  fallback, both funnelling through the existing `handleScannedPayload()` — the QR
  payload gained one backward-compatible field, `fid` (festival id), checked against the
  scanning device's active festival.
- `js/config.js` (real credentials) is gitignored; `js/config.example.js` is the
  committed template. See `SUPABASE_SETUP.md` for the exact migration/setup steps and
  `BACKEND_TEST_PLAN.md` for what's been verified vs. still needs your live project.
- Eye Festival Mode's station picker, Search Client, and Honey Rewards all read real
  backend data (`allowedStationsForTester`, `OOXII_BACKEND.searchClient`,
  `OOXII_BACKEND.getHoneyDisplayTotals`) when signed in against a configured project,
  and fall back to the original local-only/demo behaviour otherwise — same visual
  design either way. Reference `window.state` from a helper file to reach
  index.html's session data — a top-level `const state` in a classic `<script>` is
  never a `window` property; use the bare `state` identifier instead (see
  `js/backend-adapter.js`'s `appState()` for the pattern).

## Known limitations / prototype caveats
- Clinical mappings (Wheel/Paddle schemas, Distance/Near thresholds) are flagged
  assumptions pending OOXii validation — see "Clinical decision engine" above.
- In-memory only — no persistence, no encryption.
- QR scanner is simulated (pick from a list), not camera-based.
- Sign-in is a stub; no real auth or 30-day offline token.
- Sync queue is simulated; no backend.
- Illustrations are ORIGINAL art in OOXii's style, not OOXii's proprietary assets.
- Wheel-vs-Near order: engine routes Wheel before Near when correction is needed (per the PRD
  "Decision Rules"), which differs from the PRD's linear diagram (Near before Wheel) — confirm intended order.

## Suggested next tasks
1. Swap placeholder illustrations for official OOXii vector assets (edit the `*Graphic()` fns or add `<img>` slots).
2. Add real local persistence (IndexedDB) + encryption.
3. Implement real QR camera scanning.
4. Replace prototype Snellen/lens logic with validated OOXii formulas.
5. Add a Bislama / French language toggle (PRD lists these).
6. If productionising: split the single file into modules or migrate toward React Native (the PRD's intended target).
