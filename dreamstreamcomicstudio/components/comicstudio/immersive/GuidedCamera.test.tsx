// Guided camera GPU hygiene (reader.md §5.3 RD-0, PROGRAM3 B16): during a move the camera writes ONLY
// `transform` and `opacity` — the spotlight is four shutters moved by transform, never left/top/width/height
// under a 200vmax box-shadow (layout + a full-viewport repaint every frame).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook } from '@testing-library/react';
import React from 'react';
import { cameraTransform, shutterTransforms, Spotlight, useCameraAnimator, SHUTTER_SIDES } from './GuidedCamera';
import type { Camera, CameraRect } from './guidedModel';

/** Record every style property written on an element (assignments and setProperty). */
const spyStyle = (el: HTMLElement, writes: string[]) => {
  const real = el.style;
  const proxy = new Proxy(real, {
    set(target, prop, value) {
      writes.push(String(prop));
      (target as unknown as Record<string | symbol, unknown>)[prop] = value;
      return true;
    },
    get(target, prop) {
      if (prop === 'setProperty') return (name: string, value: string) => {
        writes.push(name);
        target.setProperty(name, value);
      };
      const v = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    }
  });
  Object.defineProperty(el, 'style', { value: proxy, configurable: true });
};

let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => frames.push(fn));
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});
afterEach(() => vi.unstubAllGlobals());

const runFrames = (t0: number, n: number, step = 16) => {
  for (let i = 1; i <= n; i += 1) {
    const batch = frames;
    frames = [];
    for (const fn of batch) fn(t0 + i * step);
  }
};

const cam = (s: number, tx: number, ty: number): Camera => ({ s, tx, ty, rect: { x: 0, y: 0, w: 400 / s, h: 800 / s } });

describe('useCameraAnimator', () => {
  it('a guided move writes only transform and opacity, every frame (style spy)', () => {
    const { container } = render(<Spotlight ref={() => undefined} reduced={false} />);
    const spot = container.querySelector('[data-testid="guided-spotlight"]') as HTMLDivElement;
    const wrapper = document.createElement('div');
    const writes: string[] = [];
    spyStyle(wrapper, writes);
    spyStyle(spot, writes);
    for (const child of Array.from(spot.children) as HTMLElement[]) spyStyle(child, writes);
    const { result } = renderHook(() => useCameraAnimator({ current: wrapper }, { current: spot }, { w: 400, h: 800 }));
    const t0 = performance.now();
    const panel: CameraRect = { x: 40, y: 120, w: 300, h: 200 };
    result.current.move({ to: cam(2, -60, -200), durationMs: 420, spotFor: (c) => ({ x: panel.x * c.s + c.tx, y: panel.y * c.s + c.ty, w: panel.w * c.s, h: panel.h * c.s }) });
    runFrames(t0, 40);
    expect(writes.length).toBeGreaterThan(20);
    expect([...new Set(writes)].sort()).toEqual(['opacity', 'transform']);
    // Every shutter moved; the layer was shown once (an unchanged opacity is never rewritten per frame).
    expect(writes.filter((w) => w === 'opacity').length).toBe(1);
    for (const child of Array.from(spot.children) as HTMLElement[]) expect(child.style.transform).toMatch(/^translate3d\(/);
    expect(spot.style.opacity).toBe('1');
    expect(wrapper.style.transform).toBe(cameraTransform(cam(2, -60, -200), 1));
  });

  it('hiding the spotlight is an opacity write; nothing is laid out', () => {
    const { container } = render(<Spotlight ref={() => undefined} reduced />);
    const spot = container.querySelector('[data-testid="guided-spotlight"]') as HTMLDivElement;
    const wrapper = document.createElement('div');
    const writes: string[] = [];
    spyStyle(spot, writes);
    const { result } = renderHook(() => useCameraAnimator({ current: wrapper }, { current: spot }, { w: 400, h: 800 }));
    result.current.set(cam(1, 0, 0), { x: 0, y: 0, w: 100, h: 100 });
    result.current.set(cam(1, 0, 0), null);
    expect(spot.style.opacity).toBe('0');
    expect(writes.every((w) => w === 'opacity')).toBe(true);
  });
});

describe('Spotlight', () => {
  it('is four full-room shutters in a clipping layer: no box-shadow, no layout properties, the token fill', () => {
    const { container } = render(<Spotlight ref={() => undefined} reduced={false} />);
    const spot = container.querySelector('[data-testid="guided-spotlight"]') as HTMLDivElement;
    expect(spot.style.boxShadow).toBe('');
    expect(spot.style.width).toBe('');
    expect(spot.className).toContain('inset-0');
    expect(spot.className).toContain('overflow-hidden');
    expect(spot.style.transition).toContain('opacity');
    const shutters = Array.from(spot.children) as HTMLElement[];
    expect(shutters.map((s) => s.dataset.shutter)).toEqual([...SHUTTER_SIDES]);
    for (const s of shutters) {
      expect(s.className).toContain('inset-0');
      expect(s.style.background).toContain('--ds-reader-spot-fill');
    }
  });
});

describe('shutterTransforms', () => {
  /** Where a W×H box at the origin lands under translate3d(x, y) scale(1, sy). */
  const box = (t: string, W: number, H: number) => {
    const m = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\)(?: scale\(1, ([\d.]+)\))?/.exec(t)!;
    const x = Number(m[1]);
    const y = Number(m[2]);
    const sy = m[3] ? Number(m[3]) : 1;
    return { x0: x, x1: x + W, y0: y, y1: y + H * sy };
  };

  it('leaves exactly the panel uncovered and the four never overlap (the dimming is even)', () => {
    const W = 400;
    const H = 800;
    const r = { x: 40, y: 120, w: 300, h: 200 };
    const t = shutterTransforms(r, W, H);
    const top = box(t.top, W, H);
    const bottom = box(t.bottom, W, H);
    const left = box(t.left, W, H);
    const right = box(t.right, W, H);
    expect(top.y1).toBe(r.y);
    expect(bottom.y0).toBe(r.y + r.h);
    expect(left.x1).toBe(r.x);
    expect(right.x0).toBe(r.x + r.w);
    expect(left.y0).toBe(r.y);
    expect(left.y1).toBeCloseTo(r.y + r.h, 3);
    expect(right.y1).toBeCloseTo(r.y + r.h, 3);
    // The room outside the panel is covered: top above, bottom below, left/right beside it.
    expect(top.y0).toBeLessThanOrEqual(0);
    expect(bottom.y1).toBeGreaterThanOrEqual(H);
    expect(left.x0).toBeLessThanOrEqual(0);
    expect(right.x1).toBeGreaterThanOrEqual(W);
  });
});
