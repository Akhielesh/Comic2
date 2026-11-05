// Golden (reader.md §4.3 / RD-0): RD-A moves the reader's tokens into CSS and rebuilds the edges, the spotlight
// and the progress bars on transforms — but an old doc (no design) must lay its pages out exactly as before.
// The serialized slot geometry below was recorded from the reader before RD-A (dev d3356e1b) and is pinned.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { fakeUrlFor, makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import type { ComicDoc } from '../../../shared/comic/doc';
import { ImmersiveReader } from './ImmersiveReader';
import { pageImageCache } from './pageImageCache';

const oldDoc = (): ComicDoc =>
  makeSampleDoc((d) => {
    d.cover.render = { status: 'ready', history: [], asset: { path: 'u/cover.png', source: 'generated', at: 0, w: 1000, h: 1500 } };
    d.pages.forEach((p, i) => {
      p.render = { status: 'ready', history: [], asset: { path: `u/p${i + 1}.png`, source: 'generated', at: 0, w: 1000, h: 1500 } };
    });
  });

const realMatchMedia = window.matchMedia;
beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
});
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
  pageImageCache.clear();
});

/** Every mounted slot: its key, side, visibility and its root's inline style, plus its page box. */
const slots = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-slot]')).map((el) => {
    const box = el.firstElementChild as HTMLElement | null;
    return `${el.dataset.slot} ${el.dataset.side} ${el.dataset.visible} | ${el.style.cssText} | ${box?.style.cssText ?? ''}`;
  });

/** Recorded on dev d3356e1b (before RD-A): a phone (one page) and a desktop (spreads), before and after a turn. */
const GOLDEN: Record<string, string[]> = {
  phoneBefore: [
    "i1 center false | left: 0px; top: 0px; width: 370px; height: 552.2388059701492px; z-index: 0; visibility: hidden; pointer-events: none; contain: layout paint; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.14); | left: 0.9203980099502758px; top: 0px; width: 368.15920398009945px; height: 552.2388059701492px;",
    "i2 center true | left: 0px; top: 0px; width: 370px; height: 552.2388059701492px; z-index: 1; visibility: visible; pointer-events: none; contain: layout paint; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.14); | left: 0.9203980099502758px; top: 0px; width: 368.15920398009945px; height: 552.2388059701492px;",
    "i3 center false | left: 0px; top: 0px; width: 370px; height: 552.2388059701492px; z-index: 0; visibility: hidden; pointer-events: none; contain: layout paint; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.14); | left: 0.9203980099502758px; top: 0px; width: 368.15920398009945px; height: 552.2388059701492px;"
  ],
  phoneAfter: [
    "i2 center false | left: 0px; top: 0px; width: 370px; height: 552.2388059701492px; z-index: 0; visibility: hidden; pointer-events: none; contain: layout paint; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.14); | left: 0.9203980099502758px; top: 0px; width: 368.15920398009945px; height: 552.2388059701492px;",
    "i3 center true | left: 0px; top: 0px; width: 370px; height: 552.2388059701492px; z-index: 1; visibility: visible; pointer-events: none; contain: layout paint; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.14); | left: 0.9203980099502758px; top: 0px; width: 368.15920398009945px; height: 552.2388059701492px;",
    "i4 center false | left: 0px; top: 0px; width: 370px; height: 552.2388059701492px; z-index: 0; visibility: hidden; pointer-events: none; contain: layout paint; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.14); | left: 0.9203980099502758px; top: 0px; width: 368.15920398009945px; height: 552.2388059701492px;"
  ],
  deskBefore: [
    "ep-front left false | left: 0px; top: 0px; width: 503.84000000000003px; height: 752px; z-index: 0; visibility: hidden; pointer-events: none; contain: layout paint; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.14); | background: radial-gradient(circle at 25% 25%, rgba(120,92,60,0.07) 1.2px, transparent 1.6px) 0 0 / 14px 14px, radial-gradient(circle at 75% 75%, rgba(120,92,60,0.05) 1.2px, transparent 1.6px) 0 0 / 14px 14px, var(--ds-reader-endpaper);",
    "i1 right false | left: 503.84000000000003px; top: 0px; width: 503.84000000000003px; height: 752px; z-index: 0; visibility: hidden; pointer-events: none; contain: layout paint; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.14); | left: 1.2533333333333587px; top: 0px; width: 501.3333333333333px; height: 752px;",
    "i2 left true | left: 0px; top: 0px; width: 503.84000000000003px; height: 752px; z-index: 1; visibility: visible; pointer-events: none; contain: layout paint; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.14); | left: 1.2533333333333587px; top: 0px; width: 501.3333333333333px; height: 752px;",
    "i3 right true | left: 503.84000000000003px; top: 0px; width: 503.84000000000003px; height: 752px; z-index: 1; visibility: visible; pointer-events: none; contain: layout paint; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.14); | left: 1.2533333333333587px; top: 0px; width: 501.3333333333333px; height: 752px;",
    "i4 left false | left: 0px; top: 0px; width: 503.84000000000003px; height: 752px; z-index: 0; visibility: hidden; pointer-events: none; contain: layout paint; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.14); | left: 1.2533333333333587px; top: 0px; width: 501.3333333333333px; height: 752px;",
    "i5 right false | left: 503.84000000000003px; top: 0px; width: 503.84000000000003px; height: 752px; z-index: 0; visibility: hidden; pointer-events: none; contain: layout paint; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.14); | left: 1.2533333333333587px; top: 0px; width: 501.3333333333333px; height: 752px;"
  ],
  deskAfter: [
    "i2 left false | left: 0px; top: 0px; width: 503.84000000000003px; height: 752px; z-index: 0; visibility: hidden; pointer-events: none; contain: layout paint; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.14); | left: 1.2533333333333587px; top: 0px; width: 501.3333333333333px; height: 752px;",
    "i3 right false | left: 503.84000000000003px; top: 0px; width: 503.84000000000003px; height: 752px; z-index: 0; visibility: hidden; pointer-events: none; contain: layout paint; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.14); | left: 1.2533333333333587px; top: 0px; width: 501.3333333333333px; height: 752px;",
    "i4 left true | left: 0px; top: 0px; width: 503.84000000000003px; height: 752px; z-index: 1; visibility: visible; pointer-events: none; contain: layout paint; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.14); | left: 1.2533333333333587px; top: 0px; width: 501.3333333333333px; height: 752px;",
    "i5 right true | left: 503.84000000000003px; top: 0px; width: 503.84000000000003px; height: 752px; z-index: 1; visibility: visible; pointer-events: none; contain: layout paint; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.14); | left: 1.2533333333333587px; top: 0px; width: 501.3333333333333px; height: 752px;",
    "i6 left false | left: 0px; top: 0px; width: 503.84000000000003px; height: 752px; z-index: 0; visibility: hidden; pointer-events: none; contain: layout paint; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.14); | left: 1.2533333333333587px; top: 0px; width: 501.3333333333333px; height: 752px;",
    "end right false | left: 503.84000000000003px; top: 0px; width: 503.84000000000003px; height: 752px; z-index: 0; visibility: hidden; pointer-events: none; contain: layout paint; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.14); | "
  ]
};

const capture = (w: number, h: number) => {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: h, configurable: true });
  render(<ImmersiveReader doc={oldDoc()} urlFor={fakeUrlFor} intro={false} initialPage={2} onExit={() => undefined} />);
  const before = slots();
  fireEvent.keyDown(screen.getByTestId('immersive-reader'), { key: 'ArrowRight' });
  return { before, after: slots() };
};

describe('an old doc reads exactly as it did before RD-A (slot geometry and styles)', () => {
  it('a phone: one page at a time, before and after a turn', () => {
    const got = capture(390, 844);
    if (process.env.GOLDEN_PRINT) console.log('GOLDEN phone', JSON.stringify(got));
    expect(got.before).toEqual(GOLDEN.phoneBefore);
    expect(got.after).toEqual(GOLDEN.phoneAfter);
  });

  it('a desktop: facing pages, before and after a turn', () => {
    const got = capture(1280, 800);
    if (process.env.GOLDEN_PRINT) console.log('GOLDEN desk', JSON.stringify(got));
    expect(got.before).toEqual(GOLDEN.deskBefore);
    expect(got.after).toEqual(GOLDEN.deskAfter);
  });
});
