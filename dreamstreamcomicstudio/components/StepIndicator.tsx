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
    <div className="w-full py-6 sticky top-0 z-40 bg-brand-blue/90 backdrop-blur-sm border-b-4 border-black">
      <div className="max-w-6xl mx-auto px-4">
        <div className="flex items-center justify-between relative">
          {/* Connecting Line */}
          <div className="absolute left-0 top-1/2 w-full h-2 bg-black/30 -z-10 rounded-full" />
          
          {steps.map((step, index) => {
            const isCompleted = currentStep > step.id;
            const isCurrent = currentStep === step.id;
            const isReachable = step.id <= maxStepReached;
            
            return (
              <div 
                key={step.id} 
                className={`flex flex-col items-center relative group ${isReachable ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                onClick={() => isReachable && onStepClick(step.id)}
              >
                <div 
                  className={`
                    w-10 h-10 rounded-full flex items-center justify-center border-2 border-black transition-all duration-300 z-10
                    ${isCompleted ? 'bg-brand-yellow text-black shadow-comic' : 
                      isCurrent ? 'bg-white text-black scale-125 shadow-comic' : 
                      'bg-slate-800 text-white/50 border-slate-600'}
                  `}
                >
                  {isCompleted ? <Check size={20} strokeWidth={4} /> : <span className="text-sm font-display">{index + 1}</span>}
                </div>
                <div 
                  className={`
                    absolute top-12 px-2 py-1 rounded border-2 border-black text-xs font-bold uppercase tracking-wider shadow-comic transition-all whitespace-nowrap
                    ${isCurrent ? 'bg-brand-yellow text-black rotate-2 opacity-100' : (isReachable ? 'bg-white text-black -rotate-1 opacity-0 group-hover:opacity-100' : 'opacity-0')}
                  `}
                >
                  {step.label}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
