# OOXii

OOXii is an offline-first eye-testing platform for community "Eye Festivals" —
trained lay testers running vision screening and glasses dispensing for
remote communities with unreliable internet. It has two parts:

1. **The tester app** (`index.html`) — the field tool testers use station by
   station to screen a client, decide whether they need glasses, and dispense
   them, all working fully offline once loaded.
2. **The Insights Portal** (`admin/`) — a coordinator-only dashboard that
   turns festival data into impact reporting (clients tested, glasses
   dispensed, communities reached, outcomes over time).

Both are plain HTML/CSS/vanilla JavaScript — **no build step, no framework,
no `npm install` required to run the app itself.** A Supabase project
provides the real backend (auth, Postgres, row-level security); without one
configured, the tester app runs in a fully-featured **demo mode** with sample
data instead.

---

## Quick Start (5 minutes)

You do **not** need a Supabase project to try the tester app.

```bash
git clone <this-repo-url>
cd INFS3605-HoneyLens
python3 -m http.server 8000
```

Open **http://localhost:8000** in a browser. You'll see a "Configuration
needed" screen (there's no `js/config.js` yet, which is normal and expected —
see [Running the Application](#running-the-application)) — click
**"Continue in demo mode (no backend)"**, then sign in with any
email/password (demo mode doesn't check them). You're now in the full tester
app with sample clients, able to walk the entire Registration → Distance →
Wheel/Paddle → Dispense workflow, try Eye Festival Mode and Individual
Testing Mode, and see the Honey reward animation — all running locally, all
in memory/IndexedDB, nothing leaves your machine.

The **Insights Portal** (`http://localhost:8000/admin/`) has no demo mode —
it requires a real, configured Supabase project (see
[Deployment](#deployment) and `SUPABASE_SETUP.md`). Opening it without one
shows a clear "Not configured" screen rather than an error.

---

## Features

- **Offline-first clinical workflow** — Registration, Distance/Near vision
  pre-tests, Wheel and Paddle correction determination, and Dispensing all
  work with zero connectivity; results are saved to IndexedDB immediately
  and synced to Supabase whenever a connection becomes available.
- **Anonymous client IDs** — no names, no full date of birth, no contact
  details are ever collected; clients are identified only by a
  check-character-validated ID (e.g. `A47-K`).
- **QR client handover** — a client's record travels between physical
  testing stations as a QR code (camera-scanned or image-uploaded), not
  over a network — the receiving device decodes, validates, and merges it
  locally.
- **Eye Festival Mode** — multiple testers work simultaneously at fixed
  physical stations (Registration, Distance, Wheel, Paddle, Dispense,
  Exit/Counselling), each seeing only the clients relevant to their station.
- **Individual Testing Mode** — a single tester working alone takes one
  client through every step themselves, in strict order, with no QR
  handover needed between steps.
- **Station-based Honey Rewards** — a lightweight, non-clinical
  participation reward: one "+1 Honey" per client per physical station
  completed, with a short non-blocking animation and separate daily/monthly
  milestone badges.
- **Background + manual sync** with bounded retry/backoff, and a
  coordinator-reviewable conflict queue for anything that can't be merged
  automatically.
- **Insights Portal** — coordinator/administrator-only dashboard: impact
  overview, festival comparisons, device status, a filterable research
  dataset explorer, and CSV/JSON exports.
- **Installable offline app-shell** (tester app only) via a service worker,
  with an explicit, tester-consented "Reload and update" flow — it never
  swaps app code out from under someone mid-test.

## Technology Stack

| Layer | Choice |
|---|---|
| Frontend | Vanilla HTML/CSS/JavaScript — no framework, no bundler, no build step for local dev |
| Shared design tokens | `css/ooxii-design-system.css` — one small token file (colour, radius, spacing, type scale) consumed by both the tester app and the Insights Portal |
| Backend | [Supabase](https://supabase.com) (hosted Postgres + Auth + Row Level Security) |
| Server-side logic | PostgreSQL functions, principally `apply_session_event()` — the only way client/session writes reach the database, called via `rpc()`, never raw table writes |
| Authentication | Supabase Auth (email/password) for the initial online sign-in, plus a locally-encrypted 30-day offline PIN permit (PBKDF2 + AES-GCM, Web Crypto) so the app keeps working with zero connectivity afterwards |
| Offline storage | IndexedDB (`js/indexed-db.js`) — sessions, outbound event queue, sync metadata, and the encrypted offline permit all live here |
| Offline app shell | A service worker (`sw.js`) precaches the tester app's own assets for guaranteed offline reopening |
| QR generation/scanning | `qrcodejs` and `html5-qrcode`, vendored locally under `js/vendor/` (not loaded from a CDN) so QR handover keeps working with no internet at all; `fflate` compresses the QR payload |
| Charts (Insights Portal) | `admin/js/admin-charts.js` — small hand-rolled SVG chart helpers, no charting library dependency |
| Deployment | Netlify (static site; a small Node build script injects Supabase credentials from environment variables — see [Deployment](#deployment)) |

## Project Structure

```
index.html                    Tester app — HTML + CSS + all screens/logic (single file)
sw.js                          Service worker: offline app-shell caching for the tester app
css/
  ooxii-design-system.css      Shared design tokens used by both apps

js/
  supabase-client.js           The ONLY file that calls Supabase's createClient()
  indexed-db.js                The ONLY file that touches the IndexedDB API directly
  auth-service.js               Real Supabase auth + the 30-day encrypted offline PIN permit
  session-repository.js         Local-first persistence + outbound event queue for client sessions
  sync-service.js               Pushes/pulls through apply_session_event(); conflict handling
  qr-service.js                  Real camera QR scanning + image-upload fallback
  backend-adapter.js             The one boundary index.html's screens call into (no screen makes a raw Supabase query)
  sw-register.js                 Registers sw.js; drives the "Reload and update" prompt
  config.example.js              Committed template — copy to config.js and fill in your project
  config.js                      Your real Supabase URL/key (gitignored, never committed)
  vendor/                         Locally-vendored QR + compression libraries (no CDN dependency)

admin/
  index.html                    Insights Portal — coordinator-only dashboard (separate app, shares only the Supabase project)
  js/
    admin-auth.js                Coordinator/administrator role gate
    admin-app.js                 Navigation shell + all dashboard screens
    admin-data.js                Supabase queries against the read-only admin views
    admin-charts.js               Small SVG chart helpers
  README.md                      Insights Portal-specific documentation (metric sources, access model)

supabase/
  migrations/                    11 numbered, additive SQL migrations — apply in order (see Deployment)
  seed/development_seed.sql       One-shot script to create a demo festival + assign a tester to every station
  tests/                          Manual (not automated-CI) SQL acceptance tests, one per sync-conflict-fix migration

scripts/generate-config.mjs       Netlify build step: writes js/config.js from environment variables
netlify.toml                      Netlify build/deploy configuration
PRODUCT.md                        Durable product context (users, purpose, constraints) captured for this project's design work
SUPABASE_SETUP.md                  Step-by-step Supabase project setup walkthrough
BACKEND_IMPLEMENTATION_PLAN.md      Design rationale for the local-first sync architecture
BACKEND_TEST_PLAN.md                What has been verified against a live Supabase project vs. still needs one
```

## Running the Application

Assumes no prior familiarity with this project.

### Prerequisites
- A modern browser (Chrome, Edge, Firefox, or Safari).
- Python 3 (for the simplest local static-file server) — or any other static
  file server; there are no other dependencies to install, and no `npm
  install` step, to run the app itself.
- (Optional, for the real backend / Insights Portal) a free
  [Supabase](https://supabase.com) account.

### 1. Clone and serve locally
```bash
git clone <this-repo-url>
cd INFS3605-HoneyLens
python3 -m http.server 8000
```
Then open `http://localhost:8000`. Opening `index.html` directly as a
`file://` URL also mostly works, but a local server is recommended — service
workers and camera access don't function over `file://`.

### 2. Tester app — with or without a backend
- **No backend configured (default on a fresh clone):** the app detects that
  `js/config.js` doesn't exist and shows a "Configuration needed" screen with
  a **"Continue in demo mode"** button. Demo mode runs entirely in memory
  with sample clients — nothing syncs anywhere, and no Supabase project is
  needed.
- **With a real backend:** copy `js/config.example.js` to `js/config.js` and
  fill in your Supabase project URL and publishable key (see
  [Deployment](#deployment) / `SUPABASE_SETUP.md` for the full walkthrough,
  including running all 11 migrations and creating a tester account). Reload
  the page and sign in with that account's email/password. On first
  successful online sign-in you'll be asked to set a 4–8 digit **offline
  PIN** — this (not your account password) is what unlocks the app for 30
  days with no internet.

### 3. Insights Portal
Open `http://localhost:8000/admin/`. This page **requires** a configured
Supabase project (the same `js/config.js` as above) — there is no demo mode
for it. Sign in with an account whose `profiles.app_role` is `coordinator`
or `administrator` (a plain tester account is denied with a clear message,
not a silent redirect). See `SUPABASE_SETUP.md` for how to promote an
account.

### 4. Testing the full two-device workflow
Eye Festival Mode's QR handover is meant to be tested across two actual
devices/browser tabs signed in to the same festival, each set to a different
active station — one device saves and shows a QR code, the other scans it
(camera, or upload a screenshot of it) to continue that client's record.
Individual Testing Mode does not need a second device — one tester carries
a client through every step themselves with no handover step.

## Application Workflow

The clinical sequence is fixed and centrally enforced (`DE.getNextRequiredStep`
in `index.html`) — no screen is allowed to re-derive or bypass it:

```
Registration
     │
     ▼
Distance pre-test  (Near vision is also tested here — Near has no station of its own)
     │
     ▼
route computed from Distance + Near outcomes
     │
     ├── pass / pass  → Exit / Counselling (no glasses needed)
     ├── pass / fail  → Paddle only
     ├── fail / pass  → Wheel only
     └── fail / fail  → Wheel, then Paddle (both required)
     │
     ▼
Dispensing  (gate is route-specific — never reachable on the "no glasses" route)
     │
     ▼
Complete
```

- **Station ownership**: each step belongs to exactly one physical station
  (`STEP_STATION` — Registration, Distance [covers Near], Wheel, Paddle,
  Dispense, Exit). A tester can only open sessions whose next required step
  belongs to their currently-active station.
- **QR handover, same-station vs. cross-station**: moving a client from one
  physical station to a different one (e.g. Distance → Wheel) shows a
  handover QR the next station's device scans. Saving a step that stays at
  the *same* station a tester is already working (e.g. Distance → Near, both
  at the Distance station) does **not** trigger a handover — it's treated as
  continuing the same piece of work, not passing it to someone else.
- **Handover locking**: once a client has been handed to another station via
  QR, the originating device can still view but not re-edit that step's
  results until explicitly "reopened to correct" — preventing two testers
  from silently overwriting each other's work on the same client.

## Offline Architecture

- **IndexedDB** (`js/indexed-db.js`) is the app's primary, always-on-device
  store: canonical session records, an outbound queue of not-yet-synced
  events, a record of this device's own already-synced event ids
  (idempotency), a record of QR handovers already imported (so re-scanning
  the same QR is a no-op, not a duplicate import), this device's identity,
  the signed-in context, sync metadata, unresolved conflicts, and the
  encrypted offline auth permit.
- **Local-first save order**: every clinical save (1) runs the existing
  synchronous decision-engine validation and mutates in-memory state exactly
  as before, (2) writes the full session to IndexedDB, (3) queues a
  client-generated event for sync. The UI is never blocked waiting on
  IndexedDB or the network.
- **Background + manual sync** (`js/sync-service.js`): pushes queued events
  through the `apply_session_event()` RPC in chronological order (never raw
  table writes), pulls back the server's canonical session state, and
  reports pending/syncing/synced/failed/conflicted counts. A network failure
  is retried with bounded exponential backoff (capped at 30s); a *validation*
  failure (out-of-order step, version mismatch, a finalised session touched
  again) is never silently retried — it goes to a conflict queue for a
  coordinator to review instead.
- **Manual "Sync now"** ignores the automatic backoff timer and, on a
  transient failure, blocks only the affected session — independent sessions
  keep syncing rather than the whole run stopping.
- **Service worker** (`sw.js`): precaches the tester app's own local assets
  (`index.html`, its CSS/JS, vendored QR libraries) so the app reopens fully
  offline after its first successful online load. A new version is
  downloaded in the background and never activates itself — the tester sees
  a "Reload and update" prompt and decides when it's safe to switch, so app
  code is never swapped out mid-test.
- **What works offline**: the entire clinical workflow, QR generation and
  camera scanning, viewing already-saved client records, and the Honey
  reward. **What needs connectivity**: the very first sign-in, and
  syncing/pulling data to and from Supabase (queued and retried once
  connectivity returns).

## Honey Reward System

A lightweight, purely participation-based reward — **never tied to a
clinical outcome** (a client who ultimately doesn't need glasses earns their
tester exactly the same reward as one who does).

- **One reward per physical station, per client, per tester** — Distance and
  Near count as a single station reward (both belong to the Distance
  station), not two, even though they're saved as separate steps.
  Deduplicated via a persisted `(clientId, station, testerId)` key, so
  reopening a session to correct a result, re-syncing, or restoring from
  IndexedDB never re-awards it.
- **Visual feedback**: a short (~2 second), non-blocking "+1 Honey" badge
  pinned to a corner of the screen — deliberately positioned so it never
  overlaps a QR code or other clinical content, and never blocks a tap.
  Separate, daily-badge-crossing milestones (Bronze/Silver/Gold/Platinum)
  show their own short celebratory animation.
- **Offline-safe**: awarding and its dedup check both happen entirely
  client-side against local state before any sync occurs.
- **Server-side mirror** (migration `011`): `apply_session_event()` enforces
  the same one-reward-per-station rule server-side via a partial unique
  index, so the rule holds even if two devices raced to record the same
  station completion.
- **Coordinator visibility**: Honey totals are readable (not just
  tester-local) once synced, via `honey_events` rows tied to a session and
  station.

## Insights Portal

- **Purpose**: turn festival data into impact reporting for coordinators,
  researchers, and funding stakeholders — "what has OOXii achieved" is
  emphasised over technical/system detail.
- **Access**: gated on a global `profiles.app_role` of `coordinator` or
  `administrator` (distinct from the tester app's per-festival station
  assignment) — reuses the same Supabase Auth account as the tester app.
- **Pages**: Dashboard (hero impact numbers, outcomes, trends over time,
  festival comparison, communities reached, demographics, a collapsed
  system-health panel), Festivals, Devices, Researchers (filterable
  anonymised session dataset), and Exports (CSV/JSON). A **Settings** page
  exists in navigation but is currently a placeholder only.
- **Current limitation**: there is no demo mode for this portal — it always
  requires a real, migrated Supabase project to show anything.

## Deployment

### Netlify
`netlify.toml` runs `node scripts/generate-config.mjs` as the build command,
which writes `js/config.js` from two Netlify environment variables
(`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`) — set these in Netlify's site
settings; nothing else needs to change for a deploy. The publishable key is
safe to expose in the browser bundle; every table it can reach is gated by
Row Level Security.

### Supabase project setup
Full step-by-step walkthrough: `SUPABASE_SETUP.md`. In short:
1. Create a Supabase project.
2. Run **all 11** migrations in `supabase/migrations/`, in numeric order
   (001 through 011) — each is additive and safe to re-run, but they must be
   applied in order since later ones assume earlier ones exist.

   | Migration | What it adds |
   |---|---|
   | `001_ooxii_backend.sql` | Core schema: `profiles`, `festivals`, `festival_members`, `devices`, `client_sessions`, `session_events`, `honey_events`, `sync_conflicts`; RLS on all eight; `apply_session_event()` |
   | `002`–`005` | Four incremental fixes to `apply_session_event()`'s conflict/version-baseline handling, based on real sync conflicts observed in testing |
   | `006_insights_portal_read_access.sql` | Coordinator role check + 7 additive read-only policies + the first set of admin dashboard views |
   | `007_research_dataset_view.sql` | The flattened, filterable dataset the Researchers/Exports pages query |
   | `008_dashboard_distribution_views.sql` | Age/gender/village/lens-power/throughput distribution views |
   | `009_data_quality_view.sql` | Data-quality summary view |
   | `010_impact_dashboard_views.sql` | Daily-dispensed, average-completion-time, and festival-impact views for the impact dashboard |
   | `011_station_based_honey_rewards.sql` | Server-side mirror of the one-reward-per-station Honey rule |
3. Create a tester account (never insert into `auth.users` directly) and
   optionally run `supabase/seed/development_seed.sql` to create a demo
   festival and assign that account to every station.
4. Copy `js/config.example.js` to `js/config.js` and fill in your project's
   URL and publishable key for local development.

### Bumping the service worker cache
Any change to a file listed in `sw.js`'s `CORE_ASSETS` (the tester app's own
HTML/CSS/JS) requires bumping the `CACHE_VERSION` constant at the top of
`sw.js` — otherwise a browser that already has the app installed offline
keeps serving the old cached version indefinitely. The Insights Portal has
no service worker and instead cache-busts its own scripts with a `?v=`
query-string bump on each `<script>` tag in `admin/index.html` when one of
`admin/js/*.js` changes.

## Assumptions

Assumptions genuinely made by this prototype's design, not aspirational:

- One tester is signed in per device at a time; the app does not support
  multiple simultaneous tester identities on one browser/device.
- QR handover assumes the sending and receiving devices are physically
  near each other at handover time (camera-scannable or a shared
  screenshot) — there is no remote/networked handover path.
- Internet connectivity is assumed to be intermittent, not permanent, but
  eventually available — the sync design has no "fully offline forever"
  mode; unsynced data waits for the next connection.
- Coordinators/researchers are assumed to use the Insights Portal on a
  desktop-class screen; the tester app is the one designed tablet-first.
- A tester must already have an authenticated account and an active
  `festival_members` assignment before Eye Festival Mode will let them work
  a station — there is no self-service station claiming without one.
- Clinical thresholds and lens-recommendation logic (Distance/Near
  pass/fail lines, Wheel best-lens combination, Paddle age-band suggestion)
  are prototype values pending validation against OOXii's actual clinical
  protocol — several are explicitly flagged as unresolved in code rather
  than invented (see `DISTANCE_AGGREGATION_MODE`, the Paddle age-49
  boundary, and the Wheel best-lens formula comments in `index.html`).

## Known Limitations

Honest, current-state limitations of this prototype:

- **Clinical logic is not clinically validated.** Snellen/LogMAR mappings,
  pass/fail thresholds, and lens-recommendation logic are plausible
  prototype values, not OOXii-confirmed clinical formulas.
- **Sync conflict resolution is manual, not automatic.** A conflicting event
  is recorded in `sync_conflicts` for a coordinator to review — there is no
  in-app UI yet for a coordinator to resolve a conflict directly; that
  currently requires the SQL Editor.
- **No native mobile app.** This is a responsive web app (tablet-first for
  the tester experience), not a packaged iOS/Android/React Native app,
  despite that being the long-term intended target.
- **Insights Portal has no demo mode** and no offline capability — it always
  needs a real, migrated Supabase project and a live connection.
- **The Insights Portal's Settings page is a placeholder** — present in
  navigation, not yet implemented.
- **No automated test suite.** Verification has been manual/browser-driven
  throughout (see `BACKEND_TEST_PLAN.md`); `supabase/tests/` contains
  hand-run SQL acceptance scripts for the sync-conflict fixes, not an
  automated CI suite.
- **Single-file tester app.** `index.html` is one ~4,300-line file by
  design (no build step) — a deliberate trade-off for a no-framework
  prototype, but a real constraint if this project grows further.
- **Illustrations are original placeholder art** in OOXii's visual style,
  not OOXii's own proprietary assets.
- **No language toggle yet** — Bislama/French are mentioned in the original
  product brief but not implemented; the app is English-only today.
- **Camera QR scanning requires HTTPS** (or `localhost`) — it will not
  function if you deploy somewhere serving plain HTTP.

## Future Improvements

Realistic next steps, kept separate from the limitations above:

1. Get OOXii's clinical team to confirm the flagged threshold/lens
   assumptions and replace prototype values with validated ones.
2. Build an in-app conflict-resolution UI for coordinators instead of
   requiring direct SQL access.
3. Add a language toggle (Bislama / French).
4. Swap the original placeholder illustrations for official OOXii vector
   assets.
5. Implement the Insights Portal's Settings page.
6. If productionising: split `index.html` into modules, add an automated
   test suite, and evaluate migrating the tester app toward React Native
   per the original product brief's intended target platform.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| "Configuration needed" screen on the tester app | Expected with no `js/config.js` — either click "Continue in demo mode" or follow `SUPABASE_SETUP.md` to configure a real project. |
| "Not configured" on `/admin/` | The Insights Portal has no demo mode — it needs a real, migrated Supabase project. |
| "Could not load your tester profile" at sign-in | The new-user trigger didn't fire, or the profile's `is_active` is false — check `select * from profiles where id='<uuid>'` in the SQL Editor. |
| "You are not assigned to any festival yet" | No active row for that user in `festival_members`. |
| Coordinator sees "Coordinator access required" on `/admin/` | Their `profiles.app_role` isn't `coordinator`/`administrator` yet — see `SUPABASE_SETUP.md`. |
| Sync screen shows "Sync paused" | The Supabase session expired — sign in online again. |
| QR won't scan / camera won't start | Confirm the site is served over HTTPS or `localhost` — camera access is blocked on plain HTTP everywhere else. |
| A code change doesn't seem to appear after reload | If it touches a `CORE_ASSETS` file, bump `sw.js`'s `CACHE_VERSION` and use the in-app "Reload and update" prompt; for the Insights Portal, bump the relevant `?v=` on its `<script>` tag. |
| Honey reward doesn't animate | Confirm the station-completion save actually changed `DE.getNextRequiredStep`'s station (see `isStationResponsibilityComplete()`) — a save that stays within the same station's remaining steps doesn't fire a new reward, by design. |
| `relation "public.client_sessions" does not exist` | Migration `001` hasn't been run yet against that Supabase project. |

## Development Notes

- **The decision engine (`DE` in `index.html`) is the single source of
  truth** for clinical sequencing and thresholds — screens must never
  re-derive or duplicate that logic; they call into `DE.*` and `computeRoute`.
- **To add a new station**: add it to `STATIONS` and `STEP_STATION`, extend
  the SQL `CHECK` constraint on `festival_members.allowed_stations`, and
  update `ooxii_step_station()` in SQL to match — the client and server
  mappings must stay identical.
- **To add a new Insights Portal metric**: add a SQL view in a new migration
  (never edit an existing one), add a getter in `admin/js/admin-data.js`,
  and render it in the relevant `admin-app.js` screen — RLS is inherited
  automatically since views run under the querying user's own permissions.
- **Never bypass `backend-adapter.js`** from a screen function — it's the
  only boundary between the synchronous UI and the async persistence/sync
  layer; screens read `state.sessions` directly and call
  `recordBackendEvent(...)` as the last line of a save, nothing more.
- **Never touch IndexedDB or Supabase directly from a new file** — go
  through `indexed-db.js` / `supabase-client.js` respectively; this keeps
  exactly one place responsible for each API surface.
- **Offline behaviour is easy to break silently.** Before changing anything
  in `sync-service.js`, `indexed-db.js`, or the service worker, test with
  DevTools' Network tab set to Offline, not just by reading the diff.

---

## Final Validation

This README was rewritten from a direct audit of the codebase, not from
memory. What was actually checked:

**Files inspected**: `index.html` (full structure, key constants —
`STATIONS`, `STEP_STATION`, `FLOW`, Honey config — and all `function
Screen*` definitions), every file under `js/` and `admin/js/` (header
comments plus key functions), `sw.js` (`CACHE_VERSION`, `CORE_ASSETS`),
`css/ooxii-design-system.css`, all 11 files under `supabase/migrations/`
and their header comments, `supabase/tests/`, `netlify.toml`,
`scripts/generate-config.mjs`, `js/config.example.js`, `SUPABASE_SETUP.md`,
`admin/README.md`, `PRODUCT.md`, and current git branch/history state.

**Verified directly from code**: the clinical routing table and station
ownership model; the IndexedDB store list; the offline PIN encryption
approach; the sync retry/backoff and conflict-vs-network-failure split; the
QR handover validation flow and same-station-vs-cross-station distinction;
the Honey Rewards dedup key and station-completion gate; the Insights
Portal's access-role check and its six nav pages (including that Settings
is a placeholder); the service worker's precache list and update-consent
flow; the Netlify build command and its environment-variable contract; and
that migrations 001–011 exist and what each one's header comment says it
does.

**Verified by live testing, not just reading code**: that a fresh clone
with no `js/config.js` shows "Configuration needed" on the tester app and
"Not configured" on the Insights Portal, and that "Continue in demo mode"
reaches a fully working Home screen with sample data.

**Could not be verified from the repository alone (operational, not code,
facts)**: whether migrations 002–011 have actually been applied to any
specific live Supabase project (that depends on what's been run against
that project, not on anything in this repo); whether real camera QR
scanning behaves correctly on an actual physical device (checked the code
path and the HTTPS requirement, not a real camera); and the exact current
state of any specific deployed Netlify site's environment variables.

**Known drift not fixed by this pass** (flagged, out of scope for this
task): `SUPABASE_SETUP.md` still only documents running migration `001`,
and `admin/README.md`'s migration table stops at `010` — both should
eventually be updated to mention `002`–`011` and `011` respectively.
