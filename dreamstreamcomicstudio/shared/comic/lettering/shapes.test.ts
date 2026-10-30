import { describe, expect, it } from 'vitest';
import {
  balloonShape,
  burstPath as boardBurstPath,
  captionPath as boardCaptionPath,
  cloudPath as boardCloudPath,
  hashSeed as boardHashSeed,
  speechBodyPath as boardSpeechBodyPath,
  tailPath as boardTailPath,
  thoughtBubbles as boardThoughtBubbles
} from '../../../components/comicstudio/board/balloonGeometry';
import type { LineKind } from '../doc';
import { SHAPE_BLEED } from './place';
import {
  bubbleGeometry,
  burstPath,
  captionPath,
  cloudPath,
  hashSeed,
  linkNeck,
  resolveTailStyle,
  shadeColor,
  speechBodyPath,
  tailPath,
  thoughtBubbles,
  type BubbleGeometry
} from './shapes';
import { BUBBLE_SHAPES, LETTERING_PRESETS, LINE_KINDS, type BubbleShape } from './style';

// ── A minimal SVG path tokenizer + flattener (M L C Q A Z, absolute) ─────────

type P = { x: number; y: number };
const TOKENS = /[MLCQAZ]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;

function flatten(d: string): P[][] {
  const t = d.match(TOKENS) ?? [];
  const leftovers = d.replace(TOKENS, '').replace(/[\s,]/g, '');
  expect(leftovers).toBe(''); // nothing but M L C Q A Z and numbers
  const polys: P[][] = [];
  let cur: P[] = [];
  let pos: P = { x: 0, y: 0 };
  let i = 0;
  const n = () => {
    const v = Number(t[i++]);
    expect(Number.isFinite(v)).toBe(true);
    return v;
  };
  while (i < t.length) {
    const c = t[i++].toUpperCase();
    if (c === 'M') {
      if (cur.length) polys.push(cur);
      pos = { x: n(), y: n() };
      cur = [pos];
    } else if (c === 'L') {
      pos = { x: n(), y: n() };
      cur.push(pos);
    } else if (c === 'Q') {
      const c1 = { x: n(), y: n() };
      const e = { x: n(), y: n() };
      for (let k = 1; k <= 8; k += 1) {
        const s = k / 8;
        cur.push({ x: (1 - s) ** 2 * pos.x + 2 * (1 - s) * s * c1.x + s * s * e.x, y: (1 - s) ** 2 * pos.y + 2 * (1 - s) * s * c1.y + s * s * e.y });
      }
      pos = e;
    } else if (c === 'C') {
      const c1 = { x: n(), y: n() };
      const c2 = { x: n(), y: n() };
      const e = { x: n(), y: n() };
      for (let k = 1; k <= 8; k += 1) {
        const s = k / 8;
        const a = (1 - s) ** 3;
        const b = 3 * (1 - s) ** 2 * s;
        const cc = 3 * (1 - s) * s * s;
        const dd = s ** 3;
        cur.push({ x: a * pos.x + b * c1.x + cc * c2.x + dd * e.x, y: a * pos.y + b * c1.y + cc * c2.y + dd * e.y });
      }
      pos = e;
    } else if (c === 'A') {
      let rx = Math.abs(n());
      let ry = Math.abs(n());
      n(); // rotation (always 0 here)
      const large = n();
      const sweep = n();
      const e = { x: n(), y: n() };
      const x1 = (pos.x - e.x) / 2;
      const y1 = (pos.y - e.y) / 2;
      const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
      if (lam > 1) {
        rx *= Math.sqrt(lam);
        ry *= Math.sqrt(lam);
      }
      const sign = large !== sweep ? 1 : -1;
      const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
      const coef = sign * Math.sqrt(Math.max(0, num / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
      const cxp = (coef * rx * y1) / ry;
      const cyp = (-coef * ry * x1) / rx;
      const cx = cxp + (pos.x + e.x) / 2;
      const cy = cyp + (pos.y + e.y) / 2;
      const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      const th1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
      let dth = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
      if (!sweep && dth > 0) dth -= 2 * Math.PI;
      if (sweep && dth < 0) dth += 2 * Math.PI;
      for (let k = 1; k <= 16; k += 1) {
        const th = th1 + (dth * k) / 16;
        cur.push({ x: cx + rx * Math.cos(th), y: cy + ry * Math.sin(th) });
      }
      pos = e;
    } else if (c === 'Z') {
      if (cur.length) polys.push(cur);
      cur = [];
    }
  }
  if (cur.length) polys.push(cur);
  return polys;
}

const inside = (poly: P[], p: P): boolean => {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) r = !r;
  }
  return r;
};

const BOXES = [
  { w: 300, h: 60, label: 'wide' },
  { w: 130, h: 110, label: 'square' },
  { w: 90, h: 200, label: 'tall' }
];
const INSET = { x: 15, y: 13 };
const opts = (extra: Partial<Parameters<typeof bubbleGeometry>[3]> = {}) => ({ inset: INSET, seed: hashSeed('pg_1_l1'), tail: 'none' as const, tailWidth: 1, stroke: 2.8, ...extra });
const BODY_SHAPES = BUBBLE_SHAPES.filter((s) => s !== 'none');

describe('bubble library: every shape × 3 boxes', () => {
  it('covers the 13 drawn shapes plus none', () => {
    expect(BUBBLE_SHAPES).toHaveLength(14);
    expect(bubbleGeometry('none', 100, 40, opts())).toEqual({ bubbles: [], bounds: { x: 0, y: 0, w: 100, h: 40 } });
  });
  for (const shape of BODY_SHAPES)
    for (const box of BOXES)
      it(`${shape} (${box.label}): closed, finite, text corners inside, bounds contain the outline`, () => {
        const g = bubbleGeometry(shape, box.w, box.h, opts({ borderStyle: 'solid' }));
        expect(g.body).toBeTruthy();
        expect(g.body!.trim().endsWith('Z')).toBe(true);
        const polys = flatten(g.body!);
        expect(polys.length).toBeGreaterThan(0);
        const body = polys[0];
        const eps = 0.5;
        const corners = [
          { x: INSET.x + eps, y: INSET.y + eps },
          { x: box.w - INSET.x - eps, y: INSET.y + eps },
          { x: box.w - INSET.x - eps, y: box.h - INSET.y - eps },
          { x: INSET.x + eps, y: box.h - INSET.y - eps }
        ];
        for (const c of corners) expect(inside(body, c), `${shape} ${box.label} corner ${c.x},${c.y}`).toBe(true);
        const all = [body, ...(g.extras || []).flatMap((e) => flatten(e))].flat();
        for (const p of all) {
          expect(p.x).toBeGreaterThanOrEqual(g.bounds.x - 0.6);
          expect(p.y).toBeGreaterThanOrEqual(g.bounds.y - 0.6);
          expect(p.x).toBeLessThanOrEqual(g.bounds.x + g.bounds.w + 0.6);
          expect(p.y).toBeLessThanOrEqual(g.bounds.y + g.bounds.h + 0.6);
        }
        // Outline contains the text box itself.
        expect(g.bounds.x).toBeLessThanOrEqual(0.01);
        expect(g.bounds.y).toBeLessThanOrEqual(0.01);
        expect(g.bounds.x + g.bounds.w).toBeGreaterThanOrEqual(box.w - 0.01);
        expect(g.bounds.y + g.bounds.h).toBeGreaterThanOrEqual(box.h - 0.01);
        // SHAPE_BLEED (the fallback estimate) covers the real outline of typical (not tall) balloons.
        if (box.h <= box.w) {
          const bleed = SHAPE_BLEED[shape];
          expect(-g.bounds.x).toBeLessThanOrEqual(box.w * bleed.x + 0.5);
          expect(-g.bounds.y).toBeLessThanOrEqual(box.h * bleed.y + 0.5);
          expect(g.bounds.x + g.bounds.w - box.w).toBeLessThanOrEqual(box.w * bleed.x + 0.5);
          expect(g.bounds.y + g.bounds.h - box.h).toBeLessThanOrEqual(box.h * bleed.y + 0.5);
        }
      });

  it('deterministic per seed; seeded shapes vary with the seed', () => {
    for (const shape of BODY_SHAPES) expect(bubbleGeometry(shape, 200, 70, opts())).toEqual(bubbleGeometry(shape, 200, 70, opts()));
    for (const shape of ['cloud', 'burst', 'explosion', 'jagged', 'wavy', 'scroll'] as BubbleShape[]) {
      expect(bubbleGeometry(shape, 200, 70, opts({ seed: 1 })).body).not.toBe(bubbleGeometry(shape, 200, 70, opts({ seed: 2 })).body);
    }
  });

  it('notched cuts the reading-start corner (mirrored for rtl)', () => {
    const ltr = flatten(bubbleGeometry('notched', 200, 60, opts()).body!)[0];
    const rtl = flatten(bubbleGeometry('notched', 200, 60, opts({ rtl: true })).body!)[0];
    expect(inside(ltr, { x: 1, y: 1 })).toBe(false);
    expect(inside(ltr, { x: 199, y: 1 })).toBe(true);
    expect(inside(rtl, { x: 199, y: 1 })).toBe(false);
    expect(inside(rtl, { x: 1, y: 1 })).toBe(true);
  });

  it('double borders draw an inner outline inside the body; borderStyle none drops it', () => {
    for (const shape of BODY_SHAPES) {
      const g = bubbleGeometry(shape, 220, 80, opts({ borderStyle: 'double' }));
      expect(g.inner, shape).toBeTruthy();
      const body = flatten(g.body!)[0];
      const inner = flatten(g.inner!)[0];
      const c = inner.reduce((a, p) => ({ x: a.x + p.x / inner.length, y: a.y + p.y / inner.length }), { x: 0, y: 0 });
      // Sample the inner outline pulled 1u toward its centre (polygon edge tolerance).
      for (const p of inner.filter((_, i) => i % 3 === 0)) {
        const d = Math.hypot(p.x - c.x, p.y - c.y) || 1;
        expect(inside(body, { x: p.x + ((c.x - p.x) / d) * 1.5, y: p.y + ((c.y - p.y) / d) * 1.5 }), shape).toBe(true);
      }
    }
    expect(bubbleGeometry('explosion', 220, 80, opts({ borderStyle: 'solid' })).inner).toBeTruthy();
    expect(bubbleGeometry('explosion', 220, 80, opts({ borderStyle: 'none' })).inner).toBeUndefined();
    expect(bubbleGeometry('scroll', 220, 80, opts({ borderStyle: 'solid' })).inner).toBeTruthy();
  });

  it('extras: scroll rolls and ribbon fishtails; ribbon fill is shaded', () => {
    expect(bubbleGeometry('scroll', 220, 80, opts()).extras).toHaveLength(2);
    const ribbon = bubbleGeometry('ribbon', 220, 80, opts());
    expect(ribbon.extras).toHaveLength(2);
    expect(ribbon.bounds.x).toBeLessThan(0);
    expect(shadeColor('#ffffff', -0.15)).toBe('#d9d9d9');
    expect(shadeColor('#ffffff80', -0.5)).toBe('#80808080');
    expect(shadeColor('none', -0.2)).toBe('none');
  });
});

describe('tails', () => {
  const tip = { x: 260, y: 140 };
  it('curved / straight / pointer / lightning / bubbles / none', () => {
    const base = (tail: Parameters<typeof bubbleGeometry>[3]['tail']) => bubbleGeometry('oval', 200, 60, opts({ tip, tail }));
    expect(base('curved').tail).toMatch(/Q/);
    expect(base('straight').tail).toMatch(/^M[^Q]*Z$/);
    const pointer = flatten(base('pointer').tail!)[0];
    expect(pointer).toHaveLength(3);
    const lightning = flatten(base('lightning').tail!)[0];
    expect(lightning).toHaveLength(7);
    expect(base('bubbles').bubbles.length).toBeGreaterThan(0);
    expect(base('bubbles').tail).toBeUndefined();
    expect(base('none').tail).toBeUndefined();
    expect(bubbleGeometry('oval', 200, 60, opts({ tip: { x: 100, y: 30 }, tail: 'curved' })).tail).toBeUndefined(); // tip inside
  });
  it('tailWidth widens the root', () => {
    const narrow = flatten(bubbleGeometry('squircle', 200, 60, opts({ tip, tail: 'straight', tailWidth: 0.5 })).tail!)[0];
    const wide = flatten(bubbleGeometry('squircle', 200, 60, opts({ tip, tail: 'straight', tailWidth: 2 })).tail!)[0];
    const root = (p: P[]) => Math.hypot(p[0].x - p[2].x, p[0].y - p[2].y);
    expect(root(wide)).toBeGreaterThan(root(narrow) * 3);
  });
  it('auto tails: thought → bubbles, shout → straight, electronic → lightning, else curved', () => {
    expect(resolveTailStyle('auto', 'thought', 'squircle')).toBe('bubbles');
    expect(resolveTailStyle('auto', 'shout', 'oval')).toBe('straight');
    expect(resolveTailStyle('auto', 'speech', 'electronic')).toBe('lightning');
    expect(resolveTailStyle('auto', 'speech', 'oval')).toBe('curved');
    expect(resolveTailStyle('pointer', 'thought', 'cloud')).toBe('pointer');
  });
});

describe('linked balloon neck', () => {
  it('a capsule that connects both centres', () => {
    const a = { cx: 100, cy: 100, w: 160, h: 50 };
    const b = { cx: 300, cy: 180, w: 120, h: 40 };
    const neck = flatten(linkNeck(a, b, 2.8))[0];
    expect(inside(neck, { x: a.cx, y: a.cy })).toBe(true);
    expect(inside(neck, { x: b.cx, y: b.cy })).toBe(true);
    expect(inside(neck, { x: (a.cx + b.cx) / 2, y: (a.cy + b.cy) / 2 })).toBe(true);
    // Rounded ends bulge outward past each centre.
    const len = Math.hypot(b.cx - a.cx, b.cy - a.cy);
    const u = { x: (b.cx - a.cx) / len, y: (b.cy - a.cy) / len };
    expect(inside(neck, { x: b.cx + u.x * 3, y: b.cy + u.y * 3 })).toBe(true);
    expect(inside(neck, { x: a.cx - u.x * 3, y: a.cy - u.y * 3 })).toBe(true);
    expect(inside(neck, { x: (a.cx + b.cx) / 2 - u.y * 30, y: (a.cy + b.cy) / 2 + u.x * 30 })).toBe(false);
    expect(linkNeck(a, a, 2)).toBe('');
  });
});

/** FNV-1a (32-bit) of a string — a compact golden fingerprint. */
const fnv = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};

// Golden values were produced by the PRE-v5 generators (components/comicstudio/board/balloonGeometry.ts at
// commit 24a6070, before the move to shared/). They are frozen here on purpose: balloonGeometry.ts now
// re-exports these very functions, so comparing against it alone would prove nothing.
describe('classic parity (pre-v5 balloonGeometry.ts, strings equal)', () => {
  it('the moved generators are byte-identical to the frozen pre-v5 output', () => {
    expect(speechBodyPath(200, 60, { x: 15, y: 13 }).startsWith('M204 30C204 33.7 203.55 38.2 202.66 41.1C201.77 44 200.44 45.53 198.65 47.39C196')).toBe(true);
    expect(captionPath(200, 60)).toBe('M0 0L200 0L200 60L0 60Z');
    expect(tailPath(200, 60, { x: 80, y: 110 }, 'curved')).toBe('M80.71 47.43Q74.45 77.24 80 110Q90.87 81.34 108.82 54.46Z');
    expect(hashSeed('pg_1_l5')).toBe(306277198);
    const parts: string[] = [];
    for (const [w, h] of [[200, 60], [120, 110], [90, 200], [310, 44]]) {
      for (const inset of [undefined, { x: 15, y: 13 }, { x: 6, y: 4 }]) {
        parts.push(speechBodyPath(w, h, inset));
        for (const seed of [1, 7, hashSeed('pg_1_l3')]) {
          parts.push(cloudPath(w, h, seed, inset));
          parts.push(burstPath(w, h, seed, inset));
        }
      }
      parts.push(captionPath(w, h));
      for (const tip of [{ x: w * 0.4, y: h + 50 }, { x: -40, y: h / 2 }, { x: w + 30, y: -20 }]) {
        parts.push(String(tailPath(w, h, tip, 'curved')));
        parts.push(String(tailPath(w, h, tip, 'straight')));
        parts.push(JSON.stringify(thoughtBubbles(w, h, tip)));
      }
    }
    parts.push(String(hashSeed('pg_1_l5')));
    expect(parts).toHaveLength(125);
    expect(fnv(parts.join('|'))).toBe('5f11047a');
  });

  it('the board re-exports are the shared generators (one implementation)', () => {
    for (const [w, h] of [[200, 60], [90, 200]]) {
      expect(boardSpeechBodyPath(w, h, { x: 15, y: 13 })).toBe(speechBodyPath(w, h, { x: 15, y: 13 }));
      expect(boardCloudPath(w, h, 7)).toBe(cloudPath(w, h, 7));
      expect(boardBurstPath(w, h, 7)).toBe(burstPath(w, h, 7));
      expect(boardCaptionPath(w, h)).toBe(captionPath(w, h));
      expect(boardTailPath(w, h, { x: -40, y: h / 2 })).toBe(tailPath(w, h, { x: -40, y: h / 2 }));
      expect(boardThoughtBubbles(w, h, { x: w + 30, y: -20 })).toEqual(thoughtBubbles(w, h, { x: w + 30, y: -20 }));
    }
    expect(boardHashSeed('pg_1_l5')).toBe(hashSeed('pg_1_l5'));
  });

  it('the classic preset → bubbleGeometry equals the pre-v5 balloonShape for every LineKind', () => {
    const preset = LETTERING_PRESETS.classic;
    const geometryFor = (kind: LineKind, w: number, h: number, tip: P | null, seed: number, inset: P): BubbleGeometry => {
      const style = { ...preset.base, ...(preset.kinds[kind] || {}) };
      return bubbleGeometry(style.shape, w, h, { inset, seed, tip, tail: resolveTailStyle(style.tail, kind, style.shape), tailWidth: style.tailWidth, stroke: 2.8, borderStyle: style.borderStyle });
    };
    const golden: string[] = [];
    for (const kind of LINE_KINDS)
      for (const [w, h] of [[200, 60], [140, 90]]) {
        const seed = hashSeed(`pg_2_${kind}`);
        const inset = { x: 15, y: 13 };
        for (const tip of [{ x: w * 0.45, y: h + 60 }, null]) {
          const ours = geometryFor(kind, w, h, tip, seed, inset);
          golden.push(JSON.stringify([ours.body ?? null, ours.tail ?? null, ours.bubbles]));
          const board = balloonShape(kind, w, h, { tip, seed, inset });
          expect(ours.body, kind).toBe(board.body);
          expect(ours.tail, kind).toBe(board.tail);
          expect(ours.bubbles, kind).toEqual(board.bubbles);
          expect(ours.inner, kind).toBeUndefined();
          expect(ours.extras, kind).toBeUndefined();
        }
      }
    expect(LINE_KINDS).toEqual(['speech', 'thought', 'caption', 'sfx', 'whisper', 'shout']);
    expect(golden).toHaveLength(24);
    expect(fnv(golden.join('|'))).toBe('fabbf490');
    // Whispers keep the classic dashed outline through borderStyle.
    expect({ ...preset.base, ...preset.kinds.whisper }.borderStyle).toBe('dashed');
  });
});
