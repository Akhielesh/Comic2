// One page of the book as a persistent layer (reader.md §3.3): the page (or cover, inside cover, End
// card) letterboxed on paper in a fixed-size box, plus the overlays the turn engine drives — the curl
// highlight band (used when this page is a turning back face) and a shade (board lighting, slide
// recede). The element itself never remounts during a turn; the engine only writes its styles.

import React, { forwardRef, memo } from 'react';
import type { AssetRef, ComicDoc } from '../../../shared/comic/doc';
import { PLATFORM_CEILING } from '../../../shared/comic/safety';
import { ComicPageView } from '../board/ComicPageView';
import { CoverTitleLayer } from '../lettering/CoverTitleLayer';
import { SafetyVeil } from '../safety/SafetyVeil';
import { isWithheld, type ReaderItem } from '../reader/readerModel';
import { BAND_REACH } from './flipGeometry';
import { letterbox, type SlotContent, type SlotSide } from './readerLayout';
import { pickVariant, standInVariant, useCachedImage, type CachePriority } from './pageImageCache';

export const CURL_GRADIENT =
  'linear-gradient(to right, rgba(0,0,0,0.20) 0%, rgba(0,0,0,0.10) 3%, rgba(255,255,255,0.16) 7%, rgba(0,0,0,0.06) 14%, rgba(0,0,0,0) 32%)';
export const CAST_GRADIENT = 'linear-gradient(to right, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.22) 35%, rgba(0,0,0,0) 100%)';
const GUTTER_LEFT = 'linear-gradient(to left, rgba(0,0,0,0.24) 0, rgba(0,0,0,0.08) 2.5%, rgba(255,255,255,0.10) 3.2%, rgba(0,0,0,0) 7%)';
const GUTTER_RIGHT = 'linear-gradient(to right, rgba(0,0,0,0.24) 0, rgba(0,0,0,0.08) 2.5%, rgba(255,255,255,0.10) 3.2%, rgba(0,0,0,0) 7%)';
/** A single page still shows where it is bound: a softer shade on the spine edge. */
const BINDING_LEFT = 'linear-gradient(to right, rgba(0,0,0,0.14) 0, rgba(0,0,0,0.04) 2%, rgba(255,255,255,0.06) 2.6%, rgba(0,0,0,0) 5%)';
const BINDING_RIGHT = 'linear-gradient(to left, rgba(0,0,0,0.14) 0, rgba(0,0,0,0.04) 2%, rgba(255,255,255,0.06) 2.6%, rgba(0,0,0,0) 5%)';

/** Spine shading for a slot: spreads shade both inner edges; single pages their bound edge. */
export const gutterFor = (side: SlotSide, spread: boolean, rtl: boolean): string | undefined =>
  spread ? (side === 'left' ? GUTTER_LEFT : side === 'right' ? GUTTER_RIGHT : undefined) : rtl ? BINDING_RIGHT : BINDING_LEFT;
/** Inside-cover paper: a faint woven pattern on warm cream (pure CSS). */
export const ENDPAPER_BG =
  'radial-gradient(circle at 25% 25%, rgba(120,92,60,0.07) 1.2px, transparent 1.6px) 0 0 / 14px 14px, radial-gradient(circle at 75% 75%, rgba(120,92,60,0.05) 1.2px, transparent 1.6px) 0 0 / 14px 14px, var(--ds-reader-endpaper)';

export interface SlotImage {
  urlFor(asset?: AssetRef | string | null, opts?: { width?: number }): string | undefined;
  dpr: number;
  saveData: boolean;
  /** Use the full image (guided zoom > 1.6). */
  original: boolean;
}

/**
 * Which stored image a page drawn `cssWidth` wide uses (cache path + URL): the variant pick, or the
 * original when the variant isn't signed for this viewer. Withheld (blocked) pages have none — they are
 * never fetched. Shared by the slots and the reader's preloader, so a preload is the very file the page
 * will show (never the original and then a variant: no double download on phones).
 */
export const slotImageSource = (item: ReaderItem, cssWidth: number, img: SlotImage): { path: string; url?: string } | undefined => {
  if (isWithheld(item)) return undefined;
  const pick = pickVariant(item.asset, cssWidth, { dpr: img.dpr, saveData: img.saveData, original: img.original });
  const variantUrl = pick.path !== item.asset.path ? img.urlFor(pick.path) : undefined;
  return variantUrl ? { path: pick.path, url: variantUrl } : { path: item.asset.path, url: img.urlFor(item.asset) };
};

/**
 * A page's low-resolution stand-in (reader.md §8.1, V2 N6): its ~480 px variant, signed for this viewer —
 * never for a withheld item (its art is never downloaded, at any size), and never the source itself.
 */
export const slotStandIn = (item: ReaderItem, img: Pick<SlotImage, 'urlFor'>, sourcePath?: string): { path: string; url: string } | undefined => {
  if (isWithheld(item)) return undefined;
  const v = standInVariant(item.asset);
  if (!v || v.path === sourcePath) return undefined;
  const url = img.urlFor(v.path);
  return url ? { path: v.path, url } : undefined;
};

/**
 * The page image for an item, through the shared cache (variant-aware, decoded before it shows). A slot
 * shows the first decoded of (reader.md §8.1): the source it wants → the original, if already cached →
 * the fit-width variant, if already cached (guided zoom asks for the original; never blank meanwhile) →
 * the stand-in, which is fetched only while none of those is ready. `standIn` says the stand-in is what
 * shows (the page cross-fades when the real image lands).
 */
export const useSlotImage = (item: ReaderItem | undefined, cssWidth: number, img: SlotImage, prio: CachePriority) => {
  const withheld = !!item && isWithheld(item);
  const source = item && !withheld ? slotImageSource(item, cssWidth, img) : undefined;
  const path = source?.path;
  const url = source?.url;
  const cached = useCachedImage(path, url, prio);
  // While a sharper variant loads, keep showing the one already decoded.
  const fallback = useCachedImage(item && !withheld && path !== item.asset.path ? item.asset.path : undefined, undefined, prio);
  // Guided zoom wants the original: the fit-width variant it showed a moment ago stays up meanwhile.
  const fit = item && !withheld && img.original ? slotImageSource(item, cssWidth, { ...img, original: false }) : undefined;
  const fitImage = useCachedImage(fit && fit.path !== path && fit.path !== item?.asset.path ? fit.path : undefined, undefined, prio);
  const sharp = cached.src || fallback.src || fitImage.src;
  const standIn = item && !withheld && !sharp ? slotStandIn(item, img, path) : undefined;
  const low = useCachedImage(standIn?.path, standIn?.url, prio);
  const showStandIn = !sharp && !!low.src;
  return {
    src: sharp || low.src,
    standIn: showStandIn,
    state: cached.state,
    palette: cached.palette ?? fallback.palette ?? fitImage.palette ?? low.palette,
    expired: cached.expired,
    retrying: cached.retrying,
    withheld
  };
};

/**
 * The stand-in → page swap (reader.md §8.1): when the real image replaces a stand-in, the stand-in stays
 * underneath for `ms` while the page fades in over it (opacity only). Returns the stand-in URL to lay under
 * the page during the swap (undefined otherwise). Reduced motion: an instant swap.
 */
export const useStandInSwap = (src: string | undefined, standIn: boolean, reduced: boolean, ms: number): string | undefined => {
  const last = React.useRef<{ src?: string; standIn: boolean }>({ standIn: false });
  const [under, setUnder] = React.useState<string | undefined>(undefined);
  // A layout effect: the swap is caught before the frame paints, so the page never flashes in un-faded.
  React.useLayoutEffect(() => {
    const prev = last.current;
    last.current = { src, standIn };
    if (reduced || !prev.standIn || standIn || !src || !prev.src || prev.src === src) return;
    setUnder(prev.src);
    const t = setTimeout(() => setUnder(undefined), ms + 40);
    return () => clearTimeout(t);
  }, [src, standIn, reduced, ms]);
  return under;
};

/** Fade the page's own image inside `box` in over `ms` (WAAPI: opacity only, nothing per frame from React). */
const fadeInImage = (box: HTMLElement | null, ms: number) => {
  const el = Array.from(box?.querySelectorAll('img') ?? []).find((i) => !i.closest('[data-testid="standin-under"]'));
  if (el && typeof el.animate === 'function') el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: 'linear' });
};

/** What a page that failed to load says — only what is really happening next. */
export const loadErrorText = (expired: boolean, canRelink: boolean, retrying: boolean): string =>
  expired && canRelink
    ? 'This page’s link expired — getting a fresh one…'
    : retrying
      ? 'Couldn’t load this page — trying again…'
      : 'Couldn’t load this page. Check your connection — it tries again when you reopen the reader.';

export interface SlotContentProps {
  doc: ComicDoc;
  content: SlotContent;
  items: ReaderItem[];
  width: number;
  height: number;
  contentAspect: number;
  img: SlotImage;
  prio: CachePriority;
  paper: boolean;
  letteringAriaHidden: boolean;
  visibleLineIds?: ReadonlySet<string>;
  onImageError?: () => void;
  onExpired?: () => void;
  dedication?: string;
  endCard?: React.ReactNode;
  /** Reduced motion: the stand-in → page swap is instant. */
  reduced?: boolean;
  /** The stand-in → page cross-fade (ms; the reader's --ds-reader-standin-swap). */
  swapMs?: number;
}

const PageContent: React.FC<SlotContentProps & { item: ReaderItem }> = ({ doc, item, width, height, contentAspect, img, prio, paper, letteringAriaHidden, visibleLineIds, onImageError, onExpired, reduced, swapMs = 120 }) => {
  const box = letterbox(width, height, contentAspect);
  const image = useSlotImage(item, box.w, img, prio);
  React.useEffect(() => {
    if (image.expired) onExpired?.();
  }, [image.expired, onExpired]);
  // Stand-in → page: the stand-in lies under the page while the real image fades in over it.
  const under = useStandInSwap(image.src, image.standIn, !!reduced, swapMs);
  const artRef = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    if (under) fadeInImage(artRef.current, swapMs);
  }, [under, swapMs]);
  const veil = (child: React.ReactNode) => (
    <SafetyVeil asset={item.asset} rating={PLATFORM_CEILING}>
      {child}
    </SafetyVeil>
  );
  return (
    <div
      ref={artRef}
      className="absolute overflow-hidden"
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      data-standin={image.standIn ? 'true' : undefined}
    >
      {under && (
        // The stand-in the page is fading in over (the page's own background is see-through meanwhile).
        <div aria-hidden className="absolute inset-0 bg-white" data-testid="standin-under">
          <img src={under} alt="" draggable={false} className="absolute inset-0 h-full w-full select-none object-contain" />
        </div>
      )}
      {image.withheld
        ? veil(null)
        : item.page
          ? veil(
              <ComicPageView
                doc={doc}
                page={item.page}
                imageUrl={image.src}
                loading="eager"
                develop={false}
                letteringAriaHidden={letteringAriaHidden}
                visibleLineIds={visibleLineIds}
                paper={paper}
                onImageError={onImageError}
                style={under ? { width: '100%', height: '100%', background: 'transparent' } : { width: '100%', height: '100%' }}
              />
            )
          : veil(
              <div className={under ? 'relative h-full w-full' : 'relative h-full w-full bg-white'}>
                {image.src ? (
                  <img src={image.src} alt={`Cover of ${doc.brief.title}`} draggable={false} className="absolute inset-0 h-full w-full select-none object-contain" onError={onImageError} />
                ) : (
                  <div className="studio-shimmer absolute inset-0" role="img" aria-label="Loading cover" />
                )}
                {paper && image.src && <div className="ds-reader-paper" aria-hidden />}
                <CoverTitleLayer doc={doc} aspect={contentAspect} />
              </div>
            )}
      {prio === 'now' && image.state === 'error' && !image.withheld && !image.src && (
        <p role="status" className="absolute inset-x-3 bottom-3 rounded-lg bg-black/60 px-2 py-1 text-center text-[11px] text-white [overflow-wrap:anywhere]">
          {loadErrorText(!!image.expired, !!onExpired, !!image.retrying)}
        </p>
      )}
    </div>
  );
};

/** What a slot shows (memoized: it only re-renders when its own inputs change). */
export const SlotContentView = memo<SlotContentProps>((props) => {
  const { content, items, dedication, endCard } = props;
  if (content.kind === 'item') {
    const item = items[content.index];
    return item ? <PageContent {...props} item={item} /> : null;
  }
  if (content.kind === 'endpaper') {
    return (
      <div className="absolute inset-0" style={{ background: ENDPAPER_BG }} data-testid={`endpaper-${content.side}`}>
        {content.side === 'front' && dedication && (
          <div className="absolute inset-x-[12%] top-[38%] text-center">
            <p className="font-serif text-[clamp(12px,2.2vmin,20px)] italic leading-relaxed text-[var(--ds-reader-ink-soft)] [overflow-wrap:anywhere]">{dedication}</p>
          </div>
        )}
      </div>
    );
  }
  if (content.kind === 'end') return <div className="absolute inset-0 bg-[var(--ds-reader-paper-back)]">{endCard}</div>;
  return null;
});
SlotContentView.displayName = 'SlotContentView';

export interface ReaderSlotProps extends SlotContentProps {
  slotKey: string;
  x: number;
  y: number;
  side: SlotSide;
  z: number;
  visible: boolean;
  /** Spine shading (gutterFor). */
  gutter?: string;
  interactive: boolean;
  ariaLabel: string;
}

export interface SlotRefs {
  root: HTMLDivElement | null;
  curl: HTMLDivElement | null;
  shade: HTMLDivElement | null;
}

/** The persistent slot element. Imperative styles (transform, clip-path, opacity) belong to the engine. */
export const ReaderSlot = memo(
  forwardRef<SlotRefs, ReaderSlotProps>(function ReaderSlot(props, ref) {
    const { slotKey, x, y, width, height, side, z, visible, gutter, interactive, ariaLabel, content } = props;
    const refs = React.useRef<SlotRefs>({ root: null, curl: null, shade: null });
    React.useImperativeHandle(ref, () => refs.current, []);
    const isPage = content.kind === 'item';
    return (
      <div
        ref={(el) => {
          refs.current.root = el;
        }}
        data-slot={slotKey}
        data-side={side}
        data-visible={visible ? 'true' : 'false'}
        role={visible && isPage ? 'group' : undefined}
        aria-roledescription={visible && isPage ? 'page' : undefined}
        aria-label={visible && isPage ? ariaLabel : undefined}
        aria-hidden={visible ? undefined : true}
        inert={visible ? undefined : true}
        className="absolute overflow-hidden"
        style={{
          left: x,
          top: y,
          width,
          height,
          zIndex: z,
          visibility: visible ? 'visible' : 'hidden',
          pointerEvents: interactive && visible ? 'auto' : 'none',
          contain: 'layout paint',
          boxShadow: content.kind === 'blank' ? undefined : 'inset 0 0 0 0.5px rgba(0,0,0,0.14)'
        }}
      >
        <SlotContentView {...props} />
        {gutter && content.kind !== 'blank' && content.kind !== 'end' && <div aria-hidden className="pointer-events-none absolute inset-0 z-[3]" style={{ background: gutter }} />}
        <div
          ref={(el) => {
            refs.current.curl = el;
          }}
          aria-hidden
          className="pointer-events-none absolute left-0 top-0 z-[4] opacity-0"
          style={{ width, height: BAND_REACH, transformOrigin: '0 0', background: CURL_GRADIENT }}
        />
        <div
          ref={(el) => {
            refs.current.shade = el;
          }}
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[5] bg-black opacity-0"
        />
      </div>
    );
  })
);
