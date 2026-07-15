/*
  js/supabase-client.js — the ONE place the Supabase JS client is created.
  No other file may call `supabase.createClient()`. Requires the Supabase v2
  UMD bundle to already be loaded from the CDN (see the <script> tag in
  index.html) and window.OOXII_CONFIG to already be loaded (js/config.js).

  Uses the publishable/anon key only — every table it can reach is gated by
  Row Level Security (see supabase/migrations/001_ooxii_backend.sql). This
  file never sees, requests, or logs a secret/service-role key.
*/
(function () {
  'use strict';

  const cfg = window.OOXII_CONFIG || {};
  const isPlaceholder = (v) => !v || /^YOUR_/.test(v);
  const configValid = !isPlaceholder(cfg.SUPABASE_URL) && !isPlaceholder(cfg.SUPABASE_PUBLISHABLE_KEY);

  window.OOXII_CONFIG_VALID = configValid;

  if (!configValid) {
    console.warn('[OOXii] Supabase config missing or placeholder — copy js/config.example.js to js/config.js and fill in your project values.');
    window.OOXII_SUPABASE = null;
    return;
  }

  if (typeof window.supabase === 'undefined' || typeof window.supabase.createClient !== 'function') {
    console.error('[OOXii] Supabase JS library did not load from the CDN — check network connectivity for the initial load.');
    window.OOXII_CONFIG_VALID = false;
    window.OOXII_SUPABASE = null;
    return;
  }

  window.OOXII_SUPABASE = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: 'ooxii-auth',
    },
  });
})();
