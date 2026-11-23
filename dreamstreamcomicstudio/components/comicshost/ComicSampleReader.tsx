import React, { useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Maximize2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { getStylePreset } from '../../shared/comic/stylePresets';
import { FOCUS_RING } from '../chat/studioDesign';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ds/Dialog';
import { IconButton } from '../ds/IconButton';
import { useImageReveal } from '../ds/useImageReveal';
import { samplePageUrl, type SampleLook } from '../comicstudio/library/sampleArt';
import './comicsLanding.css';

export type SampleStory = 'paper-boat' | 'last-tram' | 'hello-europa' | 'a-small-giant';
export const SHELF_EDITIONS = ['last-tram', 'hello-europa', 'a-small-giant'] as const;

export const STORIES = {
  'hello-europa': {
    title: 'Hello, Europa',
    pages: ['On Europa, an astronaut follows a distress signal, frees a rover from the ice and reconnects its power. Together they watch Jupiter rise.']
  },
  'a-small-giant': {
    title: 'A Small Giant',
    pages: ['A mouse finds a hedgehog shivering in the rain. With help from an owl, the mouse pulls a scarf over them. All three share a warm drink beneath it.']
  },
  'paper-boat': {
    title: 'The Paper Boat',
    pages: [
      'Mira and Biscuit spot a paper boat drifting down the canal at dusk.',
      'They race along the canal to catch the paper boat before the rain.'
    ]
  },
  'last-tram': {
    title: 'The Last Tram',
    pages: [
      'A traveler watches the moonlit harbor, then boards the last tram along the coast.',
      'The traveler steps off the tram, sets a paper boat afloat, and watches it drift across the moonlit harbor.'
    ]
  }
} as const;

const ART_HEIGHT = { 'last-tram': [960, 1000], 'hello-europa': [800], 'a-small-giant': [1499] } as const;

function SampleArtwork({ look, story, page, active, standalone, fullSize = false }: {
  look: SampleLook; story: SampleStory; page: number; active: boolean; standalone: boolean; fullSize?: boolean;
}) {
  const path = `/assets/comic-sample/${story}-page-${page}`;
  const src = story === 'paper-boat' ? samplePageUrl(look, page) : `${path}-1200.webp`;
  const pageHeight = story === 'paper-boat' ? 1000 : ART_HEIGHT[story][page - 1];
  const reveal = useImageReveal(src);
  return (
    <div className="comics-sample-art" data-comic-art="">
      <img
        ref={reveal.ref}
        alt=""
        width={1200}
        height={pageHeight}
        src={src}
        srcSet={story === 'paper-boat' || fullSize ? undefined : `${path}-480.webp 480w, ${path}-768.webp 768w, ${src} 1200w`}
        sizes={standalone ? '(max-width: 600px) 85vw, 760px' : '(max-width: 719px) 85vw, 48vw'}
        decoding="async"
        fetchPriority={active ? 'high' : 'low'}
        draggable={false}
        data-reveal={reveal.fromCache ? 'cached' : reveal.phase}
      />
      {reveal.phase === 'error' && <span className="comics-sample-error">Artwork could not load. Please refresh to try again.</span>}
    </div>
  );
}

/** The shelf mounts the current page on demand. The style comparison keeps its two-page filmstrip. */
export function ComicSampleReader({ look, standalone = false, story = 'paper-boat', reader }: {
  look: SampleLook; standalone?: boolean; story?: SampleStory;
  reader?: {
    open: boolean;
    show(trigger: HTMLButtonElement): void;
    close(): void;
    restoreFocus(): void;
  };
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const pageScroll = useRef<HTMLDivElement>(null);
  const isShelf = !standalone && story !== 'paper-boat';
  const captionId = useId();
  const instructionsId = useId();
  const gesture = useRef<{ x: number; y: number; pointer: number } | null>(null);
  const sample = STORIES[story];
  const goToPage = (index: number) => {
    const next = Math.max(0, Math.min(sample.pages.length - 1, index));
    if (next === pageIndex) return;
    setPageIndex(next);
    if (pageScroll.current) pageScroll.current.scrollTop = 0;
  };
  const turn = (delta: number) => goToPage(pageIndex + delta);
  const onPageKey = (event: React.KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || sample.pages.length < 2) return;
    switch (event.key) {
      case 'ArrowRight': turn(1); break;
      case 'ArrowLeft': turn(-1); break;
      case 'Home': goToPage(0); break;
      case 'End': goToPage(sample.pages.length - 1); break;
      default: return;
    }
    event.preventDefault();
  };
  const swipe = {
    onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
      if (!event.isPrimary || event.button !== 0 || sample.pages.length < 2) return;
      gesture.current = { x: event.clientX, y: event.clientY, pointer: event.pointerId };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
      const start = gesture.current;
      gesture.current = null;
      if (!start || event.pointerId !== start.pointer) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5) turn(dx < 0 ? 1 : -1);
    },
    onPointerCancel() { gesture.current = null; }
  };
  const pageButtons = sample.pages.length > 1 && <>
    <IconButton label="Previous sample page" variant="outline" disabled={pageIndex === 0} onClick={() => turn(-1)}><ChevronLeft /></IconButton>
    <IconButton label="Next sample page" variant="outline" disabled={pageIndex === sample.pages.length - 1} onClick={() => turn(1)}><ChevronRight /></IconButton>
  </>;
  return (
    <figure aria-labelledby={captionId} data-testid="comics-proof" data-story={story} data-standalone={standalone || undefined} className="comics-sample">
      <div
        className={cn('comics-sample-viewport', FOCUS_RING)}
        tabIndex={sample.pages.length > 1 ? 0 : undefined}
        role="group"
        aria-label={`${sample.title} pages`}
        aria-describedby={instructionsId}
        onKeyDown={onPageKey}
        {...swipe}
      >
        {isShelf ? (
          <div key={pageIndex} className="comics-shelf-page" aria-hidden>
            <SampleArtwork look={look} story={story} page={pageIndex + 1} active standalone={false} />
          </div>
        ) : (
          <div aria-hidden className="comics-sample-track" data-page={pageIndex}>
            {sample.pages.map((description, index) => (
              <div key={description} className="comics-sample-page" data-active={index === pageIndex}>
                <SampleArtwork key={`${story}-${look}`} look={look} story={story} page={index + 1} active={index === pageIndex} standalone={standalone} />
              </div>
            ))}
          </div>
        )}
      </div>
      <figcaption className="comics-sample-caption">
        <div className="comics-sample-name">
          <h2 id={captionId}>{sample.title}</h2>
          <p>Sample comic</p>
        </div>
        <span role="status" aria-atomic="true" className="comics-sample-count">
          <span aria-hidden>{pageIndex + 1} / {sample.pages.length}</span>
          <span className="sr-only">Page {pageIndex + 1} of {sample.pages.length}. {story === 'paper-boat' ? `${getStylePreset(look)?.name ?? look}. ` : ''}{sample.pages[pageIndex]}</span>
        </span>
        <div className="comics-sample-controls">
          {isShelf && reader && <IconButton label={`Enlarge ${sample.title}`} variant="outline" aria-haspopup="dialog" onClick={event => reader.show(event.currentTarget)}><Maximize2 /></IconButton>}
          {pageButtons}
        </div>
      </figcaption>
      {reader?.open && (
        <Dialog open onOpenChange={open => { if (!open) reader.close(); }}>
          <DialogContent className="comics-expanded-page" closeLabel="Close enlarged page" onKeyDown={onPageKey} onCloseAutoFocus={(event) => {
            event.preventDefault();
            reader.restoreFocus();
          }}>
            <header className="comics-reader-mast">
              <DialogTitle>{sample.title}</DialogTitle>
              <div className="comics-reader-tools">
                <span role="status" aria-atomic="true">Page {pageIndex + 1} of {sample.pages.length}<span className="sr-only">. {sample.pages[pageIndex]}</span></span>
                {pageButtons}
              </div>
            </header>
            <div ref={pageScroll} className="comics-reader-leaf" tabIndex={0} role="region" aria-label="Comic artwork and page description" {...swipe}>
              <div key={pageIndex} aria-hidden><SampleArtwork look={look} story={story} page={pageIndex + 1} active standalone fullSize /></div>
              <DialogDescription>{sample.pages[pageIndex]}</DialogDescription>
            </div>
          </DialogContent>
        </Dialog>
      )}
      <p id={instructionsId} className="sr-only">{sample.pages.length > 1 ? 'Use the left and right arrow keys, swipe horizontally, or use the previous and next page buttons. ' : ''}{sample.pages[pageIndex]}</p>
    </figure>
  );
}
