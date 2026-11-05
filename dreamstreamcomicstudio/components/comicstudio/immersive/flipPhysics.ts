// "Leaf" page-turn physics (reader.md §3.2). Pure, no DOM, no timers: the stage's rAF loop calls these.

import type { Vec } from './flipGeometry';

export interface Spring {
  stiffness: number;
  damping: number;
  mass: number;
}

/** Paper leaf: ζ ≈ 0.88, settles in ≈ 420 ms without visible overshoot. */
export const LEAF_SPRING: Spring = { stiffness: 220, damping: 26, mass: 1 };
/** Hardcover board: heavier, slower. */
export const COVER_SPRING: Spring = { stiffness: 140, damping: 22, mass: 1.4 };

/** Auto-turn durations (ms). */
export const TURN_MS = { single: 560, spread: 680, board: 820, slide: 420, fade: 180, riffleLeaf: 180, riffleStagger: 70 } as const;
/** A queued turn chained onto a running one plays faster. */
export const CHAIN_FACTOR = 0.65;
/** Riffles show at most this many leaves. */
export const MAX_RIFFLE = 4;

const MAX_DT = 1000 / 60;

/**
 * One spring step (semi-implicit Euler), split into ≤ 16.7 ms substeps so a dropped frame never
 * explodes the integration. Units: x in px (or any unit), v in units per ms.
 */
export const stepSpring = (x: number, v: number, target: number, s: Spring, dtMs: number): { x: number; v: number } => {
  let pos = x;
  let vel = v;
  let remaining = Math.max(0, dtMs);
  while (remaining > 1e-9) {
    const dt = Math.min(MAX_DT, remaining);
    remaining -= dt;
    // Work in seconds for the physical constants, velocity stored per ms.
    const dts = dt / 1000;
    const velS = vel * 1000;
    const force = -s.stiffness * (pos - target) - s.damping * velS;
    const nextVelS = velS + (force / s.mass) * dts;
    pos += nextVelS * dts;
    vel = nextVelS / 1000;
  }
  return { x: pos, v: vel };
};

/** The spring has landed (within half a pixel, nearly still). */
export const springDone = (x: number, v: number, target: number, eps = 0.5, vEps = 0.02): boolean =>
  Math.abs(x - target) < eps && Math.abs(v) < vEps;

/** Pointer velocity from the last 80 ms of samples (least-squares slope), px/ms. */
export class VelocityTracker {
  private samples: { t: number; x: number; y: number }[] = [];
  constructor(private windowMs = 80) {}
  push(t: number, x: number, y: number): void {
    this.samples.push({ t, x, y });
    const cutoff = t - this.windowMs * 2;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift();
  }
  reset(): void {
    this.samples = [];
  }
  velocity(): Vec {
    const last = this.samples[this.samples.length - 1];
    if (!last) return { x: 0, y: 0 };
    const recent = this.samples.filter((s) => s.t >= last.t - this.windowMs);
    if (recent.length < 2) return { x: 0, y: 0 };
    const n = recent.length;
    const mt = recent.reduce((a, s) => a + s.t, 0) / n;
    const mx = recent.reduce((a, s) => a + s.x, 0) / n;
    const my = recent.reduce((a, s) => a + s.y, 0) / n;
    let stt = 0;
    let stx = 0;
    let sty = 0;
    for (const s of recent) {
      const dt = s.t - mt;
      stt += dt * dt;
      stx += dt * (s.x - mx);
      sty += dt * (s.y - my);
    }
    if (stt < 1e-9) return { x: 0, y: 0 };
    return { x: stx / stt, y: sty / stt };
  }
}

export type Release = 'commit' | 'cancel';

/** Flick wins over position; otherwise past halfway commits. `vx` > 0 means toward completion (px/ms). */
export const decideRelease = (progress: number, vx: number): Release =>
  vx > 0.35 && progress > 0.06 ? 'commit' : vx < -0.35 ? 'cancel' : progress > 0.5 ? 'commit' : 'cancel';

/** Cubic-bezier timing function (CSS semantics) solved by Newton + bisection. */
export const cubicBezier = (p1x: number, p1y: number, p2x: number, p2y: number) => {
  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dsx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solve = (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const err = sx(t) - x;
      if (Math.abs(err) < 1e-6) return t;
      const d = dsx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 30; i += 1) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : sy(solve(x)));
};

/** Slow lift, quick middle, soft landing. */
export const PAPER_EASE = [0.38, 0.02, 0.18, 1] as const;
export const paperEase = cubicBezier(...PAPER_EASE);
/** House ease for UI motion (kit/motion.ts easeOut). */
export const HOUSE_EASE = [0.2, 0.7, 0.2, 1] as const;
export const houseEase = cubicBezier(...HOUSE_EASE);
/** In-out cubic for zoom-changing camera moves. */
export const CAMERA_EASE = [0.65, 0, 0.35, 1] as const;
export const cameraEase = cubicBezier(...CAMERA_EASE);

/**
 * Auto-turn path (tap / key): a quadratic Bézier from the grab C = (W, grabY) through
 * Q = (0, grabY − 0.38·H·sign) to L = (−W, grabY), so the corner lifts in an arc and lands flat.
 * `sign` lifts toward the page's middle: a bottom grab arcs up, a top grab arcs down.
 */
export const autoPath = (W: number, H: number, grabY: number, t: number): Vec => {
  const u = Math.min(1, Math.max(0, t));
  const sign = grabY > H / 2 ? 1 : -1;
  const C = { x: W, y: grabY };
  const Q = { x: 0, y: grabY - 0.38 * H * sign };
  const L = { x: -W, y: grabY };
  const a = (1 - u) * (1 - u);
  const b = 2 * (1 - u) * u;
  const c = u * u;
  return { x: a * C.x + b * Q.x + c * L.x, y: a * C.y + b * Q.y + c * L.y };
};

/** Default grab height for auto turns: near the bottom corner, like a thumb turning a page. */
export const AUTO_GRAB = 0.94;

/** Frame-time statistics for the low-power decision (p90 of frame deltas, ms). */
export const p90 = (deltas: number[]): number => {
  if (!deltas.length) return 0;
  const sorted = [...deltas].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
};
