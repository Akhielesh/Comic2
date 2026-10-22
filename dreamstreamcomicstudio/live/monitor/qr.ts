/**
 * QR codes for the nursery share link, drawn on this device.
 *
 * The share link carries the link's secret code, so it must never be sent to
 * an online QR service (api.qrserver.com and friends would see — and could
 * log — every nursery link). This is a small, dependency-free encoder: byte
 * mode (UTF-8), error correction level M (~15 % of the code can be damaged or
 * covered), versions 1–10 (21×21 up to 57×57 modules, up to 213 bytes), and
 * the mask chosen by the standard's penalty score (ISO/IEC 18004 §8.8).
 *
 * Ported and trimmed from Project Nayuki's QR Code generator library
 * (https://www.nayuki.io/page/qr-code-generator-library), used under the MIT
 * License:
 *
 *   Copyright (c) Project Nayuki. (MIT License)
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a
 *   copy of this software and associated documentation files (the "Software"),
 *   to deal in the Software without restriction, including without limitation
 *   the rights to use, copy, modify, merge, publish, distribute, sublicense,
 *   and/or sell copies of the Software, and to permit persons to whom the
 *   Software is furnished to do so, subject to the following conditions:
 *   - The above copyright notice and this permission notice shall be included
 *     in all copies or substantial portions of the Software.
 *   - The Software is provided "as is", without warranty of any kind, express
 *     or implied, including but not limited to the warranties of
 *     merchantability, fitness for a particular purpose and noninfringement.
 *     In no event shall the authors or copyright holders be liable for any
 *     claim, damages or other liability, whether in an action of contract,
 *     tort or otherwise, arising from, out of or in connection with the
 *     Software or the use or other dealings in the Software.
 */

export const MIN_VERSION = 1;
export const MAX_VERSION = 10;

/** Level M, indexed by version (index 0 unused). */
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const ECC_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
/** Level M's two format bits (L = 01, M = 00, Q = 11, H = 10). */
const ECC_FORMAT_BITS = 0;

export interface QrMatrix {
  version: number;
  /** Modules per side (without the quiet zone). */
  size: number;
  mask: number;
  /** modules[y][x] — true is dark. */
  modules: boolean[][];
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

/** Data bits a version can hold, after the function patterns. */
export function rawDataModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

/** Data codewords (bytes) at level M. */
export function dataCodewords(ver: number): number {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * ECC_BLOCKS[ver];
}

/** Bytes of text a version holds in byte mode at level M. */
export function byteCapacity(ver: number): number {
  const countBits = ver < 10 ? 8 : 16;
  return Math.floor((dataCodewords(ver) * 8 - 4 - countBits) / 8);
}

/* ---------------------------------------------------------- Reed–Solomon */

/** Multiplication in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1. */
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const out = new Array<number>(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < out.length; j++) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < out.length) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return out;
}

/** The `degree` error-correction bytes for a block of data. */
export function rsRemainder(data: number[], degree: number): number[] {
  const div = rsDivisor(degree);
  const out = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ (out.shift() as number);
    out.push(0);
    for (let i = 0; i < div.length; i++) out[i] ^= gfMul(div[i], factor);
  }
  return out;
}

/* ------------------------------------------------------ BCH-coded fields */

/** The 15 format bits for level M and a mask (before they are placed). */
export function formatBits(mask: number): number {
  const data = (ECC_FORMAT_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18 version bits (versions 7 and up). */
export function versionBits(ver: number): number {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

/* -------------------------------------------------------------- encoding */

/** The data codewords (before error correction) for some bytes at a version. */
export function dataBytes(bytes: Uint8Array, ver: number): number[] {
  const bits: number[] = [];
  const push = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const cap = dataCodewords(ver) * 8;
  if (bits.length > cap) throw new Error('qr: data too long for this version');
  push(0, Math.min(4, cap - bits.length)); // terminator
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) push(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    out.push(b);
  }
  return out;
}

/** Split into blocks, add each block's error correction, interleave. */
export function interleave(data: number[], ver: number): number[] {
  const numBlocks = ECC_BLOCKS[ver];
  const eccLen = ECC_PER_BLOCK[ver];
  const raw = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, eccLen);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => {
      // Skip the short blocks' padding cell.
      if (i !== shortLen - eccLen || j >= numShort) out.push(b[i]);
    });
  }
  return out;
}

export function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const size = ver * 4 + 17;
  const num = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (num * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < num; pos -= step) out.splice(1, 0, pos);
  return out;
}

class Grid {
  readonly size: number;
  readonly mod: boolean[][];
  readonly fn: boolean[][];
  constructor(readonly ver: number) {
    this.size = ver * 4 + 17;
    this.mod = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  private setFn(x: number, y: number, dark: boolean): void {
    this.mod[y][x] = dark;
    this.fn[y][x] = true;
  }

  drawFunctionPatterns(): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.setFn(6, i, i % 2 === 0);
      this.setFn(i, 6, i % 2 === 0);
    }
    this.finder(3, 3);
    this.finder(n - 4, 3);
    this.finder(3, n - 4);
    const pos = alignmentPositions(this.ver);
    const k = pos.length;
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) {
        // Not on top of the three finder patterns.
        if ((i === 0 && j === 0) || (i === 0 && j === k - 1) || (i === k - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) this.setFn(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    this.drawFormat(0); // reserves the area; redrawn with the chosen mask
    if (this.ver >= 7) {
      const bits = versionBits(this.ver);
      for (let i = 0; i < 18; i++) {
        const a = n - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.setFn(a, b, bit(bits, i));
        this.setFn(b, a, bit(bits, i));
      }
    }
  }

  private finder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFn(xx, yy, d !== 2 && d !== 4);
      }
    }
  }

  drawFormat(mask: number): void {
    const bits = formatBits(mask);
    const n = this.size;
    // Around the top-left finder.
    for (let i = 0; i <= 5; i++) this.setFn(8, i, bit(bits, i));
    this.setFn(8, 7, bit(bits, 6));
    this.setFn(8, 8, bit(bits, 7));
    this.setFn(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFn(14 - i, 8, bit(bits, i));
    // The copy split between the other two finders.
    for (let i = 0; i < 8; i++) this.setFn(n - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.setFn(8, n - 15 + i, bit(bits, i));
    this.setFn(8, n - 8, true); // the dark module
  }

  /** Codewords in the standard's two-column zigzag, bottom-right first. */
  drawCodewords(data: number[]): void {
    const n = this.size;
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // skip the vertical timing column
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? n - 1 - vert : vert;
          if (!this.fn[y][x] && i < data.length * 8) {
            this.mod[y][x] = bit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  /** XOR a mask over the data area (applying it twice undoes it). */
  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.fn[y][x]) continue;
        let inv: boolean;
        switch (mask) {
          case 0: inv = (x + y) % 2 === 0; break;
          case 1: inv = y % 2 === 0; break;
          case 2: inv = x % 3 === 0; break;
          case 3: inv = (x + y) % 3 === 0; break;
          case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (inv) this.mod[y][x] = !this.mod[y][x];
      }
    }
  }

  /** The standard's penalty: long runs, 2×2 blocks, finder look-alikes, dark/light balance. */
  penalty(): number {
    const n = this.size;
    const m = this.mod;
    let score = 0;
    const line = (get: (a: number, b: number) => boolean) => {
      for (let a = 0; a < n; a++) {
        let color = false;
        let run = 0;
        const hist = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < n; b++) {
          if (get(a, b) === color) {
            run++;
            if (run === 5) score += 3;
            else if (run > 5) score++;
          } else {
            addHistory(run, hist, n);
            if (!color) score += countFinderLike(hist) * 40;
            color = get(a, b);
            run = 1;
          }
        }
        if (color) {
          addHistory(run, hist, n);
          run = 0;
        }
        addHistory(run + n, hist, n); // the light quiet zone after the last run
        score += countFinderLike(hist) * 40;
      }
    };
    line((y, x) => m[y][x]);
    line((x, y) => m[y][x]);
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
      }
    }
    let dark = 0;
    for (const row of m) for (const c of row) if (c) dark++;
    const total = n * n;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }
}

function addHistory(run: number, hist: number[], size: number): void {
  if (hist[0] === 0) run += size; // the light quiet zone before the first run
  hist.pop();
  hist.unshift(run);
}

function countFinderLike(h: number[]): number {
  const n = h[1];
  const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
  return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
}

/**
 * Encode text (UTF-8, byte mode, level M) in the smallest version from
 * `minVersion` that fits. `mask` forces a mask (tests); otherwise the one
 * with the lowest penalty wins (ties go to the lower number).
 */
export function encodeQr(text: string, o: { minVersion?: number; mask?: number } = {}): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let ver = Math.max(MIN_VERSION, o.minVersion ?? MIN_VERSION);
  while (ver <= MAX_VERSION && bytes.length > byteCapacity(ver)) ver++;
  if (ver > MAX_VERSION) throw new Error(`qr: ${bytes.length} bytes is too long (max ${byteCapacity(MAX_VERSION)})`);
  const g = new Grid(ver);
  g.drawFunctionPatterns();
  g.drawCodewords(interleave(dataBytes(bytes, ver), ver));
  let mask = o.mask ?? -1;
  if (mask < 0) {
    let best = Infinity;
    for (let k = 0; k < 8; k++) {
      g.applyMask(k);
      g.drawFormat(k);
      const p = g.penalty();
      if (p < best) {
        best = p;
        mask = k;
      }
      g.applyMask(k);
    }
  }
  g.applyMask(mask);
  g.drawFormat(mask);
  return { version: ver, size: g.size, mask, modules: g.mod };
}

/**
 * One SVG path for the dark modules (horizontal runs merged), offset by a
 * quiet zone of `border` modules. The viewBox is `size + 2 × border` square.
 */
export function qrPath(m: QrMatrix, border = 4): string {
  let d = '';
  for (let y = 0; y < m.size; y++) {
    let x = 0;
    while (x < m.size) {
      if (!m.modules[y][x]) {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < m.size && m.modules[y][x + w]) w++;
      d += `M${x + border} ${y + border}h${w}v1h-${w}z`;
      x += w;
    }
  }
  return d;
}
