// The stage strip under the studio header (SH-A): the comic's five stages (Story, Style, Plan, Draw, Publish), and one
// line that says where it stands and the next step. Ink only: the current stage is the heavier ink, a done stage gets a
// check, the rest are muted; no hue, no spark, no price. Every stage and the next step only navigate (a board tab, the
// conversation or the composer), so nothing here can start a paid step. The words come from shared/comic/stage.ts, the
// same ones the lists read from the saved summary.
//
// Two layouts, both one row high so the conversation and the board keep their room (on a phone the content keeps at
// least 45 % of the screen: the layout smoke's phone-content rule):
//  - from 768 px: the five named stages, then the status and the "Next: …" button, in one row;
//  - below (phones, small tablets, and the first screen of a book-posture foldable): one 44 px row holding a stage
//    button that shows the five stages as marks (a check when done, a heavier ink dot for the current one, a ring for
//    the rest) and the status as one button whose second line is the next step. The stage button opens the five named
//    stages in a row below; choosing one, or Escape, closes it again. Below 360 px a done stage there shows only its
//    check, keeping its name for screen readers and as a tooltip.
// Coarse pointers get 44 px targets everywhere. The strip hides while the on-screen keyboard is up, like the tab bar.

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import { comicStage, type StagePlace } from '../../../shared/comic/stage';
import { cn } from '../../../lib/utils';
import { CLIP_TEXT, FOCUS_RING, MUTED } from '../../chat/studioDesign';
import { useFormFactor } from '../mobile/useFormFactor';

/** From this width the named stages and the status share one row. */
export const STAGE_STRIP_ONE_ROW_MIN = 768;
/** Below this width a done stage in the opened list shows only its check. */
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
  const listId = useId();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const toggle = useRef<HTMLButtonElement | null>(null);
  const hinge = ff.layout === 'dual-screen' && ff.segments.axis === 'horizontal' ? ff.segments.hinge : undefined;
  const oneRow = !hinge && ff.width >= STAGE_STRIP_ONE_ROW_MIN;
  const checkOnly = ff.width < STAGE_STRIP_FULL_LABELS_MIN;
  const [open, setOpen] = useState(false);
  const showSteps = oneRow || open;

  // A polite word when the stage itself changes (never on each page drawn: the run's own card speaks for those).
  const stageKey = `${view.stage}:${view.complete}`;
  const lastStage = useRef(stageKey);
  const [said, setSaid] = useState('');
  useEffect(() => {
    if (lastStage.current === stageKey) return;
    lastStage.current = stageKey;
    setSaid(`${view.word}. Next: ${lowerFirst(view.next.label)}.`);
  }, [stageKey, view.word, view.next.label]);

  const close = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  const go = (place: StagePlace) => {
    if (!oneRow) close();
    onGo(place);
  };

  const move = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && !oneRow) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    const at = buttons.current.findIndex((b) => b === event.target);
    if (at < 0) return;
    const last = view.steps.length - 1;
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
  const steps = showSteps && (
    <ol
      id={oneRow ? undefined : listId}
      className={cn('m-0 flex min-w-0 list-none items-center p-0', oneRow ? 'shrink-0 gap-1' : 'w-full justify-between gap-0.5 pb-1')}
      onKeyDown={move}
    >
      {view.steps.map((step, i) => (
        <li key={step.stage} className={cn('flex min-w-0 items-center', !oneRow && i > 0 && 'flex-1')}>
          {i > 0 && <span aria-hidden className={cn('h-px shrink bg-[var(--ds-hairline)]', oneRow ? 'w-3' : 'mr-0.5 min-w-1 flex-1')} />}
          <button
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            onClick={() => go(step.place)}
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

  // In one row the status may shorten with an ellipsis (it is not a control's label; its title has every word). In the
  // compact row it is the button's label, so it wraps rather than cut a word.
  const summary = (
    <span className={cn('max-w-full tabular-nums', oneRow && CLIP_TEXT)} title={oneRow ? view.summary : undefined}>
      <span className="font-medium text-[var(--ds-ink)]">{view.word}</span>
      <span className={MUTED}> · {view.progress}</span>
    </span>
  );
  const nextWords = (
    <>
      <span className={oneRow ? CLIP_TEXT : undefined}>Next: {lowerFirst(view.next.label)}</span>
      <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
    </>
  );
  const hint = (
    <span id={hintId} hidden>
      {PLACE_HINT[view.next.place]}
    </span>
  );
  const doneCount = view.steps.filter((s) => s.done).length;
  const current = view.steps.find((s) => s.current) ?? view.steps[view.steps.length - 1];

  return (
    <nav
      aria-label="Comic stages"
      data-stage-strip={oneRow ? 'row' : 'compact'}
      // Hidden while the on-screen keyboard is up, like the tab bar, so typing keeps the conversation's room.
      className={cn('shrink-0 border-b border-[var(--ds-hairline-soft)] [html.kb-open_&]:hidden', oneRow ? 'px-3' : 'px-4')}
      style={hinge ? { maxWidth: Math.max(0, hinge.start - 6) } : undefined}
    >
      {oneRow ? (
        <div className="flex min-w-0 items-center gap-3">
          {steps}
          <span aria-hidden className="h-4 w-px shrink-0 bg-[var(--ds-hairline)]" />
          <p className="m-0 flex min-w-0 flex-1 items-center gap-2 text-[12px]" data-stage-status>
            {summary}
            <span aria-hidden className={MUTED}>
              ·
            </span>
            <button
              type="button"
              onClick={() => onGo(view.next.place)}
              aria-describedby={hintId}
              data-stage-next={view.next.key}
              className={cn(
                'inline-flex max-w-full shrink-0 items-center gap-1 rounded-[var(--ds-radius-control)] px-1.5 font-medium text-[var(--ds-ink)] underline-offset-2 hover:underline',
                target,
                FOCUS_RING
              )}
            >
              {nextWords}
            </button>
            {hint}
          </p>
        </div>
      ) : (
        <>
          <div className="flex min-h-11 min-w-0 items-center gap-2" data-stage-status>
            <button
              ref={toggle}
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-controls={open ? listId : undefined}
              aria-label={`Stages: ${current.label}, ${doneCount} of ${view.steps.length} done`}
              title="Stages"
              data-stage-toggle
              className={cn('inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-0.5 rounded-[var(--ds-radius-control)] px-1.5 hover:bg-[var(--ds-hover)]', FOCUS_RING)}
            >
              {view.steps.map((step) => (
                <span
                  key={step.stage}
                  aria-hidden
                  data-stage-mark={step.done ? 'done' : step.current ? 'current' : 'upcoming'}
                  className={cn('flex h-2.5 w-2.5 items-center justify-center', step.done || step.current ? 'text-[var(--ds-ink)]' : MUTED)}
                >
                  {step.done ? <Check className="h-2.5 w-2.5" strokeWidth={step.current ? 3.5 : 2.5} /> : <span className={cn('h-2 w-2 rounded-full', step.current ? 'bg-[var(--ds-ink)]' : 'border border-current')} />}
                </span>
              ))}
            </button>
            <button
              type="button"
              onClick={() => onGo(view.next.place)}
              // The two lines it shows, as one sentence (the visible words, in order).
              aria-label={view.line}
              aria-describedby={hintId}
              data-stage-next={view.next.key}
              className={cn('flex min-h-11 min-w-0 flex-1 flex-col items-start justify-center rounded-[var(--ds-radius-control)] px-1.5 text-left text-[12px] leading-4 hover:bg-[var(--ds-hover)]', FOCUS_RING)}
            >
              {summary}
              <span className="inline-flex max-w-full items-center gap-1 font-medium text-[var(--ds-ink)]">{nextWords}</span>
            </button>
            {hint}
          </div>
          {steps}
        </>
      )}
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
    </nav>
  );
}
