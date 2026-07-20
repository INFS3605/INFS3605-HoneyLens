/*
  007_research_dataset_view.sql

  Additive-only migration for the /admin Researchers page (dataset explorer +
  anonymised export). Adds exactly one new view and one grant — no table,
  policy, function, or existing view from 001-006 is altered. Coordinator
  access to the underlying client_sessions rows already comes from
  client_sessions_select_coordinator (006); this view exists purely to
  flatten the jsonb clinical fields into filterable columns so the /admin
  client can use plain .eq()/.gte() query-builder filters instead of
  downloading every raw row and filtering client-side.

  Privacy: exposes only fields the tester app already treats as
  non-identifying by design (anonymous client_id in the "[Letter][2 digits]-
  [check]" format, age BAND not DOB, village, gender) plus clinical outcome
  columns. No name, phone, email, address, or full date of birth exists
  anywhere in client_sessions to begin with (see CLAUDE.md "Privacy").
*/

create or replace view v_admin_research_sessions as
select
  cs.id,
  cs.client_id,
  cs.festival_id,
  f.name as festival_name,
  cs.village,
  cs.age_band,
  cs.gender,
  cs.cataract,
  cs.status,
  coalesce(ooxii_compute_route(cs.distance, cs.near), 'incomplete') as route,
  ooxii_distance_outcome(cs.distance) as distance_outcome,
  ooxii_near_outcome(cs.near) as near_outcome,
  (cs.wheel #>> '{right,lensType}') as wheel_right_lens_type,
  (cs.wheel #>> '{right,spherePower}') as wheel_right_sphere,
  (cs.wheel #>> '{left,lensType}') as wheel_left_lens_type,
  (cs.wheel #>> '{left,spherePower}') as wheel_left_sphere,
  (cs.paddle ->> 'selectedPower') as paddle_power,
  (cs.dispense ->> 'glassesDispensed') = 'true' as glasses_dispensed,
  cs.registered_at,
  cs.finalised_at
from client_sessions cs
left join festivals f on f.id = cs.festival_id;

grant select on v_admin_research_sessions to authenticated;
