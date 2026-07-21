/*
  006_insights_portal_read_access.sql

  Additive-only migration for the new /admin Insights Portal (coordinator-
  facing analytics dashboard, see feature/ooxii-insights-dashboard). Does
  NOT edit any table used by the tester app, does NOT alter or remove any
  existing RLS policy, grant, trigger, or function from 001-005 — only adds
  new ones alongside them. apply_session_event() (the sole write path for
  clinical data) is completely untouched by this file.

  What this adds:

  1. ooxii_is_global_coordinator() — a NEW helper, deliberately distinct
     from the existing ooxii_is_coordinator_or_admin(festival_id). That
     function checks festival_members.member_role for ONE specific
     festival (used today for "can this tester see the full roster / mark
     a conflict resolved for the festival they're in"). This one checks
     profiles.app_role — a global, cross-festival role already defined on
     the profiles table (`app_role in ('tester','coordinator',
     'administrator')`, default 'tester') — with NO per-festival scoping,
     because the Insights Portal is explicitly meant to see across every
     festival. profiles.app_role already exists; nothing here alters the
     column, its default, or its CHECK constraint.

  2. New SELECT-only RLS policies (profiles/festivals/festival_members/
     devices/client_sessions/session_events/sync_conflicts) granting a
     global coordinator read access to every row, not just their own or
     their festival's. Postgres combines multiple permissive policies for
     the same command with OR — every existing tester-scoped SELECT policy
     from 001 keeps working completely unchanged; this only ever WIDENS
     who can additionally read, and only for SELECT. No INSERT/UPDATE/
     DELETE grants are touched or added anywhere in this file — the
     Insights Portal is read-only, full stop (also enforced by never
     shipping any write call from /admin's own client code).

  3. Aggregate SQL views for the dashboard, so the client never has to
     download raw rows to compute a count/sum/group-by. Views run with the
     QUERYING user's RLS applied to their underlying tables (Supabase's
     documented default) — so these views are automatically safe for a
     plain tester to query too (they'd just see their own festival's
     numbers via the pre-existing tester policies), even though only
     coordinators are ever shown the /admin UI that queries them.

  Known, deliberate gaps (not fabricated data — flagged instead):
    - "Pending sync events" is NOT queryable here. Pending events only
      ever exist in a tester device's local IndexedDB until they sync —
      by definition, if a device hasn't synced, Supabase has no record of
      it at all. This migration does not add any client telemetry/
      heartbeat mechanism (would require touching the tester app's offline
      logic, explicitly out of scope) — the dashboard surfaces this
      honestly as "not visible until a device syncs" rather than guessing.
    - sync_conflicts has no device_id column (only session_id) — conflicts
      cannot be attributed to a specific device with the current schema,
      only to a session/festival. v_admin_device_status does not invent a
      per-device conflict count.
    - "Offline devices" is approximated as "no successful sync in the last
      hour" (devices.last_seen_at, updated by js/sync-service.js's
      ensureDeviceRegistered() on every successful sync) — a reasonable
      proxy, not a real-time online/offline signal (there is no
      device-side "I am now offline" event to observe).
*/

-- ============================================================================
-- 1. Global coordinator helper
-- ============================================================================
create or replace function ooxii_is_global_coordinator()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid()
      and is_active = true
      and app_role in ('coordinator','administrator')
  );
$$;

-- ============================================================================
-- 2. Additive coordinator SELECT policies — every one of these is a NEW,
--    separately-named policy alongside the existing tester-scoped policy on
--    the same table; nothing here is a `drop policy` on any pre-existing
--    tester policy.
-- ============================================================================
drop policy if exists profiles_select_coordinator on profiles;
create policy profiles_select_coordinator on profiles
  for select to authenticated
  using (ooxii_is_global_coordinator());

drop policy if exists festivals_select_coordinator on festivals;
create policy festivals_select_coordinator on festivals
  for select to authenticated
  using (ooxii_is_global_coordinator());

drop policy if exists festival_members_select_coordinator on festival_members;
create policy festival_members_select_coordinator on festival_members
  for select to authenticated
  using (ooxii_is_global_coordinator());

drop policy if exists devices_select_coordinator on devices;
create policy devices_select_coordinator on devices
  for select to authenticated
  using (ooxii_is_global_coordinator());

drop policy if exists client_sessions_select_coordinator on client_sessions;
create policy client_sessions_select_coordinator on client_sessions
  for select to authenticated
  using (ooxii_is_global_coordinator());

drop policy if exists session_events_select_coordinator on session_events;
create policy session_events_select_coordinator on session_events
  for select to authenticated
  using (ooxii_is_global_coordinator());

drop policy if exists sync_conflicts_select_coordinator on sync_conflicts;
create policy sync_conflicts_select_coordinator on sync_conflicts
  for select to authenticated
  using (ooxii_is_global_coordinator());

-- No new grant statements needed — 001 already granted `select` on every one
-- of these tables to the `authenticated` role; RLS policies (not grants) are
-- what actually scope which ROWS are visible, and that's all this section
-- changes.

-- ============================================================================
-- 3. Aggregate views for the Home Dashboard
-- ============================================================================

-- One-row global summary. "Sync success %" here is an approximation —
-- successful session_events vs. (successful + conflicted) — not a true
-- end-to-end delivery rate, since transient client-side retry failures
-- never reach Supabase at all (see file header).
create or replace view v_admin_kpis as
select
  (select count(*) from festivals) as total_festivals,
  (select count(*) from client_sessions) as total_clients,
  (select count(*) from client_sessions where status = 'Finalised') as completed_sessions,
  (select count(*) from client_sessions where dispense->>'glassesDispensed' = 'true') as glasses_dispensed,
  (select count(*) from client_sessions where distance is not null) as distance_tests,
  (select count(*) from client_sessions where near is not null) as near_tests,
  (select count(*) from client_sessions where wheel is not null) as wheel_tests,
  (select count(*) from client_sessions where paddle is not null) as paddle_tests,
  (select count(distinct created_by) from client_sessions where created_by is not null) as unique_testers,
  (select count(*) from devices) as unique_devices,
  (select count(*) from devices where last_seen_at < now() - interval '1 hour') as offline_devices,
  (select count(*) from sync_conflicts) as conflict_events,
  (select count(*) from session_events) as total_session_events,
  case when (select count(*) from session_events) + (select count(*) from sync_conflicts) = 0 then null
    else round(
      100.0 * (select count(*) from session_events)
      / ((select count(*) from session_events) + (select count(*) from sync_conflicts)),
      1
    )
  end as sync_success_pct;

-- Daily registrations (line chart). Uses registered_at, falling back to
-- created_at for any row registered_at somehow never got set on.
create or replace view v_admin_daily_clients as
select
  coalesce(registered_at, created_at)::date as day,
  count(*) as clients_registered
from client_sessions
group by 1
order by 1;

-- Distance / Near pass-fail outcomes (stacked bar), reusing the exact same
-- threshold functions apply_session_event() already validates against —
-- never a second, drifting definition of "pass".
create or replace view v_admin_distance_outcomes as
select ooxii_distance_outcome(distance) as outcome, count(*) as n
from client_sessions
where distance is not null
group by 1;

create or replace view v_admin_near_outcomes as
select ooxii_near_outcome(near) as outcome, count(*) as n
from client_sessions
where near is not null
group by 1;

-- Completion funnel — raw counts reaching each stage. NOTE: Wheel/Paddle are
-- route-conditional (see ooxii_compute_route) — a client whose route legitimately
-- never required Wheel or Paddle is NOT a drop-off, just a shorter valid path.
-- v_admin_pathway_frequencies (below) is what explains that; this view is
-- intentionally literal, not "corrected" for skip-eligible stages.
create or replace view v_admin_completion_funnel as
select
  count(*) filter (where age_band is not null) as registered,
  count(*) filter (where distance is not null) as distance_done,
  count(*) filter (where wheel is not null) as wheel_done,
  count(*) filter (where paddle is not null) as paddle_done,
  count(*) filter (where dispense is not null) as dispensed,
  count(*) filter (where status = 'Finalised') as completed
from client_sessions;

-- Clinical pathway frequency — how many clients needed which combination of
-- Wheel/Paddle, derived from the same route computation apply_session_event()
-- uses. 'none' = distance-only route (glasses not needed at all).
create or replace view v_admin_pathway_frequencies as
select
  coalesce(ooxii_compute_route(distance, near), 'incomplete') as route,
  count(*) as n
from client_sessions
group by 1;

-- Per-device status for the Devices dashboard. "status" is a best-effort
-- proxy (see file header) — there is no real-time online/offline signal.
create or replace view v_admin_device_status as
select
  d.id,
  d.label,
  d.festival_id,
  f.name as festival_name,
  d.user_id as tester_id,
  p.display_name as tester_name,
  d.last_seen_at,
  d.is_active,
  case when d.last_seen_at >= now() - interval '1 hour' then 'online' else 'offline' end as status,
  (select count(*) from session_events se where se.device_id = d.id) as sessions_completed
from devices d
left join festivals f on f.id = d.festival_id
left join profiles p on p.id = d.user_id;

-- Reissue explicit grants on the views — views need their own SELECT grant
-- even though they read from already-granted tables (Postgres does not
-- imply one from the other). Still RLS-safe: querying a view enforces the
-- RLS of the tables it reads from, for whichever role is actually asking.
grant select on v_admin_kpis, v_admin_daily_clients, v_admin_distance_outcomes,
  v_admin_near_outcomes, v_admin_completion_funnel, v_admin_pathway_frequencies,
  v_admin_device_status to authenticated;
