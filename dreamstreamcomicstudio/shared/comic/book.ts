// The book as a sequence of slots (cover → title → pages → end → back cover) (contract §11.3).
// WAVE-0: working minimal implementation; P1-BOOKMODEL owns it in wave 1.

import { bookOf, isPageStale, type AssetRef, type ComicDoc, type Page } from './doc.js';

export type BookSlotKind = 'cover' | 'title' | 'page' | 'end' | 'back_cover';
export interface BookSlot {
  key: string; // 'cover' | 'title' | page.id | 'end' | 'back_cover'
  kind: BookSlotKind;
  label: string;
  page?: Page;
  asset?: AssetRef;
  plate?: boolean; // drawn by software, free
  drawn: boolean;
  status: 'planned' | 'empty' | 'queued' | 'rendering' | 'ready' | 'stale' | 'failed' | 'custom';
}

/** pageVisualStatus + 'custom' (ready, adopted, no specHash). */
export function clipStatus(doc: ComicDoc, page: Page): BookSlot['status'] {
  const r = page.render;
  switch (r.status) {
    case 'queued':
    case 'rendering':
    case 'failed':
    case 'stale':
      return r.status;
    case 'ready':
      if (isPageStale(doc, page)) return 'stale';
      return !r.specHash && r.origin === 'adopted' ? 'custom' : 'ready';
    default:
      return page.panels.length ? 'planned' : 'empty';
  }
}

/** studio: includes undrawn pages; public: drawn pages + enabled plates only. Order: cover → title → pages by n → end → back cover. */
export function bookSequence(doc: ComicDoc, opts: { audience?: 'studio' | 'public' } = {}): BookSlot[] {
  const pub = opts.audience === 'public';
  const book = bookOf(doc);
  const slots: BookSlot[] = [];
  const cover = doc.cover.render;
  const coverDrawn = cover.status === 'ready' && !!cover.asset;
  if (!pub || coverDrawn) {
    slots.push({
      key: 'cover', kind: 'cover', label: 'Cover', asset: cover.asset, drawn: coverDrawn,
      status: cover.status === 'none' ? 'planned' : cover.status === 'ready' ? 'ready' : cover.status
    });
  }
  if (book.titlePage) slots.push({ key: 'title', kind: 'title', label: 'Title page', plate: true, drawn: true, status: 'ready' });
  for (const page of [...doc.pages].sort((a, b) => a.n - b.n)) {
    const drawn = page.render.status === 'ready' && !!page.render.asset;
    if (pub && !drawn) continue;
    slots.push({ key: page.id, kind: 'page', label: `Page ${page.n}`, page, asset: page.render.asset, drawn, status: clipStatus(doc, page) });
  }
  if (book.endPage) slots.push({ key: 'end', kind: 'end', label: 'The End', plate: true, drawn: true, status: 'ready' });
  if (book.backCover === 'auto') slots.push({ key: 'back_cover', kind: 'back_cover', label: 'Back cover', plate: true, drawn: true, status: 'ready' });
  return slots;
}

/** Spread grouping (slot indexes). The cover and back cover sit alone; firstPageRight puts the first interior slot alone. */
export function bookSpreads(slots: BookSlot[], firstPageRight: boolean): number[][] {
  const spreads: number[][] = [];
  let i = 0;
  if (slots[0]?.kind === 'cover') {
    spreads.push([0]);
    i = 1;
  }
  const lastIsBack = slots[slots.length - 1]?.kind === 'back_cover';
  const end = lastIsBack ? slots.length - 1 : slots.length;
  if (firstPageRight && i < end) {
    spreads.push([i]);
    i += 1;
  }
  for (; i < end; i += 2) spreads.push(i + 1 < end ? [i, i + 1] : [i]);
  if (lastIsBack) spreads.push([slots.length - 1]);
  return spreads;
}

export function reorderIds(ids: string[], fromIndex: number, toIndex: number): string[] {
  if (fromIndex < 0 || fromIndex >= ids.length) return ids.slice();
  const next = ids.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(Math.min(next.length, Math.max(0, toIndex)), 0, moved);
  return next;
}

/** "Neighbors changed": render.continuityPath is no longer the current asset of the page before it (info only, never stale). */
export function continuityHint(doc: ComicDoc, page: Page): boolean {
  const path = page.render.continuityPath;
  if (!path) return false;
  const sorted = [...doc.pages].sort((a, b) => a.n - b.n);
  const idx = sorted.findIndex((p) => p.id === page.id);
  const prev = idx > 0 ? sorted[idx - 1] : undefined;
  return prev?.render.asset?.path !== path;
}
