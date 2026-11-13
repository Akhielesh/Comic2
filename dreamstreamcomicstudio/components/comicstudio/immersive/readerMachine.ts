// Immersive reader state machine (reader.md §12). A pure reducer: the stage animates, the reducer decides.
//
// Views are BookView indexes (the End card is the last view). Turns go idle → turn → (TURN_DONE) idle;
// drags go idle → drag → settle(commit|cancel) → idle; the view changes only when a turn commits.
// Reduced motion changes the view at once (the stage crossfades). A turn always starts from the whole
// page: any zoom resets when it begins.

import type { ReaderLayout } from './readerLayout';
import type { Vec } from './flipGeometry';
import { MAX_RIFFLE } from './flipPhysics';

export type Phase = 'intro' | 'reading' | 'end';

export type Motion =
  | { kind: 'idle' }
  | { kind: 'drag'; dir: 1 | -1; to: number; grab: Vec }
  | { kind: 'turn'; dir: 1 | -1; from: number; to: number; source: 'auto' | 'release'; riffle?: number; chained?: boolean }
  | { kind: 'settle'; dir: 1 | -1; from: number; to: number; outcome: 'commit' | 'cancel' };

export interface ReaderState {
  phase: Phase;
  layout: ReaderLayout;
  view: number;
  zoom: { s: number; x: number; y: number } | null;
  motion: Motion;
  /** One buffered step (riffle chaining). */
  queued: 1 | -1 | null;
  hud: boolean;
  reduced: boolean;
  lowPower: boolean;
  /** Bumped when a step hits the first/last view (the stage plays a 6 px nudge). */
  bump: { dir: 1 | -1; n: number } | null;
  /** Bumped on every reduced-motion view change (the stage plays a crossfade keyed on it). */
  fade: number;
}

export type ReaderEvent =
  | { type: 'OPEN'; intro: boolean }
  | { type: 'INTRO_DONE' }
  | { type: 'STEP'; delta: 1 | -1 }
  | { type: 'GOTO'; view: number }
  | { type: 'DRAG_START'; dir: 1 | -1; grab: Vec }
  | { type: 'DRAG_END'; outcome: 'commit' | 'cancel' }
  | { type: 'TURN_DONE' }
  | { type: 'ZOOM'; zoom: ReaderState['zoom'] }
  | { type: 'LAYOUT'; layout: ReaderLayout; view: number }
  | { type: 'HUD'; show: boolean }
  | { type: 'REDUCED'; on: boolean }
  | { type: 'LOW_POWER'; on: boolean }
  | { type: 'ESCAPE' };

export interface MachineCtx {
  /** Number of views (End card included). */
  views: number;
}

export const initialReaderState = (init: Partial<ReaderState> = {}): ReaderState => ({
  phase: 'reading',
  layout: 'single',
  view: 0,
  zoom: null,
  motion: { kind: 'idle' },
  queued: null,
  hud: true,
  reduced: false,
  lowPower: false,
  bump: null,
  fade: 0,
  ...init
});

const clampView = (v: number, ctx: MachineCtx) => Math.min(Math.max(0, ctx.views - 1), Math.max(0, Math.round(v)));
const phaseFor = (view: number, ctx: MachineCtx): Phase => (ctx.views > 0 && view >= ctx.views - 1 ? 'end' : 'reading');
const zoomed = (s: ReaderState) => !!s.zoom && s.zoom.s > 1.05;
const bump = (s: ReaderState, dir: 1 | -1): ReaderState => ({ ...s, bump: { dir, n: (s.bump?.n ?? 0) + 1 } });

/** Land on a view (a committed turn or an instant reduced-motion change). */
const land = (s: ReaderState, view: number, ctx: MachineCtx): ReaderState => ({
  ...s,
  view,
  phase: s.phase === 'intro' ? 'reading' : phaseFor(view, ctx),
  zoom: null
});

/** Start a turn toward `to` (or change instantly under reduced motion). */
const startTurn = (s: ReaderState, to: number, ctx: MachineCtx, source: 'auto' | 'release' = 'auto', chained = false): ReaderState => {
  const from = s.view;
  if (to === from) return s;
  const dir: 1 | -1 = to > from ? 1 : -1;
  // Reduced motion lands at once (the stage crossfades); a scrolling column has no turn to play.
  if (s.reduced || s.layout === 'scroll') return { ...land(s, to, ctx), motion: { kind: 'idle' }, queued: null, fade: s.reduced ? s.fade + 1 : s.fade };
  const distance = Math.abs(to - from);
  const riffle = distance > 2 ? Math.min(MAX_RIFFLE, distance) : undefined;
  return { ...s, phase: s.phase === 'intro' ? 'reading' : s.phase, zoom: null, motion: { kind: 'turn', dir, from, to, source, ...(riffle ? { riffle } : {}), ...(chained ? { chained } : {}) } };
};

const step = (s: ReaderState, delta: 1 | -1, ctx: MachineCtx): ReaderState => {
  const to = s.view + delta;
  if (to < 0 || to > ctx.views - 1) return bump(s, delta);
  return startTurn(s, to, ctx);
};

export const readerReducer = (s: ReaderState, e: ReaderEvent, ctx: MachineCtx): ReaderState => {
  switch (e.type) {
    case 'OPEN':
      return { ...s, phase: e.intro && !s.reduced ? 'intro' : phaseFor(s.view, ctx), motion: { kind: 'idle' } };
    case 'INTRO_DONE':
      return s.phase === 'intro' ? { ...s, phase: phaseFor(s.view, ctx) } : s;
    case 'STEP': {
      if (s.phase === 'intro') return step({ ...s, phase: 'reading' }, e.delta, ctx);
      const m = s.motion;
      if (m.kind === 'turn' || m.kind === 'settle') {
        if (m.dir === e.delta) {
          if (m.kind === 'settle' && m.outcome === 'cancel') return s;
          return { ...s, queued: e.delta };
        }
        // Opposite direction mid-turn: the page springs back.
        if (m.kind === 'turn') return { ...s, queued: null, motion: { kind: 'settle', dir: m.dir, from: m.from, to: m.to, outcome: 'cancel' } };
        return s;
      }
      if (m.kind === 'drag') return s;
      // Zoomed in: an explicit step (a key, a button) still turns the page, and startTurn / land clear the
      // zoom. The stage keeps a pan from turning by accident: it sends no step from an edge tap or a wheel
      // while zoomed, and DRAG_START below refuses a swipe.
      return step(s, e.delta, ctx);
    }
    case 'GOTO': {
      const to = clampView(e.view, ctx);
      // A jump replaces whatever turn is running (the stage resets its leaf) and riffles from here.
      if (s.motion.kind !== 'idle') return startTurn({ ...s, motion: { kind: 'idle' }, queued: null }, to, ctx);
      return startTurn(s, to, ctx);
    }
    case 'DRAG_START': {
      if (s.motion.kind !== 'idle' || zoomed(s) || s.phase === 'intro') return s;
      const to = s.view + e.dir;
      if (to < 0 || to > ctx.views - 1) return bump(s, e.dir);
      return { ...s, motion: { kind: 'drag', dir: e.dir, to, grab: e.grab } };
    }
    case 'DRAG_END': {
      const m = s.motion;
      if (m.kind !== 'drag') return s;
      return { ...s, motion: { kind: 'settle', dir: m.dir, from: s.view, to: m.to, outcome: e.outcome } };
    }
    case 'TURN_DONE': {
      const m = s.motion;
      if (m.kind === 'turn' || (m.kind === 'settle' && m.outcome === 'commit')) {
        const landed = { ...land(s, m.to, ctx), motion: { kind: 'idle' } as Motion, queued: null };
        if (s.queued !== null) {
          const next = m.to + s.queued;
          if (next >= 0 && next <= ctx.views - 1) return startTurn(landed, next, ctx, 'auto', true);
        }
        return landed;
      }
      if (m.kind === 'settle') return { ...s, motion: { kind: 'idle' }, queued: null };
      if (m.kind === 'drag') return { ...s, motion: { kind: 'idle' } };
      return s;
    }
    case 'ZOOM':
      return { ...s, zoom: e.zoom && e.zoom.s > 1.001 ? e.zoom : null };
    case 'LAYOUT':
      return { ...s, layout: e.layout, view: clampView(e.view, ctx), phase: s.phase === 'intro' ? 'intro' : phaseFor(clampView(e.view, ctx), ctx), motion: { kind: 'idle' }, queued: null, zoom: null };
    case 'HUD':
      return s.hud === e.show ? s : { ...s, hud: e.show };
    case 'REDUCED':
      return s.reduced === e.on ? s : { ...s, reduced: e.on, motion: e.on ? { kind: 'idle' } : s.motion };
    case 'LOW_POWER':
      return s.lowPower === e.on ? s : { ...s, lowPower: e.on };
    case 'ESCAPE':
      if (s.zoom) return { ...s, zoom: null };
      return s;
    default:
      return s;
  }
};

/** Escape unzooms or exits the reader (handled by the host). */
export const escapeTarget = (s: ReaderState): 'zoom' | 'exit' => (s.zoom ? 'zoom' : 'exit');
