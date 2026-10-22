// Reading order and navigation for the comic reader (pure).
//
// The reader shows what is actually drawn: the cover (when it has art), then every page
// with an image, in page order. Navigation is reading-direction aware — in a right-to-left
// comic (manga) "next" is ← and a rightward swipe, and a two-page spread puts the earlier
// page on the right.

import type { AssetRef, ComicDoc, Page } from '../../../shared/comic/doc';
import { canServeToOwner } from '../../../shared/comic/safety';

export type ReaderMode = 'scroll' | 'page' | 'spread';

export interface ReaderItem {
  key: string;
  kind: 'cover' | 'page';
  label: string;
  asset: AssetRef;
  page?: Page;
}

export const readerItems = (doc: ComicDoc): ReaderItem[] => {
  const items: ReaderItem[] = [];
  if (doc.cover.render.asset?.path) items.push({ key: 'cover', kind: 'cover', label: 'Cover', asset: doc.cover.render.asset });
  [...doc.pages]
    .sort((a, b) => a.n - b.n)
    .forEach((page) => {
      if (page.render.asset?.path) items.push({ key: page.id, kind: 'page', label: `Page ${page.n}`, asset: page.render.asset, page });
    });
  return items;
};

/**
 * Item indexes per view. Single-page modes: one item per view. Spreads: the cover alone
 * (it is a right-hand page in print), then facing pairs.
 */
export const readerViews = (items: ReaderItem[], mode: ReaderMode): number[][] => {
  if (mode !== 'spread') return items.map((_, i) => [i]);
  const views: number[][] = [];
  let i = 0;
  if (items[0]?.kind === 'cover') {
    views.push([0]);
    i = 1;
  }
  for (; i < items.length; i += 2) views.push(i + 1 < items.length ? [i, i + 1] : [i]);
  return views;
};

/** The view that contains an item (when switching modes, stay on the same page). */
export const viewOfItem = (views: number[][], itemIndex: number): number => {
  const v = views.findIndex((group) => group.includes(itemIndex));
  return v >= 0 ? v : 0;
};

export const clampIndex = (index: number, count: number): number => (count <= 0 ? 0 : Math.min(count - 1, Math.max(0, index)));

/** Keyboard → step (+1 = forward in reading order). */
export const keyDelta = (key: string, rtl: boolean): -1 | 0 | 1 => {
  switch (key) {
    case 'ArrowRight':
      return rtl ? -1 : 1;
    case 'ArrowLeft':
      return rtl ? 1 : -1;
    case 'PageDown':
    case ' ':
    case 'Spacebar':
      return 1;
    case 'PageUp':
      return -1;
    default:
      return 0;
  }
};

/** Horizontal swipe → step. A leftward swipe pulls the next page in (ltr); mirrored for rtl. */
export const swipeDelta = (dx: number, dy: number, rtl: boolean, threshold = 48): -1 | 0 | 1 => {
  if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy) * 1.2) return 0;
  const forward = rtl ? dx > 0 : dx < 0;
  return forward ? 1 : -1;
};

/** Which side a tap landed on → step (outer thirds turn pages; the middle does nothing). */
export const tapDelta = (fraction: number, rtl: boolean): -1 | 0 | 1 => {
  if (fraction < 0.3) return rtl ? 1 : -1;
  if (fraction > 0.7) return rtl ? -1 : 1;
  return 0;
};

/** Sensible starting mode: webtoons scroll; everything else reads a page at a time. */
export const defaultReaderMode = (doc: ComicDoc): ReaderMode => (doc.format.kind === 'webtoon' ? 'scroll' : 'page');

/** Resolve a 1-based page number (0 = cover) to an item. An undrawn page falls back to the nearest
 *  drawn one (earlier first), and says so via `exact: false` and the page number actually shown. */
export const resolvePageN = (items: ReaderItem[], n: number): { index: number; exact: boolean; shownN: number } => {
  if (!items.length) return { index: 0, exact: false, shownN: 0 };
  const want = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  if (want === 0) {
    const cover = items.findIndex((i) => i.kind === 'cover');
    return cover >= 0 ? { index: cover, exact: true, shownN: 0 } : { index: 0, exact: false, shownN: items[0].page?.n ?? 0 };
  }
  const exact = items.findIndex((i) => i.page?.n === want);
  if (exact >= 0) return { index: exact, exact: true, shownN: want };
  let best = -1;
  let bestScore = Infinity;
  items.forEach((item, idx) => {
    if (!item.page) return;
    const d = item.page.n - want;
    // Prefer the page just before (you never skip story), then the one just after.
    const score = d < 0 ? -d * 2 - 1 : d * 2;
    if (score < bestScore) {
      bestScore = score;
      best = idx;
    }
  });
  if (best < 0) return { index: 0, exact: false, shownN: 0 };
  return { index: best, exact: false, shownN: items[best].page!.n };
};

/** The item index for a 1-based page number (0 = cover), nearest drawn page when it isn't drawn. */
export const itemIndexForPageN = (items: ReaderItem[], n: number): number => resolvePageN(items, n).index;

/** The chapter an item belongs to: the latest chapter start at or before it. */
export const chapterOf = (items: ReaderItem[], index: number): { title: string; startIndex: number } | undefined => {
  for (let i = Math.min(index, items.length - 1); i >= 0; i -= 1) {
    const title = items[i]?.page?.chapterTitle;
    if (typeof title === 'string' && title.trim()) return { title: title.trim(), startIndex: i };
  }
  return undefined;
};

/** Chapter starts in reading order (scrubber marks, End-card list). */
export const chapterStarts = (items: ReaderItem[]): { index: number; title: string; n: number }[] =>
  items.flatMap((item, index) => {
    const title = item.page?.chapterTitle;
    return typeof title === 'string' && title.trim() && item.page ? [{ index, title: title.trim(), n: item.page.n }] : [];
  });

/** A blocked image is never shown or fetched: the reader draws a neutral "withheld" tile instead. */
export const isWithheld = (item: ReaderItem): boolean => !canServeToOwner(item.asset);
