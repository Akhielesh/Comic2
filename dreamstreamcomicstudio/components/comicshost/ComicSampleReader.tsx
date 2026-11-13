import React, { useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { getStylePreset } from '../../shared/comic/stylePresets';
import { FOCUS_RING } from '../chat/studioDesign';
import { IconButton } from '../ds/IconButton';
import { useImageReveal } from '../ds/useImageReveal';
import { samplePageUrl, type SampleLook } from '../comicstudio/library/sampleArt';
import './comicsLanding.css';

export type SampleStory = 'paper-boat' | 'last-tram';

const STORIES = {
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

function SampleArtwork({ look, story, page, active, standalone }: {
  look: SampleLook; story: SampleStory; page: number; active: boolean; standalone: boolean;
}) {
  const src = story === 'last-tram' ? `/assets/comic-sample/last-tram-page-${page}-1200.webp` : samplePageUrl(look, page);
  const reveal = useImageReveal(src);
  return (
    <div className="comics-sample-art" data-comic-art="">
      <img
        ref={reveal.ref}
        alt=""
        width={1200}
        height={1000}
        src={src}
        srcSet={story === 'last-tram' ? `/assets/comic-sample/last-tram-page-${page}-480.webp 480w, /assets/comic-sample/last-tram-page-${page}-768.webp 768w, ${src} 1200w` : undefined}
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

/** A local two-page comic; vertical touch gestures remain native scrolling. */
export function ComicSampleReader({ look, standalone = false, story = 'paper-boat' }: {
  look: SampleLook; standalone?: boolean; story?: SampleStory;
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const captionId = useId();
  const instructionsId = useId();
  const gesture = useRef<{ x: number; y: number; pointer: number } | null>(null);
  const sample = STORIES[story];
  const turn = (delta: number) => setPageIndex((page) => Math.max(0, Math.min(sample.pages.length - 1, page + delta)));
  return (
    <figure aria-labelledby={captionId} data-testid="comics-proof" data-story={story} data-standalone={standalone || undefined} className="comics-sample">
      <div
        className={cn('comics-sample-viewport', FOCUS_RING)}
        tabIndex={0}
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
        <div aria-hidden className="comics-sample-track" data-page={pageIndex}>
          {sample.pages.map((description, index) => (
            <div key={description} className="comics-sample-page" data-active={index === pageIndex}>
              <SampleArtwork key={`${story}-${look}`} look={look} story={story} page={index + 1} active={index === pageIndex} standalone={standalone} />
            </div>
          ))}
        </div>
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
          <IconButton label="Previous sample page" variant="outline" disabled={pageIndex === 0} onClick={() => turn(-1)}><ChevronLeft /></IconButton>
          <IconButton label="Next sample page" variant="outline" disabled={pageIndex === sample.pages.length - 1} onClick={() => turn(1)}><ChevronRight /></IconButton>
        </div>
      </figcaption>
      <p id={instructionsId} className="sr-only">Use the left and right arrow keys, swipe horizontally, or use the previous and next page buttons. {sample.pages[pageIndex]}</p>
    </figure>
  );
}
