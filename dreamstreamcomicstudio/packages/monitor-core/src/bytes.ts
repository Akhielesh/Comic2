/**
 * Byte helpers with no platform dependency: no TextEncoder, atob or Buffer, which not
 * every runtime this core targets has (Hermes in React Native among them). Inputs are
 * small (keys, signaling, glance JSON), so plain loops are plenty fast.
 */

/** UTF-8 bytes of a string. Lone surrogates become U+FFFD, as TextEncoder does. */
export function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    let c = ch.codePointAt(0) ?? 0xfffd;
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** A string from UTF-8 bytes; null when they aren't valid UTF-8 (strict: no replacement). */
export function fromUtf8(b: Uint8Array): string | null {
  let s = '';
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    let cp: number;
    let n: number;
    if (c < 0x80) {
      cp = c;
      n = 0;
    } else if (c >= 0xc2 && c <= 0xdf) {
      cp = c & 31;
      n = 1;
    } else if (c >= 0xe0 && c <= 0xef) {
      cp = c & 15;
      n = 2;
    } else if (c >= 0xf0 && c <= 0xf4) {
      cp = c & 7;
      n = 3;
    } else return null;
    if (n && i + n >= b.length) return null;
    for (let k = 1; k <= n; k++) {
      const d = b[i + k];
      if ((d & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (d & 63);
    }
    // Overlong forms, surrogates and out-of-range code points are invalid UTF-8.
    if ((n === 2 && cp < 0x800) || (n === 3 && (cp < 0x10000 || cp > 0x10ffff)) || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    s += String.fromCodePoint(cp);
    i += n + 1;
  }
  return s;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_INDEX[B64[i]] = i;

/** base64url without padding (RFC 4648 §5), the form every contract here uses. */
export function b64url(b: Uint8Array): string {
  let s = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    s += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < b.length) {
    const n = (b[i] << 16) | ((i + 1 < b.length ? b[i + 1] : 0) << 8);
    s += B64[n >> 18] + B64[(n >> 12) & 63];
    if (i + 1 < b.length) s += B64[(n >> 6) & 63];
  }
  return s;
}

/** Bytes from base64url (padding tolerated); null when it isn't base64url. */
export function fromB64url(s: string): Uint8Array | null {
  if (typeof s !== 'string') return null;
  const t = s.endsWith('==') ? s.slice(0, -2) : s.endsWith('=') ? s.slice(0, -1) : s;
  if (t.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((t.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < t.length; i += 4) {
    let n = 0;
    const len = Math.min(4, t.length - i);
    for (let k = 0; k < 4; k++) {
      const v = k < len ? B64_INDEX[t[i + k]] : 0;
      if (v === undefined) return null;
      n = (n << 6) | v;
    }
    out[o++] = (n >> 16) & 255;
    if (len > 2) out[o++] = (n >> 8) & 255;
    if (len > 3) out[o++] = n & 255;
  }
  // Non-canonical trailing bits (e.g. "AB" vs "AA" for one byte) would let two strings decode alike.
  if (b64url(out) !== t) return null;
  return out;
}

export function hex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += (x < 16 ? '0' : '') + x.toString(16);
  return s;
}

export function fromHex(s: string): Uint8Array | null {
  if (typeof s !== 'string' || s.length % 2 || !/^[0-9a-fA-F]*$/.test(s)) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Equal bytes, in time that depends only on the length. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** Big-endian unsigned integer of `bytes` bytes (≤ 7, so it stays an exact JS number). */
export function writeUint(out: Uint8Array, at: number, bytes: number, value: number): void {
  let v = value;
  for (let i = bytes - 1; i >= 0; i--) {
    out[at + i] = v % 256;
    v = Math.floor(v / 256);
  }
}

export function readUint(b: Uint8Array, at: number, bytes: number): number {
  let v = 0;
  for (let i = 0; i < bytes; i++) v = v * 256 + b[at + i];
  return v;
}

/** Big-endian u64 that must stay a safe integer (sequence numbers); the top byte is checked to be 0. */
export function writeU64(out: Uint8Array, at: number, value: number): void {
  out[at] = 0;
  writeUint(out, at + 1, 7, value);
}

/** A u64 as an exact JS number, or null when it doesn't fit in 2^53. */
export function readU64(b: Uint8Array, at: number): number | null {
  if (b[at] !== 0 || b[at + 1] > 0x1f) return null;
  return readUint(b, at + 1, 7);
}
