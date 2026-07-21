/*
  010_impact_dashboard_views.sql

  Additive-only, for the Insights Portal's impact-focused Dashboard redesign
  (feature/ooxii-insights-dashboard). No table, policy, function, or
  existing view from 001-009 is altered — this only adds 3 new views.

  1. v_admin_daily_dispensed — the second series for the "People Reached
     Over Time" toggle (clients tested vs. glasses dispensed). Grouped on
     finalised_at, NOT on any client-supplied timestamp: dispense.completedAt
     / wheel.recordedAt / paddle.recordedAt are all `nowTime()` in the
     tester app (index.html), which returns only "HH:MM" with no date —
     unusable for a daily series. finalised_at is a genuine server-side
     timestamptz, stamped by apply_session_event() the moment a session's
     status first becomes 'Finalised' (see 001/002/003/004/005's identical
     `finalised_at = case when p_payload->>'status' = 'Finalised' then
     now() ... end`), so it's the one reliable date signal available.

  2. v_admin_avg_completion_time — avg(finalised_at - registered_at) for
     Finalised sessions, in hours, with a sample_size so the UI can show
     "not enough data" rather than a misleading average from 1-2 sessions.
     Caveat (surfaced in the UI, not hidden): both timestamps are stamped
     when an event reaches the server, not necessarily when the action
     happened in the field — a session registered offline and synced hours
     later will show a longer "completion time" than the real in-person
     duration. Still the only timestamp pair genuinely available.

  3. v_admin_festival_impact — one purpose-built view for the "Impact by
     Eye Festival" comparison table: per-festival clients tested, completed
     sessions, glasses dispensed, completion rate, and dispensing rate.
     No existing view combines these per festival (v_admin_festival_throughput
     from 008 only has raw client counts + a naive avg-per-hour figure).
     v_admin_festival_throughput is left exactly as-is; this is a new,
     separate view, not a replacement.
*/

create or replace view v_admin_daily_dispensed as
select
  finalised_at::date as day,
  count(*) as glasses_dispensed
from client_sessions
where finalised_at is not null
  and dispense->>'glassesDispensed' = 'true'
group by 1
order by 1;

create or replace view v_admin_avg_completion_time as
select
  case when count(*) = 0 then null
    else round(avg(extract(epoch from (finalised_at - registered_at)) / 3600.0)::numeric, 1)
  end as avg_hours,
  count(*) as sample_size
from client_sessions
where status = 'Finalised' and registered_at is not null and finalised_at is not null;

create or replace view v_admin_festival_impact as
select
  f.id as festival_id,
  f.name as festival_name,
  f.village,
  f.start_date,
  f.end_date,
  count(cs.id) as clients,
  count(cs.id) filter (where cs.status = 'Finalised') as completed_sessions,
  count(cs.id) filter (where cs.dispense->>'glassesDispensed' = 'true') as glasses_dispensed,
  case when count(cs.id) = 0 then null
    else round(100.0 * count(cs.id) filter (where cs.status = 'Finalised') / count(cs.id), 1)
  end as completion_rate_pct,
  case when count(cs.id) = 0 then null
    else round(100.0 * count(cs.id) filter (where cs.dispense->>'glassesDispensed' = 'true') / count(cs.id), 1)
  end as dispensing_rate_pct
from festivals f
left join client_sessions cs on cs.festival_id = f.id
group by f.id, f.name, f.village
order by count(cs.id) desc nulls last;

grant select on v_admin_daily_dispensed, v_admin_avg_completion_time,
  v_admin_festival_impact to authenticated;
