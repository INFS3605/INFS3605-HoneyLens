/*
  009_data_quality_view.sql

  Additive-only: one view for the /admin Data Quality panel. No table,
  policy, function, or existing view from 001-008 is altered.

  Deliberate gaps, NOT fabricated (consistent with 006's "known gaps"
  section):
    - Duplicate QR scans: there is no QR-scan event log in the schema
      (js/qr-service.js's scan handling is entirely client-side/local) —
      not queryable at all server-side.
    - Average sync delay: session_events.created_at is server receipt
      time; there is no client-recorded "action performed at" timestamp
      in the payload to diff against, so a delay figure would be invented.
    - Offline queue size: same reasoning as v_admin_kpis's "pending sync
      events" — pending events live only in a device's local IndexedDB
      until synced, invisible to Supabase by definition.
    - "Failed uploads": the only server-visible failure signal is
      sync_conflicts (an upload that failed to auto-merge and was filed
      instead) — there is no separate transient-failure log, so this
      panel labels it "conflicts", not "failed uploads", to avoid
      implying a broader signal than what actually exists.
*/

create or replace view v_admin_data_quality as
select
  (select count(*) from client_sessions where age_band is null) as missing_age_band,
  (select count(*) from client_sessions where village is null) as missing_village,
  (select count(*) from client_sessions where gender is null) as missing_gender,
  (select count(*) from client_sessions where cataract is null) as missing_cataract,
  (select count(*) from client_sessions where status <> 'Finalised') as incomplete_sessions,
  (select count(*) from client_sessions) as total_sessions,
  (select count(*) from sync_conflicts) as conflicts;

grant select on v_admin_data_quality to authenticated;
