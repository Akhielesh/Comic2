// One render target as a thumbnail with honest status (queued / drawing / ready / out of
// date / failed + retry). Shared by the renders, style-choice and cast cards so every
// image in the conversation reads the same way.
//
// Failed tiles are CALM (reliability.md §3, the 2026-10-22 outage): a quiet surface, a small
// icon and Retry inside the frame, and one caption line under it that says when and why
// ("failed 16:52 · rate limited") so a stale failure is recognisable. The provider's exact
// words are one tap away ("Details") — never a red wall of text sliced by a small tile
// (visualqa P1-5: the body is safe-centred, and landscape tiles keep only icon + Retry).
//
// Program 3 PF-2 (perf F2, styles M4):
//   • thumbnails — every tile asks the signer for the ≤ 480w variant through the board's own
//     `frameSources` (contract §13.4) and never shows the full original while that small file is still
//     being signed; the <img> is lazy and decodes off the main thread. Only art stored before variants
//     existed falls back to the original, marked `data-heavy-img` for the QA image budget. A blocked
//     image is never requested: the tile says it was withheld. A small file the signer gave up on
//     (`isUnsignable`) reads "Preview unavailable" instead of loading forever.
//   • progress — a drawing tile says how long it has been drawing against the model's usual time
//     ("12s · usually ~20s") and which model draws it, with an indeterminate bar until it reads "taking
//     longer than usual" — at the board's own threshold (board/ui SLOW_FACTOR × the usual time), so the chat and the
//     board never disagree about one render. Far past it (isStuck) the tile stops: "Still drawing", a
//     still dot, no shimmer, and a free "Check again" (the open studio's refresh, on a tap only). One shared
//     one-second clock serves every drawing tile; it never fetches, skips hidden tabs and stops when
//     nothing draws. Only the page's first drawing tile carries the live ping and the sweeping bar (one live
//     pulse per view, declutter C9); the others keep a still dot. No prices here (governed users never see
//     dollars).

import React, { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, CircleAlert, RotateCcw } from 'lucide-react';
import {
  findCharacter,
  findPage,
  findPlace,
  isPageStale,
  variantFor,
  type AssetRef,
  type ComicDoc,
  type RenderState,
  type RenderTarget
} from '../../../../shared/comic/doc';
import type { ImageJobKind } from '../../../../shared/comic/models';
import type { SpendAction } from '../../../../shared/comic/ops';
import { canServeToOwner } from '../../../../shared/comic/safety';
import { ImageDevelop } from '../../../studio/kit/streamMotion';
import { LiveDot } from '../../../ds/LiveDot';
import { useInViewPause } from '../../../ds/useInViewPause';
import { FOCUS_RING, TONE_CHIP_ON_ART, TONE_TEXT } from '../../../chat/studioDesign';
import { THUMB_MAX_W, frameSources, variantCssWidth, type FrameSources } from '../../board/ImageFrame';
import { formatElapsed, jobModel } from '../../board/boardModel';
import { isStuck, SLOW_FACTOR, studioRefresh } from '../../board/ui';
import type { StudioController } from '../../types';
import { cx } from '../ui';
import { failureCaption, failureFacts, failureReason, formatFailedAt } from './failure';

/** Renders that finished this recently "develop" in; older ones show statically. */
const DEVELOP_WINDOW_MS = 15_000;

export interface TargetMeta {
  label: string;
  /** CSS aspect ratio "w / h". */
  aspect: string;
  /** Spend action that redraws this target. */
  retry?: SpendAction;
  stale: boolean;
  /** Friendly name of the model a (re)draw of this target runs on (the comic's locked model, else tier + override). */
  model?: string;
  /** That model's usual seconds per image (the "usually ~20s" hint while drawing). */
  typicalSec?: number;
}

const cssAspect = (ratio: string) => ratio.replace(':', ' / ');

/** The model a job of this kind draws on right now, as the tile names it (no price: governed users read tiles too). */
export const tileModel = (doc: ComicDoc, kind: ImageJobKind): Pick<TargetMeta, 'model' | 'typicalSec'> => {
  const spec = jobModel(doc, kind);
  return { model: spec.nickname || undefined, typicalSec: spec.latencySec > 0 ? spec.latencySec : undefined };
};

export const describeTarget = (doc: ComicDoc, target: RenderTarget): TargetMeta | null => {
  switch (target.kind) {
    case 'page': {
      const page = findPage(doc, target.id);
      if (!page) return null;
      return {
        label: `Page ${page.n}`,
        aspect: cssAspect(doc.format.pageAspect),
        retry: { type: 'render_pages', pageIds: [page.id], force: true },
        stale: page.render.status === 'stale' || isPageStale(doc, page),
        ...tileModel(doc, 'page')
      };
    }
    case 'cover':
      return { label: 'Cover', aspect: cssAspect(doc.format.pageAspect), retry: { type: 'render_cover' }, stale: false, ...tileModel(doc, 'cover') };
    case 'sheet': {
      const c = findCharacter(doc, target.id);
      if (!c) return null;
      return { label: c.name, aspect: '3 / 2', retry: { type: 'render_sheets', characterIds: [c.id], force: true }, stale: false, ...tileModel(doc, 'sheet') };
    }
    case 'place': {
      const p = findPlace(doc, target.id);
      if (!p) return null;
      return { label: p.name, aspect: '3 / 2', retry: { type: 'render_sheets', characterIds: [p.id], force: true }, stale: false, ...tileModel(doc, 'place') };
    }
    case 'style_option': {
      const o = doc.style.options.find((x) => x.id === target.id);
      if (!o) return null;
      return {
        label: o.name,
        aspect: '4 / 5',
        retry: { type: 'render_style_options', directions: [{ name: o.name, spec: o.spec }] },
        stale: false,
        ...tileModel(doc, 'style_option')
      };
    }
    default:
      return null;
  }
};

// ── Thumbnail sources (perf F2) ───────────────────────────────────────────────

/** `sizes` for a chat tile: a third to a half of a phone, a small grid cell on wider screens. */
export const TILE_SIZES = '(max-width: 640px) 50vw, 240px';

const tileDpr = (): number => {
  const d = typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : 1;
  return Math.min(Math.max(d || 1, 1), 2);
};

/** The stored variant a tile asks for (the same pick `frameSources` makes), when it is a real ≤ 480w file. */
const thumbVariantOf = (asset: AssetRef): { path: string; w?: number } | undefined => {
  const dpr = tileDpr();
  const pick = variantFor(asset, variantCssWidth(THUMB_MAX_W, dpr), dpr);
  return pick.path !== asset.path && !!pick.w && pick.w <= THUMB_MAX_W ? pick : undefined;
};

/** A tile's sources; `unavailable` = its small file exists but the signer gave up on it (no URL will come). */
export type TileSources = FrameSources & { unavailable?: boolean };

/** Whether the signer gave up on a stored path for good (useStudio `isUnsignable`: never stored, broken, out of attempts). */
export type IsUnsignable = (path: string) => boolean;

/**
 * The controller's `isUnsignable` (StudioController has it since PF-2 #7). Still read by name, so a hand-rolled
 * controller without it leaves a tile whose small file can't be signed on its loading shimmer instead of throwing.
 */
export const unsignableOf = (studio: object | null | undefined): IsUnsignable | undefined => {
  const f = studio ? (studio as { isUnsignable?: unknown }).isUnsignable : undefined;
  return typeof f === 'function' ? (path: string) => !!(f as IsUnsignable).call(studio, path) : undefined;
};

/**
 * Sources for one stored image in a chat card: the ≤ 480w variant through the board's `frameSources` (the
 * same signer request, so no extra signing round trip), lazy-loadable with `srcSet`/`sizes`. A tile NEVER
 * shows the full original when a small variant exists: while that variant is still being signed the
 * controller would hand back the original (it never fetches both), so the tile waits for the small file —
 * and when the signer has given up on that file (`isUnsignable`), the tile is `unavailable` (a calm, still
 * "Preview unavailable") rather than waiting forever or pulling the original into a 64 px tile.
 * Art stored before variants existed has only its original: that one is returned, marked `heavy`.
 * Blocked images get nothing (no URL is ever signed for them).
 */
export const tileSources = (
  urlFor: StudioController['urlFor'],
  asset: AssetRef | null | undefined,
  sizes: string = TILE_SIZES,
  isUnsignable?: IsUnsignable
): TileSources => {
  if (!asset?.path || !canServeToOwner(asset)) return { heavy: false };
  const thumb = thumbVariantOf(asset);
  // First: a broken small file keeps its last (dead) URL in the signer's table, so its srcSet would still be
  // built, and the browser never falls back from a failed srcset candidate to `src`. Nothing is signed for it.
  if (thumb && isUnsignable?.(thumb.path)) return { heavy: false, unavailable: true };
  const s = frameSources(urlFor, asset, { maxW: THUMB_MAX_W, sizes });
  if (s.srcSet || s.heavy || !thumb) return s;
  return { heavy: false };
};

// ── Drawing progress (styles M4) ──────────────────────────────────────────────

/** Tick of the shared tile clock. */
export const TILE_CLOCK_MS = 1000;

/**
 * "Taking longer than usual" starts past SLOW_FACTOR times the model's usual time: board/ui.tsx's one constant,
 * beside STUCK_FACTOR, which the board's RenderOverlay reads too, so one render never reads "slow" in the chat while
 * the board still reads "(usually ~20s)". `usual` is the model's typical time, so half of normal renders run past
 * 1×: calling those slow would cry wolf (PF-2 #6). Re-exported for the cards and their tests.
 */
export { SLOW_FACTOR };

const tileClock = (() => {
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  const tick = () => {
    // A background tab draws nothing: keep the time it shows and catch up on the first visible tick.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    listeners.forEach((fn) => fn());
  };
  return {
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      if (!timer) timer = setInterval(tick, TILE_CLOCK_MS);
      return () => {
        listeners.delete(fn);
        if (!listeners.size && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    /** The longest-running subscriber (a Set keeps insertion order): the one tile that carries the live pulse. */
    lead(): (() => void) | undefined {
      for (const fn of listeners) return fn;
      return undefined;
    }
  };
})();

/**
 * The shared clock plus whether THIS tile leads it. Exactly one ticking tile on the page leads (the first one
 * that started drawing); when it finishes, the next one takes over on the next tick. Never touches the network.
 */
const useTileClockLead = (active: boolean): { now: number; lead: boolean } => {
  const [now, setNow] = useState(() => Date.now());
  const [lead, setLead] = useState(false);
  useEffect(() => {
    if (!active) return;
    // Each tick re-reads who leads, so when the leading tile finishes the next one takes the pulse.
    const fn = () => {
      setNow(Date.now());
      setLead(tileClock.lead() === fn);
    };
    const off = tileClock.subscribe(fn);
    fn();
    return off;
  }, [active]);
  return { now, lead: active && lead };
};

/**
 * Wall clock for drawing tiles: ONE interval for every tile on the page (never one per tile), running only
 * while at least one tile is `active`. It only re-renders the tiles that read it and never touches the network.
 */
export const useTileClock = (active: boolean): number => useTileClockLead(active).now;

export interface TileProgress {
  /** "12s"; absent when the start time is unknown or the render is far past its usual time. */
  elapsed?: string;
  /** "usually ~20s", then "taking longer than usual" past SLOW_FACTOR × that, and "much longer than usual" when stuck. */
  hint?: string;
  /** Show the indeterminate bar (until "taking longer than usual"). */
  bar: boolean;
  /** The clock should keep ticking. */
  ticking: boolean;
  /** Far past the usual time (board `isStuck`): the clock stops and the tile offers "Check again". */
  stuck?: boolean;
}

/** What a busy tile says about time. Pure: `since` is when the status began (render.updatedAt). */
export const tileProgress = (status: RenderState['status'], since: number | undefined, now: number, typicalSec?: number): TileProgress => {
  if (status !== 'rendering') return { bar: false, ticking: false };
  const typical = typicalSec && typicalSec > 0 ? typicalSec : undefined;
  if (!since) return { hint: typical ? `usually ~${typical}s` : undefined, bar: true, ticking: false };
  const elapsedMs = Math.max(0, now - since);
  // A clock that reads "378d" helps nobody: far past the usual time it stops and offers a free "Check again".
  if (isStuck(elapsedMs, typical)) return { hint: 'much longer than usual', bar: false, ticking: false, stuck: true };
  const slow = !!typical && elapsedMs > typical * 1000 * SLOW_FACTOR;
  return {
    elapsed: formatElapsed(elapsedMs),
    hint: slow ? 'taking longer than usual' : typical ? `usually ~${typical}s` : undefined,
    bar: !slow,
    ticking: true
  };
};

/** The thin indeterminate bar along a drawing tile's bottom edge; its sweep holds still while off screen. */
const DrawingBar: React.FC = () => {
  const ref = useRef<HTMLSpanElement>(null);
  useInViewPause(ref);
  return (
    <span
      ref={ref}
      aria-hidden
      data-progress-bar=""
      className="ds-progress-indeterminate absolute inset-x-0 bottom-0 h-0.5 text-[var(--ds-accent)]"
    />
  );
};

export const isFreshRender = (render?: RenderState, now = Date.now()) =>
  !!render?.updatedAt && now - render.updatedAt < DEVELOP_WINDOW_MS;

/** "4 / 5" or "4:5" → 0.8 (w/h); NaN-safe (unknown ⇒ portrait). */
export const aspectValue = (aspect: string): number => {
  const [w, h] = aspect.split(/[/:]/).map((s) => Number(s.trim()));
  return w > 0 && h > 0 ? w / h : 0.75;
};

export interface RenderThumbProps {
  render: RenderState | undefined;
  label: string;
  aspect: string;
  url?: string;
  stale?: boolean;
  onOpen?: () => void;
  onRetry?: () => void;
  retryBusy?: boolean;
  /** Retry can't run right now (e.g. another batch is drawing): disabled, no spinner. */
  retryDisabled?: boolean;
  selected?: boolean;
  className?: string;
  /** Extra overlay (e.g. a lock badge). */
  badge?: React.ReactNode;
  /** Icon + Retry only inside a failed frame (small tiles). Default: landscape tiles. */
  compact?: boolean;
  /** Clock for the failure caption and the drawing time (tests); without it a shared clock ticks while drawing. */
  now?: number;
  /** Responsive sources for `url` (see `tileSources`: the ≤ 480w variant). */
  srcSet?: string;
  sizes?: string;
  /** `url` is a full-size original (art stored before variants): marked `data-heavy-img` for the QA image budget. */
  heavy?: boolean;
  /** Friendly model name shown while drawing ("Drawing · 12s · usually ~20s", then the model). */
  model?: string;
  /** The model's usual seconds per image. */
  typicalSec?: number;
  /**
   * The live ping and sweeping bar while drawing. By default only the page's first drawing tile carries them
   * (one live pulse per view); `false` keeps this tile still, `true` forces them.
   */
  live?: boolean;
  /** "Check again" on a tile stuck far past its usual time. Default: the open studio's refresh (board/ui `studioRefresh`). */
  onRecheck?: () => void;
  /** The stored image exists but its small file can't be signed (see `tileSources`): a still "Preview unavailable". */
  unavailable?: boolean;
}

/** The image (or its status placeholder) for one render target. */
export const RenderThumb: React.FC<RenderThumbProps> = ({
  render,
  label,
  aspect,
  url,
  stale,
  onOpen,
  onRetry,
  retryBusy,
  retryDisabled,
  selected,
  className,
  badge,
  compact,
  now,
  srcSet,
  sizes,
  heavy,
  model,
  typicalSec,
  live,
  onRecheck,
  unavailable
}) => {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const status = render?.status || 'none';
  // A blocked image is never requested or shown (the signer refuses it too); the tile says so instead of loading forever.
  const blocked = !!render?.asset?.path && !canServeToOwner(render.asset);
  const hasImage = !blocked && !!render?.asset?.path && (status === 'ready' || status === 'stale' || ((status === 'queued' || status === 'rendering') && !!url));
  const busy = status === 'queued' || status === 'rendering';
  const failed = status === 'failed';
  // Drawing time: one shared clock while this tile draws (stopped when it is done or far past its usual time).
  const since = render?.updatedAt;
  const ticking = now === undefined && status === 'rendering' && !!since;
  const clock = useTileClockLead(ticking && tileProgress(status, since, Date.now(), typicalSec).ticking);
  const progress = busy ? tileProgress(status, since, now ?? clock.now, typicalSec) : null;
  // Far past its usual time the tile holds still and says so; a tap re-checks (free, never on a timer).
  const stuck = !!progress?.stuck;
  const recheck = stuck ? onRecheck ?? studioRefresh() : undefined;
  // One live pulse per view: the ping and the sweep belong to the page's first drawing tile only.
  const pulsing = status === 'rendering' && !stuck && (live ?? clock.lead);
  // The small file can't be signed (never stored or broken): say so, still, instead of a shimmer that never ends.
  const noPreview = !!unavailable && !blocked && !!render?.asset?.path && !url && (status === 'ready' || status === 'stale');
  const iconOnly = compact ?? aspectValue(aspect) >= 1;
  const frame = cx(
    'relative w-full overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)]',
    selected && 'ring-2 ring-[var(--ds-accent)] ring-offset-1 ring-offset-[var(--ds-surface)]'
  );

  const facts = failed ? failureFacts(render) : {};
  const failedAt = facts.at;
  const caption = failed ? failureCaption(facts.error, failedAt, now) : '';
  const reason = failed ? failureReason(facts.error) : '';
  const hasDetails = !!(facts.error || facts.facts);
  const spokenFailure = failed
    ? `${label}: ${caption}.${facts.error ? ` ${facts.error}` : ''}`
    : undefined;

  let body: React.ReactNode;
  if (failed) {
    body = (
      <div
        title={facts.error || caption}
        data-failed=""
        className="flex h-full w-full flex-col items-center justify-[safe_center] gap-1 bg-[var(--ds-surface-soft)] p-1.5 text-center"
      >
        <span className="sr-only">{spokenFailure}</span>
        <CircleAlert className={cx('h-4 w-4 shrink-0', TONE_TEXT.warning)} aria-hidden />
        {!iconOnly && (
          <span aria-hidden className="line-clamp-2 text-[10.5px] font-medium leading-snug text-[var(--ds-muted)] first-letter:uppercase">
            {reason}
          </span>
        )}
        {onRetry && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRetry();
            }}
            disabled={retryBusy || retryDisabled}
            aria-label={`Retry ${label}`}
            className="tap-target inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 disabled:opacity-50"
          >
            <RotateCcw className={cx('h-3 w-3', retryBusy && 'animate-spin motion-reduce:animate-none')} aria-hidden /> Retry
          </button>
        )}
      </div>
    );
  } else if (hasImage && url) {
    // Keyed by the stored file, as the board's ImageFrame is: the reveal gate looks for its <img> when it mounts, so
    // a redraw landing in this same tile (the old picture stays up while it draws) mounts a fresh gate and develops,
    // while a re-signed url for the same file (path unchanged) keeps the picture on screen (MO-1 #4, risk h).
    body = (
      <ImageDevelop key={render?.asset?.path || url.split(/[?#]/)[0]} active={isFreshRender(render)} className="h-full w-full" rounded="rounded-none">
        <img
          src={url}
          srcSet={srcSet}
          sizes={srcSet ? sizes ?? TILE_SIZES : undefined}
          alt={label}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="h-full w-full object-cover"
          {...(heavy ? { 'data-heavy-img': '' } : {})}
        />
      </ImageDevelop>
    );
  } else if (blocked && !busy) {
    body = (
      <div role="img" aria-label={`${label}: image withheld`} data-safety="blocked" className="grid h-full w-full place-items-center bg-[var(--ds-well-strong)] p-1 text-center text-[10.5px] leading-snug text-[var(--ds-muted)]">
        Withheld
      </div>
    );
  } else if (noPreview) {
    body = (
      <div role="img" aria-label={`${label}: preview unavailable here`} data-preview="unavailable" className="grid h-full w-full place-items-center bg-[var(--ds-well-strong)] p-1 text-center text-[10.5px] leading-snug text-[var(--ds-muted)]">
        Preview unavailable
      </div>
    );
  } else if (stuck) {
    // Still: the UI itself says this render is stuck, so nothing on the tile pretends it is moving.
    body = <div data-stuck="" className="h-full w-full bg-[var(--ds-well-strong)]" aria-hidden />;
  } else if (busy || (hasImage && !url)) {
    body = <div className="studio-shimmer h-full w-full" aria-hidden />;
  } else {
    body = <div className="grid h-full w-full place-items-center p-1 text-center text-[10.5px] text-[var(--ds-muted)]">Not drawn yet</div>;
  }

  const content = (
    <>
      <div className={frame} style={{ aspectRatio: aspect }}>
        {body}
        {busy && (
          <span className="absolute inset-x-1.5 bottom-1.5 flex items-center justify-center gap-1 rounded-full bg-[var(--ds-surface-strong)] px-2 py-0.5 text-[10px] font-medium text-[var(--ds-ink)] shadow-sm">
            {/* The live ping holds still off screen and under reduced motion (ds-live-dot). Only the page's first
                drawing tile pings; the others, a queued tile and a stuck one keep a still dot. */}
            {pulsing ? (
              <LiveDot className="h-1.5 w-1.5 shrink-0 text-[var(--ds-accent)]" />
            ) : (
              <span data-still-dot="" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ds-accent)]" aria-hidden />
            )}
            <span className="min-w-0 truncate">{status === 'queued' ? 'Queued' : stuck ? 'Still drawing' : 'Drawing…'}</span>
          </span>
        )}
        {progress?.bar && pulsing && <DrawingBar />}
        {/* One top-left row, so "Out of date" and a quality warning never sit on top of each other. */}
        {!busy && ((stale && hasImage) || (status === 'ready' && render?.error)) && (
          <span className="absolute left-1.5 top-1.5 flex max-w-[calc(100%-0.75rem)] flex-wrap items-center gap-1">
            {stale && hasImage && (
              <span className={`min-w-0 truncate rounded-full border px-1.5 py-0.5 text-[9.5px] font-semibold ${TONE_CHIP_ON_ART.warning}`}>Out of date</span>
            )}
            {status === 'ready' && render?.error && (
              <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${TONE_CHIP_ON_ART.warning}`} title={render.error} role="img" aria-label={render.error}>
                <AlertTriangle className="h-3 w-3" aria-hidden />
              </span>
            )}
          </span>
        )}
        {badge}
      </div>
      <span className="mt-1 block truncate text-[11px] font-medium text-[var(--ds-ink)]" title={label}>
        {label}
      </span>
      {busy && (progress?.elapsed || progress?.hint || model) && (
        // Wraps instead of truncating: three style tiles side by side are ~64 px wide on a phone.
        <span data-tile-progress="" className="block min-w-0 text-[10.5px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]">
          {(progress?.elapsed || progress?.hint) && <span className="block tabular-nums">{[progress?.elapsed, progress?.hint].filter(Boolean).join(' · ')}</span>}
          {model && <span className="block">{model}</span>}
        </span>
      )}
      {stuck && recheck && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            recheck();
          }}
          aria-label={`Check again: ${label}`}
          // A real 44 px box on touch, like the board's own "Check again".
          className={`tap-target mt-0.5 inline-flex items-center rounded-full text-[10.5px] font-semibold text-[var(--ds-accent)] hover:underline coarse:min-h-[44px] coarse:px-2 ${FOCUS_RING}`}
        >
          Check again
        </button>
      )}
      {failed && (
        // Wraps instead of truncating: in a 90 px style tile "failed 16:52" must stay readable
        // (the time is what makes a stale failure recognisable); "Details" flows after it.
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-1 text-[10.5px] leading-snug text-[var(--ds-muted)]">
          <span className="min-w-0 [overflow-wrap:anywhere]" title={caption} aria-hidden>
            {caption}
          </span>
          {hasDetails && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setDetailsOpen((v) => !v);
              }}
              aria-expanded={detailsOpen}
              aria-controls={detailsId}
              className="tap-target shrink-0 font-medium text-[var(--ds-ink)] underline decoration-dotted underline-offset-2 hover:text-[var(--ds-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40"
            >
              {detailsOpen ? 'Hide' : 'Details'}
            </button>
          )}
        </span>
      )}
      {failed && detailsOpen && hasDetails && (
        <span
          id={detailsId}
          className="mt-1 block whitespace-pre-wrap rounded-lg bg-[var(--ds-well)] px-2 py-1.5 text-[10.5px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]"
        >
          {facts.error}
          {facts.facts && <span className="mt-0.5 block">{facts.facts}</span>}
          {formatFailedAt(failedAt, now) && (
            <span className="mt-0.5 block">
              Failed at {formatFailedAt(failedAt, now)}
              {facts.attempts && facts.attempts > 1 ? ` after ${facts.attempts} tries` : ''}.
            </span>
          )}
        </span>
      )}
    </>
  );

  // The whole tile opens the image — except while it holds its own control (Check again): no button in a button.
  return onOpen && ((hasImage && url) || noPreview) && !(stuck && recheck) ? (
    <button type="button" onClick={onOpen} className={cx('block w-full rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40', className)} aria-label={`Open ${label}`}>
      {content}
    </button>
  ) : (
    <div className={cx('w-full min-w-0', className)}>{content}</div>
  );
};
