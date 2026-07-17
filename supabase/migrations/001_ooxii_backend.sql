-- ============================================================================
-- OOXii HoneyLens — backend migration
-- ============================================================================
-- Run this once in the Supabase SQL Editor (see SUPABASE_SETUP.md for the
-- full walkthrough). It is written to be safe to re-run: every object uses
-- IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS first.
--
-- This mirrors the CLINICAL decision engine already implemented in index.html
-- (DE.getNextRequiredStep / computeRoute / DISTANCE_PASS_LINE / NEAR_PASS_LINE)
-- for server-side sequence validation only. It does not re-implement LogMAR
-- display math — only the pass/fail thresholds needed to reject out-of-order
-- writes. See BACKEND_IMPLEMENTATION_PLAN.md §"Decision-engine mirror" for the
-- exact JS-to-SQL mapping.
--
-- Placeholder clinical mappings (Distance/Near thresholds, Wheel/Paddle
-- schemas) are NOT clinically validated OOXii production values — see
-- CLAUDE.md "Clinical decision engine" for the flagged assumptions.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- updated_at trigger helper
-- ----------------------------------------------------------------------------
create or replace function ooxii_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================================
-- profiles — authenticated OOXii testers
-- ============================================================================
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'OOXii tester',
  app_role text not null default 'tester' check (app_role in ('tester','coordinator','administrator')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_profiles_updated_at on profiles;
create trigger trg_profiles_updated_at
  before update on profiles
  for each row execute function ooxii_set_updated_at();

-- Controlled profile creation: there is no public sign-up screen in the app.
-- When an OOXii coordinator invites/creates a user in Supabase Auth (see
-- SUPABASE_SETUP.md), this trigger creates their profile automatically as
-- inactive-by-default-is NOT what we want for the very first admin, so we
-- default is_active = true here and coordinators deactivate testers who
-- should not have access — simplest safe default for a prototype with a
-- small, manually-managed tester roster.
create or replace function ooxii_handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_on_auth_user_created on auth.users;
create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function ooxii_handle_new_user();

-- ============================================================================
-- festivals
-- ============================================================================
create table if not exists festivals (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  village text,
  start_date date not null,
  end_date date not null,
  timezone text not null default 'Pacific/Efate',
  status text not null default 'planned' check (status in ('planned','active','completed','cancelled')),
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);

drop trigger if exists trg_festivals_updated_at on festivals;
create trigger trg_festivals_updated_at
  before update on festivals
  for each row execute function ooxii_set_updated_at();

-- ============================================================================
-- festival_members — connects testers to festivals + their allowed stations
-- ============================================================================
-- allowed_stations mirrors STATIONS in index.html: Registration, Distance,
-- Wheel, Paddle, Dispense, Exit. Near has no station of its own (tested at
-- Distance, per STEP_STATION.Near='Distance' — unchanged by this migration).
create table if not exists festival_members (
  id uuid primary key default gen_random_uuid(),
  festival_id uuid not null references festivals(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  member_role text not null default 'tester' check (member_role in ('tester','coordinator','administrator')),
  allowed_stations text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (festival_id, user_id),
  constraint festival_members_stations_valid check (
    allowed_stations <@ array['Registration','Distance','Wheel','Paddle','Dispense','Exit']::text[]
  )
);

drop trigger if exists trg_festival_members_updated_at on festival_members;
create trigger trg_festival_members_updated_at
  before update on festival_members
  for each row execute function ooxii_set_updated_at();

create index if not exists idx_festival_members_user on festival_members(user_id);
create index if not exists idx_festival_members_festival on festival_members(festival_id);

-- ============================================================================
-- devices — locally generated device UUIDs, not hardware fingerprints
-- ============================================================================
create table if not exists devices (
  id uuid primary key,                     -- client-generated (crypto.randomUUID())
  festival_id uuid references festivals(id) on delete set null,
  user_id uuid references profiles(id) on delete set null,
  label text,
  app_version text,
  last_seen_at timestamptz not null default now(),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_devices_user on devices(user_id);

-- ============================================================================
-- client_sessions — one canonical row per anonymous client session
-- ============================================================================
-- jsonb columns mirror the exact shape of session.distance / .near / .wheel /
-- .paddle / .dispense / .exit already used in index.html (see
-- BACKEND_IMPLEMENTATION_PLAN.md for the field-by-field mapping) so the
-- browser can round-trip a canonical row straight back into `state.sessions`.
create table if not exists client_sessions (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,                 -- anonymous ID, e.g. "A47-K"
  festival_id uuid not null references festivals(id),
  mode text not null default 'festival' check (mode in ('festival','individual')),
  status text not null default 'Draft',
  current_required_step text,
  current_required_station text,
  version integer not null default 1,
  age_band text,
  gender text,
  village text,
  cataract text,
  distance jsonb,
  near jsonb,
  wheel jsonb,
  paddle jsonb,
  dispense jsonb,
  exit_data jsonb,   -- named exit_data, not "exit" — EXIT is a PL/pgSQL control-flow keyword
  registered_at timestamptz,
  finalised_at timestamptz,
  created_by uuid references profiles(id),
  last_modified_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (festival_id, client_id),
  constraint client_sessions_id_format check (client_id ~ '^[A-Z][0-9]{2}-[A-Z]$')
);

drop trigger if exists trg_client_sessions_updated_at on client_sessions;
create trigger trg_client_sessions_updated_at
  before update on client_sessions
  for each row execute function ooxii_set_updated_at();

create index if not exists idx_client_sessions_festival on client_sessions(festival_id);
create index if not exists idx_client_sessions_status on client_sessions(festival_id, status);

-- ============================================================================
-- session_events — immutable audit + offline-sync event log
-- ============================================================================
-- id is CLIENT-GENERATED (crypto.randomUUID() at save time) so re-sending the
-- same event twice is naturally idempotent via "on conflict (id) do nothing"
-- inside apply_session_event() — never inserted twice.
create table if not exists session_events (
  id uuid primary key,
  session_id uuid not null references client_sessions(id),
  festival_id uuid not null references festivals(id),
  event_type text not null check (event_type in (
    'registration','step_saved','qr_produced','qr_imported',
    'dispense_completed','session_finalised','exit_completed',
    'admin_task','conflict_recorded','correction'
  )),
  step text,
  station text,
  payload jsonb not null default '{}'::jsonb,
  device_id uuid references devices(id),
  user_id uuid references profiles(id),
  base_version integer,
  client_timestamp timestamptz not null,
  server_timestamp timestamptz not null default now(),
  sync_batch_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_session_events_session on session_events(session_id);
create index if not exists idx_session_events_festival on session_events(festival_id);
create index if not exists idx_session_events_batch on session_events(sync_batch_id);

-- ============================================================================
-- honey_events — immutable participation ledger (never clinical outcomes)
-- ============================================================================
create table if not exists honey_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  festival_id uuid not null references festivals(id),
  source_event_id uuid not null references session_events(id),
  reward_type text not null check (reward_type in (
    'registration','handover','step_complete','dispense_task','exit_task','admin_task'
  )),
  amount integer not null default 1 check (amount > 0),
  festival_local_date date not null,
  created_at timestamptz not null default now(),
  unique (source_event_id)               -- the same event can never award Honey twice
);

create index if not exists idx_honey_events_user on honey_events(user_id, festival_local_date);

-- ============================================================================
-- sync_conflicts — unresolved conflicts, never silently overwritten
-- ============================================================================
create table if not exists sync_conflicts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references client_sessions(id),
  local_event_id uuid,
  server_version integer,
  local_base_version integer,
  server_data jsonb,
  incoming_data jsonb,
  conflict_type text not null check (conflict_type in (
    'version_mismatch','same_step_diff_values','finalised_session_changed','duplicate_id'
  )),
  resolution_status text not null default 'unresolved' check (resolution_status in (
    'unresolved','resolved_server_wins','resolved_local_wins','resolved_merged','resolved_manual'
  )),
  resolved_by uuid references profiles(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_sync_conflicts_session on sync_conflicts(session_id);
create index if not exists idx_sync_conflicts_status on sync_conflicts(resolution_status);

-- ============================================================================
-- Row Level Security — enabled on every application table
-- ============================================================================
alter table profiles          enable row level security;
alter table festivals         enable row level security;
alter table festival_members  enable row level security;
alter table devices           enable row level security;
alter table client_sessions   enable row level security;
alter table session_events    enable row level security;
alter table honey_events      enable row level security;
alter table sync_conflicts    enable row level security;

-- No anonymous access to anything, ever. Authenticated users only, and then
-- only what RLS policies below explicitly allow.
revoke all on profiles, festivals, festival_members, devices,
  client_sessions, session_events, honey_events, sync_conflicts
  from anon;
grant usage on schema public to authenticated;

-- ---- helper: is the current user an active profile? ----
create or replace function ooxii_is_active_profile()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and is_active = true
  );
$$;

-- ---- helper: is the current user an active member of this festival? ----
create or replace function ooxii_is_festival_member(p_festival_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from festival_members fm
    join profiles p on p.id = fm.user_id
    where fm.festival_id = p_festival_id
      and fm.user_id = auth.uid()
      and fm.is_active = true
      and p.is_active = true
  );
$$;

create or replace function ooxii_is_coordinator_or_admin(p_festival_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from festival_members fm
    where fm.festival_id = p_festival_id
      and fm.user_id = auth.uid()
      and fm.is_active = true
      and fm.member_role in ('coordinator','administrator')
  );
$$;

-- ---- profiles ----
drop policy if exists profiles_select_self on profiles;
create policy profiles_select_self on profiles
  for select to authenticated
  using (id = auth.uid());

drop policy if exists profiles_update_self on profiles;
create policy profiles_update_self on profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and app_role = (select app_role from profiles where id = auth.uid()));
  -- testers may edit their own display name but never self-promote app_role

grant select, update on profiles to authenticated;

-- ---- festivals: read-only for active members ----
drop policy if exists festivals_select_member on festivals;
create policy festivals_select_member on festivals
  for select to authenticated
  using (ooxii_is_active_profile() and ooxii_is_festival_member(id));

grant select on festivals to authenticated;

-- ---- festival_members: a tester can see their own memberships; ----
-- ---- coordinators/admins can see the full roster for their festival ----
drop policy if exists festival_members_select on festival_members;
create policy festival_members_select on festival_members
  for select to authenticated
  using (
    user_id = auth.uid()
    or ooxii_is_coordinator_or_admin(festival_id)
  );

grant select on festival_members to authenticated;
-- membership is managed by coordinators/admins via the Supabase dashboard or
-- SQL editor in this prototype — no self-service join, per "no public
-- registration" requirement.

-- ---- devices: a tester manages their own device rows ----
drop policy if exists devices_select_own on devices;
create policy devices_select_own on devices
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists devices_insert_own on devices;
create policy devices_insert_own on devices
  for insert to authenticated
  with check (user_id = auth.uid() and ooxii_is_active_profile());

drop policy if exists devices_update_own on devices;
create policy devices_update_own on devices
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update on devices to authenticated;

-- ---- client_sessions: read-only for active members of the festival ----
-- All WRITES happen exclusively through apply_session_event() (below), which
-- runs as SECURITY DEFINER — direct table writes are revoked from
-- `authenticated` so the browser can never bypass sequence/version checks.
drop policy if exists client_sessions_select_member on client_sessions;
create policy client_sessions_select_member on client_sessions
  for select to authenticated
  using (ooxii_is_active_profile() and ooxii_is_festival_member(festival_id));

grant select on client_sessions to authenticated;
revoke insert, update, delete on client_sessions from authenticated;

-- ---- session_events: read-only audit trail for festival members ----
drop policy if exists session_events_select_member on session_events;
create policy session_events_select_member on session_events
  for select to authenticated
  using (ooxii_is_active_profile() and ooxii_is_festival_member(festival_id));

grant select on session_events to authenticated;
revoke insert, update, delete on session_events from authenticated;
-- ordinary users cannot delete or edit audit events — writes only via the RPC.

-- ---- honey_events: a tester can read their own; coordinators/admins can ----
-- ---- read the whole festival's participation ledger ----
drop policy if exists honey_events_select on honey_events;
create policy honey_events_select on honey_events
  for select to authenticated
  using (
    user_id = auth.uid()
    or ooxii_is_coordinator_or_admin(festival_id)
  );

grant select on honey_events to authenticated;
revoke insert, update, delete on honey_events from authenticated;
-- Honey is never awarded directly by users — only by apply_session_event().

-- ---- sync_conflicts: festival members can read; only coordinators/admins ----
-- ---- can mark a conflict resolved (authorised correction) ----
drop policy if exists sync_conflicts_select on sync_conflicts;
create policy sync_conflicts_select on sync_conflicts
  for select to authenticated
  using (
    exists (
      select 1 from client_sessions cs
      where cs.id = sync_conflicts.session_id
        and ooxii_is_festival_member(cs.festival_id)
    )
  );

drop policy if exists sync_conflicts_resolve on sync_conflicts;
create policy sync_conflicts_resolve on sync_conflicts
  for update to authenticated
  using (
    exists (
      select 1 from client_sessions cs
      where cs.id = sync_conflicts.session_id
        and ooxii_is_coordinator_or_admin(cs.festival_id)
    )
  )
  with check (resolution_status <> 'unresolved' and resolved_by = auth.uid());

grant select, update on sync_conflicts to authenticated;
revoke insert, delete on sync_conflicts from authenticated;
-- conflicts are only ever inserted by apply_session_event(); never deleted.

-- ============================================================================
-- Decision-engine mirror (SQL) — thresholds + route table only.
-- Mirrors index.html: DISTANCE_PASS_LINE=7, NEAR_PASS_LINE=9, computeRoute(),
-- ROUTE_PATHS. Used ONLY to reject out-of-order writes server-side; the
-- browser's DE.* functions remain the single source of truth for the UI.
-- ============================================================================
create or replace function ooxii_distance_outcome(p_distance jsonb)
returns text
language plpgsql immutable
as $$
declare
  r_line int; l_line int;
begin
  if p_distance is null then return null; end if;
  r_line := (p_distance #>> '{rightUnaided,lineReached}')::int;
  l_line := (p_distance #>> '{leftUnaided,lineReached}')::int;
  if r_line is null or l_line is null then return null; end if;
  return case when r_line >= 7 and l_line >= 7 then 'pass' else 'fail' end;
exception when others then return null;
end;
$$;

create or replace function ooxii_near_outcome(p_near jsonb)
returns text
language plpgsql immutable
as $$
declare
  n_line int;
begin
  if p_near is null then return null; end if;
  n_line := (p_near #>> '{unaided,lineReached}')::int;
  if n_line is null then return null; end if;
  return case when n_line >= 9 then 'pass' else 'fail' end;
exception when others then return null;
end;
$$;

create or replace function ooxii_compute_route(p_distance jsonb, p_near jsonb)
returns text
language plpgsql immutable
as $$
declare
  d text := ooxii_distance_outcome(p_distance);
  n text := ooxii_near_outcome(p_near);
begin
  if d is null or n is null then return null; end if;
  if d = 'pass' and n = 'pass' then return 'none'; end if;
  if d = 'pass' and n = 'fail' then return 'paddle_only'; end if;
  if d = 'fail' and n = 'pass' then return 'wheel_only'; end if;
  return 'wheel_then_paddle';
end;
$$;

-- required step, mirroring DE.getNextRequiredStep — reads the same jsonb
-- completion signals the browser writes (rightUnaided/leftUnaided/hasGlasses/
-- ownGlasses for distance; unaided/hasReading/ownGlasses for near; pd+per-eye
-- fields for wheel; selectedPower for paddle; glassesDispensed for dispense;
-- counsellingDone for exit).
create or replace function ooxii_next_required_step(p_session client_sessions)
returns text
language plpgsql immutable
as $$
declare
  route text;
  wheel_done boolean;
  paddle_done boolean;
begin
  if p_session.age_band is null or p_session.gender is null or p_session.village is null or p_session.cataract is null then
    return 'Registration';
  end if;

  if not (
    p_session.distance #>> '{rightUnaided,lineReached}' is not null
    and p_session.distance #>> '{leftUnaided,lineReached}' is not null
    and p_session.distance ? 'hasGlasses'
    and (
      not (p_session.distance->>'hasGlasses')::boolean
      or p_session.distance #>> '{ownGlasses,lineReached}' is not null
    )
  ) then
    return 'Distance';
  end if;

  if not (
    p_session.near #>> '{unaided,lineReached}' is not null
    and p_session.near ? 'hasReading'
    and (
      not (p_session.near->>'hasReading')::boolean
      or p_session.near #>> '{ownGlasses,lineReached}' is not null
    )
  ) then
    return 'Near';
  end if;

  route := ooxii_compute_route(p_session.distance, p_session.near);
  if route is null then
    return 'Near'; -- defensive: should be unreachable once both pre-tests validate above
  end if;

  wheel_done  := (p_session.wheel   #>> '{right,lensType}') is not null and (p_session.wheel   #>> '{left,lensType}') is not null;
  paddle_done := (p_session.paddle  ->> 'selectedPower') is not null;

  if route = 'none' then
    if coalesce((p_session.exit_data->>'counsellingDone')::boolean, false) then return 'Complete'; end if;
    return 'Exit';
  elsif route = 'paddle_only' then
    if not paddle_done then return 'Paddle'; end if;
  elsif route = 'wheel_only' then
    if not wheel_done then return 'Wheel'; end if;
  else -- wheel_then_paddle
    if not wheel_done then return 'Wheel'; end if;
    if not paddle_done then return 'Paddle'; end if;
  end if;

  if coalesce((p_session.dispense->>'glassesDispensed')::boolean, false) then return 'Complete'; end if;
  return 'Dispense';
end;
$$;

create or replace function ooxii_required_station(p_session client_sessions)
returns text
language sql immutable
as $$
  select case ooxii_next_required_step(p_session)
    when 'Registration' then 'Registration'
    when 'Distance' then 'Distance'
    when 'Near' then 'Distance'
    when 'Wheel' then 'Wheel'
    when 'Paddle' then 'Paddle'
    when 'Dispense' then 'Dispense'
    when 'Exit' then 'Exit'
    when 'Complete' then case when ooxii_compute_route(p_session.distance, p_session.near) = 'none' then 'Exit' else 'Dispense' end
    else null
  end;
$$;

-- ============================================================================
-- apply_session_event — the ONLY way any clinical write reaches the server.
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
  v_route text;
  v_honey_types text[] := array['registration','step_saved','dispense_completed','exit_completed','admin_task'];
  v_reward_type text;
  v_festival_tz text;
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

  -- 3. duplicate event id -> idempotent success, return current snapshot
  select * into v_existing_event from session_events where id = p_event_id;
  if found then
    select * into v_session from client_sessions where id = p_session_id;
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
  --    strand that session as SESSION_NOT_FOUND forever. Race-safe: if two
  --    devices race to create the same row, the loser's insert is a no-op
  --    and it simply re-selects the row the winner created.
  select * into v_session from client_sessions where id = p_session_id for update;
  if not found then
    insert into client_sessions (id, client_id, festival_id, mode, status, created_by, last_modified_by, registered_at)
    values (p_session_id, p_client_id, p_festival_id, p_mode, 'Draft', auth.uid(), auth.uid(), now())
    on conflict (id) do nothing;
    select * into v_session from client_sessions where id = p_session_id for update;
  end if;

  -- 6. finalised sessions cannot be casually modified — only an
  --    administrator's explicit correction event may touch them again
  if v_session.status = 'Finalised' and p_event_type <> 'correction' then
    insert into sync_conflicts (session_id, local_event_id, server_version, local_base_version,
      server_data, incoming_data, conflict_type)
    values (p_session_id, p_event_id, v_session.version, p_base_version,
      to_jsonb(v_session), p_payload, 'finalised_session_changed');
    return jsonb_build_object('status', 'conflict', 'conflict_type', 'finalised_session_changed', 'session', to_jsonb(v_session));
  end if;

  -- 7. version check — never let older local data overwrite newer server data
  if p_base_version is not null and p_base_version <> v_session.version then
    insert into sync_conflicts (session_id, local_event_id, server_version, local_base_version,
      server_data, incoming_data, conflict_type)
    values (p_session_id, p_event_id, v_session.version, p_base_version,
      to_jsonb(v_session), p_payload, 'version_mismatch');
    return jsonb_build_object('status', 'conflict', 'conflict_type', 'version_mismatch', 'session', to_jsonb(v_session));
  end if;

  -- 8. reject out-of-order clinical steps (registration/correction events skip this)
  if p_event_type not in ('registration','correction','qr_produced','qr_imported','admin_task') then
    v_next_step := ooxii_next_required_step(v_session);
    if p_step is not null and p_step <> v_next_step then
      insert into sync_conflicts (session_id, local_event_id, server_version, local_base_version,
        server_data, incoming_data, conflict_type)
      values (p_session_id, p_event_id, v_session.version, p_base_version,
        to_jsonb(v_session), p_payload, 'same_step_diff_values');
      return jsonb_build_object('status', 'sequence_error', 'expected_step', v_next_step, 'session', to_jsonb(v_session));
    end if;
  end if;

  -- 9. insert the immutable event (idempotent on id, belt-and-braces)
  insert into session_events (id, session_id, festival_id, event_type, step, station, payload,
    device_id, user_id, base_version, client_timestamp, sync_batch_id)
  values (p_event_id, p_session_id, p_festival_id, p_event_type, p_step, p_station, p_payload,
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
  where id = p_session_id
  returning * into v_session;

  v_next_step := ooxii_next_required_step(v_session);
  v_required_station := ooxii_required_station(v_session);
  update client_sessions
    set current_required_step = v_next_step, current_required_station = v_required_station
    where id = p_session_id
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

revoke all on function apply_session_event from public;
grant execute on function apply_session_event to authenticated;

-- ============================================================================
-- done
-- ============================================================================
