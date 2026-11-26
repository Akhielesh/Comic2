import React, { useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Maximize2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { getStylePreset } from '../../shared/comic/stylePresets';
import { FOCUS_RING } from '../chat/studioDesign';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ds/Dialog';
import { IconButton } from '../ds/IconButton';
import { useImageReveal } from '../ds/useImageReveal';
import { samplePageUrl, type SampleLook } from '../comicstudio/library/sampleArt';
import { PaperTurnSurface, type PaperTurnDirection, type PaperTurnHandle } from '../comicstudio/reader/PaperTurnSurface';
import { readReduceMotionPref } from '../comicstudio/immersive/readerMotionPref';
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
        fetchPriority={active ? 'high' : 'auto'}
        draggable={false}
        data-reveal={reveal.fromCache || (!active && reveal.phase !== 'error') ? 'cached' : reveal.phase}
      />
      {reveal.phase === 'error' && <span className="comics-sample-error">Artwork could not load. Please refresh to try again.</span>}
    </div>
  );
}

/** Each sample loads the visible illustration. A turn requests the adjacent page on demand. */
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
  const [reduceMotion] = useState(readReduceMotionPref);
  const pageScroll = useRef<HTMLDivElement>(null);
  const isShelf = !standalone && story !== 'paper-boat';
  const captionId = useId();
  const instructionsId = useId();
  const inlineTurn = useRef<PaperTurnHandle>(null);
  const dialogTurn = useRef<PaperTurnHandle>(null);
  const sample = STORIES[story];
  const goToPage = (index: number) => {
    const next = Math.max(0, Math.min(sample.pages.length - 1, index));
    if (next === pageIndex) return;
    setPageIndex(next);
    if (pageScroll.current) pageScroll.current.scrollTop = 0;
  };
  const canTurn = (dir: PaperTurnDirection) => pageIndex + dir >= 0 && pageIndex + dir < sample.pages.length;
  const onPageKey = (event: React.KeyboardEvent, handle: React.RefObject<PaperTurnHandle | null>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || sample.pages.length < 2) return;
    switch (event.key) {
      case 'ArrowRight': handle.current?.turn(1); break;
      case 'ArrowLeft': handle.current?.turn(-1); break;
      case 'Home':
      case 'End': {
        // Home and End flip as well: the first page swings in backwards, the last one forwards.
        const target = event.key === 'Home' ? 0 : sample.pages.length - 1;
        if (target === pageIndex) break;
        if (handle.current) handle.current.jump(target > pageIndex ? 1 : -1, () => goToPage(target), renderArtwork(target, handle === dialogTurn));
        else goToPage(target);
        break;
      }
      default: return;
    }
    event.preventDefault();
  };
  const pageButtons = (handle: React.RefObject<PaperTurnHandle | null>) => sample.pages.length > 1 && <>
    <IconButton label="Previous sample page" variant="outline" disabled={!canTurn(-1)} onClick={() => handle.current?.turn(-1)}><ChevronLeft /></IconButton>
    <IconButton label="Next sample page" variant="outline" disabled={!canTurn(1)} onClick={() => handle.current?.turn(1)}><ChevronRight /></IconButton>
  </>;
  const renderArtwork = (index: number, fullSize: boolean) => (
    <div className={!fullSize && isShelf ? 'comics-shelf-page' : undefined} aria-hidden>
      <SampleArtwork look={look} story={story} page={index + 1} active={index === pageIndex} standalone={fullSize || standalone} fullSize={fullSize} />
    </div>
  );
  const renderSurface = (fullSize: boolean) => {
    const current = renderArtwork(pageIndex, fullSize);
    return (
      <div className={!fullSize && !isShelf ? 'comics-sample-inset' : undefined}>
        {sample.pages.length === 1 ? current : (
          <PaperTurnSurface
            ref={fullSize ? dialogTurn : inlineTurn}
            // The sample shows the house turn: the page flip. Reduce motion (the OS setting, or the reader's own from
            // the full-screen reader's settings on this device) changes the page at once.
            turnStyle="flip"
            reducedMotion={reduceMotion}
            pageKey={`${story}/${look}/${pageIndex}`}
            enabled={fullSize || !reader?.open}
            canTurn={canTurn}
            renderAdjacent={dir => canTurn(dir) ? renderArtwork(pageIndex + dir, fullSize) : null}
            onTurn={dir => goToPage(pageIndex + dir)}
          >{current}</PaperTurnSurface>
        )}
      </div>
    );
  };
  return (
    <figure aria-labelledby={captionId} data-testid="comics-proof" data-story={story} data-standalone={standalone || undefined} className="comics-sample">
      <div
        className={cn('comics-sample-viewport', FOCUS_RING)}
        tabIndex={sample.pages.length > 1 ? 0 : undefined}
        role="group"
        aria-label={`${sample.title} pages`}
        aria-describedby={instructionsId}
        onKeyDown={event => onPageKey(event, inlineTurn)}
      >
        {renderSurface(false)}
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
          {pageButtons(inlineTurn)}
        </div>
      </figcaption>
      {reader?.open && (
        <Dialog open onOpenChange={open => { if (!open) reader.close(); }}>
          <DialogContent className="comics-expanded-page" closeLabel="Close enlarged page" onKeyDown={event => onPageKey(event, dialogTurn)} onCloseAutoFocus={(event) => {
            event.preventDefault();
            reader.restoreFocus();
          }}>
            <header className="comics-reader-mast">
              <DialogTitle>{sample.title}</DialogTitle>
              <div className="comics-reader-tools">
                <span role="status" aria-atomic="true">Page {pageIndex + 1} of {sample.pages.length}<span className="sr-only">. {sample.pages[pageIndex]}</span></span>
                {pageButtons(dialogTurn)}
              </div>
            </header>
            <div ref={pageScroll} className="comics-reader-leaf" tabIndex={0} role="region" aria-label="Comic artwork and page description">
              {renderSurface(true)}
              <DialogDescription>{sample.pages[pageIndex]}</DialogDescription>
            </div>
          </DialogContent>
        </Dialog>
      )}
      <p id={instructionsId} className="sr-only">{sample.pages.length > 1 ? 'Use the left and right arrow keys, swipe horizontally, or use the previous and next page buttons. ' : ''}{sample.pages[pageIndex]}</p>
    </figure>
  );
}
