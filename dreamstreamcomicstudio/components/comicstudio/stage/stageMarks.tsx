// What the stage strip (SH-A), My comics' cards (SH-B), the side panel (SH-C1) and the stage map (SH-C2) share: where
// each place is, in words (a next step's or a target's description), one stage drawn as a mark, and the five marks as
// one row (the one row every surface draws, so a change to the marks reaches them all). Ink only; the marks are SVG in
// the text colour, so they keep their shapes in forced colours (high contrast).

import React from 'react';
import { Check } from 'lucide-react';
import type { StagePlace, StageStep } from '../../../shared/comic/stage';
import { cn } from '../../../lib/utils';
import { MUTED } from '../../chat/studioDesign';

/** Where each place is, in words: the next step's description (the side panel and the stage map read it too). */
export const PLACE_HINT: Readonly<Record<StagePlace, string>> = {
  story: 'Opens the Story tab',
  style: 'Opens the Style tab',
  pages: 'Opens the Pages tab',
  read: 'Opens the Read tab',
  approval: 'Shows the approval in the conversation',
  draft: 'Shows the Director’s draft in the conversation',
  composer: 'Opens the message box',
  share: 'Opens the Share sheet'
};

/** One stage as a mark: a check when done, a filled dot when current, a ring otherwise. */
export const StageMark = ({ done, current }: { done: boolean; current: boolean }) =>
  done ? (
    <Check className="h-2.5 w-2.5" strokeWidth={current ? 3.5 : 2.5} />
  ) : (
    <svg viewBox="0 0 8 8" className="h-2 w-2" focusable="false">
      {current ? <circle cx="4" cy="4" r="4" fill="currentColor" /> : <circle cx="4" cy="4" r="3.5" fill="none" stroke="currentColor" strokeWidth="1" />}
    </svg>
  );

/**
 * A comic's five stages as marks: a check when done, a filled dot for the current stage, a ring for the rest. Ink only
 * and decorative: the words beside it carry the meaning.
 */
export function StageMarks({ steps, className }: { steps: readonly StageStep[]; className?: string }) {
  return (
    <span aria-hidden="true" className={cn('inline-flex shrink-0 items-center gap-0.5', className)} data-stage-marks>
      {steps.map((step) => (
        <span
          key={step.stage}
          data-stage-mark={step.done ? 'done' : step.current ? 'current' : 'upcoming'}
          className={cn('flex h-2.5 w-2.5 items-center justify-center', step.done || step.current ? 'text-[var(--ds-ink)]' : MUTED)}
        >
          <StageMark done={step.done} current={step.current} />
        </span>
      ))}
    </span>
  );
}
