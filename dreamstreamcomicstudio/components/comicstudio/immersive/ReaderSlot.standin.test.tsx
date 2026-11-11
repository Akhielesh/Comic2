// Never blank (reader.md §8.1, V2 N6; PROGRAM3 B15): a slot shows the first decoded of its page → the original
// (cached) → its stand-in (the ~480 px variant), so a cold turn lands on a picture, not paper; the real image
// then cross-fades in over the stand-in. A withheld page never fetches anything — no page, no stand-in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { fakeUrlFor, makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import type { AssetRef, ComicDoc } from '../../../shared/comic/doc';
import { readerItems } from '../reader/readerModel';
import { pageImageCache } from './pageImageCache';
import { paperTone, SlotContentView, slotStandIn, useStandInSwap, type SlotImage } from './ReaderSlot';
import type { Palette } from './ambient';

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
afterEach(async () => {
  // Unmount first: a mounted slot would ask the cleared cache again (with the real fetch).
  cleanup();
  // Let every download a test left hanging finish, so the shared cache's download slots are free again.
  await act(async () => {
    for (const g of gates.values()) g();
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
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
const renderSlot = (doc: ComicDoc, reduced = false, extra: { tone?: string; index?: number; prio?: 'now' | 'next'; img?: SlotImage } = {}) => {
  const items = readerItems(doc);
  return render(
    <div style={{ position: 'relative', width: 560, height: 840 }}>
      <SlotContentView doc={doc} content={{ kind: 'item', index: extra.index ?? items.findIndex((i) => i.kind === 'page') }} items={items} width={560} height={840} contentAspect={1696 / 2528} img={extra.img ?? img} prio={extra.prio ?? 'now'} paper={false} letteringAriaHidden reduced={reduced} swapMs={120} tone={extra.tone} />
    </div>
  );
};

/** An old page (before 2026-11-05): no variants at all, so no stand-in exists. */
const oldDoc = (): ComicDoc =>
  makeSampleDoc((d) => {
    d.cover.render = { status: 'ready', history: [], asset: { path: 'u/cover.png', source: 'generated', at: 0, w: 1696, h: 2528 } };
    d.pages.forEach((p, i) => {
      p.render = { status: 'ready', history: [], asset: { path: `u/p${i + 1}.png`, source: 'generated', at: 0, w: 1696, h: 2528 } };
    });
  });
const WHITE = /^(white|#fff(fff)?|rgb\(255, 255, 255\))$/i;

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

  it('a fast link: a page not on screen yet never fetches its stand-in (its page comes first); the page on screen still does', async () => {
    const fast = { ...img, fast: true };
    const { unmount } = renderSlot(docWith(), false, { prio: 'next', img: fast });
    await waitFor(() => expect(fetched).toContain(`https://cdn.test/${TARGET}`));
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetched).not.toContain(`https://cdn.test/${STANDIN}`);
    unmount();
    renderSlot(docWith(), false, { prio: 'now', img: fast });
    await waitFor(() => expect(fetched).toContain(`https://cdn.test/${STANDIN}`));
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

describe('a page with no picture yet stands on toned paper, never white (reader.md §8.1; old pages have no stand-in)', () => {
  it('an old page whose download hangs: no <img>, and the page is the paper (not the white page box)', async () => {
    const { container } = renderSlot(oldDoc());
    await waitFor(() => expect(fetched).toEqual([`https://cdn.test/u/p1.png`])); // the page itself; no stand-in exists
    expect(container.querySelectorAll('img')).toHaveLength(0);
    const page = container.querySelector<HTMLElement>('[data-testid="comic-page"]')!;
    expect(page).not.toBeNull();
    expect(page.style.background).not.toBe('');
    expect(page.style.background).not.toMatch(WHITE);
    expect(page.style.background).toContain('var(--ds-reader-paper-back)');
  });

  it('the reader’s tone (a neighbouring page’s palette) washes the paper', async () => {
    const pal: Palette = { dominant: { r: 180, g: 60, b: 40 }, accent: { r: 40, g: 80, b: 160 }, lum: 0.4, neutral: false };
    const tone = paperTone(pal);
    expect(tone).toBe('linear-gradient(rgba(180, 60, 40, 0.14), rgba(180, 60, 40, 0.14)), var(--ds-reader-paper-back)');
    // A grey page (or none known yet) leaves the plain paper.
    expect(paperTone({ ...pal, neutral: true })).toBe('var(--ds-reader-paper-back)');
    expect(paperTone(null)).toBe('var(--ds-reader-paper-back)');
    const { container } = renderSlot(oldDoc(), false, { tone });
    await waitFor(() => expect(fetched.length).toBe(1));
    const page = container.querySelector<HTMLElement>('[data-testid="comic-page"]')!;
    expect(page.style.background).toContain('rgba(180, 60, 40, 0.14)');
    expect(page.style.background).toContain('var(--ds-reader-paper-back)');
  });

  it('once the page has decoded, it is the page again (the toned paper is only the stand-in)', async () => {
    const { container } = renderSlot(oldDoc(), false, { tone: paperTone({ dominant: { r: 1, g: 2, b: 3 }, accent: { r: 1, g: 2, b: 3 }, lum: 0.5, neutral: false }) });
    await waitFor(() => expect(fetched.length).toBe(1));
    await open('u/p1.png');
    await waitFor(() => expect(container.querySelector('[data-testid="comic-page"] img')?.getAttribute('src')).toMatch(/^blob:/));
    expect(container.querySelector<HTMLElement>('[data-testid="comic-page"]')!.style.background).toBe('');
  });

  it('the cover with no picture yet is paper too (it was a white box)', async () => {
    const doc = oldDoc();
    const items = readerItems(doc);
    const cover = items.findIndex((i) => i.kind === 'cover');
    expect(cover).toBeGreaterThanOrEqual(0);
    const { container } = renderSlot(doc, false, { index: cover });
    await waitFor(() => expect(fetched).toEqual([`https://cdn.test/u/cover.png`]));
    const box = container.querySelector<HTMLElement>('[data-testid="reader-cover"]')!;
    expect(box.className).not.toMatch(/\bbg-white\b/);
    expect(box.className).toContain('bg-[var(--ds-reader-paper-back)]');
    expect(box.style.background).toContain('var(--ds-reader-paper-back)');
  });

  it('the stand-in underlay is paper, not white', async () => {
    const { container } = renderSlot(docWith());
    await waitFor(() => expect(gates.size).toBe(2));
    await open(STANDIN);
    await waitFor(() => expect(container.querySelector('[data-standin="true"]')).not.toBeNull());
    await open(TARGET);
    const under = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('[data-testid="standin-under"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(under.className).not.toMatch(/\bbg-white\b/);
    expect(under.className).toContain('bg-[var(--ds-reader-paper-back)]');
  });
});

describe('useStandInSwap: the underlay always leaves', () => {
  it('a source that changes again inside the fade window (stand-in → cached fit variant → original) never strands the underlay', () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(({ src, standIn }: { src?: string; standIn: boolean }) => useStandInSwap(src, standIn, false, 120), {
        initialProps: { src: 'blob:standin', standIn: true }
      });
      expect(result.current).toBeUndefined();
      rerender({ src: 'blob:fit', standIn: false });
      expect(result.current).toBe('blob:standin');
      // A guided close-up asks for the original 50 ms later, inside the 160 ms window.
      act(() => {
        vi.advanceTimersByTime(50);
      });
      rerender({ src: 'blob:original', standIn: false });
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(result.current).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reduced motion: never an underlay', () => {
    const { result, rerender } = renderHook(({ src, standIn }: { src?: string; standIn: boolean }) => useStandInSwap(src, standIn, true, 120), {
      initialProps: { src: 'blob:standin', standIn: true }
    });
    rerender({ src: 'blob:page', standIn: false });
    expect(result.current).toBeUndefined();
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
