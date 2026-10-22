// Pure pinch / pan / zoom math for TouchCanvas (mobile.md §5.1). No DOM; unit-tested.
//
// The canvas transform is `translate(x, y) scale(scale)` with origin 0 0, in stage CSS px. A content
// point c is drawn at  screen = t + c·s,  so keeping a content point under a screen point p while the
// scale changes from s to s′ means  t′ = p − (p − t)·(s′/s).

export interface Pt {
  x: number;
  y: number;
}
export interface ZoomXY {
  scale: number;
  x: number;
  y: number;
}
export interface Size {
  w: number;
  h: number;
}
export interface ZoomLimits {
  min: number;
  max: number;
}

export const IDENTITY: ZoomXY = { scale: 1, x: 0, y: 0 };
/** Resistance past the limits while a gesture is live (springs back on release). */
export const RUBBER = 0.35;

export const dist = (a: Pt, b: Pt): number => Math.hypot(b.x - a.x, b.y - a.y);
export const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

const finite = (n: number, fallback: number) => (Number.isFinite(n) ? n : fallback);

/** Soft-limit a scale: past the bounds it moves at `k` speed (k = 0 → hard clamp). */
export const softScale = (s: number, limits: ZoomLimits, k = 0): number => {
  if (s > limits.max) return limits.max + (s - limits.max) * k;
  if (s < limits.min) return limits.min - (limits.min - s) * k;
  return s;
};

/** Content fitted and centred at scale 1 (content smaller than the stage is centred). */
export const fitState = (stage: Size, content: Size = stage): ZoomXY => ({
  scale: 1,
  x: Math.round(Math.max(0, (stage.w - content.w) / 2)),
  y: Math.round(Math.max(0, (stage.h - content.h) / 2))
});

/** Zoom by `factor` keeping `point` (stage coords) fixed. */
export const zoomAt = (state: ZoomXY, point: Pt, factor: number, limits: ZoomLimits): ZoomXY => {
  const s0 = state.scale > 0 ? state.scale : 1;
  const s1 = softScale(s0 * finite(factor, 1), limits, 0);
  const k = s1 / s0;
  return { scale: s1, x: point.x - (point.x - state.x) * k, y: point.y - (point.y - state.y) * k };
};

export const panBy = (state: ZoomXY, dx: number, dy: number): ZoomXY => ({ scale: state.scale, x: state.x + finite(dx, 0), y: state.y + finite(dy, 0) });

/**
 * Two-finger pinch + pan: the content point that was under the starting midpoint stays under the
 * current midpoint (anchor invariance), and the scale follows the finger distance ratio.
 */
export const pinch = (start: { a: Pt; b: Pt; state: ZoomXY }, now: { a: Pt; b: Pt }, limits: ZoomLimits, rubberK = 0): ZoomXY => {
  const d0 = dist(start.a, start.b);
  const d1 = dist(now.a, now.b);
  const s0 = start.state.scale > 0 ? start.state.scale : 1;
  const s1 = softScale(d0 > 0 ? s0 * (d1 / d0) : s0, limits, rubberK);
  const m0 = mid(start.a, start.b);
  const m1 = mid(now.a, now.b);
  const cx = (m0.x - start.state.x) / s0;
  const cy = (m0.y - start.state.y) / s0;
  return { scale: s1, x: m1.x - cx * s1, y: m1.y - cy * s1 };
};

const clampAxis = (t: number, stageLen: number, contentLen: number, scale: number, offset: number, rubberK: number): number => {
  const scaled = contentLen * scale;
  if (scaled <= stageLen) {
    // Smaller than the stage: centred.
    return (stageLen - scaled) / 2 - offset * scale;
  }
  const max = -offset * scale; // content's left edge at the stage's left edge
  const min = stageLen - (offset + contentLen) * scale; // right edge at the stage's right edge
  if (t > max) return rubberK ? max + (t - max) * rubberK : max;
  if (t < min) return rubberK ? min - (min - t) * rubberK : min;
  return t;
};

/**
 * Keep the page covering the stage when zoomed (no gaps at the edges), centred when smaller.
 * `content` is the content box at scale 1 and `origin` its offset inside the stage (default 0,0 —
 * content fills the stage). `rubberK` > 0 lets it stretch past the bounds while a finger is down.
 */
export const clampState = (state: ZoomXY, stage: Size, content: Size = stage, rubberK = 0, origin: Pt = { x: 0, y: 0 }): ZoomXY => ({
  scale: state.scale,
  x: clampAxis(state.x, stage.w, content.w, state.scale, origin.x, rubberK),
  y: clampAxis(state.y, stage.h, content.h, state.scale, origin.y, rubberK)
});

export interface Tap {
  t: number;
  x: number;
  y: number;
}

/** Two taps within `ms` and `px` of each other. */
export const isDoubleTap = (prev: Tap | null | undefined, cur: Tap, ms = 300, px = 24): boolean =>
  !!prev && cur.t - prev.t >= 0 && cur.t - prev.t <= ms && Math.hypot(cur.x - prev.x, cur.y - prev.y) <= px;

/** How far past the clamped bounds a state is (for edge-overscroll page turns). */
export const overscrollX = (state: ZoomXY, stage: Size, content: Size = stage): number => state.x - clampState(state, stage, content).x;

export const sameZoom = (a: ZoomXY, b: ZoomXY, eps = 0.001): boolean =>
  Math.abs(a.scale - b.scale) < eps && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
