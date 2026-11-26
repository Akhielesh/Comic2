// A comic's five stages as marks, the stage strip's compact glyph (StageStrip StageMark): a check when done, a filled
// dot for the current stage, a ring for the rest. Ink only and decorative: the words beside it carry the meaning.

import React from 'react';
import type { StageStep } from '../../../shared/comic/stage';
import { cn } from '../../../lib/utils';
import { MUTED } from '../../chat/studioDesign';
import { StageMark } from '../stage/StageStrip';

export function StageMarks({ steps, className }: { steps: readonly StageStep[]; className?: string }) {
  return (
    <span aria-hidden className={cn('inline-flex shrink-0 items-center gap-0.5', className)} data-stage-marks>
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
