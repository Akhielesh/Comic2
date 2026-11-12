// The book stage's wheel zoom and the keys while zoomed, in the full immersive reader (jsdom).
//
// One Ctrl/⌘ + wheel notch is a gentle step (about ×1.4; it was ×2.7, so two notches hit the 4× cap), a
// trackpad pinch (a stream of small Ctrl+wheel deltas) still follows the fingers, and an arrow key turns the
// page while zoomed: the zoom resets, at once under reduced motion. What must not turn a zoomed page still
// does not: an edge tap, a swipe (it pans) and a plain wheel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { fakeUrlFor, makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import type { ComicDoc } from '../../../shared/comic/doc';
import { WHEEL_NOTCH_ZOOM, wheelZoomFactor } from './BookStage';
import { ImmersiveReader } from './ImmersiveReader';
import { pageImageCache } from './pageImageCache';

const drawnDoc = (): ComicDoc =>
  makeSampleDoc((d) => {
    d.cover.render = { status: 'ready', history: [], asset: { path: 'u/cover.png', source: 'generated', at: 0, w: 1000, h: 1500 } };
    d.pages.forEach((p, i) => {
      p.render = { status: 'ready', history: [], asset: { path: `u/p${i + 1}.png`, source: 'generated', at: 0, w: 1000, h: 1500 } };
    });
  });

const VW = 1280;
const VH = 800;
let reduce = false;
const realMatchMedia = window.matchMedia;
let animations: { keyframes: unknown; options: KeyframeAnimationOptions | number | undefined }[] = [];

beforeEach(() => {
  reduce = false;
  animations = [];
  // A desktop with a mouse: fine pointer, hover.
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
  Object.defineProperty(window, 'innerWidth', { value: VW, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: VH, configurable: true });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(16), { status: 200 })));
  let n = 0;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => `blob:test/${(n += 1)}`;
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
  (HTMLImageElement.prototype as unknown as { decode: () => Promise<void> }).decode = () => Promise.resolve();
  // Record WAAPI use (jsdom has none), so the reduced-motion test can read what the reader started.
  (Element.prototype as unknown as { animate: unknown }).animate = function (keyframes: unknown, options?: KeyframeAnimationOptions | number) {
    animations.push({ keyframes, options });
    return { cancel: () => undefined, finished: Promise.resolve() } as unknown as Animation;
  };
  vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
  delete (Element.prototype as unknown as { animate?: unknown }).animate;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  pageImageCache.clear();
});

const root = () => screen.getByTestId('immersive-reader');
const stage = () => screen.getByTestId('book-stage');
const book = () => screen.getByTestId('reader-book');
/** The camera's wrapper (the stage's first child): it carries the zoom transform. */
const wrapper = () => stage().firstElementChild as HTMLElement;
const press = (key: string) => fireEvent.keyDown(root(), { key });
const counter = () => screen.getByTestId('reader-hud-counter').textContent;
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

const camera = () => {
  const t = wrapper().style.transform;
  const tr = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(t);
  const sc = /scale\(([\d.]+)\)/.exec(t);
  return { tx: tr ? Number(tr[1]) : 0, ty: tr ? Number(tr[2]) : 0, scale: sc ? Number(sc[1]) : 1 };
};

/** Opens the reader on a desktop spread ("Pages 2–3 of 6"), lets its pages decode, and returns a zoom probe. */
const open = async () => {
  render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} initialPage={2} onExit={() => undefined} />);
  await wait(30);
  expect(root().dataset.layout).toBe('spread');
  expect(counter()).toBe('Pages 2–3 of 6');
  const fitWidth = parseFloat(book().style.width);
  expect(fitWidth).toBeGreaterThan(0);
  return {
    fitWidth,
    /**
     * How far the book is zoomed in. While a gesture runs the wrapper is scaled; 120 ms after it settles the
     * stage lays the book out at that size (crisp lettering) and the wrapper keeps a translation. Either way:
     * wrapper scale × laid-out width ÷ width at fit.
     */
    zoom: () => (camera().scale * parseFloat(book().style.width)) / fitWidth
  };
};

/** One wheel event at the middle of the room. Returns false when the reader took it (preventDefault). */
const wheel = (init: WheelEventInit) => fireEvent.wheel(stage(), { clientX: VW / 2, clientY: VH / 2, ...init });
const notch = (dir: 'in' | 'out', init: WheelEventInit = { ctrlKey: true }) => wheel({ deltaY: dir === 'in' ? -100 : 100, ...init });

describe('wheelZoomFactor: one wheel event → a zoom factor', () => {
  it('a mouse wheel notch (100 px, 120 px, 3 lines, a page) is one gentle step either way', () => {
    expect(WHEEL_NOTCH_ZOOM).toBeCloseTo(1.4, 5);
    for (const [dy, mode] of [[-100, 0], [-120, 0], [-3, 1], [-1, 2], [-480, 0]] as const) expect(wheelZoomFactor(dy, mode)).toBeCloseTo(1.4, 5);
    for (const [dy, mode] of [[100, 0], [120, 0], [3, 1], [1, 2]] as const) expect(wheelZoomFactor(dy, mode)).toBeCloseTo(1 / 1.4, 5);
  });

  it('small deltas (a trackpad pinch) keep the scale the gesture asked for: exp(-deltaY / 100)', () => {
    expect(wheelZoomFactor(0)).toBe(1);
    expect(wheelZoomFactor(-4)).toBeCloseTo(Math.exp(0.04), 8);
    expect(wheelZoomFactor(7.5)).toBeCloseTo(Math.exp(-0.075), 8);
    expect(wheelZoomFactor(-1, 1)).toBeCloseTo(Math.exp(0.16), 8); // one line = 16 px
    // In and out undo each other, and the step never jumps as the delta grows.
    for (const d of [1, 4, 12, 30, 33, 34, 50, 100, 240]) {
      expect(wheelZoomFactor(-d) * wheelZoomFactor(d)).toBeCloseTo(1, 8);
      expect(wheelZoomFactor(-(d + 1))).toBeGreaterThanOrEqual(wheelZoomFactor(-d));
      expect(wheelZoomFactor(-d)).toBeLessThanOrEqual(1.4 + 1e-9);
    }
  });
});

describe('Ctrl/⌘ + wheel in the full reader: one notch is a gentle step', () => {
  it('one 100-px Ctrl notch zooms in about ×1.4 (it was ×2.7), under the pointer, and the browser does not zoom the page', async () => {
    const r = await open();
    expect(r.zoom()).toBeCloseTo(1, 3);
    const notCancelled = notch('in');
    expect(notCancelled, 'the reader took the wheel (preventDefault)').toBe(false);
    expect(r.zoom()).toBeLessThanOrEqual(1.5);
    expect(r.zoom()).toBeGreaterThanOrEqual(1.3);
    expect(r.zoom()).toBeCloseTo(1.4, 2);
    // The point under the pointer (the middle of the room) stays put.
    const c = camera();
    expect((VW / 2 - c.tx) / c.scale).toBeCloseTo(VW / 2, 0);
    expect((VH / 2 - c.ty) / c.scale).toBeCloseTo(VH / 2, 0);
  });

  it('⌘ + wheel is the same step, and a notch back out returns to the whole page', async () => {
    const r = await open();
    notch('in', { metaKey: true });
    expect(r.zoom()).toBeCloseTo(1.4, 2);
    notch('out', { metaKey: true });
    await waitFor(() => expect(r.zoom()).toBeCloseTo(1, 3));
    await waitFor(() => expect(camera()).toMatchObject({ tx: 0, ty: 0, scale: 1 }));
  });

  it('a 120-px notch and a line-mode notch (3 lines) are the same step, never more than ×1.5', async () => {
    const r = await open();
    wheel({ deltaY: -120, ctrlKey: true });
    expect(r.zoom()).toBeCloseTo(1.4, 2);
    wheel({ deltaY: 120, ctrlKey: true });
    wheel({ deltaY: -3, deltaMode: 1, ctrlKey: true });
    expect(r.zoom()).toBeLessThanOrEqual(1.5);
    expect(r.zoom()).toBeCloseTo(1.4, 2);
  });

  it('the 4× cap takes five notches, not two', async () => {
    const r = await open();
    const seen: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      notch('in');
      seen.push(Math.round(r.zoom() * 100) / 100);
    }
    expect(seen[1], 'two notches').toBeLessThan(2.1);
    expect(seen.slice(0, 4).every((z) => z < 4), `steps ${seen.join(' → ')}`).toBe(true);
    expect(seen[4]).toBe(4);
    expect(seen[5]).toBe(4);
  });

  it('a trackpad pinch (a stream of small Ctrl+wheel deltas) still follows the fingers, in small even steps', async () => {
    const r = await open();
    let last = r.zoom();
    for (let i = 0; i < 20; i += 1) {
      wheel({ deltaY: -4, ctrlKey: true });
      const z = r.zoom();
      expect(z).toBeGreaterThan(last);
      expect(z / last, 'no jump inside a pinch').toBeLessThan(1.06);
      last = z;
    }
    // 20 × 4 px is the pinch scale e^0.8 ≈ 2.23: the page tracks the gesture one to one, as before.
    expect(last).toBeGreaterThan(2.15);
    expect(last).toBeLessThan(2.3);
    for (let i = 0; i < 20; i += 1) wheel({ deltaY: 4, ctrlKey: true });
    expect(r.zoom()).toBeCloseTo(1, 1);
  });
});

describe('keys turn the page while zoomed (the zoom resets)', () => {
  it('reduced motion: → turns the page at once and the camera cuts back to the whole page (no glide)', async () => {
    reduce = true;
    const r = await open();
    notch('in');
    expect(r.zoom()).toBeCloseTo(1.4, 2);
    animations = [];
    press('ArrowRight');
    expect(counter()).toBe('Pages 4–5 of 6');
    // No frames to wait for: the camera is already back at the whole page.
    expect(camera()).toMatchObject({ tx: 0, ty: 0 });
    expect(r.zoom()).toBeCloseTo(1, 3);
    for (const a of animations) {
      const o = typeof a.options === 'number' ? { duration: a.options } : a.options || {};
      expect(o.iterations ?? 1, 'never an endless animation').not.toBe(Infinity);
      expect(Number(o.duration ?? 0), 'a short fade at most').toBeLessThanOrEqual(200);
    }
    // ← works the same from a zoomed page.
    notch('in');
    press('ArrowLeft');
    expect(counter()).toBe('Pages 2–3 of 6');
    expect(r.zoom()).toBeCloseTo(1, 3);
  });

  it('reduced motion: Space and Page Up turn a zoomed page too', async () => {
    reduce = true;
    const r = await open();
    notch('in');
    press(' ');
    expect(counter()).toBe('Pages 4–5 of 6');
    notch('in');
    press('PageUp');
    expect(counter()).toBe('Pages 2–3 of 6');
    expect(r.zoom()).toBeCloseTo(1, 3);
  });

  it('motion on: → from a settled zoom eases the camera out, then turns the leaf', async () => {
    const r = await open();
    notch('in');
    await wait(200); // the zoom settles: the book is laid out at the zoomed size
    expect(parseFloat(book().style.width) / r.fitWidth).toBeCloseTo(1.4, 2);
    press('ArrowRight');
    await waitFor(() => expect(counter()).toBe('Pages 4–5 of 6'), { timeout: 8000 });
    await waitFor(() => expect(camera()).toMatchObject({ tx: 0, ty: 0, scale: 1 }));
    expect(parseFloat(book().style.width)).toBeCloseTo(r.fitWidth, 3);
  }, 20_000);

  it('motion on: → pressed right after a notch still turns, and the book is never re-laid at the old zoom mid-turn', async () => {
    const r = await open();
    const widths: number[] = [];
    const seen = new MutationObserver(() => widths.push(parseFloat(book().style.width)));
    seen.observe(book(), { attributes: true, attributeFilter: ['style'] });
    notch('in'); // not settled yet: the 120 ms crisp re-layout is still pending
    press('ArrowRight');
    await waitFor(() => expect(counter()).toBe('Pages 4–5 of 6'), { timeout: 8000 });
    await wait(450);
    seen.disconnect();
    expect(widths.every((w) => Math.abs(w - r.fitWidth) < 0.5), `book widths during the turn: ${[...new Set(widths.map((w) => Math.round(w)))].join(', ')} (fit ${Math.round(r.fitWidth)})`).toBe(true);
    expect(camera()).toMatchObject({ tx: 0, ty: 0, scale: 1 });
    expect(parseFloat(book().style.width)).toBeCloseTo(r.fitWidth, 3);
  }, 20_000);
});

describe('what still never turns a zoomed page (a pan must not turn by accident)', () => {
  /** jsdom has no layout: give the stage its real box so a tap's place across the room is read. */
  const layOutStage = () => {
    stage().getBoundingClientRect = () => ({ left: 0, top: 0, right: VW, bottom: VH, width: VW, height: VH, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  };
  const tap = (x: number) => {
    fireEvent.pointerDown(stage(), { clientX: x, clientY: 400, pointerId: 1, pointerType: 'mouse', button: 0 });
    fireEvent.pointerUp(stage(), { clientX: x, clientY: 400, pointerId: 1, pointerType: 'mouse', button: 0 });
  };

  it('an edge tap does nothing while zoomed; unzoomed it turns', async () => {
    reduce = true;
    const r = await open();
    layOutStage();
    notch('in');
    tap(VW - 40);
    expect(counter()).toBe('Pages 2–3 of 6');
    expect(r.zoom()).toBeCloseTo(1.4, 2);
    press('Escape');
    expect(r.zoom()).toBeCloseTo(1, 3);
    await wait(350); // past the double-tap window
    tap(VW - 40);
    expect(counter()).toBe('Pages 4–5 of 6');
  });

  it('a swipe pans the zoomed page and never turns it', async () => {
    reduce = true;
    const r = await open();
    layOutStage();
    notch('in');
    const before = camera();
    fireEvent.pointerDown(stage(), { clientX: 700, clientY: 400, pointerId: 3, pointerType: 'touch' });
    fireEvent.pointerMove(stage(), { clientX: 560, clientY: 404, pointerId: 3, pointerType: 'touch' });
    fireEvent.pointerMove(stage(), { clientX: 420, clientY: 408, pointerId: 3, pointerType: 'touch' });
    fireEvent.pointerUp(stage(), { clientX: 420, clientY: 408, pointerId: 3, pointerType: 'touch' });
    expect(counter()).toBe('Pages 2–3 of 6');
    expect(r.zoom()).toBeCloseTo(1.4, 2);
    expect(camera().tx).toBeLessThan(before.tx - 100);
  });

  it('a plain wheel does not step while zoomed; unzoomed it does', async () => {
    reduce = true;
    const r = await open();
    notch('in');
    wheel({ deltaY: 120 });
    expect(counter()).toBe('Pages 2–3 of 6');
    expect(r.zoom()).toBeCloseTo(1.4, 2);
    press('Escape');
    wheel({ deltaY: 120 });
    expect(counter()).toBe('Pages 4–5 of 6');
  });
});
