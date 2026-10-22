// Leaf physics (reader.md §3.2 tests): the spring converges within 600 ms without visible overshoot,
// the release truth table, least-squares velocity, the auto path's endpoints and the paper ease.
import { describe, expect, it } from 'vitest';
import { autoPath, cubicBezier, decideRelease, LEAF_SPRING, COVER_SPRING, p90, paperEase, springDone, stepSpring, VelocityTracker } from './flipPhysics';

describe('stepSpring', () => {
  it('LEAF_SPRING settles within 600 ms of simulated time with < 2% overshoot', () => {
    let x = 400;
    let v = 0;
    let minX = x;
    let t = 0;
    while (t < 600) {
      ({ x, v } = stepSpring(x, v, -400, LEAF_SPRING, 16.7));
      minX = Math.min(minX, x);
      t += 16.7;
    }
    expect(springDone(x, v, -400)).toBe(true);
    // Target −400 from +400: overshoot is how far below −400 it went, relative to the 800 px travel.
    expect((-400 - minX) / 800).toBeLessThan(0.02);
  });

  it('is frame-rate independent (one 50 ms step ≈ three 16.7 ms steps)', () => {
    const a = stepSpring(100, 0, 0, LEAF_SPRING, 50);
    let b = { x: 100, v: 0 };
    for (let i = 0; i < 3; i += 1) b = stepSpring(b.x, b.v, 0, LEAF_SPRING, 50 / 3);
    expect(Math.abs(a.x - b.x)).toBeLessThan(0.5);
  });

  it('the cover board is heavier (slower) than a paper leaf', () => {
    const leaf = stepSpring(100, 0, 0, LEAF_SPRING, 100);
    const board = stepSpring(100, 0, 0, COVER_SPRING, 100);
    expect(board.x).toBeGreaterThan(leaf.x);
  });

  it('inherits a flick velocity', () => {
    const still = stepSpring(0, 0, 100, LEAF_SPRING, 16);
    const flicked = stepSpring(0, 1.5, 100, LEAF_SPRING, 16);
    expect(flicked.x).toBeGreaterThan(still.x + 10);
  });
});

describe('decideRelease', () => {
  it('flick beats position; otherwise past halfway commits', () => {
    expect(decideRelease(0.15, 0.5)).toBe('commit');
    expect(decideRelease(0.04, 0.5)).toBe('cancel'); // too early to count as a flick
    expect(decideRelease(0.9, -0.5)).toBe('cancel');
    expect(decideRelease(0.45, 0)).toBe('cancel');
    expect(decideRelease(0.55, 0)).toBe('commit');
    expect(decideRelease(0.55, 0.2)).toBe('commit');
    expect(decideRelease(0.45, -0.2)).toBe('cancel');
  });
});

describe('VelocityTracker', () => {
  it('least-squares slope over the last 80 ms', () => {
    const vt = new VelocityTracker();
    for (let t = 0; t <= 200; t += 10) vt.push(t, 2 * t + (t % 20 ? 1 : -1), 5);
    const v = vt.velocity();
    expect(v.x).toBeCloseTo(2, 1);
    expect(v.y).toBeCloseTo(0, 6);
  });

  it('needs two samples', () => {
    const vt = new VelocityTracker();
    expect(vt.velocity()).toEqual({ x: 0, y: 0 });
    vt.push(0, 10, 10);
    expect(vt.velocity()).toEqual({ x: 0, y: 0 });
  });
});

describe('autoPath and easing', () => {
  it('starts at the grab, ends flat on the other side, and arcs toward the middle', () => {
    expect(autoPath(400, 600, 560, 0)).toEqual({ x: 400, y: 560 });
    expect(autoPath(400, 600, 560, 1)).toEqual({ x: -400, y: 560 });
    expect(autoPath(400, 600, 560, 0.5).y).toBeLessThan(560);
    expect(autoPath(400, 600, 40, 0.5).y).toBeGreaterThan(40);
  });

  it('PAPER_EASE is monotonic from 0 to 1; a linear bezier is identity', () => {
    let prev = 0;
    for (let i = 0; i <= 50; i += 1) {
      const v = paperEase(i / 50);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
    expect(paperEase(0)).toBe(0);
    expect(paperEase(1)).toBe(1);
    const lin = cubicBezier(0.25, 0.25, 0.75, 0.75);
    expect(lin(0.3)).toBeCloseTo(0.3, 4);
  });

  it('p90 of frame deltas', () => {
    expect(p90([])).toBe(0);
    expect(p90([16, 16, 16, 16, 16, 16, 16, 16, 16, 40])).toBe(40);
    expect(p90(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(19);
  });
});
