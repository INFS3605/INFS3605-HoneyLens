# Supabase setup — exact steps

Your project (already configured in `js/config.js`, gitignored):
`https://pmfieolaynpukbkmbzsx.supabase.co`

## 1. Run the migration

1. Open your project → **SQL Editor** → **New query**.
2. Paste the entire contents of `supabase/migrations/001_ooxii_backend.sql`.
3. Run it. It's safe to re-run (every object uses `IF NOT EXISTS` /
   `CREATE OR REPLACE` / `DROP ... IF EXISTS` first).
4. Confirm no errors. You should now see these tables under **Table Editor**:
   `profiles`, `festivals`, `festival_members`, `devices`, `client_sessions`,
   `session_events`, `honey_events`, `sync_conflicts`.

## 2. Create the first tester account

Never insert directly into `auth.users` — use Supabase's own user creation:

1. **Authentication → Users → Add user**.
2. Enter an email and password, toggle **Auto Confirm User** ON (no email
   step needed for a prototype), create it.
3. Copy the generated **User UID** — you'll need it next.

A `profiles` row is created automatically for this user (via the
`ooxii_handle_new_user` trigger) with `is_active = true` and
`app_role = 'tester'` by default.

## 3. Create a festival and assign the tester

Easiest path: use `supabase/seed/development_seed.sql` —

1. Open it, replace `PASTE-AUTH-USER-UUID-HERE` with the User UID from step 2.
2. Run it in the SQL Editor. It:
   - activates that tester's profile and promotes them to `coordinator`
     (so they can see the full roster while testing),
   - creates one demo festival ("Port Vila Demo Festival"),
   - assigns them to every station (`Registration, Distance, Wheel, Paddle,
     Dispense, Exit`) so you can walk the entire workflow solo.

To do it by hand instead (e.g. for a second tester with only some stations):

```sql
insert into festivals (name, village, start_date, end_date, status, created_by)
values ('My Festival', 'Port Vila', current_date, current_date + 2, 'active',
  '<coordinator-user-uuid>')
returning id;  -- copy this festival id

insert into festival_members (festival_id, user_id, member_role, allowed_stations, is_active)
values ('<festival-id-from-above>', '<tester-user-uuid>', 'tester',
  array['Distance','Wheel'], true);
```

`allowed_stations` must be a subset of
`{Registration, Distance, Wheel, Paddle, Dispense, Exit}` (enforced by a CHECK
constraint) — there is no `Near` station; Near is tested at Distance, same as
the existing app.

## 4. Confirm Row Level Security

**Database → Tables** — every OOXii table should show a green "RLS enabled"
badge (the migration runs `alter table ... enable row level security` on
all eight). Then run the Security Advisor:

**Database → Advisors → Security Advisor → Run** — it should report no
"RLS disabled" issues for the OOXii tables. (It may flag the `public` schema's
default privileges on `pg_catalog`/`extensions` objects — those are
pre-existing Supabase defaults, unrelated to this migration.)

Spot-check from the browser console (should always fail, unauthenticated):

```js
window.OOXII_SUPABASE.from('client_sessions').select('*').then(r => console.log(r.error))
```

## 5. Test login locally

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000`, sign in with the email/password from step 2.
On success you'll be prompted to set a 4–8 digit **offline PIN** — this is
what unlocks the app for 30 days without internet; it is not your account
password and is never sent anywhere.

## 6. Deploy to Netlify

`js/config.js` is gitignored — Netlify's git-based deploy won't have it
unless you either:

- **(Recommended for this prototype)** remove `js/config.js` from
  `.gitignore` and commit it. The publishable key is not a secret — it's
  designed to be public; every table it can reach is gated by RLS — so this
  is the simplest option for a no-build static site.
- Or use Netlify's **Site settings → Build & deploy → Post processing →
  Snippet injection**, or manually upload `js/config.js` via **Deploys →
  Deploy manually** after each git-based deploy.

Either way, HTTPS is required for camera access (`getUserMedia`) — Netlify
serves everything over HTTPS by default, so real camera QR scanning will work
once deployed; it will NOT work over plain `http://` except on `localhost`.

## 7. Test offline operation

Chrome DevTools → **Network** tab → set to **Offline** (or **Application →
Service Workers → Offline**). Reload — you should land on the offline PIN
unlock screen if you've already signed in once and set a PIN; clinical work
already saved should still be visible (it's read from IndexedDB, not the
network). Go back online and either wait (auto-sync fires on the `online`
event) or press **Sync now** on the Sync screen.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Could not load your tester profile" at sign-in | The `ooxii_handle_new_user` trigger didn't fire, or `is_active=false`. Check `select * from profiles where id='<uuid>'`. |
| "You are not assigned to any festival yet" | No row in `festival_members` for that user, or `is_active=false` on it. |
| `relation "public.client_sessions" does not exist` | The migration hasn't been run yet in this project. |
| RLS blocks everything even when signed in | Check `select auth.uid()` returns your user id in the SQL Editor's "Run as" — and that `festival_members.is_active=true` for that festival. |
| Sync screen shows "Sync paused" | Your Supabase session expired — sign in online again (`refreshOnlineSession()` failed). |
| Camera won't start on a phone | Confirm the site is served over HTTPS (Netlify) — camera access is blocked on plain HTTP except `localhost`. |
