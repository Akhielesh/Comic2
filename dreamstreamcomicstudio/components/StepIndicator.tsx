import React from 'react';
import { Check } from 'lucide-react';
import { AppStep } from '../types';

interface StepIndicatorProps {
  currentStep: AppStep;
  maxStepReached: number;
  onStepClick: (step: AppStep) => void;
}

const steps = [
  { id: AppStep.SCRIPT_INPUT, label: "Script" },
  { id: AppStep.STORY_PLANNING, label: "Plan" },
  { id: AppStep.STYLE_SELECTION, label: "Style" },
  { id: AppStep.REFERENCE_BUILDER, label: "World" },
  { id: AppStep.COVER, label: "Cover" },
  { id: AppStep.LAYOUT_SELECTION, label: "Layout" },
  { id: AppStep.COMBINED_PREVIEW, label: "Preview" },
  { id: AppStep.FULL_GENERATION, label: "Build" },
  { id: AppStep.REVIEW_EXPORT, label: "Done" },
];

export const StepIndicator: React.FC<StepIndicatorProps> = ({ currentStep, maxStepReached, onStepClick }) => {
  return (
    <div className="w-full py-2.5 sticky top-0 z-40 bg-brand-blue/90 backdrop-blur-sm border-b-2 border-black">
      <div className="max-w-5xl mx-auto px-4">
        <div className="flex items-center justify-between relative">
          {/* Connecting Line */}
          <div className="absolute left-0 top-1/2 w-full h-1 bg-black/30 -z-10 rounded-full" />

          {steps.map((step, index) => {
            const isCompleted = currentStep > step.id;
            const isCurrent = currentStep === step.id;
            const isReachable = step.id <= maxStepReached;

            return (
              <div
                key={step.id}
                className={`flex items-center gap-1.5 relative group ${isReachable ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                onClick={() => isReachable && onStepClick(step.id)}
                title={step.label}
              >
                <div
                  className={`
                    w-7 h-7 rounded-full flex items-center justify-center border-2 border-black transition-all duration-300 z-10
                    ${isCompleted ? 'bg-brand-yellow text-black shadow-comic' :
                      isCurrent ? 'bg-white text-black shadow-comic' :
                      'bg-slate-800 text-white/50 border-slate-600'}
                  `}
                >
                  {isCompleted ? <Check size={15} strokeWidth={4} /> : <span className="text-xs font-display">{index + 1}</span>}
                </div>
                {/* Active step keeps its label inline; others reveal on hover (kept compact to save space). */}
                <span
                  className={`
                    text-xs font-bold uppercase tracking-wide whitespace-nowrap transition-all
                    ${isCurrent ? 'text-white max-w-[5rem]' : 'text-white/0 max-w-0 overflow-hidden group-hover:text-white group-hover:max-w-[5rem]'}
                  `}
                >
                  {step.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
