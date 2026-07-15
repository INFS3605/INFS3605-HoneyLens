/*
  js/indexed-db.js — local-first persistence. This is the ONLY file that
  touches the IndexedDB API directly; everything else goes through
  window.OOXII_DB. Survives refresh, browser close/reopen, and total loss of
  connectivity — the app's primary store, with Supabase as the synchronised
  system of record once connectivity is available.

  Stores:
    sessions          — canonical local session records (same shape the app
                         already renders from `state.sessions[id]`)
    pending_events     — clinical/admin events not yet confirmed synced
    synced_event_ids   — ids of events the server has confirmed (idempotency)
    device              — one row: this device's local identity
    context             — one row: signed-in user + festival + station context
    sync_meta           — one row: pending/failed/conflict counts, last sync time
    conflicts            — unresolved sync conflicts pulled from the server
    offline_permit        — one row: encrypted 30-day offline auth permit
*/
(function () {
  'use strict';

  const DB_NAME = 'ooxii_db';
  const DB_VERSION = 1;
  const STORES = ['sessions', 'pending_events', 'synced_event_ids', 'device', 'context', 'sync_meta', 'conflicts', 'offline_permit'];

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
    });
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

  window.OOXII_DB = {
    open, put, get, getAll, remove, clearStore,
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
      clearStore('context'), clearStore('conflicts'), clearStore('sync_meta'),
    ]),
  };
})();
