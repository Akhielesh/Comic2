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
export function ComicSampleReader({ look, standalone = false, story = 'paper-boat' }: {
  look: SampleLook; standalone?: boolean; story?: SampleStory;
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const enlargeButton = useRef<HTMLButtonElement>(null);
  const isShelf = !standalone && story !== 'paper-boat';
  const captionId = useId();
  const instructionsId = useId();
  const gesture = useRef<{ x: number; y: number; pointer: number } | null>(null);
  const sample = STORIES[story];
  const turn = (delta: number) => setPageIndex((page) => Math.max(0, Math.min(sample.pages.length - 1, page + delta)));
  return (
    <figure aria-labelledby={captionId} data-testid="comics-proof" data-story={story} data-standalone={standalone || undefined} className="comics-sample">
      <div
        className={cn('comics-sample-viewport', FOCUS_RING)}
        tabIndex={sample.pages.length > 1 ? 0 : undefined}
        role="group"
        aria-label={`${sample.title} pages`}
        aria-describedby={instructionsId}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            event.preventDefault();
            turn(event.key === 'ArrowRight' ? 1 : -1);
          } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            setPageIndex(event.key === 'Home' ? 0 : sample.pages.length - 1);
          }
        }}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          gesture.current = { x: event.clientX, y: event.clientY, pointer: event.pointerId };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerUp={(event) => {
          const start = gesture.current;
          gesture.current = null;
          if (!start || event.pointerId !== start.pointer) return;
          const dx = event.clientX - start.x;
          const dy = event.clientY - start.y;
          if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5) turn(dx < 0 ? 1 : -1);
        }}
        onPointerCancel={() => { gesture.current = null; }}
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
          {isShelf && <IconButton ref={enlargeButton} label={`Enlarge ${sample.title}`} variant="outline" onClick={() => setExpanded(true)}><Maximize2 /></IconButton>}
          {sample.pages.length > 1 && <>
            <IconButton label="Previous sample page" variant="outline" disabled={pageIndex === 0} onClick={() => turn(-1)}><ChevronLeft /></IconButton>
            <IconButton label="Next sample page" variant="outline" disabled={pageIndex === sample.pages.length - 1} onClick={() => turn(1)}><ChevronRight /></IconButton>
          </>}
        </div>
      </figcaption>
      {expanded && (
        <Dialog open={expanded} onOpenChange={setExpanded}>
          <DialogContent className="comics-expanded-page" closeLabel="Close enlarged page" onCloseAutoFocus={(event) => {
            event.preventDefault();
            enlargeButton.current?.focus({ preventScroll: true });
          }}>
            <DialogTitle>{sample.title}</DialogTitle>
            <DialogDescription>Page {pageIndex + 1} of {sample.pages.length}. {sample.pages[pageIndex]}</DialogDescription>
            <div aria-hidden><SampleArtwork look={look} story={story} page={pageIndex + 1} active standalone fullSize /></div>
          </DialogContent>
        </Dialog>
      )}
      <p id={instructionsId} className="sr-only">{sample.pages.length > 1 ? 'Use the left and right arrow keys, swipe horizontally, or use the previous and next page buttons. ' : ''}{sample.pages[pageIndex]}</p>
    </figure>
  );
}
