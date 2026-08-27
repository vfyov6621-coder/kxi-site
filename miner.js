/* ═══════════════════════════════════════════════════════════
   kxi miner.js — local brute-force miner (Web Worker)
   pure-JS SHA-256 · nonce = 12 hex chars · treasure = hash
   starting with N zero hex chars over "salt:nonce"
   runs 100% in the visitor's CPU — zero server hashing
   ═══════════════════════════════════════════════════════════ */
'use strict';

/* ── SHA-256 core (reusable buffers, no per-hash allocations) ── */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const H = new Int32Array(8);
const W = new Int32Array(64);
const M = new Uint8Array(256);

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/* message bytes in M[0..len-1] → final state in H */
function sha256Blocks(len) {
  const paddedLen = (((len + 8) >> 6) + 1) << 6;
  M[len] = 0x80;
  for (let i = len + 1; i < paddedLen - 8; i++) M[i] = 0;
  const bitLen = len * 8;
  M[paddedLen - 8] = 0; M[paddedLen - 7] = 0; M[paddedLen - 6] = 0; M[paddedLen - 5] = 0;
  M[paddedLen - 4] = (bitLen >>> 24) & 255;
  M[paddedLen - 3] = (bitLen >>> 16) & 255;
  M[paddedLen - 2] = (bitLen >>> 8) & 255;
  M[paddedLen - 1] = bitLen & 255;

  let h0 = 0x6a09e667 | 0, h1 = 0xbb67ae85 | 0, h2 = 0x3c6ef372 | 0, h3 = 0xa54ff53a | 0,
      h4 = 0x510e527f | 0, h5 = 0x9b05688c | 0, h6 = 0x1f83d9ab | 0, h7 = 0x5be0cd19 | 0;

  for (let off = 0; off < paddedLen; off += 64) {
    for (let t = 0; t < 16; t++) {
      const i = off + (t << 2);
      W[t] = (M[i] << 24) | (M[i + 1] << 16) | (M[i + 2] << 8) | M[i + 3];
    }
    for (let t = 16; t < 64; t++) {
      const w15 = W[t - 15], w2 = W[t - 2];
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + W[t]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  H[0] = h0; H[1] = h1; H[2] = h2; H[3] = h3;
  H[4] = h4; H[5] = h5; H[6] = h6; H[7] = h7;
}

function toHex() {
  let s = '';
  for (let i = 0; i < 8; i++) s += (H[i] >>> 0).toString(16).padStart(8, '0');
  return s;
}

/* public: hash any short string → 64 hex chars (used by self-test) */
function sha256hex(str) {
  const s = String(str);
  if (s.length > 192) throw new Error('kxi sha256: input too long');
  let ascii = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 127) { ascii = false; break; }
    M[i] = c;
  }
  if (!ascii) {
    const bytes = new TextEncoder().encode(s);
    M.set(bytes.subarray(0, 192));
  }
  sha256Blocks(s.length);
  return toHex();
}

/* ── mining state ─────────────────────────────────────────── */
let running = false;
let salt = '';
let difficulty = 6;        // leading zero HEX chars (max 8)
let shiftBits = 32 - 6 * 4; // H[0] top 4*difficulty bits must be 0
let bufLen = 0;            // salt:nonce length in M
let saltLen = 0;
const nib = new Uint8Array(12); // nonce as 12 nibbles, index 11 = least significant
let hashes = 0;
let t0 = 0;
let reportT = 0;
let selfTested = false;

function writeSaltAndPrefix() {
  for (let i = 0; i < salt.length; i++) M[i] = salt.charCodeAt(i);
  M[salt.length] = 0x3a; // ':'
  saltLen = salt.length;
  bufLen = saltLen + 1 + 12;
}

function randomizeNonce() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  for (let i = 0; i < 6; i++) {
    nib[i * 2] = b[i] >> 4;
    nib[i * 2 + 1] = b[i] & 15;
  }
}

function incrNonce() {
  for (let i = 11; i >= 0; i--) {
    if (nib[i] < 15) { nib[i]++; return true; }
    nib[i] = 0;
  }
  return false; // 48-bit space exhausted (practically impossible)
}

function writeNonce() {
  const p = saltLen + 1;
  for (let i = 0; i < 12; i++) M[p + i] = nib[i] < 10 ? 48 + nib[i] : 87 + nib[i];
}

function nonceStr() {
  let s = '';
  for (let i = 0; i < 12; i++) s += nib[i] < 10 ? String.fromCharCode(48 + nib[i]) : String.fromCharCode(87 + nib[i]);
  return s;
}

/* ── self-test: our SHA-256 vs WebCrypto ──────────────────── */
async function selfTest() {
  const vectors = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['kxi:salt0001:000000000001', sha256hex('kxi:salt0001:000000000001')] // consistency only
  ];
  for (const [input, expect] of vectors.slice(0, 2)) {
    if (sha256hex(input) !== expect) return false;
  }
  const enc = new TextEncoder();
  const CHARS = '0123456789abcdefxyz:';
  for (let i = 0; i < 32; i++) {
    let s = '';
    const n = 5 + Math.floor(Math.random() * 60);
    for (let j = 0; j < n; j++) s += CHARS[Math.floor(Math.random() * CHARS.length)];
    const ref = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    if (sha256hex(s) !== ref) return false;
  }
  return true;
}

/* ── main loop ────────────────────────────────────────────── */
async function loop() {
  while (running) {
    const chunkEnd = Date.now() + 140;
    while (running && Date.now() < chunkEnd) {
      for (let i = 0; i < 5000; i++) {
        if (!incrNonce()) randomizeNonce();
        writeNonce();
        sha256Blocks(bufLen);
        hashes++;
        if ((H[0] >>> shiftBits) === 0) {
          writeNonce();
          postMessage({ type: 'hit', nonce: nonceStr(), hash: toHex(), hashes });
        }
      }
    }
    if (!running) break;
    const now = Date.now();
    if (now - reportT > 100) {
      reportT = now;
      writeNonce();
      const secs = Math.max(0.001, (now - t0) / 1000);
      postMessage({
        type: 'progress',
        hashes,
        hps: hashes / secs,
        nonce: nonceStr(),
        hash: toHex()
      });
    }
    await new Promise((r) => setTimeout(r, 4));
  }
}

/* ── messages from main thread ────────────────────────────── */
self.onmessage = async (ev) => {
  const m = ev.data || {};
  if (m.cmd === 'start') {
    if (!selfTested) {
      selfTested = true;
      const ok = await selfTest();
      if (!ok) {
        postMessage({ type: 'error', message: 'sha-256 self-test failed — mining refused' });
        return;
      }
    }
    if (running) return; // main thread restarts workers on param change
    salt = String(m.salt || '');
    difficulty = Math.max(1, Math.min(8, m.difficulty | 0));
    shiftBits = 32 - difficulty * 4;
    writeSaltAndPrefix();
    randomizeNonce();
    hashes = 0;
    t0 = Date.now();
    reportT = 0;
    running = true;
    postMessage({ type: 'started', salt, difficulty });
    loop();
  } else if (m.cmd === 'stop') {
    running = false;
  }
};

/* exposed for tests */
self.kxiSha256 = sha256hex;
