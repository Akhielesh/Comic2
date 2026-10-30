/**
 * Byte helpers with no platform dependency: no TextEncoder, TextDecoder, atob, btoa or Buffer (none is in the
 * ES2017 library this package compiles against, and not every host has them).
 */

/** UTF-8 bytes of a string. A lone surrogate becomes U+FFFD, as TextEncoder does. */
export const utf8Encode = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length * 3);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else c = 0xfffd;
    } else if (c >= 0xdc00 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out[n++] = c;
    else if (c < 0x800) {
      out[n++] = 0xc0 | (c >> 6);
      out[n++] = 0x80 | (c & 63);
    } else if (c < 0x10000) {
      out[n++] = 0xe0 | (c >> 12);
      out[n++] = 0x80 | ((c >> 6) & 63);
      out[n++] = 0x80 | (c & 63);
    } else {
      out[n++] = 0xf0 | (c >> 18);
      out[n++] = 0x80 | ((c >> 12) & 63);
      out[n++] = 0x80 | ((c >> 6) & 63);
      out[n++] = 0x80 | (c & 63);
    }
  }
  return out.slice(0, n);
};

const CHUNK = 8192;

/**
 * A string from UTF-8 bytes, or null when they are not valid UTF-8 (strict: no replacement character, no overlong
 * forms, no surrogates). A leading byte-order mark is kept, as JSON.parse would then refuse it.
 */
export const utf8Decode = (bytes: Uint8Array): string | null => {
  const parts: string[] = [];
  let units: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const c = bytes[i];
    let cp: number;
    let extra: number;
    if (c < 0x80) {
      cp = c;
      extra = 0;
    } else if (c >= 0xc2 && c <= 0xdf) {
      cp = c & 31;
      extra = 1;
    } else if (c >= 0xe0 && c <= 0xef) {
      cp = c & 15;
      extra = 2;
    } else if (c >= 0xf0 && c <= 0xf4) {
      cp = c & 7;
      extra = 3;
    } else return null;
    if (i + extra >= bytes.length && extra > 0) return null;
    for (let k = 1; k <= extra; k++) {
      const d = bytes[i + k];
      if ((d & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (d & 63);
    }
    if ((extra === 2 && cp < 0x800) || (extra === 3 && (cp < 0x10000 || cp > 0x10ffff)) || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    if (cp < 0x10000) units.push(cp);
    else {
      const v = cp - 0x10000;
      units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    }
    if (units.length >= CHUNK) {
      parts.push(String.fromCharCode.apply(null, units));
      units = [];
    }
    i += extra + 1;
  }
  if (units.length) parts.push(String.fromCharCode.apply(null, units));
  return parts.join('');
};

/** The bytes of an ASCII string (a token, a canonical request string that is already ASCII). */
export const asciiBytes = (text: string): Uint8Array => utf8Encode(text);

const HEX = '0123456789abcdef';

/** Lower-case hex. */
export const toHex = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return out;
};

/** Bytes from hex (either case), or null when it is not an even-length hex string. */
export const fromHex = (text: string): Uint8Array | null => {
  if (typeof text !== 'string' || text.length % 2 !== 0 || !/^[0-9A-Fa-f]*$/.test(text)) return null;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.substring(i * 2, i * 2 + 2), 16);
  return out;
};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX: { [ch: string]: number } = {};
for (let i = 0; i < B64.length; i++) B64_INDEX[B64[i]] = i;

/** base64url without padding (RFC 4648 §5): the form every token and signature on the wire uses. */
export const base64urlEncode = (bytes: Uint8Array): string => {
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

/**
 * Bytes from base64url, or null unless the text is in canonical form: the url alphabet only, no padding, and zero
 * bits after the last byte. So every byte string has exactly one accepted encoding.
 */
export const base64urlDecode = (text: string): Uint8Array | null => {
  if (typeof text !== 'string' || text.length % 4 === 1) return null;
  const full = Math.floor(text.length / 4) * 3;
  const rest = text.length % 4;
  const out = new Uint8Array(full + (rest ? rest - 1 : 0));
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const chunk = text.substring(i, i + 4);
    let n = 0;
    for (let k = 0; k < 4; k++) {
      if (k < chunk.length) {
        const v = B64_INDEX[chunk[k]];
        if (v === undefined || !Object.prototype.hasOwnProperty.call(B64_INDEX, chunk[k])) return null;
        n = (n << 6) | v;
      } else n <<= 6;
    }
    out[o++] = (n >> 16) & 255;
    if (chunk.length > 2) out[o++] = (n >> 8) & 255;
    else if (n & 0xffff) return null;
    if (chunk.length > 3) out[o++] = n & 255;
    else if (chunk.length === 3 && n & 0xff) return null;
  }
  return out;
};

/**
 * Constant-time equality of two byte strings: the time depends only on the lengths (which are public: 32-byte
 * MACs), never on where the first difference is.
 */
export const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};

/** Constant-time equality of two strings (code unit by code unit), for encoded MACs. */
export const constantTimeEqualText = (a: string, b: string): boolean => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** A fresh `ArrayBuffer` holding exactly `bytes` (what `fetch` and WebCrypto are handed). */
export const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
};
