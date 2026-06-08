import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Project, ComicPanel, DialogueBlock, TextLayout } from '../types';
import { CommentSection } from './CommentSection';
import { X, ChevronLeft, ChevronRight, Maximize2, Minimize2, BookOpen, MessageSquareText } from 'lucide-react';
import { PanelDialogue } from './PanelDialogue';
import { derivePanelTitle } from '../services/panelDescription';
import { loadReaderState, saveReaderState } from '../services/db';

import { ReviewModal } from './modals/ReviewModal';
import { submitReview } from '../services/db';
import { useAuth } from '../contexts/AuthContext';
import { StaticSiteHeader } from './layout/StaticSiteHeader';
import { LegalMicroLinks } from './layout/LegalMicroLinks';

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

export const ComicReader: React.FC<ComicReaderProps> = ({
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
  // ... existing state ...

  // Review Trigger Logic
  const handleAttemptClose = () => {
    // Only prompt for read-only (public) comics, and 30% chance, and ensure we haven't already reviewed (locally tracked for session)
    // For MVP, just random check.
    const shouldPrompt = isReadOnly && Math.random() < 0.3;

    if (shouldPrompt) {
      setShowReviewModal(true);
    } else {
      onClose();
    }
  };

  const handleReviewSubmit = async (data: any) => {
    await submitReview({
      ...data,
      projectId: project.id
    });
    onClose(); // Close after review
  };

  const [pageIndex, setPageIndex] = useState(0);
  const [flipDirection, setFlipDirection] = useState<'next' | 'prev' | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
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
  const readerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<number | null>(null);
  const touchStartX = useRef<number | null>(null);
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

  useEffect(() => {
    const handleChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleChange);
    return () => document.removeEventListener('fullscreenchange', handleChange);
  }, []);

  const pages = useMemo(() => {
    const list: Array<{ type: 'cover' | 'panel'; panel?: ComicPanel; imageUrl?: string }> = [];
    if (project.state.coverImageUrl) {
      list.push({ type: 'cover', imageUrl: project.state.coverImageUrl });
    }
    project.state.panels.forEach((panel) => {
      list.push({ type: 'panel', panel, imageUrl: panel.imageUrl });
    });
    return list;
  }, [project.state.coverImageUrl, project.state.panels]);

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
    setFlipDirection('next');
    setPageIndex((prev) => {
      const next = prev + 1;
      persistReaderState({ pageIndex: next, mode: 'flip' });
      return next;
    });
  };

  const goPrev = () => {
    if (pageIndex <= 0) return;
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

  // Touch swipe in flip mode (horizontal drag turns the page).
  const onTouchStart = (e: React.TouchEvent) => { touchStartX.current = e.touches[0]?.clientX ?? null; };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current == null) return;
    const dx = (e.changedTouches[0]?.clientX ?? touchStartX.current) - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) < 45) return;
    if (dx < 0) goNext(); else goPrev();
  };

  // Keyboard navigation: arrows/space/PageUp-Down turn pages (flip) or page-scroll
  // (scroll), Home/End jump to ends, Esc closes. Ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape') { handleAttemptClose(); return; }
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
  }, [readerMode, pageIndex, pages.length]);

  const toggleFullscreen = async () => {
    if (!document.fullscreenElement && readerRef.current) {
      await readerRef.current.requestFullscreen().catch(() => null);
      setIsFullscreen(true);
    } else {
      await document.exitFullscreen().catch(() => null);
      setIsFullscreen(false);
    }
  };

  return (
    <div ref={readerRef} className="fixed inset-0 z-50 bg-slate-100 overflow-hidden flex flex-col">
      <StaticSiteHeader
        isAuthenticated={!!user}
        onGoHome={() => onNavigate?.('home')}
        onViewComics={() => onNavigate?.('gallery')}
        onEnterStudio={() => onNavigate?.('dashboard')}
        onEnterComicForge={() => onNavigate?.('comicforge')}
        onSignIn={() => onNavigate?.('auth')}
        onOpenProfile={() => onNavigate?.('settings')}
        onNavigate={onNavigate || (() => undefined)}
      />

      {/* Reader Controls */}
      <header className="h-16 bg-white border-b-4 border-black flex items-center justify-between gap-2 px-3 sm:px-6 shadow-lg shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="font-display text-lg sm:text-2xl text-black truncate">{project.name}</h1>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button
            onClick={() => onNavigate?.('gallery')}
            className="text-xs font-bold border-2 border-black rounded-lg px-3 py-1 shrink-0 whitespace-nowrap bg-slate-50"
          >
            Library
          </button>
          <button
            onClick={() => onNavigate?.('dashboard')}
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
            onClick={toggleFullscreen}
            className="text-xs font-bold border-2 border-black rounded-lg px-3 py-1 shrink-0 whitespace-nowrap bg-slate-50 flex items-center gap-1"
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            {isFullscreen ? 'Exit' : 'Full'}
          </button>
          <button onClick={handleAttemptClose} className="p-2 hover:bg-slate-100 rounded-full transition-colors shrink-0">
            <X className="w-6 h-6" />
          </button>
        </div>
      </header >

      <div className="flex-1 flex overflow-hidden">
        {/* Main Comic Area */}
        <div className="flex-1 overflow-hidden bg-slate-200">
          {readerMode === 'scroll' ? (
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="h-full overflow-y-auto custom-scrollbar p-4 md:p-8 flex justify-center"
            >
              <div className="max-w-4xl w-full bg-white shadow-2xl min-h-full">
                {showStory && (
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
                <div className={`p-4 sm:p-8 ${getLayoutClass()}`}>
                  {allPanelsMissingArt && (
                    <div className="col-span-full text-center py-6 text-amber-700 font-bold border-2 border-amber-400 bg-amber-50 rounded-lg">
                      All panel artwork is currently missing for this comic.
                    </div>
                  )}
                  {project.state.panels.map((panel, idx) => (
                    <div key={idx} className={`border-2 border-black shadow-sm relative ${getPanelClass(idx)}`}>
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
                  ))}
                  {project.state.panels.length === 0 && (
                    <div className="col-span-full text-center py-20 text-slate-400 font-display text-2xl">
                      This comic hasn't been drawn yet!
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center p-2 sm:p-4">
              <div className="flex flex-col w-full max-w-5xl flex-1 min-h-0 bg-white shadow-2xl border-4 border-black rounded-xl overflow-hidden">
                {showStory && (
                  <div className="p-4 border-b-4 border-black bg-white shrink-0 max-h-40 overflow-y-auto custom-scrollbar">
                    <div className="border-2 border-black rounded-lg p-3 bg-slate-50">
                      <div className="text-xs font-bold uppercase text-slate-500 mb-2">Story</div>
                      <pre className="whitespace-pre-wrap font-comic text-sm text-slate-700">{project.state.script || "No story text yet."}</pre>
                    </div>
                  </div>
                )}
                {pages.length > 0 ? (
                  // The page region flexes to fill remaining height; the page itself is bounded
                  // by BOTH max-h-full and max-w-full so it always scales to fit the viewport on
                  // either axis — never oversized, never leaving dead space.
                  <div
                    className="flex-1 min-h-0 flex items-center justify-center bg-slate-100 overflow-hidden p-2 sm:p-3 select-none"
                    onTouchStart={onTouchStart}
                    onTouchEnd={onTouchEnd}
                  >
                    <div
                      key={pageIndex}
                      className={`relative inline-flex max-h-full max-w-full ${flipDirection === 'next' ? 'animate-page-flip-next' : flipDirection === 'prev' ? 'animate-page-flip-prev' : ''}`}
                    >
                      {pages[pageIndex]?.imageUrl ? (
                        <img
                          src={pages[pageIndex].imageUrl}
                          alt={pages[pageIndex]?.panel ? derivePanelTitle(pages[pageIndex].panel!, pageIndex) : 'Comic cover'}
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
                <div className="shrink-0 border-t-4 border-black bg-slate-50">
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
              </div>
              <div className="text-[11px] text-slate-500 font-comic mt-1.5 hidden sm:block">← → or space to turn · Home/End to jump · Esc to close · swipe on touch</div>
            </div>
          )}
        </div>

        {showInfo && (
          <aside className="w-full md:w-80 shrink-0 border-l-4 border-black bg-white p-4 overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-display text-xl">Comic Info</h2>
              <button onClick={() => setShowInfo(false)} className="p-2 -mr-2 rounded-full hover:bg-slate-100 md:hidden" aria-label="Close info">
                <X className="w-5 h-5" />
              </button>
            </div>
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
            </div>
          </aside>
        )}
      </div>

      <LegalMicroLinks
        onOpenPrivacy={onOpenPrivacy}
        onOpenTerms={onOpenTerms}
        onOpenFaq={onOpenFaq}
      />

      {showComments && (
        <div className="fixed inset-y-0 left-0 w-full md:w-96 bg-white border-r-4 border-black z-50 shadow-comic flex flex-col">
          <div className="p-4 border-b-4 border-black flex items-center justify-between bg-white shrink-0">
            <div className="font-display text-xl">Comments</div>
            <button onClick={() => setShowComments(false)} className="p-2 rounded-full hover:bg-slate-100">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto bg-slate-50">
            <CommentSection projectId={project.id} onNavigate={onNavigate} />
          </div>
        </div>
      )}
      {/* Review Modal */}
      <ReviewModal
        isOpen={showReviewModal}
        onClose={onClose} // If they skip/close modal, we just close the reader
        onSubmit={handleReviewSubmit}
        projectName={project.name}
      />
    </div >
  );
};
