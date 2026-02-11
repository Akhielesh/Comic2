import React, { useEffect, useState } from 'react';
import { StepIndicator } from './StepIndicator';
import { ScriptInput } from './steps/ScriptInput';
import { StyleSelection } from './steps/StyleSelection';
import { CoverDesigner } from './steps/CoverDesigner';
import { ReferenceBuilder } from './steps/ReferenceBuilder';
import { LayoutSelector } from './steps/LayoutSelector';
import { ComicGenerator } from './ComicGenerator';
import { ReviewExport } from './steps/ReviewExport';
import { CombinedPreview } from './steps/CombinedPreview';
import { AppStep, Project } from '../types';
import { assignImageTags, collectStateImageEntries } from '../services/imageTags';
import { ArrowLeft, Save, History } from 'lucide-react';
import { VersionHistoryModal } from './modals/VersionHistoryModal';
import { ProjectVersion } from '../types';

interface ComicEditorProps {
  project: Project;
  onUpdate: (updates: Partial<Project>) => void;
  onStartGeneration: (projectId: string) => void;
  onStopGeneration: (projectId: string) => void;
  onBack: () => void;
}

export const ComicEditor: React.FC<ComicEditorProps> = ({ project, onUpdate, onStartGeneration, onStopGeneration, onBack }) => {
  const state = project.state;
  const [titleDraft, setTitleDraft] = useState(project.name);
  const [showVersions, setShowVersions] = useState(false);

  const updateState = (updates: any) => {
    onUpdate({
      state: { ...state, ...updates }
    });
  };

  const nextStep = () => {
    const next = state.step + 1;
    updateState({
      step: next,
      maxStepReached: Math.max(state.maxStepReached, next)
    });
  };

  const goToStep = (targetStep: AppStep) => {
    if (targetStep <= state.maxStepReached) {
      updateState({ step: targetStep });
    }
  };

  useEffect(() => {
    const status = state.generationStatus;
    const shouldAdvance = status && !status.isActive && state.panels.length > 0 && state.step === AppStep.FULL_GENERATION;
    if (shouldAdvance) {
      updateState({
        step: AppStep.REVIEW_EXPORT,
        maxStepReached: Math.max(state.maxStepReached, AppStep.REVIEW_EXPORT)
      });
    }
  }, [state.generationStatus?.isActive, state.panels.length, state.step, state.maxStepReached]);

  useEffect(() => {
    setTitleDraft(project.name);
  }, [project.id, project.name]);

  useEffect(() => {
    const entries = collectStateImageEntries(state);
    if (entries.length === 0) return;
    const { tags, counters, added } = assignImageTags(
      state.imageTags || {},
      state.imageTagCounters || {},
      entries
    );
    if (added.length === 0) return;
    updateState({ imageTags: tags, imageTagCounters: counters });
  }, [state]);

  const saveVersion = () => {
    const name = prompt("Name this version:", `Version ${new Date().toLocaleTimeString()}`);
    if (!name) return;

    const newVersion: ProjectVersion = {
      id: crypto.randomUUID(),
      name,
      createdAt: Date.now(),
      state: JSON.parse(JSON.stringify(state)) // Deep clone state
    };

    const currentVersions = state.versions || [];
    // Limit to 10 versions max for storage size
    const updatedVersions = [...currentVersions, newVersion].slice(-10);

    updateState({ versions: updatedVersions });
    alert("Version saved!");
  };

  const deleteVersion = (versionId: string) => {
    const updatedVersions = (state.versions || []).filter(v => v.id !== versionId);
    updateState({ versions: updatedVersions });
  };

  const restoreVersion = (version: ProjectVersion) => {
    // Preserve versions list when restoring old state
    const mergedState = {
      ...version.state,
      versions: state.versions
    };
    onUpdate({ state: mergedState });
    setShowVersions(false);
  };

  const renderStep = () => {
    switch (state.step) {
      case AppStep.SCRIPT_INPUT:
        return <ScriptInput
          initialScript={state.script}
          projectId={project.id}
          onScriptChange={(script) => updateState({ script })}
          initialStoryBuilder={state.storyBuilder}
          onStoryBuilderUpdate={(storyBuilder) => updateState({ storyBuilder })}
          initialChecklist={state.scriptChecklist}
          onChecklistUpdate={(scriptChecklist) => updateState({ scriptChecklist })}
          onScenesGenerated={(script, scenes) => { updateState({ script, scenes }); nextStep(); }}
        />;
      case AppStep.STYLE_SELECTION:
        return <StyleSelection
          firstScene={state.scenes[0]}
          script={state.script}
          projectId={project.id}
          onScenesGenerated={(scenes) => updateState({ scenes })}
          onScriptUpdate={(script) => updateState({ script })}
          initialVariants={state.styleVariants}
          selectedStyleId={state.selectedStyleId}
          onVariantsChange={(styleVariants) => updateState({ styleVariants })}
          onBackToScript={() => goToStep(AppStep.SCRIPT_INPUT)}
          customAspectRatioEnabled={state.customAspectRatioEnabled}
          customAspectRatio={state.customAspectRatio}
          onCustomAspectRatioChange={(enabled, ratio) => updateState({ customAspectRatioEnabled: enabled, customAspectRatio: ratio })}
          onStyleConfirmed={(style) => {
            updateState({ selectedStyleId: style.id, stylePrompt: style.prompt, styleCategory: style.category, styleAspectRatio: style.aspectRatio, imageResolution: style.resolution });
            nextStep();
          }} />;
      case AppStep.REFERENCE_BUILDER:
        return <ReferenceBuilder
          scenes={state.scenes}
          currentStyle={state.stylePrompt}
          projectId={project.id}
          initialCharacters={state.characters || []} // Ensure defaults
          initialItems={state.items || []}
          initialLocations={state.locations || []}
          onDataUpdate={(data) => updateState({ ...data })}
          onConfirm={() => nextStep()} />;
      case AppStep.COVER:
        return (
          <CoverDesigner
            state={state}
            projectId={project.id}
            onUpdate={(updates) => updateState(updates)}
            onConfirm={() => nextStep()}
          />
        );
      case AppStep.LAYOUT_SELECTION:
        return <LayoutSelector
          currentLayoutType={state.layoutType}
          currentTextLayout={state.textLayout || 'caption'}
          projectId={project.id}
          onTextLayoutChange={(textLayout) => updateState({ textLayout })}
          onLayoutConfirmed={(layoutType, customLayoutPrompt) => { updateState({ layoutType, customLayoutPrompt }); nextStep(); }} />;
      case AppStep.COMBINED_PREVIEW:
        return (
          <CombinedPreview
            state={state}
            projectId={project.id}
            onConfirm={nextStep}
            onStateUpdate={(updates) => updateState(updates)}
          />
        );
      case AppStep.FULL_GENERATION:
        return <ComicGenerator
          state={state}
          onStart={() => onStartGeneration(project.id)}
          onCancel={() => onStopGeneration(project.id)}
          onGenerationComplete={(panels) => { updateState({ panels }); nextStep(); }}
        />;
      case AppStep.REVIEW_EXPORT:
        return <ReviewExport
          projectId={project.id}
          projectName={project.name}
          panels={state.panels}
          state={state}
          onUpdatePanel={(id, imageId, imageUrl) => {
            const newPanels = state.panels.map(p => p.id === id ? {
              ...p,
              imageId,
              imageUrl,
              imageIdHistory: [...(p.imageIdHistory || []), imageId],
              imageUrlHistory: [...(p.imageUrlHistory || []), imageUrl]
            } : p);
            updateState({ panels: newPanels });
          }} />;
      default: return null;
    }
  };

  return (
    <div className="min-h-screen flex flex-col pt-20">
      <div className="bg-white border-b-4 border-black z-40 fixed top-20 left-0 right-0">
          <StepIndicator currentStep={state.step} maxStepReached={state.maxStepReached} onStepClick={goToStep} />

           <div className="p-4 bg-white/50 backdrop-blur-sm flex items-center gap-4">
              <input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => {
                  const trimmed = titleDraft.trim();
                  if (trimmed && trimmed !== project.name) {
                    onUpdate({ name: trimmed });
                  } else {
                    setTitleDraft(project.name);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                className="font-display text-xl bg-transparent border-b-2 border-transparent focus:border-black outline-none flex-1"
                placeholder="Project Title"
              />
              {state.generationStatus?.isActive && (
                <div className="flex items-center gap-2 px-3 py-1 bg-brand-yellow rounded-full border border-black text-xs font-bold">
                  <div className="w-2 h-2 bg-black rounded-full animate-pulse" /> Building...
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  onClick={saveVersion}
                  className="p-2 hover:bg-slate-100 rounded-full text-slate-600 hover:text-black transition-colors"
                  title="Save Version Snapshot"
                >
                  <Save size={20} />
                </button>
                <button
                  onClick={() => setShowVersions(true)}
                  className="p-2 hover:bg-slate-100 rounded-full text-slate-600 hover:text-black transition-colors relative"
                  title="Version History"
                >
                  <History size={20} />
                  {(state.versions?.length || 0) > 0 && (
                    <span className="absolute top-1 right-1 w-2 h-2 bg-brand-blue rounded-full" />
                  )}
                </button>
              </div>
          </div>
      </div>

      <main className="p-6 max-w-7xl mx-auto w-full flex-1 mt-32">
        {renderStep()}
      </main>

      {showVersions && (
        <VersionHistoryModal
          versions={state.versions || []}
          onClose={() => setShowVersions(false)}
          onDelete={deleteVersion}
          onRestore={restoreVersion}
        />
      )}
    </div>
  );
};
