/**
 * Digest primitives for governance (plan §5.6, §5.7, §5.10): SHA-256, HMAC-SHA256, base64url and UTF-8, written in
 * pure ES2017 so every host computes the same `inputHash`, `planHash` and plan-token signature without a crypto
 * dependency. Keys are always injected by the host; nothing here holds or generates one.
 *
 * These run on small inputs (a checked tool input, a plan, a token payload). The wire's request signing (W1.5) uses
 * the host's own injected crypto instead; the golden vectors in the tests (RFC 4231, FIPS 180-2) bind both.
 */

/** A string's UTF-8 bytes. A lone surrogate becomes U+FFFD, exactly as `TextEncoder` does. */
export const utf8Bytes = (text: string): Uint8Array => {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else c = 0xfffd;
    } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
};

/** UTF-8 bytes → string; `null` for anything that is not well-formed UTF-8 (overlongs and surrogates included). */
export const utf8Decode = (bytes: Uint8Array): string | null => {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    let cp: number;
    let n: number;
    if (b < 0x80) {
      cp = b;
      n = 1;
    } else if (b >= 0xc2 && b < 0xe0) {
      cp = b & 31;
      n = 2;
    } else if (b >= 0xe0 && b < 0xf0) {
      cp = b & 15;
      n = 3;
    } else if (b >= 0xf0 && b < 0xf5) {
      cp = b & 7;
      n = 4;
    } else return null;
    if (i + n > bytes.length) return null;
    for (let k = 1; k < n; k++) {
      const cb = bytes[i + k];
      if ((cb & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (cb & 63);
    }
    if ((n === 3 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) || (n === 4 && (cp < 0x10000 || cp > 0x10ffff))) return null;
    if (cp >= 0x10000) {
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    } else out += String.fromCharCode(cp);
    i += n;
  }
  return out;
};

const asBytes = (data: Uint8Array | string): Uint8Array => (typeof data === 'string' ? utf8Bytes(data) : data);

// ── SHA-256 (FIPS 180-4) ────────────────────────────────────────────────────────────────────────────────────────

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** SHA-256 of `data` (a string is hashed as its UTF-8 bytes). */
export const sha256 = (data: Uint8Array | string): Uint8Array => {
  const msg = asBytes(data);
  const bitLenHi = Math.floor(msg.length / 0x20000000);
  const bitLenLo = (msg.length * 8) >>> 0;
  const padded = new Uint8Array(Math.ceil((msg.length + 9) / 64) * 64);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const end = padded.length;
  padded[end - 8] = (bitLenHi >>> 24) & 255;
  padded[end - 7] = (bitLenHi >>> 16) & 255;
  padded[end - 6] = (bitLenHi >>> 8) & 255;
  padded[end - 5] = bitLenHi & 255;
  padded[end - 4] = (bitLenLo >>> 24) & 255;
  padded[end - 3] = (bitLenLo >>> 16) & 255;
  padded[end - 2] = (bitLenLo >>> 8) & 255;
  padded[end - 1] = bitLenLo & 255;

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array<number>(64);
  for (let off = 0; off < end; off += 64) {
    for (let t = 0; t < 16; t++) {
      const j = off + t * 4;
      w[t] = ((padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = h[i] >>> 24;
    out[i * 4 + 1] = (h[i] >>> 16) & 255;
    out[i * 4 + 2] = (h[i] >>> 8) & 255;
    out[i * 4 + 3] = h[i] & 255;
  }
  return out;
};

/** HMAC-SHA256 (RFC 2104) of `message` under `key` (strings are their UTF-8 bytes). */
export const hmacSha256 = (key: Uint8Array | string, message: Uint8Array | string): Uint8Array => {
  let k = asBytes(key);
  if (k.length > 64) k = sha256(k);
  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    const b = i < k.length ? k[i] : 0;
    ipad[i] = b ^ 0x36;
    opad[i] = b ^ 0x5c;
  }
  const msg = asBytes(message);
  const inner = new Uint8Array(64 + msg.length);
  inner.set(ipad);
  inner.set(msg, 64);
  const innerHash = sha256(inner);
  const outer = new Uint8Array(64 + 32);
  outer.set(opad);
  outer.set(innerHash, 64);
  return sha256(outer);
};

const HEX = '0123456789abcdef';

export const toHex = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return out;
};

export const sha256Hex = (data: Uint8Array | string): string => toHex(sha256(data));

export const hmacSha256Hex = (key: Uint8Array | string, message: Uint8Array | string): string => toHex(hmacSha256(key, message));

// ── base64url (RFC 4648 §5, no padding) ─────────────────────────────────────────────────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export const base64urlEncode = (data: Uint8Array | string): string => {
  const bytes = asBytes(data);
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8);
    out += B64[n >> 18] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
  }
  return out;
};

/** Strict: unpadded base64url only, canonical trailing bits; `null` for anything else. */
export const base64urlDecode = (text: string): Uint8Array | null => {
  if (typeof text !== 'string' || text.length % 4 === 1 || !/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    acc = (acc << 6) | B64.indexOf(text[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null; // non-canonical trailing bits: a tampered token
  return out;
};

/** Compare two strings without an early exit on the first difference. */
export const timingSafeEqual = (a: string, b: string): boolean => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  return diff === 0;
};
