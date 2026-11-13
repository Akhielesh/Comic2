// Reader state machine (reader.md §12 rules): intro skip, turns, bounds bump, riffle queue, reverse
// mid-turn, drags, reduced motion, a key or button step while zoomed (the page turns and the zoom resets),
// layout change during a drag, and the Escape cascade.
import { describe, expect, it } from 'vitest';
import { escapeTarget, initialReaderState, readerReducer, type MachineCtx, type ReaderEvent, type ReaderState } from './readerMachine';

const ctx: MachineCtx = { views: 6 };
const run = (s: ReaderState, ...events: ReaderEvent[]) => events.reduce((acc, e) => readerReducer(acc, e, ctx), s);
const start = (over: Partial<ReaderState> = {}) => initialReaderState({ layout: 'single', ...over });

describe('intro', () => {
  it('OPEN with intro → intro; INTRO_DONE → reading; STEP skips the intro and turns the cover', () => {
    const s = run(start(), { type: 'OPEN', intro: true });
    expect(s.phase).toBe('intro');
    expect(run(s, { type: 'INTRO_DONE' }).phase).toBe('reading');
    const t = run(s, { type: 'STEP', delta: 1 });
    expect(t.phase).toBe('reading');
    expect(t.motion).toMatchObject({ kind: 'turn', dir: 1, from: 0, to: 1, source: 'auto' });
  });

  it('reduced motion never plays the intro', () => {
    expect(run(start({ reduced: true }), { type: 'OPEN', intro: true }).phase).toBe('reading');
  });
});

describe('turns', () => {
  it('STEP → auto turn; TURN_DONE lands on the new view', () => {
    const s = run(start(), { type: 'STEP', delta: 1 });
    expect(s.view).toBe(0);
    const done = run(s, { type: 'TURN_DONE' });
    expect(done.view).toBe(1);
    expect(done.motion.kind).toBe('idle');
  });

  it('the last view is the End card (phase end); stepping past either end bumps', () => {
    const atEnd = run(start({ view: 4 }), { type: 'STEP', delta: 1 }, { type: 'TURN_DONE' });
    expect(atEnd.view).toBe(5);
    expect(atEnd.phase).toBe('end');
    const bumped = run(atEnd, { type: 'STEP', delta: 1 });
    expect(bumped.motion.kind).toBe('idle');
    expect(bumped.bump).toEqual({ dir: 1, n: 1 });
    expect(run(start(), { type: 'STEP', delta: -1 }).bump).toEqual({ dir: -1, n: 1 });
  });

  it('a same-direction STEP mid-turn is queued and chained on TURN_DONE', () => {
    const s = run(start(), { type: 'STEP', delta: 1 }, { type: 'STEP', delta: 1 });
    expect(s.queued).toBe(1);
    const chained = run(s, { type: 'TURN_DONE' });
    expect(chained.view).toBe(1);
    expect(chained.motion).toMatchObject({ kind: 'turn', from: 1, to: 2, chained: true });
    expect(chained.queued).toBeNull();
  });

  it('an opposite STEP mid-turn springs the page back (cancel) and the view stays', () => {
    const s = run(start({ view: 2 }), { type: 'STEP', delta: 1 }, { type: 'STEP', delta: -1 });
    expect(s.motion).toMatchObject({ kind: 'settle', outcome: 'cancel' });
    expect(run(s, { type: 'TURN_DONE' })).toMatchObject({ view: 2, motion: { kind: 'idle' } });
  });

  it('GOTO more than two views away riffles (≤ 4 leaves); reduced motion changes the view at once', () => {
    expect(run(start(), { type: 'GOTO', view: 5 }).motion).toMatchObject({ kind: 'turn', to: 5, riffle: 4 });
    expect(run(start(), { type: 'GOTO', view: 3 }).motion).toMatchObject({ kind: 'turn', to: 3, riffle: 3 });
    expect(run(start(), { type: 'GOTO', view: 2 }).motion).not.toHaveProperty('riffle');
    const r = run(start({ reduced: true }), { type: 'GOTO', view: 4 });
    expect(r).toMatchObject({ view: 4, motion: { kind: 'idle' }, fade: 1 });
  });

  it('a scrolling column lands instantly (no turn to play)', () => {
    expect(run(start({ layout: 'scroll' }), { type: 'GOTO', view: 3 })).toMatchObject({ view: 3, motion: { kind: 'idle' }, fade: 0 });
  });
});

describe('drags', () => {
  it('DRAG_START → drag; DRAG_END commit → settle → TURN_DONE lands; cancel keeps the view', () => {
    const d = run(start({ view: 1 }), { type: 'DRAG_START', dir: 1, grab: { x: 400, y: 560 } });
    expect(d.motion).toMatchObject({ kind: 'drag', dir: 1, to: 2 });
    expect(run(d, { type: 'DRAG_END', outcome: 'commit' }, { type: 'TURN_DONE' }).view).toBe(2);
    expect(run(d, { type: 'DRAG_END', outcome: 'cancel' }, { type: 'TURN_DONE' })).toMatchObject({ view: 1, motion: { kind: 'idle' } });
  });

  it('no drag while zoomed, mid-turn, or during the intro; dragging past the ends bumps', () => {
    expect(run(start({ zoom: { s: 2, x: 0, y: 0 } }), { type: 'DRAG_START', dir: 1, grab: { x: 0, y: 0 } }).motion.kind).toBe('idle');
    expect(run(start({ phase: 'intro' }), { type: 'DRAG_START', dir: 1, grab: { x: 0, y: 0 } }).motion.kind).toBe('idle');
    expect(run(start(), { type: 'DRAG_START', dir: -1, grab: { x: 0, y: 0 } }).bump?.dir).toBe(-1);
  });

  it('a layout change during a drag cancels the motion and keeps the page', () => {
    const d = run(start({ view: 3 }), { type: 'DRAG_START', dir: 1, grab: { x: 0, y: 0 } }, { type: 'LAYOUT', layout: 'spread', view: 2 });
    expect(d).toMatchObject({ layout: 'spread', view: 2, motion: { kind: 'idle' } });
  });
});

describe('zoomed in (free zoom)', () => {
  const zoom = { s: 2, x: -120, y: -80 };

  it('a STEP (arrow key, Space, a button) turns the page and the zoom resets', () => {
    const s = run(start({ view: 1, zoom }), { type: 'STEP', delta: 1 });
    expect(s.zoom).toBeNull();
    expect(s.motion).toMatchObject({ kind: 'turn', dir: 1, from: 1, to: 2, source: 'auto' });
    expect(run(s, { type: 'TURN_DONE' })).toMatchObject({ view: 2, zoom: null, motion: { kind: 'idle' } });
    // Backward as well.
    expect(run(start({ view: 2, zoom }), { type: 'STEP', delta: -1 }, { type: 'TURN_DONE' })).toMatchObject({ view: 1, zoom: null, motion: { kind: 'idle' } });
  });

  it('reduced motion: the STEP lands on the next view at once, unzoomed', () => {
    expect(run(start({ view: 1, zoom, reduced: true }), { type: 'STEP', delta: 1 })).toMatchObject({ view: 2, zoom: null, motion: { kind: 'idle' }, fade: 1 });
  });

  it('a second STEP while that turn runs is queued like any other (no stuck state)', () => {
    const s = run(start({ view: 1, zoom }), { type: 'STEP', delta: 1 }, { type: 'STEP', delta: 1 }, { type: 'TURN_DONE' });
    expect(s).toMatchObject({ view: 2, zoom: null, motion: { kind: 'turn', from: 2, to: 3, chained: true } });
  });

  it('a STEP past either end has no page to turn to: it bumps and the zoom stays', () => {
    expect(run(start({ view: 5, zoom }), { type: 'STEP', delta: 1 })).toMatchObject({ view: 5, zoom, motion: { kind: 'idle' }, bump: { dir: 1, n: 1 } });
    expect(run(start({ view: 0, zoom }), { type: 'STEP', delta: -1 })).toMatchObject({ view: 0, zoom, motion: { kind: 'idle' }, bump: { dir: -1, n: 1 } });
  });

  it('a swipe still never turns a zoomed page (one finger pans): DRAG_START is refused and the zoom stays', () => {
    expect(run(start({ view: 1, zoom }), { type: 'DRAG_START', dir: 1, grab: { x: 400, y: 560 } })).toMatchObject({ view: 1, zoom, motion: { kind: 'idle' } });
  });
});

describe('escape cascade', () => {
  it('zoom → exit', () => {
    const zoomed = start({ zoom: { s: 2, x: 0, y: 0 } });
    expect(escapeTarget(zoomed)).toBe('zoom');
    expect(run(zoomed, { type: 'ESCAPE' }).zoom).toBeNull();
    expect(escapeTarget(start())).toBe('exit');
  });

  it('HUD, reduced and low-power flags', () => {
    expect(run(start(), { type: 'HUD', show: false }).hud).toBe(false);
    expect(run(start(), { type: 'REDUCED', on: true }).reduced).toBe(true);
    expect(run(start(), { type: 'LOW_POWER', on: true }).lowPower).toBe(true);
  });
});
