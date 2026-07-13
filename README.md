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
  `showWrongStationModal`, `guardStep`/`guardExit` (called at the top of every clinical screen —
  blocks direct navigation/deep links), `handleScannedPayload` (validates QR structure via
  `acceptableId` before gating), `qrPayloadFor` (single payload builder; added `tid`).
- **Exit / Counselling** (`ScreenExit`) is a non-clinical review station for Finalised
  sessions only (`DE.canOpenStep` role `'Exit'`); adds no clinical steps.
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

## Known limitations / prototype caveats
- Clinical mappings (`SNELLEN`, `buildRx` lens logic) are PLACEHOLDER, not validated OOXii values.
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
