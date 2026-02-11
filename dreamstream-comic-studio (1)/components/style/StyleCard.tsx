import React from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { StylePreset } from '../../services/data/stylePresets';

interface StyleCardProps {
  style: StylePreset;
  isSelected: boolean;
  onToggle: () => void;
  formFactors: { id: string; label: string }[];
  selectedFormFactors: string[];
  onToggleFormFactor: (factorId: string) => void;
  maxFactorsSelected: boolean;
}

export const StyleCard: React.FC<StyleCardProps> = ({
  style,
  isSelected,
  onToggle,
  formFactors,
  selectedFormFactors,
  onToggleFormFactor,
  maxFactorsSelected
}) => {
  return (
    <div
      className={`border-4 rounded-xl p-4 space-y-3 transition-all ${isSelected ? 'border-brand-blue bg-brand-blue/5 shadow-comic' : 'border-black bg-white'}`}
    >
      <button
        onClick={onToggle}
        className="w-full flex items-start justify-between gap-3 text-left"
      >
        <div>
          <div className="font-display text-lg">{style.label}</div>
          <div className="text-xs font-comic text-slate-600">{style.description}</div>
        </div>
        <div className={`w-6 h-6 rounded-full border-2 border-black flex items-center justify-center ${isSelected ? 'bg-brand-yellow' : 'bg-white'}`}>
          {isSelected && <Check size={16} />}
        </div>
      </button>

      <details className="group">
        <summary className="cursor-pointer text-xs font-bold flex items-center gap-2 text-slate-600">
          <ChevronDown size={14} /> Advanced form factors (pick up to 2)
        </summary>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {formFactors.map((factor) => {
            const checked = selectedFormFactors.includes(factor.id);
            const disabled = !checked && maxFactorsSelected;
            return (
              <button
                key={factor.id}
                onClick={() => onToggleFormFactor(factor.id)}
                disabled={disabled}
                className={`text-[10px] font-bold border-2 rounded px-2 py-1 ${checked ? 'bg-brand-yellow border-black' : 'bg-white border-black/40'} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                {factor.label}
              </button>
            );
          })}
        </div>
        {maxFactorsSelected && (
          <div className="text-[10px] text-slate-500 mt-2">Limit reached. Remove one to select another.</div>
        )}
      </details>
    </div>
  );
};
