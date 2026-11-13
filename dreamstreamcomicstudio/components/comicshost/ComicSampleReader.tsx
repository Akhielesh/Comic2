import React, { useId, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { getStylePreset } from '../../shared/comic/stylePresets';
import { RADIUS_FEATURE } from '../chat/studioDesign';
import { Button } from '../ds/Button';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '../ds/Dialog';
import { IconButton } from '../ds/IconButton';
import { useImageReveal } from '../ds/useImageReveal';
import { SAMPLE_COVER_URL, samplePageUrl, type SampleLook } from '../comicstudio/library/sampleArt';

const PAGES = [
  'Mira and Biscuit spot a paper boat drifting down the canal at dusk.',
  'They race along the canal to catch the paper boat before the rain.'
];

function SampleArtwork({ look, page, active }: { look: SampleLook; page: number; active: boolean }) {
  const src = samplePageUrl(look, page);
  const reveal = useImageReveal(src);

  return (
    <div className="comics-sample-art" data-comic-art="">
      <img
        ref={reveal.ref}
        alt=""
        width={1200}
        height={1000}
        src={src}
        decoding="async"
        fetchPriority={active ? 'high' : 'low'}
        data-reveal={reveal.fromCache ? 'cached' : reveal.phase}
      />
    </div>
  );
}

export function ComicSampleReader({ look }: { look: SampleLook }) {
  const [pageIndex, setPageIndex] = useState(0);
  const captionId = useId();
  const page = PAGES[pageIndex];

  return (
    <figure
      id="comic-sample"
      aria-labelledby={captionId}
      data-testid="comics-proof"
      className={cn('ds-rise-in min-w-0 scroll-mt-[var(--header-h)] overflow-hidden border border-[var(--ds-hairline)] bg-[var(--ds-well)]', RADIUS_FEATURE)}
    >
      <div aria-hidden className="comics-sample-viewport">
        <div className="comics-sample-track" data-page={pageIndex}>
          {PAGES.map((description, index) => (
            <div key={description} className="comics-sample-page">
              <SampleArtwork key={look} look={look} page={index + 1} active={index === pageIndex} />
            </div>
          ))}
        </div>
      </div>
      <figcaption className="comics-sample-caption">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2">
          <div className="min-w-0">
            <h2 id={captionId} tabIndex={-1} className="text-[length:var(--ds-text-base)] font-semibold focus:outline-none">The Paper Boat</h2>
            <p className="text-[length:var(--ds-text-xs)] text-[var(--ds-muted)]">Sample comic</p>
          </div>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="ghost" size="sm">View cover</Button>
            </DialogTrigger>
            <DialogContent size="sm" aria-describedby={undefined} closeLabel="Close cover preview">
              <DialogTitle>The Paper Boat</DialogTitle>
              <img
                className="comics-sample-cover mx-auto"
                src={SAMPLE_COVER_URL}
                width={768}
                height={1152}
                decoding="async"
                alt="Mira and Biscuit look over a stone bridge at a paper boat in the canal."
              />
            </DialogContent>
          </Dialog>
        </div>
        <span role="status" className="text-[length:var(--ds-text-sm)] tabular-nums text-[var(--ds-muted)]">
          <span aria-hidden>{pageIndex + 1} / {PAGES.length}</span>
          <span className="sr-only">Page {pageIndex + 1} of {PAGES.length}. {getStylePreset(look)?.name ?? look}. {page}</span>
        </span>
        <div className="flex gap-1.5">
          <IconButton label="Previous sample page" variant="outline" disabled={pageIndex === 0} onClick={() => setPageIndex(0)}>
            <ChevronLeft />
          </IconButton>
          <IconButton label="Next sample page" variant="outline" disabled={pageIndex === PAGES.length - 1} onClick={() => setPageIndex(PAGES.length - 1)}>
            <ChevronRight />
          </IconButton>
        </div>
      </figcaption>
    </figure>
  );
}
