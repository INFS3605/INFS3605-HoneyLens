/*
  005_fill_null_only_merge_test.sql — manual acceptance test for
  supabase/migrations/005_fill_null_only_merge.sql.

  NOT a migration — do not put this file in supabase/migrations/. Safe to
  run against the real project: everything happens inside one transaction
  and is rolled back at the end.

  Reuses YOUR real, already-existing auth user (johnsmith@gmail.com,
  69511db0-d390-47b2-b35a-224df2d6228e) — same pattern as the earlier test
  files on this branch.

  All five interesting events in this file are submitted with a
  deliberately stale base_version (1) so every one of them exercises the
  step-7 classify-and-decide path (already_applied / merged_missing_fields
  / conflict) rather than the normal same-version path — this is
  deliberate: that's exactly the real-world path a QR-relayed or a
  racing-device event takes, and it's the only path this migration
  changes. Sequence order (step 8) is never at issue here — merges and
  already_applied both bypass it by design, same as duplicate_ok.
*/

begin;

do $$
declare
  v_user_id uuid := '69511db0-d390-47b2-b35a-224df2d6228e'; -- johnsmith@gmail.com — real, already-existing auth user
  v_festival_id uuid := gen_random_uuid();
  v_device_id uuid := gen_random_uuid();
  v_client_a text := 'Z96-Z';
  v_session_a uuid := gen_random_uuid();
  v_result jsonb;
  v_conflicts_before int;
  v_conflicts_after int;

  v_event_reg uuid := gen_random_uuid();
  v_event_distance uuid := gen_random_uuid();
  v_event_near uuid := gen_random_uuid();
  v_event_paddle_fill uuid := gen_random_uuid();
  v_event_paddle_identical uuid := gen_random_uuid();
  v_event_wheel_fill uuid := gen_random_uuid();
  v_event_wheel_conflict uuid := gen_random_uuid();
  v_event_mixed_fill uuid := gen_random_uuid();
  v_event_mixed_conflict uuid := gen_random_uuid();

  -- Full-fidelity paddle (as a real direct save would send it) vs. the
  -- same clinical content with audit metadata stripped (as a QR's compact
  -- encoding would relay it) — the exact real-world pair confirmed live.
  v_paddle_full jsonb := '{"notes":"","ageBand":"45-59","selectedPower":"+0.75","suggestedPower":null,"suggestionNote":"No confirmed automatic suggestion","clientPreference":"+0.75","preferenceOverrodeSuggestion":true,"deviceId":"PADDLE-01","testerId":"69511DB0","recordedAt":"10:26"}'::jsonb;
  v_paddle_clinical_only jsonb := '{"notes":"","ageBand":"45-59","selectedPower":"+0.75","suggestedPower":null,"suggestionNote":"No confirmed automatic suggestion","clientPreference":"+0.75","preferenceOverrodeSuggestion":true}'::jsonb;

  v_wheel_1 jsonb := '{"pd":52,"left":{"bestLens":"Sphere -6.00","lensType":"Minus","spherePower":"-6.00","visionImproved":true,"colourTestResult":"Green","canReadLine9OrSmaller":true},"right":{"bestLens":"Sphere -6.00","lensType":"Plus","spherePower":"-6.00","visionImproved":true,"colourTestResult":"Green","canReadLine9OrSmaller":true},"deviceId":"WHEEL-01","testerId":"69511DB0","recordedAt":"10:26"}'::jsonb;
  v_wheel_2_different jsonb := '{"pd":60,"left":{"bestLens":"Sphere -6.00","lensType":"Minus","spherePower":"-6.00","visionImproved":true,"colourTestResult":"Green","canReadLine9OrSmaller":true},"right":{"bestLens":"Sphere -6.00","lensType":"Plus","spherePower":"-6.00","visionImproved":true,"colourTestResult":"Green","canReadLine9OrSmaller":true},"deviceId":"WHEEL-01","testerId":"69511DB0","recordedAt":"10:40"}'::jsonb;

  v_distance_1 jsonb := '{"hasGlasses":false,"ownGlasses":null,"leftUnaided":{"logmar":0.76,"lineReached":2,"bonusLetters":2},"rightUnaided":{"logmar":0.76,"lineReached":2,"bonusLetters":2}}'::jsonb;
  v_near_1 jsonb := '{"unaided":{"logmar":0.9,"lineReached":3,"bonusLetters":0},"hasReading":false,"ownGlasses":null}'::jsonb;
  v_exit_1 jsonb := '{"counsellingDone":true,"glassesDispensed":false}'::jsonb;
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
  -- SETUP: Registration -> Distance -> Near, normal sequential saves,
  -- bringing the canonical row to version 4 with wheel/paddle/exit still
  -- null — the baseline every test below builds on.
  -- ============================================================
  v_result := apply_session_event(
    v_event_reg, v_session_a, v_festival_id, v_client_a, 'festival',
    'registration', 'Registration', 'Registration',
    jsonb_build_object('ageBand','45-59','gender','Female','village','Port Vila','cataract','No','status','In Progress'),
    v_device_id, 1, now(), null
  );
  if v_result->>'status' <> 'ok' or (v_result->>'version')::int <> 2 then
    raise exception 'SETUP FAILED: registration expected ok/version=2, got %', v_result;
  end if;

  v_result := apply_session_event(
    v_event_distance, v_session_a, v_festival_id, v_client_a, 'festival',
    'step_saved', 'Distance', 'Distance',
    jsonb_build_object('distance', v_distance_1),
    v_device_id, 2, now(), null
  );
  if v_result->>'status' <> 'ok' or (v_result->>'version')::int <> 3 then
    raise exception 'SETUP FAILED: distance expected ok/version=3, got %', v_result;
  end if;

  v_result := apply_session_event(
    v_event_near, v_session_a, v_festival_id, v_client_a, 'festival',
    'step_saved', 'Near', 'Distance',
    jsonb_build_object('near', v_near_1),
    v_device_id, 3, now(), null
  );
  if v_result->>'status' <> 'ok' or (v_result->>'version')::int <> 4 then
    raise exception 'SETUP FAILED: near expected ok/version=4, got %', v_result;
  end if;

  -- Populate canonical paddle (full fidelity, as a real direct save would
  -- send it) via a stale/merge submission — paddle is currently null, so
  -- this is itself an exercise of the fill path, and gives TEST 1
  -- something realistic to compare against.
  v_result := apply_session_event(
    v_event_paddle_fill, v_session_a, v_festival_id, v_client_a, 'festival',
    'step_saved', 'Paddle', 'Paddle',
    jsonb_build_object('paddle', v_paddle_full, 'status', 'In Progress'),
    v_device_id, 1, now(), null  -- deliberately stale vs. current version 4
  );
  if v_result->>'status' <> 'merged_missing_fields' or (v_result->>'version')::int <> 5 then
    raise exception 'SETUP FAILED: expected the initial paddle fill to succeed at version 5, got %', v_result;
  end if;

  -- ============================================================
  -- TEST 1: audit-only false conflict — canonical paddle has the full
  -- payload (with deviceId/testerId/recordedAt); incoming QR-relayed
  -- paddle has the exact same clinical values but lacks those three
  -- fields. Must be already_applied, not a conflict.
  -- ============================================================
  select count(*) into v_conflicts_before from sync_conflicts where session_id = v_session_a;
  v_result := apply_session_event(
    v_event_paddle_identical, v_session_a, v_festival_id, v_client_a, 'festival',
    'qr_imported', 'QRImport', 'Dispense',
    jsonb_build_object('paddle', v_paddle_clinical_only, 'status', 'In Progress'),
    v_device_id, 1, now(), null  -- stale vs. current version 5
  );
  if v_result->>'status' <> 'already_applied' then
    raise exception 'TEST 1 FAILED: expected already_applied, got %', v_result;
  end if;
  if (v_result->>'version')::int <> 5 then
    raise exception 'TEST 1 FAILED: expected version to remain 5, got %', v_result->>'version';
  end if;
  select count(*) into v_conflicts_after from sync_conflicts where session_id = v_session_a;
  if v_conflicts_after <> v_conflicts_before then
    raise exception 'TEST 1 FAILED: expected no new sync_conflicts row';
  end if;
  raise notice 'TEST 1 PASSED: audit-metadata-only difference on paddle -> already_applied, no conflict row';

  -- ============================================================
  -- TEST 2: canonical wheel is null; incoming stale Wheel event has real
  -- data -> merged_missing_fields, wheel filled, version increments once,
  -- event row inserted.
  -- ============================================================
  v_result := apply_session_event(
    v_event_wheel_fill, v_session_a, v_festival_id, v_client_a, 'festival',
    'step_saved', 'Wheel', 'Wheel',
    jsonb_build_object('wheel', v_wheel_1, 'status', 'In Progress'),
    v_device_id, 1, now(), null  -- stale vs. current version 5
  );
  if v_result->>'status' <> 'merged_missing_fields' then
    raise exception 'TEST 2 FAILED: expected merged_missing_fields, got %', v_result;
  end if;
  if (v_result->>'version')::int <> 6 then
    raise exception 'TEST 2 FAILED: expected version to become 6, got %', v_result->>'version';
  end if;
  if not exists (select 1 from client_sessions where id = v_session_a and wheel = v_wheel_1) then
    raise exception 'TEST 2 FAILED: canonical wheel was not filled with the incoming data';
  end if;
  if not exists (select 1 from session_events where id = v_event_wheel_fill and session_id = v_session_a) then
    raise exception 'TEST 2 FAILED: expected a session_events row for the merged wheel event';
  end if;
  raise notice 'TEST 2 PASSED: null canonical wheel -> merged_missing_fields, wheel filled, version 6, event row inserted';

  -- ============================================================
  -- TEST 3: canonical wheel now holds real (different) data; a second
  -- stale Wheel event with DIFFERING clinical values must be a genuine
  -- conflict, and canonical wheel must stay exactly as TEST 2 left it.
  -- ============================================================
  select count(*) into v_conflicts_before from sync_conflicts where session_id = v_session_a;
  v_result := apply_session_event(
    v_event_wheel_conflict, v_session_a, v_festival_id, v_client_a, 'festival',
    'step_saved', 'Wheel', 'Wheel',
    jsonb_build_object('wheel', v_wheel_2_different, 'status', 'In Progress'),
    v_device_id, 1, now(), null  -- stale vs. current version 6
  );
  if v_result->>'status' <> 'conflict' or v_result->>'conflict_type' <> 'version_mismatch' then
    raise exception 'TEST 3 FAILED: expected a structured version_mismatch conflict, got %', v_result;
  end if;
  select count(*) into v_conflicts_after from sync_conflicts where session_id = v_session_a;
  if v_conflicts_after <> v_conflicts_before + 1 then
    raise exception 'TEST 3 FAILED: expected exactly one new sync_conflicts row';
  end if;
  if not exists (select 1 from client_sessions where id = v_session_a and wheel = v_wheel_1) then
    raise exception 'TEST 3 FAILED: canonical wheel must remain unchanged (the TEST 2 value), never overwritten by a genuinely differing event';
  end if;
  raise notice 'TEST 3 PASSED: differing wheel data -> genuine conflict, canonical wheel untouched';

  -- ============================================================
  -- TEST 4: mixed event — one field (distance) identical to canonical,
  -- one field (exit) fills a currently-null canonical column, zero
  -- disagreements -> merge succeeds.
  -- ============================================================
  v_result := apply_session_event(
    v_event_mixed_fill, v_session_a, v_festival_id, v_client_a, 'festival',
    'qr_imported', 'QRImport', 'Exit',
    jsonb_build_object('distance', v_distance_1, 'exit', v_exit_1, 'status', 'In Progress'),
    v_device_id, 1, now(), null  -- stale vs. current version 6
  );
  if v_result->>'status' <> 'merged_missing_fields' then
    raise exception 'TEST 4 FAILED: expected merged_missing_fields, got %', v_result;
  end if;
  if (v_result->>'version')::int <> 7 then
    raise exception 'TEST 4 FAILED: expected version to become 7, got %', v_result->>'version';
  end if;
  if not exists (select 1 from client_sessions where id = v_session_a and distance = v_distance_1 and exit_data = v_exit_1) then
    raise exception 'TEST 4 FAILED: expected distance unchanged and exit_data filled with the incoming value';
  end if;
  raise notice 'TEST 4 PASSED: one identical field + one null-filling field, no disagreements -> merge succeeds';

  -- ============================================================
  -- TEST 5: mixed event — one field (distance) identical, one field
  -- (wheel) genuinely disagrees with non-null canonical data -> the
  -- WHOLE event must be rejected as a conflict, no partial merge.
  -- ============================================================
  select count(*) into v_conflicts_before from sync_conflicts where session_id = v_session_a;
  v_result := apply_session_event(
    v_event_mixed_conflict, v_session_a, v_festival_id, v_client_a, 'festival',
    'qr_imported', 'QRImport', 'Exit',
    jsonb_build_object('distance', v_distance_1, 'wheel', v_wheel_2_different, 'status', 'In Progress'),
    v_device_id, 1, now(), null  -- stale vs. current version 7
  );
  if v_result->>'status' <> 'conflict' or v_result->>'conflict_type' <> 'version_mismatch' then
    raise exception 'TEST 5 FAILED: expected a structured version_mismatch conflict, got %', v_result;
  end if;
  select count(*) into v_conflicts_after from sync_conflicts where session_id = v_session_a;
  if v_conflicts_after <> v_conflicts_before + 1 then
    raise exception 'TEST 5 FAILED: expected exactly one new sync_conflicts row';
  end if;
  if (select version from client_sessions where id = v_session_a) <> 7 then
    raise exception 'TEST 5 FAILED: canonical version must remain 7 — no partial merge despite distance matching';
  end if;
  if not exists (select 1 from client_sessions where id = v_session_a and wheel = v_wheel_1) then
    raise exception 'TEST 5 FAILED: canonical wheel must remain the TEST 2 value — the matching distance field must not cause any field to be merged';
  end if;
  raise notice 'TEST 5 PASSED: one matching field + one genuine disagreement -> whole event rejected, no partial merge';

  raise notice 'ALL 5 TESTS PASSED';
end;
$$;

rollback;
