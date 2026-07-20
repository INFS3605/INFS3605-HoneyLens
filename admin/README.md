# OOXii Insights Portal

Coordinator-only analytics dashboard for OOXii Eye Festival data, built on
`feature/ooxii-insights-dashboard`. Lives entirely under `admin/` and is a
**separate app** from the tester-facing `index.html` — it shares nothing but
the Supabase project (`js/config.js` + `js/supabase-client.js`, one directory
up). It does not load `indexed-db.js`, `auth-service.js`,
`session-repository.js`, `sync-service.js`, `qr-service.js`, or
`backend-adapter.js`, so none of the tester app's offline/QR/sync logic runs
on this page, and none of it was modified to build this feature.

## Run / preview

Same as the main app — no build step:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000/admin/`. Needs `js/config.js` (one
directory up, gitignored — copy `js/config.example.js` and fill in your
Supabase project) pointing at a project with migrations 001–009 applied.

## Access model

- Reuses the tester app's Supabase Auth project (same `storageKey:
  'ooxii-auth'` in `js/supabase-client.js`), so a coordinator can sign in
  with their existing OOXii account.
- Gated on `profiles.app_role` (already existed as a column, default
  `'tester'`) being `'coordinator'` or `'administrator'` — a **global**
  role, distinct from the existing per-festival
  `festival_members.member_role` / `ooxii_is_coordinator_or_admin()` used
  elsewhere in the schema. `js/admin-auth.js` checks this directly; a
  tester who opens `/admin/` while signed in on the main app is denied
  with a clear "Coordinator access required" screen, not a silent
  redirect.
- To make an existing account a coordinator:
  ```sql
  update profiles set app_role = 'coordinator' where id = '<user-uuid>';
  ```

## Database changes (all additive)

| Migration | Adds |
|---|---|
| `006_insights_portal_read_access.sql` | `ooxii_is_global_coordinator()`, 7 additive coordinator-only SELECT policies, `v_admin_kpis`, `v_admin_daily_clients`, `v_admin_distance_outcomes`, `v_admin_near_outcomes`, `v_admin_completion_funnel`, `v_admin_pathway_frequencies`, `v_admin_device_status` |
| `007_research_dataset_view.sql` | `v_admin_research_sessions` (flattened, filterable session dataset for Researchers/Exports) |
| `008_dashboard_distribution_views.sql` | `v_admin_age_distribution`, `v_admin_gender_distribution`, `v_admin_village_distribution`, `v_admin_lens_power_distribution`, `v_admin_festival_throughput` |
| `009_data_quality_view.sql` | `v_admin_data_quality` |

None of these migrations alter, drop, or replace any table, policy,
function, or view from `001`–`005`. RLS on every underlying table combines
multiple permissive `SELECT` policies with `OR`, so the new coordinator
policies are purely additive — every existing tester-scoped policy keeps
working unchanged for tester accounts, and views inherit the *querying*
user's RLS on their underlying tables (Supabase's default), so a tester who
somehow queried a `v_admin_*` view would only ever see their own
already-permitted rows, not a bypass.

`apply_session_event()` — the sole write path for clinical data — is not
touched. No `/admin` code ever calls `.insert()`/`.update()`/`.delete()`/
`.upsert()`; every query in `admin/js/admin-data.js` is a `select`.

## Pages

- **Sign in** — coordinator gate; friendly errors for wrong credentials,
  inactive accounts, and non-coordinator accounts.
- **Dashboard** — 14 KPI cards, daily-clients line chart, completion
  funnel, distance/near outcome bars, clinical pathway frequencies,
  festival throughput, age/gender/village distribution, lens power
  histogram, and a data-quality table.
- **Festivals** — list of every festival; click through to a per-festival
  scoped dashboard (clients, outcomes, village mix, devices).
- **Devices** — every registered device, last sync, sessions completed,
  and a best-effort online/offline status.
- **Researchers** — filterable, anonymised session dataset (date range,
  festival, village, age band, gender, pathway, distance/near result,
  paddle power) with a CSV export of the current filtered set.
- **Exports** — CSV/JSON downloads for festival, device, clinical-summary,
  and full research reports.
- **Settings** — placeholder; nothing to configure yet.

Charts are hand-rolled inline SVG (`admin/js/admin-charts.js`) — no
charting library, no CDN dependency, consistent with how the main app
avoids third-party chart/UI dependencies.

## Known gaps (flagged, not fabricated)

A few PRD metrics have no queryable signal in the current schema. Rather
than invent numbers, the UI shows them as explicit "not available"/"not
tracked server-side" states:

- **Pending sync events / offline queue size** — these only ever exist in
  a tester device's local IndexedDB until a sync succeeds; by definition
  Supabase has no record of a device that hasn't synced yet. Adding a
  client heartbeat/telemetry event would touch the tester app's offline
  logic, which is explicitly out of scope for this feature.
- **Per-device sync conflict attribution** — `sync_conflicts` records
  `session_id`, not `device_id`; conflicts can be attributed to a
  session/festival but not to a specific device.
- **True device online/offline status** — approximated as "synced within
  the last hour" (`devices.last_seen_at`); there's no real-time
  online/offline signal from a device.
- **Duplicate QR scans / average sync delay** — no QR-scan event log
  exists, and `session_events.created_at` is server receipt time with no
  client-recorded "action performed at" timestamp to diff against.

## Scope decisions

- **Global filter bar**: the PRD asks for a Festival/Date/Tester/Village/
  Gender/Age Band/Station/Device/Status filter bar on *every* dashboard.
  What's actually built: full multi-dimension filtering on the Researchers
  page, and Festival-scoping via the Festivals → click-through detail
  view. Retrofitting the same live filter bar onto Dashboard/Devices would
  mean parameterising every aggregate view (or adding a Postgres RPC per
  view) — left as a follow-up rather than half-implemented.
- **Excel exports**: "Download CSV" opens directly in Excel/Sheets; a true
  binary `.xlsx` writer would add a new dependency and wasn't attempted.
- **Lens power distribution**: uses Paddle's `selectedPower` (the single
  reading-glasses power actually dispensed) rather than Wheel's two
  per-eye sphere values, which don't reduce to one histogram bucket per
  client without inventing a combination rule — consistent with the main
  app's existing refusal to invent a Wheel best-lens formula (see root
  `CLAUDE.md`).
- **Screenshots**: every page listed above was visually verified live in
  a browser during development (sign-in gate, error states, all six nav
  screens, the Festival detail drill-down, and CSV/JSON export), but image
  files could not be captured to disk from this environment — there was
  no coordinator account against a live project to sign in with either
  (verification used a stubbed auth check + stubbed data responses).
  Recommended: run the app locally against a project with a coordinator
  account and click through the six nav items — everything is real,
  wired Supabase queries with no server to stand up beyond the existing
  one.
