// The book as a sequence of slots (cover → title → pages → end → back cover) (contract §11.3).
//
// One ordering for every surface that walks the book: the studio reader, the timeline, the chat
// breakdown card, exports and the public reader (`audience: 'public'` keeps only what a reader may
// see: drawn pages and the free software plates that are switched on). Pure and dependency-free.

import {
  archiveOf,
  bookOf,
  coverSpecHash,
  currentVersion,
  getRender,
  isPageStale,
  renderTargetKey,
  type ArchivedVersion,
  type AspectRatio,
  type AssetRef,
  type ComicDoc,
  type Page,
  type RenderState,
  type RenderTarget,
  type RenderVersion
} from './doc.js';
import { aspectFromSize, aspectMatches } from './models.js';
import { isPanelSourceArchive } from './history/apply.js';

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

/** Cover status with the same vocabulary as pages (an older title/style ⇒ stale; adopted art ⇒ custom). */
export function coverStatus(doc: ComicDoc): BookSlot['status'] {
  const r: RenderState = doc.cover.render;
  switch (r.status) {
    case 'queued':
    case 'rendering':
    case 'failed':
    case 'stale':
      return r.status;
    case 'ready':
      if (r.specHash && r.specHash !== coverSpecHash(doc)) return 'stale';
      return !r.specHash && r.origin === 'adopted' ? 'custom' : 'ready';
    default:
      return 'planned';
  }
}

/** The art came back at a different shape than the book's page aspect (unknown sizes never flag). */
export function aspectMismatch(doc: ComicDoc, asset?: AssetRef): { want: AspectRatio; got: AspectRatio } | null {
  if (!asset || !asset.w || !asset.h) return null;
  const want = doc.format.pageAspect;
  return aspectMatches(want, asset.w, asset.h) ? null : { want, got: aspectFromSize(asset.w, asset.h) };
}

/** studio: includes undrawn pages; public: drawn pages + enabled plates only. Order: cover → title → pages by n → end → back cover. */
export function bookSequence(doc: ComicDoc, opts: { audience?: 'studio' | 'public' } = {}): BookSlot[] {
  const pub = opts.audience === 'public';
  const book = bookOf(doc);
  const slots: BookSlot[] = [];
  const cover = doc.cover.render;
  const coverDrawn = cover.status === 'ready' && !!cover.asset;
  if (!pub || coverDrawn) {
    slots.push({ key: 'cover', kind: 'cover', label: 'Cover', asset: cover.asset, drawn: coverDrawn, status: coverStatus(doc) });
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

// ── Versions (v1 = oldest) ───────────────────────────────────────────────────

/** One version of a render target (P2-AMEND, from P1-TIMELINE): the single numbering for the director's
 *  list_versions/use_version (server tools/timeline.ts) and the client timeline (bookModel.ts). */
export interface VersionEntry {
  /** v-number: 1 = oldest (AssetRef.at, then path) — stable across swaps. */
  n: number;
  path: string;
  version: RenderVersion | ArchivedVersion;
  current: boolean;
  archived: boolean;
}

/** Every version of a target — current, history and its archived versions — numbered v1 = oldest.
 *  A path appears once (current wins over history, history over archive). Missing target → [].
 *  A page's frame picture or overlay that a restore archived under the page (history/apply.ts isPanelSourceArchive)
 *  is not a drawing of the page: it is left out before numbering, so the v-numbers count drawings only and nothing
 *  that reads this list (the director's list_versions/use_version, the timeline, the board's version strip) offers
 *  it as the page's art. The media bin and Earlier list it under its page by its own label. */
export function versionList(doc: ComicDoc, target: RenderTarget): VersionEntry[] {
  const r = getRender(doc, target);
  if (!r) return [];
  const key = renderTargetKey(target);
  const seen = new Set<string>();
  const items: Omit<VersionEntry, 'n'>[] = [];
  const push = (v: RenderVersion | ArchivedVersion | undefined, current: boolean, archived: boolean) => {
    if (!v?.path || seen.has(v.path)) return;
    seen.add(v.path);
    items.push({ path: v.path, version: v, current, archived });
  };
  push(currentVersion(r), true, false);
  for (const v of r.history) push(v, false, false);
  for (const a of archiveOf(doc)) if (a.targetKey === key && !isPanelSourceArchive(a)) push(a, false, true);
  items.sort((a, b) => (a.version.at || 0) - (b.version.at || 0) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return items.map((it, i) => ({ ...it, n: i + 1 }));
}
