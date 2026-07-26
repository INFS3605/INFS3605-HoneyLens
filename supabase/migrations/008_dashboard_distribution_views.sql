/*
  008_dashboard_distribution_views.sql

  Additive-only: 5 more aggregate views for the Home Dashboard's remaining
  PRD charts (age distribution, gender distribution, village distribution,
  lens power distribution, festival throughput). No table, policy,
  function, or existing view from 001-007 is altered.

  Lens power distribution uses paddle_power (the reading-glasses power
  actually dispensed on paddle_only/wheel_then_paddle routes) — the single
  scalar "lens power" a client walks away with, as opposed to Wheel's two
  separate per-eye sphere values, which don't reduce to one histogram
  bucket per client without inventing a combination rule (see CLAUDE.md
  "Wheel best-lens combination formula ... is deliberately not invented").
*/

create or replace view v_admin_age_distribution as
select coalesce(age_band, 'Unknown') as age_band, count(*) as n
from client_sessions
group by 1;

create or replace view v_admin_gender_distribution as
select coalesce(gender, 'Unknown') as gender, count(*) as n
from client_sessions
group by 1;

create or replace view v_admin_village_distribution as
select coalesce(village, 'Unknown') as village, count(*) as n
from client_sessions
group by 1
order by 2 desc;

create or replace view v_admin_lens_power_distribution as
select paddle->>'selectedPower' as power, count(*) as n
from client_sessions
where paddle->>'selectedPower' is not null
group by 1
order by 1;

-- Clients registered per festival, plus a naive avg-per-hour figure
-- spanning first-to-last registration for that festival (not a true
-- "hours the festival was open" figure — the app has no session/open-close
-- event to derive that from; flagged rather than guessed).
create or replace view v_admin_festival_throughput as
select
  f.id as festival_id,
  f.name as festival_name,
  count(cs.id) as clients,
  case
    when count(cs.id) < 2 then null
    else round(
      count(cs.id) / greatest(
        extract(epoch from (max(cs.registered_at) - min(cs.registered_at))) / 3600.0,
        1.0
      ), 1
    )
  end as avg_per_hour
from festivals f
left join client_sessions cs on cs.festival_id = f.id
group by f.id, f.name
order by f.name;

grant select on v_admin_age_distribution, v_admin_gender_distribution,
  v_admin_village_distribution, v_admin_lens_power_distribution,
  v_admin_festival_throughput to authenticated;
