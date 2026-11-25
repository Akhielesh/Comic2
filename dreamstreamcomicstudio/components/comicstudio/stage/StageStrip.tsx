// The stage strip under the studio header (SH-A): the comic's five stages (Story, Style, Plan, Draw, Publish), and one
// line that says where it stands and the next step. Ink only: the current stage is the heavier ink, a done stage gets a
// check, the rest are muted; no hue, no spark, no price. Every stage and the next step only navigate (a board tab, the
// conversation or the composer), so nothing here can start a paid step. The words come from shared/comic/stage.ts, the
// same ones the lists read from the saved summary.
//
// Layout: one row from 768 px; below it the steps fill one row and the status line sits under them. Below 360 px a done
// stage shows only its check (its name stays in the button's name). On a book-posture foldable the strip stays on the
// first screen, never across the hinge. Coarse pointers get 44 px targets. On phones the board's tabs live in a drawer,
// so these five steps are also the quickest way between Story, Style, Pages and Read; the strip hides while the
// on-screen keyboard is up.

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import { comicStage, type StagePlace } from '../../../shared/comic/stage';
import { cn } from '../../../lib/utils';
import { CLIP_TEXT, FOCUS_RING, MUTED } from '../../chat/studioDesign';
import { useFormFactor } from '../mobile/useFormFactor';

/** From this width the steps and the status share one row. */
export const STAGE_STRIP_ONE_ROW_MIN = 768;
/** Below this width a done stage shows only its check. */
export const STAGE_STRIP_FULL_LABELS_MIN = 360;

const PLACE_HINT: Readonly<Record<StagePlace, string>> = {
  story: 'Opens the Story tab',
  style: 'Opens the Style tab',
  pages: 'Opens the Pages tab',
  read: 'Opens the Read tab',
  conversation: 'Opens the conversation',
  composer: 'Opens the message box'
};

export interface StageStripProps {
  doc: ComicDoc;
  /** Open where a stage, or the next step, is worked. */
  onGo: (place: StagePlace) => void;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export function StageStrip({ doc, onGo }: StageStripProps) {
  const ff = useFormFactor();
  const view = useMemo(() => comicStage(doc), [doc]);
  const hintId = useId();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const hinge = ff.layout === 'dual-screen' && ff.segments.axis === 'horizontal' ? ff.segments.hinge : undefined;
  const oneRow = !hinge && ff.width >= STAGE_STRIP_ONE_ROW_MIN;
  const checkOnly = ff.width < STAGE_STRIP_FULL_LABELS_MIN;

  // A polite word when the stage itself changes (never on each page drawn: the run's own card speaks for those).
  const stageKey = `${view.stage}:${view.complete}`;
  const lastStage = useRef(stageKey);
  const [said, setSaid] = useState('');
  useEffect(() => {
    if (lastStage.current === stageKey) return;
    lastStage.current = stageKey;
    setSaid(`${view.word}. Next: ${lowerFirst(view.next.label)}.`);
  }, [stageKey, view.word, view.next.label]);

  const move = (event: React.KeyboardEvent) => {
    const at = buttons.current.findIndex((b) => b === event.target);
    if (at < 0) return;
    const last = buttons.current.length - 1;
    const to =
      event.key === 'ArrowRight' ? Math.min(last, at + 1)
      : event.key === 'ArrowLeft' ? Math.max(0, at - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : -1;
    if (to < 0) return;
    event.preventDefault();
    buttons.current[to]?.focus();
  };

  const target = 'h-8 coarse:h-11';
  const steps = (
    <ol className={cn('m-0 flex min-w-0 list-none items-center p-0', oneRow ? 'shrink-0 gap-1' : 'w-full justify-between gap-0.5')} onKeyDown={move}>
      {view.steps.map((step, i) => (
        <li key={step.stage} className={cn('flex min-w-0 items-center', !oneRow && i > 0 && 'flex-1')}>
          {i > 0 && <span aria-hidden className={cn('h-px shrink bg-[var(--ds-hairline)]', oneRow ? 'w-3' : 'mr-0.5 min-w-1 flex-1')} />}
          <button
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            onClick={() => onGo(step.place)}
            aria-current={step.current ? 'step' : undefined}
            title={checkOnly && step.done ? step.label : undefined}
            data-stage={step.stage}
            data-stage-state={step.current ? 'current' : step.done ? 'done' : 'upcoming'}
            className={cn(
              'inline-flex min-w-11 shrink-0 items-center justify-center gap-1 rounded-[var(--ds-radius-control)] px-1.5 text-[12px] hover:bg-[var(--ds-hover)]',
              target,
              FOCUS_RING,
              step.current ? 'font-semibold text-[var(--ds-ink)]' : step.done ? 'text-[var(--ds-ink)]' : MUTED
            )}
          >
            {step.done && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />}
            <span className={checkOnly && step.done ? 'sr-only' : undefined}>{step.label}</span>
            {step.done && <span className="sr-only">, done</span>}
          </button>
        </li>
      ))}
    </ol>
  );

  return (
    <nav
      aria-label="Comic stages"
      data-stage-strip={oneRow ? 'row' : 'stacked'}
      // Hidden while the on-screen keyboard is up, like the tab bar, so typing keeps the conversation's room.
      className={cn('shrink-0 border-b border-[var(--ds-hairline-soft)] [html.kb-open_&]:hidden', oneRow ? 'px-3' : 'px-4')}
      style={hinge ? { maxWidth: Math.max(0, hinge.start - 6) } : undefined}
    >
      <div className={cn('flex min-w-0', oneRow ? 'items-center gap-3' : 'flex-col')}>
        {steps}
        {oneRow && <span aria-hidden className="h-4 w-px shrink-0 bg-[var(--ds-hairline)]" />}
        <p className={cn('m-0 flex min-w-0 items-center gap-2 text-[12px]', oneRow && 'flex-1')} data-stage-status>
          <span className={cn(CLIP_TEXT, 'tabular-nums')} title={view.summary}>
            <span className="font-medium text-[var(--ds-ink)]">{view.word}</span>
            <span className={MUTED}> · {view.progress}</span>
          </span>
          {oneRow && (
            <span aria-hidden className={MUTED}>
              ·
            </span>
          )}
          <button
            type="button"
            onClick={() => onGo(view.next.place)}
            aria-describedby={hintId}
            data-stage-next={view.next.key}
            className={cn(
              'inline-flex max-w-full shrink-0 items-center gap-1 rounded-[var(--ds-radius-control)] px-1.5 font-medium text-[var(--ds-ink)] underline-offset-2 hover:underline',
              !oneRow && 'ml-auto',
              target,
              FOCUS_RING
            )}
          >
            <span className={CLIP_TEXT}>Next: {lowerFirst(view.next.label)}</span>
            <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
          </button>
          <span id={hintId} hidden>
            {PLACE_HINT[view.next.place]}
          </span>
        </p>
      </div>
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
    </nav>
  );
}
