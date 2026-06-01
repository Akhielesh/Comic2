import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, BookOpen, Info } from 'lucide-react';
import { Scene, StoryPlanningState } from '../../types';
import { Button } from '../Button';
import {
  getComicFormFactorPresets,
  recommendStoryPlanning,
  getDefaultStoryPlanningState
} from '../../services/storyPlanning';

// Hover hint: a small info icon that reveals an explanation on hover/focus, so every
// control on this stage explains what it means and how it affects the rest of the flow.
const InfoHint: React.FC<{ text: string }> = ({ text }) => (
  <span className="relative inline-flex group align-middle ml-1" tabIndex={0}>
    <Info className="w-3.5 h-3.5 text-slate-400 cursor-help" />
    <span
      role="tooltip"
      className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1 w-60 rounded border-2 border-black bg-black p-2 text-[11px] font-comic font-normal normal-case tracking-normal text-white opacity-0 shadow-comic transition-opacity duration-150 group-hover:opacity-100 group-focus:opacity-100 z-50"
    >
      {text}
    </span>
  </span>
);

interface StoryPlanningProps {
  script: string;
  scenes: Scene[];
  planning?: StoryPlanningState;
  onPlanningChange: (planning: StoryPlanningState) => void;
  onConfirm: () => void;
}

const clampInt = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.floor(value)));

const readInt = (value: string, fallback: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
};

export const StoryPlanning: React.FC<StoryPlanningProps> = ({
  script,
  scenes,
  planning,
  onPlanningChange,
  onConfirm
}) => {
  const presets = useMemo(() => getComicFormFactorPresets(), []);
  const [localPlanning, setLocalPlanning] = useState<StoryPlanningState>(
    planning || recommendStoryPlanning({ script, scenes })
  );
  const [attemptedContinue, setAttemptedContinue] = useState(false);

  const wordCount = useMemo(
    () => script.trim().split(/\s+/).filter(Boolean).length,
    [script]
  );

  useEffect(() => {
    if (planning) {
      setLocalPlanning(planning);
      return;
    }
    const recommended = recommendStoryPlanning({ script, scenes });
    setLocalPlanning(recommended);
    onPlanningChange(recommended);
  }, [planning, script, scenes, onPlanningChange]);

  const preset = presets.find((entry) => entry.id === localPlanning.formFactor) || presets[0];

  const applyPlanningPatch = (patch: Partial<StoryPlanningState>) => {
    const next: StoryPlanningState = {
      ...localPlanning,
      ...patch
    };
    setLocalPlanning(next);
    onPlanningChange(next);
  };

  const recompute = (nextInput?: {
    formFactor?: StoryPlanningState['formFactor'];
    userRange?: StoryPlanningState['userRange'];
    customFormFactorNote?: string;
  }) => {
    const recommended = recommendStoryPlanning({
      script,
      scenes,
      formFactor: nextInput?.formFactor || localPlanning.formFactor,
      userRange: nextInput?.userRange || localPlanning.userRange,
      customFormFactorNote: nextInput?.customFormFactorNote ?? localPlanning.customFormFactorNote
    });

    const next: StoryPlanningState = {
      ...recommended,
      approved: false,
      approvedAt: undefined,
      resumeStep: localPlanning.resumeStep || recommended.resumeStep
    };
    setLocalPlanning(next);
    onPlanningChange(next);
  };

  const isFeasible = localPlanning.feasibility.status !== 'insufficient';

  const handleContinue = () => {
    setAttemptedContinue(true);
    if (!isFeasible) return;

    const approved: StoryPlanningState = {
      ...localPlanning,
      approved: true,
      approvedAt: Date.now()
    };
    setLocalPlanning(approved);
    onPlanningChange(approved);
    onConfirm();
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6 animate-fade-in">
      <div className="bg-white border-4 border-black rounded-xl shadow-comic p-6 space-y-2">
        <h2 className="text-3xl font-display text-black">Story Planning</h2>
        <p className="text-sm font-comic text-slate-600">
          Set the <strong>shape</strong> of your comic — its format and page count — before you choose a style and build the world.
          These choices drive the cost estimate, how your scenes are spread across pages, and the layout density suggested later.
          Nothing here is drawn yet; it's the blueprint the next stages follow.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs font-bold">
          <div className="border-2 border-black rounded px-2 py-1 bg-slate-50">Scenes: {scenes.length}</div>
          <div className="border-2 border-black rounded px-2 py-1 bg-slate-50">Words: {wordCount}</div>
          <div className="border-2 border-black rounded px-2 py-1 bg-slate-50">
            Recommended: {localPlanning.recommendedRange.min}-{localPlanning.recommendedRange.max} pages
          </div>
          <div className="border-2 border-black rounded px-2 py-1 bg-slate-50">
            Cost: ${localPlanning.estimatedCostRange.minUsd.toFixed(2)}-${localPlanning.estimatedCostRange.maxUsd.toFixed(2)}
          </div>
        </div>
      </div>

      <div className="bg-white border-4 border-black rounded-xl shadow-comic p-6 space-y-5">
        <div className="space-y-2">
          <label className="text-[11px] font-bold uppercase text-slate-500">
            Comic Form Factor
            <InfoHint text="The book format you're making (US Comic, Manga, Webtoon, etc.). It sets the typical panels-per-page and reading rhythm — US Comic ≈ 4-6 panels/page, Manga ≈ 5-8 — which guides the layout suggestions in the Layout stage." />
          </label>
          <select
            value={localPlanning.formFactor}
            onChange={(event) => {
              const formFactor = event.target.value as StoryPlanningState['formFactor'];
              recompute({ formFactor });
            }}
            className="w-full border-2 border-black rounded p-2 text-sm"
          >
            {presets.map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.label}</option>
            ))}
          </select>
          <div className="text-xs text-slate-600">{preset.description}</div>
        </div>

        {localPlanning.formFactor === 'custom' && (
          <div className="space-y-2">
            <label className="text-[11px] font-bold uppercase text-slate-500">Custom Format Notes</label>
            <textarea
              value={localPlanning.customFormFactorNote || ''}
              onChange={(event) => {
                const note = event.target.value;
                applyPlanningPatch({ customFormFactorNote: note, approved: false, approvedAt: undefined });
              }}
              rows={2}
              className="w-full border-2 border-black rounded p-2 text-sm"
              placeholder="Example: 7x10 inch print trim, matte stock"
            />
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="text-[11px] font-bold uppercase text-slate-500">
              Page Range Min
              <InfoHint text="The fewest pages you'd accept. Defaults are estimated from your script length (~110 words/page) and scene count. Sets the lower bound for the page count below." />
            </label>
            <input
              type="number"
              min={1}
              max={160}
              value={localPlanning.userRange.min}
              onChange={(event) => {
                const min = clampInt(readInt(event.target.value, localPlanning.userRange.min), 1, 160);
                const nextRange = { min, max: Math.max(min, localPlanning.userRange.max) };
                recompute({ userRange: nextRange });
              }}
              className="w-full border-2 border-black rounded p-2 text-sm"
            />
          </div>
          <div>
            <label className="text-[11px] font-bold uppercase text-slate-500">
              Page Range Max
              <InfoHint text="The most pages you'd accept. The feasibility check below warns you if your story can't comfortably fit within this range." />
            </label>
            <input
              type="number"
              min={1}
              max={160}
              value={localPlanning.userRange.max}
              onChange={(event) => {
                const max = clampInt(readInt(event.target.value, localPlanning.userRange.max), 1, 160);
                const nextRange = { min: Math.min(max, localPlanning.userRange.min), max };
                recompute({ userRange: nextRange });
              }}
              className="w-full border-2 border-black rounded p-2 text-sm"
            />
          </div>
          <div>
            <label className="text-[11px] font-bold uppercase text-slate-500">
              Approved Page Count
              <InfoHint text="The exact number of pages locked for this comic. It drives the cost estimate and how your scenes are distributed across pages in later stages. Must sit within the min/max range." />
            </label>
            <input
              type="number"
              min={localPlanning.userRange.min}
              max={localPlanning.userRange.max}
              value={localPlanning.approvedPageCount || localPlanning.recommendedPageCount}
              onChange={(event) => {
                const approvedPageCount = clampInt(
                  readInt(event.target.value, localPlanning.recommendedPageCount),
                  localPlanning.userRange.min,
                  localPlanning.userRange.max
                );
                applyPlanningPatch({ approvedPageCount, approved: false, approvedAt: undefined });
              }}
              className="w-full border-2 border-black rounded p-2 text-sm"
            />
          </div>
        </div>

        <div className={`border-2 rounded p-3 text-sm font-bold flex items-start gap-2 ${
          localPlanning.feasibility.status === 'ok'
            ? 'border-green-600 bg-green-50 text-green-700'
            : localPlanning.feasibility.status === 'tight'
              ? 'border-amber-500 bg-amber-50 text-amber-700'
              : 'border-brand-red bg-red-50 text-brand-red'
        }`}>
          {localPlanning.feasibility.status === 'ok' ? <CheckCircle2 className="w-4 h-4 mt-0.5" /> : <AlertCircle className="w-4 h-4 mt-0.5" />}
          <div>
            <div>{localPlanning.feasibility.reason}</div>
            <div className="text-xs mt-1">
              Estimated panels: {localPlanning.feasibility.estimatedPanels.min}-{localPlanning.feasibility.estimatedPanels.max}
              <InfoHint text="Roughly how many panels your story needs, from scene count and pacing. If this can't fit your page range, you'll see a warning — raise the page count or tighten the script." />
            </div>
          </div>
        </div>

        {attemptedContinue && !isFeasible && (
          <div className="border-2 border-brand-red bg-red-50 rounded px-3 py-2 text-sm font-bold text-brand-red">
            Adjust page range or script detail before continuing.
          </div>
        )}
      </div>

      <div className="bg-white border-4 border-black rounded-xl shadow-comic p-4 flex justify-end gap-3">
        <Button variant="secondary" icon={<BookOpen className="w-4 h-4" />} onClick={() => recompute()}>
          Recompute
        </Button>
        <Button onClick={handleContinue}>
          Confirm Plan & Continue
        </Button>
      </div>
    </div>
  );
};

export const createInitialPlanningState = () => getDefaultStoryPlanningState();
