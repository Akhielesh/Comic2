// The Leaf turn engine writes styles straight to the page elements (no React render per frame):
// auto turns land and report frame times; a slow drag released before halfway springs back; the cover
// turns as a rigid board; slide/fade transitions; an opposite key mid-turn springs back; destroy() leaves
// the elements exactly as React rendered them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { durationFor, recordTurnPerf, TurnEngine, type EngineEls, type LeafPart } from './leafEngine';
import type { TurnPlan } from './turnPlan';

const W = 400;
const H = 600;
const el = () => document.createElement('div');
const part = (): LeafPart => ({ root: el(), curl: el(), shade: el() });

const plan = (over: Partial<TurnPlan> = {}): TurnPlan => ({
  kind: 'paper',
  dir: 1,
  from: 2,
  to: 3,
  leafSide: 'right',
  mirrored: false,
  mode: 'forward',
  frontKey: 'i3',
  backKey: 'i4',
  staticKeys: ['i2'],
  underKeys: ['i5'],
  incomingKeys: [],
  outgoingKeys: [],
  ...over
});

const setup = (p: TurnPlan, extra: Partial<EngineEls> = {}) => {
  const els: EngineEls = { front: part(), back: part(), cast: el(), castBox: el(), shadow: el(), book: el(), incoming: [], outgoing: [], ...extra };
  const onDone = vi.fn();
  const onFrames = vi.fn();
  const engine = new TurnEngine({ plan: p, W, H, spineX: W, bookW: 2 * W, durationMs: durationFor(p.kind, true, false) }, els, { onDone, onFrames });
  return { els, engine, onDone, onFrames };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('paper', () => {
  it('an auto turn folds the page, lands, and reports its frames', () => {
    const { els, engine, onDone, onFrames } = setup(plan());
    engine.startAuto();
    // First frame is written synchronously: still flat, back face hidden.
    expect(els.back!.root!.style.visibility).toBe('hidden');
    vi.advanceTimersByTime(340);
    expect(els.front!.root!.style.clipPath).toMatch(/^polygon\(/);
    expect(els.back!.root!.style.visibility).toBe('visible');
    expect(els.back!.root!.style.transform).toMatch(/^matrix\(/);
    expect(Number(els.cast!.style.opacity)).toBeGreaterThan(0);
    expect(els.front!.root!.style.willChange).toBe('transform, clip-path');
    vi.advanceTimersByTime(500);
    expect(onDone).toHaveBeenCalledWith('commit');
    expect(onFrames).toHaveBeenCalledWith(expect.any(Array), 'paper');
    expect(onFrames.mock.calls[0][0].length).toBeGreaterThan(10);
    // Landed: the back face sits exactly on its final slot (identity), so settling causes no jump.
    expect(els.back!.root!.style.transform).toBe('matrix(1,0,0,1,0,0)');
    engine.destroy();
    for (const e of [els.front!.root!, els.back!.root!, els.cast!, els.shadow!]) {
      expect(e.style.transform).toBe('');
      expect(e.style.clipPath).toBe('');
      expect(e.style.willChange).toBe('');
    }
  });

  it('a slow drag released before halfway springs back (cancel)', () => {
    const { els, engine, onDone } = setup(plan());
    engine.startDrag({ x: W - 10, y: 0.9 * H }, 0.9 * H);
    engine.dragTo({ x: 0.55 * W, y: 0.85 * H });
    vi.advanceTimersByTime(20);
    expect(engine.turnProgress()).toBeGreaterThan(0.15);
    expect(engine.turnProgress()).toBeLessThan(0.5);
    expect(els.front!.root!.style.clipPath).toMatch(/^polygon\(/);
    engine.release('cancel');
    vi.advanceTimersByTime(900);
    expect(onDone).toHaveBeenCalledWith('cancel');
    expect(engine.turnProgress()).toBe(0);
  });

  it('the finger stays glued to the grabbed corner', () => {
    const { engine } = setup(plan());
    engine.startDrag({ x: W - 4, y: H - 4 }, 0.96 * H);
    engine.dragTo({ x: W - 104, y: H - 4 });
    // Corner moved 100 px left → the page is ~100/(2W) turned.
    expect(engine.turnProgress()).toBeCloseTo(100 / (2 * W), 1);
  });

  it('an opposite key mid-turn springs the leaf back', () => {
    const { engine, onDone } = setup(plan());
    engine.startAuto();
    vi.advanceTimersByTime(200);
    engine.springBack();
    vi.advanceTimersByTime(1200);
    expect(onDone).toHaveBeenCalledWith('cancel');
  });

  it('single pages: a page coming back (reverse) starts fully turned', () => {
    const p = plan({ leafSide: 'center', mode: 'reverse', backKey: undefined, backExtra: 'paper' });
    const { engine, onDone, els } = setup(p);
    expect(engine.turnProgress()).toBe(0);
    engine.startAuto();
    vi.advanceTimersByTime(300);
    expect(engine.turnProgress()).toBeGreaterThan(0.2);
    // Near the end of the lift the paper back fades instead of lying flat beside the book.
    vi.advanceTimersByTime(600);
    expect(onDone).toHaveBeenCalledWith('commit');
    expect(els.front!.root!.style.clipPath).not.toBe('');
  });
});

describe('board, slide, fade', () => {
  it('the cover turns as a rigid board (rotateY around the spine) with perspective', () => {
    const { els, engine, onDone } = setup(plan({ kind: 'board', frontKey: 'i0', backKey: 'ep-front' }));
    engine.startAuto();
    vi.advanceTimersByTime(400);
    expect(els.front!.root!.style.transform).toMatch(/^rotateY\(-\d/);
    expect(els.front!.root!.style.transformOrigin).toBe('0 50%');
    expect(els.front!.root!.style.backfaceVisibility).toBe('hidden');
    expect(els.book!.style.perspective).toBe('1800px');
    vi.advanceTimersByTime(600);
    expect(onDone).toHaveBeenCalledWith('commit');
    expect(els.back!.root!.style.transform).toBe('rotateY(0deg)');
    engine.destroy();
    expect(els.book!.style.perspective).toBe('');
  });

  it('slide: the next page slides in from the reading-forward edge over the receding one', () => {
    const incoming = [part()];
    const outgoing = [part()];
    const { engine, onDone } = setup(plan({ kind: 'slide', incomingKeys: ['i4'], outgoingKeys: ['i2'] }), { incoming, outgoing });
    engine.startAuto();
    expect(incoming[0].root!.style.transform).toBe(`translate3d(${2 * W}px,0,0)`);
    vi.advanceTimersByTime(500);
    expect(onDone).toHaveBeenCalledWith('commit');
    expect(incoming[0].root!.style.transform).toBe('translate3d(0px,0,0)');
    expect(outgoing[0].root!.style.transform).toBe('scale(0.97)');
  });

  it('RTL slides come from the left', () => {
    const incoming = [part()];
    const { engine } = setup(plan({ kind: 'slide', mirrored: true }), { incoming, outgoing: [] });
    engine.startAuto();
    expect(incoming[0].root!.style.transform).toBe(`translate3d(${-2 * W}px,0,0)`);
  });

  it('fade: the next page fades in on top', () => {
    const incoming = [part()];
    const { engine, onDone } = setup(plan({ kind: 'fade' }), { incoming, outgoing: [] });
    engine.startAuto();
    expect(incoming[0].root!.style.opacity).toBe('0');
    vi.advanceTimersByTime(400);
    expect(onDone).toHaveBeenCalled();
    expect(incoming[0].root!.style.opacity).toBe('1');
  });
});

describe('timing and perf', () => {
  it('durations per reader.md §14 (chained turns ×0.65)', () => {
    expect(durationFor('paper', false, false)).toBe(560);
    expect(durationFor('paper', true, false)).toBe(680);
    expect(durationFor('board', true, false)).toBe(820);
    expect(durationFor('slide', false, false)).toBe(420);
    expect(durationFor('paper', false, true)).toBe(364);
  });

  it('records per-turn frame stats for the QA harness', () => {
    const entry = recordTurnPerf('paper', Array(20).fill(16.7))!;
    expect(entry).toMatchObject({ kind: 'paper', frames: 20, p90: 16.7 });
    expect(entry.fps90).toBeGreaterThanOrEqual(55);
    expect((window as unknown as { __comicReaderPerf: unknown[] }).__comicReaderPerf.length).toBeGreaterThan(0);
    expect(recordTurnPerf('paper', [16])).toBeNull();
  });
});
