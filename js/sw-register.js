/*
  js/sw-register.js — registers sw.js (the offline app-shell service worker)
  and drives the "a new version is ready" update prompt. A no-op on file://
  (service workers are unavailable there) and in any browser without
  navigator.serviceWorker — the app already works without a service worker,
  this only adds guaranteed offline reopening on top.
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
      + 'display:flex;gap:10px;align-items:center';
    const span = document.createElement('span');
    span.textContent = 'Update available — reload when safe';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Reload';
    btn.style.cssText = 'background:#1cc3d6;color:#0b0d24;border:none;border-radius:8px;'
      + 'padding:6px 10px;font-weight:600;cursor:pointer';
    btn.onclick = () => { el.remove(); onReload(); };
    el.appendChild(span);
    el.appendChild(btn);
    document.body.appendChild(el);
  }

  function requestSkipWaiting(reg) {
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

    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // An update was already installed and waiting before this page load.
      if (reg.waiting && navigator.serviceWorker.controller) {
        showUpdateToast(() => requestSkipWaiting(reg));
      }
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // navigator.serviceWorker.controller already being set means this
          // is an UPDATE to an app that's already running, not the very
          // first install — only then is a reload prompt meaningful.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateToast(() => requestSkipWaiting(reg));
          }
        });
      });
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
