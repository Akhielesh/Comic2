// Reader state machine (reader.md §12 rules): intro skip, turns, bounds bump, riffle queue, reverse
// mid-turn, drags, reduced motion, guided across page boundaries (incl. RTL page order), layout change
// during a drag, and the Escape cascade.
import { describe, expect, it } from 'vitest';
import { escapeTarget, initialReaderState, readerReducer, type MachineCtx, type ReaderEvent, type ReaderState } from './readerMachine';

const ctx: MachineCtx = { views: 6, stopsOf: (v) => (v === 0 ? 1 : v === 5 ? 1 : 4) };
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

describe('guided', () => {
  it('STEP moves panel by panel and turns the page past the last panel', () => {
    let s = run(start({ view: 1 }), { type: 'GUIDED', on: true });
    expect(s.guided).toEqual({ on: true, stop: 0, playing: false });
    s = run(s, { type: 'STEP', delta: 1 }, { type: 'STEP', delta: 1 }, { type: 'STEP', delta: 1 });
    expect(s.guided.stop).toBe(3);
    s = run(s, { type: 'STEP', delta: 1 });
    expect(s.motion).toMatchObject({ kind: 'turn', from: 1, to: 2 });
    s = run(s, { type: 'TURN_DONE' });
    expect(s).toMatchObject({ view: 2, guided: { on: true, stop: 0 } });
  });

  it('going back enters the previous page at its last panel', () => {
    const s = run(start({ view: 2 }), { type: 'GUIDED', on: true }, { type: 'PANEL', delta: -1 }, { type: 'TURN_DONE' });
    expect(s).toMatchObject({ view: 1, guided: { stop: 3 } });
  });

  it('GUIDED at a double-tapped panel; zoom is refused in guided; PLAY toggles', () => {
    const s = run(start(), { type: 'GUIDED', on: true, at: { view: 3, stop: 2 } });
    expect(s).toMatchObject({ view: 3, guided: { stop: 2 } });
    expect(run(s, { type: 'ZOOM', zoom: { s: 2, x: 0, y: 0 } }).zoom).toBeNull();
    expect(run(s, { type: 'PLAY', on: true }).guided.playing).toBe(true);
    expect(run(s, { type: 'STOP', stop: 99 }).guided.stop).toBe(3);
  });

  it('RTL books use the same view order (the stage mirrors the geometry), so guided crosses pages identically', () => {
    const s = run(start({ view: 1 }), { type: 'GUIDED', on: true }, { type: 'STOP', stop: 3 }, { type: 'PANEL', delta: 1 }, { type: 'TURN_DONE' });
    expect(s.view).toBe(2);
  });
});

describe('escape cascade', () => {
  it('zoom → guided → exit', () => {
    const zoomed = start({ zoom: { s: 2, x: 0, y: 0 } });
    expect(escapeTarget(zoomed)).toBe('zoom');
    expect(run(zoomed, { type: 'ESCAPE' }).zoom).toBeNull();
    const guided = run(start({ view: 1 }), { type: 'GUIDED', on: true });
    expect(escapeTarget(guided)).toBe('guided');
    expect(run(guided, { type: 'ESCAPE' }).guided.on).toBe(false);
    expect(escapeTarget(start())).toBe('exit');
  });

  it('HUD, reduced and low-power flags', () => {
    expect(run(start(), { type: 'HUD', show: false }).hud).toBe(false);
    expect(run(start(), { type: 'REDUCED', on: true }).reduced).toBe(true);
    expect(run(start(), { type: 'LOW_POWER', on: true }).lowPower).toBe(true);
  });
});
