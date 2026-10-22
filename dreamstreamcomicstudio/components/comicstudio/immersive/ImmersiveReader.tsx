// Immersive full-screen reader, "Leaf" (contract §13.3, reader.md §2–§12; owner P1-READER).
//
// A dark reading room in a portal above everything: the book on the desk with a custom page-turn
// engine (paper fold, hardcover cover, riffles; slide/fade on low-end devices; crossfades under
// reduced motion), Guided View one tap away (never the default), the cover intro (immersive only,
// once per session per comic), the End card, an auto-hiding glass HUD, ambient colour from the page,
// a screen-reader transcript, wake lock, and Back closes it. Deep links: ?p= ?lang= ?guided=1 ?panel=.
// Everything is client-side and free: no AI call, no server request beyond the page images.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ScanEye } from 'lucide-react';
import { bookOf, readerOf, type ComicDoc } from '../../../shared/comic/doc';
import { localizeDoc } from '../../../shared/comic/i18n';
import { canServeToOwner } from '../../../shared/comic/safety';
import type { StudioController } from '../types';
import type { ReaderLanguageSlot } from '../i18n/ReaderLanguagePicker';
import { ensureFontsFor } from '../i18n/scriptFonts';
import { aspectNumber } from '../board/balloonGeometry';
import { cx, useElementSize } from '../board/ui';
import { useFormFactor } from '../mobile/useFormFactor';
import { usePrefersReducedMotion } from '../../studio/kit/motion';
import { chapterOf, chapterStarts, readerItems, resolvePageN, type ReaderItem } from '../reader/readerModel';
import { averagePalette, roomBackground, themeColorFor, type Palette } from './ambient';
import { BookStage } from './BookStage';
import { CoverIntro } from './CoverIntro';
import { EndCard } from './EndCard';
import { guidedStops, stopAtPoint, type GuidedStop } from './guidedModel';
import { connectionHints, pageImageCache, useCacheVersion } from './pageImageCache';
import { panelTranscript, pageTranscript } from './pageTranscript';
import { closePaperSound, primePaperSound } from './paperSound';
import { keyCommand, type ReaderCommand } from './readerInput';
import { bookGeometry, bookViews, decideLayout, firstItemOfView, letterbox, viewIndexOfItem, type BookView, type LayoutPref, type ReaderLayout } from './readerLayout';
import { slotImageSource } from './ReaderSlot';
import { initialReaderState, readerReducer, escapeTarget, type MachineCtx, type ReaderEvent, type ReaderState } from './readerMachine';
import {
  effectiveReader,
  introPlayed,
  markIntroPlayed,
  readLayoutPref,
  readPosition,
  readPrefs,
  shouldOfferResume,
  writeLayoutPref,
  writePosition,
  writePrefs,
  writeReaderLang,
  type ReaderPrefs
} from './readerPrefs';
import { createUrlSync } from './readerUrl';
import { PageScrubber } from './PageScrubber';
import { ReaderHud } from './ReaderHud';
import { ReaderSettingsSheet } from './ReaderSettingsSheet';
import { ReaderShortcuts } from './ReaderShortcuts';
import { readerEntryOnTop, useImmersive } from './useImmersive';
import { useLowPower } from './useLowPower';
import { WebtoonStage, type WebtoonStageHandle } from './WebtoonStage';

export interface ImmersiveReaderEndCard {
  authorName?: string;
  onMakeYourOwn?(): void;
  shareUrl?: string;
}

export interface ImmersiveReaderProps {
  doc: ComicDoc;
  urlFor: StudioController['urlFor'];
  /** 1-based page number, or the cover. */
  initialPage?: number | 'cover';
  language?: ReaderLanguageSlot;
  endCard?: ImmersiveReaderEndCard;
  /** Play the cover intro (immersive surfaces only, once per session per comic). */
  intro: boolean;
  onExit(): void;
  allowDownload?: boolean;
  /** Open in Guided View (deep link ?guided=1), optionally at a 1-based panel (?panel=). */
  initialGuided?: boolean;
  initialPanel?: number;
  /** Write ?p= / ?lang= / ?guided= / ?panel= back with replaceState as the reader settles (public reader). */
  syncUrl?: boolean;
  /** A page image failed to load or its signed link expired (the host re-signs). */
  onImageError?(): void;
  /** Settled on a page (1-based; 0 = cover). */
  onPageChange?(n: number): void;
}

const READER_TOKENS: React.CSSProperties = {
  // Reader-local ink on paper (identical in both themes, like the room itself).
  ['--ds-reader-ink' as string]: '#3b3026',
  ['--ds-reader-ink-soft' as string]: '#5b4a3a',
  ['--ds-reader-ink-faint' as string]: '#8a7865',
  ['--ds-reader-wash' as string]: 'rgba(59,48,38,0.10)',
  ['--ds-reader-wash-strong' as string]: 'rgba(59,48,38,0.16)',
  ['--ds-reader-edge' as string]: '#ebe4d6',
  ['--ds-reader-edge-line' as string]: '#cdc3b0'
};

const HUD_IDLE_MS = 2500;
const words = (t: string) => (t.match(/\S+/g) || []).length;
const readMs = (text: string, wpm: number) => Math.max(650, Math.round((words(text) * 60_000) / wpm));

/** The book's trim: the most common page shape among drawn pages, else the format's aspect. */
export const trimAspect = (items: ReaderItem[], fallback: number): number => {
  const counts = new Map<number, number>();
  for (const it of items) {
    if (it.kind !== 'page' || !it.asset.w || !it.asset.h) continue;
    const a = Math.round((it.asset.w / it.asset.h) * 100) / 100;
    counts.set(a, (counts.get(a) || 0) + 1);
  }
  let best = 0;
  let bestN = 0;
  for (const [a, n] of counts) if (n > bestN) [best, bestN] = [a, n];
  return best > 0 ? best : fallback;
};

const pageNOfView = (views: BookView[], items: ReaderItem[], view: number): number => {
  const first = views[view]?.items[0];
  if (first === undefined) return items[items.length - 1]?.page?.n ?? 0;
  return items[first]?.page?.n ?? 0;
};

export const ImmersiveReader: React.FC<ImmersiveReaderProps> = (props) => {
  const { doc, urlFor, language, endCard, onExit, allowDownload = true } = props;
  // ── Document ──────────────────────────────────────────────────────────────
  // Keyed on the language CODE: hosts pass the slot as an inline object, and a new object on every host
  // render must not re-localize the book (new items → new views → every page re-rendered mid-turn).
  const lang = language?.current;
  const localized = useMemo(() => (lang ? localizeDoc(doc, lang) : doc), [doc, lang]);
  const items = useMemo(() => readerItems(localized), [localized]);
  const rtl = localized.format.readingDirection === 'rtl';
  const kind = localized.format.kind;
  const trim = useMemo(() => trimAspect(items, aspectNumber(localized.format.pageAspect)), [items, localized.format.pageAspect]);
  const aspectOf = useCallback((i: number) => {
    const a = items[i]?.asset;
    return a?.w && a?.h ? a.w / a.h : trim;
  }, [items, trim]);
  const creator = readerOf(localized);
  const firstPageRight = bookOf(localized).firstPageRight;

  // ── Device, prefs, motion ─────────────────────────────────────────────────
  const ff = useFormFactor();
  const osReduced = usePrefersReducedMotion() || ff.reducedMotion;
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => readPrefs());
  const onPrefs = useCallback((patch: Partial<ReaderPrefs>) => {
    // Still inside the toggle's click: unlock audio now (iOS plays nothing started outside a gesture).
    if (patch.sound) primePaperSound();
    setPrefs((p) => {
      const next = { ...p, ...patch };
      writePrefs(next);
      return next;
    });
  }, []);
  const eff = effectiveReader(creator, prefs, kind);
  const reduced = osReduced || prefs.reduceMotion;
  const low = useLowPower(prefs.fancyTurns);
  const [layoutPref, setLayoutPrefState] = useState<LayoutPref>(() => readLayoutPref());
  const net = useMemo(() => connectionHints(), []);

  // ── Room size ─────────────────────────────────────────────────────────────
  const [roomRef, roomSize] = useElementSize<HTMLDivElement>();
  const size = useMemo(
    () => ({ w: roomSize.width || (typeof window !== 'undefined' ? window.innerWidth : 1024), h: roomSize.height || (typeof window !== 'undefined' ? window.innerHeight : 768) }),
    [roomSize.width, roomSize.height]
  );
  const decision = useMemo(
    () => decideLayout({ vw: size.w, vh: size.h, kind, pref: layoutPref, pageAspect: trim, widthClass: ff.widthClass, heightClass: ff.heightClass, segments: ff.segments }),
    [size.w, size.h, kind, layoutPref, trim, ff.widthClass, ff.heightClass, ff.segments]
  );
  const hinge = useMemo(() => {
    const r = ff.segments.rects;
    if (!decision.perSegment || r.length < 2) return undefined;
    return { start: r[0].right, end: r[1].left };
  }, [decision.perSegment, ff.segments]);

  // ── Views per layout (guided reads one page at a time) ───────────────────
  // Views and guided stops are memoized per input set (stable identities keep the stage calm).
  const viewsCache = useMemo(() => new Map<string, BookView[]>(), [items, firstPageRight]);
  const viewsFor = useCallback(
    (layout: ReaderLayout): BookView[] => {
      const key = layout === 'spread' ? 'spread' : 'single';
      let v = viewsCache.get(key);
      if (!v) {
        v = bookViews(items, layout === 'spread' ? 'spread' : 'single', { endCard: true, firstPageRight });
        viewsCache.set(key, v);
      }
      return v;
    },
    [viewsCache, items, firstPageRight]
  );
  const stopsCache = useMemo(() => new Map<number, GuidedStop[]>(), [localized, items, eff.guidedOverview]);
  const stopsFor = useCallback(
    (layout: ReaderLayout, view: number): GuidedStop[] => {
      const first = viewsFor(layout)[view]?.items[0];
      if (first === undefined) return [];
      let s = stopsCache.get(first);
      if (!s) {
        s = guidedStops(localized, items[first], first, { overview: eff.guidedOverview });
        stopsCache.set(first, s);
      }
      return s;
    },
    [viewsFor, stopsCache, localized, items, eff.guidedOverview]
  );
  const ctxFor = useCallback(
    (layout: ReaderLayout): MachineCtx => ({ views: viewsFor(layout).length, stopsOf: (v) => stopsFor(layout, v).length, overview: eff.guidedOverview }),
    [viewsFor, stopsFor, eff.guidedOverview]
  );
  const ctxRef = useRef(ctxFor);
  ctxRef.current = ctxFor;

  // ── Machine ───────────────────────────────────────────────────────────────
  const initial = useMemo(() => {
    const layout0: ReaderLayout = props.initialGuided && decision.layout !== 'scroll' ? 'single' : decision.layout;
    const vs = bookViews(items, layout0 === 'spread' ? 'spread' : 'single', { endCard: true, firstPageRight });
    let view = 0;
    let note: string | undefined;
    if (props.initialPage !== undefined) {
      const r = resolvePageN(items, props.initialPage === 'cover' ? 0 : props.initialPage);
      view = viewIndexOfItem(vs, r.index);
      if (!r.exact && props.initialPage !== 'cover' && items.length) note = `Page ${props.initialPage} isn’t drawn yet — showing ${r.shownN ? `page ${r.shownN}` : 'the cover'}.`;
    }
    const playIntro = props.intro && props.initialPage === undefined && !props.initialGuided && !introPlayed(doc.id) && items[0]?.kind === 'cover';
    return { layout0, view, note, playIntro };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const reducer = useCallback((s: ReaderState, e: ReaderEvent) => readerReducer(s, e, ctxRef.current(e.type === 'LAYOUT' ? e.layout : s.layout)), []);
  const [state, dispatchRaw] = useReducer(reducer, undefined, () =>
    initialReaderState({ layout: initial.layout0, view: initial.view, phase: initial.playIntro && !reduced ? 'intro' : 'reading', reduced, lowPower: low.lowPower })
  );
  const views = viewsFor(state.layout);
  const view = Math.min(state.view, Math.max(0, views.length - 1));

  // ── HUD visibility ────────────────────────────────────────────────────────
  const rootRef = useRef<HTMLDivElement>(null);
  const hudTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const pokeHud = useCallback(
    (show = true) => {
      if (hudTimer.current) clearTimeout(hudTimer.current);
      if (show) dispatchRaw({ type: 'HUD', show: true });
      const hide = () => {
        // The HUD stays while one of its controls has keyboard focus.
        const hud = rootRef.current?.querySelector('[data-testid="reader-hud"]');
        if (hud && typeof document !== 'undefined' && hud.contains(document.activeElement)) {
          hudTimer.current = setTimeout(hide, HUD_IDLE_MS);
          return;
        }
        dispatchRaw({ type: 'HUD', show: false });
      };
      hudTimer.current = setTimeout(hide, HUD_IDLE_MS);
    },
    []
  );
  useEffect(() => {
    if (settingsOpen || shortcutsOpen) {
      if (hudTimer.current) clearTimeout(hudTimer.current);
      dispatchRaw({ type: 'HUD', show: true });
    } else pokeHud(state.hud);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen, shortcutsOpen]);
  useEffect(() => () => {
    if (hudTimer.current) clearTimeout(hudTimer.current);
    closePaperSound();
  }, []);

  const dispatch = useCallback(
    (e: ReaderEvent) => {
      // Any turn tucks the HUD away on touch screens (it comes back with a centre tap).
      if ((e.type === 'STEP' || e.type === 'DRAG_START' || e.type === 'GOTO') && ff.coarse) dispatchRaw({ type: 'HUD', show: false });
      if (e.type !== 'PLAY' && e.type !== 'TURN_DONE' && e.type !== 'HUD' && state.guided.playing && (e.type === 'STEP' || e.type === 'GOTO' || e.type === 'DRAG_START' || e.type === 'ZOOM')) dispatchRaw({ type: 'PLAY', on: false });
      dispatchRaw(e);
    },
    [ff.coarse, state.guided.playing]
  );

  // ── Sync flags into the machine ───────────────────────────────────────────
  useEffect(() => dispatchRaw({ type: 'REDUCED', on: reduced }), [reduced]);
  useEffect(() => dispatchRaw({ type: 'LOW_POWER', on: low.lowPower }), [low.lowPower]);

  // Layout follows the room (rotation, resize, explicit choice) and Guided View (one page at a time).
  const effectiveLayout: ReaderLayout = state.guided.on && decision.layout !== 'scroll' ? 'single' : decision.layout;
  const prevLayout = useRef<{ layout: ReaderLayout; views: BookView[] }>({ layout: state.layout, views });
  useLayoutEffect(() => {
    const prev = prevLayout.current;
    if (effectiveLayout !== state.layout) {
      const first = firstItemOfView(viewsFor(state.layout), view);
      const nextViews = viewsFor(effectiveLayout);
      const atEnd = views[view]?.slots.some((s) => s.kind === 'end') && !views[view]?.items.length;
      dispatchRaw({ type: 'LAYOUT', layout: effectiveLayout, view: atEnd ? nextViews.length - 1 : viewIndexOfItem(nextViews, first) });
    } else if (prev.views !== views && prev.layout === state.layout) {
      // Items changed (a page was drawn, language changed): stay on the same page.
      const first = firstItemOfView(prev.views, view);
      const nv = viewIndexOfItem(views, first);
      if (nv !== view) dispatchRaw({ type: 'LAYOUT', layout: state.layout, view: nv });
    }
    prevLayout.current = { layout: effectiveLayout, views: viewsFor(effectiveLayout) };
  });

  // ── Platform: fullscreen, back, wake lock, theme colour ───────────────────
  const exit = useCallback(() => onExit(), [onExit]);
  useCacheVersion();
  const palette: Palette | null = useMemo(() => {
    if (!eff.ambient || low.lowPower) return null;
    const ps = (views[view]?.items ?? []).map((i) => {
      const a = items[i]?.asset;
      if (!a) return null;
      for (const p of [a.path, ...(a.variants || []).map((v) => v.path)]) {
        const e = pageImageCache.get(p);
        if (e?.palette) return e.palette;
      }
      return null;
    });
    return averagePalette(ps);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eff.ambient, low.lowPower, views, view, items, pageImageCache.snapshot()]);
  const immersive = useImmersive(rootRef, { active: true, onExit: exit, themeColor: themeColorFor(palette) });

  // Focus: the dialog takes focus and gives it back on close; Tab stays inside.
  useEffect(() => {
    const prev = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    rootRef.current?.focus({ preventScroll: true });
    if (initial.playIntro) markIntroPlayed(doc.id);
    return () => {
      try {
        prev?.focus?.({ preventScroll: true });
      } catch {
        /* gone */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Tab cycles inside the reader (pages off screen are inert, so they never take focus).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = Array.from(el.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(
        (n) => !n.closest('[inert]') && n.getAttribute('aria-hidden') !== 'true'
      );
      if (!items.length) {
        e.preventDefault();
        el.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || active === el || !el.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !el.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, []);

  const [bookEl, setBookEl] = useState<HTMLElement | null>(null);

  // ── Toasts ────────────────────────────────────────────────────────────────
  const [toast, setToast] = useState<string | null>(initial.note ?? null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3600);
    return () => clearTimeout(t);
  }, [toast]);

  // ── Guided ────────────────────────────────────────────────────────────────
  const stops = useMemo(() => (state.guided.on ? stopsFor(state.layout, view) : []), [state.guided.on, stopsFor, state.layout, view]);
  const stopsOfView = useCallback((v: number) => stopsFor(state.layout, v), [stopsFor, state.layout]);
  const guidedAvailable = items.some((i) => (i.page?.panels.length ?? 0) > 0);
  const toggleGuided = useCallback(
    (on = !state.guided.on, at?: { item: number; stop: number }) => {
      if (!on) {
        dispatch({ type: 'GUIDED', on: false });
        return;
      }
      const target: ReaderLayout = decision.layout === 'scroll' ? 'scroll' : 'single';
      const item = at?.item ?? firstItemOfView(views, view);
      const vs = viewsFor(target);
      const v = viewIndexOfItem(vs, item);
      if (target !== state.layout) dispatchRaw({ type: 'LAYOUT', layout: target, view: v });
      dispatch({ type: 'GUIDED', on: true, at: { view: v, stop: at?.stop ?? 0 } });
    },
    [state.guided.on, state.layout, decision.layout, views, view, viewsFor, dispatch]
  );
  // Deep link: ?guided=1&panel=K.
  useEffect(() => {
    if (!props.initialGuided || !guidedAvailable) return;
    const item = firstItemOfView(views, view);
    const st = stopsFor(decision.layout === 'scroll' ? 'scroll' : 'single', viewIndexOfItem(viewsFor('single'), item));
    const panelIdx = props.initialPanel ? st.findIndex((s) => s.panelIndex >= 0 && st.filter((x) => x.panelIndex >= 0).indexOf(s) === props.initialPanel! - 1) : 0;
    toggleGuided(true, { item, stop: Math.max(0, panelIdx) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autoplay: hold each stop long enough to read it, then move on. Any other input pauses.
  useEffect(() => {
    if (!state.guided.on || !state.guided.playing || state.motion.kind !== 'idle') return;
    const st = stops[state.guided.stop];
    const item = st ? items[st.itemIndex] : undefined;
    let ms = 2600;
    if (st && item?.page && st.panelIndex >= 0) {
      const lines = item.page.panels[st.panelIndex]?.lines ?? [];
      ms = Math.min(7500, Math.max(1800, 450 + lines.reduce((a, l) => a + (l.text.trim() ? readMs(l.text, prefs.wpm) : 0), 0) + 500));
    } else if (item?.page) ms = 1300;
    if (view >= views.length - 1) {
      dispatchRaw({ type: 'PLAY', on: false });
      return;
    }
    const t = setTimeout(() => dispatchRaw({ type: 'PANEL', delta: 1 }), ms);
    return () => clearTimeout(t);
  }, [state.guided.on, state.guided.playing, state.guided.stop, state.motion.kind, view, views.length, stops, items, prefs.wpm]);

  // ── Commands (keys, taps, wheel, HUD) ─────────────────────────────────────
  const webtoonRef = useRef<WebtoonStageHandle>(null);
  const onCommand = useCallback(
    (cmd: ReaderCommand) => {
      switch (cmd.type) {
        case 'step':
          if (state.phase === 'intro') dispatch({ type: 'STEP', delta: cmd.delta });
          else if (state.layout === 'scroll' && !state.guided.on) webtoonRef.current?.scrollByViewport(cmd.delta * 0.85);
          else dispatch({ type: 'STEP', delta: cmd.delta });
          break;
        case 'home':
          if (state.guided.on) dispatch({ type: 'STOP', stop: 0 });
          else if (state.layout === 'scroll') webtoonRef.current?.toTop();
          else dispatch({ type: 'GOTO', view: 0 });
          break;
        case 'end':
          if (state.guided.on) dispatch({ type: 'STOP', stop: Math.max(0, stops.length - 1) });
          else if (state.layout === 'scroll') webtoonRef.current?.toBottom();
          else dispatch({ type: 'GOTO', view: views.length - 1 });
          break;
        case 'scroll':
          webtoonRef.current?.scrollByViewport(cmd.amount);
          break;
        case 'guided':
          if (guidedAvailable) toggleGuided();
          break;
        case 'fullscreen':
          void immersive.toggleFullscreen();
          break;
        case 'play':
          if (guidedAvailable) dispatch({ type: 'PLAY', on: !state.guided.playing });
          break;
        case 'shortcuts':
          setShortcutsOpen((o) => !o);
          break;
        case 'hud':
          if (state.hud) {
            if (hudTimer.current) clearTimeout(hudTimer.current);
            dispatchRaw({ type: 'HUD', show: false });
          } else pokeHud(true);
          break;
        case 'escape':
          if (shortcutsOpen) setShortcutsOpen(false);
          else if (settingsOpen) setSettingsOpen(false);
          else if (escapeTarget(state) === 'exit') immersive.exit();
          else dispatch({ type: 'ESCAPE' });
          break;
      }
    },
    [state, stops.length, views.length, guidedAvailable, toggleGuided, immersive, shortcutsOpen, settingsOpen, pokeHud, dispatch]
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement).isContentEditable;
    if (typing && e.key !== 'Escape') return;
    // Buttons keep Space/Enter for themselves.
    if (tag === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
    const cmd = keyCommand(e, { rtl, layout: state.layout });
    if (!cmd) return;
    e.preventDefault();
    if (state.phase === 'intro' && cmd.type !== 'escape' && cmd.type !== 'fullscreen') {
      dispatch({ type: 'STEP', delta: 1 });
      return;
    }
    if (cmd.type !== 'hud' && cmd.type !== 'step') pokeHud(true);
    onCommand(cmd);
  };

  // ── Layout choice ─────────────────────────────────────────────────────────
  const onLayout = useCallback((pref: LayoutPref) => {
    setLayoutPrefState(pref);
    writeLayoutPref(pref);
  }, []);

  // ── Settle effects: announcements, resume, URL, page callback ─────────────
  const current = views[view];
  const firstItem = current?.items[0];
  const isEnd = !!current?.slots.some((s) => s.kind === 'end');
  const drawnPages = items.filter((i) => i.kind === 'page');
  const totalPages = drawnPages.length;
  const labelOf = useCallback(
    (v: number) => {
      const vv = views[v];
      if (!vv) return '';
      const pages = vv.items.map((i) => items[i]).filter((it): it is ReaderItem => !!it?.page);
      if (!vv.items.length) return vv.slots.some((s) => s.kind === 'end') ? 'The End' : 'Inside cover';
      if (!pages.length) return 'Cover';
      return pages.length > 1 ? `Pages ${pages[0].page!.n}–${pages[pages.length - 1].page!.n}` : `Page ${pages[0].page!.n}`;
    },
    [views, items]
  );
  const counter = isEnd && !current?.items.length ? 'The End' : `${labelOf(view)}${labelOf(view).startsWith('Page') ? ` of ${totalPages}` : ''}`;
  const chapter = firstItem !== undefined ? chapterOf(items, firstItem) : undefined;

  const [announce, setAnnounce] = useState('');
  const urlSync = useMemo(() => createUrlSync(300), []);
  const syncUrlRef = useRef(props.syncUrl);
  syncUrlRef.current = props.syncUrl;
  useEffect(
    () => () => {
      if (!syncUrlRef.current || typeof window === 'undefined') return urlSync.cancel();
      // The link keeps the page the reader closed on. Closing pops the reader's own history entry
      // (Back, or Close calling history.back()), so the position is written onto the entry underneath —
      // right away when it is already gone, else once the pop lands (bounded wait).
      if (!readerEntryOnTop()) return urlSync.reapply();
      let t: ReturnType<typeof setTimeout> | null = null;
      const once = () => {
        window.removeEventListener('popstate', once);
        if (t) clearTimeout(t);
        urlSync.reapply();
      };
      t = setTimeout(once, 1000);
      window.addEventListener('popstate', once);
    },
    [urlSync]
  );
  useEffect(() => {
    if (state.motion.kind !== 'idle' || state.phase === 'intro') return;
    const chap = firstItem !== undefined ? chapterOf(items, firstItem) : undefined;
    const chapterStart = chap && firstItem === chap.startIndex ? ` Chapter: ${chap.title}.` : '';
    if (!state.guided.on) setAnnounce(isEnd && !current?.items.length ? 'The End.' : `${counter}.${chapterStart}`);
    const n = pageNOfView(views, items, view);
    props.onPageChange?.(n);
    if (firstItem !== undefined && items[firstItem]) writePosition(doc.id, { key: items[firstItem].key, at: Date.now(), ...(state.guided.on ? { panel: state.guided.stop } : {}) });
    if (props.syncUrl) {
      const panelOrdinal = state.guided.on ? stops.slice(0, state.guided.stop + 1).filter((s) => s.panelIndex >= 0).length : 0;
      urlSync.schedule({ p: n, lang: language?.current, guided: state.guided.on, panel: panelOrdinal || undefined });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, state.motion.kind, state.guided.on, state.guided.stop, state.phase, language?.current]);

  // Guided announcements: "Panel 2 of 5" + that panel's words.
  useEffect(() => {
    if (!state.guided.on || state.motion.kind !== 'idle') return;
    const st = stops[state.guided.stop];
    const item = st ? items[st.itemIndex] : undefined;
    const panels = stops.filter((s) => s.panelIndex >= 0);
    if (st && item?.page && st.panelIndex >= 0) {
      const ordinal = panels.indexOf(st) + 1;
      setAnnounce(`Panel ${ordinal} of ${panels.length}. ${panelTranscript(localized, item.page, st.panelIndex, ordinal)}`);
    } else if (item) setAnnounce(`${item.label}. Whole page.`);
  }, [state.guided.on, state.guided.stop, state.motion.kind, stops, items, localized]);

  // Resume chip: offered, never automatic.
  const [resume, setResume] = useState<{ view: number; label: string } | null>(() => {
    if (props.initialPage !== undefined || props.initialGuided) return null;
    const pos = readPosition(doc.id);
    const idx = pos ? items.findIndex((i) => i.key === pos.key) : -1;
    if (!pos || idx < 0 || !shouldOfferResume(pos, idx, Date.now())) return null;
    const v = viewIndexOfItem(viewsFor(initial.layout0), idx);
    return v > 0 ? { view: v, label: items[idx].label } : null;
  });
  useEffect(() => {
    if (resume && view !== 0) setResume(null);
  }, [view, resume]);

  // Language: keep the page; load the script's fonts; remember the choice.
  const prevLang = useRef(language?.current);
  useEffect(() => {
    const lang = language?.current;
    if (!lang || lang === prevLang.current) return;
    prevLang.current = lang;
    writeReaderLang(lang);
    // Lettering crossfades into the new language; the page, panel and zoom stay put.
    if (!reduced && bookEl && typeof bookEl.animate === 'function') bookEl.animate([{ opacity: 0.8 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
    const sample = items.slice(0, 3).flatMap((i) => i.page?.panels.flatMap((p) => p.lines.map((l) => l.text)) ?? []).join(' ').slice(0, 400);
    void ensureFontsFor([lang], ['dialogue', 'sfx'], sample).then((r) => {
      if (r.degraded) setToast('Some lettering uses a fallback font on this device.');
    });
  }, [language?.current, items]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Share & download (client-side, from the already-public images) ────────
  const share = useMemo(() => {
    const url = endCard?.shareUrl;
    if (!url) return undefined;
    return async () => {
      const title = localized.cover.title || localized.brief.title || 'A comic';
      try {
        const nav = navigator as Navigator & { share?: (d: { title?: string; url?: string; text?: string }) => Promise<void> };
        if (typeof nav.share === 'function') {
          await nav.share({ title, url });
          return;
        }
        await navigator.clipboard.writeText(url);
        setToast('Link copied');
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        setToast('Couldn’t share — copy the link from the address bar instead.');
      }
    };
  }, [endCard?.shareUrl, localized]);

  const [downloading, setDownloading] = useState(false);
  const download = useMemo(() => {
    if (!allowDownload || !items.length) return undefined;
    return async () => {
      if (downloading) return;
      setDownloading(true);
      setToast('Preparing the PDF…');
      try {
        const { exportComicPdf } = await import('../export/pdfExport');
        // A withheld (safety-blocked) image is never shown, so it never goes into a download either.
        const res = await exportComicPdf(localized, (a) => (a && typeof a === 'object' && !canServeToOwner(a) ? undefined : urlFor(a)));
        const left = res.skipped.length + res.failed.length;
        setToast(left ? `Downloaded ${res.pages} page${res.pages === 1 ? '' : 's'} — ${left} couldn’t be included (not drawn, withheld or didn’t load).` : 'Downloaded the PDF.');
      } catch (err) {
        setToast(`Couldn’t make the PDF: ${(err as Error)?.message || 'please try again.'}`);
      } finally {
        setDownloading(false);
      }
    };
  }, [allowDownload, items.length, localized, urlFor, downloading]);

  // ── Ambient room (two layers crossfade on change) ─────────────────────────
  const bg = roomBackground(palette);
  const [bgLayers, setBgLayers] = useState<{ id: number; bg: string }[]>(() => [{ id: 0, bg }]);
  useEffect(() => {
    setBgLayers((layers) => (layers[layers.length - 1]?.bg === bg ? layers : [...layers.slice(-1), { id: (layers[layers.length - 1]?.id ?? 0) + 1, bg }]));
  }, [bg]);

  // ── Slot image options ────────────────────────────────────────────────────
  const img = useMemo(
    () => ({ urlFor, dpr: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, saveData: ff.saveData || net.saveData }),
    [urlFor, ff.saveData, net.saveData]
  );
  // The page box the stage draws (same geometry as BookStage / the webtoon column), so preloads and
  // the retained set name the exact file (variant) each page will show.
  const pageBox = useMemo(() => {
    if (state.layout === 'scroll') return { w: Math.min(size.w, 800), h: 0 };
    const v = views[view] ?? views[0];
    if (!v) return { w: 0, h: 0 };
    return bookGeometry({ view: v, stage: size, layout: state.layout === 'spread' ? 'spread' : 'single', rtl, aspectOf, pageAspect: trim, fit: decision.fit, widthClass: ff.widthClass, hinge: decision.perSegment ? hinge : undefined }).page;
  }, [state.layout, size, views, view, rtl, aspectOf, trim, decision.fit, decision.perSegment, ff.widthClass, hinge]);
  const sourceOf = useCallback(
    (i: number) => {
      const it = items[i];
      if (!it) return undefined;
      const w = state.layout === 'scroll' || !pageBox.h ? pageBox.w : letterbox(pageBox.w, pageBox.h, aspectOf(i)).w;
      return slotImageSource(it, w, { ...img, original: false });
    },
    [items, state.layout, pageBox, aspectOf, img]
  );
  // Polite preloading: a few pages ahead when the connection allows it (never a withheld page).
  useEffect(() => {
    const keep = views
      .slice(Math.max(0, view - 2), view + 3)
      .flatMap((v) => v.items)
      .flatMap((i) => [items[i]?.asset.path, sourceOf(i)?.path])
      .filter(Boolean) as string[];
    pageImageCache.retain(keep);
    if (net.saveData || net.slow || ff.saveData) return;
    const controller = new AbortController();
    for (const i of views.slice(view + 2, view + 6).flatMap((v) => v.items)) {
      const src = sourceOf(i);
      if (src?.url) void pageImageCache.ensure(src.path, src.url, 'idle', controller.signal);
    }
    return () => controller.abort();
  }, [view, views, items, sourceOf, net.saveData, net.slow, ff.saveData]);

  // ── Render ────────────────────────────────────────────────────────────────
  const title = localized.cover.title || localized.brief.title || 'Untitled comic';
  const visibleItems = current?.items ?? [];
  const transcript = visibleItems.map((i) => ({ key: items[i]?.key ?? String(i), paras: pageTranscript(localized, items[i]) }));
  const guidedPanels = stops.filter((s) => s.panelIndex >= 0);
  const curStop = stops[state.guided.stop];
  const guidedLabel = curStop && curStop.panelIndex >= 0 ? `Panel ${guidedPanels.indexOf(curStop) + 1} of ${guidedPanels.length}` : 'Whole page';
  const endCardNode = (
    <EndCard
      doc={localized}
      endCard={endCard}
      active={isEnd && state.motion.kind === 'idle' && state.phase !== 'intro'}
      chapters={chapterStarts(items).map((c) => ({ n: c.n, title: c.title }))}
      language={language}
      dense={ff.widthClass === 'compact'}
      onReadAgain={() => dispatch({ type: 'GOTO', view: 0 })}
      onGuidedReplay={guidedAvailable ? () => toggleGuided(true, { item: items.findIndex((i) => i.kind === 'page'), stop: 0 }) : undefined}
      onShare={share}
      onDownload={download}
      downloadBusy={downloading}
    />
  );
  const layoutOptions: LayoutPref[] = kind === 'webtoon' ? [] : kind === 'strip' ? ['auto', 'scroll'] : ['auto', 'single', 'spread', 'scroll'];
  const fullscreenCursorHidden = immersive.fullscreen && !state.hud;

  const content = (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Reading ${title}`}
      tabIndex={-1}
      data-testid="immersive-reader"
      data-layout={state.layout}
      data-phase={state.phase}
      data-guided={state.guided.on ? 'true' : 'false'}
      className={cx('gesture-root fixed inset-0 z-[80] overflow-hidden text-white outline-none', fullscreenCursorHidden && 'cursor-none')}
      style={{ ...READER_TOKENS, background: 'var(--ds-reader-room)' }}
      onKeyDown={onKeyDown}
      onPointerMove={(e) => {
        if (e.pointerType === 'mouse') pokeHud(true);
      }}
    >
      {/* Ambient glow: the newest layer fades in over the previous one. */}
      {bgLayers.map((l, i) => (
        <div
          key={l.id}
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ background: l.bg, opacity: i === bgLayers.length - 1 ? 1 : 0, transition: reduced ? undefined : 'opacity 900ms linear' }}
        />
      ))}
      <div
        ref={roomRef}
        className="absolute"
        style={{ left: 'var(--sa-left)', right: 'var(--sa-right)', top: 'var(--sa-top)', bottom: 'var(--sa-bottom)' }}
      >
        {items.length === 0 ? (
          <div className="grid h-full place-items-center p-6 text-center">
            <div className="max-w-sm space-y-3">
              <p className="text-[15px] font-semibold">Nothing to read yet</p>
              <p className="text-[13px] text-white/70">Pages appear here as soon as they are drawn.</p>
              <button type="button" onClick={() => immersive.exit()} className="press min-h-11 rounded-full bg-white/15 px-5 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)]">
                Close
              </button>
            </div>
          </div>
        ) : state.layout === 'scroll' ? (
          <WebtoonStage
            ref={webtoonRef}
            doc={localized}
            items={items}
            size={size}
            aspectOf={aspectOf}
            trim={trim}
            img={img}
            paper={eff.paper && !low.lowPower}
            reduced={reduced}
            gapless={kind === 'webtoon'}
            endCard={endCardNode}
            guided={{ on: state.guided.on, itemIndex: firstItem ?? 0, stop: curStop }}
            onScrollDirection={(d) => (d === 'down' ? dispatchRaw({ type: 'HUD', show: false }) : pokeHud(true))}
            onVisibleItem={(i) => {
              if (!state.guided.on && i !== firstItem) dispatchRaw({ type: 'GOTO', view: viewIndexOfItem(views, i) });
            }}
            onProgress={() => undefined}
            onTapCenter={() => onCommand({ type: 'hud' })}
            onImageError={props.onImageError}
            onExpired={props.onImageError}
          />
        ) : (
          <div ref={setBookEl} className="absolute inset-0">
            <BookStage
              doc={localized}
              items={items}
              views={views}
              state={{ ...state, view }}
              dispatch={dispatch}
              size={size}
              decision={decision}
              widthClass={ff.widthClass}
              trim={trim}
              aspectOf={aspectOf}
              rtl={rtl}
              turnStyle={kind === 'strip' ? 'slide' : eff.turn}
              lowPower={low.lowPower}
              paper={eff.paper && !low.lowPower}
              img={img}
              dedication={creator.dedication}
              endCard={endCardNode}
              hinge={hinge}
              stopsOf={stopsOfView}
              balloonPop={prefs.balloonPop && !reduced}
              sound={prefs.sound}
              peel={ff.hover && !ff.coarse && !reduced}
              onCommand={onCommand}
              onDoubleTap={(v, point, tapped) => {
                if (!guidedAvailable) return;
                if (state.guided.on) {
                  toggleGuided(false);
                  return;
                }
                // The page under the finger (the right-hand page of a spread is not the view's first item).
                const item = tapped ?? firstItemOfView(views, v);
                const vs = viewsFor('single');
                const st = stopsFor('single', viewIndexOfItem(vs, item));
                toggleGuided(true, { item, stop: stopAtPoint(st, point) });
              }}
              onFrames={(deltas) => low.reportFrames(deltas)}
              onImageError={props.onImageError}
              onExpired={props.onImageError}
              warmViews={resume ? [resume.view] : undefined}
            />
          </div>
        )}
        {state.phase === 'intro' && (
          <CoverIntro
            title={title}
            logline={localized.cover.tagline || localized.brief.logline}
            author={endCard?.authorName}
            reduced={reduced}
            rtl={rtl}
            bookEl={bookEl}
            onOpen={() => dispatch({ type: 'STEP', delta: 1 })}
          />
        )}
      </div>

      {/* Hairline progress while the HUD is hidden. */}
      {!state.hud && views.length > 1 && (
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-[41] h-[2px] bg-white/10" style={{ marginBottom: 'var(--sa-bottom)' }}>
          <div className="h-full bg-[var(--ds-accent)]" style={{ width: `${(view / (views.length - 1)) * 100}%`, marginLeft: rtl ? 'auto' : undefined, transition: reduced ? undefined : 'width 300ms ease' }} />
        </div>
      )}

      {state.phase !== 'intro' && items.length > 0 && (
        <ReaderHud
          visible={state.hud || settingsOpen}
          title={title}
          counter={counter}
          chapter={chapter?.title}
          compact={ff.widthClass === 'compact'}
          language={language}
          guided={{ on: state.guided.on, playing: state.guided.playing, available: guidedAvailable, label: guidedLabel }}
          onGuided={() => toggleGuided()}
          onPlay={() => dispatch({ type: 'PLAY', on: !state.guided.playing })}
          onPanel={(d) => dispatch({ type: 'PANEL', delta: d })}
          layout={{ effective: state.layout, allowSpread: decision.allowSpread, show: kind !== 'webtoon' && kind !== 'strip' && !state.guided.on }}
          onLayout={onLayout}
          onSettings={() => setSettingsOpen((o) => !o)}
          settingsOpen={settingsOpen}
          fullscreen={{ on: immersive.fullscreen, supported: immersive.fullscreenSupported }}
          onFullscreen={() => void immersive.toggleFullscreen()}
          onClose={() => immersive.exit()}
          onShare={share}
          onDownload={download}
          downloadBusy={downloading}
          rtl={rtl}
          onFocusWithin={() => pokeHud(true)}
          scrubber={
            state.layout === 'scroll' ? null : (
              <PageScrubber views={views} items={items} view={view} rtl={rtl} labelOf={labelOf} onGoto={(v) => dispatch({ type: 'GOTO', view: v })} onActivity={() => pokeHud(true)} />
            )
          }
        />
      )}

      {resume && state.phase !== 'intro' && (
        <div className="absolute inset-x-0 top-[calc(var(--sa-top)+68px)] z-[45] flex justify-center px-4" data-no-turn>
          <div className="flex items-center gap-1 rounded-full bg-black/55 p-1 pl-4 text-[13px] text-white shadow-lg backdrop-blur-md">
            <button type="button" className="press min-h-11 rounded-full px-2 font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)]" onClick={() => { dispatch({ type: 'GOTO', view: resume.view }); setResume(null); }}>
              Continue from {resume.label.toLowerCase()}
            </button>
            <button type="button" aria-label="Start from the beginning" className="press min-h-11 min-w-11 rounded-full px-3 text-white/75 outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)]" onClick={() => setResume(null)}>
              ✕
            </button>
          </div>
        </div>
      )}

      <ReaderSettingsSheet
        open={settingsOpen}
        compact={ff.widthClass === 'compact'}
        prefs={prefs}
        onPrefs={onPrefs}
        creator={creator}
        layout={{ pref: layoutPref, allowSpread: decision.allowSpread, options: layoutOptions }}
        onLayout={onLayout}
        lowPower={{ on: low.lowPower, measured: low.measured }}
        osReducedMotion={osReduced}
        onShortcuts={() => {
          setSettingsOpen(false);
          setShortcutsOpen(true);
        }}
        onClose={() => setSettingsOpen(false)}
        onShare={share}
        onDownload={download}
        downloadBusy={downloading}
      />
      <ReaderShortcuts open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      {toast && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[calc(var(--sa-bottom)+76px)] z-[90] flex justify-center px-4">
          <p role="status" className="max-w-[min(520px,100%)] rounded-full bg-black/75 px-4 py-2 text-center text-[13px] text-white shadow-lg backdrop-blur-md [overflow-wrap:anywhere]">
            {toast}
          </p>
        </div>
      )}

      {/* Guided View hint for small panels on phones (shown once per open, never the default). */}
      {guidedAvailable && !state.guided.on && ff.widthClass === 'compact' && state.phase === 'reading' && state.hud && view === 1 && (
        <button
          type="button"
          data-no-turn
          onClick={() => toggleGuided(true)}
          className="press absolute left-1/2 top-[calc(var(--sa-top)+68px)] z-[44] inline-flex min-h-11 -translate-x-1/2 items-center gap-2 rounded-full bg-black/55 px-4 text-[13px] font-medium text-white shadow-lg backdrop-blur-md outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)]"
        >
          <ScanEye className="h-4 w-4" aria-hidden /> Read panel by panel
        </button>
      )}

      {/* Screen readers: the page's words in reading order, and what changed. */}
      <section className="sr-only" aria-label="Page transcript" data-testid="reader-transcript">
        {transcript.map((t) => (
          <div key={t.key}>
            {t.paras.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        ))}
      </section>
      <p className="sr-only" aria-live="polite" data-testid="reader-live">
        {announce}
      </p>
    </div>
  );

  if (typeof document === 'undefined') return content;
  return createPortal(content, document.body);
};

export default ImmersiveReader;
