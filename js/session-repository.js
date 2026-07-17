/*
  js/session-repository.js — local-first persistence for the SAME session
  object shape the existing screens already read and write directly
  (state.sessions[clientId] — untouched by this backend work). This file
  does not change that shape or intercept it; it is a thin persistence +
  event-queue layer that index.html's existing save functions call into
  AFTER they've already mutated state.sessions (see backend-adapter.js for
  the exact hook points).

  Integration decision (documented in BACKEND_IMPLEMENTATION_PLAN.md): the
  clinical screens stay 100% synchronous and keep mutating state.sessions
  directly — that is the existing, already-tested decision engine and UI,
  and rewriting it to be async would be the highest-risk possible change.
  Persistence is bolted on as a side effect, fire-and-forget, so the UI is
  never blocked on IndexedDB or network.

  Local-first save order (per clinical save):
    1. existing decision-engine validation + state.sessions mutation (unchanged)
    2. write the full session to IndexedDB (this file)
    3. create a client-generated event UUID + queue it for sync (this file)
    4. UI already updated (step 1 already re-rendered the next screen)
    5. background sync attempt only if online (sync-service.js)
*/
(function () {
  'use strict';

  function newDeviceId() {
    let id = null;
    try { id = localStorage.getItem('ooxii_device_id'); } catch (e) {}
    if (!id) {
      id = crypto.randomUUID();
      try { localStorage.setItem('ooxii_device_id', id); } catch (e) {}
    }
    return id;
  }

  /** Ensure the session carries a stable server-side UUID (client_sessions.id)
   *  distinct from its anonymous clinical ID (client_sessions.client_id). */
  function ensureServerId(session) {
    if (!session._serverId) session._serverId = crypto.randomUUID();
    return session._serverId;
  }

  /** Load every locally persisted session back into the shape
   *  state.sessions/state.queue expect, for boot-time restoration after a
   *  refresh or full browser restart. */
  async function hydrate() {
    const rows = await window.OOXII_DB.sessions.all();
    const sessions = {};
    const queue = [];
    for (const row of rows) {
      sessions[row.id] = row;
      queue.push(row.id);
    }
    queue.sort((a, b) => (sessions[b].time || '').localeCompare(sessions[a].time || ''));
    return { sessions, queue };
  }

  /** Persist the current session snapshot and enqueue one sync event.
   *  `meta`: { eventType, step, station, payloadKeys, baseVersion, festivalId, userId, mode } */
  async function persistAndQueue(session, meta) {
    await window.OOXII_DB.sessions.put(session);

    const deviceId = newDeviceId();
    const payload = {};
    for (const key of meta.payloadKeys || []) payload[key] = session[key];
    if (session.status) payload.status = session.status;

    const event = {
      id: crypto.randomUUID(),
      sessionServerId: ensureServerId(session),
      clientId: session.id,
      festivalId: meta.festivalId || null,
      mode: meta.mode || 'festival',
      eventType: meta.eventType,
      step: meta.step || null,
      station: meta.station || null,
      payload,
      deviceId,
      userId: meta.userId || null,
      baseVersion: meta.baseVersion,
      clientTimestamp: new Date().toISOString(),
      attempts: 0,
      lastError: null,
    };
    await window.OOXII_DB.pendingEvents.put(event);
    await bumpPendingCount();

    // fire-and-forget: never block the UI on network or IndexedDB
    if (navigator.onLine && window.OOXII_SYNC) {
      window.OOXII_SYNC.syncNow().catch(() => {});
    }
    return event;
  }

  async function bumpPendingCount() {
    const pending = await window.OOXII_DB.pendingEvents.all();
    const meta = (await window.OOXII_DB.syncMeta.get()) || {};
    meta.pendingCount = pending.length;
    await window.OOXII_DB.syncMeta.set(meta);
  }

  /** Demo seed clients (A47-K, B12-M, C09-T, ...) are for local exploration
   *  only — gated behind an explicit flag so they never appear in a real
   *  festival. True when the tester explicitly chose Demo Mode this browser
   *  session (sessionStorage('ooxii_demo_mode'), set only by index.html's
   *  "Continue in demo mode" button — see isDemoModeSession() there), via
   *  the legacy ?demo=1 URL param, or automatically when no backend is
   *  configured at all (so the static prototype still walks). Reads
   *  sessionStorage directly rather than calling index.html's helper — both
   *  read the exact same key, and sessionStorage is a plain browser global,
   *  not something that needs cross-file wiring. */
  function demoSeedAllowed() {
    try {
      if (sessionStorage.getItem('ooxii_demo_mode') === 'true') return true;
      const params = new URLSearchParams(window.location.search);
      if (params.get('demo') === '1') return true;
    } catch (e) {}
    return !window.OOXII_CONFIG_VALID;
  }

  window.OOXII_SESSIONS = { hydrate, persistAndQueue, ensureServerId, demoSeedAllowed, newDeviceId };
})();
