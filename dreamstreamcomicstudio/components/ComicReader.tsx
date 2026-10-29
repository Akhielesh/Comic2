import React, { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Project, ComicPanel, DialogueBlock, TextLayout } from '../types';
import { CommentSection } from './CommentSection';
import { X, ChevronLeft, ChevronRight, Maximize2, Minimize2, BookOpen, MessageSquareText, Volume2, VolumeX, Sparkles, MoreHorizontal, Library, LayoutDashboard, Info, Rows3, LogIn } from 'lucide-react';
import { PanelDialogue } from './PanelDialogue';
import { derivePanelTitle } from '../services/panelDescription';
import { readerDialogueBlocks } from '../services/dialogueUtils';
import { loadReaderState, saveReaderState } from '../services/db';

import { ReviewModal } from './modals/ReviewModal';
import { submitReview } from '../services/db';
import { useAuth } from '../contexts/AuthContext';
import { StaticSiteHeader } from './layout/StaticSiteHeader';
import { LegalMicroLinks } from './layout/LegalMicroLinks';
import { isStudioV4Project } from '../services/studioDeepLink';
import { lazyImportWithRetry } from '../services/lazyImportWithRetry';
import {
  IOS_FULLSCREEN_NOTE,
  enterFullscreen,
  exitFullscreen,
  isFullscreenActive,
  markIosFullscreenNoteSeen,
  onFullscreenChange,
  shouldShowIosFullscreenNote
} from '../services/fullscreen';

// Phones read in a "phone reading mode": no site header or footer inside the reader, Close and Full screen pinned
// as 44 px controls, everything else in one "⋯" menu, chrome that gets out of the way. Coarse pointer covers
// phones and tablets; the width test covers narrow desktop windows.
const PHONE_QUERY = '(pointer: coarse), (max-width: 639.98px)';
const CHROME_AUTO_HIDE_MS = 2500;
// Page Flip on phones: the dialogue goes UNDER the art (never beside it, where it ran off-screen) and the art gets
// the rest of the page region. The dialogue may take at most this share of the region's height (less in landscape,
// so the art stays large), and scrolls inside itself beyond that.
const FLIP_DIALOGUE_MAX_SHARE = 0.4;
const FLIP_DIALOGUE_MAX_SHARE_SHORT = 0.35;
const FLIP_SHORT_REGION_PX = 480;
const FLIP_GAP_PX = 8;
const FLIP_DIALOGUE_MAX_W = 576;
/** A horizontal drag at least this long (and mostly horizontal) turns a Page Flip page. */
const SWIPE_MIN_PX = 45;
/** Pinch-zoomed in: drags pan the page instead of turning it. */
const isViewportZoomed = (): boolean => typeof window !== 'undefined' && (window.visualViewport?.scale ?? 1) > 1.01;
const PHONE_BTN =
  'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45';
const PHONE_MENU_ITEM =
  'flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 text-left text-[14px] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45';
/** Chrome that fades away (reduced motion: no animation, it just goes). */
const chromeFade = (hidden: boolean) =>
  `transition-[opacity,transform,visibility] duration-200 motion-reduce:transition-none ${hidden ? 'invisible opacity-0 pointer-events-none' : 'visible opacity-100'}`;

const useMediaQuery = (query: string): boolean => {
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [query]);
  return matches;
};

/** A full-screen sheet for Story / Info on phones (desktop keeps its inline panels). */
const PhoneSheet: React.FC<{ title: string; onClose: () => void; children: React.ReactNode }> = ({ title, onClose, children }) => (
  <div
    role="dialog"
    aria-modal="true"
    aria-label={title}
    className="fixed inset-0 z-40 flex flex-col bg-white text-slate-900"
    style={{ paddingTop: 'var(--sa-top)', paddingBottom: 'var(--sa-bottom)', paddingLeft: 'var(--sa-left)', paddingRight: 'var(--sa-right)' }}
  >
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--ds-hairline)] pl-4 pr-1">
      <h2 className="min-w-0 truncate py-3 text-[17px] font-semibold tracking-tight">{title}</h2>
      <button type="button" onClick={onClose} className={PHONE_BTN} aria-label={`Close ${title}`}>
        <X className="h-5 w-5" />
      </button>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">{children}</div>
  </div>
);

// ── Back closes the reader ──────────────────────────────────────────────────────────────────────────────────
// The app pushes ?view=read&id=… when a comic opens but never listens for Back, so on phones the Back gesture
// changed the URL under an open reader and a second Back left the site. The reader now pushes ONE entry of its
// own (same URL, state[READER_KEY] = project id); popping it (Back) closes the reader. The reading mode adds a
// second entry so Back leaves it first. Every exit the reader controls (Close, the review prompt, Library, the
// header, legal links) pops the reader's entries before acting, so a later Back never lands on a stale entry.
const READER_KEY = '__dsReader';
const READING_KEY = '__dsReadingMode';
/** If a requested traversal never reports back (no popstate), the exit still happens after this long. */
const HISTORY_SETTLE_MS = 800;

const historyState = (): Record<string, unknown> => {
  try {
    const s: unknown = window.history.state;
    return s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

interface ReaderHistory {
  /**
   * Leave the reader (close or navigate away): pop the reader's entries first, then run `action` once. A navigation
   * (`final: false`) re-arms the reader afterwards, so if the app keeps it open its controls still work.
   */
  leave: (action: () => void, opts?: { final?: boolean }) => void;
  /** The reading mode gets its own entry so the Back gesture leaves it before it closes the comic. */
  pushReadingMode: () => void;
  /** Leaving the reading mode with a control pops its entry (no-op when Back already did). */
  popReadingMode: () => void;
}

const useReaderHistory = (id: string, onBack: () => void, onReadingModeBack?: () => void): ReaderHistory => {
  const onBackRef = useRef(onBack);
  const onReadingModeBackRef = useRef(onReadingModeBack);
  onBackRef.current = onBack;
  onReadingModeBackRef.current = onReadingModeBack;
  const pendingRef = useRef<{ action: () => void; final: boolean } | null>(null);
  const inFlightRef = useRef(false);
  const doneRef = useRef(false);
  const settleTimerRef = useRef<number | null>(null);

  const ours = (s = historyState()) => s[READER_KEY] === id;

  const runPending = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    doneRef.current = true;
    if (settleTimerRef.current != null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
    pending.action();
    if (!pending.final) doneRef.current = false;
  }, []);

  const goBack = useCallback(() => {
    inFlightRef.current = true;
    try {
      window.history.back();
    } catch {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.history) return;
    doneRef.current = false;
    // StrictMode (mount, unmount, mount) or a re-render with the same comic adopts the entry it already pushed.
    if (!ours()) {
      try {
        const next: Record<string, unknown> = { ...historyState(), [READER_KEY]: id };
        delete next[READING_KEY];
        window.history.pushState(next, '', window.location.href);
      } catch {
        /* history unavailable (sandboxed frame): exits still work, Back just isn't intercepted */
      }
    }
    const onPop = () => {
      inFlightRef.current = false;
      const s = historyState();
      if (pendingRef.current) {
        // Still on one of ours (the reading-mode entry, then the reader entry): keep unwinding, one step at a time.
        if (ours(s)) goBack();
        else runPending();
        return;
      }
      if (doneRef.current) return;
      if (!ours(s)) {
        // The reader's entry was popped by Back: close (no review prompt in the way of a Back gesture).
        doneRef.current = true;
        onBackRef.current();
        return;
      }
      if (s[READING_KEY] !== true) onReadingModeBackRef.current?.();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(
    () => () => {
      if (settleTimerRef.current != null) window.clearTimeout(settleTimerRef.current);
    },
    []
  );

  const leave = useCallback(
    (action: () => void, opts?: { final?: boolean }) => {
      if (doneRef.current) return;
      pendingRef.current = { action, final: opts?.final ?? true };
      if (inFlightRef.current) return; // the traversal already under way continues the unwinding when it lands
      if (!ours()) {
        runPending();
        return;
      }
      if (settleTimerRef.current == null) settleTimerRef.current = window.setTimeout(runPending, HISTORY_SETTLE_MS);
      goBack();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, goBack, runPending]
  );

  const pushReadingMode = useCallback(() => {
    const s = historyState();
    if (!ours(s) || s[READING_KEY] === true || doneRef.current) return;
    try {
      window.history.pushState({ ...s, [READING_KEY]: true }, '', window.location.href);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const popReadingMode = useCallback(() => {
    if (inFlightRef.current || doneRef.current) return;
    const s = historyState();
    if (ours(s) && s[READING_KEY] === true) goBack();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, goBack]);

  return { leave, pushReadingMode, popReadingMode };
};

// Comic Studio v4 comics (state.studioVersion === 4) keep their pages in a server-side
// ComicDoc, not in the legacy panels this reader draws — they read in the v4 reader.
const PublicComicReader = lazyImportWithRetry(() =>
  import('./comicstudio/PublicComicReader').then((module) => ({ default: module.PublicComicReader }))
);

// Reveals its children with a comic "pop-in" the first time they scroll into view.
const RevealOnScroll: React.FC<{ className?: string; children: React.ReactNode }> = ({ className, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    // Degrade gracefully where IntersectionObserver isn't available (jsdom/SSR): just show.
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) { setVisible(true); io.disconnect(); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);
  return (
    <div ref={ref} className={`comic-reveal ${visible ? 'is-visible' : ''} ${className || ''}`}>
      {children}
    </div>
  );
};

// A short, soft "page turn" using WebAudio (filtered noise burst) — no asset needed.
const playPageTurnSound = () => {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const duration = 0.18;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * duration), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      // Decaying noise = paper rustle.
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2.5);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1600;
    filter.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.value = 0.18;
    src.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
    src.start();
    src.stop(ctx.currentTime + duration);
    src.onended = () => ctx.close().catch(() => undefined);
  } catch {
    /* audio not available — ignore */
  }
};

interface ComicReaderProps {
  project: Project;
  onClose: () => void;
  onUpdateProject: (projectId: string, updates: Partial<Project> | ((prev: Project) => Partial<Project>)) => void;
  isReadOnly?: boolean;
  allowDownload?: boolean;
  onNavigate?: (view: string, id?: string) => void;
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
  onOpenFaq: () => void;
}

/**
 * Reader entry point for every comic link (/?view=read&id=…, the public gallery, the
 * dashboard's Read). Classic comics render below; v4 studio comics delegate to the v4
 * PublicComicReader, which loads the published doc (or the signed-in owner's own,
 * unpublished one) from /api/comic/public/:id.
 */
export const ComicReader: React.FC<ComicReaderProps> = (props) => {
  if (isStudioV4Project(props.project)) return <StudioComicReader projectId={props.project.id} onClose={props.onClose} />;
  return <ClassicComicReader {...props} />;
};

const StudioComicReader: React.FC<{ projectId: string; onClose: () => void }> = ({ projectId, onClose }) => {
  const history = useReaderHistory(projectId, onClose);
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[var(--ds-canvas)]" data-testid="studio-comic-reader">
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-sm text-[var(--ds-muted)]" role="status">
            Opening the comic…
          </div>
        }
      >
        <PublicComicReader projectId={projectId} onClose={() => history.leave(onClose)} />
      </Suspense>
    </div>
  );
};

const ClassicComicReader: React.FC<ComicReaderProps> = ({
  project,
  onClose,
  onUpdateProject,
  isReadOnly = false,
  allowDownload = true,
  onNavigate,
  onOpenPrivacy,
  onOpenTerms,
  onOpenFaq
}) => {
  const { user } = useAuth();
  const [showStory, setShowStory] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [readerMode, setReaderMode] = useState<'scroll' | 'flip'>('scroll');
  // Comic-feel toggles, remembered across sessions.
  const [soundOn, setSoundOn] = useState<boolean>(() => {
    try { return window.localStorage.getItem('reader_sound') !== 'off'; } catch { return true; }
  });
  const [fxOn, setFxOn] = useState<boolean>(() => {
    try { return window.localStorage.getItem('reader_fx') === 'on'; } catch { return false; }
  });
  const toggleSound = () => setSoundOn((prev) => {
    const next = !prev;
    try { window.localStorage.setItem('reader_sound', next ? 'on' : 'off'); } catch { /* ignore */ }
    return next;
  });
  const toggleFx = () => setFxOn((prev) => {
    const next = !prev;
    try { window.localStorage.setItem('reader_fx', next ? 'on' : 'off'); } catch { /* ignore */ }
    return next;
  });
  // ... existing state ...

  // Review Trigger Logic
  const handleAttemptClose = () => {
    // Only prompt for read-only (public) comics, and 30% chance, and ensure we haven't already reviewed (locally tracked for session)
    // For MVP, just random check.
    const shouldPrompt = isReadOnly && Math.random() < 0.3;

    if (shouldPrompt) {
      setShowReviewModal(true);
    } else {
      readerHistory.leave(onClose);
    }
  };

  const handleReviewSubmit = async (data: any) => {
    await submitReview({
      ...data,
      projectId: project.id
    });
    readerHistory.leave(onClose); // Close after review
  };

  const [pageIndex, setPageIndex] = useState(0);
  const [flipDirection, setFlipDirection] = useState<'next' | 'prev' | null>(null);
  // Full screen: native state comes only from fullscreenchange; the reading mode is the fallback when the
  // browser has no API (iPhone) or refuses. Either one counts as "full screen" for the button label.
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [readingMode, setReadingMode] = useState(false);
  const isFullscreen = nativeFullscreen || readingMode;
  const [showIosNote, setShowIosNote] = useState(false);
  const phoneUi = useMediaQuery(PHONE_QUERY);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [chromeTick, setChromeTick] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const chromeHidden = phoneUi && !chromeVisible;
  // Back pops the reading mode first (its controls come back), then closes the comic.
  const readerHistory = useReaderHistory(project.id, onClose, () => {
    setReadingMode(false);
    setChromeVisible(true);
    setChromeTick((n) => n + 1);
  });
  /** Navigation out of the reader pops the reader's history entries first. */
  const leaveTo = (fn: () => void) => () => readerHistory.leave(fn, { final: false });
  const navigate = (view: string, id?: string) =>
    readerHistory.leave(() => (id === undefined ? onNavigate?.(view) : onNavigate?.(view, id)), { final: false });
  // On phones, multi-column comic grids (3-up splash, golden-ratio, etc.) are unreadable,
  // so we collapse every layout to a single vertical column — the standard way comics are
  // read on mobile. Tracked reactively so rotating the device re-flows immediately.
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const on = () => setIsNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  // Phone Page Flip geometry, measured (percentage heights do not chain reliably through the flip page).
  const [flipRegion, setFlipRegion] = useState<HTMLDivElement | null>(null);
  const [flipBox, setFlipBox] = useState<{ w: number; h: number } | null>(null);
  const [flipDialogue, setFlipDialogue] = useState<HTMLDivElement | null>(null);
  const [flipDialogueH, setFlipDialogueH] = useState(0);
  useLayoutEffect(() => {
    if (!flipRegion) {
      setFlipBox(null);
      return;
    }
    const read = () => {
      const cs = window.getComputedStyle(flipRegion);
      const w = Math.floor(flipRegion.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0));
      const h = Math.floor(flipRegion.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0));
      if (w <= 0 || h <= 0) return;
      setFlipBox((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(flipRegion);
    return () => ro.disconnect();
  }, [flipRegion]);
  useLayoutEffect(() => {
    if (!flipDialogue) {
      setFlipDialogueH(0);
      return;
    }
    const read = () => setFlipDialogueH(Math.ceil(flipDialogue.offsetHeight));
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(flipDialogue);
    return () => ro.disconnect();
  }, [flipDialogue]);
  const flipDialogueMax = flipBox
    ? Math.round(flipBox.h * (flipBox.h < FLIP_SHORT_REGION_PX ? FLIP_DIALOGUE_MAX_SHARE_SHORT : FLIP_DIALOGUE_MAX_SHARE))
    : null;
  const flipArtMaxH = flipBox ? Math.max(80, flipBox.h - (flipDialogue ? Math.min(flipDialogueH, flipDialogueMax ?? 0) + FLIP_GAP_PX : 0)) : null;
  const readerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<number | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const touchMulti = useRef(false);
  const textLayout = project.state.textLayout || 'caption';
  const panelCount = project.state.panels.length;
  const panelsWithArtCount = project.state.panels.filter((panel) => !!panel.imageUrl).length;
  const allPanelsMissingArt = panelCount > 0 && panelsWithArtCount === 0;

  useEffect(() => {
    loadReaderState(project.id).then((state) => {
      if (!state) return;
      setReaderMode(state.mode);
      if (typeof state.pageIndex === 'number') setPageIndex(state.pageIndex);
      if (typeof state.scrollTop === 'number') {
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = state.scrollTop || 0;
        });
      }
    });
  }, [project.id]);

  useEffect(() => onFullscreenChange(() => setNativeFullscreen(isFullscreenActive(readerRef.current))), []);

  // Entering native full screen on a phone is a "just let me read" gesture: get the chrome out of the way.
  useEffect(() => {
    if (nativeFullscreen && phoneUi) setChromeVisible(false);
  }, [nativeFullscreen, phoneUi]);

  // Reading mode locks the page behind the reader (no rubber-band scrolling of the site underneath).
  useEffect(() => {
    if (!readingMode) return;
    const html = document.documentElement;
    const body = document.body;
    const prev = [html.style.overflow, body.style.overflow];
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    return () => {
      html.style.overflow = prev[0];
      body.style.overflow = prev[1];
    };
  }, [readingMode]);

  // Phone chrome hides itself after a moment of reading, unless a menu or sheet is open.
  const chromePinned = menuOpen || showInfo || showStory || showComments || showReviewModal || showIosNote;
  useEffect(() => {
    if (!phoneUi || !chromeVisible || chromePinned) return;
    const timer = window.setTimeout(() => setChromeVisible(false), CHROME_AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [phoneUi, chromeVisible, chromePinned, chromeTick, readerMode, pageIndex]);

	  const pages = useMemo(() => {
	    const list: Array<{ type: 'cover' | 'panel' | 'page'; panel?: ComicPanel; imageUrl?: string }> = [];
	    if (project.state.coverImageUrl) {
	      list.push({ type: 'cover', imageUrl: project.state.coverImageUrl });
	    }
	    project.state.panels.forEach((panel) => {
	      list.push({ type: 'panel', panel, imageUrl: panel.imageUrl });
	    });
	    project.state.pageStudio?.pages?.forEach((page) => {
	      list.push({ type: 'page', imageUrl: page.imageUrl });
	    });
	    return list;
	  }, [project.state.coverImageUrl, project.state.panels, project.state.pageStudio?.pages]);
  const flipHasDialogue = useMemo(() => {
    const panel = pages[pageIndex]?.panel;
    return !!panel && textLayout !== 'none' && readerDialogueBlocks(panel).length > 0;
  }, [pages, pageIndex, textLayout]);

  // Preload nearby page images so a flip (forward OR back) never flashes blank.
  useEffect(() => {
    const list = pages;
    const PRELOAD_AHEAD = 3;
    const preload = (url?: string) => { if (url) { const img = new Image(); img.src = url; } };
    if (readerMode === 'flip') {
      preload(list[pageIndex - 1]?.imageUrl);
      for (let i = pageIndex + 1; i < Math.min(pageIndex + 1 + PRELOAD_AHEAD, list.length); i++) {
        preload(list[i]?.imageUrl);
      }
    } else {
      list.forEach((p) => preload(p.imageUrl));
    }
  }, [pageIndex, readerMode, pages]);

  useEffect(() => {
    return () => {
      persistReaderState();
    };
  }, []);

  useEffect(() => {
    persistReaderState({ mode: readerMode, pageIndex });
  }, [readerMode]);

  const persistReaderState = (override?: Partial<{ mode: 'scroll' | 'flip'; pageIndex: number; scrollTop: number }>) => {
    const payload = {
      projectId: project.id,
      mode: override?.mode ?? readerMode,
      pageIndex: override?.pageIndex ?? pageIndex,
      scrollTop: override?.scrollTop ?? (scrollRef.current?.scrollTop || 0),
      updatedAt: Date.now()
    };
    saveReaderState(payload);
  };

  // renderPanelText removed — use <PanelDialogue /> component instead

  // Grid layouts use `auto-rows-auto` + `items-start` so every cell is exactly as tall as
  // its image — images keep their true aspect ratio instead of being squashed/cropped into
  // fixed-pixel rows (the old `auto-rows-[200px]` / `auto-rows-fr` is what made panels look
  // "never rightfully sized"). `items-start` stops short panels from stretching to match
  // taller neighbours.
  const getLayoutClass = () => {
    if (isNarrow) return 'flex flex-col items-center gap-4';
    switch (project.state.layoutType) {
      case 'webtoon': return 'flex flex-col items-center gap-4';
      case 'strip': return 'flex flex-col gap-3';
      case 'graphic_novel': return 'grid grid-cols-2 lg:grid-cols-3 gap-4 auto-rows-auto items-start';
      case 'conversation_grid': return 'grid grid-cols-2 gap-4 auto-rows-auto items-start';
      case 'splash_insets': return 'grid grid-cols-2 lg:grid-cols-3 gap-4 auto-rows-auto items-start';
      case 'golden_ratio': return 'grid grid-cols-2 lg:grid-cols-3 gap-4 auto-rows-auto items-start';
      case 'diagonal_action': return 'grid grid-cols-2 gap-4 auto-rows-auto items-start';
      case 'storyboard': return 'grid grid-cols-2 lg:grid-cols-3 gap-3 auto-rows-auto items-start';
      case 'manga': return 'grid grid-cols-2 gap-4 auto-rows-auto items-start';
      case 'cinematic': return 'flex flex-col items-center gap-4';
      case 'grid':
      case 'custom':
      default:
        return 'grid grid-cols-1 md:grid-cols-2 gap-6 auto-rows-auto items-start';
    }
  };

  // Only horizontal emphasis (col-span) survives — row-span needs fixed row heights, which
  // we removed, and it was the other half of the distortion. A full-width "splash" panel
  // still reads as a hero shot; the rest flow naturally at their own aspect ratios.
  const getPanelClass = (idx: number) => {
    if (isNarrow) return 'w-full max-w-xl';
    switch (project.state.layoutType) {
      case 'splash_insets':
        return idx === 0 ? 'col-span-2 lg:col-span-3' : 'col-span-1';
      case 'golden_ratio':
        return idx === 0 ? 'col-span-2' : 'col-span-1';
      case 'diagonal_action':
        return idx % 3 === 0 ? 'col-span-2' : 'col-span-1';
      case 'graphic_novel':
        return idx % 4 === 0 ? 'col-span-2' : 'col-span-1';
      default:
        return 'col-span-1';
    }
  };

  useEffect(() => {
    if (pageIndex >= pages.length && pages.length > 0) {
      setPageIndex(pages.length - 1);
    }
  }, [pages.length]);

  const handleScroll = () => {
    if (readerMode !== 'scroll') return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      persistReaderState({ scrollTop: scrollRef.current?.scrollTop || 0 });
    }, 400);
  };

  const goNext = () => {
    if (pageIndex >= pages.length - 1) return;
    if (soundOn) playPageTurnSound();
    setFlipDirection('next');
    setPageIndex((prev) => {
      const next = prev + 1;
      persistReaderState({ pageIndex: next, mode: 'flip' });
      return next;
    });
  };

  const goPrev = () => {
    if (pageIndex <= 0) return;
    if (soundOn) playPageTurnSound();
    setFlipDirection('prev');
    setPageIndex((prev) => {
      const next = prev - 1;
      persistReaderState({ pageIndex: next, mode: 'flip' });
      return next;
    });
  };

  useEffect(() => {
    if (!flipDirection) return;
    // Match the 0.45s page-flip animation so the transform isn't cleared mid-turn.
    const timer = window.setTimeout(() => setFlipDirection(null), 470);
    return () => window.clearTimeout(timer);
  }, [flipDirection]);

  // Touch swipe in flip mode (a horizontal drag turns the page). Safe gestures: a pinch never turns a page, whichever
  // finger lifts first (once a second finger touched down, the gesture is spent until every finger is up); while the
  // page is zoomed in (visualViewport.scale > 1.01) drags pan the zoomed page and never turn it; a mostly vertical drag
  // (scrolling the dialogue under the art) is not a swipe.
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length > 1) {
      touchMulti.current = true;
      touchStart.current = null;
      return;
    }
    touchMulti.current = false;
    const t = e.touches[0];
    touchStart.current = t ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length > 1) {
      touchMulti.current = true;
      touchStart.current = null;
    }
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchStart.current;
    if (touchMulti.current || e.touches.length > 0) {
      touchStart.current = null;
      if (e.touches.length === 0) touchMulti.current = false;
      return;
    }
    touchStart.current = null;
    if (!start || isViewportZoomed()) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    if (dx < 0) goNext(); else goPrev();
  };
  const onTouchCancel = () => {
    touchStart.current = null;
    touchMulti.current = false;
  };

  // Keyboard navigation: arrows/space/PageUp-Down turn pages (flip) or page-scroll
  // (scroll), Home/End jump to ends, Esc closes. Ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape') {
        // Esc peels one layer at a time: the menu, then the reading mode, then the comic.
        if (menuOpen) { setMenuOpen(false); return; }
        if (readingMode) { exitReadingMode(); return; }
        handleAttemptClose();
        return;
      }
      if (readerMode === 'flip') {
        if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); goNext(); }
        else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goPrev(); }
        else if (e.key === 'Home') { e.preventDefault(); setFlipDirection('prev'); setPageIndex(0); }
        else if (e.key === 'End') { e.preventDefault(); setFlipDirection('next'); setPageIndex(Math.max(pages.length - 1, 0)); }
      } else {
        const el = scrollRef.current;
        if (!el) return;
        const page = el.clientHeight * 0.9;
        if (e.key === 'ArrowDown') { e.preventDefault(); el.scrollBy({ top: 140, behavior: 'smooth' }); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); el.scrollBy({ top: -140, behavior: 'smooth' }); }
        else if (e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); el.scrollBy({ top: page, behavior: 'smooth' }); }
        else if (e.key === 'PageUp') { e.preventDefault(); el.scrollBy({ top: -page, behavior: 'smooth' }); }
        else if (e.key === 'Home') { e.preventDefault(); el.scrollTo({ top: 0, behavior: 'smooth' }); }
        else if (e.key === 'End') { e.preventDefault(); el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [readerMode, pageIndex, pages.length, menuOpen, readingMode]);

  const enterReadingMode = useCallback(() => {
    setReadingMode(true);
    setMenuOpen(false);
    setChromeVisible(false);
    readerHistory.pushReadingMode();
    if (shouldShowIosFullscreenNote()) {
      markIosFullscreenNoteSeen();
      setShowIosNote(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readerHistory.pushReadingMode]);

  // Leaving the reading mode brings the controls back (that is what the reader asked for by tapping Exit).
  const exitReadingMode = () => {
    readerHistory.popReadingMode();
    setReadingMode(false);
    setChromeVisible(true);
    setChromeTick((n) => n + 1);
  };

  // Called synchronously from the tap (the browser only grants full screen inside the user gesture). The label
  // never flips optimistically: native state arrives as fullscreenchange, the fallback sets readingMode.
  const toggleFullscreen = () => {
    if (readingMode) {
      exitReadingMode();
      return;
    }
    if (isFullscreenActive(readerRef.current)) {
      exitFullscreen();
      return;
    }
    enterFullscreen(readerRef.current, { onFallback: enterReadingMode });
  };

  // Phones: a tap on the art shows or hides the chrome (a tap with the menu open just closes the menu).
  const onArtTap = (e: React.MouseEvent) => {
    if (!phoneUi) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, select, [role="menu"]')) return;
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    setChromeVisible((v) => !v);
  };
  const showChrome = () => {
    setChromeVisible(true);
    setChromeTick((n) => n + 1);
  };
  const menuSelect = (fn: () => void) => () => {
    setMenuOpen(false);
    fn();
  };

  const infoDetails = (
    <div className="space-y-3 text-sm">
      <div>
        <div className="text-xs uppercase font-bold text-slate-500">Title</div>
        <div className="font-semibold">{project.name}</div>
      </div>
      <div>
        <div className="text-xs uppercase font-bold text-slate-500">Author</div>
        <div>{project.authorName || 'Unknown creator'}</div>
      </div>
      <div>
        <div className="text-xs uppercase font-bold text-slate-500">Published</div>
        <div>
          {project.isPublic
            ? new Date(project.publishedAt || project.createdAt).toLocaleDateString()
            : 'Not public yet'}
        </div>
      </div>
      <div>
        <div className="text-xs uppercase font-bold text-slate-500">Overview</div>
        <p className="text-slate-700 whitespace-pre-wrap">{project.state.overview || 'No overview added yet.'}</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="border border-slate-200 rounded p-2">
          <div className="text-xs uppercase font-bold text-slate-500">Panels</div>
          <div>{project.state.panels.length}</div>
        </div>
        <div className="border border-slate-200 rounded p-2">
          <div className="text-xs uppercase font-bold text-slate-500">Layout</div>
          <div>{project.state.layoutType || 'grid'}</div>
        </div>
      </div>
      {project.state.storyMood && (
        <div className="border border-slate-200 rounded p-2">
          <div className="text-xs uppercase font-bold text-slate-500">Mood the AI read</div>
          <div className="font-semibold">{project.state.storyMood.label}</div>
          <div className="text-xs text-slate-500 mt-0.5">{project.state.storyMood.summary}</div>
        </div>
      )}
    </div>
  );

  const storyText = (
    <pre className="whitespace-pre-wrap font-comic text-sm text-slate-700">{project.state.script || "No story text yet."}</pre>
  );

  return (
    <div
      ref={readerRef}
      className="fixed inset-0 z-50 bg-slate-100 overflow-hidden flex flex-col"
      data-testid="classic-reader"
      data-phone={phoneUi ? 'true' : 'false'}
      data-reading-mode={readingMode ? 'true' : 'false'}
      data-chrome={chromeHidden || (!phoneUi && readingMode) ? 'hidden' : 'visible'}
      style={
        phoneUi
          ? {
              // Edge-to-edge on notched phones (viewport-fit=cover): keep the art out of the cut-outs.
              paddingLeft: 'var(--sa-left)',
              paddingRight: 'var(--sa-right)',
              ...(readingMode ? { height: '100dvh', bottom: 'auto' } : null)
            }
          : readingMode
            ? { height: '100dvh', bottom: 'auto' }
            : undefined
      }
    >
      {phoneUi && (
        // Screen readers and keyboards can always bring the chrome back, even while it is hidden.
        <button type="button" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-full focus:bg-white focus:px-3 focus:py-2" onClick={showChrome}>
          Show reader controls
        </button>
      )}
      {!phoneUi && !readingMode && (
      <StaticSiteHeader
        isAuthenticated={!!user}
        onGoHome={() => navigate('home')}
        onViewComics={() => navigate('gallery')}
        onEnterStudio={() => navigate('dashboard')}
        onSignIn={() => navigate('auth')}
        onOpenProfile={() => navigate('settings')}
        onNavigate={navigate}
      />
      )}

      {phoneUi && (
        <header
          data-testid="reader-phone-bar"
          aria-hidden={chromeHidden || undefined}
          className={`absolute inset-x-0 top-0 z-30 border-b border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] backdrop-blur-md ${chromeFade(chromeHidden)} ${chromeHidden ? '-translate-y-full' : 'translate-y-0'}`}
          style={{ paddingTop: 'var(--sa-top)', paddingLeft: 'calc(var(--sa-left) + 12px)', paddingRight: 'calc(var(--sa-right) + 4px)' }}
          onPointerDown={() => setChromeTick((n) => n + 1)}
        >
          <div className="flex min-h-[48px] items-center gap-1">
            <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-[var(--ds-ink)]">{project.name}</h1>
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              className={PHONE_BTN}
              aria-label="More reader options"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <MoreHorizontal className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={toggleFullscreen}
              className={PHONE_BTN}
              aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
              aria-pressed={isFullscreen}
            >
              {isFullscreen ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
            </button>
            <button type="button" onClick={handleAttemptClose} className={PHONE_BTN} aria-label="Close reader">
              <X className="h-6 w-6" />
            </button>
          </div>
        </header>
      )}

      {phoneUi && menuOpen && (
        <div
          role="menu"
          aria-label="Reader options"
          className="absolute right-2 z-40 w-60 max-w-[calc(100%-16px)] overflow-y-auto overscroll-contain rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] p-1 shadow-[0_12px_40px_rgba(0,0,0,0.18)] backdrop-blur-md"
          style={{ top: 'calc(var(--sa-top) + 52px)', maxHeight: 'calc(100dvh - var(--sa-top) - 64px)' }}
        >
          <button type="button" role="menuitem" className={PHONE_MENU_ITEM} onClick={menuSelect(() => navigate('gallery'))}>
            <Library className="h-4 w-4 shrink-0" aria-hidden /> Library
          </button>
          <button type="button" role="menuitem" className={PHONE_MENU_ITEM} onClick={menuSelect(() => navigate('dashboard'))}>
            <LayoutDashboard className="h-4 w-4 shrink-0" aria-hidden /> Dashboard
          </button>
          <button type="button" role="menuitem" className={PHONE_MENU_ITEM} onClick={menuSelect(() => setShowStory(true))}>
            <BookOpen className="h-4 w-4 shrink-0" aria-hidden /> Story
          </button>
          <button type="button" role="menuitem" className={PHONE_MENU_ITEM} onClick={menuSelect(() => setShowInfo(true))}>
            <Info className="h-4 w-4 shrink-0" aria-hidden /> Info
          </button>
          <button type="button" role="menuitem" className={PHONE_MENU_ITEM} onClick={menuSelect(() => setShowComments(true))}>
            <MessageSquareText className="h-4 w-4 shrink-0" aria-hidden /> Comments
          </button>
          <button type="button" role="menuitem" className={PHONE_MENU_ITEM} onClick={menuSelect(() => setReaderMode(readerMode === 'scroll' ? 'flip' : 'scroll'))}>
            {readerMode === 'scroll' ? <BookOpen className="h-4 w-4 shrink-0" aria-hidden /> : <Rows3 className="h-4 w-4 shrink-0" aria-hidden />}
            {readerMode === 'scroll' ? 'Page Flip' : 'Scroll'}
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={fxOn} className={PHONE_MENU_ITEM} onClick={toggleFx}>
            <Sparkles className="h-4 w-4 shrink-0" aria-hidden /> FX (halftone texture)
            <span className="ml-auto text-[12px] text-[var(--ds-muted)]">{fxOn ? 'On' : 'Off'}</span>
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={soundOn} className={PHONE_MENU_ITEM} onClick={toggleSound}>
            {soundOn ? <Volume2 className="h-4 w-4 shrink-0" aria-hidden /> : <VolumeX className="h-4 w-4 shrink-0" aria-hidden />} Page-turn sound
            <span className="ml-auto text-[12px] text-[var(--ds-muted)]">{soundOn ? 'On' : 'Off'}</span>
          </button>
          {!user && (
            <button type="button" role="menuitem" className={PHONE_MENU_ITEM} onClick={menuSelect(() => navigate('auth'))}>
              <LogIn className="h-4 w-4 shrink-0" aria-hidden /> Sign in
            </button>
          )}
        </div>
      )}

      {((readingMode && (!phoneUi || chromeHidden)) || (nativeFullscreen && phoneUi && chromeHidden)) && (
        // The way out of full screen (the reading mode, or native full screen on a phone): always on screen while the
        // chrome is away (the bar's own toggle takes over when the chrome is showing).
        <button
          type="button"
          onClick={toggleFullscreen}
          aria-label="Exit full screen"
          className="absolute z-40 inline-flex h-11 min-w-[44px] items-center justify-center gap-1.5 rounded-full bg-black/60 px-3 text-[13px] font-semibold text-white backdrop-blur-md hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          style={{ top: 'calc(var(--sa-top) + 8px)', right: 'calc(var(--sa-right) + 8px)' }}
        >
          <Minimize2 className="h-4 w-4" aria-hidden /> Exit
        </button>
      )}

      {showIosNote && (
        <div
          role="status"
          className="absolute inset-x-3 z-40 mx-auto max-w-sm rounded-2xl bg-black/80 p-3 text-[13px] leading-snug text-white shadow-lg backdrop-blur-md"
          style={{ bottom: 'calc(var(--sa-bottom) + 16px)' }}
        >
          <p>{IOS_FULLSCREEN_NOTE}</p>
          <div className="mt-1 flex justify-end">
            <button type="button" onClick={() => setShowIosNote(false)} className="min-h-[44px] rounded-full bg-white/15 px-4 text-[13px] font-semibold hover:bg-white/25">
              Got it
            </button>
          </div>
        </div>
      )}

      {/* Reader Controls */}
      {!phoneUi && !readingMode && (
      <header className="h-16 bg-white border-b-4 border-black flex items-center justify-between gap-2 px-3 sm:px-6 shadow-lg shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="font-display text-lg sm:text-2xl text-black truncate">{project.name}</h1>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button
            onClick={() => navigate('gallery')}
            className="text-xs font-bold border-2 border-black rounded-lg px-3 py-1 shrink-0 whitespace-nowrap bg-slate-50"
          >
            Library
          </button>
          <button
            onClick={() => navigate('dashboard')}
            className="text-xs font-bold border-2 border-black rounded-lg px-3 py-1 shrink-0 whitespace-nowrap bg-slate-50"
          >
            Dashboard
          </button>
          <button
            onClick={() => setShowStory((prev) => !prev)}
            className="text-xs font-bold border-2 border-black rounded-lg px-3 py-1 shrink-0 whitespace-nowrap bg-slate-50 flex items-center gap-1"
          >
            <BookOpen className="w-4 h-4" /> Story
          </button>
          <button
            onClick={() => setShowInfo((prev) => !prev)}
            className="text-xs font-bold border-2 border-black rounded-lg px-3 py-1 shrink-0 whitespace-nowrap bg-slate-50"
          >
            Info
          </button>
          <button
            onClick={() => setShowComments((prev) => !prev)}
            className="text-xs font-bold border-2 border-black rounded-lg px-3 py-1 shrink-0 whitespace-nowrap bg-slate-50 flex items-center gap-1"
          >
            <MessageSquareText className="w-4 h-4" /> Comments
          </button>
          <button
            onClick={() => setReaderMode(readerMode === 'scroll' ? 'flip' : 'scroll')}
            className="text-xs font-bold border-2 border-black rounded-lg px-3 py-1 shrink-0 whitespace-nowrap bg-brand-yellow"
          >
            {readerMode === 'scroll' ? 'Page Flip' : 'Scroll'}
          </button>
          <button
            onClick={toggleFx}
            title="Halftone comic texture"
            aria-pressed={fxOn}
            className={`text-xs font-bold border-2 border-black rounded-lg px-3 py-1 shrink-0 whitespace-nowrap flex items-center gap-1 ${fxOn ? 'bg-brand-blue text-white' : 'bg-slate-50'}`}
          >
            <Sparkles className="w-4 h-4" /> FX
          </button>
          <button
            onClick={toggleSound}
            title={soundOn ? 'Mute page-turn sound' : 'Unmute page-turn sound'}
            aria-pressed={soundOn}
            className="text-xs font-bold border-2 border-black rounded-lg px-2 py-1 shrink-0 whitespace-nowrap bg-slate-50 flex items-center gap-1"
          >
            {soundOn ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </button>
          <button
            onClick={toggleFullscreen}
            className="text-xs font-bold border-2 border-black rounded-lg px-3 py-1 shrink-0 whitespace-nowrap bg-slate-50 flex items-center gap-1"
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            {isFullscreen ? 'Exit' : 'Full'}
          </button>
          <button onClick={handleAttemptClose} className="p-2 hover:bg-slate-100 rounded-full transition-colors shrink-0" aria-label="Close reader">
            <X className="w-6 h-6" />
          </button>
        </div>
      </header >
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* Main Comic Area */}
        <div className="flex-1 overflow-hidden bg-slate-200" onClick={onArtTap}>
          {readerMode === 'scroll' ? (
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className={phoneUi ? 'h-full overflow-y-auto overscroll-contain custom-scrollbar flex justify-center' : 'h-full overflow-y-auto custom-scrollbar p-4 md:p-8 flex justify-center'}
              // Phones: the art runs edge to edge under the floating bar (which hides itself while reading).
              style={phoneUi ? { paddingTop: 52, paddingBottom: 'calc(var(--sa-bottom) + 12px)' } : undefined}
            >
              <div className="max-w-4xl w-full bg-white shadow-2xl min-h-full">
                {showStory && !phoneUi && (
                  <div className="p-6 border-b-4 border-black bg-white">
                    <div className="border-2 border-black rounded-lg p-4 bg-slate-50">
                      <div className="text-xs font-bold uppercase text-slate-500 mb-2">Story</div>
                      <pre className="whitespace-pre-wrap font-comic text-sm text-slate-700">{project.state.script || "No story text yet."}</pre>
                    </div>
                  </div>
                )}
                {project.state.coverImageUrl && (
                  <div className="p-6 border-b-4 border-black bg-slate-100">
                    <div className="border-4 border-black rounded-lg overflow-hidden shadow-comic">
                      <img src={project.state.coverImageUrl} alt={`${project.name} cover`} className="block w-full h-auto animate-fade-in" />
                    </div>
                  </div>
                )}
	                <div className={`${phoneUi ? 'p-2' : 'p-4 sm:p-8'} ${getLayoutClass()}`}>
	                  {allPanelsMissingArt && (
	                    <div className="col-span-full text-center py-6 text-amber-700 font-bold border-2 border-amber-400 bg-amber-50 rounded-lg">
	                      All panel artwork is currently missing for this comic.
	                    </div>
	                  )}
                  {project.state.panels.map((panel, idx) => (
                    <RevealOnScroll key={idx} className={getPanelClass(idx)}>
                      <div className={`border-2 border-black shadow-sm relative ${fxOn ? 'comic-halftone' : ''}`}>
                        {panel.imageUrl ? (
                          <img src={panel.imageUrl} alt={derivePanelTitle(panel, idx)} loading="lazy" className="block w-full h-auto animate-fade-in" />
                        ) : (
                          <div className="w-full min-h-[280px] flex items-center justify-center bg-amber-50 text-amber-800 text-sm font-bold border-b-2 border-black">
                            Image missing for this panel
                          </div>
                        )}
                        {!panel.imageUrl && (
                          <div className="px-3 py-1 text-[11px] font-bold bg-amber-100 border-b border-amber-300 text-amber-800">
                            Dialogue shown without artwork
                          </div>
                        )}
                        <PanelDialogue panel={panel} layout={textLayout} />
	                      </div>
	                    </RevealOnScroll>
	                  ))}
	                  {project.state.panels.length === 0 && project.state.pageStudio?.pages?.map((page, idx) => (
	                    <RevealOnScroll key={page.id || idx} className="col-span-full">
	                      {page.imageUrl ? (
	                        <img src={page.imageUrl} alt={`${project.name} page ${idx + 1}`} loading="lazy" className="mx-auto block h-auto max-w-full animate-fade-in border-2 border-black shadow-sm" />
	                      ) : (
	                        <div className="w-full min-h-[280px] flex items-center justify-center bg-amber-50 text-amber-800 text-sm font-bold border-2 border-black">
	                          Image missing for this page
	                        </div>
	                      )}
	                    </RevealOnScroll>
	                  ))}
	                  {project.state.panels.length === 0 && (project.state.pageStudio?.pages?.length || 0) === 0 && (
	                    <div className="col-span-full text-center py-20 text-slate-400 font-display text-2xl">
	                      This comic hasn't been drawn yet!
	                    </div>
	                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className={phoneUi ? 'h-full flex flex-col' : 'h-full flex flex-col items-center p-2 sm:p-4'}>
              <div className={phoneUi ? 'relative flex flex-col w-full flex-1 min-h-0 bg-slate-100 overflow-hidden' : 'flex flex-col w-full max-w-5xl flex-1 min-h-0 bg-white shadow-2xl border-4 border-black rounded-xl overflow-hidden'}>
                {showStory && !phoneUi && (
                  <div className="p-4 border-b-4 border-black bg-white shrink-0 max-h-40 overflow-y-auto custom-scrollbar">
                    <div className="border-2 border-black rounded-lg p-3 bg-slate-50">
                      <div className="text-xs font-bold uppercase text-slate-500 mb-2">Story</div>
                      <pre className="whitespace-pre-wrap font-comic text-sm text-slate-700">{project.state.script || "No story text yet."}</pre>
                    </div>
                  </div>
                )}
                {pages.length > 0 && phoneUi ? (
                  // Phones: the art on top, its dialogue UNDER it (never beside it, off-screen), the art sized to what
                  // the dialogue leaves; the dialogue scrolls inside itself past its share of the height.
                  <div
                    ref={setFlipRegion}
                    data-testid="flip-region"
                    className="flex-1 min-h-0 flex items-center justify-center bg-slate-100 overflow-hidden p-2 select-none"
                    onTouchStart={onTouchStart}
                    onTouchMove={onTouchMove}
                    onTouchEnd={onTouchEnd}
                    onTouchCancel={onTouchCancel}
                  >
                    <div
                      key={pageIndex}
                      data-testid="flip-page"
                      className={`flex max-h-full w-full flex-col items-center ${flipDirection === 'next' ? 'animate-page-flip-next' : flipDirection === 'prev' ? 'animate-page-flip-prev' : ''}`}
                      style={{ gap: FLIP_GAP_PX }}
                    >
                      <div data-testid="flip-art" className={`relative inline-flex max-w-full shrink-0 ${fxOn ? 'comic-halftone' : ''}`}>
                        {pages[pageIndex]?.imageUrl ? (
                          <img
                            src={pages[pageIndex].imageUrl}
                            alt={pages[pageIndex]?.panel ? derivePanelTitle(pages[pageIndex].panel!, pageIndex) : pages[pageIndex]?.type === 'page' ? `${project.name} page ${pageIndex + 1}` : 'Comic cover'}
                            className="block max-h-full max-w-full w-auto h-auto object-contain border-2 border-black shadow-comic bg-white"
                            style={flipBox && flipArtMaxH ? { maxWidth: flipBox.w, maxHeight: flipArtMaxH } : undefined}
                          />
                        ) : (
                          <div className="w-[70vw] max-w-md min-h-[200px] flex items-center justify-center bg-amber-50 text-amber-800 text-sm font-bold border-2 border-black rounded">
                            {pages[pageIndex]?.type === 'panel' ? 'Image missing for this panel' : 'Image missing for this page'}
                          </div>
                        )}
                      </div>
                      {flipHasDialogue && (
                        <div
                          ref={setFlipDialogue}
                          data-testid="flip-dialogue"
                          className="w-full shrink-0 overflow-y-auto overscroll-contain"
                          style={{ maxWidth: FLIP_DIALOGUE_MAX_W, maxHeight: flipDialogueMax ?? `${FLIP_DIALOGUE_MAX_SHARE * 100}%` }}
                        >
                          <PanelDialogue panel={pages[pageIndex].panel!} layout={textLayout} placement="below" />
                        </div>
                      )}
                    </div>
                  </div>
                ) : pages.length > 0 ? (
                  // The page region flexes to fill remaining height; the page itself is bounded
                  // by BOTH max-h-full and max-w-full so it always scales to fit the viewport on
                  // either axis — never oversized, never leaving dead space.
                  <div
                    className={phoneUi ? 'flex-1 min-h-0 flex items-center justify-center bg-slate-100 overflow-hidden p-2 select-none' : 'flex-1 min-h-0 flex items-center justify-center bg-slate-100 overflow-hidden p-2 sm:p-3 select-none'}
                    onTouchStart={onTouchStart}
                    onTouchMove={onTouchMove}
                    onTouchEnd={onTouchEnd}
                    onTouchCancel={onTouchCancel}
                  >
                    <div
                      key={pageIndex}
                      className={`relative inline-flex max-h-full max-w-full ${fxOn ? 'comic-halftone' : ''} ${flipDirection === 'next' ? 'animate-page-flip-next' : flipDirection === 'prev' ? 'animate-page-flip-prev' : ''}`}
                    >
	                      {pages[pageIndex]?.imageUrl ? (
	                        <img
	                          src={pages[pageIndex].imageUrl}
	                          alt={pages[pageIndex]?.panel ? derivePanelTitle(pages[pageIndex].panel!, pageIndex) : pages[pageIndex]?.type === 'page' ? `${project.name} page ${pageIndex + 1}` : 'Comic cover'}
	                          className="block max-h-full max-w-full w-auto h-auto object-contain mx-auto border-2 border-black shadow-comic bg-white"
	                        />
                      ) : (
                        <div className="w-[70vw] max-w-md min-h-[300px] flex items-center justify-center bg-amber-50 text-amber-800 text-sm font-bold border-2 border-black rounded">
                          {pages[pageIndex]?.type === 'panel' ? 'Image missing for this panel' : 'Image missing for this page'}
                        </div>
                      )}
                      {pages[pageIndex]?.panel && <PanelDialogue panel={pages[pageIndex].panel!} layout={textLayout} />}
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center p-10 text-center text-slate-400 font-display text-2xl">This comic hasn't been drawn yet!</div>
                )}
                <div
                  className={phoneUi ? `absolute inset-x-0 bottom-0 z-20 border-t-4 border-black bg-slate-50 ${chromeFade(chromeHidden)} ${chromeHidden ? 'translate-y-full' : 'translate-y-0'}` : 'shrink-0 border-t-4 border-black bg-slate-50'}
                  style={phoneUi ? { paddingBottom: 'var(--sa-bottom)' } : undefined}
                  aria-hidden={chromeHidden || undefined}
                  onPointerDown={phoneUi ? () => setChromeTick((n) => n + 1) : undefined}
                >
                  <div className="h-1.5 bg-slate-200" aria-hidden>
                    <div className="h-full bg-brand-yellow transition-all duration-300" style={{ width: `${(Math.min(pageIndex + 1, pages.length) / Math.max(pages.length, 1)) * 100}%` }} />
                  </div>
                  <div className="flex items-center justify-between p-3">
                    <button onClick={goPrev} disabled={pageIndex <= 0} className="px-4 py-2.5 sm:py-2 border-2 border-black rounded-lg text-sm sm:text-xs font-bold flex items-center gap-1 bg-white active:translate-y-0.5 transition-transform disabled:opacity-40 disabled:cursor-not-allowed">
                      <ChevronLeft className="w-4 h-4" /> Prev
                    </button>
                    <div className="text-xs font-bold tabular-nums">{Math.min(pageIndex + 1, Math.max(pages.length, 1))} / {Math.max(pages.length, 1)}</div>
                    <button onClick={goNext} disabled={pageIndex >= pages.length - 1} className="px-4 py-2.5 sm:py-2 border-2 border-black rounded-lg text-sm sm:text-xs font-bold flex items-center gap-1 bg-white active:translate-y-0.5 transition-transform disabled:opacity-40 disabled:cursor-not-allowed">
                      Next <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                {phoneUi && chromeHidden && (
                  // While the chrome is away, a hairline progress bar keeps your place.
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-1 bg-black/10" aria-hidden>
                    <div className="h-full bg-brand-yellow" style={{ width: `${(Math.min(pageIndex + 1, pages.length) / Math.max(pages.length, 1)) * 100}%` }} />
                  </div>
                )}
              </div>
              {!phoneUi && <div className="text-[11px] text-slate-500 font-comic mt-1.5 hidden sm:block">← → or space to turn · Home/End to jump · Esc to close · swipe on touch</div>}
            </div>
          )}
        </div>

        {showInfo && !phoneUi && (
          <aside className="w-full md:w-80 shrink-0 border-l-4 border-black bg-white p-4 overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-display text-xl">Comic Info</h2>
              <button onClick={() => setShowInfo(false)} className="p-2 -mr-2 rounded-full hover:bg-slate-100 md:hidden" aria-label="Close info">
                <X className="w-5 h-5" />
              </button>
            </div>
            {infoDetails}
          </aside>
        )}
      </div>

      {!phoneUi && !readingMode && (
      <LegalMicroLinks
        onOpenPrivacy={leaveTo(onOpenPrivacy)}
        onOpenTerms={leaveTo(onOpenTerms)}
        onOpenFaq={leaveTo(onOpenFaq)}
      />
      )}

      {phoneUi && showInfo && (
        <PhoneSheet title="Comic Info" onClose={() => setShowInfo(false)}>
          {infoDetails}
          {/* The site footer is not drawn inside the phone reader: its links live here. */}
          <div className="mt-5 border-t border-slate-200 pt-3">
            <div className="text-xs uppercase font-bold text-slate-500">DreamStream</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-1 text-[13px] font-semibold text-slate-600">
              <button type="button" onClick={leaveTo(onOpenPrivacy)} className="min-h-[44px] rounded-lg px-2 hover:text-black hover:bg-slate-100">Privacy Policy</button>
              <button type="button" onClick={leaveTo(onOpenTerms)} className="min-h-[44px] rounded-lg px-2 hover:text-black hover:bg-slate-100">Terms &amp; Conditions</button>
              <button type="button" onClick={leaveTo(onOpenFaq)} className="min-h-[44px] rounded-lg px-2 hover:text-black hover:bg-slate-100">FAQs</button>
              <a href="mailto:contact@dreamstream.com" className="inline-flex min-h-[44px] items-center rounded-lg px-2 hover:text-black hover:bg-slate-100">Contact</a>
            </div>
          </div>
        </PhoneSheet>
      )}

      {phoneUi && showStory && (
        <PhoneSheet title="Story" onClose={() => setShowStory(false)}>
          {storyText}
        </PhoneSheet>
      )}

      {showComments && (
        <div className="fixed inset-y-0 left-0 w-full md:w-96 bg-white border-r-4 border-black z-50 shadow-comic flex flex-col">
          <div className="p-4 border-b-4 border-black flex items-center justify-between bg-white shrink-0">
            <div className="font-display text-xl">Comments</div>
            <button onClick={() => setShowComments(false)} className="p-2 coarse:p-3 rounded-full hover:bg-slate-100" aria-label="Close comments">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto bg-slate-50">
            <CommentSection projectId={project.id} onNavigate={onNavigate ? navigate : undefined} />
          </div>
        </div>
      )}
      {/* Review Modal */}
      <ReviewModal
        isOpen={showReviewModal}
        onClose={() => readerHistory.leave(onClose)} // If they skip/close modal, we just close the reader
        onSubmit={handleReviewSubmit}
        projectName={project.name}
      />
    </div >
  );
};
