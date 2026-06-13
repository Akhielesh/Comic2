import React from 'react';
import { Check } from 'lucide-react';
import { AppStep } from '../types';

interface StepIndicatorProps {
  currentStep: AppStep;
  maxStepReached: number;
  onStepClick: (step: AppStep) => void;
}

// The live flow is grouped into three agent phases. Story-Planning and the manual
// panel Preview are intentionally absent: scene review is automatic, and panel
// planning happens inside the build.
const STAGES: { label: string; steps: { id: AppStep; label: string }[] }[] = [
  {
    label: 'Prompt',
    steps: [
      { id: AppStep.SCRIPT_INPUT, label: 'Script' },
      { id: AppStep.STYLE_SELECTION, label: 'Style' }
    ]
  },
  {
    label: 'Design',
    steps: [
      { id: AppStep.REFERENCE_BUILDER, label: 'Cast' },
      { id: AppStep.COVER, label: 'Cover' }
    ]
  },
  {
    label: 'Build',
    steps: [
      { id: AppStep.LAYOUT_SELECTION, label: 'Pages' },
      { id: AppStep.FULL_GENERATION, label: 'Build' },
      { id: AppStep.REVIEW_EXPORT, label: 'Export' }
    ]
  }
];

export const StepIndicator: React.FC<StepIndicatorProps> = ({ currentStep, maxStepReached, onStepClick }) => {
  return (
    <div className="w-full py-2 sticky top-0 z-40 bg-zinc-950/95 backdrop-blur-sm border-b border-zinc-800">
      <div className="max-w-5xl mx-auto px-4 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex items-center gap-2 sm:gap-3">
          {STAGES.map((stage, stageIndex) => {
            const firstStep = stage.steps[0].id;
            const lastStep = stage.steps[stage.steps.length - 1].id;
            const isCurrentStage = currentStep >= firstStep && currentStep <= lastStep;
            const isCompletedStage = currentStep > lastStep;
            const isReachableStage = firstStep <= maxStepReached;

            return (
              <React.Fragment key={stage.label}>
                {stageIndex > 0 && <div className="h-px w-2 sm:w-8 shrink-0 bg-zinc-700" />}
                <div
                  className={`
                    flex items-center gap-1.5 rounded-full border px-1.5 py-1 sm:px-2 shrink-0 transition-all
                    ${isCurrentStage ? 'bg-white border-white' :
                      isCompletedStage ? 'bg-emerald-300 border-emerald-300 cursor-pointer' :
                      isReachableStage ? 'bg-zinc-900 border-zinc-700 cursor-pointer' :
                      'bg-zinc-900 border-zinc-800 opacity-60 cursor-not-allowed'}
                  `}
                  onClick={() => {
                    if (!isCurrentStage && isReachableStage) {
                      onStepClick(Math.min(firstStep, maxStepReached) as AppStep);
                    }
                  }}
                  title={stage.label}
                >
                  <div
                    className={`
                      w-5 h-5 rounded-full flex items-center justify-center border shrink-0
                      ${isCompletedStage ? 'bg-zinc-950 text-emerald-300 border-zinc-950' : isCurrentStage ? 'bg-zinc-950 text-white border-zinc-950' : 'bg-zinc-800 text-white/60 border-zinc-700'}
                    `}
                  >
                    {isCompletedStage ? <Check size={12} strokeWidth={4} /> : <span className="text-[10px] font-semibold">{stageIndex + 1}</span>}
                  </div>
                  <span className={`text-xs font-semibold whitespace-nowrap ${isCurrentStage ? '' : 'hidden sm:inline'} ${isCurrentStage || isCompletedStage ? 'text-zinc-950' : 'text-white/70'}`}>
                    {stage.label}
                  </span>

                  {/* Sub-steps of the active stage, inline and clickable */}
                  {isCurrentStage && (
                    <div className="flex items-center gap-1 pl-1">
                      {stage.steps.map((step) => {
                        const isCurrent = currentStep === step.id;
                        const isDone = currentStep > step.id;
                        const isReachable = step.id <= maxStepReached;
                        return (
                          <button
                            key={step.id}
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              if (isReachable) onStepClick(step.id);
                            }}
                            disabled={!isReachable}
                            title={step.label}
                            className={`
                              rounded-full border px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap transition-all
                              ${isCurrent ? 'bg-zinc-950 text-white border-zinc-950' :
                                isDone ? 'bg-emerald-300 text-zinc-950 border-emerald-300' :
                                isReachable ? 'bg-white text-zinc-600 border-zinc-300 hover:border-zinc-950' :
                                'bg-white/60 text-zinc-400 border-zinc-200 cursor-not-allowed'}
                            `}
                          >
                            {step.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
};
