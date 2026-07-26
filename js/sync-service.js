/*
  js/sync-service.js — pushes the local pending-events queue through the
  secure apply_session_event() RPC (never raw table writes), pulls back
  updated canonical sessions, and reports pending/syncing/synced/failed/
  conflicted counts to the Sync screen.

  Ordering & conflicts:
   - events are pushed in chronological (clientTimestamp) order
   - a duplicate event id is treated as already-synced (idempotent)
   - a validation failure (out-of-sequence step, version mismatch, a
     finalised session touched again) is NEVER retried — it's moved to the
     conflicts store for a coordinator to review, never silently overwritten
   - a network failure IS retried, with a bounded exponential backoff
     (capped at 30s between attempts) — this is not a validation problem,
     just "try again later"
   - "Synced" is only ever shown once the server has actually acknowledged
     the event; nothing here guesses success
*/
(function () {
  'use strict';

  const MAX_BACKOFF_MS = 30000;
  let syncing = false;
  // Local-event-ids currently in flight to apply_session_event(), for exactly
  // the duration of the RPC call — this is what getSyncStatus()'s "Syncing"
  // bucket reflects. Always empty between sync runs; never persisted (it
  // describes what THIS tab is doing right now, not durable state).
  const syncingEventIds = new Set();
  // True once this device's `devices` row has been confirmed to exist this
  // page load — avoids re-upserting on every syncNow() call (fired on
  // every save via persistAndQueue's fire-and-forget, on 'online', and on
  // boot). Never cached on failure, so a transient failure retries next time.
  let deviceRegistered = false;

  /** session_events.device_id references devices(id), but nothing else in
   *  this codebase ever creates that row — js/session-repository.js's
   *  newDeviceId() only ever generates/persists a LOCAL id (localStorage),
   *  it never reaches the server. Confirmed as a real, previously-hidden
   *  bug: every apply_session_event() call was masked by the version-
   *  baseline bug returning before the session_events insert was ever
   *  reached; fixing that surfaced this uncaught session_events_device_id_fkey
   *  violation instead. devices is one of the few tables the client writes
   *  to directly (not through apply_session_event()) — devices_insert_own/
   *  devices_update_own RLS policies already existed in 001 for exactly
   *  this, just never exercised until now. */
  async function ensureDeviceRegistered(ctx) {
    if (deviceRegistered) return { ok: true };
    const sb = window.OOXII_SUPABASE;
    const deviceId = window.OOXII_SESSIONS.newDeviceId();
    const { error } = await sb.from('devices').upsert({
      id: deviceId,
      festival_id: ctx.activeFestivalId,
      user_id: ctx.userId,
      label: (navigator.userAgent || 'OOXii device').slice(0, 120),
      app_version: 'ooxii-1.0',
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'id' });
    console.info('[SYNC TRACE] ensureDeviceRegistered()', { deviceId, userId: ctx.userId, festivalId: ctx.activeFestivalId, ok: !error, error: error ? error.message : null });
    if (!error) deviceRegistered = true;
    return { ok: !error, error };
  }

  function backoffDelay(attempts) {
    return Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, attempts));
  }

  async function updateMeta(patch) {
    const meta = (await window.OOXII_DB.syncMeta.get()) || {};
    await window.OOXII_DB.syncMeta.set(Object.assign({}, meta, patch));
  }

  /** Status definitions (each pendingEvents row falls into exactly ONE of
   *  pendingCount/syncingCount/retryCount — never more than one, unlike the
   *  old getSyncStatus() where every retry-needed event was ALSO counted
   *  in pendingCount, double-counting the same event under two labels):
   *   - Pending: queued, never yet attempted (attempts===0), not part of
   *     an active sync run right now.
   *   - Syncing: currently included in the active sync attempt in THIS
   *     tab (syncingEventIds, set only for the duration of pushEvent()).
   *     Cross-tab syncing elsewhere isn't visible here — the Web Locks
   *     mutex already prevents this tab from starting its own run
   *     concurrently (see syncNow()'s 'already_running_elsewhere').
   *   - Retry needed: attempts>0 — failed with a transient/connectivity
   *     error and is waiting for its next backoff attempt.
   *   - Conflict: moved to the separate conflicts store — a real
   *     validation failure (business/version conflict) apply_session_event()
   *     explicitly rejected. Never retried, never silently overwritten.
   *  There is no separate "Failed (non-retryable)" bucket: the RPC itself
   *  only ever returns success (ok/duplicate_ok/already_applied/
   *  merged_missing_fields) or a conflict status — every non-transient
   *  failure already lands in the conflicts store above, so a distinct
   *  "Failed" count would have zero real events behind it. */
  async function getSyncStatus() {
    const [pending, conflicts, meta] = await Promise.all([
      window.OOXII_DB.pendingEvents.all(),
      window.OOXII_DB.conflicts.all(),
      window.OOXII_DB.syncMeta.get(),
    ]);
    const notSyncing = pending.filter((e) => !syncingEventIds.has(e.id));
    const retrying = notSyncing.filter((e) => (e.attempts || 0) > 0);
    const notYetAttempted = notSyncing.filter((e) => (e.attempts || 0) === 0);
    return {
      pendingCount: notYetAttempted.length,
      syncingCount: syncingEventIds.size,
      retryCount: retrying.length,
      conflictedCount: conflicts.length,
      lastSyncAt: meta ? meta.lastSyncAt : null,
      blocked: meta ? !!meta.blocked : false,
      blockedReason: meta ? meta.blockedReason : null,
    };
  }

  /** Merge a server-returned canonical session snapshot into local storage
   *  AND the live in-memory `state.sessions` the UI is already rendering
   *  from, so a synced update shows up immediately without a reload. */
  async function applyServerSnapshot(clientId, serverRow) {
    if (!serverRow) return;
    const local = await window.OOXII_DB.sessions.get(clientId);
    const merged = Object.assign({}, local, {
      id: clientId,
      _serverId: serverRow.id,
      version: serverRow.version,
      status: serverRow.status,
      intake: local ? local.intake : undefined,
      distance: serverRow.distance || (local && local.distance) || null,
      near: serverRow.near || (local && local.near) || null,
      wheel: serverRow.wheel || (local && local.wheel) || null,
      paddle: serverRow.paddle || (local && local.paddle) || null,
      dispense: serverRow.dispense || (local && local.dispense) || null,
      exit: serverRow.exit_data || (local && local.exit) || null,
    });
    await window.OOXII_DB.sessions.put(merged);
    // `state` is index.html's top-level `const state` — a classic <script>'s
    // top-level let/const is never a `window` property, but every classic
    // script on the page shares the same global scope, so the bare
    // identifier IS reachable here (this function only runs long after
    // index.html's inline script has already declared it).
    const st = (typeof state!=='undefined') ? state : null;
    if (st && st.sessions && st.sessions[clientId]) {
      Object.assign(st.sessions[clientId], merged);
    }
  }

  async function pushEvent(event) {
    const sb = window.OOXII_SUPABASE;
    const rpcParams = {
      p_event_id: event.id,
      p_session_id: event.sessionServerId,
      p_festival_id: event.festivalId,
      p_client_id: event.clientId,
      p_mode: event.mode,
      p_event_type: event.eventType,
      p_step: event.step,
      p_station: event.station,
      p_payload: event.payload,
      p_device_id: event.deviceId,
      p_base_version: event.baseVersion,
      p_client_timestamp: event.clientTimestamp,
      p_sync_batch_id: null,
    };
    // TEMPORARY diagnostic trace for the version-mismatch investigation —
    // logs exactly what this device is about to send. No behaviour changed.
    console.info('[SYNC TRACE] pushing to apply_session_event', {
      session_id: event.sessionServerId,
      local_event_id: event.id,
      client_id: event.clientId,
      local_base_version: event.baseVersion,
      event_type: event.eventType,
      payload_sent: rpcParams,
    });

    let data, error, status, statusText;
    try {
      const resp = await sb.rpc('apply_session_event', rpcParams);
      data = resp.data; error = resp.error; status = resp.status; statusText = resp.statusText;
    } catch (e) {
      console.error('[SYNC TRACE] apply_session_event threw (exception, not a returned error object)', {
        session_id: event.sessionServerId, local_event_id: event.id, message: e.message, stack: e.stack,
      });
      return { transient: true, error: e };
    }

    if (error) {
      // network / transient failure — never a validation error (those come
      // back as a normal `data.status`, not a thrown/RPC error)
      console.info('[SYNC TRACE] RPC transport error (not a version check — never reached apply_session_event\'s logic)', {
        session_id: event.sessionServerId,
        local_event_id: event.id,
        response_status: status,
        response_statusText: statusText,
        error_message: error.message,
        error_code: error.code,
        error_details: error.details,
        error_hint: error.hint,
        error_raw: error,
      });
      return { transient: true, error };
    }

    // server_version_before: for a conflict, data.session is the row exactly
    // as apply_session_event() read it (to_jsonb(v_session)) BEFORE any
    // update was attempted — i.e. the real server version at rejection time.
    // For a real increment (ok, or merged_missing_fields — see migration
    // 005, which increments version exactly once when it fills empty
    // fields), data.version is the version AFTER that increment, so
    // subtracting 1 gives the before-value; already_applied/duplicate_ok
    // never increment, so data.session's version is both before and after.
    const serverVersionBefore = (data.status === 'ok' || data.status === 'merged_missing_fields')
      ? (data.version != null ? data.version - 1 : null)
      : (data.session ? data.session.version : (data.version != null ? data.version : null));
    console.info('[SYNC TRACE] apply_session_event response', {
      session_id: event.sessionServerId,
      local_event_id: event.id,
      local_base_version: event.baseVersion,
      response_status: status,
      response_statusText: statusText,
      response_body: data,
      status: data.status,
      conflict_type: data.conflict_type || null,
      server_version_before: serverVersionBefore,
      server_version_after: data.version != null ? data.version : (data.session ? data.session.version : null),
    });

    // 'already_applied' (migration 004): this event's supplied fields
    // already exactly matched the canonical row. 'merged_missing_fields'
    // (migration 005): this event's fields were a strict fill-null-only
    // merge — every supplied field was either identical or filled a
    // currently-empty column, never overwrote a genuine disagreement.
    // Both are treated exactly like a real success, never as a conflict —
    // the canonical session snapshot is applied locally either way.
    if (data.status === 'ok' || data.status === 'duplicate_ok' || data.status === 'already_applied' || data.status === 'merged_missing_fields') {
      await window.OOXII_DB.syncedEventIds.mark(event.id);
      await window.OOXII_DB.pendingEvents.remove(event.id);
      await applyServerSnapshot(event.clientId, data.session);
      return { synced: true };
    }

    // conflict / sequence_error: a real validation failure — never retried,
    // never silently overwritten
    await window.OOXII_DB.conflicts.put({
      id: crypto.randomUUID(),
      eventId: event.id,
      clientId: event.clientId,
      conflictType: data.conflict_type || data.status,
      expectedStep: data.expected_step || null,
      serverSession: data.session || null,
      detectedAt: new Date().toISOString(),
    });
    await window.OOXII_DB.pendingEvents.remove(event.id);
    return { conflicted: true, status: data.status };
  }

  const SYNC_LOCK_NAME = 'ooxii-sync';

  /** Cross-tab mutual exclusion for the whole sync sequence (device
   *  registration through local pending-event removal) — see
   *  BACKEND_IMPLEMENTATION_PLAN.md. Two same-origin tabs share one
   *  IndexedDB; without this, both can independently read the same
   *  pending_events snapshot and push the same event to
   *  apply_session_event() within milliseconds of each other (confirmed
   *  happening in production — a real conflict-table pair with the
   *  identical local_event_id, 2ms apart). Web Locks is scoped per
   *  browser context at the origin level, so `{ ifAvailable: true }`
   *  correctly returns null to every OTHER tab (and to a second overlapping
   *  call within the SAME tab) while one holder is still inside the lock —
   *  no separate localStorage/spin-lock bookkeeping needed, and nothing
   *  here can go stale: the lock is released automatically the instant the
   *  callback settles (success OR throw), even if a tab crashes or is
   *  killed mid-sync. */
  async function syncNow() {
    if (!window.OOXII_CONFIG_VALID) return { ok: false, reason: 'not_configured' };
    if (!navigator.onLine) return { ok: false, reason: 'offline' };

    if (navigator.locks && navigator.locks.request) {
      return navigator.locks.request(SYNC_LOCK_NAME, { ifAvailable: true }, (lock) => {
        if (!lock) {
          console.info('[SYNC TRACE] syncNow() could not acquire the cross-tab lock — another tab is already syncing');
          return { ok: false, reason: 'already_running_elsewhere' };
        }
        return runSyncLoop();
      });
    }

    // Web Locks unavailable (older browsers) — falls back to the original
    // in-tab-only guard. This cannot stop a genuinely separate TAB from
    // syncing concurrently, but still prevents this tab calling itself
    // re-entrantly. Deliberately not a localStorage spin-lock (no expiry/
    // recovery logic to get wrong) — just the same boolean this file
    // already had before Web Locks existed.
    if (syncing) return { ok: false, reason: 'already_syncing' };
    console.info('[SYNC TRACE] syncNow() Web Locks API unavailable — using in-tab-only fallback guard');
    return runSyncLoop();
  }

  async function runSyncLoop() {
    syncing = true;
    try {
      const sessionCheck = await window.OOXII_AUTH.refreshOnlineSession();
      if (!sessionCheck.ok) {
        await updateMeta({ blocked: true, blockedReason: sessionCheck.error });
        return { ok: false, reason: 'session_expired' };
      }

      const ctx = await window.OOXII_AUTH.getCurrentContext();
      if (!ctx) {
        await updateMeta({ blocked: true, blockedReason: 'No signed-in context available for syncing. Try signing in again.' });
        return { ok: false, reason: 'no_context' };
      }
      // Must happen before any apply_session_event() call — that RPC's
      // session_events insert has a foreign key on device_id, and nothing
      // else in this codebase ever creates the devices row it points to.
      const deviceCheck = await ensureDeviceRegistered(ctx);
      if (!deviceCheck.ok) {
        await updateMeta({ blocked: true, blockedReason: 'Could not register this device for syncing: ' + ((deviceCheck.error && deviceCheck.error.message) || 'unknown error') });
        return { ok: false, reason: 'device_registration_failed' };
      }

      await updateMeta({ blocked: false, blockedReason: null });

      const all = await window.OOXII_DB.pendingEvents.all();
      const now = Date.now();
      const due = all
        .filter((e) => !e.nextRetryAt || new Date(e.nextRetryAt).getTime() <= now)
        .sort((a, b) => a.clientTimestamp.localeCompare(b.clientTimestamp));

      let pushed = 0, conflicted = 0, blockedSessions = new Set();
      for (const event of due) {
        if (blockedSessions.has(event.clientId)) continue; // preserve per-session order
        syncingEventIds.add(event.id);
        let result;
        try {
          result = await pushEvent(event);
        } finally {
          syncingEventIds.delete(event.id);
        }
        if (result.synced) {
          pushed++;
          console.info('[SYNC TRACE] pending event disposition: REMOVED (synced)', { local_event_id: event.id, client_id: event.clientId });
          continue;
        }
        if (result.conflicted) {
          conflicted++; blockedSessions.add(event.clientId);
          console.info('[SYNC TRACE] pending event disposition: REMOVED (moved to conflicts, never retried)', { local_event_id: event.id, client_id: event.clientId, conflict_status: result.status });
          continue;
        }
        // transient network failure — bounded backoff, keep in queue, stop
        // this run (a network blip usually affects every request, not one)
        event.attempts = (event.attempts || 0) + 1;
        event.lastError = String((result.error && result.error.message) || 'network error');
        event.nextRetryAt = new Date(Date.now() + backoffDelay(event.attempts)).toISOString();
        await window.OOXII_DB.pendingEvents.put(event);
        console.info('[SYNC TRACE] pending event disposition: RETAINED (transient failure, will retry)', { local_event_id: event.id, client_id: event.clientId, attempts: event.attempts, nextRetryAt: event.nextRetryAt });
        break;
      }

      const status = await getSyncStatus();
      await updateMeta({ lastSyncAt: new Date().toISOString(), pendingCount: status.pendingCount, conflictedCount: status.conflictedCount });
      return { ok: true, pushed, conflicted, remaining: status.pendingCount };
    } finally {
      syncing = false;
    }
  }

  // triggers: on load (if already online), and whenever the browser regains connectivity
  window.addEventListener('online', () => { syncNow().catch(() => {}); });

  // Periodic reconnect safety net — NOT the primary sync trigger (save-time,
  // boot, 'online', and manual "Sync now" all remain exactly as they were);
  // this only covers the gap where a device comes back online without any
  // of those firing (e.g. connectivity returns silently, or the browser
  // doesn't fire a genuine 'online' event for the transition). A
  // conservative 50s interval — frequent enough that a tester never has to
  // reload the page to see a reconnect picked up, infrequent enough not to
  // hammer the RPC. Every check below is deliberately cheap and read-only
  // before ever calling syncNow(), which itself already handles "already
  // running" (Web Locks) and "nothing to do" safely — this is just about
  // not bothering to try in the first place when it's obviously pointless
  // (demo mode, not signed in, offline, or genuinely nothing queued).
  const PERIODIC_SYNC_INTERVAL_MS = 50000;
  setInterval(async () => {
    if (!window.OOXII_CONFIG_VALID || !navigator.onLine) return;
    // `state` is index.html's top-level const — see applyServerSnapshot()'s
    // comment above for why the bare identifier (not window.state) is the
    // correct way to reach it from this file.
    const st = (typeof state !== 'undefined') ? state : null;
    if (!st || !st.authed || st.authMode === 'demo') return; // never in Demo Mode
    try {
      const pending = await window.OOXII_DB.pendingEvents.all();
      if (!pending.length) return;
    } catch (e) {
      return; // can't check IndexedDB right now — skip this tick, try again next interval
    }
    console.info('[SYNC TRACE] periodic reconnect sync firing', { intervalMs: PERIODIC_SYNC_INTERVAL_MS });
    syncNow().catch(() => {});
  }, PERIODIC_SYNC_INTERVAL_MS);

  window.OOXII_SYNC = { syncNow, getSyncStatus };
})();
