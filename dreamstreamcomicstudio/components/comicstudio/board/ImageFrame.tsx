// A rendered image (sheet, style board, cover) at its true aspect: object-contain inside
// an aspect box, developing in when the render just landed, with a placeholder and a
// status layer slot.
//
// Wave 2 (P2-BOARD):
//   • variants — `frameSources()` asks the signer for the ≤ 480w WebP in grids and cards (contract
//     §13.4: grids never pull a 4K original onto a phone) and builds `srcSet`/`sizes`; an image that
//     can only be the full-size original carries `data-heavy-img` (the QA perf budget counts them);
//   • safety — `safety` wraps the art in <SafetyVeil>: a blocked image is never an <img> (its URL is
//     never even requested: `frameSources` skips blocked assets), an over-rating one is blurred;
//   • versions — `VersionsButton` opens the shared VersionStack (v1 = oldest, the director's numbers,
//     free optimistic "Use this version" with an undo toast, star, compare) instead of the old strip.

import React, { useMemo, useState } from 'react';
import { Layers } from 'lucide-react';
import { renderTargetKey, variantFor, type AssetRef, type ComicDoc, type RenderState, type RenderTarget } from '../../../shared/comic/doc';
import { versionList } from '../../../shared/comic/book';
import { canServeToOwner, safetyStatusOf, type ContentRating } from '../../../shared/comic/safety';
import { ImageDevelop } from '../../studio/kit/streamMotion';
import type { StudioController } from '../types';
import { LibraryImage } from '../library/LibraryImage';
import { EmptyArt, type EmptyArtVariant } from '../library/procedural/EmptyArt';
import { useComicLibrary } from '../library/useComicLibrary';
import { SafetyVeil } from '../safety/SafetyVeil';
import { VersionStack } from '../timeline/VersionStack';
import { TimelineDialog } from '../timeline/ui';
import { isFreshRender } from './boardModel';
import { OVERLINE, TONE_CHIP_ON_ART } from '../../chat/studioDesign';
import { GhostButton, cx } from './ui';

// ── Variant sources (contract §13.4) ─────────────────────────────────────────

/** Grids, filmstrips, the scrubber and the media bin: never more than the 480w variant. */
export const THUMB_MAX_W = 480;
/** Larger single views (the locked style board): up to the 1080w variant. */
export const VIEW_MAX_W = 1080;

type UrlFor = StudioController['urlFor'];

const dprCap = (): number => {
  const d = typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : 1;
  return Math.min(Math.max(d || 1, 1), 2);
};

/** The CSS width that makes the signer pick exactly the `maxW` variant (it multiplies by min(dpr, 2)). */
export const variantCssWidth = (maxW: number = THUMB_MAX_W, dpr: number = dprCap()): number => Math.max(1, Math.floor(maxW / Math.min(Math.max(dpr || 1, 1), 2)));

export interface FrameSources {
  url?: string;
  srcSet?: string;
  sizes?: string;
  /** The image shown is (or can only be) the full-size original, wider than `maxW`. */
  heavy: boolean;
}

/**
 * Sources for one stored image in a card or grid. Blocked images get NOTHING (no URL is signed for
 * them; the veil shows a neutral tile). `srcSet` lists the picked variant with its real width once it
 * is signed — the same path the signer was already asked for, so this never signs a second file.
 */
export const frameSources = (urlFor: UrlFor, asset: AssetRef | null | undefined, opts: { maxW?: number; sizes?: string } = {}): FrameSources => {
  if (!asset?.path || !canServeToOwner(asset)) return { heavy: false };
  const maxW = opts.maxW ?? THUMB_MAX_W;
  const dpr = dprCap();
  const cssW = variantCssWidth(maxW, dpr);
  const url = urlFor(asset, { width: cssW });
  const pick = variantFor(asset, cssW, dpr);
  const isVariant = pick.path !== asset.path && !!pick.w && pick.w <= maxW;
  const variantUrl = isVariant ? urlFor(pick.path) : undefined;
  const heavy = !isVariant && !(typeof asset.w === 'number' && asset.w > 0 && asset.w <= maxW);
  return {
    ...(url ? { url } : {}),
    ...(variantUrl && pick.w ? { srcSet: `${variantUrl} ${pick.w}w`, sizes: opts.sizes ?? `${cssW}px` } : {}),
    heavy
  };
};

// ── Frame ────────────────────────────────────────────────────────────────────

export interface ImageFrameSafety {
  /** The comic's effective rating (what the art is checked against). */
  rating: ContentRating;
  onRedrawSafer?(): void;
  /** What "Redraw safer" costs, formatted for THIS user (board costFormat `cost.quote`; usage terms when governed). */
  redrawPrice?: string;
  onCheckAgain?(): void;
  onChangeRating?(): void;
}

export interface ImageFrameProps {
  url?: string;
  /** Width / height, or a CSS aspect-ratio string ("3 / 2"). */
  aspect: number | string;
  alt: string;
  render?: RenderState;
  /** Shown when there is no image to display. */
  placeholder?: React.ReactNode;
  overlay?: React.ReactNode;
  className?: string;
  /** Background behind letterboxed images. */
  tone?: 'paper' | 'well';
  onClick?: () => void;
  clickLabel?: string;
  /** Responsive sources (variants, see `frameSources`). */
  srcSet?: string;
  sizes?: string;
  /** The image is a full-size original: marked `data-heavy-img` for the QA image budget. */
  heavy?: boolean;
  /** Content-check veil around the art (contract §13.3). Needs `render.asset` (or `asset`). */
  safety?: ImageFrameSafety;
  /** The stored image when there is no RenderState (the locked style board). */
  asset?: AssetRef;
  /** Small badges pinned to the top-left corner (aspect mismatch, "from older photos"). */
  badges?: React.ReactNode;
}

export const ImageFrame: React.FC<ImageFrameProps> = ({
  url,
  aspect,
  alt,
  render,
  placeholder,
  overlay,
  className,
  tone = 'well',
  onClick,
  clickLabel,
  srcSet,
  sizes,
  heavy,
  safety,
  asset: assetProp,
  badges
}) => {
  const [broken, setBroken] = useState<string | null>(null);
  const asset = assetProp ?? render?.asset;
  const blocked = !!asset && !canServeToOwner(asset);
  const showImage = !!url && broken !== url && !blocked;
  const waiting = !url && !!asset?.path && !blocked;
  // While the overlay is the whole story — a failure's opaque card, or the shimmer and its
  // "Drawing… / Check again" pill — the placeholder under it ("Not drawn yet", the initials + hint)
  // would only be text under text (ui-findings 2026-10-29), so it is not rendered.
  const overlayCovers = !!overlay && (render?.status === 'failed' || render?.status === 'queued' || render?.status === 'rendering');
  const img = showImage ? (
    <img
      src={url}
      srcSet={srcSet}
      sizes={srcSet ? sizes : undefined}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      className="absolute inset-0 h-full w-full object-contain"
      onError={() => setBroken(url || null)}
      {...(heavy ? { 'data-heavy-img': '' } : {})}
    />
  ) : null;
  let body: React.ReactNode = showImage ? (
    <div className="absolute inset-0">
      <ImageDevelop key={asset?.path || url} active={isFreshRender(render)} className="h-full w-full" rounded="rounded-none">
        {img}
      </ImageDevelop>
    </div>
  ) : waiting ? (
    <div className="studio-shimmer absolute inset-0" role="img" aria-label={`Loading ${alt}`} />
  ) : blocked || overlayCovers ? null : (
    <div className="absolute inset-0">{placeholder}</div>
  );
  if (asset && (safety || blocked)) {
    // The veil decides: blocked → a neutral tile (children never render), over-rating → blurred.
    body = (
      <div className="absolute inset-0">
        <SafetyVeil
          asset={asset}
          rating={safety?.rating ?? 'PG-13'}
          onRedrawSafer={safety?.onRedrawSafer}
          redrawPrice={safety?.redrawPrice}
          onCheckAgain={safety?.onCheckAgain}
          onChangeRating={safety?.onChangeRating}
        >
          {body ?? <span className="block h-full w-full" />}
        </SafetyVeil>
      </div>
    );
  }
  const frame = cx(
    'relative w-full overflow-hidden rounded-xl border border-[var(--ds-hairline)]',
    // Paper only behind real art: placeholders keep the themed well (readable in dark mode).
    tone === 'paper' && showImage ? 'bg-white' : 'bg-[var(--ds-well)]',
    className
  );
  const style = { aspectRatio: typeof aspect === 'number' ? String(aspect) : aspect };
  const corner = badges ? (
    <span className="pointer-events-none absolute left-1.5 top-1.5 z-[4] flex max-w-[calc(100%-0.75rem)] flex-wrap items-center gap-1 [&>*]:pointer-events-auto">{badges}</span>
  ) : null;
  // A veiled image shows its own buttons (Show, Redraw safer…): the frame is never a button around them.
  const veilStatus = asset ? safetyStatusOf(asset.safety, safety?.rating ?? 'PG-13') : 'unchecked';
  if (onClick && showImage && veilStatus !== 'over_rating' && veilStatus !== 'blocked') {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={clickLabel || alt}
        className={cx(frame, 'block text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45')}
        style={style}
      >
        {body}
        {corner}
        {overlay}
      </button>
    );
  }
  return (
    <div className={frame} style={style}>
      {body}
      {corner}
      {overlay}
    </div>
  );
};

/**
 * A small corner badge over art ("1:1, not 4:5", "From older photos"). The pill is the flex box; the
 * text sits in its own `min-w-0 truncate` span, because text directly inside a flex container is an
 * anonymous flex item and `text-overflow` never applies to it — a long badge on a narrow card would be
 * clipped mid-word with no ellipsis (layoutLint `flex-truncate`). The vertical padding lives on the
 * text span so its clip box keeps room for descenders at `leading-none` ("From older photos").
 */
export const FrameBadge: React.FC<{ children: React.ReactNode; tone?: 'warn' | 'info'; title?: string }> = ({ children, tone = 'info', title }) => (
  <span
    title={title}
    data-frame-badge=""
    className={cx(
      'inline-flex min-w-0 max-w-full items-center gap-1 rounded-full px-1.5 text-[10px] font-semibold leading-none shadow-sm',
      // Over the art: warn is the opaque warning surface (TONE_CHIP_ON_ART; white on amber was 2.15:1).
      tone === 'warn' ? `border ${TONE_CHIP_ON_ART.warning}` : 'bg-[var(--ds-surface-strong)] text-[var(--ds-ink)]'
    )}
  >
    <span className="min-w-0 truncate py-0.5">{children}</span>
  </span>
);

// ── Empty states ─────────────────────────────────────────────────────────────

/**
 * Empty-state art (assets.md §12): the platform library's illustration for this variant and theme
 * when one is published, over the free procedural line art (never blank, no layout shift).
 */
export const EmptyIllustration: React.FC<{ variant: EmptyArtVariant }> = ({ variant }) => {
  const library = useComicLibrary();
  const theme: 'light' | 'dark' = typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  const asset = library.empty(variant, theme);
  const art = (
    <span className="flex h-full w-full items-center justify-center text-[var(--ds-muted)]">
      <EmptyArt variant={variant} />
    </span>
  );
  return (
    <span className="mx-auto block h-24 w-28" data-empty-illustration={variant}>
      {asset ? <LibraryImage id={asset.id} alt="" sizes="112px" className="h-full w-full object-contain" fallback={art} /> : art}
    </span>
  );
};

// ── Versions ─────────────────────────────────────────────────────────────────

/** How many versions a target has (current, history and archived; the shared v1 = oldest list). */
export const versionCountOf = (doc: ComicDoc, target: RenderTarget): number => versionList(doc, target).length;

/**
 * "3 versions" → the full VersionStack in a dialog (large preview, ←/→, recorded model/cost/QC, free
 * "Use this version" with undo, star, compare; a sheet version that would put pages out of date asks
 * first and lists them). Hidden until there is something to pick from.
 */
export const VersionsButton: React.FC<{
  studio: StudioController;
  target: RenderTarget;
  /** "Page 3", "Maya sheet", "Cover". */
  label: string;
  className?: string;
  /** Show even with a single version (the dialog explains there is nothing else yet). */
  always?: boolean;
}> = ({ studio, target, label, className, always }) => {
  const [open, setOpen] = useState(false);
  const doc = studio.doc;
  const count = useMemo(() => (doc ? versionCountOf(doc, target) : 0), [doc, target]);
  if (!doc || (count < 2 && !always)) return null;
  return (
    <>
      <GhostButton size="xs" className={className} onClick={() => setOpen(true)} aria-label={`${label}: ${count} ${count === 1 ? 'version' : 'versions'} — pick one (free)`}>
        <Layers className="h-3 w-3" aria-hidden /> {count} {count === 1 ? 'version' : 'versions'}
      </GhostButton>
      <TimelineDialog open={open} onClose={() => setOpen(false)} title={`${label} · versions`} wide>
        {open && <VersionStack key={renderTargetKey(target)} studio={studio} target={target} />}
      </TimelineDialog>
    </>
  );
};

/**
 * Version thumbnails (newest first; v-numbers from the shared versionList, v1 = oldest); click
 * restores one. Kept for the page editor. With `doc` + `target` it lists archived versions too and
 * labels them exactly as the director and the VersionStack do.
 */
export const VersionStrip: React.FC<{
  render: RenderState;
  urlFor: (path: string) => string | undefined;
  onRestore: (path: string) => void;
  aspect: number | string;
  label?: string;
  disabled?: boolean;
  className?: string;
  doc?: ComicDoc;
  target?: RenderTarget;
}> = ({ render, urlFor, onRestore, aspect, label = 'Versions', disabled, className, doc, target }) => {
  const versions = useMemo(() => {
    if (doc && target) {
      return versionList(doc, target)
        .map((v) => ({ path: v.path, current: v.current, blocked: !canServeToOwner(v.version), name: v.current ? `v${v.n} (current version)` : `Use v${v.n}` }))
        .reverse();
    }
    // Render-only fallback (no doc): current first, then history, labelled as before.
    const raw = [...(render.asset ? [render.asset] : []), ...render.history.filter((a) => a.path !== render.asset?.path)];
    return raw.map((a, i) => {
      const current = i === 0 && !!render.asset;
      return { path: a.path, current, blocked: !canServeToOwner(a), name: current ? 'Current version' : `Restore version ${i}` };
    });
  }, [doc, target, render]);
  if (versions.length < 2) return null;
  return (
    <div className={className}>
      <p className={cx('mb-1.5', OVERLINE)}>{label}</p>
      <ul className="flex gap-2 overflow-x-auto overscroll-x-contain pb-1">
        {versions.map((v) => {
          const u = v.blocked ? undefined : urlFor(v.path);
          return (
            <li key={v.path} className="shrink-0">
              <button
                type="button"
                disabled={disabled || v.current || v.blocked}
                onClick={() => onRestore(v.path)}
                aria-label={v.name}
                title={v.current ? 'Current version' : v.blocked ? 'Hidden by the content check' : 'Use this version (free)'}
                className={cx(
                  'tap-target relative block w-16 overflow-hidden rounded-lg border bg-[var(--ds-well)] transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45',
                  v.current ? 'border-[var(--ds-accent)] ring-1 ring-[var(--ds-accent)]' : 'border-[var(--ds-hairline)] hover:border-[#D97757]/50 disabled:opacity-50'
                )}
                style={{ aspectRatio: typeof aspect === 'number' ? String(aspect) : aspect }}
              >
                {u ? <img src={u} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-contain" /> : <span className={cx('absolute inset-0', !v.blocked && 'studio-shimmer')} aria-hidden />}
                {v.current && <span className="absolute inset-x-0 bottom-0 bg-[var(--ds-accent)] py-px text-center text-[9px] font-semibold text-white">Current</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
