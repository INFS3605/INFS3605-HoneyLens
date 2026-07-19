/*
  002_fix_session_event_version_baseline.sql

  Additive fix on top of 001_ooxii_backend.sql — does not edit or re-run
  that file, only replaces apply_session_event() with a corrected body via
  `create or replace function` (same name, same argument list, same
  return type — Postgres keeps existing GRANT/REVOKE privileges across a
  CREATE OR REPLACE with an identical signature; the grants at the bottom
  of this file are reissued anyway, explicitly, so this migration is fully
  self-contained and safe to reason about on its own).

  Root cause fixed (confirmed via live trace, not guessed — see the
  conversation this migration was written from):

  1. VERSION-BASELINE OFF-BY-ONE (the bug that left session_events at 0
     rows for every brand-new client):
       - A new local client session always starts at version 1
         (index.html) and computes its first event's base_version as
         session.version - 1 = 0.
       - The OLD apply_session_event() created a brand-new client_sessions
         row using the table's default `version = 1` and then compared
         incoming base_version (0) against that (1) — a false
         'version_mismatch' conflict, EVERY time, before session_events
         was ever inserted.
       - Fixed by making `version` count APPLIED events: a session with
         zero events applied is version 0, so a new row is now created
         with version = 0 explicitly (not the table default of 1 — the
         table default is left untouched, per the instruction to prefer a
         narrow fix over a global one). The first event's base_version=0
         now legitimately matches. Applying it increments the row to
         version 1, exactly as every subsequent event already did (this
         part of the logic was never broken).

  2. UNIQUE-CONSTRAINT GAP (a separate, real, currently-live gap — not
     necessarily the primary cause of THIS symptom, but a genuine risk):
       - client_sessions has both a primary key (id) and a separate
         unique(festival_id, client_id) constraint.
       - The old insert's `on conflict (id) do nothing` only ever guarded
         the primary key. If two different session ids were ever used for
         the same (festival_id, client_id) — e.g. a device whose local
         sessionServerId was generated before it ever learned the real
         canonical id — the insert would raise an UNCAUGHT Postgres
         23505 unique_violation, which PostgREST maps to a raw HTTP 409,
         bypassing this function's own structured conflict responses
         entirely (the client's pushEvent() would treat that as a
         transient network error, not a real conflict).
       - Fixed by looking up any existing row for (festival_id, client_id)
         BEFORE attempting the insert, and — if one exists — adopting its
         canonical id instead of trying to create a second row. This
         self-heals a stale/wrong local session id onto the real
         canonical row rather than erroring, and the client already
         adopts whatever id comes back in the response
         (applyServerSnapshot() in js/sync-service.js sets
         _serverId = serverRow.id from every successful/ conflict response
         session), so no client-side change was needed for this to work.

  Everything else in apply_session_event() — the duplicate-event-id
  idempotency check, the finalised-session guard, the version check for
  EXISTING sessions, the out-of-order-step guard, the event insert, the
  canonical snapshot merge + version increment, and the Honey Rewards
  award — is copied over unchanged in intent; only the identifiers noted
  above (v_session_id in place of the raw p_session_id parameter, once a
  session may have been remapped onto a different canonical row) changed.
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
  --    A brand-new row starts at version 0, not the table default of 1 —
  --    version counts APPLIED events, so zero events applied is version 0,
  --    matching a first event's base_version of 0. See file header.
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
      values (p_session_id, p_client_id, p_festival_id, p_mode, 'Draft', 0, auth.uid(), auth.uid(), now())
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
