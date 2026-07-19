/*
  004_handle_identical_stale_events.sql

  (Filename note: the requesting instructions suggested 003_... but 003 is
  already taken by 003_correct_version_baseline_convention.sql on this
  branch — using 004 to stay additive rather than colliding with it.)

  Additive fix on top of 001/002/003 — does not edit any of them, only
  replaces apply_session_event() again via `create or replace function`
  (same signature; grants reissued below, same as every prior migration).

  Root cause this addresses (confirmed via live sync_conflicts data, not
  guessed — see the conversation this migration was written from): two
  independent, real mechanisms both legitimately produce a SECOND event
  carrying data that's already been applied under a different
  local_event_id:
    1. A qr_imported event never increments its own version (see
       003's header) — it reuses (sender's version - 1) as its
       base_version. If the sender's own event for that same change ALSO
       reaches the server (independently, e.g. because the sender
       reconnects), one of the two arrives second and version-mismatches,
       even though its payload is byte-identical to what's already
       canonical.
    2. Two same-origin tabs sharing one IndexedDB can each independently
       read the same pending_events snapshot and push the same logical
       (sometimes literally the same) event within milliseconds of each
       other — see 004... this file's sibling fix in js/sync-service.js
       (Web Locks) for the client-side half of this; this migration only
       makes the SERVER-side symptom (a spurious conflict for identical
       data) harmless.

  Fix: before filing a version_mismatch conflict, compare ONLY the fields
  this specific event's payload actually supplies (present AND non-null —
  the same presence test step 10's coalesce() already uses, so "supplies"
  here means exactly "would change something if applied") against the
  canonical row's corresponding columns. jsonb '=' is a structural/deep
  comparison in Postgres — key order is never significant, so no separate
  normalisation is needed for that. If every supplied field already
  matches, this is the same information arriving twice: return a new
  'already_applied' status (same shape as 'ok'/'duplicate_ok' — the
  current canonical session + version) instead of writing a sync_conflicts
  row. Genuinely differing incoming values are completely unaffected —
  they still file a real version_mismatch conflict, unchanged.

  Deliberately narrow: only applies to the version_mismatch branch (step
  7). The finalised-session guard (step 6) and the out-of-order-step guard
  (step 8) are untouched — those represent different failure classes
  (touching a locked-down record; violating sequencing) that "same data"
  doesn't make more acceptable. Never overwrites or deletes canonical data
  either way — an already_applied result changes nothing about the row; it
  only changes what's RETURNED to the caller and whether a conflict row
  gets written.
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
  -- Stale-but-identical detection (step 7) — see file header.
  v_identical boolean;
  v_compared_any boolean;
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

  -- 7. version check — never let older local data overwrite newer server data.
  --    Before treating a mismatch as a genuine conflict: if every field
  --    THIS event actually supplies (present and non-null — same test
  --    step 10's coalesce() uses) already matches the canonical row, this
  --    is the same information arriving a second time under a different
  --    event id, not a disagreement. jsonb equality is structural — key
  --    order never matters, no separate normalisation needed. See file
  --    header for the two confirmed real-world mechanisms that produce
  --    this (qr_imported's version convention; two tabs racing).
  if p_base_version is not null and p_base_version <> v_session.version then
    v_identical := true;
    v_compared_any := false;

    if p_payload ? 'ageBand' and p_payload->>'ageBand' is not null then
      v_compared_any := true;
      if p_payload->>'ageBand' is distinct from v_session.age_band then v_identical := false; end if;
    end if;
    if p_payload ? 'gender' and p_payload->>'gender' is not null then
      v_compared_any := true;
      if p_payload->>'gender' is distinct from v_session.gender then v_identical := false; end if;
    end if;
    if p_payload ? 'village' and p_payload->>'village' is not null then
      v_compared_any := true;
      if p_payload->>'village' is distinct from v_session.village then v_identical := false; end if;
    end if;
    if p_payload ? 'cataract' and p_payload->>'cataract' is not null then
      v_compared_any := true;
      if p_payload->>'cataract' is distinct from v_session.cataract then v_identical := false; end if;
    end if;
    if p_payload ? 'status' and p_payload->>'status' is not null then
      v_compared_any := true;
      if p_payload->>'status' is distinct from v_session.status then v_identical := false; end if;
    end if;
    if p_payload ? 'distance' and p_payload->'distance' is not null then
      v_compared_any := true;
      if p_payload->'distance' is distinct from v_session.distance then v_identical := false; end if;
    end if;
    if p_payload ? 'near' and p_payload->'near' is not null then
      v_compared_any := true;
      if p_payload->'near' is distinct from v_session.near then v_identical := false; end if;
    end if;
    if p_payload ? 'wheel' and p_payload->'wheel' is not null then
      v_compared_any := true;
      if p_payload->'wheel' is distinct from v_session.wheel then v_identical := false; end if;
    end if;
    if p_payload ? 'paddle' and p_payload->'paddle' is not null then
      v_compared_any := true;
      if p_payload->'paddle' is distinct from v_session.paddle then v_identical := false; end if;
    end if;
    if p_payload ? 'dispense' and p_payload->'dispense' is not null then
      v_compared_any := true;
      if p_payload->'dispense' is distinct from v_session.dispense then v_identical := false; end if;
    end if;
    if p_payload ? 'exit' and p_payload->'exit' is not null then
      v_compared_any := true;
      if p_payload->'exit' is distinct from v_session.exit_data then v_identical := false; end if;
    end if;

    if v_compared_any and v_identical then
      return jsonb_build_object('status', 'already_applied', 'session', to_jsonb(v_session), 'version', v_session.version);
    end if;

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
