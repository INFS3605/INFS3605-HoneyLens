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
