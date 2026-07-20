/*
  js/backend-adapter.js — the ONE boundary index.html's screens call into.
  No screen function makes a raw Supabase query; they either read the
  already-existing `state.sessions` (unchanged, synchronous, local-first) or
  call one of the functions exposed here.

  Boot sequence (see index.html's boot section):
   1. boot() hydrates IndexedDB into {sessions, queue} for state to adopt
   2. if no real persisted sessions exist yet, the demo seed() clients from
      index.html are kept for a walkable local prototype (gated by
      OOXII_SESSIONS.demoSeedAllowed()) — never mixed with real festival data
   3. recordEvent(...) is the single hook index.html's save functions call
      (advance/saveIntake/confirmGlasses/confirmExit) AFTER they've already
      mutated state.sessions — this is what makes every clinical save
      local-first-then-synced rather than replacing the existing decision
      engine or screen code.
*/
(function () {
  'use strict';

  let cachedContext = null;

  /* index.html's `const state = {...}` (top-level in a classic <script>) is
     NOT a property of `window` — top-level let/const/class bindings never
     are, even though every classic <script> on the page shares the same
     global lexical scope and CAN see the bare identifier. Reference `state`
     directly (safe: this only ever runs from functions called well after
     index.html's inline script has already declared it), not `window.state`,
     which is always undefined and would silently no-op every check below. */
  function appState(){ return (typeof state!=='undefined') ? state : null; }

  let cachedHoneySummary = null;

  async function boot() {
    const hydrated = await window.OOXII_SESSIONS.hydrate();
    const hasRealSessions = Object.keys(hydrated.sessions).length > 0;
    cachedContext = await window.OOXII_AUTH.getCurrentContext();

    // background sync on startup if we're already online — never blocks boot
    if (navigator.onLine && window.OOXII_CONFIG_VALID && cachedContext) {
      window.OOXII_SYNC.syncNow().catch(() => {});
      refreshHoneySummary().catch(() => {});
    }

    return {
      hydratedSessions: hydrated.sessions,
      hydratedQueue: hydrated.queue,
      hasRealSessions,
      useDemoSeed: window.OOXII_SESSIONS.demoSeedAllowed() && !hasRealSessions,
      context: cachedContext,
    };
  }

  /* Same event types apply_session_event() awards Honey for — kept in sync
     with EVENT_TYPE below and the RPC's own v_honey_types. Participation and
     administrative task completion only; never a clinical outcome. */
  const HONEY_ELIGIBLE_EVENT_TYPES = ['registration', 'step_saved', 'dispense_completed', 'exit_completed', 'admin_task'];

  /* "Festival-local date" — the SAME timezone the RPC uses server-side
     (festivals.timezone, default Pacific/Efate) so a client's "today" and
     the server's festival_local_date always agree, regardless of which
     timezone the tester's own device is set to. */
  function festivalTimezone() {
    const m = getActiveFestivalMembershipForHoney();
    return (m && m.timezone) || 'Pacific/Efate';
  }
  function getActiveFestivalMembershipForHoney() {
    if (!cachedContext || !cachedContext.festivals) return null;
    return cachedContext.festivals.find((f) => f.festivalId === cachedContext.activeFestivalId) || null;
  }
  function festivalLocalDateParts(tz) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    // en-CA formats as YYYY-MM-DD
    return { today: parts, month: parts.slice(0, 7) };
  }

  /** Confirmed Honey (from the server) for today + this month, using the
   *  festival-local date. Cached; call again to refresh (e.g. after a sync
   *  or when the Profile screen opens). Returns null when offline/demo/not
   *  yet fetched — callers fall back to the existing local-only counters,
   *  unchanged, in that case. */
  async function refreshHoneySummary() {
    if (!navigator.onLine || !window.OOXII_CONFIG_VALID || !cachedContext) return cachedHoneySummary;
    const tz = festivalTimezone();
    const { today, month } = festivalLocalDateParts(tz);
    try {
      const { data, error } = await window.OOXII_SUPABASE
        .from('honey_events').select('festival_local_date')
        .eq('user_id', cachedContext.userId).eq('festival_id', cachedContext.activeFestivalId)
        .gte('festival_local_date', month + '-01');
      if (error) return cachedHoneySummary;
      const rows = data || [];
      cachedHoneySummary = {
        todayConfirmed: rows.filter((r) => r.festival_local_date === today).length,
        monthConfirmed: rows.length,
        festivalLocalToday: today,
      };
    } catch (e) { /* keep whatever was cached before */ }
    return cachedHoneySummary;
  }

  /** Pending (not yet synced) Honey-eligible events created on THIS device —
   *  disjoint from the confirmed server count by construction: an event is
   *  removed from the pending queue the moment it syncs (success OR
   *  conflict), so it is never counted in both places at once. */
  async function pendingHoneyCount(sinceMonthStr) {
    const pending = await window.OOXII_DB.pendingEvents.all();
    return pending.filter((e) => HONEY_ELIGIBLE_EVENT_TYPES.includes(e.eventType)
      && (!sinceMonthStr || (e.clientTimestamp || '').slice(0, 7) >= sinceMonthStr)).length;
  }

  /** What the sidebar/Profile actually render: confirmed-server + still-
   *  pending-local, merged without double counting. Returns null (meaning
   *  "use the existing local-only state.honey counters, unchanged") when no
   *  backend is configured or nothing has been fetched yet. */
  let cachedDisplayTotals = null;
  async function getHoneyDisplayTotals() {
    if (!cachedHoneySummary) return null;
    const { today, month } = festivalLocalDateParts(festivalTimezone());
    const pendingToday = await pendingHoneyCount(today.slice(0, 7)); // this device's pending, this month
    cachedDisplayTotals = {
      today: cachedHoneySummary.todayConfirmed + (cachedHoneySummary.festivalLocalToday === today ? pendingToday : 0),
      month: cachedHoneySummary.monthConfirmed + pendingToday,
      pendingCount: pendingToday,
    };
    return cachedDisplayTotals;
  }
  /** Synchronous read of the last-computed totals, for screens that render
   *  synchronously (sidebar/Profile) — they show this immediately (or fall
   *  back to the existing local-only state.honey counters when null, e.g.
   *  demo mode or nothing fetched yet) and separately kick off
   *  refreshHoneyDisplayCache() in the background to keep it current. */
  function getCachedHoneyDisplayTotalsSync() { return cachedDisplayTotals; }
  function refreshHoneyDisplayCache() {
    if (!navigator.onLine || !window.OOXII_CONFIG_VALID || !cachedContext) return;
    refreshHoneySummary().then(getHoneyDisplayTotals).catch(() => {});
  }

  /* Honey's cached totals are scoped to one user+festival — a sign-out or a
     festival switch must invalidate them, otherwise a stale confirmed total
     from the PREVIOUS context could keep being shown as if still current. */
  function refreshCachedContext(ctx) {
    const prevKey = cachedContext ? cachedContext.userId + ':' + cachedContext.activeFestivalId : null;
    const nextKey = ctx ? ctx.userId + ':' + ctx.activeFestivalId : null;
    if (prevKey !== nextKey) { cachedHoneySummary = null; cachedDisplayTotals = null; }
    cachedContext = ctx;
  }

  /** Per-step payload key map — mirrors exactly what each save function in
   *  index.html already writes onto `s`, so the event payload is the same
   *  shape apply_session_event() expects for that column. */
  const PAYLOAD_KEYS = {
    Registration: ['ageBand', 'gender', 'village', 'cataract', 'status'],
    Distance: ['distance', 'status'],
    Near: ['near', 'status'],
    Wheel: ['wheel', 'status'],
    Paddle: ['paddle', 'status'],
    Dispense: ['dispense', 'status'],
    Exit: ['exit', 'status'],
    /* A QR import can be the very first event this session's canonical row
       ever sees on the server (e.g. the registering device never reconnects)
       — carry every field so the RPC can build a complete row from it, not
       just whatever the receiving station happens to look at. */
    QRImport: ['ageBand', 'gender', 'village', 'cataract', 'distance', 'near', 'wheel', 'paddle', 'dispense', 'exit', 'status'],
  };
  const EVENT_TYPE = {
    Registration: 'registration', Distance: 'step_saved', Near: 'step_saved',
    Wheel: 'step_saved', Paddle: 'step_saved', Dispense: 'dispense_completed', Exit: 'exit_completed',
    QRImport: 'qr_imported',
  };

  /** Called by index.html right after a clinical save mutates state.sessions.
   *  `step` is one of the keys above; `session` is the just-mutated
   *  state.sessions[id] object (already has its NEW version) — the REAL
   *  object, not a copy.
   *
   *  Session-ID stability fix: this used to call ensureServerId() on a
   *  throwaway `Object.assign({}, session, ...)` copy created fresh every
   *  call, so every single save generated a NEW random UUID — every
   *  clinical save for the same client targeted a DIFFERENT canonical
   *  client_sessions row on the server (confirmed in production: server
   *  stuck at version 1 while the client's own version counter climbed to
   *  2, 3... — see BACKEND_IMPLEMENTATION_PLAN.md for the full trace).
   *  ensureServerId() now runs on the REAL session object FIRST, is
   *  persisted and read back before anything is queued, and is passed
   *  through explicitly — persistAndQueue() no longer generates one itself. */
  async function recordEvent(step, session, station) {
    const authMode = (appState() && appState().authMode) || null;
    console.info('[SYNC TRACE] recordEvent() entered', { step, clientId: session.id, station: station||null, versionAtEntry: session.version, serverIdAtEntry: session._serverId||null, authMode });
    try{
      const ctx = cachedContext || (cachedContext = await window.OOXII_AUTH.getCurrentContext());
      const festivalId = ctx ? ctx.activeFestivalId : null;
      const userId = ctx ? ctx.userId : null;
      console.info('[SYNC TRACE] recordEvent() context resolved', { clientId: session.id, festivalId, userId, ctxPresent: !!ctx });

      const sessionServerId = window.OOXII_SESSIONS.ensureServerId(session);
      console.info('[SYNC TRACE] recordEvent() ensureServerId result', { clientId: session.id, sessionServerId });

      // Persist the REAL session (now carrying the stable _serverId) and read
      // it back before anything is queued — never silently proceed with an
      // event that references an ID that didn't actually get saved (a full
      // IndexedDB, a blocked connection, etc.).
      if(!window.OOXII_DB){
        throw new Error('IndexedDB unavailable — cannot persist the stable session ID for '+session.id);
      }
      await window.OOXII_DB.sessions.put(session);
      const verify = await window.OOXII_DB.sessions.get(session.id);
      console.info('[SYNC TRACE] recordEvent() IndexedDB readback', { clientId: session.id, expectedServerId: sessionServerId, readBackServerId: verify ? verify._serverId : null, match: !!(verify && verify._serverId===sessionServerId) });
      if(!verify || verify._serverId!==sessionServerId){
        throw new Error('Stable session ID (_serverId) failed to persist for '+session.id+' — refusing to queue an event that references an unconfirmed ID');
      }

      const flat = Object.assign({}, session, session.intake || {});
      flat._serverId = sessionServerId; // carry the stable ID explicitly — persistAndQueue() must never (re)generate one
      const baseVersion = (session.version || 1) - 1;
      const eventType = EVENT_TYPE[step] || 'step_saved';
      console.info('[SYNC TRACE] recordEvent() calling persistAndQueue()', {
        clientId: session.id, sessionServerId, local_base_version: baseVersion, local_version: session.version, event_type: eventType, step,
      });
      const event = await window.OOXII_SESSIONS.persistAndQueue(flat, {
        sessionServerId,
        eventType,
        step,
        station: station || null,
        payloadKeys: PAYLOAD_KEYS[step] || [],
        baseVersion,
        festivalId, userId,
        mode: (appState() && appState().mode) || 'festival',
      });
      console.info('[SYNC TRACE] recordEvent() returning', { clientId: session.id, local_event_id: event ? event.id : null });
      return event;
    }catch(e){
      console.error('[SYNC TRACE] recordEvent() threw', { clientId: session.id, step, message: e.message, stack: e.stack });
      throw e;
    }
  }

  /** Online lookup, scoped to the tester's own active festival membership —
   *  both by this query filter AND independently by RLS server-side
   *  (ooxii_is_festival_member), so a tester can never pull another
   *  festival's session even if this filter were somehow bypassed. */
  async function searchClientOnline(clientId) {
    if (!navigator.onLine || !window.OOXII_CONFIG_VALID || !cachedContext) return null;
    try {
      const { data, error } = await window.OOXII_SUPABASE
        .from('client_sessions').select('*')
        .eq('client_id', clientId).eq('festival_id', cachedContext.activeFestivalId)
        .maybeSingle();
      if (error || !data) return null;
      return data;
    } catch (e) { return null; }
  }

  /** Map a client_sessions row (server shape) onto the same session object
   *  shape state.sessions already uses — no personal fields exist in either
   *  shape (the schema itself has none to leak). */
  function serverRowToSession(row) {
    if (!row) return null;
    return {
      id: row.client_id, status: row.status, version: row.version, time: row.updated_at,
      intake: { ageBand: row.age_band, gender: row.gender, village: row.village, cataract: row.cataract },
      distance: row.distance, near: row.near, wheel: row.wheel, paddle: row.paddle,
      dispense: row.dispense, exit: row.exit_data,
    };
  }

  /** Search Client's single data-access point — local-first (IndexedDB, then
   *  the in-memory demo/seed fallback), enhanced with a server lookup when
   *  online. Never overwrites a newer local record with an older server
   *  snapshot; reports which of local/server "won" plus a sync-status label
   *  the screen can render directly. This is the ONLY place that touches
   *  IndexedDB or Supabase for a search — index.html's screen function just
   *  calls this and renders the result. */
  async function searchClient(clientId) {
    const localRaw = await window.OOXII_DB.sessions.get(clientId);
    const st = appState();
    const localFallback = (!localRaw && st && st.sessions) ? (st.sessions[clientId] || null) : null;
    const local = localRaw || localFallback;

    const serverRow = await searchClientOnline(clientId);
    const server = serverRowToSession(serverRow);

    if (!local && !server) return null;

    const [pendingEvents, conflicts] = await Promise.all([
      window.OOXII_DB.pendingEvents.all(), window.OOXII_DB.conflicts.all(),
    ]);
    const hasPending = pendingEvents.some((e) => e.clientId === clientId);
    const hasConflict = conflicts.some((c) => c.clientId === clientId);

    const localVersion = local ? (local.version || 0) : -1;
    const serverVersion = server ? (server.version || 0) : -1;
    // preserve newer local unsynchronised data over an older server snapshot
    const preferLocal = !!local && (hasPending || !server || localVersion >= serverVersion);
    const merged = preferLocal ? local : Object.assign({}, local, server);

    let syncStatus;
    if (hasConflict) syncStatus = 'conflicted';
    else if (hasPending) syncStatus = 'pending';
    else if (merged.status === 'Finalised' && server) syncStatus = 'finalised';
    else if (server) syncStatus = 'synced';
    else syncStatus = 'local_only';

    return { session: merged, syncStatus, source: preferLocal ? 'local' : 'server' };
  }

  window.OOXII_BACKEND = {
    boot, recordEvent, refreshCachedContext, searchClientOnline, searchClient,
    refreshHoneySummary, getHoneyDisplayTotals, getCachedHoneyDisplayTotalsSync,
    refreshHoneyDisplayCache, getCachedContext: () => cachedContext,
  };
})();
