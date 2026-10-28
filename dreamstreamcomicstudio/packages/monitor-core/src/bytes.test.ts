// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { b64url, concat, equalBytes, fromB64url, fromHex, fromUtf8, hex, readU64, readUint, utf8, writeU64, writeUint } from './bytes';

describe('utf8', () => {
  it('matches TextEncoder / TextDecoder on every plane', () => {
    for (const s of ['', 'abc', 'Maya’s room', 'naïve café', '日本語', '👶🏽 crib', '\u0000\u007f\u0080߿ࠀ￿']) {
      expect(Array.from(utf8(s))).toEqual(Array.from(new TextEncoder().encode(s)));
      expect(fromUtf8(utf8(s))).toBe(s);
    }
  });

  it('writes a lone surrogate as U+FFFD, like TextEncoder', () => {
    expect(Array.from(utf8('a\ud800b'))).toEqual(Array.from(new TextEncoder().encode('a\ud800b')));
  });

  it('refuses invalid UTF-8 instead of guessing', () => {
    for (const bad of [[0xc0, 0x80], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82], [0x80], [0xff]]) {
      expect(fromUtf8(Uint8Array.from(bad))).toBeNull();
    }
  });
});

describe('base64url', () => {
  it('round-trips every length and matches Node', () => {
    for (let n = 0; n < 70; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
      const s = b64url(b);
      expect(s).toBe(Buffer.from(b).toString('base64url'));
      expect(Array.from(fromB64url(s)!)).toEqual(Array.from(b));
    }
  });

  it('accepts padding and rejects other alphabets and non-canonical tails', () => {
    expect(Array.from(fromB64url('AQ==')!)).toEqual([1]);
    expect(fromB64url('A+/=')).toBeNull();
    expect(fromB64url('A')).toBeNull();
    expect(fromB64url('AR')).toBeNull(); // the canonical form of [1] is "AQ"
    expect(fromB64url(42 as unknown as string)).toBeNull();
  });
});

describe('hex and integers', () => {
  it('hex round-trips and rejects junk', () => {
    expect(hex(Uint8Array.of(0, 15, 255))).toBe('000fff');
    expect(Array.from(fromHex('000fff')!)).toEqual([0, 15, 255]);
    expect(fromHex('0g')).toBeNull();
    expect(fromHex('abc')).toBeNull();
  });

  it('writes big-endian unsigned integers up to 2^53', () => {
    const b = new Uint8Array(8);
    writeUint(b, 0, 6, 2 ** 48 - 1);
    expect(readUint(b, 0, 6)).toBe(2 ** 48 - 1);
    writeU64(b, 0, Number.MAX_SAFE_INTEGER);
    expect(hex(b)).toBe('001fffffffffffff');
    expect(readU64(b, 0)).toBe(Number.MAX_SAFE_INTEGER);
    b[1] = 0x20;
    expect(readU64(b, 0)).toBeNull();
  });

  it('concat and constant-time equality', () => {
    expect(Array.from(concat(Uint8Array.of(1), Uint8Array.of(), Uint8Array.of(2, 3)))).toEqual([1, 2, 3]);
    expect(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(equalBytes(Uint8Array.of(1), Uint8Array.of(1, 2))).toBe(false);
  });
});
