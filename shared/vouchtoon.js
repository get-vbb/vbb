// VouchToon capture/render — extracted and adapted from poc/vouchtoon-poc.html.
// The PoC (poc/vouchtoon-poc.html) is left untouched as the historical prototype;
// this file is the shared version used by app/voucher.html (capture at issuance)
// and app/bouncer.html (render for the eyeball comparison at verification), and
// by poc/toon-calibration.html (the analysis/render tuning harness — see D9).
//
// Adaptation from the PoC: the PoC ran capture+render together, at "presentation"
// time, on an uploaded photo. Here capture and render are split — voucher.html
// captures at issuance and ships the extracted feature data in the credential;
// bouncer.html only renders, from feature data it received, never from a photo.
//
// Settings plumbing (D9, v0.6): captureFace/renderCartoon accept an optional
// settings object, split into an `analysis` group (Issuer-side — bakes into the
// credential's `L`) and a `render` group (Verifier-side — style only, never
// changes sampled values). Omitting settings reproduces DEFAULT_SETTINGS, so
// voucher.html/bouncer.html are unchanged. The calibration harness is the only
// caller that passes non-default settings today.
'use strict';

(function (global) {
  const MODELS = '../shared/vendor/weights';
  let modelsReady = false;

  async function loadModels() {
    if (modelsReady) return;
    if (typeof faceapi === 'undefined') {
      throw new Error('face-api.js not loaded (expected a global `faceapi` from the CDN script tag)');
    }
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODELS);
    await faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODELS);
    modelsReady = true;
  }

  // ── Default settings ─────────────────────────────────────────────────────
  // `analysis` bakes into the credential's L (Issuer-side); `render` is
  // style-only and never touches sampled values (Verifier-side).
  //
  // The skin-tone defect (Q8): sampleSkinRobust used to sample directly on the
  // jaw-contour landmarks (indices 1,15,4,12,3,13), which sit ON the face's
  // silhouette edge, not inside it. Roughly half of each sample box fell
  // outside the face — background, hair, or jaw shadow — dragging the trimmed
  // mean away from true skin colour (observed: a white subject rendering with
  // dark skin, because the contaminating pixels were darker than the face).
  // The fix is `skin.inset`: each sample point is pulled a fraction of the way
  // from its landmark toward an interior reference point (the nose tip, p[30])
  // before sampling, moving the box off the boundary and onto actual cheek
  // skin. `inset: 0` reproduces the old (buggy) behaviour for comparison.
  const DEFAULT_SETTINGS = {
    analysis: {
      skin: {
        points: [1, 15, 4, 12, 3, 13],
        pad: 10,
        inset: 0.30,
        loFrac: 0.2, hiFrac: 0.2,
        adjR: 1.10, adjG: 1.04, adjB: 0.98, addR: 8, addG: 4,
        quant: 0, // 0 = no quantisation; else round each display channel to nearest N
      },
      hair: {
        pad: 10,
        browOffsetFrac: 0.30,
        nonSkinLumDelta: 18, nonSkinFracThreshold: 0.25,
        loFrac: 0.10, hiFrac: 0.10,
        greyLumThreshold: 155, greySatThreshold: 32,
        quant: 0,
      },
      beard: {
        pad: 7,
        lumRatioThreshold: 0.76,
      },
      glasses: {
        pad: 5,
        darkLumRatio: 0.65,
        darkFracThreshold: 0.28,
      },
      landmarkRound: 0, // 0 = no rounding; N = quantize positions to nearest N px
    },
    render: {
      lineWeightScale: 1.0,
      colorSaturation: 1.0, // style-only remap of already-sampled colour; never re-samples
      eyeEmphasis: 1.0,
      warmth: 0,            // 0 = true sampled skin; 1 = the legacy warm cast (displayRgb)
    },
  };

  // ── Identity enums (graduated from poc/vouchtoon-lab.js) ─────────────────
  // These are the operator-selectable, quantised likeness axes. They are the
  // SOURCE OF TRUTH for ordering: vbb-crypto.js (packLikeness → LC) and
  // vbb-codec.js (QR encode) index into these lists, so their order is part of
  // the committed `L` contract — appending is safe, reordering is not.
  const HAIR_STYLES   = ['bald', 'short', 'medium', 'long', 'curly'];
  const FRINGE_STYLES = ['none', 'centre', 'left', 'right', 'bowl'];
  const BEARD_STYLES  = ['none', 'stubble', 'goatee', 'full'];
  const IRIS_COLORS   = {
    brown: [92, 58, 34], hazel: [126, 98, 52], amber: [150, 105, 40],
    green: [86, 110, 70], blue: [74, 110, 150], grey: [120, 128, 136],
  };
  const IRIS_KEYS = Object.keys(IRIS_COLORS);

  const irisIndex        = (name) => Math.max(0, IRIS_KEYS.indexOf(name));
  const hairStyleIndex   = (s) => Math.max(0, HAIR_STYLES.indexOf(s));
  const fringeStyleIndex = (s) => Math.max(0, FRINGE_STYLES.indexOf(s));
  const beardStyleIndex  = (s) => Math.max(0, BEARD_STYLES.indexOf(s));
  const irisFromIndex        = (i) => IRIS_KEYS[i] || 'blue';
  const hairStyleFromIndex   = (i) => HAIR_STYLES[i] || 'short';
  const fringeStyleFromIndex = (i) => FRINGE_STYLES[i] || 'none';
  const beardStyleFromIndex  = (i) => BEARD_STYLES[i] || 'none';

  // Quantised brightness nudge on a sampled hair colour. The voucher applies
  // this into the stored hair.rgb (and mirrors it onto beard.rgb) BEFORE
  // committing, so it needs no field of its own and the verifier reproduces it.
  function tintRgb(rgb, shade) {
    const f = 1 + (shade || 0) * 0.10;
    return rgb.map((v) => Math.max(0, Math.min(255, Math.round(v * f))));
  }

  function mergeAnalysis(overrides) {
    const d = DEFAULT_SETTINGS.analysis;
    const o = overrides || {};
    return {
      skin: Object.assign({}, d.skin, o.skin),
      hair: Object.assign({}, d.hair, o.hair),
      beard: Object.assign({}, d.beard, o.beard),
      glasses: Object.assign({}, d.glasses, o.glasses),
      landmarkRound: o.landmarkRound !== undefined ? o.landmarkRound : d.landmarkRound,
    };
  }

  function mergeRender(overrides) {
    return Object.assign({}, DEFAULT_SETTINGS.render, overrides || {});
  }

  // Runs face detection + landmark extraction + feature sampling on an
  // already-drawn canvas. Returns null if no face is found, otherwise
  // { positions: [{x,y} x68], score, skin, hair, beard, glasses }
  // where skin/hair/beard/glasses match the PoC's feature-extraction shape.
  // `settings.analysis` (see DEFAULT_SETTINGS) tunes sampling; omitted fields
  // fall back to defaults, so existing callers are unaffected.
  async function captureFace(canvas, settings) {
    if (!modelsReady) await loadModels();
    const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.35 });
    const det = await faceapi.detectSingleFace(canvas, opts).withFaceLandmarks(true);
    if (!det) return null;

    const a = mergeAnalysis(settings && settings.analysis);
    let pts = det.landmarks.positions.map((p) => ({ x: p.x, y: p.y }));
    if (a.landmarkRound > 0) pts = pts.map((pt) => quantizePoint(pt, a.landmarkRound));

    const ctx = canvas.getContext('2d');
    const skinData = sampleSkinRobust(ctx, pts, a.skin);
    const hairColor = sampleHair(ctx, pts, skinData.rgb, a.hair);
    const beardData = detectBeard(ctx, pts, skinData.rgb, a.beard);
    const hasGlasses = detectGlasses(ctx, pts, skinData.rgb, a.glasses);

    // Identity axes (graduated from the lab). Auto-detect only SEEDS these; the
    // voucher operator corrects them from the enum lists (the D9 identikit path).
    const iris = sampleIris(ctx, pts);
    const beardStyle = guessBeardStyle(ctx, pts, skinData.rgb);
    // Beard colour follows hair colour (session direction, 2026-07-18).
    beardData.rgb = hairColor.rgb.slice();
    beardData.color = hairColor.css;

    return {
      positions: pts,
      score: det.detection.score,
      skin: skinData,
      hair: hairColor,
      beard: beardData,
      glasses: hasGlasses,
      iris: iris.name,
      hairStyle: guessHairStyle(ctx, pts, hairColor),
      fringeStyle: guessFringe(ctx, pts, hairColor),
      beardStyle,
    };
  }

  // ── Landmark overlay (used by voucher.html to show the capture worked) ──────
  function overlayLandmarks(ctx, p, W) {
    const lw = Math.max(1, W / 350);
    ctx.strokeStyle = 'rgba(77,143,212,0.8)';
    ctx.fillStyle = '#4d8fd4';
    ctx.lineWidth = lw;
    const segs = [
      [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],
      [17,18,19,20,21], [22,23,24,25,26],
      [27,28,29,30,31,32,33,34,35],
      [36,37,38,39,40,41,36], [42,43,44,45,46,47,42],
      [48,49,50,51,52,53,54,55,56,57,58,59,48],
      [60,61,62,63,64,65,66,67,60],
    ];
    segs.forEach(s => {
      ctx.beginPath();
      ctx.moveTo(p[s[0]].x, p[s[0]].y);
      for (let i=1; i<s.length; i++) ctx.lineTo(p[s[i]].x, p[s[i]].y);
      ctx.stroke();
    });
    p.forEach(pt => {
      ctx.beginPath(); ctx.arc(pt.x, pt.y, lw*1.5, 0, Math.PI*2); ctx.fill();
    });
  }

  // ── Sample-region overlay (calibration harness diagnostic) ──────────────────
  // Returns the boxes actually used for palette sampling, in the same
  // geometry sampleSkinRobust/sampleHair/detectBeard/detectGlasses use, so the
  // harness can draw them over the source photo — this is what makes the
  // skin-tone bug (and its fix) visible rather than inferred.
  function getSampleRegions(p, analysisSettings) {
    const a = mergeAnalysis(analysisSettings);
    const regions = [];
    const center = p[30] || avgPoint(p);

    a.skin.points.forEach((i) => {
      const pt = insetPoint(p[i], center, a.skin.inset);
      regions.push(box('skin', pt, a.skin.pad));
    });
    hairSamplePoints(p, a.hair).forEach((pt) => regions.push(box('hair', pt, a.hair.pad)));
    [p[5],p[6],p[7],p[8],p[9],p[10],p[11]].forEach((pt) => regions.push(box('beard', pt, a.beard.pad)));
    [p[27],p[28],p[29],p[36],p[37],p[44],p[45]].forEach((pt) => regions.push(box('glasses', pt, a.glasses.pad)));

    return regions;
  }

  function box(feature, pt, pad) {
    return { feature, x: pt.x - pad, y: pt.y - pad, w: pad * 2, h: pad * 2 };
  }

  // ── Feature extraction ───────────────────────────────────────────────────
  function avgPoint(pts) {
    const n = pts.length;
    return { x: pts.reduce((s,p)=>s+p.x,0)/n, y: pts.reduce((s,p)=>s+p.y,0)/n };
  }

  function insetPoint(pt, center, frac) {
    return { x: pt.x + (center.x - pt.x) * frac, y: pt.y + (center.y - pt.y) * frac };
  }

  function quantizePoint(pt, step) {
    return { x: Math.round(pt.x / step) * step, y: Math.round(pt.y / step) * step };
  }

  function quantizeColor(rgb, step) {
    if (!step) return rgb;
    return rgb.map((c) => Math.max(0, Math.min(255, Math.round(c / step) * step)));
  }

  function sampleRegion(ctx, pts, pad=8) {
    const pixels = [];
    pts.forEach(pt => {
      try {
        const px = Math.max(0, (pt.x-pad)|0), py = Math.max(0, (pt.y-pad)|0);
        const pw = Math.min(ctx.canvas.width-px,  pad*2);
        const ph = Math.min(ctx.canvas.height-py, pad*2);
        if (pw<1||ph<1) return;
        const d = ctx.getImageData(px, py, pw, ph).data;
        for (let i=0; i<d.length; i+=4) pixels.push([d[i], d[i+1], d[i+2]]);
      } catch(e) {}
    });
    return pixels;
  }

  function trimmedMean(pixels, loFrac=0.2, hiFrac=0.2) {
    if (!pixels.length) return [220, 180, 150];
    const sorted = [...pixels].sort((a,b) => (a[0]+a[1]+a[2])-(b[0]+b[1]+b[2]));
    const lo = Math.floor(sorted.length * loFrac);
    const hi = Math.floor(sorted.length * hiFrac);
    const mid = sorted.slice(lo, sorted.length - hi);
    if (!mid.length) return [220, 180, 150];
    return [
      Math.round(mid.reduce((s,p)=>s+p[0],0)/mid.length),
      Math.round(mid.reduce((s,p)=>s+p[1],0)/mid.length),
      Math.round(mid.reduce((s,p)=>s+p[2],0)/mid.length),
    ];
  }

  // `s` = analysis.skin settings (see DEFAULT_SETTINGS). `s.inset` is the Q8
  // fix: pulls each jaw-contour sample point inward off the face silhouette
  // before sampling (see the comment on DEFAULT_SETTINGS for the root cause).
  function sampleSkinRobust(ctx, p, s) {
    s = s || DEFAULT_SETTINGS.analysis.skin;
    const center = p[30] || avgPoint(p);
    const pts = s.points.map((i) => insetPoint(p[i], center, s.inset));
    const pixels = sampleRegion(ctx, pts, s.pad);
    const [r,g,b] = trimmedMean(pixels, s.loFrac, s.hiFrac);
    const rr = Math.min(255, Math.round(r*s.adjR+s.addR));
    const gg = Math.min(255, Math.round(g*s.adjG+s.addG));
    const bb = Math.min(255, Math.round(b*s.adjB));
    const [qr,qg,qb] = quantizeColor([rr,gg,bb], s.quant);
    return { css: `rgb(${qr},${qg},${qb})`, rgb: [r,g,b], displayRgb: [qr,qg,qb] };
  }

  function hairSamplePoints(p, s) {
    const browY   = Math.min(...[17,18,19,20,21,22,23,24,25,26].map(i=>p[i].y));
    const faceH   = p[8].y - browY;
    const midX    = (p[17].x+p[21].x+p[22].x+p[26].x)/4;
    const span    = Math.abs(p[26].x - p[17].x);
    const sampleY = browY - faceH*s.browOffsetFrac;
    return [
      {x: midX,             y: sampleY},
      {x: midX - span*0.28, y: sampleY + faceH*0.04},
      {x: midX + span*0.28, y: sampleY + faceH*0.04},
      {x: midX - span*0.46, y: sampleY + faceH*0.08},
      {x: midX + span*0.46, y: sampleY + faceH*0.08},
    ];
  }

  function sampleHair(ctx, p, skinRGB, s) {
    s = s || DEFAULT_SETTINGS.analysis.hair;
    const pts = hairSamplePoints(p, s);
    const pixels = sampleRegion(ctx, pts, s.pad);
    if (!pixels.length) return { css: '#2c1e14', grey: false, rgb: [44,30,20] };

    const skinLum = (skinRGB[0]+skinRGB[1]+skinRGB[2]) / 3;
    const nonSkin = pixels.filter(([r,g,b]) => Math.abs((r+g+b)/3 - skinLum) > s.nonSkinLumDelta);
    const use = nonSkin.length > pixels.length * s.nonSkinFracThreshold ? nonSkin : pixels;

    const [r,g,b] = trimmedMean(use, s.loFrac, s.hiFrac);
    const lum = (r+g+b)/3;

    const sat = Math.max(r,g,b) - Math.min(r,g,b);
    if (lum > s.greyLumThreshold && sat < s.greySatThreshold) {
      const grey = Math.round(lum * (lum > 210 ? 0.90 : 0.95));
      const [qg] = quantizeColor([grey], s.quant);
      return { css: `rgb(${qg},${qg},${qg})`, grey: true, rgb: [qg,qg,qg] };
    }

    const df = lum > 210 ? 0.90 : lum > 175 ? 0.95 : 1.0;
    const rr = Math.max(0,Math.round(r*df)), gg = Math.max(0,Math.round(g*df)), bb = Math.max(0,Math.round(b*df));
    const [qr,qgc,qb] = quantizeColor([rr,gg,bb], s.quant);
    return { css: `rgb(${qr},${qgc},${qb})`, grey: false, rgb: [qr,qgc,qb] };
  }

  function detectBeard(ctx, p, skinRGB, s) {
    s = s || DEFAULT_SETTINGS.analysis.beard;
    const chinPts = [p[5],p[6],p[7],p[8],p[9],p[10],p[11]];
    const pixels  = sampleRegion(ctx, chinPts, s.pad);
    if (!pixels.length) return { detected: false, color: '#4a3020', rgb: [74,48,32] };
    const skinLum = (skinRGB[0]+skinRGB[1]+skinRGB[2]) / 3;
    const chinLum = pixels.reduce((s,[r,g,b])=>s+(r+g+b)/3, 0) / pixels.length;
    const detected = chinLum < skinLum * s.lumRatioThreshold;
    const sorted  = [...pixels].sort((a,b)=>(a[0]+a[1]+a[2])-(b[0]+b[1]+b[2]));
    const darkHalf = sorted.slice(0, Math.floor(sorted.length*0.5));
    const [r,g,b] = darkHalf.length ? trimmedMean(darkHalf, 0, 0) : [60,45,35];
    const rr = Math.max(0,Math.round(r*0.75)), gg = Math.max(0,Math.round(g*0.72)), bb = Math.max(0,Math.round(b*0.70));
    return { detected, color: `rgb(${rr},${gg},${bb})`, rgb: [rr,gg,bb] };
  }

  function detectGlasses(ctx, p, skinRGB, s) {
    s = s || DEFAULT_SETTINGS.analysis.glasses;
    const skinLum = (skinRGB[0]+skinRGB[1]+skinRGB[2]) / 3;
    const isDark  = pixels => {
      if (!pixels.length) return false;
      const dark = pixels.filter(([r,g,b]) => (r+g+b)/3 < skinLum*s.darkLumRatio).length;
      return dark / pixels.length > s.darkFracThreshold;
    };
    const bridge      = isDark(sampleRegion(ctx, [p[27],p[28],p[29]], s.pad));
    const rightTemple = isDark(sampleRegion(ctx, [p[36],p[37]],        s.pad));
    const leftTemple  = isDark(sampleRegion(ctx, [p[44],p[45]],        s.pad));
    return bridge && (rightTemple || leftTemple);
  }

  // ── Identity-axis detection (graduated from poc/vouchtoon-lab.js) ──────────
  // Iris: sample a disc at each eye centre, discard sclera (bright) and
  // pupil/lashes (dark), then snap to the nearest palette entry.
  function sampleIris(ctx, p) {
    const px = [];
    [[36, 41], [42, 47]].forEach(([s, e]) => {
      const ep = []; for (let i = s; i <= e; i++) ep.push(p[i]);
      const xs = ep.map((q) => q.x), ys = ep.map((q) => q.y);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const r = Math.max(2, (Math.max(...xs) - Math.min(...xs)) * 0.20);
      const x0 = Math.max(0, (cx - r) | 0), y0 = Math.max(0, (cy - r) | 0);
      const w = Math.min(ctx.canvas.width - x0, (r * 2) | 0);
      const h = Math.min(ctx.canvas.height - y0, (r * 2) | 0);
      if (w < 1 || h < 1) return;
      try {
        const d = ctx.getImageData(x0, y0, w, h).data;
        for (let i = 0; i < d.length; i += 4) {
          const lum = (d[i] + d[i + 1] + d[i + 2]) / 3;
          if (lum > 195 || lum < 42) continue;
          px.push([d[i], d[i + 1], d[i + 2]]);
        }
      } catch (e) {}
    });
    if (!px.length) return { rgb: IRIS_COLORS.brown, name: 'brown' };
    const rgb = trimmedMean(px, 0.2, 0.2);
    return { rgb, name: nearestIris(rgb) };
  }

  function nearestIris(rgb) {
    let best = 'brown', bd = Infinity;
    IRIS_KEYS.forEach((k) => {
      const v = IRIS_COLORS[k];
      const d = (v[0]-rgb[0])**2 + (v[1]-rgb[1])**2 + (v[2]-rgb[2])**2;
      if (d < bd) { bd = d; best = k; }
    });
    return best;
  }

  // Shared hair-colour probe used by the length and fringe guessers.
  function hairProbe(ctx, hair) {
    return (x, y) => {
      const px = Math.max(0, Math.min(ctx.canvas.width - 1, x | 0));
      const py = Math.max(0, Math.min(ctx.canvas.height - 1, y | 0));
      try {
        const d = ctx.getImageData(px, py, 1, 1).data;
        return Math.hypot(d[0]-hair.rgb[0], d[1]-hair.rgb[1], d[2]-hair.rgb[2]) < 62;
      } catch (e) { return false; }
    };
  }

  // Hair length: how tall above the brow, and does it hang past the jaw.
  // 'curly' is never guessed; texture is not separable this cheaply.
  function guessHairStyle(ctx, p, hair) {
    const browY = Math.min(...[17,18,19,20,21,22,23,24,25,26].map((i) => p[i].y));
    const faceH = p[8].y - browY;
    const jawW = Math.abs(p[16].x - p[0].x);
    const midX = (p[0].x + p[16].x) / 2;
    const isHair = hairProbe(ctx, hair);
    const top = [0.12, 0.28, 0.44].filter((f) => isHair(midX, browY - faceH * f)).length;
    const sideL = [0.10, 0.45, 0.80].filter((f) => isHair(p[0].x - jawW * 0.09, browY + faceH * f)).length;
    const sideR = [0.10, 0.45, 0.80].filter((f) => isHair(p[16].x + jawW * 0.09, browY + faceH * f)).length;
    const sides = Math.max(sideL, sideR);
    if (top === 0) return 'bald';
    if (sides >= 3) return 'long';
    if (sides >= 2) return 'medium';
    return 'short';
  }

  // Fringe: hair colour just above the brows. Nothing → 'none'; otherwise guess
  // a parting from which temple is exposed. 'centre' is the safe default seed.
  function guessFringe(ctx, p, hair) {
    const browY = Math.min(...[17,18,19,20,21,22,23,24,25,26].map((i) => p[i].y));
    const faceH = p[8].y - browY;
    const y = browY + faceH * 0.03;
    const isHair = hairProbe(ctx, hair);
    const l = isHair(p[19].x, y);
    const c = isHair((p[19].x + p[24].x) / 2, y);
    const r = isHair(p[24].x, y);
    if (!l && !c && !r) return 'none';
    if (l && c && r) return 'bowl';
    if (l && !r) return 'right';
    if (r && !l) return 'left';
    return 'centre';
  }

  // Beard style: biased toward 'none'. Adds a desaturation test so grey/white
  // beards (bright, so invisible to a luminance-only test) still register.
  function guessBeardStyle(ctx, p, skinRGB) {
    const px = sampleRegion(ctx, [p[5],p[6],p[7],p[8],p[9],p[10],p[11]], 7);
    if (!px.length) return 'none';
    const skinLum = (skinRGB[0] + skinRGB[1] + skinRGB[2]) / 3;
    const skinSat = Math.max(...skinRGB) - Math.min(...skinRGB);
    const lum = px.reduce((s, q) => s + (q[0]+q[1]+q[2]) / 3, 0) / px.length;
    const mean = trimmedMean(px, 0.1, 0.1);
    const sat = Math.max(...mean) - Math.min(...mean);
    const ratio = lum / skinLum;
    if (ratio < 0.62) return 'full';
    if (sat < skinSat * 0.45 && ratio > 0.92) return 'full';
    if (ratio < 0.66) return 'stubble';
    return 'none';
  }

  // ── Cartoon renderer ──────────────────────────────────────────────────────
  // `settings` = { render: {...} } (see DEFAULT_SETTINGS). Render settings are
  // style-only: they remap already-sampled colours for display (colorSaturation)
  // or scale drawing parameters (lineWeightScale, eyeEmphasis) — they never
  // re-sample or change what was baked into the credential's L.
  function applySaturation(rgb, factor) {
    if (!rgb) return null;
    if (factor === 1) return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    const lum = (rgb[0]+rgb[1]+rgb[2])/3;
    const adj = rgb.map(c => Math.max(0, Math.min(255, Math.round(lum + (c-lum)*factor))));
    return `rgb(${adj[0]},${adj[1]},${adj[2]})`;
  }

  function darken(rgb, f) {
    return `rgb(${Math.round(rgb[0]*f)},${Math.round(rgb[1]*f)},${Math.round(rgb[2]*f)})`;
  }

  function geometry(p) {
    const browMY = [17,18,19,20,21,22,23,24,25,26].reduce((s, i) => s + p[i].y, 0) / 10;
    const chinY = p[8].y;
    const faceH = chinY - browMY;
    return {
      browMY, chinY, faceH,
      jawMX: (p[0].x + p[16].x) / 2,
      jawW: Math.abs(p[16].x - p[0].x),
      topY: browMY - faceH * 0.72,
    };
  }

  function renderCartoon(ctx, p, W, H, f, settings) {
    const r = mergeRender(settings && settings.render);
    const lw = Math.max(1.5, W/200) * r.lineWeightScale;
    const g = geometry(p);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';

    ctx.fillStyle = '#ccdae8';
    ctx.fillRect(0, 0, W, H);

    // Missing fields default to the legacy look, so credentials issued before
    // these axes existed still render (short cap, no fringe, blue eyes, beard
    // iff the old boolean fired).
    const hairStyle   = f.hairStyle   || 'short';
    const fringeStyle = f.fringeStyle || 'none';
    const iris        = f.iris        || 'blue';
    const beardStyle  = f.beardStyle  || (f.beard && f.beard.detected ? 'full' : 'none');

    // Skin: blend true sampled colour toward the legacy warm cast by `warmth`
    // (default 0), then apply the style-only saturation remap.
    const rawSkin  = f.skin.rgb || [220,180,150];
    const warmSkin = f.skin.displayRgb || rawSkin;
    const skinRgb  = rawSkin.map((v, i) => Math.round(v + (warmSkin[i] - v) * r.warmth));
    const skin  = applySaturation(skinRgb, r.colorSaturation);
    // Hair colour drives beard and brows too, so beard colour always matches hair.
    const hairRgb = f.hair.rgb || [44,30,20];
    const hairC = applySaturation(hairRgb, r.colorSaturation);
    const beardC = hairC;

    drawHairBack(ctx, p, g, hairStyle, hairC, lw);
    drawNeckAndShoulders(ctx, p, g, W, H, skin, lw);

    ctx.fillStyle = skin; ctx.strokeStyle = '#1a0a00'; ctx.lineWidth = lw;
    ctx.beginPath();
    catmullRomPath(ctx, Array.from({ length: 17 }, (_, i) => p[i]));
    ctx.bezierCurveTo(p[16].x + g.jawW*0.05, g.topY + g.faceH*0.2, g.jawMX + g.jawW*0.52, g.topY, g.jawMX, g.topY - g.faceH*0.12);
    ctx.bezierCurveTo(g.jawMX - g.jawW*0.52, g.topY, p[0].x - g.jawW*0.05, g.topY + g.faceH*0.2, p[0].x, p[0].y);
    ctx.fill(); ctx.stroke();

    for (const [ep, sign] of [[p[0], -1], [p[16], 1]]) {
      ctx.fillStyle = skin; ctx.strokeStyle = '#1a0a00'; ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.ellipse(ep.x + sign*g.jawW*0.03, ep.y - g.faceH*0.04, g.jawW*0.05, g.faceH*0.09, sign*0.18, 0, Math.PI*2);
      ctx.fill(); ctx.stroke();
    }

    drawBeardStyle(ctx, p, g, beardStyle, beardC, lw);

    // Brows tinted from the (shaded) hair colour rather than a hardcoded value.
    ctx.strokeStyle = darken(hairRgb, 0.75); ctx.lineWidth = lw * 2.8;
    for (const [a, b] of [[17, 21], [22, 26]]) {
      ctx.beginPath(); ctx.moveTo(p[a].x, p[a].y);
      for (let i = a + 1; i <= b; i++) {
        const pv = p[i-1], cr = p[i];
        ctx.quadraticCurveTo(pv.x, pv.y, (pv.x + cr.x) / 2, (pv.y + cr.y) / 2);
      }
      ctx.lineTo(p[b].x, p[b].y); ctx.stroke();
    }
    ctx.lineWidth = lw; ctx.strokeStyle = '#1a0a00';

    const irisRgb = IRIS_COLORS[iris] || IRIS_COLORS.blue;
    const irisCss = `rgb(${irisRgb[0]},${irisRgb[1]},${irisRgb[2]})`;
    drawEye(ctx, p, 36, lw, r.eyeEmphasis, irisCss);
    drawEye(ctx, p, 42, lw, r.eyeEmphasis, irisCss);

    ctx.strokeStyle = 'rgba(100,50,20,0.22)'; ctx.lineWidth = lw * 0.9;
    ctx.beginPath(); ctx.moveTo(p[27].x, p[27].y);
    ctx.quadraticCurveTo(p[28].x, p[29].y, p[30].x, p[30].y); ctx.stroke();
    ctx.strokeStyle = 'rgba(100,50,20,0.45)'; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(p[30].x, p[30].y);
    ctx.quadraticCurveTo(p[31].x - 3, p[31].y + 4, p[31].x, p[31].y - 3); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p[30].x, p[30].y);
    ctx.quadraticCurveTo(p[35].x + 3, p[35].y + 4, p[35].x, p[35].y - 3); ctx.stroke();

    ctx.strokeStyle = '#1a0a00'; ctx.lineWidth = lw; ctx.fillStyle = '#c06070';
    ctx.beginPath();
    ctx.moveTo(p[48].x, p[48].y);
    ctx.bezierCurveTo(p[49].x, p[49].y, p[50].x, p[50].y, p[51].x, p[51].y);
    ctx.bezierCurveTo(p[52].x, p[52].y, p[53].x, p[53].y, p[54].x, p[54].y);
    ctx.bezierCurveTo(p[55].x, p[55].y, p[56].x, p[56].y, p[57].x, p[57].y);
    ctx.bezierCurveTo(p[58].x, p[58].y, p[59].x, p[59].y, p[48].x, p[48].y);
    ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#8a1020'; ctx.lineWidth = lw * 0.9;
    ctx.beginPath(); ctx.moveTo(p[48].x, p[48].y);
    ctx.bezierCurveTo(p[49].x, (p[49].y + p[59].y)/2, p[53].x, (p[53].y + p[55].y)/2, p[54].x, p[54].y);
    ctx.stroke();

    // Fringe sits in front of the face (its own axis, drawn over the skin).
    if (hairStyle !== 'bald') drawFringe(ctx, p, g, fringeStyle, hairC, lw);

    if (f.glasses) drawGlasses(ctx, p, lw);
  }

  // ── Hair silhouettes ───────────────────────────────────────────────────────
  function capPath(ctx, p, g) {
    ctx.beginPath();
    ctx.moveTo(p[0].x - g.jawW*0.06, p[0].y - g.faceH*0.05);
    ctx.bezierCurveTo(p[0].x - g.jawW*0.24, g.topY + g.faceH*0.12, g.jawMX - g.jawW*0.7, g.topY - g.faceH*0.1, g.jawMX, g.topY - g.faceH*0.26);
    ctx.bezierCurveTo(g.jawMX + g.jawW*0.7, g.topY - g.faceH*0.1, p[16].x + g.jawW*0.24, g.topY + g.faceH*0.12, p[16].x + g.jawW*0.06, p[16].y - g.faceH*0.05);
    ctx.closePath();
  }

  function drawHairBack(ctx, p, g, style, css, lw) {
    if (style === 'bald') return;
    ctx.fillStyle = css; ctx.strokeStyle = '#1a0a00'; ctx.lineWidth = lw;

    if (style === 'long' || style === 'medium') {
      const dropY = style === 'long' ? g.chinY + g.faceH*0.95 : g.chinY - g.faceH*0.02;
      const outL = p[0].x - g.jawW*0.13, outR = p[16].x + g.jawW*0.13;
      ctx.beginPath();
      ctx.moveTo(outL, p[0].y);
      ctx.bezierCurveTo(outL - g.jawW*0.10, g.topY + g.faceH*0.10, g.jawMX - g.jawW*0.74, g.topY - g.faceH*0.14, g.jawMX, g.topY - g.faceH*0.30);
      ctx.bezierCurveTo(g.jawMX + g.jawW*0.74, g.topY - g.faceH*0.14, outR + g.jawW*0.10, g.topY + g.faceH*0.10, outR, p[16].y);
      ctx.lineTo(outR, dropY);
      ctx.quadraticCurveTo(g.jawMX, dropY + g.faceH*0.14, outL, dropY);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      return;
    }

    capPath(ctx, p, g); ctx.fill(); ctx.stroke();

    if (style === 'curly') {
      const n = 10;
      for (let i = 0; i <= n; i++) {
        const ang = Math.PI * (1 - i / n);
        const cx = g.jawMX + Math.cos(ang) * g.jawW * 0.54;
        const cy = (g.browMY - g.faceH*0.16) - Math.sin(ang) * g.faceH * 0.60;
        ctx.beginPath(); ctx.arc(cx, cy, g.jawW * 0.115, 0, Math.PI*2); ctx.fill(); ctx.stroke();
      }
      capPath(ctx, p, g); ctx.fill();
    }
  }

  // Fringe axis (drawn over the face). The TOP edge follows the same scalp dome
  // as the back hair, so the fringe hangs from the hairline with no forehead
  // showing above it; only the LOWER hairline across the forehead changes per
  // style: none / centre (mid parting) / left / right / bowl (flat low edge).
  function drawFringe(ctx, p, g, style, css, lw) {
    if (!style || style === 'none') return;
    ctx.fillStyle = css; ctx.strokeStyle = '#1a0a00'; ctx.lineWidth = lw;
    const x0 = p[0].x - g.jawW*0.04, x1 = p[16].x + g.jawW*0.04;
    const midX = g.jawMX;
    const low  = g.browMY + g.faceH*0.04;
    const high = g.browMY - g.faceH*0.34;
    const edge = (xa, ya, xb, yb) => {
      const n = 4;
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const x = xa + (xb - xa) * t, y = ya + (yb - ya) * t;
        const tip = (i % 2) ? g.faceH*0.06 : 0;
        ctx.quadraticCurveTo(x + (xb - xa) * 0.07, y + tip, x, y);
      }
    };
    const rY = style === 'right' ? high : low;
    const lY = style === 'left'  ? high : low;
    ctx.beginPath();
    ctx.moveTo(p[0].x - g.jawW*0.06, p[0].y - g.faceH*0.05);
    ctx.bezierCurveTo(p[0].x - g.jawW*0.24, g.topY + g.faceH*0.12, midX - g.jawW*0.7, g.topY - g.faceH*0.1, midX, g.topY - g.faceH*0.26);
    ctx.bezierCurveTo(midX + g.jawW*0.7, g.topY - g.faceH*0.1, p[16].x + g.jawW*0.24, g.topY + g.faceH*0.12, p[16].x + g.jawW*0.06, p[16].y - g.faceH*0.05);
    ctx.lineTo(x1, rY);
    if (style === 'centre') {
      ctx.quadraticCurveTo((midX + x1) / 2, low + g.faceH*0.02, midX, high);
      ctx.quadraticCurveTo((midX + x0) / 2, low + g.faceH*0.02, x0, lY);
    } else {
      edge(x1, rY, x0, lY);
    }
    ctx.lineTo(p[0].x - g.jawW*0.06, p[0].y - g.faceH*0.05);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }

  // Neck + shoulders. Without them the head floats and long/medium hair reads
  // as wrapping under the chin. Drawn over back hair and under the face.
  function drawNeckAndShoulders(ctx, p, g, W, H, skin, lw) {
    const topY = g.chinY - g.faceH*0.28;
    const lx = p[4].x + g.jawW*0.05, rx = p[12].x - g.jawW*0.05;
    const botY = g.chinY + g.faceH*0.80;
    ctx.fillStyle = skin; ctx.strokeStyle = '#1a0a00'; ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(lx, topY);
    ctx.lineTo(lx - g.jawW*0.03, botY);
    ctx.lineTo(rx + g.jawW*0.03, botY);
    ctx.lineTo(rx, topY);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    const shY = g.chinY + g.faceH*0.72;
    ctx.fillStyle = '#3d4657';
    ctx.beginPath();
    ctx.moveTo(g.jawMX - g.jawW*1.6, H);
    ctx.quadraticCurveTo(g.jawMX - g.jawW*0.60, shY, g.jawMX, shY);
    ctx.quadraticCurveTo(g.jawMX + g.jawW*0.60, shY, g.jawMX + g.jawW*1.6, H);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }

  // ── Beard styles ───────────────────────────────────────────────────────────
  // Full beard = sideburns + jaw + chin + moustache, closed along the under-nose
  // line so the moustache/philtrum are covered. The mouth is drawn after, so it
  // still reads through.
  function fullBeardPath(ctx, p, g) {
    const noseY = (p[31].y + p[35].y) / 2;
    ctx.beginPath();
    ctx.moveTo(p[0].x, p[0].y - g.faceH*0.02);
    for (let i = 1; i <= 16; i++) ctx.lineTo(p[i].x, p[i].y);
    ctx.lineTo(p[16].x, p[16].y - g.faceH*0.02);
    ctx.quadraticCurveTo(p[35].x + g.jawW*0.10, noseY + g.faceH*0.04, p[35].x, noseY);
    ctx.quadraticCurveTo(p[33].x, noseY + g.faceH*0.02, p[31].x, noseY);
    ctx.quadraticCurveTo(p[31].x - g.jawW*0.10, noseY + g.faceH*0.04, p[0].x, p[0].y - g.faceH*0.02);
    ctx.closePath();
  }

  function drawBeardStyle(ctx, p, g, style, css, lw) {
    if (!style || style === 'none') return;

    if (style === 'stubble') {
      ctx.save(); ctx.globalAlpha = 0.40;
      ctx.fillStyle = css; fullBeardPath(ctx, p, g); ctx.fill();
      ctx.restore();
      return;
    }

    if (style === 'goatee') {
      ctx.fillStyle = css; ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = lw * 0.6;
      ctx.beginPath();
      ctx.ellipse(p[8].x, (p[57].y + p[8].y)/2 + g.faceH*0.02, g.jawW*0.13, g.faceH*0.15, 0, 0, Math.PI*2);
      ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p[48].x, p[48].y);
      ctx.quadraticCurveTo(p[51].x, p[51].y - g.faceH*0.07, p[54].x, p[54].y);
      ctx.quadraticCurveTo(p[51].x, p[51].y - g.faceH*0.01, p[48].x, p[48].y);
      ctx.fill(); ctx.stroke();
      return;
    }

    ctx.fillStyle = css; ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = lw * 0.6;
    fullBeardPath(ctx, p, g); ctx.fill(); ctx.stroke();
  }

  function drawGlasses(ctx, p, lw) {
    const eyeData = [[36,41],[42,47]].map(([s,e]) => {
      const ep  = Array.from({length:e-s+1},(_,i)=>p[s+i]);
      const xs  = ep.map(q=>q.x), ys = ep.map(q=>q.y);
      const minX=Math.min(...xs), maxX=Math.max(...xs);
      const minY=Math.min(...ys), maxY=Math.max(...ys);
      const pad = (maxX-minX)*0.14;
      return { cx:(minX+maxX)/2, cy:(minY+maxY)/2, rx:(maxX-minX)/2+pad, ry:Math.max((maxY-minY)/2,(maxX-minX)*0.14)+pad*1.6 };
    });
    const frameColor = '#1a1520';
    ctx.strokeStyle = frameColor; ctx.lineWidth = lw*2.0; ctx.fillStyle = 'rgba(190,215,245,0.10)';
    eyeData.forEach(({cx,cy,rx,ry}) => {
      ctx.beginPath(); ctx.ellipse(cx,cy,rx,ry,0,0,Math.PI*2); ctx.fill(); ctx.stroke();
    });
    const bridgeY = (p[39].y+p[42].y)/2;
    ctx.lineWidth = lw*1.6;
    ctx.beginPath();
    ctx.moveTo(p[39].x, bridgeY);
    ctx.quadraticCurveTo((p[39].x+p[42].x)/2, bridgeY-lw*2, p[42].x, bridgeY);
    ctx.stroke();
    const armLen = (p[45].x-p[36].x)*0.32;
    ctx.lineWidth = lw*1.6;
    ctx.beginPath(); ctx.moveTo(p[36].x,eyeData[0].cy); ctx.lineTo(p[36].x-armLen,eyeData[0].cy+lw); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p[45].x,eyeData[1].cy); ctx.lineTo(p[45].x+armLen,eyeData[1].cy+lw); ctx.stroke();
  }

  function drawEye(ctx, p, s, lw, emphasis, irisCss) {
    emphasis = emphasis == null ? 1.0 : emphasis;
    irisCss = irisCss || 'rgb(74,110,150)';
    const ep = Array.from({length:6},(_,i)=>p[s+i]);
    const xs=ep.map(q=>q.x), ys=ep.map(q=>q.y);
    const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
    const cx=(minX+maxX)/2, cy=(minY+maxY)/2, ew=maxX-minX;
    const ir=Math.min(ew*0.30, Math.max(maxY-minY,ew*0.22)*0.92) * emphasis;
    ctx.fillStyle='white'; ctx.strokeStyle='#1a0a00'; ctx.lineWidth=lw;
    ctx.beginPath(); ctx.moveTo(ep[0].x,ep[0].y);
    ctx.bezierCurveTo(ep[1].x,ep[1].y,ep[2].x,ep[2].y,ep[3].x,ep[3].y);
    ctx.bezierCurveTo(ep[4].x,ep[4].y,ep[5].x,ep[5].y,ep[0].x,ep[0].y);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle=irisCss; ctx.beginPath(); ctx.arc(cx,cy,ir,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#0c0c10'; ctx.beginPath(); ctx.arc(cx,cy,ir*0.58,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='rgba(255,255,255,0.88)'; ctx.beginPath(); ctx.arc(cx-ir*0.28,cy-ir*0.28,ir*0.22,0,Math.PI*2); ctx.fill();
  }

  function catmullRomPath(ctx, pts) {
    if (!pts.length) return;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i=0; i<pts.length-1; i++) {
      const p0=pts[Math.max(0,i-1)],p1=pts[i],p2=pts[i+1],p3=pts[Math.min(pts.length-1,i+2)];
      ctx.bezierCurveTo(p1.x+(p2.x-p0.x)/6,p1.y+(p2.y-p0.y)/6,p2.x-(p3.x-p1.x)/6,p2.y-(p3.y-p1.y)/6,p2.x,p2.y);
    }
  }

  global.VouchToon = {
    loadModels, captureFace, overlayLandmarks, renderCartoon,
    DEFAULT_SETTINGS, mergeAnalysis, mergeRender, getSampleRegions, quantizePoint,
    // Identity enums + index helpers — the committed `L` ordering. vbb-crypto.js
    // and vbb-codec.js index into these, so this module is their single source.
    HAIR_STYLES, FRINGE_STYLES, BEARD_STYLES, IRIS_COLORS, IRIS_KEYS, tintRgb,
    irisIndex, hairStyleIndex, fringeStyleIndex, beardStyleIndex,
    irisFromIndex, hairStyleFromIndex, fringeStyleFromIndex, beardStyleFromIndex,
    // exposed for the calibration harness and the Node smoke test, which need
    // to drive analysis functions directly without a browser/face-api runtime
    __testables: { sampleSkinRobust, sampleHair, detectBeard, detectGlasses, sampleRegion, trimmedMean, insetPoint, avgPoint,
      sampleIris, nearestIris, guessHairStyle, guessFringe, guessBeardStyle },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VouchToon;
  }
})(typeof window !== 'undefined' ? window : globalThis);
