// The Leaf turn engine writes styles straight to the page elements (no React render per frame):
// auto turns land and report frame times; a slow drag released before halfway springs back; the cover
// turns as a rigid board; slide/fade transitions; an opposite key mid-turn springs back; destroy() leaves
// the elements exactly as React rendered them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blankTurnCount, durationFor, recordBlankTurn, recordTurnPerf, TurnEngine, type EngineEls, type LeafPart } from './leafEngine';
import { READER_TOKEN_DEFAULTS } from './readerTokens';
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
    // One fade (reader.md F8): the DS entrance, 280 ms — not 300 here and 180 in TURN_MS.
    expect(durationFor('fade', false, false)).toBe(280);
  });

  it('a riffle takes its leaf time and stagger from the reader tokens (not literals)', () => {
    const leaves = [0, 1, 2].map(() => ({ front: part(), back: part() }));
    const p = plan({ kind: 'riffle', riffle: 3 } as Partial<TurnPlan>);
    const onDone = vi.fn();
    const engine = new TurnEngine(
      { plan: p, W, H, spineX: W, bookW: 2 * W, durationMs: 560, tokens: { riffleLeaf: 100, riffleStep: 50, easePaper: READER_TOKEN_DEFAULTS.easePaper } },
      { front: part(), back: part(), cast: el(), castBox: el(), shadow: el(), book: el(), incoming: [], outgoing: [], leaves },
      { onDone }
    );
    engine.startAuto();
    // 100 + 2 × 50 = 200 ms (the defaults would take 180 + 2 × 70 = 320 ms).
    vi.advanceTimersByTime(260);
    expect(onDone).toHaveBeenCalledWith('commit');
  });

  it('records per-turn frame stats for the QA harness', () => {
    const entry = recordTurnPerf('paper', Array(20).fill(16.7))!;
    expect(entry).toMatchObject({ kind: 'paper', frames: 20, p90: 16.7 });
    expect(entry.fps90).toBeGreaterThanOrEqual(55);
    expect((window as unknown as { __comicReaderPerf: unknown[] }).__comicReaderPerf.length).toBeGreaterThan(0);
    expect(recordTurnPerf('paper', [16])).toBeNull();
  });

  it('counts blank turns on the QA log (reader.md §8.9: __comicReaderPerf.blankTurns)', () => {
    const before = blankTurnCount();
    expect(recordBlankTurn()).toBe(before + 1);
    expect((window as unknown as { __comicReaderPerf: { blankTurns: number } }).__comicReaderPerf.blankTurns).toBe(before + 1);
  });
});

describe('flip', () => {
  const flipPlan = (over: Partial<TurnPlan> = {}) => plan({ kind: 'flip', leafSide: 'center', frontKey: undefined, backKey: undefined, staticKeys: [], underKeys: [], ...over });

  it('swings the incoming page in with index.css’s class, no frame loop, and lands once it ends', () => {
    const incoming = part();
    const outgoing = part();
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame');
    const { engine, onDone } = setup(flipPlan({ incomingKeys: ['i3'], outgoingKeys: ['i2'] }), { incoming: [incoming], outgoing: [outgoing] });
    engine.startAuto();
    expect(incoming.root!.classList.contains('animate-page-flip-next')).toBe(true);
    // Transform and opacity are the CSS animation's: the engine writes nothing per frame.
    expect(incoming.root!.style.transform).toBe('');
    expect(outgoing.root!.style.cssText).toBe('');
    expect(raf).not.toHaveBeenCalled();
    incoming.root!.dispatchEvent(new Event('animationend'));
    expect(onDone).toHaveBeenCalledWith('commit');
    expect(incoming.root!.className).toBe('');
    expect(durationFor('flip', true, true)).toBe(450);
  });

  it('mirrors in RTL; a spread swings as a pair around its spine; a reversal drops the swing', async () => {
    const left = part();
    const right = part();
    const slotX = new Map([[left.root!, 0], [right.root!, W]]);
    const p = flipPlan({ dir: -1, mirrored: true, incomingKeys: ['i2', 'i3'] });
    const onDone = vi.fn();
    const engine = new TurnEngine({ plan: p, W, H, spineX: 0, bookW: 2 * W, slotX, flipSpineX: W, durationMs: 450 }, { incoming: [left, right], outgoing: [] }, { onDone });
    engine.startAuto();
    expect(left.root!.classList.contains('animate-page-flip-next')).toBe(true);
    expect(left.root!.style.transformOrigin).toBe(`${W}px 50%`);
    expect(right.root!.style.transformOrigin).toBe('0px 50%');
    engine.springBack();
    expect(left.root!.className).toBe('');
    expect(right.root!.style.transformOrigin).toBe('');
    await Promise.resolve();
    expect(onDone).toHaveBeenCalledWith('cancel');
  });

  it('lands on its own when no animation runs, and destroy() leaves the pages as React rendered them', () => {
    const incoming = part();
    const { engine, onDone } = setup(flipPlan({ incomingKeys: ['i3'] }), { incoming: [incoming] });
    engine.startAuto();
    vi.advanceTimersByTime(600);
    expect(onDone).toHaveBeenCalledWith('commit');
    const again = part();
    const second = setup(flipPlan({ incomingKeys: ['i3'] }), { incoming: [again] });
    second.engine.startAuto();
    second.engine.destroy();
    expect(again.root!.className).toBe('');
    vi.advanceTimersByTime(600);
    expect(second.onDone).not.toHaveBeenCalled();
  });
});
