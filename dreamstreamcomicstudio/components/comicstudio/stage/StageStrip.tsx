// The stage strip under the studio header (SH-A): the comic's five stages (Story, Style, Plan, Draw, Publish), and one
// line that says where it stands and the next step. Ink only: the current stage is the heavier ink, a done stage gets a
// check, the rest are muted; no hue, no spark, no price. Every stage and the next step only navigate (a board tab, the
// approval or the draft in the conversation, the composer, or the Share sheet), so nothing here can start a paid step.
// The words come from shared/comic/stage.ts, the same ones the lists read from the saved summary.
//
// Two layouts:
//  - from 768 px: the five named stages, then the status and the "Next: …" button, then the stage map's button (SH-C2),
//    in one row under the header;
//  - below (a narrow split, the first screen of a book-posture foldable, and phones): one 44 px row holding a stage
//    button that shows the five stages as marks (a check when done, a heavier ink dot for the current one, a ring for
//    the rest) and the status as one button whose second line is the next step. The marks open the stage map (a bottom
//    sheet on phones): each stage by name, what is left in it, and a way there; choosing one, or Escape, closes it and
//    focus comes back to the marks. One control for the stages, so the row stays one next step. On a phone the shell
//    puts this row at the top of the board's scrolling panel rather than under the header, so it adds no fixed chrome
//    and scrolls away with the work.
// The marks are SVG in the text colour, so they keep their shapes in forced colours (high contrast). Coarse pointers get
// 44 px targets everywhere. The strip hides while the on-screen keyboard is up, like the tab bar.

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import { stageFacts, stageView, type StagePlace } from '../../../shared/comic/stage';
import { cn } from '../../../lib/utils';
import { CLIP_TEXT, FOCUS_RING, MUTED } from '../../chat/studioDesign';
import { useFormFactor } from '../mobile/useFormFactor';
import { StageMapButton } from './StageMap';
import { PLACE_HINT, StageMark } from './stageMarks';

/** From this width the named stages and the status share one row. */
export const STAGE_STRIP_ONE_ROW_MIN = 768;

export interface StageStripProps {
  doc: ComicDoc;
  /** The server's own "changes not published" (the owner's publication view), when the studio has it. */
  behind?: boolean;
  /** Open where a stage, or the next step, is worked. */
  onGo: (place: StagePlace) => void;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export function StageStrip({ doc, behind, onGo }: StageStripProps) {
  const ff = useFormFactor();
  const facts = useMemo(() => stageFacts(doc, { behind }), [doc, behind]);
  const view = useMemo(() => stageView(facts), [facts]);
  const hintId = useId();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const hinge = ff.layout === 'dual-screen' && ff.segments.axis === 'horizontal' ? ff.segments.hinge : undefined;
  const oneRow = !hinge && ff.width >= STAGE_STRIP_ONE_ROW_MIN;

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
  const steps = oneRow && (
    <ol className="m-0 flex min-w-0 shrink-0 list-none items-center gap-1 p-0" onKeyDown={move}>
      {view.steps.map((step, i) => (
        <li key={step.stage} className="flex min-w-0 items-center">
          {i > 0 && <span aria-hidden className="h-px w-3 shrink bg-[var(--ds-hairline)]" />}
          <button
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            onClick={() => onGo(step.place)}
            aria-current={step.current ? 'step' : undefined}
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
            <span>{step.label}</span>
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
          <StageMapButton facts={facts} onGo={onGo} />
        </div>
      ) : (
        <div className="flex min-h-11 min-w-0 items-center gap-2" data-stage-status>
          {/* The marks: where the comic stands at a glance, and the way into the stage map. */}
          <StageMapButton facts={facts} onGo={onGo} label={`Stages: ${current.label}, ${doneCount} of ${view.steps.length} done`} align="start">
            {view.steps.map((step) => (
              <span
                key={step.stage}
                aria-hidden
                data-stage-mark={step.done ? 'done' : step.current ? 'current' : 'upcoming'}
                className={cn('flex h-2.5 w-2.5 items-center justify-center', step.done || step.current ? 'text-[var(--ds-ink)]' : MUTED)}
              >
                <StageMark done={step.done} current={step.current} />
              </span>
            ))}
          </StageMapButton>
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
      )}
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
    </nav>
  );
}
