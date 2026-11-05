// Reader GPU hygiene and "never blank" in the full immersive reader (reader.md §5.3, §8; PROGRAM3 B15/B16):
// the page-edge stacks and the progress hairline animate transform only (never width/left); the root uses
// the reader token set and the z ladder; a tapped turn onto pages that have not decoded waits (≤ 300 ms, with
// a progress arc) and then turns anyway; preloads lean the way you read; reduced motion leaves nothing animating.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { fakeUrlFor, makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import type { ComicDoc } from '../../../shared/comic/doc';
import { ImmersiveReader, preloadPlan, retainedPaths } from './ImmersiveReader';
import { blankTurnCount } from './leafEngine';
import { pageImageCache } from './pageImageCache';
import type { BookView } from './readerLayout';

const drawnDoc = (): ComicDoc =>
  makeSampleDoc((d) => {
    d.cover.render = { status: 'ready', history: [], asset: { path: 'u/cover.png', source: 'generated', at: 0, w: 1000, h: 1500 } };
    d.pages.forEach((p, i) => {
      p.render = { status: 'ready', history: [], asset: { path: `u/p${i + 1}.png`, source: 'generated', at: 0, w: 1000, h: 1500 } };
    });
  });

let reduce = false;
let hang = false;
const realMatchMedia = window.matchMedia;
let animations: { keyframes: unknown; options: KeyframeAnimationOptions | number | undefined }[] = [];
/** Downloads a test left hanging: released after it, so the shared cache's download slots free up. */
const hanging: ((r: Response) => void)[] = [];

beforeEach(() => {
  reduce = false;
  hang = false;
  animations = [];
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? reduce : query.includes('hover: hover') || query.includes('any-pointer: fine'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });
  vi.stubGlobal('fetch', vi.fn(async () => (hang ? new Promise<Response>((r) => hanging.push(r)) : new Response(new Uint8Array(16), { status: 200 }))));
  let n = 0;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => `blob:test/${(n += 1)}`;
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
  (HTMLImageElement.prototype as unknown as { decode: () => Promise<void> }).decode = () => Promise.resolve();
  // Record WAAPI use (jsdom has none): the reader must leave nothing running under reduced motion.
  (Element.prototype as unknown as { animate: unknown }).animate = function (keyframes: unknown, options?: KeyframeAnimationOptions | number) {
    animations.push({ keyframes, options });
    return { cancel: () => undefined, finished: Promise.resolve() } as unknown as Animation;
  };
  vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
});

afterEach(async () => {
  cleanup();
  for (const r of hanging.splice(0)) r(new Response(null, { status: 404 }));
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
  window.matchMedia = realMatchMedia;
  delete (Element.prototype as unknown as { animate?: unknown }).animate;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  pageImageCache.clear();
});

const root = () => screen.getByTestId('immersive-reader');
const press = (key: string) => fireEvent.keyDown(root(), { key });
const counter = () => screen.getByTestId('reader-hud-counter').textContent;

describe('the reader root carries the token set', () => {
  it('data-reader-root, the --ds-z-reader layer, and no inline colour literals', () => {
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} onExit={() => undefined} />);
    const el = root();
    expect(el.hasAttribute('data-reader-root')).toBe(true);
    expect(el.className).toContain('z-[var(--ds-z-reader)]');
    expect(el.className).not.toContain('z-[80]');
    expect(el.getAttribute('style') || '').not.toMatch(/#[0-9a-f]{3,6}\b|--ds-reader-ink/i);
  });
});

describe('page-edge stacks (transform only, crisp stripes)', () => {
  const edges = () => ['page-edge-left', 'page-edge-right'].map((id) => screen.getByTestId(id));
  const stack = (box: HTMLElement) => box.querySelector('[data-edge-stack]') as HTMLElement;

  it('the boxes never change as you read; only the striped stack inside slides (translateX), and nothing transitions width or left', () => {
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} initialPage={2} onExit={() => undefined} />);
    const before = edges().map((b) => ({ left: b.style.left, width: b.style.width, t: stack(b).style.transform }));
    for (const b of edges()) {
      expect(b.style.transition).not.toMatch(/width|left/);
      expect(stack(b).style.transition).toMatch(/^transform /);
      expect(stack(b).style.transition).not.toMatch(/width|left/);
      expect(stack(b).style.transform).toMatch(/^translateX\(-?\d+px\)$/);
    }
    reduce = false;
    press('End');
    const after = edges().map((b) => ({ left: b.style.left, width: b.style.width, t: stack(b).style.transform }));
    // A riffle to the end starts a turn (motion on): the stacks keep their boxes.
    expect(after.map((a) => a.width)).toEqual(before.map((b) => b.width));
  });

  it('reduced motion: the stacks jump (no transition)', () => {
    reduce = true;
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} initialPage={2} onExit={() => undefined} />);
    for (const b of edges()) expect(stack(b).style.transition).toBe('');
    const start = edges().map((b) => stack(b).style.transform);
    const boxes = edges().map((b) => `${b.style.left} ${b.style.width}`);
    press('ArrowRight');
    const moved = edges().map((b) => stack(b).style.transform);
    expect(moved).not.toEqual(start);
    expect(edges().map((b) => `${b.style.left} ${b.style.width}`)).toEqual(boxes);
  });
});

describe('the progress hairline (scaleX, the room accent)', () => {
  it('is a full-width bar scaled from the reading edge, never an animated width, in --ds-reader-accent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      reduce = true;
      render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} initialPage={3} onExit={() => undefined} />);
      await act(async () => {
        vi.advanceTimersByTime(3000); // the HUD hides; the hairline shows
      });
      const bar = await screen.findByTestId('reader-progress');
      expect(bar.className).toContain('bg-[var(--ds-reader-accent)]');
      expect(bar.className).not.toContain('--ds-accent)');
      expect(bar.className).toContain('w-full');
      expect(bar.style.width).toBe('');
      expect(bar.style.transform).toMatch(/^scaleX\(0?\.\d+\)$/);
      expect(bar.style.transformOrigin).toBe('left');
      expect(bar.style.transition).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('right-to-left books fill from the right', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const doc = drawnDoc();
      doc.format = { ...doc.format, readingDirection: 'rtl', kind: 'manga' };
      render(<ImmersiveReader doc={doc} urlFor={fakeUrlFor} intro={false} initialPage={2} onExit={() => undefined} />);
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      const bar = await screen.findByTestId('reader-progress');
      expect(bar.style.transformOrigin).toBe('right');
      expect(bar.style.transition).toMatch(/^transform /);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reduced motion: nothing keeps animating after a turn settles', () => {
  it('turns land at once; every animation the reader starts is a short, finite fade', async () => {
    reduce = true;
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} onExit={() => undefined} />);
    press('ArrowRight');
    press('ArrowRight');
    expect(counter()).toBe('Page 2 of 6');
    expect(screen.queryByTestId('turn-gate')).toBeNull();
    for (const a of animations) {
      const o = typeof a.options === 'number' ? { duration: a.options } : a.options || {};
      expect(o.iterations ?? 1, 'never an endless animation').not.toBe(Infinity);
      expect(Number(o.duration ?? 0), 'a short fade').toBeLessThanOrEqual(200);
    }
  });
});

describe('the turn gate (reader.md §8.2): a tapped turn waits for its pages, at most 300 ms', () => {
  it('pages not decoded → the progress arc shows, then the turn goes anyway; a blank landing is counted', async () => {
    hang = true; // nothing ever arrives
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} onExit={() => undefined} />);
    const blanks = blankTurnCount();
    press('ArrowRight');
    expect(screen.getByTestId('turn-gate')).toBeInTheDocument();
    expect(counter()).toBe('Cover');
    await waitFor(() => expect(screen.queryByTestId('turn-gate')).toBeNull(), { timeout: 1500 });
    await waitFor(() => expect(counter()).toBe('Page 1 of 6'), { timeout: 3000 });
    expect(blankTurnCount()).toBe(blanks + 1);
  });

  it('pages already decoded → no wait, no arc', async () => {
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} onExit={() => undefined} />);
    await waitFor(() => expect(pageImageCache.isDecoded('u/p1.png')).toBe(true));
    const blanks = blankTurnCount();
    press('ArrowRight');
    expect(screen.queryByTestId('turn-gate')).toBeNull();
    await waitFor(() => expect(counter()).toBe('Page 1 of 6'), { timeout: 3000 });
    expect(blankTurnCount()).toBe(blanks);
  });
});

describe('preloading (reader.md §8.3) and the retained window (V1 C8)', () => {
  const views: BookView[] = Array.from({ length: 10 }, (_, v) => ({ key: `v${v}`, items: [v], slots: [] }) as unknown as BookView);

  it('forward: +1 page and stand-in at next, −1 page at next, +2…+3 pages at idle, +4…+5 stand-ins only at idle', () => {
    const plan = preloadPlan(views, 3, 1, false);
    const at = (item: number) => plan.filter((p) => p.item === item).map((p) => `${p.kind}:${p.prio}`).sort();
    expect(at(4)).toEqual(['standIn:next', 'target:next']);
    expect(at(2)).toEqual(['target:next']);
    expect(at(5)).toEqual(['target:idle']);
    expect(at(6)).toEqual(['target:idle']);
    expect(at(7)).toEqual(['standIn:idle']);
    expect(at(8)).toEqual(['standIn:idle']);
    expect(at(9)).toEqual([]);
    expect(at(1)).toEqual([]);
  });

  it('reading backward leans the other way', () => {
    const plan = preloadPlan(views, 6, -1, false);
    expect(plan.filter((p) => p.item === 5).map((p) => p.kind).sort()).toEqual(['standIn', 'target']);
    expect(plan.some((p) => p.item === 7 && p.kind === 'target')).toBe(true);
    expect(plan.some((p) => p.item === 2 && p.kind === 'standIn')).toBe(true);
  });

  it('Save-Data or 2G: stand-ins for the next two views only', () => {
    const plan = preloadPlan(views, 3, 1, true);
    expect(plan.every((p) => p.kind === 'standIn')).toBe(true);
    expect(plan.map((p) => p.item).sort()).toEqual([4, 5]);
  });

  it('the scrolling column asks for pages only (it shows no stand-ins)', () => {
    const plan = preloadPlan(views, 3, 1, false, { standIns: false });
    expect(plan.some((p) => p.kind === 'standIn')).toBe(false);
    expect(plan.map((p) => p.item).sort()).toEqual([2, 4, 5, 6]);
    expect(preloadPlan(views, 3, 1, true, { standIns: false })).toEqual([]);
  });

  it('spreads count both pages of a view', () => {
    const spread = [{ items: [0] }, { items: [1, 2] }, { items: [3, 4] }] as unknown as BookView[];
    expect(preloadPlan(spread, 0, 1, false).filter((p) => p.kind === 'target' && p.prio === 'next').map((p) => p.item)).toEqual([1, 2]);
  });

  it('retains ±2 views on fine pointers and ±1 on coarse ones; the shown source and its stand-in, never an unshown original', () => {
    const src = (i: number) => ({ path: `v${i}.1080.webp` });
    const stand = (i: number) => ({ path: `v${i}.480.webp` });
    const fine = retainedPaths(views, 5, false, src, stand);
    const coarse = retainedPaths(views, 5, true, src, stand);
    expect(fine).toEqual(['v3', 'v4', 'v5', 'v6', 'v7'].flatMap((v) => [`${v}.1080.webp`, `${v}.480.webp`]));
    expect(coarse).toEqual(['v4', 'v5', 'v6'].flatMap((v) => [`${v}.1080.webp`, `${v}.480.webp`]));
    expect(fine.some((p) => p.endsWith('.png'))).toBe(false);
  });
});
