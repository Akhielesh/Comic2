// Leaf fold geometry (reader.md §3.1 tests): identity at rest, exact landing at progress 1, determinants,
// convex in-page polygons, the no-stretch constraint (2,000 seeded random pointers), mirrored frames, and
// a vertical fold for a mid-edge pull.
import { describe, expect, it } from 'vitest';
import {
  apply,
  compose,
  computeFold,
  constrainPointer,
  det,
  flipX,
  invert,
  leafFrame,
  leafStyles,
  pageRect,
  type Mat,
  type Vec
} from './flipGeometry';

const W = 400;
const H = 600;
const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);
const closeV = (a: Vec, b: Vec, eps = 1e-6) => {
  close(a.x, b.x, eps);
  close(a.y, b.y, eps);
};

/** Seeded LCG (Numerical Recipes constants) — deterministic "random" pointers. */
const lcg = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
};

const isConvex = (poly: Vec[]) => {
  if (poly.length < 3) return true;
  let sign = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = poly[(i + 2) % poly.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-6) continue;
    const s = Math.sign(cross);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
};
const insideRect = (p: Vec) => p.x >= -1e-6 && p.x <= W + 1e-6 && p.y >= -1e-6 && p.y <= H + 1e-6;

describe('matrices', () => {
  it('compose / invert round-trip and flipX is an involution', () => {
    const m: Mat = [0.6, 0.8, -0.8, 0.6, 12, -7];
    const p = { x: 31, y: 77 };
    closeV(apply(compose(invert(m), m), p), p);
    closeV(apply(compose(flipX(W), flipX(W)), p), p);
    close(det(flipX(W)), -1);
  });
});

describe('computeFold', () => {
  it('is flat (null) at rest — the identity', () => {
    expect(computeFold({ W, H, grab: { x: W, y: H }, pointer: { x: W, y: H } })).toBeNull();
    expect(computeFold({ W, H, grab: { x: W, y: 300 }, pointer: { x: W - 0.2, y: 300 } })).toBeNull();
  });

  it('at progress 1 the back matrix lays the back page exactly on [−W,0]×[0,H]', () => {
    const f = computeFold({ W, H, grab: { x: W, y: 300 }, pointer: { x: -W, y: 300 } })!;
    expect(f.progress).toBe(1);
    // Back-page local (u, v) lands at (u − W, v).
    for (const p of [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 123, y: 456 }]) closeV(apply(f.backMatrix, p), { x: p.x - W, y: p.y });
  });

  it('the back face reads correctly (det +1) and the show-through is mirrored (det −1)', () => {
    const rnd = lcg(7);
    for (let i = 0; i < 50; i += 1) {
      const f = computeFold({ W, H, grab: { x: W, y: rnd() * H }, pointer: { x: W - rnd() * 2 * W, y: rnd() * H } });
      if (!f) continue;
      close(det(f.backMatrix), 1, 1e-9);
      close(det(f.showThroughMatrix), -1, 1e-9);
    }
  });

  it('the reflection maps the grab point onto the pointer and fixes the fold line', () => {
    const f = computeFold({ W, H, grab: { x: W, y: H }, pointer: { x: 120, y: 420 } })!;
    closeV(apply(f.reflect, { x: W, y: H }), f.pointer, 1e-6);
    closeV(apply(f.reflect, f.m), f.m);
    closeV(apply(f.reflect, f.foldA), f.foldA);
    closeV(apply(f.reflect, f.foldB), f.foldB);
  });

  it('a mid-edge pull gives a vertical fold', () => {
    const f = computeFold({ W, H, grab: { x: W, y: H / 2 }, pointer: { x: 100, y: H / 2 } })!;
    close(f.n.y, 0);
    close(f.foldA.x, f.foldB.x);
    close(f.foldA.x, (W + 100) / 2);
    expect(f.progress).toBeCloseTo((W - 100) / (2 * W), 9);
  });

  it('shadow intensities peak mid-turn and vanish at the ends', () => {
    const mid = computeFold({ W, H, grab: { x: W, y: 300 }, pointer: { x: 0, y: 300 } })!;
    close(mid.progress, 0.5);
    close(mid.shade.cast, 0.5);
    close(mid.shade.curl, 0.22);
    close(mid.shade.spec, 0.12);
    const end = computeFold({ W, H, grab: { x: W, y: 300 }, pointer: { x: -W, y: 300 } })!;
    expect(end.shade.curl).toBeLessThan(1e-9);
  });

  it('property: 2,000 random pointers keep convex in-page polygons and never stretch the paper', () => {
    const rnd = lcg(20261022);
    let folds = 0;
    for (let i = 0; i < 2000; i += 1) {
      const grabY = rnd() * H;
      const pointer = { x: -1.6 * W + rnd() * 3.2 * W, y: -0.6 * H + rnd() * 2.2 * H };
      const P = constrainPointer(W, H, { x: W, y: grabY }, pointer);
      // No stretching: never farther from a spine point than on the flat page.
      expect(Math.hypot(P.x, P.y - grabY)).toBeLessThanOrEqual(W + 1e-6);
      expect(Math.hypot(P.x, P.y)).toBeLessThanOrEqual(Math.hypot(W, grabY) + 1e-6);
      expect(Math.hypot(P.x, P.y - H)).toBeLessThanOrEqual(Math.hypot(W, H - grabY) + 1e-6);
      const f = computeFold({ W, H, grab: { x: W, y: grabY }, pointer });
      if (!f) continue;
      folds += 1;
      expect(f.progress).toBeGreaterThanOrEqual(0);
      expect(f.progress).toBeLessThanOrEqual(1);
      for (const poly of [f.frontClip, f.flapRegion]) {
        expect(isConvex(poly)).toBe(true);
        expect(poly.every(insideRect)).toBe(true);
        expect(poly.length).toBeLessThanOrEqual(5);
      }
      // The spine stays on the static side (it never folds).
      for (const s of [{ x: 0, y: 0 }, { x: 0, y: H }]) expect((s.x - f.m.x) * f.n.x + (s.y - f.m.y) * f.n.y).toBeGreaterThanOrEqual(-1e-6);
    }
    expect(folds).toBeGreaterThan(1500);
  });
});

describe('frames (RTL / backward turns)', () => {
  it('a mirrored frame round-trips leaf ↔ book and keeps the back face readable', () => {
    const spine = 500;
    const normal = leafFrame(spine, 0, W, H, false);
    const mirrored = leafFrame(spine, 0, W, H, true);
    const p = { x: 123, y: 321 };
    // Leaf x is distance from the spine in both frames.
    expect(apply(normal.S, p).x).toBe(spine + 123);
    expect(apply(mirrored.S, p).x).toBe(spine - 123);
    closeV(apply(invert(mirrored.S), apply(mirrored.S, p)), p);
    const fold = computeFold({ W, H, grab: { x: W, y: 500 }, pointer: { x: 30, y: 380 } })!;
    for (const frame of [normal, mirrored]) {
      const st = leafStyles(frame, fold);
      const back = compose([1, 0, 0, 1, frame.backAt.x, frame.backAt.y], st.backTransform);
      close(det(back), 1, 1e-9);
    }
  });

  it('at progress 1 the back element needs no transform at its final slot (no jump on settle)', () => {
    for (const mirrored of [false, true]) {
      const frame = leafFrame(400, 0, W, H, mirrored);
      const fold = computeFold({ W, H, grab: { x: W, y: 560 }, pointer: { x: -W, y: 560 } })!;
      const m = leafStyles(frame, fold).backTransform;
      [1, 0, 0, 1, 0, 0].forEach((v, i) => close(m[i], v, 1e-9));
    }
  });

  it('front and back clips are px polygons in the elements’ own coordinates', () => {
    const frame = leafFrame(0, 0, W, H, true);
    const fold = computeFold({ W, H, grab: { x: W, y: H }, pointer: { x: 200, y: 500 } })!;
    const st = leafStyles(frame, fold);
    expect(st.frontClip).toMatch(/^polygon\(([-\d.]+px [-\d.]+px,?)+\)$/);
    expect(st.backClip).toMatch(/^polygon\(/);
    // Mirrored frame: the front's static part includes its spine edge, now on the element's right.
    expect(st.frontClip).toContain(`${W}px 0px`);
    expect(pageRect(W, H)).toHaveLength(4);
  });
});
