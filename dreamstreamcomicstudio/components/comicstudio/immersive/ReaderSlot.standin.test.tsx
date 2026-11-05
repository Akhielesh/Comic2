// Never blank (reader.md §8.1, V2 N6; PROGRAM3 B15): a slot shows the first decoded of its page → the original
// (cached) → its stand-in (the ~480 px variant), so a cold turn lands on a picture, not paper; the real image
// then cross-fades in over the stand-in. A withheld page never fetches anything — no page, no stand-in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { fakeUrlFor, makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import type { AssetRef, ComicDoc } from '../../../shared/comic/doc';
import { readerItems } from '../reader/readerModel';
import { pageImageCache } from './pageImageCache';
import { SlotContentView, slotStandIn, type SlotImage } from './ReaderSlot';

const TARGET = 'u/p1_w1080.webp';
const STANDIN = 'u/p1_w480.webp';
const asset = (): AssetRef => ({
  path: 'u/p1.png',
  source: 'generated',
  at: 0,
  w: 1696,
  h: 2528,
  variants: [
    { path: STANDIN, w: 480, h: 715 },
    { path: TARGET, w: 1080, h: 1610 }
  ]
});
const docWith = (withheld = false): ComicDoc =>
  makeSampleDoc((d) => {
    d.pages.forEach((p, i) => {
      p.render = i === 0 ? { status: 'ready', history: [], asset: asset(), ...(withheld ? { withheld: 'safety' as const } : {}) } : { status: 'none', history: [] };
    });
  });

const img: SlotImage = { urlFor: fakeUrlFor, dpr: 1, saveData: false, original: false };

/** fetch gates per URL: each request waits until its test opens it. */
let gates: Map<string, () => void>;
let fetched: string[];
beforeEach(() => {
  gates = new Map();
  fetched = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          fetched.push(url);
          gates.set(url, () => resolve(new Response(new Uint8Array(64), { status: 200 })));
        })
    )
  );
  let n = 0;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => `blob:test/${(n += 1)}`;
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
  (HTMLImageElement.prototype as unknown as { decode: () => Promise<void> }).decode = () => Promise.resolve();
});
afterEach(() => {
  // Unmount first: a mounted slot would ask the cleared cache again (with the real fetch).
  cleanup();
  vi.unstubAllGlobals();
  pageImageCache.clear();
});

const open = async (path: string) => {
  await act(async () => {
    gates.get(`https://cdn.test/${path}`)?.();
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
};

/** A 560 px slot asks for the 1080 w variant (its source) at dpr 1. */
const renderSlot = (doc: ComicDoc, reduced = false) => {
  const items = readerItems(doc);
  return render(
    <div style={{ position: 'relative', width: 560, height: 840 }}>
      <SlotContentView doc={doc} content={{ kind: 'item', index: 0 }} items={items} width={560} height={840} contentAspect={1696 / 2528} img={img} prio="now" paper={false} letteringAriaHidden reduced={reduced} swapMs={120} />
    </div>
  );
};

describe('the stand-in chain', () => {
  it('a stand-in shows before the target, and an <img> never renders without a src', async () => {
    const { container } = renderSlot(docWith());
    // Both requested: the page itself and, while it is not decoded, its stand-in.
    await waitFor(() => expect(fetched).toEqual(expect.arrayContaining([`https://cdn.test/${TARGET}`, `https://cdn.test/${STANDIN}`])));
    const imgs = () => Array.from(container.querySelectorAll('img'));
    expect(imgs().filter((i) => !i.getAttribute('src'))).toEqual([]);
    expect(imgs()).toHaveLength(0); // nothing decoded yet: the shimmer, never an empty image

    await open(STANDIN);
    await waitFor(() => expect(container.querySelector('[data-standin="true"]')).not.toBeNull());
    const shown = imgs();
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((i) => (i.getAttribute('src') || '').startsWith('blob:'))).toBe(true);
    const standInSrc = shown[0].getAttribute('src');

    await open(TARGET);
    await waitFor(() => expect(container.querySelector('[data-standin="true"]')).toBeNull());
    const page = container.querySelector('[data-testid="comic-page"] img');
    expect(page?.getAttribute('src')).toMatch(/^blob:/);
    expect(page?.getAttribute('src')).not.toBe(standInSrc);
    expect(imgs().filter((i) => !i.getAttribute('src'))).toEqual([]);
  });

  it('the swap cross-fades: the stand-in lies under the page, which fades in over it (opacity), then the stand-in goes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const faded: { el: Element; keyframes: unknown }[] = [];
    (Element.prototype as unknown as { animate: unknown }).animate = function (this: Element, keyframes: unknown) {
      faded.push({ el: this, keyframes });
      return { cancel: () => undefined } as unknown as Animation;
    };
    try {
      const { container } = renderSlot(docWith());
      await waitFor(() => expect(gates.size).toBe(2));
      await open(STANDIN);
      await waitFor(() => expect(container.querySelector('[data-standin="true"]')).not.toBeNull());
      await open(TARGET);
      await waitFor(() => expect(container.querySelector('[data-testid="standin-under"] img')).not.toBeNull());
      // The page image (not the stand-in under it) fades in, opacity only.
      const page = container.querySelector('[data-testid="comic-page"] img');
      expect(faded.map((f) => f.el)).toContain(page);
      expect(faded.find((f) => f.el === page)?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
      expect(faded.some((f) => f.el.closest('[data-testid="standin-under"]'))).toBe(false);
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      await waitFor(() => expect(container.querySelector('[data-testid="standin-under"]')).toBeNull());
    } finally {
      vi.useRealTimers();
      delete (Element.prototype as unknown as { animate?: unknown }).animate;
    }
  });

  it('reduced motion: the stand-in → page swap is instant (nothing laid under it)', async () => {
    const { container } = renderSlot(docWith(), true);
    await waitFor(() => expect(gates.size).toBe(2));
    await open(STANDIN);
    await open(TARGET);
    await waitFor(() => expect(container.querySelector('[data-standin="true"]')).toBeNull());
    expect(container.querySelector('[data-testid="standin-under"]')).toBeNull();
  });

  it('a page already decoded never fetches a stand-in', async () => {
    const loaded = pageImageCache.ensure(TARGET, `https://cdn.test/${TARGET}`, 'now');
    await open(TARGET);
    expect((await loaded).state).toBe('ready');
    fetched = [];
    renderSlot(docWith());
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetched).toEqual([]);
  });
});

describe('withheld pages (the PG-13 ceiling: their art is never downloaded, at any size)', () => {
  it('a withheld page never fetches a stand-in (or its page)', async () => {
    const doc = docWith(true);
    const item = readerItems(doc)[0];
    expect(item.withheld).toBe(true);
    expect(slotStandIn(item, img)).toBeUndefined();
    // Even an item whose asset still lists variants: withheld wins.
    expect(slotStandIn({ ...item, asset: asset() }, img)).toBeUndefined();
    const { container } = renderSlot(doc);
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetched).toEqual([]);
    expect(container.querySelectorAll('img[src]').length).toBe(0);
  });

  it('a visible page with variants has a signed stand-in, never the source itself', () => {
    const item = readerItems(docWith())[0];
    expect(slotStandIn(item, img)).toEqual({ path: STANDIN, url: `https://cdn.test/${STANDIN}` });
    expect(slotStandIn(item, img, STANDIN)).toBeUndefined();
    expect(slotStandIn(item, { urlFor: () => undefined })).toBeUndefined();
  });
});
