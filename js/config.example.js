/*
  Copy this file to js/config.js and fill in your own project values.
  js/config.js is gitignored — it is never committed.

  SUPABASE_URL: your project's API URL (Project Settings → API → Project URL).
  SUPABASE_PUBLISHABLE_KEY: the publishable ("anon"/"public") key — safe to ship
  to the browser, NOT the secret/service-role key. Every table it can reach is
  gated by Row Level Security (see supabase/migrations/001_ooxii_backend.sql).
*/
window.OOXII_CONFIG = {
  SUPABASE_URL: "YOUR_SUPABASE_PROJECT_URL",
  SUPABASE_PUBLISHABLE_KEY: "YOUR_SUPABASE_PUBLISHABLE_KEY",
};
