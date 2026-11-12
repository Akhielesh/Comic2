// PE-LETTER: the six Pro bubble shapes (master plan §2.3: radio, monster, telepathic, icicle, heart, sticky), procedural,
// M L C Q A Z only, deterministic, each enclosing the text block like the classic ones; their bleed estimate
// (PRO_SHAPE_BLEED, read by place.ts outlineBounds under grant C-21). Before PE-LETTER bubbleGeometry drew every Pro id as
// the default squircle and outlineBounds fell back to the kind's bleed.

import { describe, expect, it } from 'vitest';
import { outlineBounds, SHAPE_BLEED } from './place';
import { bubbleGeometry, hashSeed, PRO_SHAPE_BLEED, resolveTailStyle, speechBodyPath } from './shapes';
import { PRO_BUBBLE_SHAPES, type ProBubbleShape } from './style';

type P = { x: number; y: number };
const TOKENS = /[MLCQAZ]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;

/** Flatten an absolute M L C Q A Z path into polygons (A: sampled on its ellipse; only used by none of these). */
function flatten(d: string): P[][] {
  const t = d.match(TOKENS) ?? [];
  expect(d.replace(TOKENS, '').replace(/[\s,]/g, '')).toBe('');
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
    if (c === 'M' || c === 'L') {
      if (c === 'M' && cur.length) polys.push(cur);
      pos = { x: n(), y: n() };
      if (c === 'M') cur = [pos];
      else cur.push(pos);
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
      for (let k = 0; k < 5; k += 1) n();
      pos = { x: n(), y: n() };
      cur.push(pos);
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

describe('Pro bubble shapes: each × 3 boxes', () => {
  for (const shape of PRO_BUBBLE_SHAPES)
    for (const box of BOXES)
      it(`${shape} (${box.label}): closed, M L C Q A Z only, text block inside, bounds contain the outline, its own drawing`, () => {
        const g = bubbleGeometry(shape, box.w, box.h, opts({ borderStyle: 'solid' }));
        expect(g.body).toBeTruthy();
        expect(g.body!.trim().endsWith('Z')).toBe(true);
        // Not the squircle every unknown shape used to fall back to.
        expect(g.body).not.toBe(speechBodyPath(box.w, box.h, INSET));
        const body = flatten(g.body!)[0];
        const eps = 0.5;
        // The text block's edge (corners and edge points) is inside the outline.
        for (let k = 0; k <= 4; k += 1) {
          const f = k / 4;
          for (const c of [
            { x: INSET.x + eps + (box.w - 2 * INSET.x - 2 * eps) * f, y: INSET.y + eps },
            { x: INSET.x + eps + (box.w - 2 * INSET.x - 2 * eps) * f, y: box.h - INSET.y - eps },
            { x: INSET.x + eps, y: INSET.y + eps + (box.h - 2 * INSET.y - 2 * eps) * f },
            { x: box.w - INSET.x - eps, y: INSET.y + eps + (box.h - 2 * INSET.y - 2 * eps) * f }
          ])
            expect(inside(body, c), `${shape} ${box.label} ${c.x},${c.y}`).toBe(true);
        }
        const all = [body, ...(g.extras || []).flatMap(flatten), ...(shape === 'telepathic' && g.inner ? flatten(g.inner) : [])].flat();
        for (const p of all) {
          expect(p.x).toBeGreaterThanOrEqual(g.bounds.x - 0.6);
          expect(p.y).toBeGreaterThanOrEqual(g.bounds.y - 0.6);
          expect(p.x).toBeLessThanOrEqual(g.bounds.x + g.bounds.w + 0.6);
          expect(p.y).toBeLessThanOrEqual(g.bounds.y + g.bounds.h + 0.6);
        }
        expect(g.bounds.x).toBeLessThanOrEqual(0.01);
        expect(g.bounds.y).toBeLessThanOrEqual(0.01);
        expect(g.bounds.x + g.bounds.w).toBeGreaterThanOrEqual(box.w - 0.01);
        expect(g.bounds.y + g.bounds.h).toBeGreaterThanOrEqual(box.h - 0.01);
        // PRO_SHAPE_BLEED (the fallback estimate) covers the real outline of typical (not tall) balloons.
        if (box.h <= box.w) {
          const bleed = PRO_SHAPE_BLEED[shape];
          expect(-g.bounds.x, 'left').toBeLessThanOrEqual(box.w * bleed.x + 0.5);
          expect(-g.bounds.y, 'top').toBeLessThanOrEqual(box.h * bleed.y + 0.5);
          expect(g.bounds.x + g.bounds.w - box.w, 'right').toBeLessThanOrEqual(box.w * bleed.x + 0.5);
          expect(g.bounds.y + g.bounds.h - box.h, 'bottom').toBeLessThanOrEqual(box.h * bleed.y + 0.5);
        }
      });

  it('deterministic per seed; the seeded ones vary with the seed', () => {
    for (const shape of PRO_BUBBLE_SHAPES) expect(bubbleGeometry(shape, 200, 70, opts())).toEqual(bubbleGeometry(shape, 200, 70, opts()));
    for (const shape of ['monster', 'telepathic', 'icicle'] as ProBubbleShape[]) expect(bubbleGeometry(shape, 200, 70, opts({ seed: 1 })).body).not.toBe(bubbleGeometry(shape, 200, 70, opts({ seed: 2 })).body);
  });

  it('monster drips below its body; icicles hang below the box; telepathic has an outer ripple; sticky a folded corner', () => {
    const monster = bubbleGeometry('monster', 240, 80, opts());
    expect(monster.bounds.y + monster.bounds.h).toBeGreaterThan(80 * 1.15);
    const icicle = bubbleGeometry('icicle', 240, 80, opts());
    expect(icicle.bounds.y + icicle.bounds.h).toBeGreaterThan(80 + 3);
    expect(icicle.bounds.y).toBeGreaterThanOrEqual(-0.01); // a flat top
    const tele = bubbleGeometry('telepathic', 240, 80, opts());
    expect(tele.inner).toBeTruthy();
    expect(bubbleGeometry('telepathic', 240, 80, opts({ borderStyle: 'none' })).inner).toBeUndefined();
    const sticky = bubbleGeometry('sticky', 240, 80, opts());
    const poly = flatten(sticky.body!)[0];
    expect(inside(poly, { x: 239, y: 79 })).toBe(false); // the folded corner is cut
    expect(inside(poly, { x: 1, y: 79 })).toBe(true);
    expect(sticky.inner).toMatch(/^M240 /); // the crease starts on the right edge
    const rtl = flatten(bubbleGeometry('sticky', 240, 80, opts({ rtl: true })).body!)[0];
    expect(inside(rtl, { x: 1, y: 79 })).toBe(false);
  });

  it('a radio balloon takes a lightning tail by default; tails attach to every Pro body', () => {
    expect(resolveTailStyle('auto', 'speech', 'radio')).toBe('lightning');
    for (const shape of PRO_BUBBLE_SHAPES) {
      const g = bubbleGeometry(shape, 200, 70, opts({ tail: 'curved', tip: { x: 60, y: 200 } }));
      expect(g.tail, shape).toBeTruthy();
    }
  });

  it('place.ts outlineBounds reads the Pro bleed (grant C-21), not the kind fallback', () => {
    const b = { x: 0.2, y: 0.2, w: 0.3, h: 0.1 };
    expect(SHAPE_BLEED.squircle).toBeTruthy();
    const heart = outlineBounds(b, 'speech', 'heart' as never);
    expect(heart.x).toBeCloseTo(0.2 - 0.3 * PRO_SHAPE_BLEED.heart.x, 6);
    expect(heart.h).toBeCloseTo(0.1 + 2 * 0.1 * PRO_SHAPE_BLEED.heart.y, 6);
    const sticky = outlineBounds(b, 'speech', 'sticky' as never);
    expect(sticky).toEqual(b);
  });
});
