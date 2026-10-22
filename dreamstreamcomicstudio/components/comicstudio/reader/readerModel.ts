// Reading order and navigation for the comic reader (pure).
//
// The reader shows what is actually drawn: the cover (when it has art), then every page
// with an image, in page order. Navigation is reading-direction aware — in a right-to-left
// comic (manga) "next" is ← and a rightward swipe, and a two-page spread puts the earlier
// page on the right.

import type { AssetRef, ComicDoc, Page } from '../../../shared/comic/doc';

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
