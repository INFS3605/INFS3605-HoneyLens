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
| `010_impact_dashboard_views.sql` | `v_admin_daily_dispensed`, `v_admin_avg_completion_time`, `v_admin_festival_impact` (added for the impact-dashboard redesign, see below) |

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
- **Dashboard** — redesigned as an impact-focused nonprofit report rather
  than a technical monitoring console (see "Dashboard redesign" below):
  a 4-KPI impact hero, an outcomes section, a togglable people-reached-
  over-time chart, a festival impact comparison table, a communities-
  reached ranking, a smaller demographics section, program-effectiveness
  averages, and a collapsed "System and Data Health" panel holding
  everything that used to be a flat, equally-weighted KPI grid.
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

## Dashboard redesign (impact-focused)

The original Dashboard gave a flat, 14-card KPI grid equal visual weight
to wheel/paddle test counts, device counts, and sync/conflict metrics
alongside clients-tested and glasses-dispensed — useful for technical
administration, but not something a founder, donor, or grant reviewer
could scan in five seconds to answer "is this working?" It was rebuilt
around one hierarchy: **people helped → outcomes delivered → communities
reached → program effectiveness → technical health**, with nothing
technical above the fold. Colours and typography are unchanged (the
existing palette/Segoe UI stack already matched `index.html`'s — see
"Access model" era CSS — this redesign only reorganises layout and
hierarchy, adding a small hero/outcome/rank-row vocabulary of its own).

**What moved where** (no query was deleted — every `AdminData` function
from before this redesign still exists and is still called from
somewhere):

| Was on the old flat KPI grid | Now |
|---|---|
| Total Eye Festivals, Total Clients Tested, Completed Sessions, Glasses Dispensed | Impact Summary Hero (reframed: festivals *delivered*, not just counted) |
| Distance/Near/Wheel/Paddle test counts, Unique Testers, Unique Devices, Offline Devices, Conflict Events, Sync Success %, Pending Sync Events | Collapsed "System and Data Health" panel |
| Daily clients line chart | "People Reached Over Time" (togglable clients ⇄ glasses) |
| Testing completion funnel, Distance/Near outcome bars, Pathway frequencies | "Outcomes Delivered" + "Program Effectiveness" |
| Festival throughput bar chart | "Impact by Eye Festival" table (clients, glasses, completion %, dispensing %) |
| Age/Gender/Village distribution | "Who OOXii Reached" (smaller) + "Communities Reached" (village, ranked) |
| Lens power histogram | Still queryable (`AdminData.getLensPowerDistribution`); not shown as a headline chart — supporting clinical detail belongs on Researchers, not the impact dashboard |
| Data quality table | Inside the collapsed System and Data Health panel |

**Global filter bar** (reporting period / festival / village + Reset) drives
every section consistently via one of two paths:
- **Unfiltered ("All time", no festival, no village)** — uses the existing
  all-time aggregate views (`v_admin_kpis`, `v_admin_completion_funnel`,
  `v_admin_pathway_frequencies`, `v_admin_distance/near_outcomes`,
  `v_admin_age/gender/village_distribution`, `v_admin_festival_impact`,
  `v_admin_daily_clients`/`v_admin_daily_dispensed`, `v_admin_avg_completion_time`)
  — no row cap, exact totals.
- **Any filter applied** — queries the existing `v_admin_research_sessions`
  view with the matching filters and recomputes every hero/outcome/
  festival/community number client-side from that one filtered result
  set, so every section stays consistent with each other. This view is
  capped at 2000 rows (an existing limit from the Researchers page); if a
  filtered query hits exactly 2000 rows, the UI notes results may be
  capped rather than silently under-counting.
- System and Data Health intentionally ignores the filter bar — it
  reports the whole system's technical status, not a slice of it, and
  says so in its own subtext.

**"Generate Impact Summary"** builds a print-friendly HTML snapshot (Blob
URL opened in a new tab, with a `window.print()` button and `@media
print` rules) from whatever is currently loaded on the Dashboard —
reporting period, the 4 hero KPIs, completion/dispensing rates, the
current over-time chart, and the festival comparison table. No PDF
library or server-side rendering was added.

### Dashboard metrics — source and calculation

| Dashboard metric | Plain-language meaning | Supabase source | Calculation | Tested with real data |
|---|---|---|---|---|
| Clients tested | Unique client testing sessions | `client_sessions` (unfiltered: `v_admin_kpis.total_clients`; filtered: row count of `v_admin_research_sessions`) | `count(*)` over `client_sessions` rows — one row per client per festival (`unique(festival_id, client_id)`), never per `session_events` | No — stubbed responses only (no live coordinator account against a deployed project yet, see "Screenshots" below) |
| Glasses dispensed | Clients who received glasses | `client_sessions.dispense` | `count(*) where dispense->>'glassesDispensed' = 'true'` — one per session, not per click/event | No — stubbed |
| Eye festivals delivered | Festivals with at least one tested client | `v_admin_festival_impact` (new, migration 010) | `count(festivals where clients > 0)` — deliberately excludes festivals with zero activity, unlike `v_admin_kpis.total_festivals` which counts every festival row | No — stubbed |
| Communities reached | Unique villages with a tested client | `v_admin_village_distribution` (unfiltered) / distinct `village` (filtered) | Distinct non-null `client_sessions.village`; the view's null→"Unknown" bucket is excluded from the count | No — stubbed |
| % clients who received glasses | Dispensing rate | derived | glasses dispensed ÷ **tested clients** (denominator shown next to the figure, e.g. "7 of 29 tested clients") | No — stubbed |
| % testing pathways completed | Completion rate | `v_admin_completion_funnel.completed` (unfiltered) / `status='Finalised'` count (filtered) | Finalised sessions ÷ tested clients (denominator shown) | No — stubbed |
| Clients with distance/near vision needs | Failed the relevant pre-test | `v_admin_distance_outcomes` / `v_admin_near_outcomes` | `count(outcome='fail')`, reusing `ooxii_distance_outcome()`/`ooxii_near_outcome()` — the exact same thresholds `apply_session_event()` validates against | No — stubbed |
| Both distance + near correction / no glasses needed | Full-workflow vs. distance-only pathway counts | `v_admin_pathway_frequencies` | `route='wheel_then_paddle'` / `route='none'` counts from `ooxii_compute_route()` | No — stubbed |
| People Reached Over Time | Daily clients tested / glasses dispensed | `v_admin_daily_clients` / `v_admin_daily_dispensed` (new, migration 010) | Grouped on `registered_at::date` / `finalised_at::date` — **not** on `dispense.completedAt`/`wheel.recordedAt`/`paddle.recordedAt`, which are `nowTime()` ("HH:MM" only, no date) in the tester app and unusable for a daily series | No — stubbed |
| Impact by Eye Festival table | Per-festival clients/glasses/rates | `v_admin_festival_impact` (new, migration 010) | Per-festival `count`, `count filter (status='Finalised')`, `count filter (glassesDispensed='true')`, and the two rates, all in one `left join` so zero-activity festivals are visible too (then filtered to `clients>0` for display) | No — stubbed |
| Avg. clients / glasses per festival | Program effectiveness averages | derived | tested clients (or glasses dispensed) ÷ festivals delivered — deliberately not ÷ every festival row, which would understate the average | No — stubbed |
| Avg. registration → completion | How long a testing pathway takes | `v_admin_avg_completion_time` (new, migration 010) | `avg(finalised_at - registered_at)` for Finalised sessions, in hours; shown as "Not enough data yet" below 3 samples. **Caveat surfaced in the UI**: both timestamps are stamped when an event reaches the server, so this can run long for a session that was registered offline and synced later — not a precise field-measured duration | No — stubbed |
| System and Data Health metrics | Sync success %, conflicts, offline devices, data completeness | `v_admin_kpis`, `v_admin_data_quality` | Unchanged from the pre-redesign Dashboard — see "Known gaps" below | No — stubbed |

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

- **Global filter bar**: the Dashboard now has a reporting period /
  festival / village filter bar (see "Dashboard redesign" above) that
  drives every section consistently. The broader PRD ask (also Tester/
  Station/Device/Status dimensions, on every page including Devices) is
  still not built — Devices/Festivals/Exports remain unfiltered pages,
  and Researchers keeps its own separate, more clinical filter set
  (route/distance/near/paddle power) that doesn't fit the impact
  dashboard's framing. Extending Tester/Station/Device filtering to the
  Dashboard would need those fields added to `v_admin_research_sessions`
  — left as a follow-up rather than half-implemented.
- **Excel exports**: "Download CSV" opens directly in Excel/Sheets; a true
  binary `.xlsx` writer would add a new dependency and wasn't attempted.
- **Lens power distribution**: uses Paddle's `selectedPower` (the single
  reading-glasses power actually dispensed) rather than Wheel's two
  per-eye sphere values, which don't reduce to one histogram bucket per
  client without inventing a combination rule — consistent with the main
  app's existing refusal to invent a Wheel best-lens formula (see root
  `CLAUDE.md`).
- **Screenshots**: every page listed above, including every section of
  the redesigned Dashboard (filter bar, hero, outcomes, the over-time
  toggle, festival impact table, communities reached, demographics,
  program effectiveness, the collapsed System and Data Health panel, and
  the generated Impact Summary), was visually verified live in a browser
  during development — at both desktop and tablet widths, and against
  empty-data and filtered states — but image files could not be captured
  to disk from this environment, and there was still no coordinator
  account against a live project to sign in with (verification used a
  stubbed auth check + stubbed `AdminData` responses standing in for real
  Supabase rows). Recommended: run the app locally against a project with
  a coordinator account and migrations 001–010 applied, and click through
  every page — everything is real, wired Supabase queries with no server
  to stand up beyond the existing one.
