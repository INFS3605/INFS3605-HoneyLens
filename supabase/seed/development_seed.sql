-- ============================================================================
-- OOXii HoneyLens — development/demo seed (OPTIONAL, local/dev projects only)
-- ============================================================================
-- Run 001_ooxii_backend.sql FIRST. Do not run this against a production
-- Supabase project with real festival data — it creates a demo festival and
-- assigns a tester to every station so you can exercise the whole app.
--
-- Step 1 — create the tester's login the safe way (never via raw SQL insert
-- into auth.users): Supabase Dashboard → Authentication → Users → Add user
-- (email + password, "Auto Confirm User" ON). Copy the generated User UID.
--
-- Step 2 — paste that UID below in place of 'PASTE-AUTH-USER-UUID-HERE' and
-- run the rest of this script in the SQL Editor.
-- ============================================================================

do $$
declare
  v_user_id uuid := 'PASTE-AUTH-USER-UUID-HERE'; -- from Authentication → Users
  v_festival_id uuid;
begin
  if v_user_id is null then
    raise exception 'Set v_user_id to a real auth.users id before running this seed.';
  end if;

  -- activate the tester profile (auto-created by the trigger on signup) and
  -- promote to coordinator so they can see the full roster while testing
  update profiles
    set is_active = true, app_role = 'coordinator', display_name = 'Demo Tester'
    where id = v_user_id;

  if not found then
    raise exception 'No profiles row for %. Did the user actually sign up / get created in Auth first?', v_user_id;
  end if;

  -- one demo festival
  insert into festivals (name, village, start_date, end_date, timezone, status, created_by)
  values ('Port Vila Demo Festival', 'Port Vila', current_date, current_date + 2, 'Pacific/Efate', 'active', v_user_id)
  returning id into v_festival_id;

  -- give the demo tester every station so they can walk the whole workflow
  insert into festival_members (festival_id, user_id, member_role, allowed_stations, is_active)
  values (v_festival_id, v_user_id, 'coordinator',
    array['Registration','Distance','Wheel','Paddle','Dispense','Exit'], true);

  raise notice 'Seeded festival % for user %', v_festival_id, v_user_id;
end $$;
