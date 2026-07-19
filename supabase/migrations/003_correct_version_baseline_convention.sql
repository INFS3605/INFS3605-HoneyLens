/*
  003_correct_version_baseline_convention.sql

  Corrects a mistake in 002_fix_session_event_version_baseline.sql — does
  not edit that file, only replaces apply_session_event() again via
  `create or replace function` (same signature; grants reissued below,
  same as 002).

  What was wrong with 002, confirmed via live evidence (sync_conflicts for
  a real test client showed local_base_version 1, 2, 3, 4 against a
  server_version stuck at 0 forever — not the 0-vs-1 mismatch 002 assumed):

    002 assumed the client's first-ever event sends base_version=0,
    reasoning that a fresh local session starts at version:1 and
    base_version = session.version - 1. That's only true if recordEvent()
    reads session.version BEFORE it's incremented for this save. It
    doesn't — every save function in index.html (saveIntake, and the
    Distance/Near/Wheel/Paddle/Dispense/Exit saves, confirmed by grepping
    every `s.version++` call site) increments FIRST, then calls
    recordBackendEvent(). So for a session created at version:1, the
    FIRST save already bumps it to 2 before base_version is computed:
    base_version = 2 - 1 = 1, not 0. Each subsequent save follows the
    same pattern (base_version = N for the Nth save).

    002's fix (new rows start at version=0) therefore didn't remove the
    false conflict — it shifted it by exactly one: a new row's version=0
    still never matches the client's real first base_version of 1.

  The correct convention, matching what the client actually sends: a
  brand-new row (zero events applied) is version 1 — which is exactly
  what 001's original table default already was. The ORIGINAL bug that
  started this whole investigation was never a version-baseline mismatch
  at all; it was almost certainly the session-ID-instability bug fixed
  earlier on this branch (a fresh random session id generated per save,
  so the server never found the row it should have been comparing
  against). This migration's only change from 002 is the single literal
  in the new-row insert: 0 -> 1. 002's separate, still-valid fix (the
  unique(festival_id, client_id) self-heal, avoiding an uncaught
  unique_violation/raw HTTP 409) is unchanged and kept.

  Does NOT retroactively fix any row already created under 002's wrong
  version=0 default — that row is real, already-conflicted state, not
  something this migration should silently rewrite (matches the standing
  instruction to never auto-resolve or rewrite historical conflicts). A
  session stuck at version=0 from testing under 002 needs a fresh test
  client id, or a manual one-off correction if a coordinator specifically
  wants to keep that exact row.
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
  --    first save computes base_version = session.version - 1 = 1). See
  --    file header for the full correction from migration 002's mistaken
  --    version=0.
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

  -- 7. version check — never let older local data overwrite newer server data
  if p_base_version is not null and p_base_version <> v_session.version then
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
