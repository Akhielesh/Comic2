// The inline reader for a v4 comic (reader.md §11.1, contract §13.3): cover, then every drawn page,
// lettered — the "preview" surface shared by the studio Read tab and the public reader.
//
// One layout decision for the inline and the immersive readers (immersive/readerLayout.ts): Scroll
// (vertical, webtoon-friendly), Page (one at a time) and Spread (facing pages when two pages fit —
// the cover alone on its side, page 1 facing the inside cover, exactly like print and the immersive
// book). An explicit choice wins and is remembered (`comicstudio.reader.mode`, shared with the
// immersive reader). Page modes turn with ←/→ (reading-direction aware), Space/PageUp/PageDown,
// Home/End, swipes and taps on the outer thirds; pinch / ctrl+wheel zoom the page (TouchCanvas) and
// turns pause while zoomed. Pages come through the shared page-image cache (decoded before they show,
// the right size variant for the box, neighbours preloaded politely), and a withheld (safety-blocked)
// page is a neutral tile that is never fetched. Deep links: `initialPage` in, `?p=` out (syncUrl).
// Chrome is docked (studio) or auto-hides (public reader). Everything is client-side and free.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, Columns2, Download, Expand, Flag, Maximize2, Minimize2, MoreHorizontal, Rows3, Share2, Square, X } from 'lucide-react';
import type { AssetRef, ComicDoc } from '../../../shared/comic/doc';
import { bookOf, readerOf } from '../../../shared/comic/doc';
import { fallbackLineIds, localizeDoc } from '../../../shared/comic/i18n';
import { sameLanguage } from '../../../shared/comic/languages';
import { PLATFORM_CEILING, canServeToOwner, type ContentRating } from '../../../shared/comic/safety';
import { ComicPageView } from '../board/ComicPageView';
import { aspectNumber, pageAspectOf } from '../board/balloonGeometry';
import { EmptyHint, IconButton, Segmented, cx, useElementSize } from '../board/ui';
import { ReaderLanguagePicker, type ReaderLanguageSlot } from '../i18n/ReaderLanguagePicker';
import { readerString } from '../i18n/readerStrings';
import { EndCard } from '../immersive/EndCard';
import { ImmersiveReader, trimAspect, type ImmersiveReaderEndCard } from '../immersive/ImmersiveReader';
import { connectionHints, pageImageCache } from '../immersive/pageImageCache';
import { SlotContentView, slotImageSource, type SlotImage } from '../immersive/ReaderSlot';
import { bookGeometry, bookViews, decideLayout, letterbox, viewIndexOfItem, type BookView, type LayoutPref } from '../immersive/readerLayout';
import { effectiveReader, readLayoutPref, readPosition, readPrefs, shouldOfferResume, writeLayoutPref, writePosition } from '../immersive/readerPrefs';
import { createUrlSync } from '../immersive/readerUrl';
import { useFormFactor } from '../mobile/useFormFactor';
import { TouchCanvas } from '../mobile/touch/TouchCanvas';
import { RatingBadge } from '../safety/RatingBadge';
import { SafetyVeil } from '../safety/SafetyVeil';
import { usePrefersReducedMotion } from '../../studio/kit/motion';
import { chapterStarts, clampIndex, keyDelta, readerItems, resolvePageN, swipeDelta, tapDelta, isWithheld, type ReaderItem, type ReaderMode } from './readerModel';

export type ReaderChrome = 'docked' | 'auto-hide';
export type InlineLayoutChoice = 'auto' | 'single' | 'spread';

export interface ComicReaderViewProps {
  doc: ComicDoc;
  /** Signed / public URL for an asset; `width` asks for the best stored variant (studio urlFor). */
  urlFor: (asset?: AssetRef | string | null, opts?: { width?: number }) => string | undefined;
  /** Start in this mode ('page' = one page at a time). Not remembered (the host chose it). */
  initialMode?: ReaderMode;
  /** Extra toolbar controls (e.g. export buttons). */
  toolbarExtra?: React.ReactNode;
  className?: string;
  /** A page image failed to load or its signed link expired (the host re-signs). */
  onImageError?: () => void;
  /** Focus the reader on mount so the keyboard works immediately (default true). */
  autoFocus?: boolean;
  // ── contract §13.3 ──
  /** Start position: 1-based page number (0 = cover) or the cover. An undrawn page shows the nearest drawn one, honestly. */
  initialPage?: number | 'cover';
  /** Settled on a page (1-based; 0 = cover). */
  onPageChange?(n: number): void;
  /** Write ?p= (and keep ?lang=) with history.replaceState as the reader settles (public reader only). */
  syncUrl?: boolean;
  /** Reader language slot: the picker in the toolbar; the pages show that edition. */
  language?: ReaderLanguageSlot;
  /** End card extras (public reader: author, "Make your own", share link). Without it the book ends on its last page. */
  endCard?: ImmersiveReaderEndCard;
  /** Host default layout (an explicit, remembered user choice wins). */
  layout?: InlineLayoutChoice;
  /** Pinch / ctrl+wheel zoom on the page (default true; never in Scroll). */
  zoomable?: boolean;
  /** 'docked' (default): the toolbar stays; 'auto-hide': it overlays the page and hides while reading. */
  chrome?: ReaderChrome;
  /** Show a Share button that calls this. */
  onShare?(): void;
  /** Offer a PDF download (client-side, from the images this reader already shows). */
  allowDownload?: boolean;
  // ── additive ──
  /** Show "Full screen" that opens the immersive reader (instead of browser fullscreen of this box). */
  immersiveEntry?: boolean;
  /** Open straight into the immersive reader (call from a user gesture). */
  immersiveOnMount?: boolean;
  /** The immersive reader opened / closed (hosts hide their own chrome). */
  onImmersiveChange?(on: boolean): void;
  /** Content rating badge (the rating the publish gate assigned). */
  rating?: ContentRating;
  ratingReason?: string;
  /** Show "Report" (never pass it for the owner). Called with the current page (1-based; 0 = cover). */
  onReport?(page: number): void;
  /** Host-provided download (replaces the built-in PDF). */
  onDownload?(): void;
}

/** Reader ink on paper (same in both themes, like the immersive reading room). */
const READER_INK: React.CSSProperties = {
  ['--ds-reader-ink' as string]: '#3b3026',
  ['--ds-reader-ink-soft' as string]: '#5b4a3a',
  ['--ds-reader-ink-faint' as string]: '#8a7865',
  ['--ds-reader-wash' as string]: 'rgba(59,48,38,0.10)',
  ['--ds-reader-wash-strong' as string]: 'rgba(59,48,38,0.16)'
};

const CHROME_IDLE_MS = 2500;
const PAGE_SHADOW = 'shadow-[0_6px_30px_rgba(0,0,0,0.22)]';

type Pos = { key: string | null; end: boolean };

const pageNOf = (item?: ReaderItem): number => item?.page?.n ?? 0;

/** The settled page number of a view (End card / back endpaper: the last page). */
const pageNOfView = (views: BookView[], items: ReaderItem[], view: number): number => {
  const first = views[view]?.items[0];
  if (first === undefined) return pageNOf(items[items.length - 1]);
  return pageNOf(items[first]);
};

/** Scroll mode: one page (or the cover) at full column width, natively lazy. */
const ScrollPage: React.FC<{
  doc: ComicDoc;
  item: ReaderItem;
  img: SlotImage;
  paper: boolean;
  eager: boolean;
  onImageError?: () => void;
}> = ({ doc, item, img, paper, eager, onImageError }) => {
  const aspect = item.asset.w && item.asset.h ? item.asset.w / item.asset.h : item.page ? pageAspectOf(doc, item.page) : aspectNumber(doc.format.pageAspect);
  if (isWithheld(item)) {
    // Never fetched, never an <img>: a neutral tile in the page's place.
    return (
      <div data-testid="reader-page" data-key={item.key} className="relative w-full overflow-hidden rounded-sm" style={{ aspectRatio: String(aspect) }}>
        <div className="absolute inset-0">
          <SafetyVeil asset={item.asset} rating={PLATFORM_CEILING}>
            {null}
          </SafetyVeil>
        </div>
      </div>
    );
  }
  if (item.page) {
    return (
      <div data-testid="reader-page" data-key={item.key} className={cx('w-full', PAGE_SHADOW)}>
        <ComicPageView
          doc={doc}
          page={item.page}
          imageUrl={img.urlFor(item.asset)}
          srcWidth={(w) => slotImageSource(item, w, img)?.url}
          loading={eager ? 'eager' : 'lazy'}
          develop={false}
          paper={paper}
          onImageError={onImageError}
        />
      </div>
    );
  }
  const url = slotImageSource(item, 800, img)?.url;
  return (
    <div data-testid="reader-page" data-key={item.key} className={cx('relative w-full overflow-hidden bg-white', PAGE_SHADOW)} style={{ aspectRatio: String(aspect) }}>
      {url ? (
        <img src={url} alt={`Cover of ${doc.cover.title || doc.brief.title}`} loading={eager ? 'eager' : 'lazy'} className="absolute inset-0 h-full w-full object-contain" onError={onImageError} />
      ) : (
        <div className="studio-shimmer absolute inset-0" role="img" aria-label="Loading cover" />
      )}
    </div>
  );
};

export interface ReaderMenuItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  onSelect(): void;
  disabled?: boolean;
}

/** A small reader menu (⋯ / Download): a disclosure with real buttons; Esc and an outside tap close it. */
export const ReaderMenu: React.FC<{ label: string; items: ReaderMenuItem[]; icon?: React.ReactNode; className?: string }> = ({ label, items, icon, className }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      ref.current?.querySelector<HTMLButtonElement>('button[aria-haspopup]')?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  if (!items.length) return null;
  return (
    <div ref={ref} className={cx('relative', className)}>
      <IconButton label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {icon ?? <MoreHorizontal className="h-4 w-4" />}
      </IconButton>
      {open && (
        <div
          role="menu"
          aria-label={label}
          className="absolute right-0 top-full z-30 mt-1 min-w-[12rem] max-w-[calc(100vw-24px)] rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] p-1 shadow-[0_8px_30px_rgba(0,0,0,0.18)] backdrop-blur-md"
        >
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
              className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-[13px] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 disabled:opacity-50"
            >
              {it.icon}
              <span className="min-w-0 truncate">{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export const ComicReaderView: React.FC<ComicReaderViewProps> = ({
  doc,
  urlFor,
  initialMode,
  toolbarExtra,
  className,
  onImageError,
  autoFocus = true,
  initialPage,
  onPageChange,
  syncUrl = false,
  language,
  endCard,
  layout: hostLayout,
  zoomable = true,
  chrome = 'docked',
  onShare,
  allowDownload = false,
  immersiveEntry = false,
  immersiveOnMount = false,
  onImmersiveChange,
  rating,
  ratingReason,
  onReport,
  onDownload
}) => {
  // ── Document (keyed on the language CODE: a host's inline slot object must not re-localize) ──
  const lang = language?.current;
  const localized = useMemo(() => (lang ? localizeDoc(doc, lang) : doc), [doc, lang]);
  const items = useMemo(() => readerItems(localized), [localized]);
  const chromeLang = lang || localized.format.language || 'en';
  const t = useCallback((key: Parameters<typeof readerString>[1], vars?: Record<string, string | number>) => readerString(chromeLang, key, vars), [chromeLang]);
  const fallback = useMemo(() => (localized !== doc ? fallbackLineIds(localized) : []), [localized, doc]);
  const rtl = localized.format.readingDirection === 'rtl';
  const kind = localized.format.kind;
  const trim = useMemo(() => trimAspect(items, aspectNumber(localized.format.pageAspect)), [items, localized.format.pageAspect]);
  const firstPageRight = bookOf(localized).firstPageRight;
  const creator = readerOf(localized);
  // Stable per doc (never keyed on cache events: geometry and preloading must not churn as images land).
  const aspectOf = useCallback(
    (i: number): number => {
      const it = items[i];
      if (!it) return trim;
      const a = it.asset;
      if (a.w && a.h) return a.w / a.h;
      return it.page ? pageAspectOf(localized, it.page) : trim;
    },
    [items, trim, localized]
  );

  // ── Device, prefs ─────────────────────────────────────────────────────────
  const ff = useFormFactor();
  const reduced = usePrefersReducedMotion() || ff.reducedMotion;
  const eff = useMemo(() => effectiveReader(creator, readPrefs(), kind), [creator, kind]);
  const net = useMemo(() => connectionHints(), []);
  const img = useMemo<SlotImage>(
    () => ({ urlFor, dpr: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, saveData: ff.saveData || net.saveData, original: false }),
    [urlFor, ff.saveData, net.saveData]
  );

  // ── Layout ────────────────────────────────────────────────────────────────
  const [pref, setPref] = useState<LayoutPref>(() => {
    if (initialMode) return initialMode === 'page' ? 'single' : initialMode;
    const stored = readLayoutPref();
    return stored !== 'auto' ? stored : hostLayout ?? 'auto';
  });
  const [rootSizeRef, rootSize] = useElementSize<HTMLDivElement>();
  const [stageRef, stage] = useElementSize<HTMLDivElement>();
  const winW = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const winH = typeof window !== 'undefined' ? window.innerHeight : 768;
  const boxW = rootSize.width || winW;
  const boxH = rootSize.height || winH;
  const decision = useMemo(
    () => decideLayout({ vw: boxW, vh: boxH, kind, pref, pageAspect: trim, widthClass: ff.widthClass, heightClass: ff.heightClass }),
    [boxW, boxH, kind, pref, trim, ff.widthClass, ff.heightClass]
  );
  const layout = decision.layout;
  const viewLayout = layout === 'spread' ? 'spread' : 'single';
  const views = useMemo(() => bookViews(items, viewLayout, { endCard: !!endCard, firstPageRight }), [items, viewLayout, endCard, firstPageRight]);

  // ── Position (anchored on the item key, so live doc updates never jump) ──
  const [note, setNote] = useState<string | null>(() => {
    // The honest fallback note for an undrawn deep-linked page.
    if (initialPage === undefined || initialPage === 'cover' || !items.length) return null;
    const r = resolvePageN(items, initialPage);
    return r.exact ? null : `Page ${initialPage} isn’t drawn yet — showing ${r.shownN ? `page ${r.shownN}` : 'the cover'}.`;
  });
  const [pos, setPos] = useState<Pos>(() => {
    if (initialPage === undefined || !items.length) return { key: items[0]?.key ?? null, end: false };
    const r = resolvePageN(items, initialPage === 'cover' ? 0 : initialPage);
    return { key: items[r.index]?.key ?? null, end: false };
  });
  const itemIdx = Math.max(0, pos.key ? items.findIndex((i) => i.key === pos.key) : 0);
  const viewIdx = clampIndex(pos.end ? views.length - 1 : viewIndexOfItem(views, itemIdx), views.length);
  const currentView = views[viewIdx];
  const atEnd = !!currentView && !currentView.items.length;

  const goToView = useCallback(
    (v: number) => {
      const target = views[clampIndex(v, views.length)];
      if (!target) return;
      const first = target.items[0];
      if (first === undefined) setPos({ key: items[items.length - 1]?.key ?? null, end: true });
      else setPos({ key: items[first]?.key ?? null, end: false });
    },
    [views, items]
  );

  // ── Chrome (auto-hide) ────────────────────────────────────────────────────
  const autoHide = chrome === 'auto-hide';
  const [chromeShown, setChromeShown] = useState(true);
  const chromeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const pokeChrome = useCallback(
    (show = true) => {
      if (!autoHide) return;
      if (chromeTimer.current) clearTimeout(chromeTimer.current);
      if (show) setChromeShown(true);
      const hide = () => {
        // The toolbar stays while one of its controls has keyboard focus.
        if (typeof document !== 'undefined' && toolbarRef.current?.contains(document.activeElement)) {
          chromeTimer.current = setTimeout(hide, CHROME_IDLE_MS);
          return;
        }
        setChromeShown(false);
      };
      chromeTimer.current = setTimeout(hide, CHROME_IDLE_MS);
    },
    [autoHide]
  );
  useEffect(() => {
    if (autoHide) pokeChrome(true);
    else setChromeShown(true);
    return () => {
      if (chromeTimer.current) clearTimeout(chromeTimer.current);
    };
  }, [autoHide, pokeChrome]);
  const hideChromeNow = useCallback(() => {
    if (!autoHide) return;
    if (typeof document !== 'undefined' && toolbarRef.current?.contains(document.activeElement)) return;
    if (chromeTimer.current) clearTimeout(chromeTimer.current);
    setChromeShown(false);
  }, [autoHide]);

  // ── Zoom ──────────────────────────────────────────────────────────────────
  const zoomRef = useRef(1);
  const canZoom = zoomable && layout !== 'scroll' && decision.fit !== 'width';

  // ── Navigation ────────────────────────────────────────────────────────────
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);
  // Swipes and taps pause while zoomed (a drag pans the page instead; the stage handlers check
  // zoomRef). An explicit control — a toolbar arrow, a key, a side zone — always turns, and
  // TouchCanvas snaps back to fit on the new page (resetKey), so no button is ever dead.
  const go = useCallback(
    (delta: number) => {
      if (!delta) return;
      if (layout === 'scroll') {
        const container = scrollRef.current;
        if (!container) return;
        const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="reader-page"]'));
        const top = container.scrollTop;
        const idx = nodes.findIndex((n) => n.offsetTop >= top - 4);
        const target = nodes[clampIndex((idx < 0 ? 0 : idx) + delta, nodes.length)];
        target?.scrollIntoView?.({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
        return;
      }
      setNote(null);
      goToView(viewIdx + delta);
      hideChromeNow();
    },
    [layout, reduced, goToView, viewIdx, hideChromeNow]
  );

  const setLayoutChoice = (next: 'scroll' | 'page' | 'spread') => {
    const p: LayoutPref = next === 'page' ? 'single' : next;
    if (p === pref) return;
    setPref(p);
    writeLayoutPref(p);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The immersive reader portals out of this box, but React still bubbles its keys here: it owns them.
    if (immersive) return;
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((e.target as HTMLElement).closest?.('[role="menu"],[role="listbox"]')) return;
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      if (layout === 'scroll') {
        const c = scrollRef.current;
        if (c) c.scrollTop = e.key === 'Home' ? 0 : c.scrollHeight;
      } else {
        setNote(null);
        goToView(e.key === 'Home' ? 0 : views.length - 1);
      }
      return;
    }
    // In scroll mode Space/PageUp/PageDown keep their native scrolling.
    if (layout === 'scroll' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const delta = keyDelta(e.key, rtl);
    if (!delta) return;
    e.preventDefault();
    go(delta);
  };

  // Keyboard works right away.
  useEffect(() => {
    if (autoFocus) rootRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  // Browser fullscreen of this box (only without the immersive entry).
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement && document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) await rootRef.current?.requestFullscreen?.();
      else await document.exitFullscreen?.();
    } catch {
      /* fullscreen refused (iframe / iOS) — keep reading inline */
    }
  };

  // ── Immersive ─────────────────────────────────────────────────────────────
  const [immersive, setImmersive] = useState<{ page: number | 'cover'; intro: boolean } | null>(() =>
    immersiveOnMount ? { page: initialPage ?? 'cover', intro: initialPage === undefined } : null
  );
  const immersivePage = useRef<number | null>(null);
  const immersiveOn = !!immersive;
  useEffect(() => {
    onImmersiveChange?.(immersiveOn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [immersiveOn]);
  const openImmersive = () => {
    immersivePage.current = null;
    const first = currentView?.items[0];
    const n = layout === 'scroll' ? pageNOf(items[itemIdx]) : pageNOfView(views, items, viewIdx);
    const onCover = layout === 'scroll' ? items[itemIdx]?.kind === 'cover' : first !== undefined && items[first]?.kind === 'cover';
    setImmersive({ page: onCover || !n ? 'cover' : n, intro: false });
  };
  const closeImmersive = useCallback(() => {
    const n = immersivePage.current;
    setImmersive(null);
    if (n !== null && items.length) {
      const r = resolvePageN(items, n);
      setPos({ key: items[r.index]?.key ?? null, end: false });
    }
    rootRef.current?.focus({ preventScroll: true });
  }, [items]);

  // ── Settled page: host callback, ?p= sync, resume position ───────────────
  const urlSync = useMemo(() => (syncUrl ? createUrlSync() : null), [syncUrl]);
  useEffect(() => () => urlSync?.flush(), [urlSync]);
  const settled = useRef(false);
  const settledN = layout === 'scroll' ? null : pageNOfView(views, items, viewIdx);
  const settledKey = layout === 'scroll' ? null : `${currentView?.key ?? ''}|${pos.end ? 'end' : ''}`;
  const onPageChangeRef = useRef(onPageChange);
  onPageChangeRef.current = onPageChange;
  const reportPage = useCallback(
    (n: number, key: string | null) => {
      onPageChangeRef.current?.(n);
      if (!settled.current) {
        // Opening never rewrites the link or the saved position (the resume chip still offers it).
        settled.current = true;
        return;
      }
      if (key) writePosition(doc.id, { key, at: Date.now() });
      if (urlSync && !immersiveOn) urlSync.schedule({ p: n, ...(lang && !sameLanguage(lang, doc.format.language) ? { lang } : {}) });
    },
    [doc.id, urlSync, immersiveOn, lang, doc.format.language]
  );
  useEffect(() => {
    if (settledN === null) {
      settled.current = true; // Scroll reports from its scroll position; opening is not a move
      return;
    }
    if (!items.length) return;
    reportPage(settledN, pos.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledKey]);

  // Resume: "Continue from page N" (offered, never jumped to on its own; never over a deep link).
  const [resume, setResume] = useState<{ key: string; n: number } | null>(() => {
    if (initialPage !== undefined || immersiveOnMount) return null;
    const p = readPosition(doc.id);
    if (!p) return null;
    const idx = items.findIndex((i) => i.key === p.key);
    if (idx < 0 || !shouldOfferResume(p, idx, Date.now())) return null;
    return { key: p.key, n: pageNOf(items[idx]) };
  });
  useEffect(() => {
    if (resume && pos.key === resume.key) setResume(null);
  }, [pos.key, resume]);

  // ── Scroll mode: settle on the page in view ───────────────────────────────
  const scrollTick = useRef<number | null>(null);
  const lastScrollTop = useRef(0);
  const onScroll = () => {
    const c = scrollRef.current;
    if (!c) return;
    if (autoHide) {
      const dy = c.scrollTop - lastScrollTop.current;
      if (dy > 24) hideChromeNow();
      else if (dy < -24) pokeChrome(true);
      if (Math.abs(dy) > 24) lastScrollTop.current = c.scrollTop;
    }
    if (scrollTick.current !== null || typeof requestAnimationFrame === 'undefined') return;
    scrollTick.current = requestAnimationFrame(() => {
      scrollTick.current = null;
      const nodes = Array.from(c.querySelectorAll<HTMLElement>('[data-testid="reader-page"]'));
      const line = c.scrollTop + c.clientHeight / 3;
      let at = 0;
      nodes.forEach((n, i) => {
        if (n.offsetTop <= line) at = i;
      });
      const item = items[at];
      if (!item || item.key === pos.key) return;
      setPos({ key: item.key, end: false });
      reportPage(pageNOf(item), item.key);
    });
  };
  useEffect(
    () => () => {
      if (scrollTick.current !== null && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(scrollTick.current);
    },
    []
  );
  // Entering Scroll keeps your place.
  useLayoutEffect(() => {
    if (layout !== 'scroll' || !pos.key) return;
    const node = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>('[data-testid="reader-page"]') ?? []).find((n) => n.dataset.key === pos.key);
    if (node && scrollRef.current) scrollRef.current.scrollTop = node.offsetTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  // ── Geometry + polite preloading ──────────────────────────────────────────
  const stageW = stage.width || boxW;
  const stageH = stage.height || Math.max(1, boxH - (autoHide ? 0 : 48));
  const geo = useMemo(
    () =>
      currentView && layout !== 'scroll'
        ? bookGeometry({ view: currentView, stage: { w: stageW, h: stageH }, layout: viewLayout, rtl, aspectOf, pageAspect: trim, fit: decision.fit, widthClass: ff.widthClass })
        : null,
    [currentView, layout, stageW, stageH, viewLayout, rtl, aspectOf, trim, decision.fit, ff.widthClass]
  );
  useEffect(() => {
    if (layout === 'scroll' || !geo || immersiveOn || typeof window === 'undefined') return;
    const sourceOf = (i: number) => {
      const it = items[i];
      return it ? slotImageSource(it, letterbox(geo.page.w, geo.page.h, aspectOf(i)).w, img) : undefined;
    };
    const keep = views
      .slice(Math.max(0, viewIdx - 2), viewIdx + 3)
      .flatMap((v) => v.items)
      .flatMap((i) => [items[i]?.asset.path, sourceOf(i)?.path])
      .filter(Boolean) as string[];
    pageImageCache.retain(keep);
    const controller = new AbortController();
    const ahead = img.saveData || net.slow ? [viewIdx + 1] : [viewIdx + 1, viewIdx - 1, viewIdx + 2];
    for (const v of ahead) {
      for (const i of views[v]?.items ?? []) {
        const src = sourceOf(i);
        if (src?.url) void pageImageCache.ensure(src.path, src.url, v === viewIdx + 1 ? 'next' : 'idle', controller.signal);
      }
    }
    return () => controller.abort();
  }, [layout, geo, immersiveOn, items, views, viewIdx, aspectOf, img, net.slow]);

  // ── Download (client-side PDF from the images already served; withheld pages never included) ──
  const [downloading, setDownloading] = useState(false);
  const download = useCallback(async () => {
    if (onDownload) {
      onDownload();
      return;
    }
    if (downloading) return;
    setDownloading(true);
    setNote('Preparing the PDF…');
    try {
      const { exportComicPdf } = await import('../export/pdfExport');
      const res = await exportComicPdf(localized, (a) => (a && typeof a === 'object' && !canServeToOwner(a) ? undefined : urlFor(a)));
      const left = res.skipped.length + res.failed.length;
      setNote(left ? `Downloaded ${res.pages} page${res.pages === 1 ? '' : 's'} — ${left} couldn’t be included (not drawn, withheld or didn’t load).` : 'Downloaded the PDF.');
    } catch (err) {
      setNote(`Couldn’t make the PDF: ${(err as Error)?.message || 'please try again.'}`);
    } finally {
      setDownloading(false);
    }
  }, [onDownload, downloading, localized, urlFor]);

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

  // ── Labels ────────────────────────────────────────────────────────────────
  const drawnPages = items.filter((i) => i.kind === 'page').length;
  const shown = (currentView?.items ?? []).map((i) => items[i]).filter(Boolean);
  const shownLabel = atEnd
    ? t('theEnd').replace(/\.$/, '')
    : shown.length > 1 && shown.every((s) => s.page)
      ? `Pages ${shown[0].page!.n}–${shown[shown.length - 1].page!.n}`
      : shown.map((s) => (s.kind === 'cover' ? t('cover') : `${t('page')} ${s.page!.n}`)).join(' + ');
  const counter = layout === 'scroll' ? `${drawnPages} ${drawnPages === 1 ? 'page' : 'pages'}` : `${shownLabel} · ${viewIdx + 1}/${views.length}`;
  const prevLabel = rtl ? t('nextPage') : t('previousPage');
  const nextLabel = rtl ? t('previousPage') : t('nextPage');
  const layoutValue: 'scroll' | 'page' | 'spread' = layout === 'scroll' ? 'scroll' : layout === 'spread' ? 'spread' : 'page';
  const layoutOptions =
    kind === 'webtoon'
      ? []
      : [
          { value: 'scroll' as const, label: (<><Rows3 className="h-3 w-3" aria-hidden /> {t('scroll')}</>), title: 'One long vertical scroll' },
          { value: 'page' as const, label: (<><Square className="h-3 w-3" aria-hidden /> {t('page')}</>), title: 'One page at a time' },
          // Facing pages need room — where they can't fit the option is left out rather than shown dead.
          ...(kind !== 'strip' && (decision.allowSpread || layout === 'spread')
            ? [{ value: 'spread' as const, label: (<><Columns2 className="h-3 w-3" aria-hidden /> {t('spread')}</>), title: 'Facing pages' }]
            : [])
        ];
  const narrow = boxW < 560;
  const currentPageN = layout === 'scroll' ? pageNOf(items[itemIdx]) : pageNOfView(views, items, viewIdx);
  const menuItems = [
    ...(allowDownload || onDownload
      ? [{ id: 'download', label: downloading ? 'Preparing…' : `${t('download')} (PDF)`, icon: <Download className="h-4 w-4" aria-hidden />, onSelect: () => void download(), disabled: downloading }]
      : []),
    ...(onReport ? [{ id: 'report', label: 'Report this comic', icon: <Flag className="h-4 w-4" aria-hidden />, onSelect: () => onReport(currentPageN) }] : [])
  ];
  const endNode = endCard ? (
    <div className="absolute inset-0" style={READER_INK}>
      <EndCard
        doc={localized}
        endCard={endCard}
        active={atEnd}
        chapters={chapterStarts(items).map((c) => ({ n: c.n, title: c.title }))}
        language={language}
        onReadAgain={() => goToView(0)}
        onShare={onShare}
        onDownload={allowDownload || onDownload ? () => void download() : undefined}
        downloadBusy={downloading}
        dense={(geo?.page.w ?? stageW) < 360}
      />
    </div>
  ) : null;

  const toolbar = (
    <div
      ref={toolbarRef}
      data-testid="reader-toolbar"
      data-shown={chromeShown ? 'true' : 'false'}
      onFocus={() => pokeChrome(true)}
      className={cx(
        'flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--ds-hairline)] px-3 py-2',
        autoHide && 'absolute inset-x-0 top-0 z-20 bg-[var(--ds-surface-strong)] backdrop-blur-md',
        autoHide && !reduced && 'transition-[opacity,transform] duration-200 ease-out',
        autoHide && !chromeShown && 'pointer-events-none -translate-y-full opacity-0'
      )}
    >
      {layoutOptions.length > 1 && <Segmented label="Reading mode" size="xs" value={layoutValue} onChange={setLayoutChoice} options={layoutOptions} />}
      {layout !== 'scroll' && (
        <div className="flex items-center gap-0.5">
          <IconButton label={prevLabel} onClick={() => go(rtl ? 1 : -1)} disabled={rtl ? viewIdx >= views.length - 1 : viewIdx <= 0}>
            <ChevronLeft className="h-4 w-4" />
          </IconButton>
          <span className="min-w-[5.5rem] text-center text-[12px] tabular-nums text-[var(--ds-muted)] sm:min-w-[7rem]" aria-live="polite" data-testid="reader-counter">
            {counter}
          </span>
          <IconButton label={nextLabel} onClick={() => go(rtl ? -1 : 1)} disabled={rtl ? viewIdx <= 0 : viewIdx >= views.length - 1}>
            <ChevronRight className="h-4 w-4" />
          </IconButton>
        </div>
      )}
      {layout === 'scroll' && <span className="text-[12px] text-[var(--ds-muted)]">{counter}</span>}
      {rating && <RatingBadge rating={rating} reason={ratingReason} />}
      {rtl && <span className="rounded-full bg-[var(--ds-well-strong)] px-2 py-0.5 text-[11px] text-[var(--ds-muted)]">{t('readsRightToLeft')}</span>}
      {drawnPages < doc.pages.length && (
        <span className={cx('text-[11px] text-[var(--ds-muted)]', narrow && 'sr-only')}>
          {drawnPages} of {doc.pages.length} pages drawn
        </span>
      )}
      {fallback.length > 0 && (
        <span className="rounded-full bg-[var(--ds-well-strong)] px-2 py-0.5 text-[11px] text-[var(--ds-muted)]" data-testid="reader-fallback-chip">
          {t('untranslatedLines', { n: fallback.length })}
        </span>
      )}
      <div className="ml-auto flex min-w-0 items-center gap-1">
        {toolbarExtra}
        {language && <ReaderLanguagePicker {...language} source={doc.format.language} compact={narrow} />}
        {onShare && (
          <IconButton label={t('share')} onClick={onShare}>
            <Share2 className="h-4 w-4" />
          </IconButton>
        )}
        <ReaderMenu label="More" items={menuItems} />
        {immersiveEntry ? (
          <button
            type="button"
            onClick={openImmersive}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-[12px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 coarse:h-11 coarse:min-w-[44px]"
          >
            <Expand className="h-4 w-4" aria-hidden />
            <span className={cx(narrow && 'sr-only')}>{t('fullScreen')}</span>
          </button>
        ) : (
          <IconButton label={fullscreen ? t('exitFullScreen') : t('fullScreen')} onClick={() => void toggleFullscreen()}>
            {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </IconButton>
        )}
      </div>
    </div>
  );

  const notices = (note || resume) && (
    // Overlaid (auto-hide): the strip itself lets taps through to the page; only its chips catch them.
    <div className={cx('flex shrink-0 flex-wrap items-center gap-2 px-3 py-1.5', autoHide && 'pointer-events-none absolute inset-x-0 bottom-3 z-20 justify-center [&>*]:pointer-events-auto')}>
      {note && (
        <p role="status" className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] py-1 pl-3 pr-1 text-[12px] text-[var(--ds-ink)] backdrop-blur-md">
          <span className="min-w-0 [overflow-wrap:anywhere]">{note}</span>
          <IconButton size="sm" label="Dismiss" onClick={() => setNote(null)}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </p>
      )}
      {resume && (
        <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] py-0.5 pl-1 pr-1 text-[12px] backdrop-blur-md">
          <button
            type="button"
            onClick={() => {
              setPos({ key: resume.key, end: false });
              setResume(null);
            }}
            className="min-h-8 rounded-full px-2.5 font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 coarse:min-h-11"
          >
            {resume.n ? `Continue from page ${resume.n}` : 'Continue reading'}
          </button>
          <IconButton size="sm" label="Dismiss" onClick={() => setResume(null)}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </span>
      )}
    </div>
  );

  const book = geo && currentView && (
    <div
      className="absolute"
      style={{ left: geo.book.x, top: geo.book.y, width: geo.book.w, height: geo.book.h }}
      data-testid="reader-book"
      data-layout={viewLayout}
      role="region"
      aria-roledescription="book"
      aria-label={localized.cover.title || localized.brief.title || 'Comic'}
    >
      {geo.slots.map((slot) => {
        const c = slot.content;
        if (c.kind === 'blank') return null;
        const item = c.kind === 'item' ? items[c.index] : undefined;
        const label = item ? (item.kind === 'cover' ? t('cover') : t('pageOf', { n: item.page!.n, total: drawnPages })) : undefined;
        return (
          <div
            key={c.kind === 'item' ? `i${c.index}` : c.kind === 'endpaper' ? `ep-${c.side}` : c.kind}
            className={cx('absolute overflow-hidden', PAGE_SHADOW)}
            style={{ left: slot.x, top: slot.y, width: slot.w, height: slot.h, background: 'var(--ds-reader-paper-back)', contain: 'layout paint', ...READER_INK }}
            data-side={slot.side}
            {...(item ? { 'data-testid': 'reader-page', 'data-key': item.key, role: 'group', 'aria-roledescription': 'page', 'aria-label': label } : {})}
          >
            <SlotContentView
              doc={localized}
              content={c}
              items={items}
              width={slot.w}
              height={slot.h}
              contentAspect={slot.contentAspect}
              img={img}
              prio="now"
              paper={eff.paper}
              letteringAriaHidden={false}
              onImageError={onImageError}
              onExpired={onImageError}
              dedication={creator.dedication}
              endCard={endNode}
            />
          </div>
        );
      })}
    </div>
  );

  return (
    <div
      ref={(el) => {
        rootRef.current = el;
        rootSizeRef(el);
      }}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerMove={(e) => {
        if (e.pointerType === 'mouse') pokeChrome(true);
      }}
      data-testid="comic-reader"
      data-layout={layout}
      aria-label={`Read ${localized.cover.title || localized.brief.title}`}
      role="region"
      className={cx('relative flex h-full min-h-0 flex-col bg-[var(--ds-canvas)] focus:outline-none', className)}
    >
      {toolbar}
      {!autoHide && notices}

      {layout === 'scroll' ? (
        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="reader-scroll">
          <div className={cx('mx-auto flex max-w-[860px] flex-col items-stretch px-3 py-4', kind === 'webtoon' ? 'gap-0' : 'gap-5', autoHide && 'pt-14')}>
            {items.map((item, i) => (
              <ScrollPage key={item.key} doc={localized} item={item} img={img} paper={eff.paper} eager={i < 2} onImageError={onImageError} />
            ))}
            {endNode ? (
              <div className="relative mx-auto mt-4 w-full max-w-[560px] overflow-hidden rounded-sm bg-[var(--ds-reader-paper-back)]" style={{ aspectRatio: String(trim) }}>
                {endNode}
              </div>
            ) : (
              <p className="py-6 text-center text-[12px] text-[var(--ds-muted)]">{t('theEnd')}</p>
            )}
          </div>
        </div>
      ) : (
        <div
          ref={stageRef}
          data-testid="reader-stage"
          className={cx('relative min-h-0 flex-1 select-none', decision.fit === 'width' ? 'overflow-y-auto overflow-x-hidden' : 'overflow-hidden', !canZoom && 'touch-pan-y')}
          onPointerDown={(e) => {
            swipe.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
          }}
          onPointerUp={(e) => {
            const start = swipe.current;
            swipe.current = null;
            if (!start || zoomRef.current > 1.05) return;
            const dx = e.clientX - start.x;
            const dy = e.clientY - start.y;
            const s = swipeDelta(dx, dy, rtl);
            if (s) {
              go(s);
              return;
            }
            const target = e.target as HTMLElement;
            if (target.dataset?.zone || target.closest?.('button,a,input,[role="menu"]')) return;
            if (Math.hypot(dx, dy) < 8 && e.pointerType !== 'mouse') {
              const rect = e.currentTarget.getBoundingClientRect();
              const tap = tapDelta(rect.width ? (e.clientX - rect.left) / rect.width : 0.5, rtl);
              if (tap) go(tap);
              else if (autoHide && chromeShown) hideChromeNow();
              else if (autoHide) pokeChrome(true);
            }
          }}
          onPointerCancel={() => {
            swipe.current = null;
          }}
        >
          {canZoom ? (
            <TouchCanvas
              label="Zoomable page"
              resetKey={currentView?.key}
              oneFingerPan="whenZoomed"
              onZoomChange={(s) => {
                zoomRef.current = s;
              }}
              onEdgeOverscroll={(dir) => {
                zoomRef.current = 1;
                go(rtl ? -dir : dir);
              }}
            >
              <div className="relative h-full w-full">{book}</div>
            </TouchCanvas>
          ) : decision.fit === 'width' && geo ? (
            <div className="relative w-full" style={{ height: geo.book.y + geo.book.h + 12 }}>
              {book}
            </div>
          ) : (
            book
          )}
          {/* Mouse-only click zones on the page edges (the resize cursor is their affordance). Touch
              devices never get invisible buttons: there the outer thirds turn through the stage's
              own tap handler, and the toolbar arrows are always visible. */}
          {!ff.coarse && (
            <>
              <button
                type="button"
                aria-label={prevLabel}
                data-zone="prev"
                tabIndex={-1}
                onClick={() => go(rtl ? 1 : -1)}
                className="absolute inset-y-0 left-0 z-[6] hidden w-[12%] cursor-w-resize opacity-0 md:block coarse:hidden"
              />
              <button
                type="button"
                aria-label={nextLabel}
                data-zone="next"
                tabIndex={-1}
                onClick={() => go(rtl ? -1 : 1)}
                className="absolute inset-y-0 right-0 z-[6] hidden w-[12%] cursor-e-resize opacity-0 md:block coarse:hidden"
              />
            </>
          )}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[7] h-0.5 bg-[var(--ds-well-strong)]" aria-hidden>
            <div
              className={cx('h-full bg-[var(--ds-accent)]', !reduced && 'transition-[width] duration-300')}
              style={{ width: `${views.length > 1 ? (viewIdx / (views.length - 1)) * 100 : 100}%`, marginLeft: rtl ? 'auto' : undefined }}
            />
          </div>
        </div>
      )}
      {autoHide && notices}

      {immersive && (
        <ImmersiveReader
          doc={doc}
          urlFor={urlFor}
          language={language}
          endCard={endCard}
          intro={immersive.intro}
          initialPage={immersive.page}
          allowDownload={allowDownload || !!onDownload}
          syncUrl={syncUrl}
          onImageError={onImageError}
          onPageChange={(n) => {
            immersivePage.current = n;
            onPageChangeRef.current?.(n);
          }}
          onExit={closeImmersive}
        />
      )}
    </div>
  );
};

export default ComicReaderView;
