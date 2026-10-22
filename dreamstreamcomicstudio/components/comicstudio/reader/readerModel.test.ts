import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { clampIndex, defaultReaderMode, keyDelta, readerItems, readerViews, swipeDelta, tapDelta, viewOfItem } from './readerModel';

const withCover = () =>
  makeSampleDoc((d) => {
    d.cover.render = { status: 'ready', history: [], asset: { path: 'u/cover.png', source: 'generated', at: 0, w: 1000, h: 1500 } };
    d.pages.forEach((p, i) => {
      if (!p.render.asset) p.render = { ...p.render, asset: { path: `u/p${i + 1}.png`, source: 'generated', at: 0 } };
    });
  });

describe('reading order', () => {
  it('is the cover, then drawn pages in page order', () => {
    expect(readerItems(makeSampleDoc()).map((i) => i.key)).toEqual(['pg_1', 'pg_5']);
    expect(readerItems(withCover()).map((i) => i.key)).toEqual(['cover', 'pg_1', 'pg_2', 'pg_3', 'pg_4', 'pg_5', 'pg_6']);
  });

  it('groups spreads: the cover alone, then facing pairs', () => {
    const items = readerItems(withCover());
    expect(readerViews(items, 'spread')).toEqual([[0], [1, 2], [3, 4], [5, 6]]);
    expect(readerViews(items, 'page')).toHaveLength(7);
    const noCover = readerItems(makeSampleDoc());
    expect(readerViews(noCover, 'spread')).toEqual([[0, 1]]);
  });

  it('keeps the same page when switching modes', () => {
    const spreads = readerViews(readerItems(withCover()), 'spread');
    expect(viewOfItem(spreads, 4)).toBe(2);
    expect(viewOfItem(spreads, 99)).toBe(0);
  });
});

describe('navigation', () => {
  it('maps keys to steps, mirrored for right-to-left', () => {
    expect(keyDelta('ArrowRight', false)).toBe(1);
    expect(keyDelta('ArrowLeft', false)).toBe(-1);
    expect(keyDelta('ArrowRight', true)).toBe(-1);
    expect(keyDelta('ArrowLeft', true)).toBe(1);
    expect(keyDelta(' ', true)).toBe(1);
    expect(keyDelta('PageUp', false)).toBe(-1);
    expect(keyDelta('a', false)).toBe(0);
  });

  it('maps swipes to steps (left swipe = next in ltr, right swipe = next in rtl)', () => {
    expect(swipeDelta(-120, 10, false)).toBe(1);
    expect(swipeDelta(120, 10, false)).toBe(-1);
    expect(swipeDelta(120, 10, true)).toBe(1);
    expect(swipeDelta(-20, 0, false)).toBe(0);
    expect(swipeDelta(-80, 200, false)).toBe(0);
  });

  it('maps taps on the outer thirds', () => {
    expect(tapDelta(0.1, false)).toBe(-1);
    expect(tapDelta(0.9, false)).toBe(1);
    expect(tapDelta(0.1, true)).toBe(1);
    expect(tapDelta(0.5, false)).toBe(0);
  });

  it('clamps indexes', () => {
    expect(clampIndex(-3, 4)).toBe(0);
    expect(clampIndex(9, 4)).toBe(3);
    expect(clampIndex(2, 0)).toBe(0);
  });

  it('scrolls webtoons by default', () => {
    expect(defaultReaderMode(makeSampleDoc((d) => (d.format.kind = 'webtoon')))).toBe('scroll');
    expect(defaultReaderMode(makeSampleDoc())).toBe('page');
  });
});

describe('v5 helpers: deep links, chapters, withheld pages', () => {
  it('resolves 1-based pages (0 = cover) and falls back to the nearest drawn page, saying so', async () => {
    const { resolvePageN, itemIndexForPageN } = await import('./readerModel');
    const items = readerItems(withCover());
    expect(resolvePageN(items, 0)).toEqual({ index: 0, exact: true, shownN: 0 });
    expect(resolvePageN(items, 3)).toEqual({ index: 3, exact: true, shownN: 3 });
    expect(itemIndexForPageN(items, 3)).toBe(3);
    // Only pages 1 and 5 drawn: page 3 → page 1 (the earlier one first), page 9 → page 5.
    const sparse = readerItems(makeSampleDoc());
    expect(resolvePageN(sparse, 3)).toMatchObject({ exact: false, shownN: 1 });
    expect(resolvePageN(sparse, 9)).toMatchObject({ exact: false, shownN: 5 });
    expect(resolvePageN(sparse, 0)).toMatchObject({ exact: false, shownN: 1 });
    expect(resolvePageN([], 2)).toEqual({ index: 0, exact: false, shownN: 0 });
  });

  it('knows each item’s chapter and lists chapter starts', async () => {
    const { chapterOf, chapterStarts } = await import('./readerModel');
    const doc = withCover();
    doc.pages[1].chapterTitle = 'The Lake';
    doc.pages[3].chapterTitle = '  Home  ';
    const items = readerItems(doc);
    expect(chapterOf(items, 1)).toBeUndefined();
    expect(chapterOf(items, 2)).toEqual({ title: 'The Lake', startIndex: 2 });
    expect(chapterOf(items, 3)).toEqual({ title: 'The Lake', startIndex: 2 });
    expect(chapterOf(items, 6)).toEqual({ title: 'Home', startIndex: 4 });
    expect(chapterStarts(items)).toEqual([
      { index: 2, title: 'The Lake', n: 2 },
      { index: 4, title: 'Home', n: 4 }
    ]);
  });

  it('a blocked image is withheld (never shown or fetched by the reader)', async () => {
    const { isWithheld } = await import('./readerModel');
    const doc = withCover();
    const items = readerItems(doc);
    expect(isWithheld(items[1])).toBe(false);
    items[1] = { ...items[1], asset: { ...items[1].asset, safety: { assessed: 'X', at: 1 } } };
    expect(isWithheld(items[1])).toBe(true);
  });
});
