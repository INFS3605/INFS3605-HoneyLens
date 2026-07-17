/*
  js/auth-service.js — real Supabase auth + a 30-day encrypted offline permit.

  Two separate things on purpose:
   1. The Supabase SDK's own session (JWT + refresh token), persisted by the
      SDK itself (auth.persistSession=true) — this is what actually
      authorises server requests, and is only ever used/refreshed while
      online.
   2. A locally encrypted "offline permit" (this file), which only unlocks
      the APP UI when there is no connectivity to even ask Supabase whether
      the SDK session is still valid. It is never sent anywhere and never
      substitutes for a real Supabase session when talking to the server —
      "Do not treat a locally cached permit as authorisation to access
      server data" (sync-service.js always requires a live Supabase session
      before pushing/pulling).

  The permit is encrypted with a key derived (PBKDF2) from a short offline
  PIN the tester sets right after a successful online sign-in — never from
  their account password, and the password itself is never stored anywhere.
*/
(function () {
  'use strict';

  const OFFLINE_DAYS = 30;
  const PBKDF2_ITERATIONS = 100000;

  function nowIso() { return new Date().toISOString(); }
  function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
  function unb64(str) { return Uint8Array.from(atob(str), (c) => c.charCodeAt(0)); }

  async function deriveKey(pin, saltBytes) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  }

  async function encryptJson(obj, pin) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pin, salt);
    const data = new TextEncoder().encode(JSON.stringify(obj));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    return { salt: b64(salt), iv: b64(iv), ciphertext: b64(cipher) };
  }

  async function decryptJson(blob, pin) {
    const key = await deriveKey(pin, unb64(blob.salt));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ciphertext));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  function friendlyAuthError(err) {
    const msg = (err && err.message) || '';
    if (/invalid login credentials/i.test(msg)) return 'Incorrect email or password.';
    if (/network/i.test(msg)) return 'No internet connection. Try again once you are online.';
    return 'Could not sign in right now. Please try again.';
  }

  async function loadProfileAndMemberships(userId) {
    const sb = window.OOXII_SUPABASE;
    const { data: profile, error: profErr } = await sb.from('profiles').select('*').eq('id', userId).single();
    if (profErr || !profile) return { error: 'Could not load your tester profile. Ask a coordinator to check your account.' };
    if (!profile.is_active) return { error: 'Your tester account is inactive. Ask a coordinator to reactivate it.' };

    const { data: memberships, error: memErr } = await sb
      .from('festival_members')
      .select('festival_id, member_role, allowed_stations, is_active, festivals ( id, name, village, status, timezone )')
      .eq('user_id', userId).eq('is_active', true);
    if (memErr) return { error: 'Could not load your festival assignments.' };
    if (!memberships || memberships.length === 0) {
      return { error: 'You are not assigned to any festival yet. Ask a coordinator to add you.' };
    }
    return { profile, memberships };
  }

  /** Builds and persists the same `context` shape from a userId/email we
   *  already know is currently valid (either a fresh password sign-in, or an
   *  existing Supabase session found on boot) — the ONLY place that shape is
   *  built, so a restored session and a fresh sign-in can never drift apart.
   *  Every failure here (inactive/missing profile, no festival assignment,
   *  a query error) is reported as a plain error — the caller decides what
   *  to show; this function never itself falls back to any other identity. */
  async function restoreSessionContext(userId, email) {
    const loaded = await loadProfileAndMemberships(userId);
    if (loaded.error) return { ok: false, error: loaded.error };
    const context = {
      userId,
      email,
      displayName: loaded.profile.display_name,
      appRole: loaded.profile.app_role,
      festivals: loaded.memberships.map((m) => ({
        festivalId: m.festival_id,
        festivalName: m.festivals ? m.festivals.name : '(unknown festival)',
        timezone: m.festivals ? (m.festivals.timezone || 'Pacific/Efate') : 'Pacific/Efate',
        memberRole: m.member_role,
        allowedStations: m.allowed_stations || [],
      })),
      activeFestivalId: loaded.memberships[0].festival_id,
      signedInAt: nowIso(),
    };
    await window.OOXII_DB.context.set(context);
    return { ok: true, context };
  }

  async function signInOnline(email, password) {
    if (!window.OOXII_CONFIG_VALID) return { ok: false, error: 'App is not configured yet — see SUPABASE_SETUP.md.' };
    if (!navigator.onLine) return { ok: false, error: 'The first sign-in on this device must happen online.' };
    const sb = window.OOXII_SUPABASE;
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error || !data.user) return { ok: false, error: friendlyAuthError(error) };

    const restored = await restoreSessionContext(data.user.id, data.user.email);
    if (!restored.ok) { await sb.auth.signOut(); return { ok: false, error: restored.error }; }
    return { ok: true, context: restored.context, needsOfflinePin: true };
  }

  async function setOfflinePin(pin) {
    if (!/^\d{4,8}$/.test(pin)) return { ok: false, error: 'PIN must be 4–8 digits.' };
    const context = await window.OOXII_DB.context.get();
    if (!context) return { ok: false, error: 'Sign in online first.' };
    const expiresAt = new Date(Date.now() + OFFLINE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const blob = await encryptJson(context, pin);
    await window.OOXII_DB.offlinePermit.set({ blob, expiresAt, displayName: context.displayName });
    return { ok: true, expiresAt };
  }

  async function offlinePermitStatus() {
    const permit = await window.OOXII_DB.offlinePermit.get();
    if (!permit) return { exists: false };
    const valid = new Date(permit.expiresAt).getTime() > Date.now();
    return { exists: true, valid, expiresAt: permit.expiresAt, displayName: permit.displayName };
  }

  async function unlockOffline(pin) {
    const permit = await window.OOXII_DB.offlinePermit.get();
    if (!permit) return { ok: false, error: 'No offline permit on this device yet. Sign in online first.' };
    if (new Date(permit.expiresAt).getTime() <= Date.now()) {
      return { ok: false, error: 'Your 30-day offline access has expired. Please sign in online again.' };
    }
    try {
      const context = await decryptJson(permit.blob, pin);
      await window.OOXII_DB.context.set(context);
      return { ok: true, context };
    } catch (e) {
      return { ok: false, error: 'Incorrect PIN.' };
    }
  }

  async function getCurrentContext() {
    return window.OOXII_DB.context.get();
  }

  /** Called before syncing once connectivity returns — never trust the
   *  offline permit for server access; always re-verify with Supabase. */
  async function refreshOnlineSession() {
    if (!window.OOXII_CONFIG_VALID || !navigator.onLine) return { ok: false, error: 'offline' };
    const sb = window.OOXII_SUPABASE;
    const { data, error } = await sb.auth.getSession();
    if (error || !data.session) return { ok: false, error: 'Your session has expired. Please sign in online again.' };
    return { ok: true, session: data.session };
  }

  async function pendingUnsyncedCount() {
    const events = await window.OOXII_DB.pendingEvents.all();
    return events.length;
  }

  async function signOut({ force = false } = {}) {
    const pending = await pendingUnsyncedCount();
    if (pending > 0 && !force) {
      return { ok: false, needsConfirmation: true, pendingCount: pending };
    }
    if (window.OOXII_CONFIG_VALID && navigator.onLine) {
      try { await window.OOXII_SUPABASE.auth.signOut(); } catch (e) { /* best-effort */ }
    }
    await window.OOXII_DB.wipeClinicalData();
    await window.OOXII_DB.offlinePermit.clear();
    return { ok: true };
  }

  window.OOXII_AUTH = {
    signInOnline, restoreSessionContext, setOfflinePin, offlinePermitStatus, unlockOffline,
    getCurrentContext, refreshOnlineSession, pendingUnsyncedCount, signOut,
  };
})();
