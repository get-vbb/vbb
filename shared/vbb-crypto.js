// Shared VBB pass-1 crypto glue: attribute packing, likeness commitment,
// EdDSA-BabyJubJub signing/verification, the Poseidon trust-root Merkle tree,
// combined-challenge derivation, and Groth16 witness-input assembly.
//
// Used by app/voucher.html, app/bob.html, app/bouncer.html (browser) and
// scripts/smoke-test.js (Node) so both sides compute identical values.
// Governing decisions: .claudable/artifacts/project/SPEC-VBB.md D5/D6,
// .claudable/artifacts/project/DECISIONS.md D5/D6.
'use strict';

const IS_NODE = typeof process !== 'undefined' && !!(process.versions && process.versions.node);

// vouchtoon.js owns the identity-enum ordering that packLikeness commits to.
// Browser: loaded as a prior <script>, so the global exists. Node: require it.
const VT = (typeof VouchToon !== 'undefined') ? VouchToon
  : (IS_NODE ? require('./vouchtoon.js')
             : (typeof window !== 'undefined' ? window.VouchToon : null));

// Merkle tree depth fixed at 10 (1024 issuer slots) — a pass-1 demo parameter,
// not a protocol constant. Must match circuits/vbb.circom's `VBB(10)` instantiation.
const MERKLE_LEVELS = 10;
const MERKLE_SIZE = 1 << MERKLE_LEVELS;

// 18 years, approximated as 365.25 * 18 days, truncated. Must match the
// circuit's THRESHOLD_DAYS constant exactly, or proofs will verify against
// a different threshold than the circuit enforces.
const THRESHOLD_DAYS = 6570;

const EPOCH = Date.UTC(1970, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

function dobDaysFromDate(isoDateStr) {
  // isoDateStr: 'YYYY-MM-DD'. Returns integer days since 1970-01-01 (UTC).
  const [y, m, d] = isoDateStr.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  return Math.floor((ms - EPOCH) / DAY_MS);
}

function todayDays(date = new Date()) {
  const ms = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor((ms - EPOCH) / DAY_MS);
}

async function loadLibs() {
  // snarkjs is only needed by Bob (prove) and the Bouncer (verify) — voucher.html
  // never touches it, so it is loaded lazily and optionally here rather than
  // required up front, letting voucher.html skip the snarkjs CDN script entirely.
  if (IS_NODE) {
    const circomlibjs = require('circomlibjs');
    const snarkjs = require('snarkjs');
    return { circomlibjs, snarkjs };
  }
  // circomlibjs bundles its own copy of the node buffer module but several of its
  // dependencies (blake-hash, ripemd) still reach for a bare global Buffer while
  // their module bodies evaluate, which browsers do not provide. Install the
  // polyfill before the import so the global exists by the time it runs.
  if (typeof globalThis.Buffer === 'undefined') {
    // The CDN +esm build exposes a named `Buffer`; the locally-vendored esbuild
    // bundle of the CommonJS package puts it at `default.Buffer`. Accept either.
    const m = await import('./vendor/buffer.esm.js');
    globalThis.Buffer = m.Buffer || (m.default && m.default.Buffer);
  }
  const circomlibjs = await import('./vendor/circomlibjs.esm.js');
  const snarkjs = typeof window !== 'undefined' ? window.snarkjs : undefined;
  return { circomlibjs, snarkjs };
}

async function createVbbCrypto() {
  const { circomlibjs, snarkjs } = await loadLibs();
  const eddsa = await circomlibjs.buildEddsa();
  const poseidon = await circomlibjs.buildPoseidon();
  const F = poseidon.F; // BN128 scalar field — shared by eddsa (BabyJubJub is defined over it)

  function toBig(x) { return F.toObject(x); }
  function feFromBig(x) { return F.e(x); }

  function poseidon2(a, b) {
    return toBig(poseidon([feFromBig(a), feFromBig(b)]));
  }

  // ---- Issuer keypair ---------------------------------------------------
  // rawSeed: any Buffer/Uint8Array of entropy (32 bytes recommended).
  function genKeypair(rawSeed) {
    const pub = eddsa.prv2pub(rawSeed);
    return {
      privRaw: rawSeed,
      pubX: toBig(pub[0]).toString(),
      pubY: toBig(pub[1]).toString(),
    };
  }

  // ---- Likeness commitment: H_L(L) --------------------------------------
  // Canonical packing (pass-1 choice, documented — SPEC-VBB.md §10, D6):
  //   1. 68 landmarks, in fixed index order, x then y, each rounded to the
  //      nearest integer pixel and clamped to [0, 1023] against a reference
  //      canvas normalized to <= 1024px on a side.
  //   2. skin RGB (3 ints, 0-255)
  //   3. hair RGB (3 ints, 0-255), hair-is-grey flag (0/1)
  //   4. beard-detected flag (0/1), beard RGB (3 ints, 0-255)
  //   5. glasses-detected flag (0/1)
  //   6. iris / hairStyle / fringeStyle / beardStyle enum indices (appended
  //      2026-07-18 — see vouchtoon.js for the ordering these index into)
  // The resulting ordered list of field elements is folded into a single
  // commitment via a sequential Poseidon(2) chain: acc=0; acc=Poseidon([acc,e])
  // for each e in order. This is an off-circuit hash (only its output, LC,
  // crosses into the proof) so there is no in-circuit arity limit to respect;
  // the chain is chosen for simplicity/determinism over a wider sponge.
  function packLikeness(L) {
    const clamp1024 = (v) => Math.max(0, Math.min(1023, Math.round(v)));
    const vals = [];
    for (const pt of L.positions) {
      vals.push(clamp1024(pt.x));
      vals.push(clamp1024(pt.y));
    }
    const skinRgb = L.skin.rgb || L.skin;
    const hairRgb = L.hair.rgb || [0, 0, 0];
    const beardRgb = L.beard.rgb || [0, 0, 0];
    vals.push(...skinRgb);
    vals.push(...hairRgb);
    vals.push(L.hair.grey ? 1 : 0);
    vals.push(L.beard.detected ? 1 : 0);
    vals.push(...beardRgb);
    vals.push(L.glasses ? 1 : 0);
    // Identity axes (appended — never reorder the above). Enum ordering lives in
    // vouchtoon.js; both issuer and verifier must resolve it identically.
    if (!VT) throw new Error('vbb-crypto: VouchToon must load before packLikeness (enum ordering)');
    const beardStyle = L.beardStyle != null ? L.beardStyle : (L.beard && L.beard.detected ? 'full' : 'none');
    vals.push(VT.irisIndex(L.iris));
    vals.push(VT.hairStyleIndex(L.hairStyle));
    vals.push(VT.fringeStyleIndex(L.fringeStyle));
    vals.push(VT.beardStyleIndex(beardStyle));
    return vals;
  }

  function computeLikenessCommitment(L) {
    const vals = packLikeness(L);
    let acc = 0n;
    for (const v of vals) acc = poseidon2(acc, BigInt(v));
    return acc; // LC, as a BigInt
  }

  // ---- Attribute message + signature -------------------------------------
  function attributeMessage(dobDays, likenessCommitment) {
    return poseidon2(BigInt(dobDays), likenessCommitment);
  }

  function signCredential(privRaw, dobDays, likenessCommitment) {
    const msg = attributeMessage(dobDays, likenessCommitment);
    const sig = eddsa.signPoseidon(privRaw, feFromBig(msg));
    return {
      R8x: toBig(sig.R8[0]).toString(),
      R8y: toBig(sig.R8[1]).toString(),
      S: sig.S.toString(),
    };
  }

  function verifyCredentialSig(pubX, pubY, dobDays, likenessCommitment, sig) {
    const msg = attributeMessage(dobDays, likenessCommitment);
    const pub = [feFromBig(BigInt(pubX)), feFromBig(BigInt(pubY))];
    const s = { R8: [feFromBig(BigInt(sig.R8x)), feFromBig(BigInt(sig.R8y))], S: BigInt(sig.S) };
    return eddsa.verifyPoseidon(feFromBig(msg), s, pub);
  }

  // ---- Trust-root Merkle tree (depth 10, Poseidon(2)) --------------------
  // Leaf = Poseidon(pubX, pubY). Unused slots (up to 1024) are zero-leaves
  // (Poseidon(0,0)) — a pass-1 simplification; a real deployment would use
  // an incremental/sparse tree so the unused-slot count doesn't matter.
  function buildTrustTree(issuerPubkeys) {
    if (issuerPubkeys.length > MERKLE_SIZE) {
      throw new Error(`trust root: ${issuerPubkeys.length} issuers exceeds MERKLE_SIZE=${MERKLE_SIZE}`);
    }
    const zeroLeaf = poseidon2(0n, 0n);
    const leaves = new Array(MERKLE_SIZE).fill(zeroLeaf);
    issuerPubkeys.forEach((pk, i) => {
      leaves[i] = poseidon2(BigInt(pk.pubX), BigInt(pk.pubY));
    });

    const levels = [leaves];
    for (let l = 0; l < MERKLE_LEVELS; l++) {
      const prev = levels[l];
      const next = [];
      for (let i = 0; i < prev.length; i += 2) {
        next.push(poseidon2(prev[i], prev[i + 1]));
      }
      levels.push(next);
    }
    return { levels, root: levels[MERKLE_LEVELS][0], size: issuerPubkeys.length };
  }

  function getMerklePath(tree, leafIndex) {
    const pathElements = [];
    const pathIndices = [];
    let idx = leafIndex;
    for (let l = 0; l < MERKLE_LEVELS; l++) {
      const level = tree.levels[l];
      const isRight = idx % 2 === 1;
      const siblingIdx = isRight ? idx - 1 : idx + 1;
      pathElements.push(level[siblingIdx]);
      pathIndices.push(isRight ? 1 : 0);
      idx = Math.floor(idx / 2);
    }
    return { pathElements, pathIndices };
  }

  // ---- Combined challenge N = Poseidon(N_v, N_p) -------------------------
  function combineChallenge(Nv, Np) {
    return poseidon2(BigInt(Nv), BigInt(Np));
  }

  function randomFieldElement() {
    // 31 bytes of entropy, safely below the BN128 scalar field modulus.
    let bytes;
    if (IS_NODE) {
      bytes = require('crypto').randomBytes(31);
    } else {
      bytes = new Uint8Array(31);
      crypto.getRandomValues(bytes);
    }
    let hex = '0x';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return BigInt(hex).toString();
  }

  // ---- Groth16 witness input assembly ------------------------------------
  function buildCircuitInput({ credential, sigOverride, merklePath, root, challenge, likenessPub, today }) {
    return {
      dob_days: credential.attrs.dob_days.toString(),
      likeness_commitment: credential.attrs.likeness_commitment.toString(),
      issuer_pub_x: credential.issuer_pub.x.toString(),
      issuer_pub_y: credential.issuer_pub.y.toString(),
      sig_R8x: (sigOverride || credential.sig).R8x,
      sig_R8y: (sigOverride || credential.sig).R8y,
      sig_S: (sigOverride || credential.sig).S,
      path_elements: merklePath.pathElements.map(String),
      path_indices: merklePath.pathIndices.map(String),
      root: root.toString(),
      challenge: challenge.toString(),
      likeness_pub: likenessPub.toString(),
      today: today.toString(),
    };
  }

  function requireSnarkjs() {
    if (!snarkjs) throw new Error('snarkjs not loaded — load it via <script src=".../snarkjs.min.js"> before this page\'s scripts run');
    return snarkjs;
  }

  async function proveGroth16(input, wasmPath, zkeyPath) {
    const { proof, publicSignals } = await requireSnarkjs().groth16.fullProve(input, wasmPath, zkeyPath);
    return { proof, publicSignals };
  }

  async function verifyGroth16(vkey, publicSignals, proof) {
    return requireSnarkjs().groth16.verify(vkey, publicSignals, proof);
  }

  return {
    MERKLE_LEVELS, MERKLE_SIZE, THRESHOLD_DAYS,
    dobDaysFromDate, todayDays,
    genKeypair,
    packLikeness, computeLikenessCommitment,
    attributeMessage, signCredential, verifyCredentialSig,
    buildTrustTree, getMerklePath,
    combineChallenge, randomFieldElement,
    buildCircuitInput, proveGroth16, verifyGroth16,
    F, poseidon, eddsa,
  };
}

if (IS_NODE) {
  module.exports = { createVbbCrypto, dobDaysFromDate, todayDays, THRESHOLD_DAYS, MERKLE_LEVELS };
} else {
  window.VbbCrypto = { createVbbCrypto, dobDaysFromDate, todayDays, THRESHOLD_DAYS, MERKLE_LEVELS };
}
