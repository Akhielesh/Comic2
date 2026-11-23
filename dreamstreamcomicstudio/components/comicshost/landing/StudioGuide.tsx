import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, MessagesSquare } from 'lucide-react';
import { AUTH_WORKSPACE_PATHS } from '../../../shared/authWorkspace';
import { sampleThumbnailUrl, SAMPLE_COVER_URL } from '../../comicstudio/library/sampleArt';
import type { ComicTheme } from '../../comicstudio/useComicTheme';
import { Button } from '../../ds/Button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ds/Dialog';
import { FOCUS_RING } from '../../chat/studioDesign';
import { cn } from '../../../lib/utils';
import { LandingShot } from './LandingShot';
import { landingMedia } from './landingMedia';
import './studioGuide.css';

const STOPS = [
  { title: 'Read a comic', body: 'Open the public Library and pick a cover. Turn the pages to see how the artwork and lettering work together. Anyone can read.' },
  { title: 'Make your first comic', body: 'Give the Comic Director a sentence about your story. Review the cast and page plan, adjust what matters to you, then choose when to draw.' },
  { title: 'Draw a single image', body: 'Describe the picture you want. Add a reference if you have a subject or a style in mind. Choose Generate image when your brief is ready.' },
  { title: 'Talk through an idea', body: 'Open a chat for a question or an idea that’s still taking shape. Type your message, or choose the microphone to dictate it.' },
] as const;

type Progress = number | 'finished' | 'skipped' | 'new';

function readProgress(key: string): Progress {
  try {
    const value = window.localStorage.getItem(key);
    if (value === 'finished' || value === 'skipped') return value;
    const index = Number(value);
    if (String(index) === value && Number.isInteger(index) && index >= 0 && index < STOPS.length) return index;
  } catch { /* Storage can be disabled. This visit still keeps its place. */ }
  return 'new';
}

export function useStudioGuide(account: string) {
  const key = `comic.studio-guide.v1.${account}`;
  const [progress, setProgress] = useState<Progress>(() => readProgress(key));
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('tour') !== '1') return;
    // Clean the underlying address before the Dialog pushes its Android Back entry.
    url.searchParams.delete('tour');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    setOpen(true);
  }, []);
  const step = typeof progress === 'number' ? progress : 0;
  const trigger = useRef<HTMLButtonElement | null>(null);
  const hero = useRef<HTMLButtonElement | null>(null);
  const label = typeof progress === 'number' ? 'Continue studio tour' : progress === 'new' ? 'Take the studio tour' : 'Replay studio tour';

  function save(next: Progress) {
    setProgress(next);
    try { window.localStorage.setItem(key, String(next)); } catch { /* Keep the in-memory experience. */ }
  }

  function start(event: React.MouseEvent<HTMLButtonElement>) {
    trigger.current = event.currentTarget;
    save(step);
    setOpen(true);
  }

  function close(next: Progress = step) {
    save(next);
    setOpen(false);
  }

  return { open, step, label, start, close, save, hero, returnFocus: () => (trigger.current ?? hero.current)?.focus({ preventScroll: true }) };
}

type Guide = ReturnType<typeof useStudioGuide>;

function GuideIllustration({ step }: { step: number }) {
  if (step === 0) return <figure className="studio-guide-art studio-guide-cover"><img src={SAMPLE_COVER_URL} alt="The illustrated cover of The Paper Boat" /></figure>;
  if (step === 1) return <figure className="studio-guide-art studio-guide-plan"><LandingShot media={landingMedia('plan')} /></figure>;
  if (step === 2) return <figure className="studio-guide-art studio-guide-image"><img src={sampleThumbnailUrl('watercolor-storybook')} alt="A watercolor scene from The Paper Boat" /><figcaption>Watercolor study from The Paper Boat</figcaption></figure>;
  return <figure className="studio-guide-art studio-guide-prompt"><figcaption><MessagesSquare aria-hidden /> A conversation starter</figcaption><blockquote>“What could happen to a paper boat after it slips out of sight?”</blockquote></figure>;
}

interface StudioGuideDialogProps {
  guide: Guide;
  theme: ComicTheme;
  signedIn: boolean;
  onBrowse: () => void;
  onStartComic: () => void;
}

export function StudioGuideDialog({ guide, theme, signedIn, onBrowse, onStartComic }: StudioGuideDialogProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const { step, open } = guide;
  const stop = STOPS[step];
  const last = step === STOPS.length - 1;
  const linkClass = cn('studio-guide-destination', FOCUS_RING);
  function launch(action: () => void) {
    guide.close();
    action();
  }
  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open, step]);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) guide.close(); }}>
      <DialogContent className="studio-guide-panel" data-comic-theme={theme} closeLabel="Close studio guide"
        onOpenAutoFocus={(event) => { event.preventDefault(); heading.current?.focus(); }}
        onCloseAutoFocus={(event) => { event.preventDefault(); guide.returnFocus(); }}>
        <div className="studio-guide-heading">
          <p>Studio guide <span aria-hidden> / </span> Step {step + 1} of {STOPS.length}</p>
          <div aria-hidden className="studio-guide-meter">{STOPS.map((stop, index) => <span key={stop.title} data-filled={index <= step} />)}</div>
        </div>
        <div className="studio-guide-stop">
          <GuideIllustration step={step} />
          <div className="studio-guide-copy">
            <DialogTitle ref={heading} tabIndex={-1}>{stop.title}<span className="sr-only">, step {step + 1} of {STOPS.length}</span></DialogTitle>
            <DialogDescription>{stop.body}</DialogDescription>
            <div className="studio-guide-destinations">
              {step === 0 && <button className={linkClass} onClick={() => launch(onBrowse)}>Browse the Library <ArrowRight aria-hidden /></button>}
              {step === 1 && <button className={linkClass} onClick={() => launch(onStartComic)}>{signedIn ? 'Start a comic' : 'Create an account'} <ArrowRight aria-hidden /></button>}
              {step === 2 && <a className={linkClass} href={AUTH_WORKSPACE_PATHS.images} onClick={() => guide.save(step)}>Open image workspace <ArrowRight aria-hidden /></a>}
              {step === 3 && <><a className={linkClass} href={AUTH_WORKSPACE_PATHS.chat} onClick={() => guide.save(step)}>Open chat <ArrowRight aria-hidden /></a><a className={linkClass} href={AUTH_WORKSPACE_PATHS.voice} onClick={() => guide.save(step)}>Talk by voice <ArrowRight aria-hidden /></a></>}
            </div>
          </div>
        </div>
        <div className="studio-guide-controls">
          <button className={cn('studio-guide-skip', FOCUS_RING)} onClick={() => guide.close('skipped')}>Skip tour</button>
          {step > 0 && <Button variant="outline" onClick={() => guide.save(step - 1)}><ArrowLeft aria-hidden /> Back</Button>}
          <Button onClick={() => last ? guide.close('finished') : guide.save(step + 1)}>{last ? 'Finish' : 'Next'}{!last && <ArrowRight aria-hidden />}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
