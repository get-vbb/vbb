// VBB QR transport — display + camera capture for the Bob <-> Bouncer hops.
//
// Payload sizes (measured, session 2026-07-16):
//   challenge (Bouncer -> Bob) : ~194 chars JSON  -> 73-module QR at EC H
//   proof     (Bob -> Bouncer) : 944 base64 chars -> 117-module QR at EC M
//                                                    (153 modules at EC H)
// The proof only fits because vbb-codec.js packs it (7370 B JSON -> 707 B).
// Raw JSON exceeds ANY single QR, so the codec is a hard dependency, not an
// optimisation. Multi-frame cycling is therefore not needed.
//
// EC default is M: 117 modules is a good balance for a phone camera. EC H (153
// modules) survives more damage but is dense enough to fuss on small screens.
//
// Libraries are vendored in app/vendor/ (qrcode-generator, jsQR), not CDN —
// verification is offline by design (Q4), and CDN deps at verification time
// would break that. Camera capture needs a secure context: localhost is fine,
// a LAN IP is not (use localhost or https).
'use strict';

(function (global) {
  const DEFAULT_EC = 'M';

  function render(el, text, opts) {
    const o = Object.assign({ ec: DEFAULT_EC, cellSize: 4, margin: 8 }, opts || {});
    if (typeof qrcode === 'undefined') throw new Error('qrcode-generator not loaded (app/vendor/qrcode.min.js)');
    const qr = qrcode(0, o.ec); // 0 = smallest version that fits
    qr.addData(text, 'Byte');
    qr.make();
    el.innerHTML = qr.createImgTag(o.cellSize, o.margin);
    const img = el.querySelector('img');
    if (img) { img.style.width = '100%'; img.style.height = 'auto'; img.style.imageRendering = 'pixelated'; }
    return { modules: qr.getModuleCount(), chars: text.length, ec: o.ec };
  }

  // Camera scanner. onResult(text) fires once, then the stream stops — these
  // are one-shot hops, not a continuous reader.
  function Scanner(videoEl, onResult, onError) {
    let stream = null, raf = null, done = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    async function start() {
      if (typeof jsQR === 'undefined') throw new Error('jsQR not loaded (app/vendor/jsQR.js)');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('no camera API — needs a secure context (localhost or https)');
      }
      done = false;
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }, audio: false,
      });
      videoEl.srcObject = stream;
      videoEl.setAttribute('playsinline', 'true');
      await videoEl.play();
      tick();
    }

    function tick() {
      if (done) return;
      if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
        canvas.width = videoEl.videoWidth;
        canvas.height = videoEl.videoHeight;
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        try {
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          if (code && code.data) { done = true; stop(); onResult(code.data); return; }
        } catch (e) { if (onError) onError(e); }
      }
      raf = requestAnimationFrame(tick);
    }

    function stop() {
      done = true;
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
      videoEl.srcObject = null;
    }

    return { start, stop };
  }

  global.VBBQR = { render, Scanner, DEFAULT_EC };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.VBBQR;
})(typeof window !== 'undefined' ? window : globalThis);
