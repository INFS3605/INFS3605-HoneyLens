/*
  js/indexed-db.js — local-first persistence. This is the ONLY file that
  touches the IndexedDB API directly; everything else goes through
  window.OOXII_DB. Survives refresh, browser close/reopen, and total loss of
  connectivity — the app's primary store, with Supabase as the synchronised
  system of record once connectivity is available.

  Stores:
    sessions          — canonical local session records (same shape the app
                         already renders from `state.sessions[id]`)
    pending_events     — clinical/admin events not yet confirmed synced (this
                         device's own outbox, going TO Supabase)
    synced_event_ids   — ids of THIS device's own events the server has
                         confirmed (idempotency for the outbox above)
    imported_events    — ids of QR handovers RECEIVED from another device,
                         already applied locally — a re-scan of the same QR
                         is recognised here without re-processing anything
    device              — one row: this device's local identity
    context             — one row: signed-in user + festival + station context
    sync_meta           — one row: pending/failed/conflict counts, last sync time
    conflicts            — unresolved sync conflicts pulled from the server
    offline_permit        — one row: encrypted 30-day offline auth permit
*/
(function () {
  'use strict';

  const DB_NAME = 'ooxii_db';
  const DB_VERSION = 2;
  const STORES = ['sessions', 'pending_events', 'synced_event_ids', 'imported_events', 'device', 'context', 'sync_meta', 'conflicts', 'offline_permit'];

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of STORES) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: 'id' });
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      // Without this, a version-upgrade request that's blocked by another
      // open connection to the same database (e.g. a second tab left open
      // on an older version of the app) fires NEITHER onsuccess NOR
      // onerror — it just sits there. Every caller of open() (including
      // getCurrentContext(), which the startup/auth path depends on) would
      // hang forever with no error and no visible sign anything was wrong.
      // Reproduced directly during testing. Reject visibly instead.
      req.onblocked = () => {
        const err = new Error('IndexedDB open blocked — another tab may have this database open on an older version. Close other tabs of this app and reload.');
        err.code = 'INDEXEDDB_BLOCKED'; // lets callers (index.html's boot()) show the specific "close other tabs" message rather than a generic failure
        reject(err);
      };
    });
    dbPromise.catch(() => { dbPromise = null; }); // allow a retry (e.g. after the tester closes the other tab) instead of caching the failure forever
    return dbPromise;
  }

  function tx(storeName, mode) {
    return open().then((db) => db.transaction(storeName, mode).objectStore(storeName));
  }

  function put(storeName, value) {
    return tx(storeName, 'readwrite').then((store) => new Promise((resolve, reject) => {
      const req = store.put(value);
      req.onsuccess = () => resolve(value);
      req.onerror = () => reject(req.error);
    }));
  }

  function get(storeName, key) {
    return tx(storeName, 'readonly').then((store) => new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    }));
  }

  function getAll(storeName) {
    return tx(storeName, 'readonly').then((store) => new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    }));
  }

  function remove(storeName, key) {
    return tx(storeName, 'readwrite').then((store) => new Promise((resolve, reject) => {
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    }));
  }

  function clearStore(storeName) {
    return tx(storeName, 'readwrite').then((store) => new Promise((resolve, reject) => {
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    }));
  }

  // ---- convenience helpers for the single-row stores ----
  const singleRow = (storeName) => ({
    get: () => get(storeName, 'current'),
    set: (data) => put(storeName, Object.assign({}, data, { id: 'current' })),
    clear: () => remove(storeName, 'current'),
  });

  /** Best-effort request that the browser NOT evict this origin's storage
   *  under pressure (relevant because a whole festival's clinical data lives
   *  only in IndexedDB until it syncs). Never blocks the app — the browser
   *  may silently ignore this on some platforms (notably iOS Safari), and
   *  that is an acceptable, expected outcome, not an error. Cache Storage
   *  (the service worker's app-shell cache) and IndexedDB are separate
   *  systems with separate lifecycles; this only concerns IndexedDB/
   *  localStorage durability, never ties into the service worker's cache. */
  async function requestPersistentStorage() {
    try {
      if (!(navigator.storage && navigator.storage.persist)) {
        console.info('[OOXii] Persistent storage API not available in this browser — skipping (not fatal).');
        return null;
      }
      const alreadyPersisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      const granted = alreadyPersisted || await navigator.storage.persist();
      console.info('[OOXii] Persistent storage ' + (granted ? 'granted' : 'NOT granted (browser may evict local data under storage pressure)') + '.');
      return granted;
    } catch (e) {
      console.info('[OOXii] Persistent storage request failed — continuing without it (not fatal).', e);
      return null;
    }
  }
  // Fire-and-forget at load: best-effort by definition, nothing downstream
  // depends on this having resolved.
  requestPersistentStorage();

  window.OOXII_DB = {
    open, put, get, getAll, remove, clearStore, requestPersistentStorage,
    sessions: {
      put: (s) => put('sessions', s),
      get: (id) => get('sessions', id),
      all: () => getAll('sessions'),
      remove: (id) => remove('sessions', id),
    },
    pendingEvents: {
      put: (e) => put('pending_events', e),
      get: (id) => get('pending_events', id),
      all: () => getAll('pending_events'),
      remove: (id) => remove('pending_events', id),
    },
    syncedEventIds: {
      mark: (id) => put('synced_event_ids', { id, syncedAt: new Date().toISOString() }),
      has: (id) => get('synced_event_ids', id).then((r) => !!r),
    },
    importedEvents: {
      mark: (id, meta) => put('imported_events', Object.assign({ id, importedAt: new Date().toISOString() }, meta || {})),
      has: (id) => get('imported_events', id).then((r) => !!r),
      get: (id) => get('imported_events', id),
    },
    device: singleRow('device'),
    context: singleRow('context'),
    syncMeta: singleRow('sync_meta'),
    offlinePermit: singleRow('offline_permit'),
    conflicts: {
      put: (c) => put('conflicts', c),
      all: () => getAll('conflicts'),
      remove: (id) => remove('conflicts', id),
    },
    /** Wipe everything except the offline permit and device identity — used
     *  on sign-out after the user has been warned about unsynced records. */
    wipeClinicalData: () => Promise.all([
      clearStore('sessions'), clearStore('pending_events'), clearStore('synced_event_ids'),
      clearStore('imported_events'), clearStore('context'), clearStore('conflicts'), clearStore('sync_meta'),
    ]),
  };
})();
