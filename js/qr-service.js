/*
  js/qr-service.js — real QR generation and real camera scanning.

  Generation reuses the qrcodejs CDN library index.html already loads (with
  its existing plain-text fallback if that CDN script fails to load).

  Scanning uses the html5-qrcode CDN library (global `Html5Qrcode`) for real
  rear-camera scanning with a visible preview + scan frame, plus a QR-image
  upload fallback using the same library's file-based decoder. EVERY decoded
  payload — camera, image upload, or the DEMO_MODE simulated picker already
  in index.html — is passed through the app's single
  `handleScannedPayload()` validation function. This file never duplicates
  that validation.

  Camera permission is requested only when startCameraScan() is called (i.e.
  only after the tester presses "Scan QR"), never on page load. Works fully
  offline once the page and this CDN script have loaded once — no network
  call is made to move the QR payload between devices.
*/
(function () {
  'use strict';

  const READER_ELEMENT_ID = 'qr-camera-reader';
  // 260-320px range for a comfortably scannable handover QR; index.html's
  // handover modal is sized to fit this (see showHandoverQR).
  const QR_SIZE_PX = 280;
  let html5QrCode = null;
  let scanning = false;
  let lastHandledText = null;
  let lastHandledAt = 0;

  /** DEMO_MODE gates the simulated pick-from-list scanner already built into
   *  index.html (openScanner/simulateScan) — real camera scanning is always
   *  offered first; the simulated list stays available for local dev/demo
   *  when there's no real backend (or ?demo=1) so the app is still walkable
   *  without a second physical device. */
  function isDemoMode() {
    return window.OOXII_SESSIONS ? window.OOXII_SESSIONS.demoSeedAllowed() : true;
  }

  function cameraSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && typeof window.Html5Qrcode !== 'undefined';
  }

  /** Real QR generation. Returns true on success, false if the library isn't
   *  loaded or generation genuinely failed (e.g. this vendored qrcodejs
   *  build throws once a payload exceeds its encodable capacity — confirmed
   *  happens for a fully-populated handover payload, ~2.3KB+, at the
   *  library's default error-correction level). The caller (index.html's
   *  showHandoverQR) decides what the tester sees on failure — this
   *  function NEVER renders the raw payload text itself; that was the
   *  reported production bug (a white box showing the JSON as plain text
   *  instead of a scannable QR). */
  function renderQrInto(targetEl, payloadString) {
    console.info('[QR TRACE] renderQrInto() entered', {
      payload_length: payloadString ? payloadString.length : null,
      QRCodeExists: !!window.QRCode,
      fflateExists: !!window.fflate,
    });
    targetEl.innerHTML = '';
    if (!window.QRCode) {
      console.error('[OOXii] QRCode library (js/vendor/qrcode.min.js) did not load — cannot render a QR code.');
      return false;
    }
    try {
      // Error-correction level L (lowest redundancy, maximum data capacity)
      // — deliberately not the library's default (M). The handover payload
      // legitimately runs to 2-3KB once Wheel/Paddle/notes are all
      // populated, and this QR is shown on a clean screen and scanned
      // immediately, not printed or handled — physical-damage resilience
      // matters far less here than fitting the complete, unmodified payload.
      new QRCode(targetEl, { text: payloadString, width: QR_SIZE_PX, height: QR_SIZE_PX, correctLevel: QRCode.CorrectLevel.L });
      console.info('[QR TRACE] renderQrInto() succeeded', { payload_length: payloadString ? payloadString.length : null });
      return true;
    } catch (e) {
      console.error('[QR TRACE] renderQrInto() threw', { payload_length: payloadString ? payloadString.length : null, message: e.message, stack: e.stack });
      targetEl.innerHTML = '';
      return false;
    }
  }

  function dedupeGuard(text) {
    const now = Date.now();
    if (text === lastHandledText && now - lastHandledAt < 4000) return false; // same QR re-detected mid-stop
    lastHandledText = text;
    lastHandledAt = now;
    return true;
  }

  async function pickRearCameraId() {
    try {
      const cameras = await window.Html5Qrcode.getCameras();
      if (!cameras || !cameras.length) return null;
      const rear = cameras.find((c) => /back|rear|environment/i.test(c.label));
      return (rear || cameras[cameras.length - 1]).id;
    } catch (e) {
      return null; // e.g. iOS Safari before permission is granted — fall back to facingMode
    }
  }

  /** Starts the live camera preview into #<readerElementId> and calls
   *  onDecoded(text) exactly once per distinct QR, then stops the camera
   *  immediately (per spec: never keep scanning after a valid read). */
  async function startCameraScan({ readerElementId = READER_ELEMENT_ID, onDecoded, onError } = {}) {
    if (!cameraSupported()) {
      onError && onError('camera_unsupported');
      return;
    }
    if (scanning) return;
    lastHandledText = null;

    try {
      html5QrCode = new window.Html5Qrcode(readerElementId, /* verbose= */ false);
      const cameraId = await pickRearCameraId();
      const cameraConfig = cameraId ? { deviceId: { exact: cameraId } } : { facingMode: { ideal: 'environment' } };

      scanning = true;
      await html5QrCode.start(
        cameraConfig,
        { fps: 10, qrbox: { width: 240, height: 240 } },
        async (decodedText) => {
          if (!dedupeGuard(decodedText)) return;
          await stopCameraScan(); // stop immediately on any valid decode
          onDecoded && onDecoded(decodedText);
        },
        () => { /* per-frame "no QR found" — not an error, ignore */ }
      );
    } catch (err) {
      scanning = false;
      const msg = String((err && err.message) || err || '');
      if (/permission|denied|NotAllowed/i.test(msg)) onError && onError('permission_denied');
      else if (/NotFound|no camera/i.test(msg)) onError && onError('no_camera');
      else onError && onError('camera_error');
    }
  }

  async function stopCameraScan() {
    if (!html5QrCode || !scanning) { scanning = false; return; }
    try { await html5QrCode.stop(); await html5QrCode.clear(); } catch (e) { /* already stopped */ }
    scanning = false;
  }

  /** Image-upload fallback — used when camera access fails or isn't available. */
  async function scanFromImageFile(file, { onDecoded, onError } = {}) {
    if (typeof window.Html5Qrcode === 'undefined') { onError && onError('camera_unsupported'); return; }
    const tempId = 'qr-file-scan-tmp';
    let holder = document.getElementById(tempId);
    if (!holder) {
      holder = document.createElement('div');
      holder.id = tempId;
      holder.style.display = 'none';
      document.body.appendChild(holder);
    }
    try {
      const scanner = new window.Html5Qrcode(tempId, false);
      const decodedText = await scanner.scanFile(file, false);
      onDecoded && onDecoded(decodedText);
    } catch (err) {
      onError && onError('invalid_image');
    }
  }

  window.OOXII_QR = {
    renderQrInto, startCameraScan, stopCameraScan, scanFromImageFile,
    cameraSupported, isDemoMode, READER_ELEMENT_ID,
  };
})();
