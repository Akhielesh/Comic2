import React from 'react';
import { Check } from 'lucide-react';
import { AppStep } from '../types';

interface StepIndicatorProps {
  currentStep: AppStep;
  maxStepReached: number;
  onStepClick: (step: AppStep) => void;
}

// The nine AppSteps grouped into the three stages users actually think in:
// write the story, set up the cast, make the pages. The underlying step machine
// is unchanged — this is purely how progress is presented and navigated.
const STAGES: { label: string; steps: { id: AppStep; label: string }[] }[] = [
  {
    label: 'Story',
    steps: [
      { id: AppStep.SCRIPT_INPUT, label: 'Script' },
      { id: AppStep.STORY_PLANNING, label: 'Plan' },
      { id: AppStep.STYLE_SELECTION, label: 'Style' }
    ]
  },
  {
    label: 'Cast',
    steps: [
      { id: AppStep.REFERENCE_BUILDER, label: 'World' },
      { id: AppStep.COVER, label: 'Cover' }
    ]
  },
  {
    label: 'Pages',
    steps: [
      { id: AppStep.LAYOUT_SELECTION, label: 'Layout' },
      { id: AppStep.COMBINED_PREVIEW, label: 'Preview' },
      { id: AppStep.FULL_GENERATION, label: 'Build' },
      { id: AppStep.REVIEW_EXPORT, label: 'Done' }
    ]
  }
];

export const StepIndicator: React.FC<StepIndicatorProps> = ({ currentStep, maxStepReached, onStepClick }) => {
  return (
    <div className="w-full py-2 sticky top-0 z-40 bg-brand-blue/90 backdrop-blur-sm border-b-2 border-black">
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
                {stageIndex > 0 && <div className="h-1 w-4 sm:w-8 shrink-0 rounded-full bg-black/30" />}
                <div
                  className={`
                    flex items-center gap-1.5 rounded-full border-2 px-2 py-1 shrink-0 transition-all
                    ${isCurrentStage ? 'bg-white border-black shadow-comic' :
                      isCompletedStage ? 'bg-brand-yellow border-black cursor-pointer' :
                      isReachableStage ? 'bg-slate-800/70 border-slate-600 cursor-pointer' :
                      'bg-slate-800/70 border-slate-600 opacity-60 cursor-not-allowed'}
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
                      w-6 h-6 rounded-full flex items-center justify-center border-2 border-black shrink-0
                      ${isCompletedStage ? 'bg-white text-black' : isCurrentStage ? 'bg-brand-yellow text-black' : 'bg-slate-700 text-white/60 border-slate-500'}
                    `}
                  >
                    {isCompletedStage ? <Check size={14} strokeWidth={4} /> : <span className="text-xs font-display">{stageIndex + 1}</span>}
                  </div>
                  <span className={`text-xs font-bold uppercase tracking-wide whitespace-nowrap ${isCurrentStage || isCompletedStage ? 'text-black' : 'text-white/70'}`}>
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
                              rounded-full border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide whitespace-nowrap transition-all
                              ${isCurrent ? 'bg-black text-white border-black' :
                                isDone ? 'bg-brand-yellow text-black border-black' :
                                isReachable ? 'bg-white text-slate-600 border-slate-300 hover:border-black' :
                                'bg-white/60 text-slate-400 border-slate-200 cursor-not-allowed'}
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
