// VBB likeness perturbation — semantic (not per-landmark) transforms.
//
// WHY NOT JITTER (session 2026-07-16, and prior human experiment): independent
// per-point noise was "disastrous". Faces sit on a low-dimensional manifold —
// the 68 landmarks are heavily correlated — so independent noise leaves the
// manifold immediately and renders a lumpy non-face rather than a different
// face. Semantic transforms stay ON the manifold: every output is a plausible
// face, just not the actual one. (poc/toon-calibration-v2.html reached the
// same conclusion independently; its applySemanticTransform is the richer
// 11-axis version of this.)
//
// WHICH AXES — the rigid/drift split (session 2026-07-16):
//   Drift axes change naturally between issuance and presentation (weight,
//   haircut, ageing). The gatekeeper must ALREADY tolerate them, because the
//   credential is months or years old — so perturbing along them costs little
//   recognisability that isn't already being paid, and the change is deniable:
//   nobody can tell perturbation from a haircut.
//   Rigid axes (eye spacing, nose structure, iris colour, skull proportion) do
//   NOT drift. Perturbing them reads as *wrong* rather than as change — likely
//   part of why per-point jitter failed, since it perturbed rigid structure.
// Consequence: discriminating power comes from rigid features, unlinkability
// from drift features, and no single feature gives both.
//
// SEEDING (D1 extended to the likeness channel): the seed is the COMBINED
// nonce N = f(N_v, N_p). Verifier-only seeding lets a venue replay one seed and
// recover a stable rendering across visits — which is exactly the correlation
// handle the perturbation exists to destroy. Prover-only seeding lets Bob grind
// for a flattering or conveniently ambiguous rendering. Combined, neither steers it.
//
// PASS-1 LIMIT (honest): this runs VERIFIER-SIDE at render time. Bob still ships
// likeness_data in the clear, so pass 1 has no likeness privacy whatever the
// perturbation does. Per D7, the real thing computes L' = f(L, N) IN-CIRCUIT
// with N public — otherwise Bob just sends whatever he likes and the nonce is
// decoration. That makes f part of the circuit, so f must stay cheap in
// constraints. This module is the shape of f, not a security boundary.
'use strict';

(function (global) {
  // Drift axes only. Deliberately omits eyeSpacing / noseLength / noseWidth /
  // earScale — those are rigid, and perturbing them reads as error.
  const DRIFT_AXES = {
    faceWidth: 1,       // weight change
    jawTaper: 1,        // weight change, lower face
    foreheadHeight: 1,  // hairline recession / ageing
  };

  function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
      t = (t + 0x6D2B79F5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Fold an arbitrary-length decimal string (the combined nonce N) plus a
  // variant index into a 32-bit seed. FNV-1a.
  function seedFrom(N, variantIndex) {
    let h = 0x811c9dc5;
    const s = String(N) + ':' + variantIndex;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function metrics(p) {
    const browY = Math.min(...[17,18,19,20,21,22,23,24,25,26].map((i) => p[i].y));
    const chinY = p[8].y;
    const cx = p.reduce((s, q) => s + q.x, 0) / p.length;
    return { browY, chinY, cx, faceH: Math.max(1, chinY - browY) };
  }

  // Apply drift-axis transforms. `axes` values are multipliers around 1.0.
  function applyDrift(positions, axes) {
    const a = Object.assign({}, DRIFT_AXES, axes || {});
    const m = metrics(positions);
    return positions.map((pt, i) => {
      let x = pt.x, y = pt.y;

      // faceWidth — horizontal scale about the face centre (weight)
      x = m.cx + (x - m.cx) * a.faceWidth;

      // jawTaper — extra horizontal scale, ramped in over the lower face only
      const t = Math.max(0, Math.min(1, (y - m.browY) / m.faceH));
      x = m.cx + (x - m.cx) * (1 + (a.jawTaper - 1) * t);

      // foreheadHeight — lift the brow/upper contour (hairline, ageing)
      if (y < m.browY + m.faceH * 0.12) {
        y = m.browY - (m.browY - y) * a.foreheadHeight;
      }
      return { x, y };
    });
  }

  // The pass-1 shape of f: L' = perturb(L, N, variantIndex).
  // `intensity` is a fraction of face size, matching v2's perturbation panel
  // (default 0.04 there). Each axis is drawn from [1-intensity, 1+intensity].
  function perturb(positions, N, variantIndex, intensity) {
    const i = intensity == null ? 0.05 : intensity;
    const rnd = mulberry32(seedFrom(N, variantIndex));
    const axes = {};
    Object.keys(DRIFT_AXES).forEach((k) => { axes[k] = 1 + (rnd() * 2 - 1) * i; });
    return { positions: applyDrift(positions, axes), axes };
  }

  // k deterministic variants from one combined nonce — what the gatekeeper sees.
  function variants(positions, N, k, intensity) {
    return Array.from({ length: k }, (_, i) => perturb(positions, N, i, intensity));
  }

  global.VBBPerturb = { perturb, variants, applyDrift, seedFrom, mulberry32, DRIFT_AXES };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.VBBPerturb;
})(typeof window !== 'undefined' ? window : globalThis);
