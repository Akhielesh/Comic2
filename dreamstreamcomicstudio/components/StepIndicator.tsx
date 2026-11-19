import React, { useEffect, useRef } from 'react';
import { Check } from 'lucide-react';
import { AppStep } from '../types';
import { cn } from '../lib/utils';
import {
  CANVAS_BG,
  DENSITY,
  HAIRLINE,
  RADIUS_ROUND,
  SEGMENTED_ACTIVE_FILL,
  SEGMENTED_ITEM,
  SEGMENTED_TRACK,
  Z
} from './chat/studioDesign';

interface StepIndicatorProps {
  currentStep: AppStep;
  maxStepReached: number;
  onStepClick: (step: AppStep) => void;
}

// Classic flat comic wizard — the original Dreamstream studio track restored. Scene review
// is automatic and panel planning happens inside the build, so there's no Story-Planning or
// manual Preview step (those enum slots stay reserved for old saves). Steps are referenced
// symbolically, so the current enum numbering is respected.
const steps = [
  { id: AppStep.SCRIPT_INPUT, label: 'Script' },
  { id: AppStep.STYLE_SELECTION, label: 'Style' },
  { id: AppStep.REFERENCE_BUILDER, label: 'World' },
  { id: AppStep.COVER, label: 'Cover' },
  { id: AppStep.LAYOUT_SELECTION, label: 'Layout' },
  { id: AppStep.FULL_GENERATION, label: 'Build' },
  { id: AppStep.REVIEW_EXPORT, label: 'Done' },
];

// The step track in the Atlas language: one segmented track, the current step on the raised pill with its
// label, done steps ticked, steps not reached yet quiet and not pressable. Every step is at least 44 px wide;
// labels of the other steps show from `sm` up, and on a narrow phone the track scrolls sideways and keeps the
// current step in view.
const STEP_ITEM = cn(
  SEGMENTED_ITEM,
  'min-w-[var(--ds-density-touch)] snap-center px-2 motion-reduce:transition-none aria-[current=step]:text-[var(--ds-ink)]',
  DENSITY.touch
);
const STEP_MARK = `grid size-5 shrink-0 place-items-center ${RADIUS_ROUND} text-[11px] font-semibold tabular-nums`;

export const StepIndicator: React.FC<StepIndicatorProps> = ({ currentStep, maxStepReached, onStepClick }) => {
  const listRef = useRef<HTMLOListElement>(null);

  // When the track overflows (a narrow phone), bring the current step into view without moving the page.
  useEffect(() => {
    const list = listRef.current;
    const current = list?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!list || !current || list.scrollWidth <= list.clientWidth) return;
    list.scrollLeft = current.offsetLeft - (list.clientWidth - current.offsetWidth) / 2;
  }, [currentStep]);

  return (
    <nav aria-label="Comic steps" className={cn('sticky top-0 w-full border-b border-[var(--ds-hairline)] py-3', CANVAS_BG, Z.chrome)}>
      <div className="mx-auto max-w-6xl px-4">
        <ol ref={listRef} className={cn(SEGMENTED_TRACK, 'flex w-full snap-x overflow-x-auto overscroll-x-contain')}>
          {steps.map((step, index) => {
            const isCompleted = currentStep > step.id;
            const isCurrent = currentStep === step.id;
            const isReachable = step.id <= maxStepReached;

            return (
              <li key={step.id} className={cn('flex', isCurrent ? 'shrink-0' : 'flex-1')}>
                <button
                  type="button"
                  aria-current={isCurrent ? 'step' : undefined}
                  aria-disabled={isReachable ? undefined : true}
                  aria-label={`Step ${index + 1}: ${step.label}${isCompleted ? ' (done)' : ''}`}
                  onClick={() => isReachable && onStepClick(step.id)}
                  className={cn(
                    STEP_ITEM,
                    'w-full',
                    isCurrent
                      ? SEGMENTED_ACTIVE_FILL
                      : isReachable
                        ? 'cursor-pointer'
                        : 'cursor-not-allowed opacity-60 hover:text-[var(--ds-muted)]'
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      STEP_MARK,
                      isCurrent || isCompleted
                        ? 'bg-[var(--ds-ink)] text-[var(--ds-canvas)]'
                        : cn(HAIRLINE, 'bg-[var(--ds-canvas)]')
                    )}
                  >
                    {isCompleted ? <Check className="size-3" strokeWidth={3} /> : index + 1}
                  </span>
                  <span aria-hidden className={cn('min-w-0 truncate', isCurrent ? 'inline' : 'hidden sm:inline')}>
                    {step.label}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </nav>
  );
};
