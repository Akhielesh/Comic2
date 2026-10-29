// The reading experience for a v4 comic: cover, then every drawn page, lettered.
//
// Three ways to read — Scroll (vertical, webtoon-friendly), Page (one at a time) and
// Spread (facing pages on wide screens). Page modes turn with ←/→ (reading-direction
// aware), Space/PageUp/PageDown, Home/End, swipes and taps on the outer thirds; the next
// page is preloaded (after the current one has loaded) so turns never flash blank. Full screen on demand: native where
// the browser has it, else the reader fills the viewport (services/fullscreen.ts) — the button always does something.
// Inside the public reader that viewport mode has a history entry of its own, so Back leaves it before the comic.

import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, Columns2, Maximize2, Minimize2, Rows3, Square } from 'lucide-react';
import type { AssetRef, ComicDoc } from '../../../shared/comic/doc';
import { ComicPageView } from '../board/ComicPageView';
import { aspectNumber, pageAspectOf } from '../board/balloonGeometry';
import { EmptyHint, IconButton, Segmented, cx, useElementSize } from '../board/ui';
import {
  FullscreenFallbackHistoryContext,
  IOS_FULLSCREEN_NOTE,
  enterFullscreen,
  exitFullscreen,
  isFullscreenActive,
  markIosFullscreenNoteSeen,
  onFullscreenChange,
  shouldShowIosFullscreenNote
} from '../../../services/fullscreen';
import {
  clampIndex,
  defaultReaderMode,
  keyDelta,
  readerItems,
  readerViews,
  swipeDelta,
  tapDelta,
  viewOfItem,
  type ReaderItem,
  type ReaderMode
} from './readerModel';

export interface ComicReaderViewProps {
  doc: ComicDoc;
  urlFor: (asset?: AssetRef | string | null) => string | undefined;
  initialMode?: ReaderMode;
  /** Extra toolbar controls (e.g. export buttons). */
  toolbarExtra?: React.ReactNode;
  className?: string;
  onImageError?: () => void;
  /** Focus the reader on mount so the keyboard works immediately (default true). */
  autoFocus?: boolean;
}

const MODE_KEY = 'comicstudio.reader.mode';

/** Toolbar targets: 32 px for a mouse, 44 px under a finger (coarse pointer). */
const TOUCH_TARGET = 'coarse:h-11 coarse:w-11';

/** Pinch-zoomed in (the browser's own page zoom): drags pan the page, swipes and taps never turn it. */
const isViewportZoomed = (): boolean => typeof window !== 'undefined' && (window.visualViewport?.scale ?? 1) > 1.01;

const useViewportZoomed = (): boolean => {
  const [zoomed, setZoomed] = useState(isViewportZoomed);
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    const on = () => setZoomed(isViewportZoomed());
    on();
    vv.addEventListener('resize', on);
    return () => vv.removeEventListener('resize', on);
  }, []);
  return zoomed;
};

const readStoredMode = (): ReaderMode | null => {
  try {
    const v = window.localStorage.getItem(MODE_KEY);
    return v === 'scroll' || v === 'page' || v === 'spread' ? v : null;
  } catch {
    return null;
  }
};

const storeMode = (mode: ReaderMode) => {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* private mode — not remembered */
  }
};

const itemAspect = (doc: ComicDoc, item: ReaderItem, loaded?: Record<string, number>): number => {
  const known = loaded?.[item.asset.path];
  if (known && known > 0) return known;
  if (item.page) return pageAspectOf(doc, item.page);
  const a = item.asset;
  return a.w && a.h ? a.w / a.h : aspectNumber(doc.format.pageAspect);
};

/** The cover (its title is lettered in the art) or a page with its balloons. */
const ReaderPage: React.FC<{
  doc: ComicDoc;
  item: ReaderItem;
  urlFor: ComicReaderViewProps['urlFor'];
  width?: number;
  eager?: boolean;
  onImageError?: () => void;
  onAspect?: (path: string, aspect: number) => void;
  /** Known width/height of the art (cover box). */
  aspect?: number;
}> = ({ doc, item, urlFor, width, eager, onImageError, onAspect, aspect }) => {
  const url = urlFor(item.asset);
  // Before the stage is measured, a sensible readable width (never a collapsed 0).
  const style: React.CSSProperties = width ? { width: `${width}px` } : { width: '100%', maxWidth: 640 };
  if (item.page) {
    return (
      <div style={style} className="shrink-0 shadow-[0_6px_30px_rgba(0,0,0,0.22)]" data-testid="reader-page" data-key={item.key}>
        <ComicPageView
          doc={doc}
          page={item.page}
          imageUrl={url}
          loading={eager ? 'eager' : 'lazy'}
          develop={false}
          onImageError={onImageError}
          onAspectChange={(a) => onAspect?.(item.asset.path, a)}
        />
      </div>
    );
  }
  return (
    <div style={style} className="shrink-0 shadow-[0_6px_30px_rgba(0,0,0,0.22)]" data-testid="reader-page" data-key={item.key}>
      <div className="relative w-full overflow-hidden bg-white" style={{ aspectRatio: String(aspect ?? itemAspect(doc, item)) }}>
        {url ? (
          <img
            src={url}
            alt={`Cover of ${doc.brief.title}`}
            loading={eager ? 'eager' : 'lazy'}
            className="absolute inset-0 h-full w-full object-contain"
            onError={onImageError}
            onLoad={(e) => {
              const el = e.currentTarget;
              if (el.naturalWidth > 0 && el.naturalHeight > 0) onAspect?.(item.asset.path, el.naturalWidth / el.naturalHeight);
            }}
          />
        ) : (
          <div className="studio-shimmer absolute inset-0" aria-hidden />
        )}
      </div>
    </div>
  );
};

export const ComicReaderView: React.FC<ComicReaderViewProps> = ({ doc, urlFor, initialMode, toolbarExtra, className, onImageError, autoFocus = true }) => {
  const items = useMemo(() => readerItems(doc), [doc]);
  const rtl = doc.format.readingDirection === 'rtl';
  const [chosenMode, setModeState] = useState<ReaderMode>(() => initialMode || readStoredMode() || defaultReaderMode(doc));
  const [rootSizeRef, rootSize] = useElementSize<HTMLDivElement>();
  // Facing pages need room: on a narrow screen a spread reads as single pages.
  const narrow = rootSize.width > 0 && rootSize.width < 560;
  const mode: ReaderMode = chosenMode === 'spread' && narrow ? 'page' : chosenMode;
  const views = useMemo(() => readerViews(items, mode), [items, mode]);
  const [view, setView] = useState(0);
  const current = clampIndex(view, views.length);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stageRef, stage] = useElementSize<HTMLDivElement>();
  // Full screen: native state only from fullscreenchange; the viewport mode is the fallback when the browser has no
  // API (iPhone) or refuses. Either counts as full screen for the button.
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [viewportFullscreen, setViewportFullscreen] = useState(false);
  const [showIosNote, setShowIosNote] = useState(false);
  const fullscreen = nativeFullscreen || viewportFullscreen;
  // The viewport mode's history entry (only where a reader provides one: the public reader, not the studio tab).
  const fallbackHistory = useContext(FullscreenFallbackHistoryContext);
  const fallbackHistoryRef = useRef(fallbackHistory);
  fallbackHistoryRef.current = fallbackHistory;
  const viewportRef = useRef(false);
  viewportRef.current = viewportFullscreen;
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);
  // Safe gestures: every pointer on the stage is tracked; once a second one touches down (a pinch) the swipe
  // candidate is gone and nothing turns until every finger is up, whichever lifts first.
  const pointers = useRef(new Set<number>());
  const multiPointer = useRef(false);
  // touch-action can only change between gestures (a change mid-gesture is ignored), so it follows the zoom level:
  // at 1x vertical pans and pinch-zoom go to the browser and horizontal swipes to us; zoomed in, the browser pans
  // in every direction.
  const zoomed = useViewportZoomed();
  // Real width/height of each image once loaded (models snap to their nearest aspect).
  const [loadedAspects, setLoadedAspects] = useState<Record<string, number>>({});
  const onAspect = useCallback((path: string, a: number) => {
    setLoadedAspects((prev) => (Math.abs((prev[path] || 0) - a) < 1e-4 ? prev : { ...prev, [path]: a }));
  }, []);

  const setMode = (next: ReaderMode) => {
    if (next === chosenMode) return;
    const firstItem = views[current]?.[0] ?? 0;
    const effective = next === 'spread' && narrow ? 'page' : next;
    setModeState(next);
    storeMode(next);
    setView(viewOfItem(readerViews(items, effective), firstItem));
  };

  const go = useCallback(
    (delta: number) => {
      if (!delta) return;
      if (mode === 'scroll') {
        const container = scrollRef.current;
        if (!container) return;
        const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="reader-page"]'));
        const top = container.scrollTop;
        const idx = nodes.findIndex((n) => n.offsetTop >= top - 4);
        const target = nodes[clampIndex((idx < 0 ? 0 : idx) + delta, nodes.length)];
        target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        return;
      }
      setView((v) => clampIndex(clampIndex(v, views.length) + delta, views.length));
    },
    [mode, views.length]
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.key === 'Escape' && viewportFullscreen) {
      e.preventDefault();
      leaveViewportFullscreen();
      return;
    }
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      if (mode === 'scroll') {
        const c = scrollRef.current;
        if (c) c.scrollTop = e.key === 'Home' ? 0 : c.scrollHeight;
      } else setView(e.key === 'Home' ? 0 : views.length - 1);
      return;
    }
    // In scroll mode Space/PageUp/PageDown keep their native scrolling.
    if (mode === 'scroll' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const delta = keyDelta(e.key, rtl);
    if (!delta) return;
    e.preventDefault();
    go(delta);
  };

  // Keyboard works right away.
  useEffect(() => {
    if (autoFocus) rootRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  useEffect(() => onFullscreenChange(() => setNativeFullscreen(isFullscreenActive(rootRef.current))), []);

  // The viewport mode locks the page behind the reader (no rubber-band scrolling of the site underneath).
  useEffect(() => {
    if (!viewportFullscreen) return;
    const html = document.documentElement;
    const body = document.body;
    const prev = [html.style.overflow, body.style.overflow];
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    return () => {
      html.style.overflow = prev[0];
      body.style.overflow = prev[1];
    };
  }, [viewportFullscreen]);

  const enterViewportFullscreen = useCallback(() => {
    setViewportFullscreen(true);
    // Back pops this entry: the viewport mode ends and the comic stays open.
    fallbackHistoryRef.current?.push(() => setViewportFullscreen(false));
    if (shouldShowIosFullscreenNote()) {
      markIosFullscreenNoteSeen();
      setShowIosNote(true);
    }
  }, []);

  // A control (the Exit button, Esc) leaves the viewport mode and pops its entry.
  const leaveViewportFullscreen = useCallback(() => {
    setViewportFullscreen(false);
    fallbackHistoryRef.current?.pop();
  }, []);

  // Unmounted while in the viewport mode (the reader swapped views): its entry goes too, so Back is never dead. A
  // reader closing on its own has already unwound it (pop is then a no-op).
  useEffect(
    () => () => {
      if (viewportRef.current) fallbackHistoryRef.current?.pop();
    },
    []
  );

  // Called synchronously from the tap (full screen is only granted inside the user gesture); never throws.
  const toggleFullscreen = () => {
    if (viewportFullscreen) {
      leaveViewportFullscreen();
      return;
    }
    if (isFullscreenActive(rootRef.current)) {
      exitFullscreen();
      return;
    }
    enterFullscreen(rootRef.current, { onFallback: enterViewportFullscreen });
  };

  // Preload only the next view, and only once the current one has loaded: on a slow phone connection, parallel
  // full-size downloads made the page on screen arrive last. (Same URLs as the <img> on screen, so the browser shares
  // the request; a failed current page still lets the next one load.)
  useEffect(() => {
    if (mode === 'scroll' || typeof Image === 'undefined') return;
    const urlsOf = (v: number) => (views[v] || []).map((i) => urlFor(items[i]?.asset)).filter((u): u is string => !!u);
    const next = urlsOf(current + 1);
    if (!next.length) return;
    const now = urlsOf(current);
    let cancelled = false;
    const preloadNext = () => {
      if (cancelled) return;
      next.forEach((url) => {
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
      });
    };
    if (!now.length) {
      preloadNext();
      return () => {
        cancelled = true;
      };
    }
    let waiting = now.length;
    const probes = now.map((url) => {
      const probe = new Image();
      const done = () => {
        probe.onload = null;
        probe.onerror = null;
        waiting -= 1;
        if (waiting === 0) preloadNext();
      };
      probe.onload = done;
      probe.onerror = done;
      probe.src = url;
      return probe;
    });
    return () => {
      cancelled = true;
      probes.forEach((probe) => {
        probe.onload = null;
        probe.onerror = null;
      });
    };
  }, [current, mode, views, items, urlFor]);

  if (!items.length) {
    return (
      <div className={cx('flex h-full items-center justify-center p-6', className)} data-testid="comic-reader">
        <EmptyHint icon={<BookOpen className="h-8 w-8" />} title="Nothing to read yet">
          {doc.pages.length
            ? 'Pages appear here as soon as they are drawn.'
            : 'Once pages are planned and drawn, read the finished comic here — page by page or as one long scroll.'}
        </EmptyHint>
      </div>
    );
  }

  const drawnPages = items.filter((i) => i.kind === 'page').length;
  const group = views[current] || [];
  const shown = group.map((i) => items[i]).filter(Boolean);
  const ordered = rtl ? [...shown].reverse() : shown;
  const availW = Math.max(0, stage.width - 32);
  const availH = Math.max(0, stage.height - 24);
  const totalAspect = ordered.reduce((s, it) => s + itemAspect(doc, it, loadedAspects), 0) || 1;
  const fitH = availW && availH ? Math.min(availH, availW / totalAspect) : 0;
  const shownLabel =
    shown.length > 1 && shown.every((s) => s.page)
      ? `Pages ${shown[0].page!.n}–${shown[shown.length - 1].page!.n}`
      : shown.map((s) => s.label).join(' + ');
  const counter = mode === 'scroll' ? `${drawnPages} ${drawnPages === 1 ? 'page' : 'pages'}` : `${shownLabel} · ${current + 1}/${views.length}`;
  const prevLabel = rtl ? 'Next page' : 'Previous page';
  const nextLabel = rtl ? 'Previous page' : 'Next page';

  return (
    <div
      ref={(el) => {
        rootRef.current = el;
        rootSizeRef(el);
      }}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-testid="comic-reader"
      data-fullscreen={viewportFullscreen ? 'viewport' : nativeFullscreen ? 'native' : 'off'}
      aria-label={`Read ${doc.brief.title}`}
      role="region"
      className={cx('flex h-full min-h-0 flex-col bg-[var(--ds-canvas)] focus:outline-none', className)}
      style={
        viewportFullscreen
          ? {
              // The fallback "full screen": the whole viewport, clear of notches and the home indicator.
              position: 'fixed',
              inset: 0,
              zIndex: 70,
              width: '100%',
              height: '100dvh',
              paddingTop: 'var(--sa-top, 0px)',
              paddingBottom: 'var(--sa-bottom, 0px)',
              paddingLeft: 'var(--sa-left, 0px)',
              paddingRight: 'var(--sa-right, 0px)'
            }
          : undefined
      }
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--ds-hairline)] px-3 py-2">
        <Segmented
          label="Reading mode"
          size="xs"
          className="coarse:[&>button]:min-h-[44px]"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'scroll' as ReaderMode, label: (<><Rows3 className="h-3 w-3" aria-hidden /> Scroll</>), title: 'One long vertical scroll' },
            { value: 'page' as ReaderMode, label: (<><Square className="h-3 w-3" aria-hidden /> Page</>), title: 'One page at a time' },
            // Facing pages need a wide screen — on a phone the option is left out rather than shown dead.
            ...(narrow ? [] : [{ value: 'spread' as ReaderMode, label: (<><Columns2 className="h-3 w-3" aria-hidden /> Spread</>), title: 'Facing pages' }])
          ]}
        />
        {mode !== 'scroll' && (
          <div className="flex items-center gap-0.5">
            <IconButton label={prevLabel} className={TOUCH_TARGET} onClick={() => go(rtl ? 1 : -1)} disabled={rtl ? current >= views.length - 1 : current <= 0}>
              <ChevronLeft className="h-4 w-4" />
            </IconButton>
            <span className="min-w-[5.5rem] text-center text-[12px] tabular-nums text-[var(--ds-muted)] sm:min-w-[7rem]" aria-live="polite" data-testid="reader-counter">
              {counter}
            </span>
            <IconButton label={nextLabel} className={TOUCH_TARGET} onClick={() => go(rtl ? -1 : 1)} disabled={rtl ? current <= 0 : current >= views.length - 1}>
              <ChevronRight className="h-4 w-4" />
            </IconButton>
          </div>
        )}
        {mode === 'scroll' && <span className="text-[12px] text-[var(--ds-muted)]">{counter}</span>}
        {rtl && <span className="rounded-full bg-[var(--ds-well-strong)] px-2 py-0.5 text-[11px] text-[var(--ds-muted)]">Reads right to left</span>}
        {drawnPages < doc.pages.length && (
          <span className={cx('text-[11px] text-[var(--ds-muted)]', narrow && 'sr-only')}>
            {drawnPages} of {doc.pages.length} pages drawn
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {toolbarExtra}
          <IconButton label={fullscreen ? 'Exit full screen' : 'Full screen'} className={TOUCH_TARGET} aria-pressed={fullscreen} onClick={toggleFullscreen}>
            {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </IconButton>
        </div>
      </div>

      {showIosNote && (
        // iPhone browsers have no element full screen: say once, honestly, what does work.
        <div
          role="status"
          aria-label="Full screen on iPhone"
          className="fixed inset-x-3 z-[71] mx-auto max-w-sm rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] p-3 text-[13px] leading-snug text-[var(--ds-ink)] shadow-[0_12px_40px_rgba(0,0,0,0.18)] backdrop-blur-md"
          style={{ bottom: 'calc(var(--sa-bottom, 0px) + 16px)' }}
        >
          <p>{IOS_FULLSCREEN_NOTE}</p>
          <div className="mt-1 flex justify-end">
            <button
              type="button"
              onClick={() => setShowIosNote(false)}
              className="min-h-[44px] rounded-full px-4 text-[13px] font-semibold text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {mode === 'scroll' ? (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" data-testid="reader-scroll">
          <div className={cx('mx-auto flex max-w-[860px] flex-col items-stretch px-3 py-4', doc.format.kind === 'webtoon' ? 'gap-0' : 'gap-5')}>
            {items.map((item, i) => (
              <ReaderPage key={item.key} doc={doc} item={item} urlFor={urlFor} eager={i < 2} onImageError={onImageError} onAspect={onAspect} aspect={itemAspect(doc, item, loadedAspects)} />
            ))}
            <p className="py-6 text-center text-[12px] text-[var(--ds-muted)]">The end.</p>
          </div>
        </div>
      ) : (
        <div
          ref={stageRef}
          data-testid="reader-stage"
          className="relative flex min-h-0 flex-1 select-none items-center justify-center gap-0 overflow-hidden px-4 py-3"
          style={{ touchAction: zoomed ? 'manipulation' : 'pan-y pinch-zoom' }}
          data-zoomed={zoomed ? 'true' : undefined}
          onPointerDown={(e) => {
            if (e.isPrimary || pointers.current.size === 0) {
              pointers.current.clear();
              multiPointer.current = false;
            }
            pointers.current.add(e.pointerId);
            if (pointers.current.size > 1) {
              multiPointer.current = true;
              swipe.current = null;
              return;
            }
            swipe.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
          }}
          onPointerUp={(e) => {
            pointers.current.delete(e.pointerId);
            const start = swipe.current;
            swipe.current = null;
            if (multiPointer.current) {
              if (pointers.current.size === 0) multiPointer.current = false;
              return;
            }
            if (!start || isViewportZoomed()) return;
            const dx = e.clientX - start.x;
            const dy = e.clientY - start.y;
            const s = swipeDelta(dx, dy, rtl);
            if (s) {
              go(s);
              return;
            }
            if ((e.target as HTMLElement).dataset?.zone) return;
            if (Math.hypot(dx, dy) < 8 && e.pointerType !== 'mouse') {
              const rect = e.currentTarget.getBoundingClientRect();
              const t = tapDelta(rect.width ? (e.clientX - rect.left) / rect.width : 0.5, rtl);
              if (t) go(t);
            }
          }}
          onPointerCancel={(e) => {
            pointers.current.delete(e.pointerId);
            if (pointers.current.size === 0) multiPointer.current = false;
            swipe.current = null;
          }}
        >
          {ordered.map((item) => (
            <ReaderPage
              key={item.key}
              doc={doc}
              item={item}
              urlFor={urlFor}
              eager
              width={fitH ? fitH * itemAspect(doc, item, loadedAspects) : undefined}
              aspect={itemAspect(doc, item, loadedAspects)}
              onAspect={onAspect}
              onImageError={onImageError}
            />
          ))}
          <button
            type="button"
            aria-label={prevLabel}
            data-zone="prev"
            tabIndex={-1}
            onClick={() => !isViewportZoomed() && go(rtl ? 1 : -1)}
            className="absolute inset-y-0 left-0 hidden w-[12%] cursor-w-resize opacity-0 md:block"
          />
          <button
            type="button"
            aria-label={nextLabel}
            data-zone="next"
            tabIndex={-1}
            onClick={() => !isViewportZoomed() && go(rtl ? -1 : 1)}
            className="absolute inset-y-0 right-0 hidden w-[12%] cursor-e-resize opacity-0 md:block"
          />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-[var(--ds-well-strong)]" aria-hidden>
            <div
              className="h-full bg-[var(--ds-accent)] transition-[width] duration-300"
              style={{ width: `${views.length > 1 ? (current / (views.length - 1)) * 100 : 100}%`, marginLeft: rtl ? 'auto' : undefined }}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default ComicReaderView;
