// VBB compact codec — packs a proof package into a QR-sized binary blob.
//
// Why: the JSON proof package is ~7.4 kB, beyond any single QR (v40 binary
// tops out ~2953 B). Almost none of that is information — 3.5 kB is
// likeness_data.positions as JSON floats, and every field element is a decimal
// STRING (~77 chars) where 32 raw bytes carry the same value. Packed, the same
// package is ~700 B: one QR at high error correction, no multi-frame cycling.
//
// Layout (all field elements big-endian 32-byte, i.e. BN254 Fr):
//   0    2   magic 'VB'
//   2    1   version (2)
//   3    1   flags  bit0 hair.grey · bit1 beard.detected · bit2 glasses
//   4    1   score  (round(score * 255))
//   5    1   enum1  low nibble hairStyle · high nibble fringeStyle
//   6    1   enum2  low nibble iris · high nibble beardStyle
//   7   64   pi_a   x, y            (z is always 1 — dropped)
//   +  128   pi_b   x0, x1, y0, y1  (z is always [1,0] — dropped)
//   +   64   pi_c   x, y
//   +    1   nPublic
//   +  32*n  publicSignals
//   +   32   N_p
//   +    1   nPoints
//   + 4*pts  positions — uint16 x, uint16 y, fixed point (value * 4)
//   +   12   skin.rgb, skin.displayRgb, hair.rgb, beard.rgb
//
// Positions are stored at 0.25 px precision. That is deliberately finer than
// the format needs — landmark coarseness is a separate decision (D9's frozen L
// format, analysis.landmarkRound) and this codec does not smuggle it in.
'use strict';

(function (global) {
  const MAGIC = 0x5642; // 'VB'
  const VERSION = 2;    // v2: appended identity-enum bytes (iris/hair/fringe/beard)
  const FE = 32;        // field element bytes
  const POS_SCALE = 4;  // positions stored as round(v * 4) in a uint16

  // vouchtoon.js owns the identity-enum ordering. Browser: prior <script>.
  const VT = (typeof VouchToon !== 'undefined') ? VouchToon
    : (global.VouchToon || (typeof require !== 'undefined' ? require('./vouchtoon.js') : null));

  // ── field element <-> bytes ────────────────────────────────────────────────
  function feToBytes(dec, out, off) {
    let v = BigInt(dec);
    for (let i = FE - 1; i >= 0; i--) { out[off + i] = Number(v & 0xffn); v >>= 8n; }
    return off + FE;
  }

  function feFromBytes(buf, off) {
    let v = 0n;
    for (let i = 0; i < FE; i++) v = (v << 8n) | BigInt(buf[off + i]);
    return v.toString();
  }

  // ── encode ────────────────────────────────────────────────────────────────
  function encodeProofPackage(pkg) {
    const pub = pkg.publicSignals;
    const L = pkg.likeness_data;
    const pts = L.positions;
    // +2 for the identity-enum bytes (see below).
    const size = 5 + 2 + 64 + 128 + 64 + 1 + FE * pub.length + FE + 1 + 4 * pts.length + 12;
    const b = new Uint8Array(size);
    const dv = new DataView(b.buffer);
    let o = 0;

    dv.setUint16(0, MAGIC); o = 2;
    b[o++] = VERSION;
    b[o++] = (L.hair.grey ? 1 : 0) | (L.beard.detected ? 2 : 0) | (pkg.likeness_data.glasses ? 4 : 0);
    b[o++] = Math.max(0, Math.min(255, Math.round((L.score || 0) * 255)));

    // Identity enums, nibble-packed (each index ≤ 15). Ordering from vouchtoon.js.
    if (!VT) throw new Error('vbb-codec: VouchToon must load before encoding (enum ordering)');
    const beardStyle = L.beardStyle != null ? L.beardStyle : (L.beard && L.beard.detected ? 'full' : 'none');
    b[o++] = VT.hairStyleIndex(L.hairStyle) | (VT.fringeStyleIndex(L.fringeStyle) << 4);
    b[o++] = VT.irisIndex(L.iris) | (VT.beardStyleIndex(beardStyle) << 4);

    o = feToBytes(pkg.proof.pi_a[0], b, o);
    o = feToBytes(pkg.proof.pi_a[1], b, o);
    o = feToBytes(pkg.proof.pi_b[0][0], b, o);
    o = feToBytes(pkg.proof.pi_b[0][1], b, o);
    o = feToBytes(pkg.proof.pi_b[1][0], b, o);
    o = feToBytes(pkg.proof.pi_b[1][1], b, o);
    o = feToBytes(pkg.proof.pi_c[0], b, o);
    o = feToBytes(pkg.proof.pi_c[1], b, o);

    b[o++] = pub.length;
    pub.forEach((s) => { o = feToBytes(s, b, o); });
    o = feToBytes(pkg.N_p, b, o);

    b[o++] = pts.length;
    pts.forEach((p) => {
      dv.setUint16(o, Math.max(0, Math.min(65535, Math.round(p.x * POS_SCALE)))); o += 2;
      dv.setUint16(o, Math.max(0, Math.min(65535, Math.round(p.y * POS_SCALE)))); o += 2;
    });

    [L.skin.rgb, L.skin.displayRgb, L.hair.rgb, L.beard.rgb].forEach((rgb) => {
      b[o++] = rgb[0]; b[o++] = rgb[1]; b[o++] = rgb[2];
    });

    return b;
  }

  // ── decode ────────────────────────────────────────────────────────────────
  function decodeProofPackage(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (dv.getUint16(0) !== MAGIC) throw new Error('not a VBB payload (bad magic)');
    const version = b[2];
    if (version !== VERSION) throw new Error(`unsupported VBB payload version ${version}`);
    const flags = b[3];
    const score = b[4] / 255;
    const enum1 = b[5], enum2 = b[6];
    let o = 7;

    if (!VT) throw new Error('vbb-codec: VouchToon must load before decoding (enum ordering)');
    const hairStyle   = VT.hairStyleFromIndex(enum1 & 0x0f);
    const fringeStyle = VT.fringeStyleFromIndex(enum1 >> 4);
    const iris        = VT.irisFromIndex(enum2 & 0x0f);
    const beardStyle  = VT.beardStyleFromIndex(enum2 >> 4);

    const fe = () => { const v = feFromBytes(b, o); o += FE; return v; };
    const pi_a = [fe(), fe(), '1'];
    const pi_b = [[fe(), fe()], [fe(), fe()], ['1', '0']];
    const pi_c = [fe(), fe(), '1'];

    const nPub = b[o++];
    const publicSignals = [];
    for (let i = 0; i < nPub; i++) publicSignals.push(fe());
    const N_p = fe();

    const nPts = b[o++];
    const positions = [];
    for (let i = 0; i < nPts; i++) {
      positions.push({
        x: dv.getUint16(o) / POS_SCALE,
        y: dv.getUint16(o + 2) / POS_SCALE,
      });
      o += 4;
    }

    const rgb = () => { const v = [b[o], b[o+1], b[o+2]]; o += 3; return v; };
    const skinRgb = rgb(), skinDisp = rgb(), hairRgb = rgb(), beardRgb = rgb();
    const css = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

    return {
      proof: { pi_a, pi_b, pi_c, protocol: 'groth16', curve: 'bn128' },
      publicSignals,
      N_p,
      likeness_data: {
        positions,
        score,
        skin:  { css: css(skinDisp), rgb: skinRgb, displayRgb: skinDisp },
        hair:  { css: css(hairRgb), grey: !!(flags & 1), rgb: hairRgb },
        beard: { detected: !!(flags & 2), color: css(beardRgb), rgb: beardRgb },
        glasses: !!(flags & 4),
        iris, hairStyle, fringeStyle, beardStyle,
      },
    };
  }

  // ── base64 (isomorphic: browser + node) ───────────────────────────────────
  function toBase64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function fromBase64(s) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
    const bin = atob(s);
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }

  const encodeToBase64 = (pkg) => toBase64(encodeProofPackage(pkg));
  const decodeFromBase64 = (s) => decodeProofPackage(fromBase64(s));

  // Challenge is already tiny (~207 B of JSON) — it goes in a QR as-is.
  const encodeChallenge = (ch) => JSON.stringify(ch);
  const decodeChallenge = (s) => JSON.parse(s);

  global.VBBCodec = {
    encodeProofPackage, decodeProofPackage,
    encodeToBase64, decodeFromBase64,
    encodeChallenge, decodeChallenge,
    toBase64, fromBase64, VERSION,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.VBBCodec;
})(typeof window !== 'undefined' ? window : globalThis);
