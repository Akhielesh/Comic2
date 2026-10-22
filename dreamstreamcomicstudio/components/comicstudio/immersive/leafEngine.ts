// The "Leaf" turn engine: one rAF loop that animates a planned turn by writing styles straight to the
// page elements (reader.md §3.3: no React render per frame). It knows four motions:
//   paper   the fold (clip-path + reflection matrix), cast shadow, curl highlight, flap shadow;
//           riffles run several staggered paper leaves
//   board   the cover as a rigid hardcover (rotateY around the spine, preserve-3d)
//   slide   slide-stack (strip comics, low-power devices, the creator's "slide" choice)
//   fade    crossfade (the creator's "fade" choice)
// Every motion runs off one scalar (geometric progress) or, for paper, the pointer itself, so taps,
// drags, flicks and springs all share the same code. Frame times are reported for the low-power check.

import {
  autoPath,
  AUTO_GRAB,
  COVER_SPRING,
  LEAF_SPRING,
  paperEase,
  springDone,
  stepSpring,
  VelocityTracker,
  type Spring
} from './flipPhysics';
import {
  BAND_REACH,
  composeAll,
  computeFold,
  cssMatrix,
  leafFrame,
  leafStyles,
  rotate,
  translate,
  type LeafFrame,
  type Vec
} from './flipGeometry';
import type { TurnKind, TurnPlan } from './turnPlan';

export interface LeafPart {
  root: HTMLElement | null;
  curl?: HTMLElement | null;
  shade?: HTMLElement | null;
}

export interface EngineEls {
  front?: LeafPart;
  back?: LeafPart;
  castBox?: HTMLElement | null;
  cast?: HTMLElement | null;
  shadow?: HTMLElement | null;
  book?: HTMLElement | null;
  incoming: LeafPart[];
  outgoing: LeafPart[];
  /** Riffle leaves in start order (leaf 0 starts first). */
  leaves?: { front: LeafPart; back: LeafPart }[];
}

export interface EngineConfig {
  plan: TurnPlan;
  /** Page box. */
  W: number;
  H: number;
  /** Spine x in book coordinates. */
  spineX: number;
  bookW: number;
  /** Book x of each incoming/outgoing element (slide origin math). */
  slotX?: Map<HTMLElement, number>;
  durationMs: number;
  grabY?: number;
}

export type Outcome = 'commit' | 'cancel';

export interface EngineHooks {
  onDone(outcome: Outcome): void;
  onFrames?(deltas: number[], kind: TurnKind): void;
  /** 0.55 crossed (for chaining) — once per turn. */
  onLate?(): void;
}

type Phase = 'idle' | 'auto' | 'drag' | 'spring' | 'done';

const raf = (fn: FrameRequestCallback): number =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : (setTimeout(() => fn(performance.now()), 16) as unknown as number);
const caf = (id: number) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
/** Smoothstep from a to b. */
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

const STYLE_KEYS = ['transform', 'clipPath', 'opacity', 'willChange', 'transformOrigin', 'backfaceVisibility', 'visibility', 'filter'] as const;

const resetEl = (el?: HTMLElement | null) => {
  if (!el) return;
  for (const k of STYLE_KEYS) (el.style as unknown as Record<string, string>)[k] = '';
  el.style.removeProperty('-webkit-clip-path');
  el.style.removeProperty('-webkit-backface-visibility');
};
const resetPart = (p?: LeafPart) => {
  if (!p) return;
  resetEl(p.root);
  resetEl(p.curl);
  resetEl(p.shade);
};

const setClip = (el: HTMLElement | null | undefined, clip: string) => {
  if (!el) return;
  el.style.clipPath = clip;
  el.style.setProperty('-webkit-clip-path', clip);
};

export class TurnEngine {
  private phase: Phase = 'idle';
  private frame: LeafFrame;
  private grabY: number;
  private t0 = 0;
  private last = 0;
  private rafId: number | null = null;
  private deltas: number[] = [];
  private lateSent = false;
  /** Spring variable: the leaf-0 pointer x (paper) or the equivalent for other kinds (px). */
  private sx: number;
  private sv = 0;
  private sTarget = 0;
  private yRelease = 0;
  private sxRelease = 0;
  private pointer: Vec;
  private dragOffset: Vec = { x: 0, y: 0 };
  private dragStart: Vec = { x: 0, y: 0 };
  private tracker = new VelocityTracker();
  private outcome: Outcome = 'commit';
  private touched = false;

  constructor(private cfg: EngineConfig, private els: EngineEls, private hooks: EngineHooks) {
    const { W, H, plan } = cfg;
    this.frame = leafFrame(cfg.spineX, 0, W, H, plan.mirrored);
    this.grabY = Math.min(0.96 * H, Math.max(0.04 * H, cfg.grabY ?? AUTO_GRAB * H));
    // Start state: flat (forward) or fully turned (reverse).
    this.sx = plan.mode === 'forward' ? W : -W;
    this.pointer = { x: this.sx, y: this.grabY };
  }

  get kind(): TurnKind {
    return this.cfg.plan.kind;
  }

  /** Geometric progress of leaf 0 (0 = flat on its starting side, 1 = landed on the other side). */
  private geometric(): number {
    return clamp01((this.cfg.W - this.sx) / (2 * this.cfg.W));
  }

  /** Progress toward completing the turn (what a release decides on). */
  turnProgress(): number {
    const g = this.geometric();
    return this.cfg.plan.mode === 'forward' ? g : 1 - g;
  }

  // ── Control ────────────────────────────────────────────────────────────────

  /** Tap / key turn along the auto path. */
  startAuto(): void {
    this.phase = 'auto';
    this.t0 = now();
    this.prime();
    // First frame written synchronously (called before paint), so nothing flashes in its end state.
    this.advance(this.t0, 0);
    this.apply();
    this.loop();
  }

  /** Begin following a finger (leaf-space point where it went down). */
  startDrag(finger: Vec, grabY?: number): void {
    if (grabY !== undefined) this.grabY = Math.min(0.96 * this.cfg.H, Math.max(0.04 * this.cfg.H, grabY));
    this.phase = 'drag';
    this.dragStart = finger;
    const start = this.cfg.plan.mode === 'forward' ? { x: this.cfg.W, y: this.grabY } : { x: -this.cfg.W, y: this.grabY };
    this.dragOffset = { x: start.x - finger.x, y: start.y - finger.y };
    this.tracker.reset();
    this.tracker.push(now(), finger.x, finger.y);
    this.prime();
    this.apply();
  }

  /** A peeled corner grabbed by the mouse: keep the leaf where it is and follow the finger from here. */
  continueDrag(finger: Vec): void {
    this.phase = 'drag';
    this.dragStart = finger;
    this.dragOffset = { x: this.pointer.x - finger.x, y: this.pointer.y - finger.y };
    this.tracker.reset();
    this.tracker.push(now(), finger.x, finger.y);
  }

  /** Finger moved (leaf space). */
  dragTo(finger: Vec): void {
    if (this.phase !== 'drag') return;
    this.tracker.push(now(), finger.x, finger.y);
    const { W } = this.cfg;
    if (this.cfg.plan.mode === 'forward' || this.cfg.plan.kind === 'board') {
      this.pointer = { x: finger.x + this.dragOffset.x, y: finger.y + this.dragOffset.y };
    } else {
      // A page coming back: its edge follows the finger's travel.
      this.pointer = { x: -W + 2 * (finger.x - this.dragStart.x), y: this.grabY + (finger.y - this.dragStart.y) };
    }
    if (this.cfg.plan.kind === 'board') {
      // A rigid board's free edge is at W·cos θ: map the finger to the angle directly.
      const c = Math.max(-1, Math.min(1, (finger.x + this.dragOffset.x) / W));
      this.pointer = { x: W - 2 * W * (Math.acos(c) / Math.PI), y: this.grabY };
    }
    this.sx = Math.max(-W, Math.min(W, this.pointer.x));
    this.applyRaf();
  }

  /** Velocity toward completing the turn, px/ms (for decideRelease). */
  releaseVelocity(): number {
    const v = this.tracker.velocity();
    return this.cfg.plan.mode === 'forward' ? -v.x : v.x;
  }

  /** Finger lifted: spring to the outcome, inheriting the flick velocity. */
  release(outcome: Outcome): void {
    const v = this.tracker.velocity().x;
    // A page coming back moves its pointer twice as fast as the finger (its edge follows the finger).
    const k = this.cfg.plan.mode === 'reverse' && this.cfg.plan.kind !== 'board' ? 2 : 1;
    this.springTo(outcome, v * k);
  }

  /** An auto turn reversed mid-way (opposite key): spring back to where it started. */
  springBack(): void {
    this.springTo('cancel', 0);
  }

  /** Mouse peel teaser: hold the corner slightly lifted toward a point (leaf space). */
  peekAt(p: Vec): void {
    this.phase = 'drag';
    this.prime();
    this.pointer = p;
    this.sx = p.x;
    this.applyRaf();
  }

  destroy(): void {
    if (this.rafId !== null) caf(this.rafId);
    this.rafId = null;
    this.phase = 'done';
    this.resetAll();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private springTo(outcome: Outcome, vPointer: number) {
    const { W, plan } = this.cfg;
    this.outcome = outcome;
    const commitX = plan.mode === 'forward' ? -W : W;
    const startX = plan.mode === 'forward' ? W : -W;
    this.sTarget = outcome === 'commit' ? commitX : startX;
    this.sv = Number.isFinite(vPointer) ? Math.max(-6, Math.min(6, vPointer)) : 0;
    this.yRelease = this.pointer.y;
    this.sxRelease = this.sx;
    this.phase = 'spring';
    this.last = now();
    this.prime();
    this.apply();
    this.loop();
  }

  private spring(): Spring {
    return this.cfg.plan.kind === 'board' ? COVER_SPRING : LEAF_SPRING;
  }

  private prime() {
    if (this.touched) return;
    this.touched = true;
    const parts = this.parts();
    for (const p of parts) if (p.root) p.root.style.willChange = this.cfg.plan.kind === 'paper' || this.cfg.plan.kind === 'riffle' ? 'transform, clip-path' : 'transform, opacity';
    if (this.cfg.plan.kind === 'board' && this.els.book) {
      this.els.book.style.perspective = '1800px';
      this.els.book.style.perspectiveOrigin = `${this.cfg.spineX}px 50%`;
    }
  }

  private parts(): LeafPart[] {
    const out: LeafPart[] = [];
    if (this.els.front) out.push(this.els.front);
    if (this.els.back) out.push(this.els.back);
    for (const l of this.els.leaves || []) out.push(l.front, l.back);
    out.push(...this.els.incoming, ...this.els.outgoing);
    return out;
  }

  private resetAll() {
    for (const p of this.parts()) resetPart(p);
    resetEl(this.els.cast);
    resetEl(this.els.castBox);
    resetEl(this.els.shadow);
    if (this.els.book) {
      this.els.book.style.perspective = '';
      this.els.book.style.perspectiveOrigin = '';
    }
  }

  private applyRaf() {
    if (this.rafId !== null) return;
    this.rafId = raf(() => {
      this.rafId = null;
      this.apply();
    });
  }

  private loop() {
    if (this.rafId !== null) caf(this.rafId);
    this.last = now();
    const tick = (t: number) => {
      this.rafId = null;
      const dt = t - this.last;
      if (dt > 0 && dt < 500) this.deltas.push(dt);
      this.last = t;
      const done = this.advance(t, dt);
      this.apply();
      if (!this.lateSent && this.turnProgress() >= 0.55 && this.outcome === 'commit') {
        this.lateSent = true;
        this.hooks.onLate?.();
      }
      if (done) {
        this.phase = 'done';
        this.hooks.onFrames?.(this.deltas, this.cfg.plan.kind);
        this.hooks.onDone(this.outcome);
        return;
      }
      this.rafId = raf(tick);
    };
    this.rafId = raf(tick);
  }

  /** Riffle: total time; single leaf: the configured duration. */
  private totalMs(): number {
    const n = this.cfg.plan.kind === 'riffle' ? Math.max(1, this.els.leaves?.length ?? 1) : 1;
    return this.cfg.plan.kind === 'riffle' ? 180 + (n - 1) * 70 : this.cfg.durationMs;
  }

  private advance(t: number, dt: number): boolean {
    const { W, plan } = this.cfg;
    if (this.phase === 'auto') {
      const u = clamp01((t - this.t0) / Math.max(1, this.totalMs()));
      const e = paperEase(u);
      const g = plan.mode === 'forward' ? e : 1 - e;
      if (plan.kind === 'paper') this.pointer = autoPath(W, this.cfg.H, this.grabY, g);
      else this.pointer = { x: W - 2 * W * g, y: this.grabY };
      this.sx = this.pointer.x;
      this.outcome = 'commit';
      return u >= 1;
    }
    if (this.phase === 'spring') {
      const next = stepSpring(this.sx, this.sv, this.sTarget, this.spring(), Math.min(64, Math.max(0, dt)));
      this.sx = Math.max(-W * 1.02, Math.min(W * 1.02, next.x));
      this.sv = next.v;
      const span = Math.abs(this.sTarget - this.sxRelease) || 1;
      const f = clamp01(1 - Math.abs(this.sTarget - this.sx) / span);
      this.pointer = { x: this.sx, y: this.yRelease + (this.grabY - this.yRelease) * f };
      if (springDone(this.sx, this.sv, this.sTarget)) {
        this.sx = this.sTarget;
        this.pointer = { x: this.sTarget, y: this.grabY };
        return true;
      }
      return false;
    }
    return false;
  }

  /** Write the current state to the DOM. */
  private apply() {
    switch (this.cfg.plan.kind) {
      case 'paper':
        this.applyPaper(this.els.front, this.els.back, this.pointer, true);
        break;
      case 'riffle':
        this.applyRiffle();
        break;
      case 'board':
        this.applyBoard();
        break;
      case 'slide':
        this.applySlide();
        break;
      case 'fade':
        this.applyFade();
        break;
    }
  }

  private applyPaper(front: LeafPart | undefined, back: LeafPart | undefined, pointer: Vec, shadows: boolean) {
    const { W, H } = this.cfg;
    const fold = computeFold({ W, H, grab: { x: W, y: this.grabY }, pointer });
    if (!fold) {
      // Flat on the starting side: the front shows whole, the back is out of sight.
      if (front?.root) setClip(front.root, 'none');
      if (back?.root) back.root.style.visibility = 'hidden';
      if (shadows) {
        if (this.els.cast) this.els.cast.style.opacity = '0';
        if (this.els.shadow) this.els.shadow.style.opacity = '0';
      }
      return;
    }
    const st = leafStyles(this.frame, fold);
    const k = Math.sin(Math.PI * fold.progress);
    if (front?.root) setClip(front.root, fold.progress >= 0.999 ? 'polygon(0 0,0 0,0 0)' : st.frontClip);
    // Single page: the turned leaf lifts away beside the book instead of lying flat on the desk.
    const away = this.cfg.plan.leafSide === 'center' ? 1 - smooth(0.8, 1, fold.progress) : 1;
    if (back?.root) {
      back.root.style.visibility = 'visible';
      back.root.style.transform = cssMatrix(st.backTransform);
      setClip(back.root, st.backClip);
      back.root.style.opacity = away < 1 ? String(away) : '';
    }
    if (back?.curl) {
      back.curl.style.transform = cssMatrix(st.curlBand);
      back.curl.style.opacity = String(Math.min(1, k * 1.1));
    }
    if (!shadows) return;
    if (this.els.cast) {
      this.els.cast.style.transform = cssMatrix(st.castBand);
      this.els.cast.style.opacity = String(Math.min(1, st.shade.cast * 1.6));
    }
    if (this.els.shadow) {
      this.els.shadow.style.transform = cssMatrix(st.backTransform);
      setClip(this.els.shadow, st.shadowClip);
      this.els.shadow.style.opacity = String(Math.min(1, 0.25 + 0.75 * k) * (fold.progress < 0.995 ? away : 0));
    }
  }

  private applyRiffle() {
    const leaves = this.els.leaves || [];
    const { W, H, plan } = this.cfg;
    const t = now();
    let lastActive = -1;
    leaves.forEach((leaf, i) => {
      const local = this.phase === 'auto' ? clamp01((t - this.t0 - i * 70) / 180) : this.phase === 'spring' || this.phase === 'done' ? 1 : 0;
      if (local > 0) lastActive = i;
      const e = paperEase(local);
      const g = plan.mode === 'forward' ? e : 1 - e;
      const p = autoPath(W, H, this.grabY, g);
      this.applyPaper(leaf.front, leaf.back, p, false);
    });
    // One set of shadows follows the newest moving leaf.
    const i = Math.max(0, lastActive);
    const local = this.phase === 'auto' ? clamp01((t - this.t0 - i * 70) / 180) : 1;
    const g = plan.mode === 'forward' ? paperEase(local) : 1 - paperEase(local);
    const fold = computeFold({ W, H, grab: { x: W, y: this.grabY }, pointer: autoPath(W, H, this.grabY, g) });
    if (fold && local < 1) {
      const st = leafStyles(this.frame, fold);
      if (this.els.cast) {
        this.els.cast.style.transform = cssMatrix(st.castBand);
        this.els.cast.style.opacity = String(Math.min(1, st.shade.cast * 1.4));
      }
    } else if (this.els.cast) this.els.cast.style.opacity = '0';
  }

  private applyBoard() {
    const { W, plan } = this.cfg;
    const g = this.geometric();
    const theta = g * 180;
    const m = plan.mirrored;
    const front = this.els.front;
    const back = this.els.back;
    if (front?.root) {
      front.root.style.transformOrigin = m ? '100% 50%' : '0 50%';
      front.root.style.backfaceVisibility = 'hidden';
      front.root.style.setProperty('-webkit-backface-visibility', 'hidden');
      front.root.style.transform = `rotateY(${m ? theta : -theta}deg)`;
    }
    if (front?.shade) front.shade.style.opacity = String(theta < 90 ? 0.32 * (theta / 90) : 0);
    if (back?.root) {
      back.root.style.visibility = theta > 1 ? 'visible' : 'hidden';
      // Single page: the opened cover swings away beside the book rather than lying on the desk.
      if (plan.leafSide === 'center') back.root.style.opacity = String(1 - smooth(150, 180, theta));
      back.root.style.transformOrigin = m ? '0 50%' : '100% 50%';
      back.root.style.backfaceVisibility = 'hidden';
      back.root.style.setProperty('-webkit-backface-visibility', 'hidden');
      back.root.style.transform = `rotateY(${m ? -(180 - theta) : 180 - theta}deg)`;
    }
    if (back?.shade) back.shade.style.opacity = String(theta > 90 ? 0.32 * ((180 - theta) / 90) : 0);
    if (this.els.cast) {
      const s = Math.sin((Math.PI * theta) / 180);
      const spineLocal = m ? W : 0;
      const dir = m ? Math.PI : 0;
      this.els.cast.style.transform = cssMatrix(composeAll(translate(spineLocal, 0), rotate(dir), [0.08 + 0.55 * s, 0, 0, 1, 0, -BAND_REACH / 2]));
      this.els.cast.style.opacity = String(Math.min(1, 0.9 * s));
    }
  }

  private applySlide() {
    const { plan, bookW } = this.cfg;
    const g = this.geometric();
    const sign = plan.mirrored ? -1 : 1;
    const origin = (el: HTMLElement) => `${bookW / 2 - (this.cfg.slotX?.get(el) ?? 0)}px 50%`;
    if (plan.dir > 0) {
      for (const p of this.els.incoming) if (p.root) p.root.style.transform = `translate3d(${sign * (1 - g) * bookW}px,0,0)`;
      for (const p of this.els.outgoing) {
        if (p.root) {
          p.root.style.transformOrigin = origin(p.root);
          p.root.style.transform = `scale(${1 - 0.03 * g})`;
        }
        if (p.shade) p.shade.style.opacity = String(0.15 * g);
      }
    } else {
      // Going back: the current page slides away toward the forward edge, the previous one rises.
      const out = 1 - g;
      for (const p of this.els.outgoing) if (p.root) p.root.style.transform = `translate3d(${sign * out * bookW}px,0,0)`;
      for (const p of this.els.incoming) {
        if (p.root) {
          p.root.style.transformOrigin = origin(p.root);
          p.root.style.transform = `scale(${0.97 + 0.03 * out})`;
        }
        if (p.shade) p.shade.style.opacity = String(0.15 * (1 - out));
      }
    }
  }

  private applyFade() {
    const g = this.geometric();
    const t = this.cfg.plan.dir > 0 ? g : 1 - g;
    for (const p of this.els.incoming) if (p.root) p.root.style.opacity = String(t);
  }
}

/** Duration for an auto turn of a kind (reader.md §14). */
export const durationFor = (kind: TurnKind, spread: boolean, chained: boolean): number => {
  const base = kind === 'board' ? 820 : kind === 'slide' ? 420 : kind === 'fade' ? 300 : spread ? 680 : 560;
  return chained ? Math.round(base * 0.65) : base;
};

// ── Perf stats (QA harness: window.__comicReaderPerf) ─────────────────────────

export interface TurnPerf {
  kind: TurnKind;
  frames: number;
  p90: number;
  fps90: number;
}

const perfLog: TurnPerf[] = [];

/** Record one turn's frame times (kept to the last 20 turns; read by the P1-QA perf spec). */
export const recordTurnPerf = (kind: TurnKind, deltas: number[]): TurnPerf | null => {
  if (deltas.length < 3) return null;
  const sorted = [...deltas].sort((a, b) => a - b);
  const p90v = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  const entry = { kind, frames: deltas.length, p90: Math.round(p90v * 10) / 10, fps90: Math.round((1000 / Math.max(1, p90v)) * 10) / 10 };
  perfLog.push(entry);
  if (perfLog.length > 20) perfLog.shift();
  try {
    if (typeof window !== 'undefined') (window as Window & { __comicReaderPerf?: TurnPerf[] }).__comicReaderPerf = perfLog;
  } catch {
    /* ignore */
  }
  return entry;
};
