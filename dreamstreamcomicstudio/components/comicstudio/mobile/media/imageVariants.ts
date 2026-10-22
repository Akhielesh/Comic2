// Image variants on the client (mobile.md §8.2; contract §13.4 "Variants"). The server stores 480w and
// 1080w WebP downscales next to each render (AssetRef.variants); grids and filmstrips must never pull
// a 4K original onto a phone. These helpers pick the right width for a surface and build
// `srcSet`/`sizes` from the controller's signed URLs (falling back to the original, as today).

import { variantFor, type AssetRef } from '../../../../shared/comic/doc';
import type { FormFactor } from '../formFactor';

export const VARIANT_THUMB_W = 480;
export const VARIANT_SCREEN_W = 1080;
/** Above this zoom the reader/editor swaps to the original (swap on zoom end). */
export const ORIGINAL_ZOOM = 1.6;

export type ImageUse = 'grid' | 'filmstrip' | 'scrubber' | 'media' | 'chat' | 'reader' | 'editor';

/**
 * CSS width to request for a surface, or undefined for the original:
 *  - grids, filmstrips, the scrubber, the media bin and chat tiles: ≤ 480w;
 *  - reader and editor at fit: ≤ 1080w on phones, the original on tablets/desktop or when zoom > 1.6;
 *  - saveData: 480w everywhere except the reader at fit (1080w).
 */
export const variantWidthFor = (use: ImageUse, ff: Pick<FormFactor, 'widthClass' | 'heightClass' | 'saveData'>, zoom = 1): number | undefined => {
  const thumbnail = use === 'grid' || use === 'filmstrip' || use === 'scrubber' || use === 'media' || use === 'chat';
  if (thumbnail) return VARIANT_THUMB_W;
  if (zoom > ORIGINAL_ZOOM) return ff.saveData ? VARIANT_SCREEN_W : undefined;
  if (ff.saveData) return use === 'reader' ? VARIANT_SCREEN_W : VARIANT_THUMB_W;
  const phone = ff.widthClass === 'compact' || ff.heightClass === 'compact';
  return phone ? VARIANT_SCREEN_W : undefined;
};

/** The variant path for a CSS width × device pixel ratio (cap 2), else the original. */
export const pickVariant = (asset: AssetRef, cssWidth: number, dpr = 1): { path: string; w?: number; h?: number } => variantFor(asset, cssWidth, dpr);

type UrlFor = (asset?: AssetRef | string | null, opts?: { width?: number }) => string | undefined;

export interface ImageSources {
  src?: string;
  srcSet?: string;
  sizes?: string;
}

/**
 * `src` (the variant for the requested width, via the controller's signer) plus a `srcSet` of every
 * signed variant and the original, so the browser can choose by DPR/zoom. Unsigned entries are
 * skipped (they appear once their URL is signed). `sizes` defaults to the requested CSS width.
 */
export const srcSetFor = (asset: AssetRef | null | undefined, urlFor: UrlFor, opts: { width?: number; sizes?: string } = {}): ImageSources => {
  if (!asset || !asset.path) return {};
  const src = opts.width ? urlFor(asset, { width: opts.width }) ?? urlFor(asset) : urlFor(asset);
  const entries: string[] = [];
  const seen = new Set<string>();
  const add = (url: string | undefined, w: number | undefined) => {
    if (!url || !w || !Number.isFinite(w) || w <= 0 || seen.has(url)) return;
    seen.add(url);
    entries.push(`${url} ${Math.round(w)}w`);
  };
  for (const v of [...(asset.variants || [])].sort((a, b) => a.w - b.w)) add(urlFor(v.path), v.w);
  add(urlFor(asset), asset.w);
  const sizes = opts.sizes ?? (opts.width ? `${Math.round(opts.width)}px` : undefined);
  return {
    ...(src ? { src } : {}),
    ...(entries.length > 1 ? { srcSet: entries.join(', ') } : {}),
    ...(entries.length > 1 && sizes ? { sizes } : {})
  };
};

/** Stable data attribute so the QA harness can count heavy images (contract D13). */
export const heavyImageAttr = (cssWidth: number | undefined): Record<string, string> =>
  cssWidth === undefined || cssWidth >= VARIANT_SCREEN_W ? { 'data-heavy-img': '' } : {};
