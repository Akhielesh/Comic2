import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { DENSITY, FOCUS_RING } from '../chat/studioDesign';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ds/Dialog';
import { IconButton } from '../ds/IconButton';
import { prefersReducedMotion } from '../ds/useReducedMotion';
import { useComicTheme } from '../comicstudio/useComicTheme';
import { FEATURED_SAMPLES, SAMPLE_COMICS, findSample, sampleLibraryHref, type SampleComic, type SampleStory } from '../comicstudio/library/sampleCatalog';
import { ComicSampleReader } from './ComicSampleReader';
import './comicSampleDeck.css';

function SampleCover({ comic, eager = false }: { comic: SampleComic; eager?: boolean }) {
  const page = comic.pages[0];
  return <img src={comic.cover ?? page.src} srcSet={comic.cover ? undefined : page.srcSet} alt="" width={page.width} height={page.height}
    sizes="(max-width: 600px) 72vw, 280px" loading={eager ? 'eager' : 'lazy'} decoding="async" draggable={false} />;
}

/** Native public reading links; a caller may open the deck without breaking modified clicks. */
export function ComicSampleShelf({ comics = FEATURED_SAMPLES, onRead, title = 'Five stories. Five worlds.' }: {
  comics?: readonly SampleComic[]; onRead?: (event: React.MouseEvent<HTMLAnchorElement>, story: SampleStory) => void; title?: string;
}) {
  const titleId = useId();
  const strip = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ scrollable: false, start: true, end: true });
  const measureEdges = () => {
    const element = strip.current;
    if (!element) return;
    const max = element.scrollWidth - element.clientWidth;
    setEdges(previous => {
      const next = { scrollable: max > 2, start: element.scrollLeft <= 2, end: element.scrollLeft >= max - 2 };
      return previous.scrollable === next.scrollable && previous.start === next.start && previous.end === next.end ? previous : next;
    });
  };
  useEffect(() => {
    measureEdges();
    if (!strip.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measureEdges); observer.observe(strip.current);
    return () => observer.disconnect();
  }, [comics.length]);
  return <section className="comic-sample-shelf" aria-labelledby={titleId}>
    <div className="comic-sample-shelf-heading"><h2 id={titleId}>{title}</h2>{edges.scrollable && <div className="comic-sample-shelf-controls">
      <IconButton label="Scroll to previous sample comics" variant="outline" disabled={edges.start} onClick={() => strip.current?.scrollBy({ left: -(strip.current.clientWidth * .8), behavior: prefersReducedMotion() ? 'auto' : 'smooth' })}><ChevronLeft /></IconButton>
      <IconButton label="Scroll to next sample comics" variant="outline" disabled={edges.end} onClick={() => strip.current?.scrollBy({ left: strip.current.clientWidth * .8, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })}><ChevronRight /></IconButton>
    </div>}</div>
    <ul ref={strip} onScroll={measureEdges} className="comic-sample-shelf-track" aria-label="Studio sample comics">
      {comics.map(comic => <li key={comic.id}><a href={sampleLibraryHref(comic.id)} className={cn('comic-sample-book', DENSITY.coarse, FOCUS_RING)} onClick={event => onRead?.(event, comic.id)} aria-label={`Read ${comic.title}`}>
        <div className="comic-sample-cover" data-comic-art="" aria-hidden="true"><SampleCover comic={comic} /></div>
        <div className="comic-sample-book-copy"><span className="comic-sample-style">{comic.style}</span><h3>{comic.title}</h3><p>{comic.synopsis}</p><span className="comic-sample-read">Read the story <ArrowRight aria-hidden /></span></div>
      </a></li>)}
    </ul>
  </section>;
}

function DeckContents({ initialStory }: { initialStory?: SampleStory }) {
  const initialId = initialStory ?? FEATURED_SAMPLES[0].id;
  const [activeId, setActiveId] = useState<SampleStory>(initialId);
  const [scrolling, setScrolling] = useState(false);
  const selectedIndex = useRef(SAMPLE_COMICS.findIndex(comic => comic.id === initialId));
  const scrollTarget = useRef<number | null>(selectedIndex.current);
  const track = useRef<HTMLUListElement>(null);
  const reader = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const index = SAMPLE_COMICS.findIndex(comic => comic.id === activeId);
  const comic = findSample(activeId)!;
  const select = (next: number, focus = false) => {
    const entry = SAMPLE_COMICS[next];
    const card = track.current?.children[next] as HTMLElement | undefined;
    if (!entry || !card || !track.current) return;
    selectedIndex.current = next;
    scrollTarget.current = next;
    setActiveId(entry.id);
    track.current.scrollTo({ left: card.offsetLeft - (track.current.clientWidth - card.clientWidth) / 2, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    if (focus) card.querySelector('button')?.focus({ preventScroll: true });
  };
  useEffect(() => {
    const selected = track.current?.children[SAMPLE_COMICS.findIndex(entry => entry.id === initialId)] as HTMLElement | undefined;
    if (selected && track.current) track.current.scrollLeft = selected.offsetLeft - (track.current.clientWidth - selected.clientWidth) / 2;
    return () => clearTimeout(timer.current);
  }, [initialId]);
  return <>
    <div className="comic-deck-controls"><IconButton label="Previous sample comic" variant="outline" disabled={index === 0} onClick={() => select(selectedIndex.current - 1)}><ChevronLeft /></IconButton>
      <p role="status" aria-live="polite"><span>{index + 1} / {SAMPLE_COMICS.length}</span> {comic.title}</p>
      <IconButton label="Next sample comic" variant="outline" disabled={index === SAMPLE_COMICS.length - 1} onClick={() => select(selectedIndex.current + 1)}><ChevronRight /></IconButton>
    </div>
    <ul ref={track} onPointerDown={() => { scrollTarget.current = null; }} onWheel={event => { if (Math.abs(event.deltaX) > 0 || event.shiftKey) scrollTarget.current = null; }} className="comic-deck-track" aria-label="Choose a sample comic" data-scrolling={scrolling || undefined}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        select(event.key === 'Home' ? 0 : event.key === 'End' ? SAMPLE_COMICS.length - 1 : Math.max(0, Math.min(SAMPLE_COMICS.length - 1, selectedIndex.current + (event.key === 'ArrowRight' ? 1 : -1))), true);
      }} onScroll={() => {
        setScrolling(true); clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          const strip = track.current;
          if (!strip) return;
          const center = strip.scrollLeft + strip.clientWidth / 2;
          let nearest = 0, distance = Infinity;
          Array.from(strip.children).forEach((child, at) => { const card = child as HTMLElement; const delta = Math.abs(card.offsetLeft + card.clientWidth / 2 - center); if (delta < distance) { nearest = at; distance = delta; } });
          // A smooth scroll can finish after a newer button/key selection. It must not
          // overwrite that deliberate target; only native user scrolling chooses by position.
          if (scrollTarget.current === null) {
            selectedIndex.current = nearest;
            setActiveId(SAMPLE_COMICS[nearest].id);
          } else if (nearest === scrollTarget.current) scrollTarget.current = null;
          setScrolling(false);
        }, 140);
      }}>
      {SAMPLE_COMICS.map((entry, at) => <li key={entry.id} data-active={entry.id === activeId}><button type="button" aria-pressed={entry.id === activeId} aria-label={`Read ${entry.title}`} className={cn(DENSITY.coarse, FOCUS_RING)} onClick={() => select(at)}>
        <div className="comic-deck-card-art" data-comic-art="" aria-hidden="true"><SampleCover comic={entry} eager={at < 2} /></div><span>{entry.title}</span><small>{entry.style}</small>
      </button></li>)}
    </ul>
    <div ref={reader} className="comic-deck-reader" data-selected-sample={comic.id}>
      <div className="comic-deck-story-heading"><p>{comic.synopsis}</p><span>{comic.pages.length} {comic.pages.length === 1 ? 'complete page' : 'pages'} · {comic.pages.reduce((total, page) => total + page.panels, 0)} panels</span></div>
      <ComicSampleReader key={comic.id} story={comic.id} standalone />
      <a href={sampleLibraryHref(comic.id)} className={cn('comic-deck-library-link', DENSITY.coarse, FOCUS_RING)}>Open {comic.title} in the Library <ArrowRight aria-hidden /></a>
    </div>
  </>;
}

export function ComicSampleDeckDialog({ open, onOpenChange, initialStory, returnFocusRef }: {
  open: boolean; onOpenChange: (open: boolean) => void; initialStory?: SampleStory; returnFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const { theme } = useComicTheme();
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="comic-deck-dialog" data-comic-theme={theme} closeLabel="Close sample comics"
    onCloseAutoFocus={event => { if (returnFocusRef?.current?.isConnected) { event.preventDefault(); returnFocusRef.current.focus({ preventScroll: true }); } }}>
    <div className="comic-deck-heading"><DialogTitle>Explore sample comics</DialogTitle><DialogDescription>Choose a story. Scroll down to read every panel.</DialogDescription></div>
    <div className="comic-deck-body"><DeckContents initialStory={initialStory} /></div>
  </DialogContent></Dialog>;
}

/** Self-contained entry for the creation workspace: opening and closing never changes its route or draft. */
export function ComicSampleExploreButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <><button ref={trigger} type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" className={cn('comic-sample-explore', DENSITY.coarse, FOCUS_RING, className)}>
    <span className="comic-sample-explore-art" aria-hidden>{FEATURED_SAMPLES.slice(0, 3).map(comic => <span key={comic.id}><SampleCover comic={comic} /></span>)}</span>
    <span><strong>Explore sample comics</strong><small>Five new stories, five different looks.</small></span><ArrowRight aria-hidden />
  </button><ComicSampleDeckDialog open={open} onOpenChange={setOpen} returnFocusRef={trigger} /></>;
}
