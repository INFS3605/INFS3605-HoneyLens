/*
  005_fill_null_only_merge.sql

  Additive fix on top of 001-004 — does not edit any of them, only
  replaces apply_session_event() again via `create or replace function`
  (same signature; grants reissued below, same as every prior migration).

  Two problems this addresses, both confirmed via live sync_conflicts data:

  1. AUDIT-METADATA FALSE CONFLICTS. wheel/paddle/dispense payloads carry
     deviceId/testerId/recordedAt/completedAt alongside their clinical
     values. A QR handover's compact encoding (compactResultsFor() /
     expandResults() in index.html) never round-trips those three fields —
     confirmed live: a qr_imported paddle payload was clinically identical
     to canonical but structurally different (missing deviceId/testerId/
     recordedAt), so 004's already_applied check correctly-but-unhelpfully
     saw it as "different" and filed a real conflict. Fixed by stripping
     those known audit-only keys from wheel/paddle/dispense before
     comparing — distance/near/exit never carry that metadata, so they're
     compared as full objects, unchanged from 004.

  2. GENUINE NEW DATA REJECTED FOR A STALE VERSION NUMBER. Two confirmed-
     live cases (a Wheel step_saved event, and an early QR snapshot) supply
     real clinical data for fields that are still null on the canonical row
     at the moment they're processed — but because something else (a
     different device's event, or a later QR snapshot) reached the version
     number they were waiting for first, they version-mismatch even though
     nothing actually disagrees. Fixed with a STRICT fill-null-only merge:
     for every field the event supplies, classify it as identical (matches
     canonical), fillable (canonical is null/absent, incoming is real
     data), or conflicting (canonical is non-null and differs). If even one
     field conflicts, the WHOLE event is rejected as a genuine conflict —
     no partial merge, ever. Only when there are zero conflicting fields
     AND at least one fillable field does this merge proceed, and even
     then it only ever fills currently-empty fields — it never overwrites
     an existing non-null canonical value, regardless of what the event's
     stale base_version implied about its "authority" to do so.

  Three-way result from the version-mismatch branch (was two-way in 004):
    - 'already_applied'      — no new information; unchanged from 004.
    - 'merged_missing_fields' — new: real data filled into currently-empty
      fields only; session_events row inserted; version incremented once;
      routing (current_required_step/station) recomputed; Honey Rewards
      awarded exactly as a normal successful event would be.
    - 'conflict'              — unchanged: a real disagreement, filed to
      sync_conflicts for coordinator review, canonical data untouched.

  Safety boundaries (deliberately never touched by this merge, matching
  the instruction this migration was written from):
    - identity/ownership columns (festival_id, client_id, id, created_by,
      last_modified_by's SOURCE is always auth.uid(), never payload-
      supplied) were never part of the payload-driven merge set to begin
      with — nothing new needed here.
    - `status` is compared (a genuinely differing status is still a real
      conflict) but is NEVER written by the fill-merge branch, even in
      principle — hardcoded unchanged in that branch's UPDATE, so this
      path can never finalise, reopen, or otherwise transition a session's
      status. finalised_at likewise never changes in this branch.
    - `version` only ever exists as the monotonic canonical counter; this
      merge increments it exactly once per successful merge, same as a
      normal apply — it is never itself a mergeable/fillable field.
    - An empty jsonb object ({}) is never treated as real clinical data —
      neither as something worth filling canonical with, nor as something
      that blocks a fill (a canonical {} is treated the same as canonical
      null for fill purposes).

  Also deliberately skips the out-of-order-step guard (step 8) for a
  merge, same as it already does for already_applied and duplicate_ok —
  a merge's entire premise is "this event's ordering assumption was
  already stale," so re-validating linear step order against it doesn't
  add a meaningful safety check on top of the field-level conflict
  detection above (not specified in the instructions this migration was
  written from; flagging the design choice explicitly here).
*/

create or replace function apply_session_event(
  p_event_id uuid,
  p_session_id uuid,
  p_festival_id uuid,
  p_client_id text,
  p_mode text,
  p_event_type text,
  p_step text,
  p_station text,
  p_payload jsonb,
  p_device_id uuid,
  p_base_version integer,
  p_client_timestamp timestamptz,
  p_sync_batch_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session client_sessions;
  v_existing_event session_events;
  v_new_version integer;
  v_next_step text;
  v_required_station text;
  v_honey_types text[] := array['registration','step_saved','dispense_completed','exit_completed','admin_task'];
  v_reward_type text;
  v_festival_tz text;
  -- The canonical client_sessions.id this event is actually applied
  -- against. Usually equal to p_session_id; differs only when p_session_id
  -- was stale and an existing row was found by (festival_id, client_id)
  -- instead (see step 5) — every downstream reference to "this session's
  -- id" uses this variable, never the raw parameter, so a remap can never
  -- silently write against the wrong row or violate the session_events
  -- foreign key.
  v_session_id uuid;
  -- Per-field classification for a stale-version event (step 7) — see
  -- file header. v_any_conflict wins over v_any_fill if both are set for
  -- different fields (one real disagreement rejects the WHOLE event).
  v_any_conflict boolean;
  v_any_fill boolean;
  v_any_compared boolean;
  -- Audit-only keys stripped from wheel/paddle/dispense before comparing
  -- (never stripped from distance/near/exit — those never carry them).
  v_audit_keys text[] := array['deviceId','testerId','recordedAt','completedAt'];
begin
  -- 1. authenticated user with an active profile
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if not ooxii_is_active_profile() then
    raise exception 'INACTIVE_PROFILE' using errcode = '28000';
  end if;

  -- 2. festival membership
  if not ooxii_is_festival_member(p_festival_id) then
    raise exception 'NOT_A_FESTIVAL_MEMBER' using errcode = '42501';
  end if;

  -- 3. duplicate event id -> idempotent success, return current snapshot.
  --    Looked up via the event's OWN recorded session_id (not
  --    p_session_id) so a previously-remapped event (step 5) still
  --    resolves to the correct row on a duplicate re-send.
  select * into v_existing_event from session_events where id = p_event_id;
  if found then
    select * into v_session from client_sessions where id = v_existing_event.session_id;
    return jsonb_build_object('status', 'duplicate_ok', 'session', to_jsonb(v_session), 'version', v_session.version);
  end if;

  -- 4. station validation — waived for sessions created in individual mode
  --    (mirrors canActiveTesterOpenSession()'s isIndividualMode() bypass)
  if p_mode = 'festival' and p_station is not null then
    if not exists (
      select 1 from festival_members
      where festival_id = p_festival_id and user_id = auth.uid() and is_active = true
        and p_station = any(allowed_stations)
    ) then
      raise exception 'STATION_NOT_ALLOWED' using errcode = '42501';
    end if;
  end if;

  -- 5. lock the canonical row (create it on the first event for this session,
  --    for ANY event type — not just 'registration'). Offline QR handover
  --    means a later station's device can genuinely be the first one to ever
  --    reach the internet for a given client (the registering device may
  --    never reconnect at all); requiring 'registration' specifically would
  --    strand that session as SESSION_NOT_FOUND forever.
  --
  --    A brand-new row starts at version 1 — matching what the client's
  --    first-ever event actually sends as its base_version (every save
  --    function increments s.version BEFORE calling recordEvent(), so a
  --    session created at version:1 already reads as 2 by the time its
  --    first save computes base_version = session.version - 1 = 1).
  --
  --    Collision-safe against a stale/wrong local session id: if
  --    p_session_id doesn't match any row, check for an existing row under
  --    this (festival_id, client_id) BEFORE inserting — inserting a second
  --    row for an already-registered client would raise an uncaught
  --    unique_violation on unique(festival_id, client_id), since the
  --    insert's own ON CONFLICT only ever covers the id column. Adopting
  --    the existing canonical row instead means the event still applies
  --    successfully (or genuinely version-conflicts against the REAL
  --    current version) rather than surfacing a raw database error.
  --
  --    Race-safe against two devices creating the SAME id: if two devices
  --    race to insert the same id, the loser's insert is a no-op (on
  --    conflict (id) do nothing) and it simply re-selects the row the
  --    winner created.
  select * into v_session from client_sessions where id = p_session_id for update;
  if not found then
    select * into v_session from client_sessions
      where festival_id = p_festival_id and client_id = p_client_id for update;
    if not found then
      insert into client_sessions (id, client_id, festival_id, mode, status, version, created_by, last_modified_by, registered_at)
      values (p_session_id, p_client_id, p_festival_id, p_mode, 'Draft', 1, auth.uid(), auth.uid(), now())
      on conflict (id) do nothing;
      select * into v_session from client_sessions where id = p_session_id for update;
    end if;
  end if;
  v_session_id := v_session.id;

  -- 6. finalised sessions cannot be casually modified — only an
  --    administrator's explicit correction event may touch them again
  if v_session.status = 'Finalised' and p_event_type <> 'correction' then
    insert into sync_conflicts (session_id, local_event_id, server_version, local_base_version,
      server_data, incoming_data, conflict_type)
    values (v_session_id, p_event_id, v_session.version, p_base_version,
      to_jsonb(v_session), p_payload, 'finalised_session_changed');
    return jsonb_build_object('status', 'conflict', 'conflict_type', 'finalised_session_changed', 'session', to_jsonb(v_session));
  end if;

  -- 7. version check — never let older local data overwrite newer server
  --    data. Before treating a mismatch as a genuine conflict, classify
  --    every field THIS event actually supplies (present, non-null, and
  --    for jsonb fields not an empty object after stripping audit-only
  --    keys — see file header) as identical / fillable / conflicting
  --    against the canonical row. One conflicting field rejects the WHOLE
  --    event; zero conflicts and at least one fillable field merges just
  --    those empty fields in; zero conflicts and nothing fillable means
  --    every supplied field already matched exactly.
  if p_base_version is not null and p_base_version <> v_session.version then
    v_any_conflict := false;
    v_any_fill := false;
    v_any_compared := false;

    -- scalar text fields — no audit metadata, compared as-is
    if p_payload ? 'ageBand' and p_payload->>'ageBand' is not null then
      v_any_compared := true;
      if v_session.age_band is null then v_any_fill := true;
      elsif p_payload->>'ageBand' is distinct from v_session.age_band then v_any_conflict := true;
      end if;
    end if;
    if p_payload ? 'gender' and p_payload->>'gender' is not null then
      v_any_compared := true;
      if v_session.gender is null then v_any_fill := true;
      elsif p_payload->>'gender' is distinct from v_session.gender then v_any_conflict := true;
      end if;
    end if;
    if p_payload ? 'village' and p_payload->>'village' is not null then
      v_any_compared := true;
      if v_session.village is null then v_any_fill := true;
      elsif p_payload->>'village' is distinct from v_session.village then v_any_conflict := true;
      end if;
    end if;
    if p_payload ? 'cataract' and p_payload->>'cataract' is not null then
      v_any_compared := true;
      if v_session.cataract is null then v_any_fill := true;
      elsif p_payload->>'cataract' is distinct from v_session.cataract then v_any_conflict := true;
      end if;
    end if;
    -- status is compared (a genuine mismatch still conflicts) but is
    -- NEVER a target of the fill-merge — see file header safety
    -- boundaries. A fillable-only outcome for status is intentionally
    -- impossible in practice (the column is never null past row
    -- creation), but v_any_fill is deliberately not set here regardless,
    -- so this can never become the sole reason a merge is attempted.
    if p_payload ? 'status' and p_payload->>'status' is not null then
      v_any_compared := true;
      if v_session.status is not null and p_payload->>'status' is distinct from v_session.status then
        v_any_conflict := true;
      end if;
    end if;

    -- jsonb fields without audit metadata — compared as full objects,
    -- an empty object never counts as real incoming data or as a
    -- meaningfully-filled canonical value
    if p_payload ? 'distance' and p_payload->'distance' is not null and p_payload->'distance' <> '{}'::jsonb then
      v_any_compared := true;
      if v_session.distance is null or v_session.distance = '{}'::jsonb then v_any_fill := true;
      elsif p_payload->'distance' is distinct from v_session.distance then v_any_conflict := true;
      end if;
    end if;
    if p_payload ? 'near' and p_payload->'near' is not null and p_payload->'near' <> '{}'::jsonb then
      v_any_compared := true;
      if v_session.near is null or v_session.near = '{}'::jsonb then v_any_fill := true;
      elsif p_payload->'near' is distinct from v_session.near then v_any_conflict := true;
      end if;
    end if;
    if p_payload ? 'exit' and p_payload->'exit' is not null and p_payload->'exit' <> '{}'::jsonb then
      v_any_compared := true;
      if v_session.exit_data is null or v_session.exit_data = '{}'::jsonb then v_any_fill := true;
      elsif p_payload->'exit' is distinct from v_session.exit_data then v_any_conflict := true;
      end if;
    end if;

    -- jsonb fields WITH audit metadata (deviceId/testerId/recordedAt/
    -- completedAt) — a QR's compact encoding never carries these, so
    -- they're stripped from both sides before comparing. The stripped
    -- result being empty means "no real clinical content", same as the
    -- empty-object rule above.
    if p_payload ? 'wheel' and p_payload->'wheel' is not null
       and ((p_payload->'wheel') - v_audit_keys) <> '{}'::jsonb then
      v_any_compared := true;
      if v_session.wheel is null or ((v_session.wheel) - v_audit_keys) = '{}'::jsonb then
        v_any_fill := true;
      elsif ((p_payload->'wheel') - v_audit_keys) is distinct from ((v_session.wheel) - v_audit_keys) then
        v_any_conflict := true;
      end if;
    end if;
    if p_payload ? 'paddle' and p_payload->'paddle' is not null
       and ((p_payload->'paddle') - v_audit_keys) <> '{}'::jsonb then
      v_any_compared := true;
      if v_session.paddle is null or ((v_session.paddle) - v_audit_keys) = '{}'::jsonb then
        v_any_fill := true;
      elsif ((p_payload->'paddle') - v_audit_keys) is distinct from ((v_session.paddle) - v_audit_keys) then
        v_any_conflict := true;
      end if;
    end if;
    if p_payload ? 'dispense' and p_payload->'dispense' is not null
       and ((p_payload->'dispense') - v_audit_keys) <> '{}'::jsonb then
      v_any_compared := true;
      if v_session.dispense is null or ((v_session.dispense) - v_audit_keys) = '{}'::jsonb then
        v_any_fill := true;
      elsif ((p_payload->'dispense') - v_audit_keys) is distinct from ((v_session.dispense) - v_audit_keys) then
        v_any_conflict := true;
      end if;
    end if;

    if v_any_conflict then
      -- one or more supplied fields genuinely disagree with a non-null
      -- canonical value — reject the WHOLE event, never a partial merge.
      insert into sync_conflicts (session_id, local_event_id, server_version, local_base_version,
        server_data, incoming_data, conflict_type)
      values (v_session_id, p_event_id, v_session.version, p_base_version,
        to_jsonb(v_session), p_payload, 'version_mismatch');
      return jsonb_build_object('status', 'conflict', 'conflict_type', 'version_mismatch', 'session', to_jsonb(v_session));
    end if;

    if v_any_fill then
      -- zero conflicts, at least one field fills a currently-empty
      -- canonical column — record the event, fill ONLY empty fields
      -- (coalesce(canonical, incoming) — canonical wins whenever it is
      -- already set, deliberately the reverse order from step 10's
      -- normal-path merge below), increment version once, recompute
      -- routing, award Honey exactly as a normal successful apply would.
      insert into session_events (id, session_id, festival_id, event_type, step, station, payload,
        device_id, user_id, base_version, client_timestamp, sync_batch_id)
      values (p_event_id, v_session_id, p_festival_id, p_event_type, p_step, p_station, p_payload,
        p_device_id, auth.uid(), p_base_version, p_client_timestamp, p_sync_batch_id)
      on conflict (id) do nothing;

      update client_sessions set
        age_band   = coalesce(age_band, p_payload->>'ageBand'),
        gender     = coalesce(gender, p_payload->>'gender'),
        village    = coalesce(village, p_payload->>'village'),
        cataract   = coalesce(cataract, p_payload->>'cataract'),
        distance   = coalesce(distance, p_payload->'distance'),
        near       = coalesce(near, p_payload->'near'),
        wheel      = coalesce(wheel, p_payload->'wheel'),
        paddle     = coalesce(paddle, p_payload->'paddle'),
        dispense   = coalesce(dispense, p_payload->'dispense'),
        exit_data  = coalesce(exit_data, p_payload->'exit'),
        -- status is NEVER written by a fill-merge — see file header.
        version    = version + 1,
        last_modified_by = auth.uid()
      where id = v_session_id
      returning * into v_session;

      v_next_step := ooxii_next_required_step(v_session);
      v_required_station := ooxii_required_station(v_session);
      update client_sessions
        set current_required_step = v_next_step, current_required_station = v_required_station
        where id = v_session_id
        returning * into v_session;

      if p_event_type = any(v_honey_types) then
        v_reward_type := case p_event_type
          when 'registration' then 'registration'
          when 'dispense_completed' then 'dispense_task'
          when 'exit_completed' then 'exit_task'
          when 'admin_task' then 'admin_task'
          else 'step_complete'
        end;
        select timezone into v_festival_tz from festivals where id = p_festival_id;
        insert into honey_events (user_id, festival_id, source_event_id, reward_type, amount, festival_local_date)
        values (auth.uid(), p_festival_id, p_event_id, v_reward_type, 1,
          (p_client_timestamp at time zone coalesce(v_festival_tz, 'Pacific/Efate'))::date)
        on conflict (source_event_id) do nothing;
      end if;

      return jsonb_build_object('status', 'merged_missing_fields', 'session', to_jsonb(v_session), 'version', v_session.version);
    end if;

    if v_any_compared then
      -- every supplied field matched canonical exactly — same
      -- information arriving a second time under a different event id.
      return jsonb_build_object('status', 'already_applied', 'session', to_jsonb(v_session), 'version', v_session.version);
    end if;

    -- nothing comparable was supplied at all — cannot safely classify;
    -- fall back to a genuine conflict rather than silently accepting an
    -- event with no real content (matches 004's original fallback).
    insert into sync_conflicts (session_id, local_event_id, server_version, local_base_version,
      server_data, incoming_data, conflict_type)
    values (v_session_id, p_event_id, v_session.version, p_base_version,
      to_jsonb(v_session), p_payload, 'version_mismatch');
    return jsonb_build_object('status', 'conflict', 'conflict_type', 'version_mismatch', 'session', to_jsonb(v_session));
  end if;

  -- 8. reject out-of-order clinical steps (registration/correction events skip this)
  if p_event_type not in ('registration','correction','qr_produced','qr_imported','admin_task') then
    v_next_step := ooxii_next_required_step(v_session);
    if p_step is not null and p_step <> v_next_step then
      insert into sync_conflicts (session_id, local_event_id, server_version, local_base_version,
        server_data, incoming_data, conflict_type)
      values (v_session_id, p_event_id, v_session.version, p_base_version,
        to_jsonb(v_session), p_payload, 'same_step_diff_values');
      return jsonb_build_object('status', 'sequence_error', 'expected_step', v_next_step, 'session', to_jsonb(v_session));
    end if;
  end if;

  -- 9. insert the immutable event (idempotent on id, belt-and-braces)
  insert into session_events (id, session_id, festival_id, event_type, step, station, payload,
    device_id, user_id, base_version, client_timestamp, sync_batch_id)
  values (p_event_id, v_session_id, p_festival_id, p_event_type, p_step, p_station, p_payload,
    p_device_id, auth.uid(), p_base_version, p_client_timestamp, p_sync_batch_id)
  on conflict (id) do nothing;

  -- 10. merge payload into the canonical snapshot
  v_new_version := v_session.version + 1;
  update client_sessions set
    age_band   = coalesce(p_payload->>'ageBand', age_band),
    gender     = coalesce(p_payload->>'gender', gender),
    village    = coalesce(p_payload->>'village', village),
    cataract   = coalesce(p_payload->>'cataract', cataract),
    distance   = coalesce(p_payload->'distance', distance),
    near       = coalesce(p_payload->'near', near),
    wheel      = coalesce(p_payload->'wheel', wheel),
    paddle     = coalesce(p_payload->'paddle', paddle),
    dispense   = coalesce(p_payload->'dispense', dispense),
    exit_data  = coalesce(p_payload->'exit', exit_data),
    status     = coalesce(p_payload->>'status', status),
    version    = v_new_version,
    last_modified_by = auth.uid(),
    finalised_at = case when p_payload->>'status' = 'Finalised' then now() else finalised_at end
  where id = v_session_id
  returning * into v_session;

  v_next_step := ooxii_next_required_step(v_session);
  v_required_station := ooxii_required_station(v_session);
  update client_sessions
    set current_required_step = v_next_step, current_required_station = v_required_station
    where id = v_session_id
    returning * into v_session;

  -- 11. honey — participation only, never clinical outcomes; idempotent via
  --     unique(source_event_id) so a duplicate-processed event never double-awards
  if p_event_type = any(v_honey_types) then
    v_reward_type := case p_event_type
      when 'registration' then 'registration'
      when 'dispense_completed' then 'dispense_task'
      when 'exit_completed' then 'exit_task'
      when 'admin_task' then 'admin_task'
      else 'step_complete'
    end;
    select timezone into v_festival_tz from festivals where id = p_festival_id;
    insert into honey_events (user_id, festival_id, source_event_id, reward_type, amount, festival_local_date)
    values (auth.uid(), p_festival_id, p_event_id, v_reward_type, 1,
      (p_client_timestamp at time zone coalesce(v_festival_tz, 'Pacific/Efate'))::date)
    on conflict (source_event_id) do nothing;
  end if;

  return jsonb_build_object('status', 'ok', 'session', to_jsonb(v_session), 'version', v_session.version);
end;
$$;

-- Reissued explicitly (not just relied on as preserved-by-default) so this
-- migration is self-contained: only the RPC caller (authenticated,
-- through this SECURITY DEFINER function) may execute it — never PUBLIC,
-- and never direct table access, exactly as 001 established.
revoke all on function apply_session_event from public;
grant execute on function apply_session_event to authenticated;
