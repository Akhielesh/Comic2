// The one "Continue" card at the top of My comics in Comic Studio: the comic the member was working on, its cover, where
// it stands (its saved stage, the same words as its card and the studio's stage strip) and its next step one tap away.
// No fill (the frame's New comic stays the view's one), no price, no request of its own (the cover is the URL the list
// load already signed; the stage comes from the page's one stage read). The next step only opens a place in the studio.

import React, { useId } from 'react';
import { ArrowRight, BookOpen, MessageSquare } from 'lucide-react';
import type { Project } from '../../../types';
import { cn } from '../../../lib/utils';
import { Button } from '../../ds/Button';
import { CARD } from '../../ds/Card';
import { CLIP_TEXT, HEADING, LIFT, MUTED, OVERLINE, RADIUS_CONTROL, SHADOW_SOFT } from '../../chat/studioDesign';
import { LoadingState } from '../../ds/LoadingState';
import { SmartImage } from '../../common/SmartImage';
import { coverCandidates, myComicCard, type CardStageRow, type CardStageStatus } from './homeModel';
import { CardStageLine, NextStep } from './MyComicCard';
import type { TaskDestination } from './workspaceTaskTarget';

export interface ContinueCardProps {
  project: Project;
  /** Open the comic; at a place in the studio when the next step names one. */
  onOpen(id: string, destination?: TaskDestination | null): void;
  onRead(id: string): void;
  /** The comic's row from the page's stage read; absent before stages or until the read answers. */
  stageRow?: CardStageRow;
  /** Whether the stage read has answered: until it does, the stage line is a placeholder. */
  stageStatus?: CardStageStatus;
  /** For tests and scenes; the card reads the clock when it renders otherwise. */
  now?: number;
  /** The relative time's language; the page's own language by default. */
  locale?: string;
}

const pageLocale = (): string | undefined =>
  typeof document !== 'undefined' ? document.documentElement.lang || undefined : undefined;

/** Explicit size for the cover (a portrait page, framed from the top); the box sets what is shown. */
const COVER_W = 240;
const COVER_H = 320;

export function ContinueCard({ project, onOpen, onRead, stageRow, stageStatus = 'settled', now, locale }: ContinueCardProps) {
  const id = useId();
  const model = myComicCard(project, stageRow, stageStatus, now ?? Date.now(), locale ?? pageLocale());
  const { title } = model;
  const [cover, ...fallbacks] = coverCandidates(project);
  const open = () => onOpen(project.id, null);
  const only = (action: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    action();
  };
  // The next step when it names a place in the studio; otherwise the comic opens as it was left.
  const next = model.next?.destination ? model.next : null;
  return (
    <section aria-labelledby={`${id}-label ${id}-title`} className="mb-6 min-w-0">
      {/* The whole card is the pointer target; keyboard and screen readers use the buttons inside it. */}
      <div
        data-testid="continue-card"
        onClick={open}
        className={cn(CARD, SHADOW_SOFT, LIFT, 'cursor-pointer flex-row items-center gap-4 p-3 sm:gap-5 sm:p-4')}
      >
        <div className={cn('relative aspect-[3/4] w-20 shrink-0 overflow-hidden border border-[var(--ds-hairline)] bg-[var(--ds-well)] sm:w-28', RADIUS_CONTROL)}>
          {cover ? (
            <SmartImage
              src={cover}
              fallbackSources={fallbacks}
              alt={`${title} cover`}
              width={COVER_W}
              height={COVER_H}
              fetchPriority="high"
              decoding="async"
              className="h-full w-full object-cover object-top"
              containerClassName="h-full w-full"
              loadingComponent={<LoadingState variant="inline" title="Loading cover…" className="h-full w-full justify-center bg-[var(--ds-well)]" />}
              fallbackIcon={<BookOpen className={cn('size-6', MUTED)} aria-hidden />}
            />
          ) : (
            <div className={cn('flex h-full w-full items-center justify-center', MUTED)}>
              <MessageSquare className="size-7" aria-hidden />
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p id={`${id}-label`} className={cn('m-0', OVERLINE)}>Continue</p>
          <h2 id={`${id}-title`} className={cn('m-0 text-[length:var(--ds-text-xl)] leading-7', HEADING, CLIP_TEXT)} title={title}>
            {title}
          </h2>
          <CardStageLine model={model} />
          <p className={cn('m-0 text-[length:var(--ds-text-sm)] leading-5 tabular-nums', MUTED)}>{model.status}</p>
          {/* Its own controls: a tap on one never also opens the card behind it. */}
          <div className="mt-2 flex flex-wrap items-center gap-2" onClick={(event) => event.stopPropagation()}>
            {next ? (
              <NextStep id={project.id} title={title} next={next} kind={model.kind} onOpen={(comic, destination) => onOpen(comic, destination)} size="default" className="max-w-full" />
            ) : (
              <Button variant="outline" onClick={only(open)}>
                Continue <ArrowRight aria-hidden />
              </Button>
            )}
            {model.canRead && (
              <Button variant="ghost" aria-label={`Read ${title}`} onClick={only(() => onRead(project.id))}>
                <BookOpen aria-hidden /> Read
              </Button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
