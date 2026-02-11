import React, { useState, useEffect } from 'react';
import { Sparkles, Search, X, Wand2 } from 'lucide-react';
import { Scene, StyleVariant } from '../../types';
import { Button } from '../Button';
import { STYLE_PRESETS, RECOMMENDED_STYLE_IDS } from '../../services/data/stylePresets';
import { StyleCard } from '../style/StyleCard';
import { useStyleGeneration, FORM_FACTORS, DEFAULT_FORM_FACTOR } from '../../hooks/useStyleGeneration';

interface StyleSelectionProps {
  firstScene?: Scene;
  script: string;
  projectId: string;
  onScenesGenerated: (scenes: Scene[]) => void;
  onStyleConfirmed: (style: StyleVariant) => void;
  initialVariants: StyleVariant[];
  onVariantsChange: (variants: StyleVariant[]) => void;
  selectedStyleId?: string;
  onBackToScript?: () => void;
  onScriptUpdate?: (script: string) => void;
  customAspectRatioEnabled?: boolean;
  customAspectRatio?: string;
  onCustomAspectRatioChange?: (enabled: boolean, ratio?: string) => void;
}

export const StyleSelection: React.FC<StyleSelectionProps> = ({
  firstScene,
  projectId,
  onStyleConfirmed,
  initialVariants,
  onVariantsChange,
  customAspectRatioEnabled,
  customAspectRatio
}) => {
  const [customPrompt, setCustomPrompt] = useState('');
  const [customStyleInput, setCustomStyleInput] = useState('');
  const [styleSearch, setStyleSearch] = useState('');

  const [customRatioEnabled, setCustomRatioEnabled] = useState(!!customAspectRatioEnabled);
  const [customRatioInput, setCustomRatioInput] = useState(customAspectRatio || '');

  const [styleSelections, setStyleSelections] = useState<Record<string, { selected: boolean, formFactors: string[] }>>(() => {
    const init: Record<string, { selected: boolean, formFactors: string[] }> = {};
    STYLE_PRESETS.forEach((style) => {
      init[style.id] = { selected: false, formFactors: [] };
    });
    return init;
  });

  const {
      isBatchGenerating,
      generationError,
      pendingPreviews,
      generateStyles
  } = useStyleGeneration({
      projectId,
      firstSceneSynopsis: firstScene?.synopsis,
      firstSceneSetting: firstScene?.setting,
      onVariantsChange,
      initialVariants
  });

  const toggleStyle = (styleId: string) => {
    setStyleSelections((prev) => {
      const current = prev[styleId] || { selected: false, formFactors: [] };
      const nextSelected = !current.selected;
      const nextFormFactors = nextSelected
        ? (current.formFactors.length > 0 ? current.formFactors : [DEFAULT_FORM_FACTOR])
        : current.formFactors;
      return { ...prev, [styleId]: { selected: nextSelected, formFactors: nextFormFactors } };
    });
  };

  const toggleFormFactor = (styleId: string, formFactorId: string) => {
    setStyleSelections((prev) => {
      const current = prev[styleId] || { selected: false, formFactors: [] };
      let next = current.formFactors.includes(formFactorId)
        ? current.formFactors.filter((id) => id !== formFactorId)
        : current.formFactors.length >= 2
          ? current.formFactors
          : [...current.formFactors, formFactorId];
      if (next.length === 0) next = [DEFAULT_FORM_FACTOR];
      return { ...prev, [styleId]: { ...current, formFactors: next } };
    });
  };

  const selectRecommended = () => {
      setStyleSelections((prev) => {
          const next = { ...prev };
          RECOMMENDED_STYLE_IDS.forEach((id) => {
              next[id] = { selected: true, formFactors: [DEFAULT_FORM_FACTOR] };
          });
          return next;
      });
  };

  const handleGenerateSelected = async () => {
      const selectedStyles = STYLE_PRESETS.filter(s => styleSelections[s.id]?.selected);

      // Temporary handling for custom style input
      if (customStyleInput.trim()) {
          const customStyle = {
              id: `custom-${Date.now()}`,
              label: 'Custom Style',
              prompt: customStyleInput,
              description: 'Your custom style',
          };
          selectedStyles.push(customStyle);
          // Mock selection entry
          styleSelections[customStyle.id] = { selected: true, formFactors: [DEFAULT_FORM_FACTOR] };
      }

      await generateStyles(selectedStyles, styleSelections, customPrompt, customRatioEnabled, customRatioInput);
  };

  if (!firstScene) {
      return (
        <div className="flex items-center justify-center h-64">
           <div className="text-xl font-bold text-slate-500">Please analyze your script first to generate scenes.</div>
        </div>
      );
  }

  const normalizedSearch = styleSearch.trim().toLowerCase();
  const visibleStyles = normalizedSearch.length === 0
    ? STYLE_PRESETS
    : STYLE_PRESETS.filter((style) =>
      style.label.toLowerCase().includes(normalizedSearch) ||
      style.description.toLowerCase().includes(normalizedSearch)
    );

  const selectedCount = Object.values(styleSelections).filter((s) => s.selected).length;

  return (
    <div className="max-w-7xl mx-auto space-y-8 animate-fade-in">
       <div className="text-center space-y-2 bg-white p-4 rounded-xl border-4 border-black shadow-comic w-fit mx-auto transform rotate-1">
        <h2 className="text-3xl font-display text-black uppercase tracking-wider">Style Stage</h2>
        <p className="text-slate-600 font-comic font-bold">Pick your favorite style directions, then generate only those previews.</p>
      </div>

       <div className="bg-white p-6 rounded-xl border-4 border-black shadow-comic space-y-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h3 className="text-2xl font-display">Recommended 5</h3>
            <p className="text-sm text-slate-600 font-comic">A solid starting set to keep things focused.</p>
          </div>
          <Button onClick={selectRecommended} variant="secondary" icon={<Sparkles className="w-4 h-4" />}>
            Select Recommended
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {STYLE_PRESETS.filter((style) => RECOMMENDED_STYLE_IDS.includes(style.id)).map((style) => (
            <span key={style.id} className="px-3 py-1 text-xs font-bold border-2 border-black rounded bg-brand-yellow/60">
              {style.label}
            </span>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-8">
        <div className="space-y-6">
            <div className="bg-white p-6 rounded-xl border-4 border-black shadow-comic space-y-4">
                <div className="flex items-center justify-between">
                    <h3 className="text-2xl font-display">Choose Styles</h3>
                    <div className="text-xs font-bold">Selected: {selectedCount}</div>
                </div>

                 <div className="flex items-center gap-2 border-2 border-black rounded-lg px-3 py-2 bg-slate-50 w-full md:w-2/3">
                    <Search className="w-4 h-4 text-slate-500" />
                    <input
                    value={styleSearch}
                    onChange={(e) => setStyleSearch(e.target.value)}
                    placeholder="Search styles..."
                    className="flex-1 bg-transparent text-sm font-medium outline-none"
                    />
                    {styleSearch && (
                    <button onClick={() => setStyleSearch('')} className="text-slate-400 hover:text-black">
                        <X className="w-4 h-4" />
                    </button>
                    )}
                </div>

                <div className="max-h-[520px] overflow-y-auto pr-2 custom-scrollbar">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Custom Input Card */}
                        <div className={`border-4 rounded-xl p-4 space-y-3 transition-all ${customStyleInput ? 'border-brand-blue bg-brand-blue/5 shadow-comic' : 'border-dashed border-slate-300 bg-slate-50'}`}>
                            <div className="font-display text-lg">Your Custom Style</div>
                            <textarea
                                value={customStyleInput}
                                onChange={(e) => setCustomStyleInput(e.target.value)}
                                placeholder="Describe a unique style e.g. 'Pixel art cyberpunk with neon pink outlines'..."
                                className="w-full h-24 text-xs font-medium bg-white border-2 border-slate-200 rounded p-2 focus:border-black focus:ring-0 resize-none"
                            />
                        </div>

                        {visibleStyles.map(style => (
                            <StyleCard
                                key={style.id}
                                style={style}
                                isSelected={styleSelections[style.id]?.selected}
                                onToggle={() => toggleStyle(style.id)}
                                formFactors={FORM_FACTORS}
                                selectedFormFactors={styleSelections[style.id]?.formFactors || []}
                                onToggleFormFactor={(fid) => toggleFormFactor(style.id, fid)}
                                maxFactorsSelected={(styleSelections[style.id]?.formFactors || []).length >= 2}
                            />
                        ))}
                    </div>
                </div>
            </div>

            <div className="bg-white p-6 rounded-xl border-4 border-black shadow-comic space-y-3">
                <label className="text-lg font-display text-black">Style Notes (Optional)</label>
                <textarea
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder="Add any extra notes that should apply to all selected styles..."
                className="w-full h-24 bg-slate-50 border-2 border-black rounded-lg p-3 text-sm font-medium text-black placeholder-slate-400 focus:ring-0 focus:shadow-comic transition-all resize-none"
                />
                <Button
                onClick={handleGenerateSelected}
                isLoading={isBatchGenerating}
                disabled={selectedCount === 0 && !customStyleInput}
                className="w-full"
                icon={<Wand2 className="w-4 h-4" />}
                >
                Generate Selected Styles
                </Button>
            </div>

             {generationError && (
              <div className="bg-red-50 p-4 rounded-xl border-4 border-brand-red shadow-comic mt-4">
                <h3 className="text-lg font-display text-brand-red mb-2">Error</h3>
                <p className="font-comic text-black font-medium">{generationError}</p>
              </div>
            )}
        </div>

        <div className="space-y-6">
            <div className="bg-white p-6 rounded-xl border-4 border-black shadow-comic">
                <h3 className="text-2xl font-display mb-4">Generated Gallery</h3>
                 <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
                    {initialVariants.map(variant => (
                        <div key={variant.id} className="bg-white rounded-xl border-4 border-black shadow-comic p-2 group relative">
                             <img src={variant.imageUrl} className="w-full aspect-square object-cover rounded mb-2" />
                             <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                <Button size="sm" onClick={() => onStyleConfirmed(variant)}>Select</Button>
                             </div>
                             <div className="text-xs font-bold text-center">{variant.category}</div>
                        </div>
                    ))}
                    {pendingPreviews.map(p => (
                         <div key={p.id} className="bg-slate-100 rounded-xl border-4 border-black border-dashed aspect-square flex flex-col items-center justify-center p-4 text-center">
                             <span className="text-xs font-bold animate-pulse mb-2">Generating...</span>
                             <span className="text-[10px] text-slate-500">{p.category}</span>
                         </div>
                    ))}
                 </div>
                 {initialVariants.length === 0 && pendingPreviews.length === 0 && (
                     <div className="text-center text-slate-500 py-10">
                         No styles generated yet.
                     </div>
                 )}
            </div>
        </div>
      </div>
    </div>
  );
};
