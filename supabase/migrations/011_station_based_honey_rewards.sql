/*
  011_station_based_honey_rewards.sql

  Fixes the server-side counterpart of the tester-app Honey fix already
  shipped on this branch (index.html's awardStationHoney()/
  isStationResponsibilityComplete()). Root cause here was identical in
  spirit: apply_session_event() inserted one honey_events row per
  honey-eligible EVENT, not per physical STATION. Since Distance and Near
  are the same physical station (STEP_STATION.Near='Distance' client-side;
  ooxii_required_station() already mirrors this server-side, added in 001),
  a client passing through both created two 'step_complete' rows for one
  station visit. This migration makes the server award exactly once per
  (session, station, tester), matching the corrected client model exactly,
  using the SAME station mapping already established in 001
  (ooxii_next_required_step/ooxii_required_station) plus one new small
  mirror function for the raw step->station lookup.

  Additive only — does not edit 001-010. create or replace on
  apply_session_event() (same signature, same pattern every prior honey/
  conflict-logic migration has used), plus two ALTER TABLE ADD COLUMN
  statements and one backfill UPDATE on honey_events. No table is dropped,
  no row is deleted, no existing amount/reward_type/created_at value is
  changed by the backfill (it only fills two new, previously-nonexistent
  columns from data that's already sitting in session_events).

  ----------------------------------------------------------------------
  Why two new columns (session_id, station) instead of relying on
  source_event_id alone:

  The existing unique(source_event_id) constraint only proves "this exact
  event was never processed before" — it says nothing about whether a
  DIFFERENT event (Distance's own event vs Near's own event) represents
  the same physical station visit. Enforcing "one reward per (session,
  station, tester)" as a real database constraint requires the database
  to actually have session_id and station as columns on honey_events, not
  just derivable through a join to session_events every time. Both are
  cheap, safe additions: session_events already carries this exact data on
  every row (session_id directly, station via the step/station columns
  the client has sent since day one), so backfilling is a pure join, no
  guessed values.
  ----------------------------------------------------------------------

  Historical data: NOT deleted, NOT rewritten. Existing rows keep their
  original reward_type ('step_complete' for the old per-event-not-
  per-station model). The new unique index below is INTENTIONALLY a
  PARTIAL index scoped to reward_type IN ('registration','station_complete',
  'dispense_task') — it does not (and structurally cannot, since it would
  fail to create) apply to the old 'step_complete' rows, several of which
  are expected to already violate a per-station uniqueness rule by
  definition (that's the bug being fixed). See the diagnostic query at the
  bottom of this file to see exactly how many, run read-only, before
  deciding whether to separately clean them up later — nothing in this
  migration does that cleanup.

  admin_task is deliberately left completely untouched (no station
  concept, not part of the clinical station model, out of scope for this
  fix) — still dedup'd only by source_event_id, exactly as before.
*/

-- ============================================================================
-- 1. New columns on honey_events, backfilled from session_events (safe: only
--    adds data, never touches amount/reward_type/created_at/user_id/etc.)
-- ============================================================================
alter table honey_events add column if not exists session_id uuid references client_sessions(id);
alter table honey_events add column if not exists station text;

update honey_events he
set session_id = se.session_id,
    station    = se.station
from session_events se
where he.source_event_id = se.id
  and (he.session_id is null or he.station is null);

create index if not exists idx_honey_events_session_station on honey_events(session_id, station);

-- ============================================================================
-- 2. Widen reward_type to allow the new, station-aware value. Every
--    existing allowed value is kept — historical rows are never invalidated.
-- ============================================================================
alter table honey_events drop constraint if exists honey_events_reward_type_check;
alter table honey_events add constraint honey_events_reward_type_check check (reward_type in (
  'registration','handover','step_complete','station_complete','dispense_task','exit_task','admin_task'
));

-- ============================================================================
-- 3. Raw step -> station mirror (the direct equivalent of index.html's
--    STEP_STATION object) — deliberately NOT ooxii_required_station(),
--    which has a different job (the NEXT step's station, with a special
--    "terminal review station" case for when next_step='Complete') that
--    doesn't suit a plain "which station does THIS step belong to" lookup.
-- ============================================================================
create or replace function ooxii_step_station(p_step text)
returns text
language sql immutable
as $$
  select case p_step
    when 'Registration' then 'Registration'
    when 'Distance' then 'Distance'
    when 'Near' then 'Distance'
    when 'Wheel' then 'Wheel'
    when 'Paddle' then 'Paddle'
    when 'Dispense' then 'Dispense'
    when 'Exit' then 'Exit'
    else null
  end;
$$;

-- ============================================================================
-- 4. Database-enforced uniqueness: at most one station-based reward per
--    (session, station, tester) going forward. Partial index — scoped to
--    the new/unaffected-by-the-bug reward types only, see header comment
--    for why historical 'step_complete' rows are never checked against
--    this (some already legitimately violate it; that's exactly the
--    historical bug, not something this migration silently fixes).
-- ============================================================================
create unique index if not exists idx_honey_events_station_reward_once
  on honey_events(session_id, station, user_id)
  where reward_type in ('registration','station_complete','dispense_task')
    and session_id is not null and station is not null;

-- ============================================================================
-- 5. apply_session_event() — same signature as 001/002/003/004/005, only
--    the two honey-insertion blocks change (fill-merge branch and the
--    normal success branch) plus v_honey_types dropping 'exit_completed'.
--    Every other line is carried over unchanged from 005 — conflict
--    detection, version checking, fill-merge classification, sequence
--    validation, and the client_sessions/session_events writes themselves
--    are byte-for-byte the same logic, not touched by this fix.
-- ============================================================================
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
  -- 'exit_completed' removed: Exit is not a physical station (mirrors the
  -- tester app's confirmExit(), which no longer calls awardStationHoney()
  -- at all) — the Distance station's one reward for a route "none" client
  -- was already granted when Near (or Distance, if Near turns out not to
  -- be required) determined the route, via the station-completeness check
  -- below. An 'exit_completed' event reaching this function simply never
  -- attempts a honey_events insert now.
  v_honey_types text[] := array['registration','step_saved','dispense_completed','admin_task'];
  v_reward_type text;
  v_festival_tz text;
  v_session_id uuid;
  v_any_conflict boolean;
  v_any_fill boolean;
  v_any_compared boolean;
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
  select * into v_existing_event from session_events where id = p_event_id;
  if found then
    select * into v_session from client_sessions where id = v_existing_event.session_id;
    return jsonb_build_object('status', 'duplicate_ok', 'session', to_jsonb(v_session), 'version', v_session.version);
  end if;

  -- 4. station validation — waived for sessions created in individual mode
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
  --    for ANY event type — not just 'registration').
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

  -- 7. version check — fill-null-only merge classification (unchanged from 005)
  if p_base_version is not null and p_base_version <> v_session.version then
    v_any_conflict := false;
    v_any_fill := false;
    v_any_compared := false;

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
    if p_payload ? 'status' and p_payload->>'status' is not null then
      v_any_compared := true;
      if v_session.status is not null and p_payload->>'status' is distinct from v_session.status then
        v_any_conflict := true;
      end if;
    end if;

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
      insert into sync_conflicts (session_id, local_event_id, server_version, local_base_version,
        server_data, incoming_data, conflict_type)
      values (v_session_id, p_event_id, v_session.version, p_base_version,
        to_jsonb(v_session), p_payload, 'version_mismatch');
      return jsonb_build_object('status', 'conflict', 'conflict_type', 'version_mismatch', 'session', to_jsonb(v_session));
    end if;

    if v_any_fill then
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

      -- Honey: station-based, exactly once per (session, station, tester).
      -- v_next_step already reflects the state AFTER this event (computed
      -- just above), same as the client reading DE.getNextRequiredStep(s)
      -- right after mutating s — no separate recomputation needed.
      if p_event_type = any(v_honey_types) then
        if p_event_type = 'admin_task' then
          select timezone into v_festival_tz from festivals where id = p_festival_id;
          insert into honey_events (user_id, festival_id, source_event_id, session_id, station, reward_type, amount, festival_local_date)
          values (auth.uid(), p_festival_id, p_event_id, v_session_id, p_station, 'admin_task', 1,
            (p_client_timestamp at time zone coalesce(v_festival_tz, 'Pacific/Efate'))::date)
          on conflict (source_event_id) do nothing;
        elsif p_station is not null and (v_next_step = 'Complete' or ooxii_step_station(v_next_step) is distinct from p_station) then
          v_reward_type := case p_event_type
            when 'registration' then 'registration'
            when 'dispense_completed' then 'dispense_task'
            else 'station_complete'
          end;
          select timezone into v_festival_tz from festivals where id = p_festival_id;
          insert into honey_events (user_id, festival_id, source_event_id, session_id, station, reward_type, amount, festival_local_date)
          select auth.uid(), p_festival_id, p_event_id, v_session_id, p_station, v_reward_type, 1,
            (p_client_timestamp at time zone coalesce(v_festival_tz, 'Pacific/Efate'))::date
          where not exists (
            select 1 from honey_events he
            where he.session_id = v_session_id and he.station = p_station and he.user_id = auth.uid()
              and he.reward_type = any(array['registration','station_complete','dispense_task'])
          )
          on conflict (source_event_id) do nothing;
        end if;
      end if;

      return jsonb_build_object('status', 'merged_missing_fields', 'session', to_jsonb(v_session), 'version', v_session.version);
    end if;

    if v_any_compared then
      return jsonb_build_object('status', 'already_applied', 'session', to_jsonb(v_session), 'version', v_session.version);
    end if;

    insert into sync_conflicts (session_id, local_event_id, server_version, local_base_version,
      server_data, incoming_data, conflict_type)
    values (v_session_id, p_event_id, v_session.version, p_base_version,
      to_jsonb(v_session), p_payload, 'version_mismatch');
    return jsonb_build_object('status', 'conflict', 'conflict_type', 'version_mismatch', 'session', to_jsonb(v_session));
  end if;

  -- 8. reject out-of-order clinical steps
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

  -- 11. Honey: station-based, exactly once per (session, station, tester).
  --     See the fill-merge branch above for the identical logic + comment.
  if p_event_type = any(v_honey_types) then
    if p_event_type = 'admin_task' then
      select timezone into v_festival_tz from festivals where id = p_festival_id;
      insert into honey_events (user_id, festival_id, source_event_id, session_id, station, reward_type, amount, festival_local_date)
      values (auth.uid(), p_festival_id, p_event_id, v_session_id, p_station, 'admin_task', 1,
        (p_client_timestamp at time zone coalesce(v_festival_tz, 'Pacific/Efate'))::date)
      on conflict (source_event_id) do nothing;
    elsif p_station is not null and (v_next_step = 'Complete' or ooxii_step_station(v_next_step) is distinct from p_station) then
      v_reward_type := case p_event_type
        when 'registration' then 'registration'
        when 'dispense_completed' then 'dispense_task'
        else 'station_complete'
      end;
      select timezone into v_festival_tz from festivals where id = p_festival_id;
      insert into honey_events (user_id, festival_id, source_event_id, session_id, station, reward_type, amount, festival_local_date)
      select auth.uid(), p_festival_id, p_event_id, v_session_id, p_station, v_reward_type, 1,
        (p_client_timestamp at time zone coalesce(v_festival_tz, 'Pacific/Efate'))::date
      where not exists (
        select 1 from honey_events he
        where he.session_id = v_session_id and he.station = p_station and he.user_id = auth.uid()
          and he.reward_type = any(array['registration','station_complete','dispense_task'])
      )
      on conflict (source_event_id) do nothing;
    end if;
  end if;

  return jsonb_build_object('status', 'ok', 'session', to_jsonb(v_session), 'version', v_session.version);
end;
$$;

revoke all on function apply_session_event from public;
grant execute on function apply_session_event to authenticated;

/*
  ----------------------------------------------------------------------
  DIAGNOSTIC ONLY — read-only, changes nothing. Run this yourself in the
  Supabase SQL editor (before or after applying the migration above; it
  works either way since it joins through session_events directly rather
  than relying on the new backfilled columns) to see exactly how many
  historical rewards would be considered duplicates under the new
  per-station rule. This migration does NOT delete or merge any of them —
  that is a separate decision for you to make once you've seen the count.
  ----------------------------------------------------------------------

  select se.session_id, se.station, he.user_id, count(*) as reward_count,
         array_agg(he.id order by he.created_at) as honey_event_ids,
         array_agg(he.created_at order by he.created_at) as awarded_at
  from honey_events he
  join session_events se on se.id = he.source_event_id
  where he.reward_type = 'step_complete'
  group by se.session_id, se.station, he.user_id
  having count(*) > 1
  order by reward_count desc;
*/
