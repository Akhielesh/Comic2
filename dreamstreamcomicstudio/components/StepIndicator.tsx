import React from 'react';
import { Check } from 'lucide-react';
import { AppStep } from '../types';
import { cn } from '../lib/utils';
import {
  CANVAS_BG,
  DENSITY,
  FOCUS_RING_FLUSH,
  HAIRLINE,
  RADIUS_ROUND,
  SEGMENTED_ACTIVE,
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
// label, done steps ticked, steps not reached yet quiet and not pressable. Labels of the other steps show
// from `sm` up, so all seven fit a 320 px phone.
const STEP_ITEM = `relative inline-flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[calc(var(--ds-radius-control)-2px)] px-2 text-[13px] font-medium transition-colors duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] motion-reduce:transition-none ${DENSITY.touch} ${FOCUS_RING_FLUSH}`;
const STEP_MARK = `grid size-5 shrink-0 place-items-center ${RADIUS_ROUND} text-[11px] font-semibold tabular-nums`;

export const StepIndicator: React.FC<StepIndicatorProps> = ({ currentStep, maxStepReached, onStepClick }) => {
  return (
    <nav aria-label="Comic steps" className={cn('sticky top-0 w-full border-b border-[var(--ds-hairline)] py-3', CANVAS_BG, Z.chrome)}>
      <div className="mx-auto max-w-6xl px-4">
        <ol className={cn(SEGMENTED_TRACK, 'flex w-full')}>
          {steps.map((step, index) => {
            const isCompleted = currentStep > step.id;
            const isCurrent = currentStep === step.id;
            const isReachable = step.id <= maxStepReached;

            return (
              <li key={step.id} className={cn('flex min-w-0', isCurrent ? 'shrink-0' : 'flex-1')}>
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
                      ? SEGMENTED_ACTIVE
                      : isReachable
                        ? 'cursor-pointer text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
                        : 'cursor-not-allowed text-[var(--ds-faint)]'
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
