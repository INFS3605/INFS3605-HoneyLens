/*
  004_handle_identical_stale_events_test.sql — manual acceptance test for
  supabase/migrations/004_handle_identical_stale_events.sql.

  NOT a migration — do not put this file in supabase/migrations/. Safe to
  run against the real project: everything happens inside one transaction
  and is rolled back at the end.

  Reuses YOUR real, already-existing auth user (johnsmith@gmail.com,
  69511db0-d390-47b2-b35a-224df2d6228e) — same pattern as
  002_version_baseline_test.sql / 003_version_baseline_correction_test.sql.
*/

begin;

do $$
declare
  v_user_id uuid := '69511db0-d390-47b2-b35a-224df2d6228e'; -- johnsmith@gmail.com — real, already-existing auth user
  v_festival_id uuid := gen_random_uuid();
  v_device_id uuid := gen_random_uuid();
  v_result jsonb;
  v_client_a text := 'Z94-Z'; -- throwaway anonymous ID, distinct from earlier test files
  v_session_a uuid := gen_random_uuid();
  v_event_1 uuid := gen_random_uuid();
  v_event_identical uuid := gen_random_uuid();
  v_event_diff uuid := gen_random_uuid();
  v_conflicts_before int;
  v_conflicts_after int;
  v_session_events_count int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id::text)::text, true);

  if not exists (select 1 from profiles where id = v_user_id) then
    raise exception 'TEST SETUP FAILED: no profiles row for %. Update v_user_id to a real auth user on this project.', v_user_id;
  end if;

  insert into festivals (id, name, village, start_date, end_date, status)
  values (v_festival_id, 'TEST FESTIVAL (rolled back)', 'Test Village', current_date, current_date, 'active');
  insert into festival_members (festival_id, user_id, member_role, allowed_stations, is_active)
  values (v_festival_id, v_user_id, 'coordinator', array['Registration','Distance','Wheel','Paddle','Dispense','Exit'], true);
  insert into devices (id, festival_id, user_id, label, app_version)
  values (v_device_id, v_festival_id, v_user_id, 'TEST DEVICE (rolled back)', 'test-1.0');

  -- ============================================================
  -- SETUP: one successful Registration event, bringing the canonical
  -- row to version 2 with known age_band/gender/village/cataract/status.
  -- ============================================================
  v_result := apply_session_event(
    v_event_1, v_session_a, v_festival_id, v_client_a, 'festival',
    'registration', 'Registration', 'Registration',
    jsonb_build_object('ageBand','45-59','gender','Female','village','Port Vila','cataract','No','status','In Progress'),
    v_device_id, 1, now(), null
  );
  if v_result->>'status' <> 'ok' or (v_result->>'version')::int <> 2 then
    raise exception 'SETUP FAILED: expected first registration to succeed at version 2, got %', v_result;
  end if;

  -- ============================================================
  -- TEST A: stale-but-identical event — a DIFFERENT event id, SAME
  -- clinical values, stale base_version=1 (server is already at 2).
  -- Mirrors the real production case: a second device/tab (or a
  -- qr_imported snapshot) resending the same Registration data.
  -- ============================================================
  select count(*) into v_conflicts_before from sync_conflicts where session_id = v_session_a;
  select count(*) into v_session_events_count from session_events where session_id = v_session_a;

  v_result := apply_session_event(
    v_event_identical, v_session_a, v_festival_id, v_client_a, 'festival',
    'registration', 'Registration', 'Registration',
    jsonb_build_object('ageBand','45-59','gender','Female','village','Port Vila','cataract','No','status','In Progress'),
    v_device_id, 1, now(), null  -- stale base_version, identical values
  );
  if v_result->>'status' <> 'already_applied' then
    raise exception 'TEST A FAILED: expected status=already_applied, got %', v_result;
  end if;
  if (v_result->>'version')::int <> 2 then
    raise exception 'TEST A FAILED: expected canonical version to remain 2 (no increment for a no-op), got %', v_result->>'version';
  end if;
  select count(*) into v_conflicts_after from sync_conflicts where session_id = v_session_a;
  if v_conflicts_after <> v_conflicts_before then
    raise exception 'TEST A FAILED: expected no new sync_conflicts row, had % before and % after', v_conflicts_before, v_conflicts_after;
  end if;
  if exists (select 1 from session_events where id = v_event_identical) then
    raise exception 'TEST A FAILED: an already_applied event must not be inserted into session_events';
  end if;
  select count(*) into v_session_events_count from session_events where session_id = v_session_a;
  if v_session_events_count <> 1 then
    raise exception 'TEST A FAILED: expected session_events count to remain 1, got %', v_session_events_count;
  end if;
  raise notice 'TEST A PASSED: stale-but-identical event -> already_applied, no conflict row, no version increment, no session_events row';

  -- ============================================================
  -- TEST B: genuine stale conflict — a DIFFERENT event id, stale
  -- base_version=1, but a DIFFERENT ageBand than what's canonical.
  -- Must still be treated as a real conflict.
  -- ============================================================
  select count(*) into v_conflicts_before from sync_conflicts where session_id = v_session_a;

  v_result := apply_session_event(
    v_event_diff, v_session_a, v_festival_id, v_client_a, 'festival',
    'registration', 'Registration', 'Registration',
    jsonb_build_object('ageBand','60+','gender','Female','village','Port Vila','cataract','No','status','In Progress'),
    v_device_id, 1, now(), null  -- stale base_version, DIFFERENT ageBand
  );
  if v_result->>'status' <> 'conflict' or v_result->>'conflict_type' <> 'version_mismatch' then
    raise exception 'TEST B FAILED: expected structured version_mismatch conflict, got %', v_result;
  end if;
  select count(*) into v_conflicts_after from sync_conflicts where session_id = v_session_a;
  if v_conflicts_after <> v_conflicts_before + 1 then
    raise exception 'TEST B FAILED: expected exactly one new sync_conflicts row, had % before and % after', v_conflicts_before, v_conflicts_after;
  end if;
  if not exists (select 1 from client_sessions where id = v_session_a and age_band = '45-59') then
    raise exception 'TEST B FAILED: canonical age_band must remain unchanged (45-59), the differing incoming value must never overwrite it';
  end if;
  raise notice 'TEST B PASSED: stale event with a genuinely different value -> version_mismatch conflict, one conflict row, canonical data unchanged';

  -- ============================================================
  -- TEST C: duplicate event UUID — re-send the ORIGINAL successful
  -- event id. Must remain idempotent, unaffected by this fix.
  -- ============================================================
  v_result := apply_session_event(
    v_event_1, v_session_a, v_festival_id, v_client_a, 'festival',
    'registration', 'Registration', 'Registration',
    jsonb_build_object('ageBand','45-59','gender','Female','village','Port Vila','cataract','No','status','In Progress'),
    v_device_id, 1, now(), null
  );
  if v_result->>'status' <> 'duplicate_ok' then
    raise exception 'TEST C FAILED: expected status=duplicate_ok for a re-sent original event id, got %', v_result;
  end if;
  select count(*) into v_session_events_count from session_events where id = v_event_1;
  if v_session_events_count <> 1 then
    raise exception 'TEST C FAILED: duplicate re-send must not create a second session_events row, found %', v_session_events_count;
  end if;
  raise notice 'TEST C PASSED: duplicate event UUID -> duplicate_ok, unaffected by the already_applied change';

  raise notice 'ALL 3 TESTS PASSED';
end;
$$;

rollback;
