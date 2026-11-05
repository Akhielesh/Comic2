// The shared loop behind the PDF and the PNG ZIP: render each book slot one at a time (bounded
// memory on phones), report progress, keep going past a slot that fails (it is reported, never
// silently dropped) and stop at once when cancelled.

import type { ComicDoc, Page } from '../../../shared/comic/doc';
import type { PlateKind } from '../timeline/plates';
import { CANCELLED, ExportError, friendlyExportError } from './errors';
import { DEFAULT_PLATE_WIDTH, renderCoverToBlob, renderPageToBlob, renderPlateToBlob, type RasterOptions } from './rasterize';
import type { ExportSlot } from './sequence';

export interface ExportProgress {
  done: number;
  total: number;
  label: string;
}

/** Renderer overrides (tests, or a caller with its own pipeline). */
export interface SlotRenderers {
  renderPage?: (doc: ComicDoc, page: Page, url: string, opts: RasterOptions) => Promise<Blob>;
  /** Legacy override for the cover (drawn as a plain image). */
  renderImage?: (url: string, opts: RasterOptions) => Promise<Blob>;
  renderCover?: (doc: ComicDoc, url: string, opts: RasterOptions) => Promise<Blob>;
  renderPlate?: (doc: ComicDoc, kind: PlateKind, opts: RasterOptions & { artUrl?: string }) => Promise<Blob>;
}

export interface FailedSlot {
  label: string;
  message: string;
}

/** Render one slot of a (localized) doc through the overrides or the real canvas pipeline. */
export function renderSlotWith(doc: ComicDoc, slot: ExportSlot, raster: RasterOptions, r: SlotRenderers & { coverUrl?: string } = {}): Promise<Blob> {
  if (slot.plate) return (r.renderPlate ?? renderPlateToBlob)(doc, slot.plate, { ...raster, artUrl: r.coverUrl });
  if (!slot.url) return Promise.reject(new ExportError(`${slot.label} has no image to export.`));
  if (slot.kind === 'cover') {
    if (r.renderCover) return r.renderCover(doc, slot.url, raster);
    if (r.renderImage) return r.renderImage(slot.url, raster);
    return renderCoverToBlob(doc, slot.url, raster);
  }
  // The slot may come from another language's copy of the book: render THIS doc's page.
  const page = doc.pages.find((p) => p.id === slot.page?.id) ?? slot.page!;
  return (r.renderPage ?? renderPageToBlob)(doc, page, slot.url, raster);
}

/** Plate resolution: the book's page width (the first drawn page's pixel width), within sane bounds. */
export function plateWidthFor(slots: readonly ExportSlot[], longEdge?: number): number {
  const page = slots.find((s) => s.kind === 'page' && s.asset?.w);
  const w = page?.asset?.w ?? DEFAULT_PLATE_WIDTH;
  const clamped = Math.min(2400, Math.max(800, w));
  if (longEdge && longEdge > 0 && page?.asset?.w && page.asset.h) {
    const scale = longEdge / Math.max(page.asset.w, page.asset.h);
    return Math.max(200, Math.round(page.asset.w * scale));
  }
  return clamped;
}

export const isCancelled = (signal?: AbortSignal) => !!signal?.aborted;

/** Throws the cancellation error when the signal fired. */
export const checkCancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new ExportError(CANCELLED);
};

/**
 * Run `work` for every item, reporting progress; a failing item is recorded and the rest continue.
 * Cancellation stops immediately and throws.
 */
export async function forEachReported<T>(
  items: readonly T[],
  labelOf: (item: T) => string,
  work: (item: T, index: number) => Promise<void>,
  opts: { signal?: AbortSignal; onProgress?: (p: ExportProgress) => void } = {}
): Promise<FailedSlot[]> {
  const failed: FailedSlot[] = [];
  const total = items.length;
  for (let i = 0; i < total; i += 1) {
    checkCancelled(opts.signal);
    const item = items[i];
    const label = labelOf(item);
    opts.onProgress?.({ done: i, total, label: `Rendering ${label.charAt(0).toLowerCase()}${label.slice(1)} (${i + 1} of ${total})…` });
    try {
      await work(item, i);
    } catch (err) {
      checkCancelled(opts.signal);
      failed.push({ label, message: friendlyExportError(err) });
    }
  }
  return failed;
}
