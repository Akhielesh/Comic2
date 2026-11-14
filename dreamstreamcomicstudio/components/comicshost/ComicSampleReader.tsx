import React, { useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Maximize2, Minimize2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { getStylePreset } from '../../shared/comic/stylePresets';
import { FOCUS_RING } from '../chat/studioDesign';
import { IconButton } from '../ds/IconButton';
import { useImageReveal } from '../ds/useImageReveal';
import { type SampleLook } from '../comicstudio/library/sampleArt';
import { findSample, sampleArtwork, type SamplePage, type SampleStory } from '../comicstudio/library/sampleCatalog';
import './comicsLanding.css';
export type { SampleStory } from '../comicstudio/library/sampleCatalog';

function SampleArtwork({ page, active, standalone, enlarged = false }: { page: SamplePage; active: boolean; standalone: boolean; enlarged?: boolean }) {
  const reveal = useImageReveal(page.src);
  return (
    <div className="comics-sample-art" data-comic-art="" style={standalone ? { aspectRatio: `${page.width} / ${page.height}` } : undefined}>
      <img ref={reveal.ref} alt="" width={page.width} height={page.height} src={page.src} srcSet={page.srcSet}
        sizes={enlarged ? '1200px' : standalone ? '(max-width: 600px) 90vw, 900px' : '(max-width: 719px) 85vw, 48vw'}
        decoding="async" loading={active ? 'eager' : 'lazy'} fetchPriority={active ? 'high' : 'low'} draggable={false}
        data-reveal={reveal.fromCache ? 'cached' : reveal.phase} />
      {reveal.phase === 'error' && <span className="comics-sample-error">Artwork could not load. Please refresh to try again.</span>}
    </div>
  );
}

/** Complete public sample editions; page turns never capture vertical reading gestures. */
export function ComicSampleReader({ look = 'ligne-claire', standalone = false, story = 'paper-boat' }: {
  look?: SampleLook; standalone?: boolean; story?: SampleStory;
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const [enlarged, setEnlarged] = useState(false);
  const captionId = useId(), instructionsId = useId();
  const gesture = useRef<{ x: number; y: number; pointer: number } | null>(null);
  const sample = findSample(story)!;
  const safeIndex = Math.min(pageIndex, sample.pages.length - 1);
  const current = sampleArtwork(sample, safeIndex, look);
  const turn = (delta: number) => setPageIndex(page => Math.max(0, Math.min(sample.pages.length - 1, page + delta)));
  return (
    <figure aria-labelledby={captionId} data-testid="comics-proof" data-story={story} data-standalone={standalone || undefined} data-single={sample.pages.length === 1 || undefined} className="comics-sample">
      <div className={cn('comics-sample-viewport', FOCUS_RING)} tabIndex={0} role="group" aria-label={`${sample.title} pages`} aria-describedby={instructionsId} data-enlarged={enlarged || undefined}
        onKeyDown={(event) => {
          if (enlarged) return;
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); turn(event.key === 'ArrowRight' ? 1 : -1); }
          else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); setPageIndex(event.key === 'Home' ? 0 : sample.pages.length - 1); }
        }}
        onPointerDown={(event) => {
          if (enlarged || !event.isPrimary || event.button !== 0) return;
          gesture.current = { x: event.clientX, y: event.clientY, pointer: event.pointerId };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerUp={(event) => {
          const start = gesture.current; gesture.current = null;
          if (!start || event.pointerId !== start.pointer) return;
          const dx = event.clientX - start.x, dy = event.clientY - start.y;
          if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5) turn(dx < 0 ? 1 : -1);
        }} onPointerCancel={() => { gesture.current = null; }}>
        {enlarged ? <div aria-hidden className="comics-sample-enlarged"><SampleArtwork page={current} active standalone enlarged /></div> : (
          <div aria-hidden className="comics-sample-track" data-page={safeIndex} style={{ transform: `translateX(-${safeIndex * 88}%)` }}>
            {sample.pages.map((_, index) => <div key={`${story}-${look}-${index}`} className="comics-sample-page" data-active={index === safeIndex}>
              <SampleArtwork page={sampleArtwork(sample, index, look)} active={index === safeIndex} standalone={standalone} />
            </div>)}
          </div>
        )}
      </div>
      <figcaption className="comics-sample-caption">
        <div className="comics-sample-name"><h2 id={captionId}>{sample.title}</h2><p>{sample.id === 'paper-boat' ? getStylePreset(look)?.name ?? sample.style : sample.style}</p></div>
        <span role="status" aria-atomic="true" className="comics-sample-count"><span aria-hidden>{safeIndex + 1} / {sample.pages.length}</span><span className="sr-only">Page {safeIndex + 1} of {sample.pages.length}. {story === 'paper-boat' ? `${getStylePreset(look)?.name ?? look}. ` : ''}{current.description}</span></span>
        <div className="comics-sample-controls">
          {standalone && <IconButton label={enlarged ? 'Fit comic page' : 'Enlarge comic page'} variant="outline" aria-pressed={enlarged} onClick={() => setEnlarged(value => !value)}>{enlarged ? <Minimize2 /> : <Maximize2 />}</IconButton>}
          {sample.pages.length > 1 && <><IconButton label="Previous sample page" variant="outline" disabled={safeIndex === 0} onClick={() => turn(-1)}><ChevronLeft /></IconButton><IconButton label="Next sample page" variant="outline" disabled={safeIndex === sample.pages.length - 1} onClick={() => turn(1)}><ChevronRight /></IconButton></>}
        </div>
      </figcaption>
      <p id={instructionsId} className="sr-only">{sample.pages.length > 1 ? 'Use the left and right arrow keys, swipe horizontally, or use the previous and next page buttons. ' : ''}{enlarged ? 'Scroll within the enlarged artwork to read it, then choose Fit comic page. ' : ''}{current.description}</p>
      {standalone && <details className="comics-sample-transcript"><summary>Read the scene descriptions</summary>
        {current.transcript.length ? <ol>{current.transcript.map((text, index) => <li key={text}><span>Panel {index + 1}</span>{text}</li>)}</ol> : <p>{current.description}</p>}
      </details>}
    </figure>
  );
}
