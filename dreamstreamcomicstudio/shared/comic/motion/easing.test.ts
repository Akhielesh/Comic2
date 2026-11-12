// PE-MOTION-ENGINE easing (master plan §2.5 "Easing"): every EASE_IDS id has a curve; the Atlas beziers solve exactly;
// the springs overshoot and settle; nothing reads a clock or a DOM.

import { describe, expect, it } from 'vitest';
import { applyEase, cubicBezier, dampedSpring, EASE_BEZIERS, EASINGS, easeOf, isKnownEase } from './easing';
import { EASE_IDS } from './types';

const grid = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n);

describe('easing', () => {
  it('every EASE_IDS id has a curve, and nothing else does', () => {
    expect(Object.keys(EASINGS).sort()).toEqual([...EASE_IDS].sort());
    for (const id of EASE_IDS) expect(isKnownEase(id), id).toBe(true);
    for (const bad of ['bounce', 'constructor', 'toString', '', undefined, 3]) {
      expect(isKnownEase(bad)).toBe(false);
      expect(easeOf(bad)).toBeUndefined();
    }
  });

  it('every curve starts at 0 and ends at 1 exactly; out-of-range and non-finite t clamp', () => {
    for (const id of EASE_IDS) {
      const f = EASINGS[id];
      expect(f(0), id).toBe(0);
      expect(f(1), id).toBe(1);
      expect(f(-3), id).toBe(0);
      expect(f(7), id).toBe(1);
      expect(f(Number.NaN), id).toBe(0);
      for (const t of grid(50)) expect(Number.isFinite(f(t)), `${id} ${t}`).toBe(true);
    }
  });

  it('the Atlas beziers are the tokens the spec names', () => {
    expect(EASE_BEZIERS.ease).toEqual([0.2, 0.8, 0.2, 1]);
    expect(EASE_BEZIERS.enter).toEqual([0.16, 1, 0.3, 1]);
    expect(EASE_BEZIERS.spring).toEqual([0.34, 1.36, 0.64, 1]);
  });

  it('a cubic-bezier is solved for x: the curve passes through its own points', () => {
    const [x1, y1, x2, y2] = EASE_BEZIERS.ease!;
    const f = cubicBezier(x1, y1, x2, y2);
    for (const u of grid(40)) {
      const x = 3 * (1 - u) ** 2 * u * x1 + 3 * (1 - u) * u ** 2 * x2 + u ** 3;
      const y = 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u ** 2 * y2 + u ** 3;
      expect(f(x)).toBeCloseTo(y, 5);
    }
    // The CSS keywords: linear is the identity; in, out and in-out are monotone and symmetric where they should be.
    for (const t of grid(20)) expect(EASINGS.linear(t)).toBe(t);
    expect(EASINGS['in-out'](0.5)).toBeCloseTo(0.5, 6);
    expect(EASINGS.in(0.25)).toBeLessThan(0.25);
    expect(EASINGS.out(0.25)).toBeGreaterThan(0.25);
  });

  it('ease, enter, in, out and in-out never overshoot and never go back; spring and damped overshoot then settle', () => {
    for (const id of ['ease', 'enter', 'linear', 'in', 'out', 'in-out'] as const) {
      let prev = 0;
      for (const t of grid(200)) {
        const v = EASINGS[id](t);
        expect(v, `${id} ${t}`).toBeGreaterThanOrEqual(prev - 1e-9);
        expect(v).toBeLessThanOrEqual(1 + 1e-9);
        prev = v;
      }
    }
    const peak = (id: 'spring' | 'damped') => Math.max(...grid(400).map((t) => EASINGS[id](t)));
    expect(peak('spring')).toBeGreaterThan(1.02);
    expect(peak('damped')).toBeGreaterThan(1.05);
    expect(EASINGS.damped(0.97)).toBeCloseTo(1, 1);
  });

  it('the damped spring is closed form: the same numbers on every call, any ratio still ends at 1', () => {
    const a = dampedSpring(0.5, 14);
    const b = dampedSpring(0.5, 14);
    for (const t of grid(30)) expect(a(t)).toBe(b(t));
    for (const z of [0.1, 0.5, 0.9, 5, -1]) {
      const f = dampedSpring(z, 10);
      expect(f(0)).toBe(0);
      expect(f(1)).toBe(1);
    }
    expect(applyEase('nope', 0.3)).toBe(0.3);
    expect(applyEase('in-out', 0.5)).toBeCloseTo(0.5, 6);
  });
});
