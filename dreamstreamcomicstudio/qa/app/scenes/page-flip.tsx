// QA scene `page-flip` (fx-reader; the scene contract is in qa/app/index.tsx): the page flip every reader turns with
// by default, so the layout smoke and a person can see it at a phone, a tablet and a desktop size. One live stage
// (components/comicstudio/reader/PaperTurnSurface, the inline readers' own) turns the landing's sample pages with
// Prev / Next, the arrow keys, a swipe or the page edges, in any of the four styles and either reading direction; under
// it, the swing held part-way (the real index.css classes, paused) forward, back, right to left and as a spread's pair.
// Same-origin sample art only; nothing reaches the network or spends.

import React, { useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { PageTurnStyle } from '../../../shared/comic/doc';
import { PaperTurnSurface, type PaperTurnDirection, type PaperTurnHandle } from '../../../components/comicstudio/reader/PaperTurnSurface';
import { FLIP_NEXT, FLIP_PREV } from '../../../components/comicstudio/reader/pageFlip';
import { PageHeader } from '../../../components/ds';
import { Button } from '../../../components/ds/Button';
import { Segmented } from '../../../components/ds/Segmented';
import { cn } from '../../../lib/utils';
import { FOCUS_RING, HEADING, MUTED, OVERLINE, RADIUS_PANEL, SHADOW_SOFT } from '../../../components/chat/studioDesign';
import type { QaAppScene } from '../index';

const ART = '/assets/comic-sample';
const PAGES = [
  { src: `${ART}/last-tram-page-1-768.webp`, alt: 'A traveler watches the moonlit harbor, then boards the last tram.' },
  { src: `${ART}/last-tram-page-2-768.webp`, alt: 'The traveler sets a paper boat afloat on the harbor.' },
  { src: `${ART}/hello-europa-page-1-768.webp`, alt: 'On Europa, an astronaut frees a rover from the ice.' },
  { src: `${ART}/a-small-giant-page-1-768.webp`, alt: 'A mouse, a hedgehog and an owl share a warm drink under a scarf.' }
];

const STYLES: { value: PageTurnStyle; label: string }[] = [
  { value: 'flip', label: 'Flip' },
  { value: 'paper', label: 'Paper' },
  { value: 'slide', label: 'Slide' },
  { value: 'fade', label: 'Fade' }
];

/** A page on paper, letterboxed in the stage. */
function Sheet({ index }: { index: number }) {
  const page = PAGES[index];
  if (!page) return null;
  return (
    <div className="flex h-full w-full items-center justify-center bg-[var(--ds-well)] p-2">
      <img src={page.src} alt={page.alt} draggable={false} className={cn('block max-h-full max-w-full overflow-hidden bg-[var(--ds-surface)] object-contain', SHADOW_SOFT)} />
    </div>
  );
}

function LiveStage() {
  const [index, setIndex] = useState(0);
  const [style, setStyle] = useState<PageTurnStyle>('flip');
  const [dir, setDir] = useState<'ltr' | 'rtl'>('ltr');
  const turn = useRef<PaperTurnHandle>(null);
  const rtl = dir === 'rtl';
  const canTurn = (d: PaperTurnDirection) => index + d >= 0 && index + d < PAGES.length;
  const onKey = (e: React.KeyboardEvent) => {
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === forward) turn.current?.turn(1);
    else if (e.key === back) turn.current?.turn(-1);
    else if (e.key === 'Home' || e.key === 'End') {
      const target = e.key === 'Home' ? 0 : PAGES.length - 1;
      if (target !== index) turn.current?.jump(target > index ? 1 : -1, () => setIndex(target), <Sheet index={target} />);
    } else return;
    e.preventDefault();
  };
  return (
    <section aria-labelledby="qa-flip-live" className="flex min-w-0 flex-col gap-3">
      <h2 id="qa-flip-live" className={cn('m-0 text-[length:var(--ds-text-base)]', HEADING)}>Turn the page</h2>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Segmented<PageTurnStyle> label="Page turn style" size="sm" value={style} onChange={setStyle} options={STYLES} />
        <Segmented<'ltr' | 'rtl'> label="Reading direction" size="sm" value={dir} onChange={setDir} options={[{ value: 'ltr', label: 'Left to right' }, { value: 'rtl', label: 'Right to left' }]} />
      </div>
      <div
        role="group"
        aria-label="Sample pages"
        aria-describedby="qa-flip-how"
        tabIndex={0}
        onKeyDown={onKey}
        className={cn('relative mx-auto aspect-[3/4] w-full max-w-[min(100%,520px)] overflow-hidden border border-[var(--ds-hairline)] bg-[var(--ds-well)]', RADIUS_PANEL, FOCUS_RING)}
      >
        <PaperTurnSurface
          ref={turn}
          className="h-full w-full"
          turnStyle={style}
          rtl={rtl}
          pageKey={`${style}/${dir}/${index}`}
          canTurn={canTurn}
          onTurn={(d) => setIndex(index + d)}
          renderAdjacent={(d) => <Sheet index={index + d} />}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            if (!r.width) return;
            const x = (e.clientX - r.left) / r.width;
            if (x > 0.3 && x < 0.7) return;
            const d: PaperTurnDirection = (x > 0.5) !== rtl ? 1 : -1;
            if (canTurn(d)) turn.current?.turn(d);
          }}
        >
          <Sheet index={index} />
        </PaperTurnSurface>
      </div>
      <div className="flex min-w-0 items-center justify-center gap-3">
        <Button variant="outline" onClick={() => turn.current?.turn(-1)} disabled={!canTurn(-1)}>
          {rtl ? <ChevronRight aria-hidden /> : <ChevronLeft aria-hidden />} Prev
        </Button>
        <span role="status" className={cn('min-w-[6rem] text-center text-[length:var(--ds-text-sm)] tabular-nums', MUTED)}>
          Page {index + 1} of {PAGES.length}
        </span>
        <Button variant="outline" onClick={() => turn.current?.turn(1)} disabled={!canTurn(1)}>
          Next {rtl ? <ChevronLeft aria-hidden /> : <ChevronRight aria-hidden />}
        </Button>
      </div>
      <p id="qa-flip-how" className={cn('m-0 text-center text-[length:var(--ds-text-sm)]', MUTED)}>
        Prev and Next, the arrow keys, Home and End, a swipe or a tap on a page edge. Reduce motion changes the page at once.
      </p>
    </section>
  );
}

/** The swing held part-way: the real class, paused 0.18 s in (index.css owns the keyframes). */
const HELD: React.CSSProperties = { animationDelay: '-0.18s', animationPlayState: 'paused' };

function Held({ title, cls, spread = false }: { title: string; cls: string; spread?: boolean }) {
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-2">
      <div className={cn('flex aspect-[4/3] min-w-0 items-center justify-center overflow-hidden border border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] p-3', RADIUS_PANEL)}>
        <div className={cn(cls, 'flex h-full max-w-full gap-px')} style={spread ? { ...HELD, transformOrigin: '50% 50%' } : HELD}>
          <img src={PAGES[1].src} alt="" className={cn('block h-full w-auto bg-[var(--ds-surface)] object-contain', SHADOW_SOFT)} />
          {spread && <img src={PAGES[2].src} alt="" className={cn('block h-full w-auto bg-[var(--ds-surface)] object-contain', SHADOW_SOFT)} />}
        </div>
      </div>
      <figcaption className={cn('text-[length:var(--ds-text-sm)]', MUTED)}>{title}</figcaption>
    </figure>
  );
}

function PageFlipScene() {
  return (
    <main data-qa-scene="page-flip" aria-label="Page flip" className="min-h-[100dvh] min-w-0 bg-[var(--ds-canvas)] px-4 py-6 text-[var(--ds-ink)] sm:px-6">
      <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-8">
        <PageHeader eyebrow="Reader" title="The page flip" description="The new page swings in from the spine. Every reader turns this way unless the creator or the reader picked another style." />
        <LiveStage />
        <section aria-labelledby="qa-flip-held" className="flex min-w-0 flex-col gap-3">
          <h2 id="qa-flip-held" className={cn('m-0 text-[length:var(--ds-text-base)]', HEADING)}>Part-way through the swing</h2>
          <p className={cn('m-0', OVERLINE)}>Held 0.18 s into 0.45 s</p>
          <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Held title="Next, left to right: from the left spine" cls={FLIP_NEXT} />
            <Held title="Back, left to right: from the right edge" cls={FLIP_PREV} />
            <Held title="Next, right to left: mirrored" cls={FLIP_PREV} />
            <Held title="A spread: the pair around its spine" cls={FLIP_NEXT} spread />
          </div>
        </section>
      </div>
    </main>
  );
}

const scene: QaAppScene = { id: 'page-flip', title: 'The page flip (live stage, four styles, RTL, the swing held part-way)', Scene: PageFlipScene };
export default scene;
