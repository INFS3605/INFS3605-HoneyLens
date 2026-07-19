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

  function backoffDelay(attempts) {
    return Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, attempts));
  }

  async function updateMeta(patch) {
    const meta = (await window.OOXII_DB.syncMeta.get()) || {};
    await window.OOXII_DB.syncMeta.set(Object.assign({}, meta, patch));
  }

  async function getSyncStatus() {
    const [pending, conflicts, meta] = await Promise.all([
      window.OOXII_DB.pendingEvents.all(),
      window.OOXII_DB.conflicts.all(),
      window.OOXII_DB.syncMeta.get(),
    ]);
    const failed = pending.filter((e) => (e.attempts || 0) > 0);
    return {
      pendingCount: pending.length,
      failedCount: failed.length,
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
    // For a success, data.version is the NEW version AFTER the update, so
    // subtracting 1 gives what it was immediately before this event.
    const serverVersionBefore = (data.status === 'ok' || data.status === 'duplicate_ok')
      ? (data.version != null ? data.version - 1 : null)
      : (data.session ? data.session.version : null);
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

    if (data.status === 'ok' || data.status === 'duplicate_ok') {
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

  async function syncNow() {
    if (syncing) return { ok: false, reason: 'already_syncing' };
    if (!window.OOXII_CONFIG_VALID) return { ok: false, reason: 'not_configured' };
    if (!navigator.onLine) return { ok: false, reason: 'offline' };

    syncing = true;
    try {
      const sessionCheck = await window.OOXII_AUTH.refreshOnlineSession();
      if (!sessionCheck.ok) {
        await updateMeta({ blocked: true, blockedReason: sessionCheck.error });
        return { ok: false, reason: 'session_expired' };
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
        const result = await pushEvent(event);
        if (result.synced) { pushed++; continue; }
        if (result.conflicted) { conflicted++; blockedSessions.add(event.clientId); continue; }
        // transient network failure — bounded backoff, keep in queue, stop
        // this run (a network blip usually affects every request, not one)
        event.attempts = (event.attempts || 0) + 1;
        event.lastError = String((result.error && result.error.message) || 'network error');
        event.nextRetryAt = new Date(Date.now() + backoffDelay(event.attempts)).toISOString();
        await window.OOXII_DB.pendingEvents.put(event);
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

  window.OOXII_SYNC = { syncNow, getSyncStatus };
})();
