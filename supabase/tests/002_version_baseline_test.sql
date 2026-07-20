/*
  002_version_baseline_test.sql — manual acceptance test for
  supabase/migrations/002_fix_session_event_version_baseline.sql.

  NOT a migration — do not put this file in supabase/migrations/ (Supabase
  applies every .sql file there automatically; this one must only ever be
  run by hand). Safe to run against the real project: everything happens
  inside one transaction and is rolled back at the end, so nothing here
  is left behind, no matter which assertion (if any) fails.

  How to run: paste this whole file into the Supabase SQL Editor and
  execute it. Every check is a `do $$ ... raise exception ... $$` block —
  if the script runs to the final `rollback;` with no error, every
  assertion passed. If something fails, the SQL Editor will show exactly
  which RAISE EXCEPTION fired and stop there (the transaction still rolls
  back automatically on error).

  Reuses YOUR real, already-existing auth user (johnsmith@gmail.com,
  69511db0-d390-47b2-b35a-224df2d6228e) and its real profiles row — no
  fake auth.users/profiles rows are created (profiles.id has a foreign key
  to auth.users, so a throwaway UUID there would fail anyway). Only a
  throwaway festival + festival_members row are created, and only inside
  this rolled-back transaction.

  This assumes the standard Supabase auth.uid() implementation, reading
  auth.uid() from the 'sub' claim of request.jwt.claims. If your project
  customised auth.uid(), adjust the set_config() call below accordingly.
*/

begin;

do $$
declare
  v_user_id uuid := '69511db0-d390-47b2-b35a-224df2d6228e'; -- johnsmith@gmail.com — real, already-existing auth user
  v_festival_id uuid := gen_random_uuid();
  v_result jsonb;
  v_client_a text := 'Z90-Z'; -- throwaway anonymous IDs, unlikely to collide with real data even without rollback
  v_client_b text := 'Z91-Z';
  v_session_a uuid := gen_random_uuid();
  v_event_1 uuid := gen_random_uuid();
  v_event_2 uuid := gen_random_uuid();
  v_event_3 uuid := gen_random_uuid();
  v_event_4_dup uuid;
  v_session_events_count int;
  v_conflicts_count int;
  v_client_sessions_count int;
  -- session_events.device_id references devices(id) — apply_session_event()
  -- never creates this row itself (by design: devices is one of the few
  -- tables the client writes to directly, via RLS, not through this RPC —
  -- see devices_insert_own below). A bare gen_random_uuid() here fails
  -- that FK. One throwaway device row, reused across every call in this
  -- test, exactly as a single real tester's single real device would be.
  v_device_id uuid := gen_random_uuid();
begin
  -- Fake an authenticated request context for auth.uid() (standard Supabase pattern).
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id::text)::text, true);

  if not exists (select 1 from profiles where id = v_user_id) then
    raise exception 'TEST SETUP FAILED: no profiles row for %. This test reuses a real existing user — update v_user_id to a real auth user on this project.', v_user_id;
  end if;

  insert into festivals (id, name, village, start_date, end_date, status)
  values (v_festival_id, 'TEST FESTIVAL (rolled back)', 'Test Village', current_date, current_date, 'active');
  insert into festival_members (festival_id, user_id, member_role, allowed_stations, is_active)
  values (v_festival_id, v_user_id, 'coordinator', array['Registration','Distance','Wheel','Paddle','Dispense','Exit'], true);
  -- devices_insert_own's RLS check (user_id = auth.uid() and
  -- ooxii_is_active_profile()) is satisfied by the set_config() above plus
  -- the real, already-active profile reused from v_user_id.
  insert into devices (id, festival_id, user_id, label, app_version)
  values (v_device_id, v_festival_id, v_user_id, 'TEST DEVICE (rolled back)', 'test-1.0');

  -- ============================================================
  -- TEST 1: brand-new session, first event, base_version = 0
  -- ============================================================
  v_result := apply_session_event(
    v_event_1, v_session_a, v_festival_id, v_client_a, 'festival',
    'registration', 'Registration', 'Registration',
    -- Must match js/backend-adapter.js's PAYLOAD_KEYS.Registration exactly
    -- (ageBand, gender, village, cataract, status) — ooxii_next_required_step()
    -- only considers Registration complete once ALL FOUR clinical fields are
    -- non-null (age_band/gender/village/cataract), not just ageBand. Omitting
    -- any of them left current_required_step stuck at 'Registration' after
    -- this event, which is what made TEST 2's 'Distance' step get rejected
    -- as out-of-order — a test-fixture bug, not a migration bug.
    jsonb_build_object('ageBand','45-59','gender','Female','village','Port Vila','cataract','None','status','Draft'),
    v_device_id, 0, now(), null
  );
  if v_result->>'status' <> 'ok' then
    raise exception 'TEST 1 FAILED: expected status=ok, got %', v_result;
  end if;
  if (v_result->>'version')::int <> 1 then
    raise exception 'TEST 1 FAILED: expected canonical version=1, got %', v_result->>'version';
  end if;
  select count(*) into v_session_events_count from session_events where session_id = v_session_a;
  if v_session_events_count <> 1 then
    raise exception 'TEST 1 FAILED: expected exactly 1 session_events row, got %', v_session_events_count;
  end if;
  select count(*) into v_conflicts_count from sync_conflicts where session_id = v_session_a;
  if v_conflicts_count <> 0 then
    raise exception 'TEST 1 FAILED: expected 0 sync_conflicts rows, got %', v_conflicts_count;
  end if;
  raise notice 'TEST 1 PASSED: new session, first event (base_version 0) -> ok, version 1, 1 session_events row, 0 conflicts';

  -- ============================================================
  -- TEST 2: second sequential event, base_version = 1
  -- ============================================================
  v_result := apply_session_event(
    v_event_2, v_session_a, v_festival_id, v_client_a, 'festival',
    'step_saved', 'Distance', 'Distance',
    jsonb_build_object('distance', jsonb_build_object('rightUnaided', jsonb_build_object('lineReached',7), 'leftUnaided', jsonb_build_object('lineReached',7), 'hasGlasses', false, 'ownGlasses', null)),
    v_device_id, 1, now(), null
  );
  if v_result->>'status' <> 'ok' then
    raise exception 'TEST 2 FAILED: expected status=ok, got %', v_result;
  end if;
  if (v_result->>'version')::int <> 2 then
    raise exception 'TEST 2 FAILED: expected canonical version=2, got %', v_result->>'version';
  end if;
  if not exists (select 1 from session_events where id = v_event_2 and session_id = v_session_a) then
    raise exception 'TEST 2 FAILED: second session_events row not found';
  end if;
  raise notice 'TEST 2 PASSED: second event (base_version 1) -> ok, version 2, second session_events row exists';

  -- ============================================================
  -- TEST 3: stale event — server is at version 2, event claims base 1
  -- ============================================================
  v_result := apply_session_event(
    v_event_3, v_session_a, v_festival_id, v_client_a, 'festival',
    'step_saved', 'Wheel', 'Wheel',
    jsonb_build_object('wheel', jsonb_build_object('pd', 62)),
    v_device_id, 1, now(), null
  );
  if v_result->>'status' <> 'conflict' or v_result->>'conflict_type' <> 'version_mismatch' then
    raise exception 'TEST 3 FAILED: expected structured version_mismatch conflict, got %', v_result;
  end if;
  if not exists (select 1 from sync_conflicts where local_event_id = v_event_3 and conflict_type = 'version_mismatch') then
    raise exception 'TEST 3 FAILED: expected a sync_conflicts row for the stale event';
  end if;
  if exists (select 1 from session_events where id = v_event_3) then
    raise exception 'TEST 3 FAILED: the stale event must NOT have been inserted into session_events';
  end if;
  raise notice 'TEST 3 PASSED: stale event (base_version 1 vs server 2) -> structured version_mismatch, conflict row inserted, no extra session_events row';

  -- ============================================================
  -- TEST 4: duplicate event UUID (re-send event_2)
  -- ============================================================
  select count(*) into v_session_events_count from session_events where id = v_event_2;
  if v_session_events_count <> 1 then
    raise exception 'TEST 4 SETUP FAILED: expected exactly 1 pre-existing row for event_2 before duplicate re-send, got %', v_session_events_count;
  end if;
  v_result := apply_session_event(
    v_event_2, v_session_a, v_festival_id, v_client_a, 'festival',
    'step_saved', 'Distance', 'Distance',
    jsonb_build_object('distance', jsonb_build_object('rightUnaided', jsonb_build_object('lineReached',7), 'leftUnaided', jsonb_build_object('lineReached',7), 'hasGlasses', false, 'ownGlasses', null)),
    v_device_id, 1, now(), null
  );
  if v_result->>'status' <> 'duplicate_ok' then
    raise exception 'TEST 4 FAILED: expected status=duplicate_ok for a re-sent event id, got %', v_result;
  end if;
  select count(*) into v_session_events_count from session_events where id = v_event_2;
  if v_session_events_count <> 1 then
    raise exception 'TEST 4 FAILED: duplicate re-send must not create a second session_events row, found %', v_session_events_count;
  end if;
  raise notice 'TEST 4 PASSED: duplicate event UUID -> duplicate_ok, no duplicate session_events row';

  -- ============================================================
  -- TEST 5: existing (festival_id, client_id) reached under a DIFFERENT
  -- session UUID — must self-heal onto the canonical row, never raise a
  -- raw unique_violation/HTTP 409, never create a second client_sessions row.
  -- ============================================================
  -- first, establish a canonical row for v_client_b under session id v_session_a-like uuid
  declare
    v_session_b_real uuid := gen_random_uuid();
    v_session_b_stale uuid := gen_random_uuid(); -- a DIFFERENT id the "other device" mistakenly uses
    v_event_5a uuid := gen_random_uuid();
    v_event_5b uuid := gen_random_uuid();
  begin
    v_result := apply_session_event(
      v_event_5a, v_session_b_real, v_festival_id, v_client_b, 'festival',
      'registration', 'Registration', 'Registration',
      jsonb_build_object('ageBand','60+','gender','Male','village','Mele','cataract','None','status','Draft'),
      v_device_id, 0, now(), null
    );
    if v_result->>'status' <> 'ok' then
      raise exception 'TEST 5 SETUP FAILED: expected ok creating the canonical row, got %', v_result;
    end if;

    -- "another device" sends the SECOND event for the same client under a
    -- DIFFERENT (stale/wrong) session id, with base_version=1 matching
    -- what it believes the canonical row's version to be after event 1.
    v_result := apply_session_event(
      v_event_5b, v_session_b_stale, v_festival_id, v_client_b, 'festival',
      'step_saved', 'Distance', 'Distance',
      jsonb_build_object('distance', jsonb_build_object('rightUnaided', jsonb_build_object('lineReached',6), 'leftUnaided', jsonb_build_object('lineReached',6), 'hasGlasses', false, 'ownGlasses', null)),
      v_device_id, 1, now(), null
    );
    if v_result->>'status' <> 'ok' then
      raise exception 'TEST 5 FAILED: expected the remapped event to succeed structurally (ok or a real conflict), got %', v_result;
    end if;

    select count(*) into v_client_sessions_count from client_sessions
      where festival_id = v_festival_id and client_id = v_client_b;
    if v_client_sessions_count <> 1 then
      raise exception 'TEST 5 FAILED: expected exactly 1 client_sessions row for (festival, client_b), got %', v_client_sessions_count;
    end if;

    if not exists (select 1 from session_events where id = v_event_5b and session_id = v_session_b_real) then
      raise exception 'TEST 5 FAILED: the remapped event must be recorded against the REAL canonical session id, not the stale one';
    end if;

    if exists (select 1 from client_sessions where id = v_session_b_stale) then
      raise exception 'TEST 5 FAILED: no row should ever have been created under the stale/wrong session id';
    end if;

    raise notice 'TEST 5 PASSED: second event under a different/stale session id for an already-registered client -> no raw error, no duplicate client_sessions row, event recorded against the real canonical row';
  end;

  raise notice 'ALL 5 TESTS PASSED';
end;
$$;

rollback;
