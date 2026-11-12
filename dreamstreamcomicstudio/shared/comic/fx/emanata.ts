// Emanata (master plan §2.6 "Effects": emanata 12, PE-FX): the cartoonist's marks around a character (sweat drops,
// shake marks, surprise lines, the anger mark, hearts, dizzy stars, steam puffs, sleep Zs, music notes, gloom lines,
// an exclamation and a dizzy swirl). One generator, `emanata@1`: a symbol, how many, how big and how they are arranged.
// Pure; registered by fx/generators.ts, never imported by the registry. Parameters arrive clamped (fxParamsOf); every
// symbol is filled (no strokes) in the isotropic frame (draw.ts), at most 29 segments a symbol and 12 symbols.

import type { FxNode } from './types.js';
import { fillPath, FxPath, fxFrame, fxRng, pBool, pNum, pStr, TAU, type FxParams, type Pt } from './draw.js';
import { clampNum } from './seed.js';

const SALT = 0x0b4611a3;

// The symbol and arrangement ids are the registry's (FX_EMANATA_SYMBOLS, FX_EMANATA_ARRANGEMENTS in fx/registry.ts).
/** Symbols drawn in two tones: an ink outline under the fill colour. */
const TWO_TONE: ReadonlySet<string> = new Set(['sweat', 'heart', 'star', 'steam']);

/** A symbol's cell: its centre, size, turn and mirror. Points are given in the cell's own −0.5..0.5 square (y down). */
interface Cell {
  c: Pt;
  s: number;
  rot: number;
  flip: boolean;
}
const at = (cell: Cell, u: number, v: number): Pt => {
  const x = (cell.flip ? -u : u) * cell.s;
  const y = v * cell.s;
  const cs = Math.cos(cell.rot);
  const sn = Math.sin(cell.rot);
  return [cell.c[0] + x * cs - y * sn, cell.c[1] + x * sn + y * cs];
};
type UV = readonly [number, number];
const polyUV = (path: FxPath, cell: Cell, uv: readonly UV[]): void => {
  path.poly(uv.map(([u, v]) => at(cell, u, v)));
};
/** A closed cubic outline in cell units: a start point, then [c1, c2, end] triples. */
const cubicUV = (path: FxPath, cell: Cell, start: UV, curves: readonly (readonly [UV, UV, UV])[], scale = 1, about: UV = [0, 0]): void => {
  const sc = ([u, v]: UV): Pt => at(cell, about[0] + (u - about[0]) * scale, about[1] + (v - about[1]) * scale);
  path.m(sc(start));
  for (const [c1, c2, e] of curves) path.c(sc(c1), sc(c2), sc(e));
  path.z();
};
const lensUV = (path: FxPath, cell: Cell, a: UV, b: UV, w: number, bulge = 0): void => {
  path.lens(at(cell, a[0], a[1]), at(cell, b[0], b[1]), w * cell.s, bulge * cell.s * (cell.flip ? -1 : 1));
};
const ellipseUV = (path: FxPath, cell: Cell, c: UV, r: number): void => {
  path.ellipse(at(cell, c[0], c[1]), r * cell.s, r * cell.s);
};

// ── The symbols ──────────────────────────────────────────────────────────────────────────────────────────────────

const DROP: readonly (readonly [UV, UV, UV])[] = [
  [[0.12, -0.3], [0.32, -0.05], [0.32, 0.15]],
  [[0.32, 0.34], [0.18, 0.47], [0, 0.47]],
  [[-0.18, 0.47], [-0.32, 0.34], [-0.32, 0.15]],
  [[-0.32, -0.05], [-0.12, -0.3], [0, -0.5]]
];
const HEART: readonly (readonly [UV, UV, UV])[] = [
  [[-0.15, 0.3], [-0.48, 0.08], [-0.48, -0.15]],
  [[-0.48, -0.38], [-0.22, -0.48], [0, -0.28]],
  [[0.22, -0.48], [0.48, -0.38], [0.48, -0.15]],
  [[0.48, 0.08], [0.15, 0.3], [0, 0.42]]
];
const STAR: readonly UV[] = Array.from({ length: 10 }, (_, k) => {
  const r = k % 2 === 0 ? 0.5 : 0.21;
  const a = -Math.PI / 2 + (k * Math.PI) / 5;
  return [Math.cos(a) * r, Math.sin(a) * r * 1.02 + 0.03] as UV;
});
const ZED: readonly UV[] = [
  [-0.36, -0.45],
  [0.38, -0.45],
  [0.38, -0.3],
  [-0.12, 0.3],
  [0.38, 0.3],
  [0.38, 0.45],
  [-0.38, 0.45],
  [-0.38, 0.3],
  [0.12, -0.3],
  [-0.36, -0.3]
];

/** Draws one symbol: ink marks into `ink`, fill-colour parts into `fill`. */
const drawSymbol = (symbol: string, cell: Cell, outline: boolean, ink: FxPath, fill: FxPath): void => {
  switch (symbol) {
    case 'sweat':
      if (outline) {
        cubicUV(ink, cell, [0, -0.5], DROP);
        cubicUV(fill, cell, [0, -0.5], DROP, 0.7, [0, 0.14]);
      } else cubicUV(fill, cell, [0, -0.5], DROP);
      return;
    case 'heart':
      if (outline) {
        cubicUV(ink, cell, [0, 0.42], HEART);
        cubicUV(fill, cell, [0, 0.42], HEART, 0.76, [0, -0.02]);
      } else cubicUV(fill, cell, [0, 0.42], HEART);
      return;
    case 'star':
      if (outline) {
        polyUV(ink, cell, STAR);
        polyUV(
          fill,
          cell,
          STAR.map(([u, v]) => [u * 0.68, 0.03 + (v - 0.03) * 0.68] as UV)
        );
      } else polyUV(fill, cell, STAR);
      return;
    case 'steam':
      // A round puff of six scallops.
      if (outline) {
        ink.cloud(cell.c, 0.48 * cell.s, 6, 0.2, cell.rot);
        fill.cloud(cell.c, 0.38 * cell.s, 6, 0.2, cell.rot);
      } else fill.cloud(cell.c, 0.48 * cell.s, 6, 0.2, cell.rot);
      return;
    case 'shake':
      // ")))": three bent strokes, the inner one tallest (mirrored on the left side: "(((").
      for (let k = 0; k < 3; k += 1) {
        const x = -0.28 + 0.26 * k;
        const hh = 0.44 - 0.1 * k;
        lensUV(ink, cell, [x, -hh], [x, hh], 0.11, -0.1);
      }
      return;
    case 'surprise':
      lensUV(ink, cell, [0, 0.47], [0, -0.47], 0.2);
      return;
    case 'anger':
      // The cross-popping vein: four bent strokes, each bowing in toward the middle.
      for (let k = 0; k < 4; k += 1) {
        const q: Cell = { ...cell, rot: cell.rot + (k * Math.PI) / 2 };
        lensUV(ink, q, [0.1, -0.44], [0.44, -0.1], 0.13, 0.08);
      }
      return;
    case 'sleep':
      polyUV(ink, cell, ZED);
      return;
    case 'note':
      ellipseUV(ink, cell, [-0.16, 0.3], 0.16);
      polyUV(ink, cell, [
        [-0.03, -0.46],
        [0.05, -0.46],
        [0.05, 0.3],
        [-0.03, 0.3]
      ]);
      ink
        .m(at(cell, 0.05, -0.46))
        .q(at(cell, 0.38, -0.32), at(cell, 0.3, -0.04))
        .q(at(cell, 0.26, -0.2), at(cell, 0.05, -0.27))
        .z();
      return;
    case 'gloom':
      ink
        .m(at(cell, -0.04, -0.5))
        .c(at(cell, 0.12, -0.2), at(cell, -0.2, 0.2), at(cell, -0.04, 0.5))
        .l(at(cell, 0.04, 0.5))
        .c(at(cell, -0.12, 0.2), at(cell, 0.2, -0.2), at(cell, 0.04, -0.5))
        .z();
      return;
    case 'exclaim':
      polyUV(ink, cell, [
        [-0.12, -0.5],
        [0.12, -0.5],
        [0.05, 0.2],
        [-0.05, 0.2]
      ]);
      ellipseUV(ink, cell, [0, 0.38], 0.09);
      return;
    case 'spiral': {
      // About 1.6 turns of a widening ribbon, closed through its centre: 14 samples on each side.
      const N = 14;
      const turns = 1.6;
      const outer: Pt[] = [];
      const inner: Pt[] = [];
      for (let i = 0; i < N; i += 1) {
        const t = i / (N - 1);
        const a = t * turns * TAU;
        const r = 0.05 + 0.4 * t;
        const hw = 0.015 + 0.045 * t;
        outer.push(at(cell, Math.cos(a) * (r + hw), Math.sin(a) * (r + hw)));
        inner.push(at(cell, Math.cos(a) * (r - hw), Math.sin(a) * (r - hw)));
      }
      ink.smooth([...outer, ...inner.reverse()]);
      return;
    }
  }
};

// ── Arrangements ─────────────────────────────────────────────────────────────────────────────────────────────────

/** emanata@1: `count` symbols of one kind, arranged in the box, each kept inside it. */
export const drawEmanata = (p: FxParams, seed: number, aspect: number): FxNode[] => {
  const { A, S } = fxFrame(aspect);
  const rand = fxRng(seed, SALT);
  const symbol = pStr(p, 'symbol');
  const count = pNum(p, 'count');
  const arrange = pStr(p, 'arrange');
  const spread = pNum(p, 'spread');
  const jitter = pNum(p, 'jitter');
  const tilt = (pNum(p, 'tilt') * Math.PI) / 180;
  const outline = pBool(p, 'outline') && TWO_TONE.has(symbol);
  const base = pNum(p, 'size') * S;
  // A symbol's cell, turned and grown by the jitter (≤ 1.2×), reaches 0.85 s from its centre: keep centres that far in.
  const margin = (s: number) => Math.min(s * 0.85, A / 2, 0.5);
  const keep = (c: Pt, s: number): Pt => {
    const m = margin(s);
    return [clampNum(c[0], m, A - m), clampNum(c[1], m, 1 - m)];
  };
  const cells: Cell[] = [];
  const m0 = margin(base);
  const C: Pt = [A / 2, 0.5];
  const rx = Math.max(0, A / 2 - m0);
  const ry = Math.max(0, 0.5 - m0);
  for (let i = 0; i < count; i += 1) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    let c: Pt = C;
    let rot = 0;
    let s = base;
    let flip = false;
    switch (arrange) {
      case 'arc': {
        const span = Math.PI * (0.3 + 0.7 * spread);
        const a = -Math.PI / 2 + (t - 0.5) * span;
        c = [C[0] + Math.cos(a) * rx, C[1] + Math.sin(a) * ry];
        rot = a + Math.PI / 2;
        break;
      }
      case 'ring': {
        const a = -Math.PI / 2 + (TAU * i) / count;
        c = [C[0] + Math.cos(a) * rx * (0.4 + 0.6 * spread), C[1] + Math.sin(a) * ry * (0.4 + 0.6 * spread)];
        rot = a + Math.PI / 2;
        break;
      }
      case 'rise': {
        // Bottom-left to top-right, growing as they rise (sleep Zs, notes, hearts).
        s = base * (0.6 + 0.4 * t);
        const half = rx * spread;
        c = [C[0] - half + 2 * half * t, C[1] + ry - 2 * ry * t];
        break;
      }
      case 'row': {
        const half = rx * spread;
        c = [C[0] - half + 2 * half * t, C[1]];
        break;
      }
      case 'sides': {
        // Alternating right and left of the box (shake marks): the left ones mirrored.
        const right = i % 2 === 0;
        const k = Math.floor(i / 2);
        const rows = Math.ceil(count / 2);
        const dy = rows === 1 ? 0 : (k / (rows - 1) - 0.5) * 2 * ry * spread;
        c = [right ? A - m0 : m0, C[1] + dy];
        flip = !right;
        break;
      }
      default: {
        // 'scatter': the best of four seeded candidates, farthest from the symbols already placed.
        let best: Pt = C;
        let bestD = -1;
        for (let k = 0; k < 4; k += 1) {
          const cand: Pt = [m0 + rand() * Math.max(0, A - 2 * m0), m0 + rand() * Math.max(0, 1 - 2 * m0)];
          const d = cells.reduce((min, o) => Math.min(min, Math.hypot(o.c[0] - cand[0], o.c[1] - cand[1])), Infinity);
          if (d > bestD) {
            bestD = d;
            best = cand;
          }
        }
        c = best;
      }
    }
    // One mark sits in the middle of its box, whatever the arrangement: the creator places it by placing the box (an
    // anger mark drawn over a head lands on the head, not at a seeded spot beside it).
    if (count === 1) c = C;
    // Jitter: up to ±20 % size, ±30 % of a cell in position and ±20° of turn.
    s *= 1 + jitter * 0.4 * (rand() - 0.5);
    c = [c[0] + jitter * s * 0.3 * (rand() - 0.5), c[1] + jitter * s * 0.3 * (rand() - 0.5)];
    rot += tilt + jitter * (Math.PI / 9) * (rand() - 0.5);
    cells.push({ c: keep(c, s), s, rot, flip });
  }
  const ink = new FxPath(A);
  const fill = new FxPath(A);
  for (const cell of cells) drawSymbol(symbol, cell, outline, ink, fill);
  return [...fillPath(ink, pStr(p, 'color')), ...fillPath(fill, pStr(p, 'fill'))];
};
