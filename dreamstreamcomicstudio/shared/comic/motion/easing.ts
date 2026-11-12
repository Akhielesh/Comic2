// Pro Edit motion: easing (master plan §2.5 "Easing"; PE-MOTION-ENGINE). Every EASE_IDS curve as a pure function of
// progress t (0..1 in, 0..1 out; a spring may overshoot on the way). Deterministic, no DOM, no clock: the editor
// preview, the MP4 export and the server read the same numbers.
//
// The Atlas curves are the app's own motion tokens (Atlas globals.css): ease (.2,.8,.2,1), enter (.16,1,.3,1) and
// spring (.34,1.36,.64,1). in, out and in-out are the CSS keywords; damped is a closed-form damped spring.

import { EASE_IDS, type EaseId } from './types.js';

/** Progress in, progress out: f(0) = 0 and f(1) = 1 exactly; a non-finite or negative t reads as 0, t ≥ 1 as 1. */
export type EaseFn = (t: number) => number;

const clampT = (t: number): number => (t > 0 ? (t < 1 ? t : 1) : 0);

/**
 * A CSS cubic-bezier(x1, y1, x2, y2) as a function of t: solves x(u) = t for u (Newton, falling back to bisection) and
 * returns y(u). x1 and x2 must lie in 0..1 (as in CSS), so x(u) is monotone and the solve has one root.
 */
export const cubicBezier = (x1: number, y1: number, x2: number, y2: number): EaseFn => {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const xAt = (u: number) => ((ax * u + bx) * u + cx) * u;
  const yAt = (u: number) => ((ay * u + by) * u + cy) * u;
  const slope = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  const solve = (t: number): number => {
    let u = t;
    for (let i = 0; i < 8; i += 1) {
      const err = xAt(u) - t;
      if (Math.abs(err) < 1e-7) return u;
      const d = slope(u);
      if (Math.abs(d) < 1e-6) break;
      u -= err / d;
      if (u < 0 || u > 1) break;
    }
    let lo = 0;
    let hi = 1;
    u = t;
    for (let i = 0; i < 48; i += 1) {
      const x = xAt(u);
      if (Math.abs(x - t) < 1e-7) return u;
      if (x < t) lo = u;
      else hi = u;
      u = (lo + hi) / 2;
    }
    return u;
  };
  return (t: number) => {
    if (!(t > 0)) return 0;
    if (t >= 1) return 1;
    return yAt(solve(t));
  };
};

/**
 * A closed-form damped spring settling from 0 to 1 over t = 0..1: 1 − e^(−ζωt)(cos ω_d t + ζω/ω_d · sin ω_d t), with a
 * linear correction so f(1) is exactly 1. ζ is the damping ratio (0 < ζ < 1 overshoots), ω the natural frequency in
 * radians per unit t.
 */
export const dampedSpring = (zeta: number, omega: number): EaseFn => {
  const z = Math.min(0.99, Math.max(0.05, zeta));
  const w = Math.max(1, omega);
  const wd = w * Math.sqrt(1 - z * z);
  const raw = (t: number) => 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
  const end = raw(1);
  return (t: number) => {
    if (!(t > 0)) return 0;
    if (t >= 1) return 1;
    return raw(t) + t * (1 - end);
  };
};

/** The bezier control points of the curves that have them (for CSS: the editor chrome can quote the same curve). */
export const EASE_BEZIERS: Readonly<Partial<Record<EaseId, readonly [number, number, number, number]>>> = {
  ease: [0.2, 0.8, 0.2, 1],
  enter: [0.16, 1, 0.3, 1],
  spring: [0.34, 1.36, 0.64, 1],
  in: [0.42, 0, 1, 1],
  out: [0, 0, 0.58, 1],
  'in-out': [0.42, 0, 0.58, 1]
};

/** The damped spring's ratio and frequency (about 16 % overshoot, settled by t = 1). */
export const DAMPED_SPRING = { zeta: 0.5, omega: 14 } as const;

const bez = (id: EaseId): EaseFn => {
  const p = EASE_BEZIERS[id]!;
  return cubicBezier(p[0], p[1], p[2], p[3]);
};

/** Every ease id this build plays (EASE_IDS, exhaustive). */
export const EASINGS: Readonly<Record<EaseId, EaseFn>> = {
  ease: bez('ease'),
  enter: bez('enter'),
  spring: bez('spring'),
  linear: clampT,
  in: bez('in'),
  out: bez('out'),
  'in-out': bez('in-out'),
  damped: dampedSpring(DAMPED_SPRING.zeta, DAMPED_SPRING.omega)
};

/** True for an ease id this build plays. A stored id it does not know makes its clip inert (types.ts). */
export const isKnownEase = (id: unknown): id is EaseId => typeof id === 'string' && (EASE_IDS as readonly string[]).includes(id);

/** The curve for an ease id, or undefined for one this build does not know (own keys only: never 'constructor'). */
export const easeOf = (id: unknown): EaseFn | undefined => (isKnownEase(id) ? EASINGS[id] : undefined);

/** Progress through `id` at t (linear for an unknown id). */
export const applyEase = (id: unknown, t: number): number => (easeOf(id) ?? clampT)(t);
