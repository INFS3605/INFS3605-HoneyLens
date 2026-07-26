/*
  admin/js/admin-auth.js — coordinator-only auth gate for the Insights
  Portal. Completely separate from js/auth-service.js (the tester app's
  auth module) — does not import it, does not touch the offline-PIN-
  permit flow, does not write anything. Read-only: signs in via the same
  Supabase project (window.OOXII_SUPABASE, shared storageKey so a tab
  already signed in on the main app is recognised here too), then checks
  profiles.app_role directly.
*/
(function () {
  'use strict';

  function friendlyAuthError(err) {
    const msg = (err && err.message) || '';
    if (/invalid login credentials/i.test(msg)) return 'Incorrect email or password.';
    if (/network/i.test(msg)) return 'No internet connection. Try again once you are online.';
    return 'Could not sign in right now. Please try again.';
  }

  /** Returns { ok:true, profile } for an active coordinator/administrator,
   *  or { ok:false, reason, profile? } for everyone else — never throws;
   *  every failure is a normal returned value the caller decides how to
   *  present. `reason` is one of: 'not_configured' | 'no_session' |
   *  'no_profile' | 'inactive' | 'not_coordinator' | 'error'. */
  async function checkCoordinatorAccess() {
    if (!window.OOXII_CONFIG_VALID || !window.OOXII_SUPABASE) {
      return { ok: false, reason: 'not_configured' };
    }
    let session;
    try {
      const { data, error } = await window.OOXII_SUPABASE.auth.getSession();
      if (error || !data || !data.session || !data.session.user) return { ok: false, reason: 'no_session' };
      session = data.session;
    } catch (e) {
      return { ok: false, reason: 'error', error: e };
    }
    try {
      const { data: profile, error } = await window.OOXII_SUPABASE
        .from('profiles').select('id, display_name, app_role, is_active').eq('id', session.user.id).single();
      if (error || !profile) return { ok: false, reason: 'no_profile' };
      if (!profile.is_active) return { ok: false, reason: 'inactive', profile };
      if (profile.app_role !== 'coordinator' && profile.app_role !== 'administrator') {
        return { ok: false, reason: 'not_coordinator', profile };
      }
      return { ok: true, profile, userId: session.user.id, email: session.user.email };
    } catch (e) {
      return { ok: false, reason: 'error', error: e };
    }
  }

  async function signIn(email, password) {
    if (!window.OOXII_CONFIG_VALID) return { ok: false, error: 'This portal is not configured yet — see SUPABASE_SETUP.md.' };
    if (!navigator.onLine) return { ok: false, error: 'Sign-in needs an internet connection.' };
    const { data, error } = await window.OOXII_SUPABASE.auth.signInWithPassword({ email, password });
    if (error || !data.user) return { ok: false, error: friendlyAuthError(error) };
    return { ok: true };
  }

  async function signOut() {
    try { await window.OOXII_SUPABASE.auth.signOut(); } catch (e) { /* best-effort */ }
  }

  window.AdminAuth = { checkCoordinatorAccess, signIn, signOut };
})();
