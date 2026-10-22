// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { byteCapacity, dataBytes, dataCodewords, encodeQr, formatBits, qrPath, rsRemainder, versionBits, type QrMatrix } from './qr';

const hex = (a: number[]) => a.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
const LINK = 'https://dreamstreamstudio.ai/live#/monitor/join/11111111-2222-4333-8444-555555555555/AbCdEfGhIjKlMnOpQrStUv';

/* ---------------------------------------------------------------------------
 * An independent reader, written from the standard rather than from qr.ts:
 * its own function-pattern map (alignment positions from the spec's table),
 * its own zigzag, mask formulas and block layout. If the encoder placed a bit
 * wrong, this reads garbage.
 * ------------------------------------------------------------------------- */
const ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
/** Total codewords, then [blocks, ECC codewords per block] at level M (ISO/IEC 18004 tables 9). */
const TOTAL = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const BLOCKS_M: [number, number][] = [[0, 0], [1, 10], [1, 16], [1, 26], [2, 18], [2, 24], [4, 16], [4, 18], [4, 22], [5, 22], [5, 26]];
const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function readQr(m: QrMatrix): { text: string; mask: number; ecl: number; eccOk: boolean } {
  const n = m.size;
  const ver = (n - 17) / 4;
  const at = (x: number, y: number) => m.modules[y][x];
  // Format information, first copy (around the top-left finder).
  const pos: [number, number][] = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  let f = 0;
  pos.forEach(([x, y], i) => {
    if (at(x, y)) f |= 1 << i;
  });
  const five = (f ^ 0x5412) >> 10;
  const ecl = five >> 3;
  const mask = five & 7;

  const fn = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const mark = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < n && y < n) fn[y][x] = true;
  };
  mark(0, 0, 9, 9);
  mark(n - 8, 0, 8, 9);
  mark(0, n - 8, 9, 8);
  mark(6, 0, 1, n);
  mark(0, 6, n, 1);
  const a = ALIGN[ver];
  for (const cx of a) {
    for (const cy of a) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === a[a.length - 1]) || (cx === a[a.length - 1] && cy === 6)) continue;
      mark(cx - 2, cy - 2, 5, 5);
    }
  }
  if (ver >= 7) {
    mark(n - 11, 0, 3, 6);
    mark(0, n - 11, 6, 3);
  }

  const bits: number[] = [];
  let up = true;
  for (let right = n - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (let k = 0; k < n; k++) {
      const y = up ? n - 1 - k : k;
      for (const x of [right, right - 1]) if (!fn[y][x]) bits.push(at(x, y) !== MASKS[mask](x, y) ? 1 : 0);
    }
    up = !up;
  }
  const words: number[] = [];
  for (let i = 0; i + 8 <= bits.length && words.length < TOTAL[ver]; i += 8) words.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));

  const [numBlocks, ecc] = BLOCKS_M[ver];
  const shortTotal = Math.floor(TOTAL[ver] / numBlocks);
  const numLong = TOTAL[ver] % numBlocks;
  const dataLen = Array.from({ length: numBlocks }, (_, j) => shortTotal - ecc + (j >= numBlocks - numLong ? 1 : 0));
  const blocks = dataLen.map(() => [] as number[]);
  let k = 0;
  for (let i = 0; i < Math.max(...dataLen); i++) for (let j = 0; j < numBlocks; j++) if (i < dataLen[j]) blocks[j].push(words[k++]);
  const eccBlocks = dataLen.map(() => [] as number[]);
  for (let i = 0; i < ecc; i++) for (let j = 0; j < numBlocks; j++) eccBlocks[j].push(words[k++]);
  const eccOk = blocks.every((b, j) => hex(rsRemainder(b, ecc)) === hex(eccBlocks[j]));

  const stream = blocks.flat().flatMap((b) => Array.from({ length: 8 }, (_, i) => (b >> (7 - i)) & 1));
  let p = 0;
  const take = (len: number) => {
    let v = 0;
    for (let i = 0; i < len; i++) v = (v << 1) | stream[p++];
    return v;
  };
  if (take(4) !== 0b0100) throw new Error('not byte mode');
  const count = take(ver < 10 ? 8 : 16);
  const bytes = new Uint8Array(count);
  for (let i = 0; i < count; i++) bytes[i] = take(8);
  return { text: new TextDecoder().decode(bytes), mask, ecl, eccOk };
}

const randomLink = (r: () => number) => {
  const pick = (s: string, len: number) => Array.from({ length: len }, () => s[Math.floor(r() * s.length)]).join('');
  const hexs = '0123456789abcdef';
  const nid = `${pick(hexs, 8)}-${pick(hexs, 4)}-4${pick(hexs, 3)}-8${pick(hexs, 3)}-${pick(hexs, 12)}`;
  const code = pick('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', 22);
  const origin = ['https://dreamstreamstudio.ai', 'http://localhost:5173', 'https://comic2.pages.dev'][Math.floor(r() * 3)];
  return `${origin}/live#/monitor/join/${nid}/${code}`;
};
/** Small deterministic PRNG so failures reproduce. */
const prng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

describe('QR building blocks (known vectors)', () => {
  it('Reed–Solomon: the standard’s HELLO WORLD 1-M example', () => {
    const data = [0x20, 0x5b, 0x0b, 0x78, 0xd1, 0x72, 0xdc, 0x4d, 0x43, 0x40, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
    expect(hex(rsRemainder(data, 10))).toBe('C4 23 27 77 EB D7 E7 E2 5D 17');
  });

  it('format and version information', () => {
    expect(formatBits(0).toString(2).padStart(15, '0')).toBe('101010000010010');
    for (let mask = 0; mask < 8; mask++) expect((formatBits(mask) ^ 0x5412) >> 10).toBe(mask); // level M = 00
    expect(versionBits(7)).toBe(0x07c94);
    expect(versionBits(8)).toBe(0x085bc);
    expect(versionBits(9)).toBe(0x09a99);
    expect(versionBits(10)).toBe(0x0a4d3);
  });

  it('byte-mode capacity at level M, versions 1–10', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(byteCapacity)).toEqual([14, 26, 42, 62, 84, 106, 122, 152, 180, 213]);
    expect(dataCodewords(7)).toBe(124); // 4 blocks of 31 data + 18 ECC codewords
  });

  it('pads with the terminator and alternating 0xEC 0x11', () => {
    expect(hex(dataBytes(new TextEncoder().encode('a'), 1))).toBe('40 16 10 EC 11 EC 11 EC 11 EC 11 EC 11 EC 11 EC');
  });
});

describe('encodeQr', () => {
  it('fits a nursery share link (107 characters) in version 7: 45×45 modules', () => {
    expect(LINK).toHaveLength(107);
    const m = encodeQr(LINK);
    expect(m.version).toBe(7);
    expect(m.size).toBe(45);
    expect(readQr(m)).toMatchObject({ text: LINK, ecl: 0, eccOk: true, mask: m.mask });
  });

  it('draws the finder, timing and dark-module patterns', () => {
    const m = encodeQr(LINK);
    const n = m.size;
    const finder = (x0: number, y0: number) => {
      for (let y = 0; y < 7; y++) {
        for (let x = 0; x < 7; x++) {
          const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
          expect(m.modules[y0 + y][x0 + x]).toBe(ring !== 2);
        }
      }
    };
    finder(0, 0);
    finder(n - 7, 0);
    finder(0, n - 7);
    for (let i = 8; i < n - 8; i++) {
      expect(m.modules[6][i]).toBe(i % 2 === 0);
      expect(m.modules[i][6]).toBe(i % 2 === 0);
    }
    expect(m.modules[n - 8][8]).toBe(true);
  });

  it('round-trips random links, unicode and every length up to version 10', () => {
    const r = prng(42);
    const texts = [
      ...Array.from({ length: 40 }, () => randomLink(r)),
      'Héllo — ünïcode ✓ 👶',
      ...[1, 14, 15, 26, 27, 62, 106, 107, 122, 123, 152, 180, 181, 213].map((len) => 'x'.repeat(len)),
    ];
    for (const t of texts) {
      const m = encodeQr(t);
      const got = readQr(m);
      expect(got.text).toBe(t);
      expect(got.eccOk).toBe(true);
      expect(got.mask).toBe(m.mask);
    }
  });

  it('every mask reads back; the chosen one is stable', () => {
    for (let mask = 0; mask < 8; mask++) expect(readQr(encodeQr(LINK, { mask }))).toMatchObject({ text: LINK, mask, eccOk: true });
    expect(encodeQr(LINK).mask).toBe(encodeQr(LINK).mask);
    expect(encodeQr(LINK).modules).toEqual(encodeQr(LINK).modules);
  });

  it('refuses text longer than version 10 holds', () => {
    expect(() => encodeQr('x'.repeat(214))).toThrow(/too long/);
  });
});

describe('qrPath', () => {
  it('covers exactly the dark modules, offset by the quiet zone', () => {
    const m = encodeQr('HELLO WORLD');
    const d = qrPath(m, 4);
    let area = 0;
    for (const [, , , w] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) area += Number(w);
    const dark = m.modules.flat().filter(Boolean).length;
    expect(area).toBe(dark);
    const xs = [...d.matchAll(/M(\d+) (\d+)/g)].map((x) => Number(x[1]));
    expect(Math.min(...xs)).toBe(4);
  });
});
