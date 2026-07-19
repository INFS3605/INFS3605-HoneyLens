/*
  js/sw-register.js — registers sw.js (the offline app-shell service worker)
  and drives the "a new version is ready" update prompt. A no-op on file://
  (service workers are unavailable there) and in any browser without
  navigator.serviceWorker — the app already works without a service worker,
  this only adds guaranteed offline reopening on top.

  Update policy: a new worker is installed in the background and sits in
  "waiting" — it NEVER takes over on its own. The tester decides when it's
  safe by pressing "Reload and update" on the non-blocking prompt below.
  This is deliberate: silently swapping app code out from under a tester
  mid-eye-test is worse than running one version behind for a while.
*/
(function () {
  'use strict';

  function showUpdateToast(onReload) {
    if (document.getElementById('sw-update-toast')) return;
    const el = document.createElement('div');
    el.id = 'sw-update-toast';
    el.setAttribute('role', 'status');
    el.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99999;'
      + 'background:#1e2157;color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:12px;'
      + 'padding:10px 14px;font:13px/1.4 system-ui,-apple-system,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35);'
      + 'display:flex;gap:10px;align-items:center;max-width:min(90vw,420px)';
    const span = document.createElement('span');
    span.textContent = 'App update available. Reload when it is safe to pause testing.';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Reload and update';
    btn.style.cssText = 'background:#1cc3d6;color:#0b0d24;border:none;border-radius:8px;'
      + 'padding:6px 10px;font-weight:600;cursor:pointer;white-space:nowrap';
    btn.onclick = onReload;
    el.appendChild(span);
    el.appendChild(btn);
    document.body.appendChild(el);
    return el;
  }

  /** Best-effort check that nothing on screen would lose data if reloaded
   *  right now — a clinical form mid-entry, or a QR handover modal (mid
   *  device-to-device handoff). index.html exposes this; if it hasn't
   *  loaded for some reason, fail safe (treat as NOT safe) rather than risk
   *  losing a tester's unsaved work. */
  function safeToReloadNow() {
    if (typeof window.OOXII_SAFE_TO_RELOAD_NOW !== 'function') return false;
    try { return !!window.OOXII_SAFE_TO_RELOAD_NOW(); } catch (e) { return false; }
  }

  function requestSkipWaiting(reg, toastEl) {
    if (!safeToReloadNow()) {
      if (typeof window.toast === 'function') {
        window.toast('Finish or close the current step first, then tap Reload and update again.', 'warn');
      }
      return; // leave the toast up — the tester can retry once it's safe
    }
    if (toastEl) toastEl.remove();
    if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
  }

  function init() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol === 'file:') return; // service workers are unavailable on file://

    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return; // guard against firing twice
      refreshing = true;
      window.location.reload();
    });

    // updateViaCache:'none' — sw.js itself must never be served from the
    // browser's ordinary HTTP cache, or the browser's own periodic
    // "check for a new service worker" byte-comparison can compare against
    // a stale cached copy of sw.js and never notice a real update shipped.
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((reg) => {
      // An update was already installed and waiting before this page load.
      if (reg.waiting && navigator.serviceWorker.controller) {
        const toastEl = showUpdateToast(() => requestSkipWaiting(reg, toastEl));
      }
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // navigator.serviceWorker.controller already being set means this
          // is an UPDATE to an app that's already running, not the very
          // first install — only then is a reload prompt meaningful.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            const toastEl = showUpdateToast(() => requestSkipWaiting(reg, toastEl));
          }
        });
      });
      // Ask the browser to check for a newer sw.js right now (in addition
      // to its own periodic checks) whenever we're online at startup — this
      // is what actually surfaces a new version promptly instead of relying
      // on the browser's own check interval. Never forces activation; a
      // detected update still only reaches "waiting", same as above.
      if (navigator.onLine) {
        reg.update().catch(() => {});
      }
    }).catch((err) => {
      console.error('[OOXii] Service worker registration failed — offline QR handover after a full app close/reopen will not be guaranteed.', err);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
