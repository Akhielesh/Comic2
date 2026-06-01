import React, { useEffect, useRef, useState } from 'react';
import { StepIndicator } from './StepIndicator';
import { ScriptInput } from './steps/ScriptInput';
import { StoryPlanning } from './steps/StoryPlanning';
import { StyleSelection } from './steps/StyleSelection';
import { CoverDesigner } from './steps/CoverDesigner';
import { ReferenceBuilder } from './steps/ReferenceBuilder';
import { LayoutSelector } from './steps/LayoutSelector';
import { ComicGenerator } from './ComicGenerator';
import { ReviewExport } from './steps/ReviewExport';
import { CombinedPreview } from './steps/CombinedPreview';
import { AppStep, Project } from '../types';
import { assignImageTags, collectStateImageEntries } from '../services/imageTags';
import {
  resetFromLayoutConfirm,
  resetFromScriptAnalysis,
  resetFromStoryPlanningConfirm,
  resetFromStyleConfirm,
  resetFromWorldConfirm
} from '../services/pipelineReset';
import { ArrowLeft, Save, History, AlertTriangle } from 'lucide-react';
import { VersionHistoryModal } from './modals/VersionHistoryModal';
import { ProjectVersion } from '../types';
import { checkDeploymentParity, DeploymentParityStatus } from '../services/geminiService';
import { getFormFactorDefaultAspectRatio } from '../services/storyPlanning';

interface ComicEditorProps {
  project: Project;
  onUpdate: (updates: Partial<Project> | ((prev: Project) => Partial<Project>)) => void;
  onStartGeneration: (projectId: string) => void;
  onStopGeneration: (projectId: string) => void;
  onBack: () => void;
}

export const ComicEditor: React.FC<ComicEditorProps> = ({ project, onUpdate, onStartGeneration, onStopGeneration, onBack }) => {
  const state = project.state;
  const [titleDraft, setTitleDraft] = useState(project.name);
  const [showVersions, setShowVersions] = useState(false);
  const [deploymentParity, setDeploymentParity] = useState<DeploymentParityStatus | null>(null);
  const [navError, setNavError] = useState<string | null>(null);
  const previousStepRef = useRef<AppStep>(state.step);
  const previousGenerationActiveRef = useRef<boolean>(!!state.generationStatus?.isActive);
  const lastAutoVersionKeyRef = useRef<string>('');
  const lastPlanVersionKeyRef = useRef<string>('');

  const updateState = (updates: Partial<Project['state']> | ((prev: Project['state']) => Partial<Project['state']>)) => {
    onUpdate((prevProject) => {
      const patch = typeof updates === 'function' ? updates(prevProject.state) : updates;
      return {
        state: { ...prevProject.state, ...patch }
      };
    });
  };

  // Hard prerequisites for leaving a step — keeps the pipeline from advancing into a
  // state generation can't use (e.g. entering generation with no planned panels).
  const advanceBlockReason = (s: Project['state']): string | null => {
    switch (s.step) {
      case AppStep.SCRIPT_INPUT:
        return (s.scenes?.length || 0) > 0 ? null : 'Analyze the script into scenes first.';
      case AppStep.STYLE_SELECTION:
        return s.selectedStyleId || s.stylePrompt ? null : 'Choose a style first.';
      case AppStep.LAYOUT_SELECTION:
        return (s.scenes?.length || 0) > 0 ? null : 'Add scenes before planning panels.';
      case AppStep.COMBINED_PREVIEW:
        return (s.panels?.length || 0) > 0 ? null : 'Plan at least one panel before generating.';
      default:
        return null;
    }
  };

  const nextStep = () => {
    const reason = advanceBlockReason(state);
    if (reason) {
      setNavError(reason);
      return;
    }
    setNavError(null);
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

  const snapshotState = (source: Project['state']): Project['state'] => {
    const cloned = JSON.parse(JSON.stringify(source)) as Project['state'];
    delete cloned.versions;
    return cloned;
  };

  const computeSnapshotHash = (sourceState: Project['state']) => {
    const raw = JSON.stringify(snapshotState(sourceState));
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i += 1) {
      hash ^= raw.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return `v${Math.abs(hash >>> 0).toString(16)}`;
  };

  const appendVersion = (
    name: string,
    sourceState: Project['state'],
    reason?: ProjectVersion['reason'],
    parentVersionId?: string
  ) => {
    const snapshotHash = computeSnapshotHash(sourceState);
    const currentVersions = state.versions || [];
    if (currentVersions[currentVersions.length - 1]?.snapshotHash === snapshotHash) {
      return currentVersions;
    }
    const newVersion: ProjectVersion = {
      id: crypto.randomUUID(),
      name,
      createdAt: Date.now(),
      state: snapshotState(sourceState),
      reason,
      parentVersionId,
      snapshotHash
    };
    return [...currentVersions, newVersion].slice(-20);
  };

  // Snapshot the pre-reset state before a destructive pipeline reset, so editing an
  // upstream step doesn't silently discard downstream work — it stays restorable from
  // Version History.
  const applyReset = (
    label: string,
    producePatch: (prev: Project['state']) => Partial<Project['state']>
  ) => {
    setNavError(null);
    updateState((prev) => ({
      ...producePatch(prev),
      versions: appendVersion(`Before ${label} (${new Date().toLocaleTimeString()})`, prev, 'reset')
    }));
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
    const previousStep = previousStepRef.current;
    if (previousStep === state.step) return;

    let nextVersionName: string | null = null;
    let autoKey = '';

    if (state.step === AppStep.COMBINED_PREVIEW && state.panels.length > 0) {
      autoKey = `preview:${state.panelPlanVersion || 0}:${state.panels.length}`;
      nextVersionName = `Auto - Preview Plan (${new Date().toLocaleTimeString()})`;
    }

    if (state.step === AppStep.REVIEW_EXPORT && state.panels.length > 0) {
      const imageSignature = state.panels.map((panel) => panel.imageId || '').join('|');
      // Include panelPlanVersion (as the preview key does) so a re-plan after an upstream
      // edit/reset isn't deduped away when it lands on the same panel count + images.
      autoKey = `review:${state.panelPlanVersion || 0}:${state.panels.length}:${imageSignature}`;
      nextVersionName = `Auto - Build Ready (${new Date().toLocaleTimeString()})`;
    }

    previousStepRef.current = state.step;

    if (!nextVersionName || !autoKey || autoKey === lastAutoVersionKeyRef.current) return;
    lastAutoVersionKeyRef.current = autoKey;
    updateState({ versions: appendVersion(nextVersionName, state, 'panel') });
  }, [state.step, state.panels, state.panelPlanVersion]);

  useEffect(() => {
    const previous = previousGenerationActiveRef.current;
    const current = !!state.generationStatus?.isActive;
    if (previous === current) return;

    previousGenerationActiveRef.current = current;
    if (current) {
      updateState({
        versions: appendVersion(
          `Auto - Generation Started (${new Date().toLocaleTimeString()})`,
          state,
          'panel'
        )
      });
      return;
    }
    if (!current && state.panels.length > 0) {
      updateState({
        versions: appendVersion(
          `Auto - Generation Complete (${new Date().toLocaleTimeString()})`,
          state,
          'panel'
        )
      });
    }
  }, [state.generationStatus?.isActive, state.panels.length]);

  useEffect(() => {
    if (state.step !== AppStep.COMBINED_PREVIEW) return;
    if (state.panels.length === 0) return;
    const planIds = state.panels
      .filter((panel) => panel.isPlanned !== false)
      .map((panel) => panel.id)
      .sort()
      .join('|');
    if (!planIds) return;
    const key = `plan:${planIds}`;
    if (key === lastPlanVersionKeyRef.current) return;
    lastPlanVersionKeyRef.current = key;
    updateState({
      versions: appendVersion(
        `Auto - Plan Updated (${new Date().toLocaleTimeString()})`,
        state,
        'panel'
      )
    });
  }, [state.step, state.panels]);

  useEffect(() => {
    setTitleDraft(project.name);
  }, [project.id, project.name]);

  useEffect(() => {
    let active = true;
    const loadParity = async () => {
      try {
        const parity = await checkDeploymentParity();
        if (!active) return;
        setDeploymentParity(parity);
      } catch {
        if (!active) return;
        setDeploymentParity(null);
      }
    };
    void loadParity();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    previousStepRef.current = state.step;
    previousGenerationActiveRef.current = !!state.generationStatus?.isActive;
    lastAutoVersionKeyRef.current = '';
    lastPlanVersionKeyRef.current = '';
  }, [project.id]);

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
    // Recompute tags only when an image-bearing slice changes — collectStateImageEntries
    // reads exactly these — rather than on every state mutation (e.g. each keystroke).
  }, [
    state.coverImageId,
    state.coverTemplateImageId,
    state.styleVariants,
    state.characters,
    state.items,
    state.locations,
    state.panels
  ]);

  const saveVersion = () => {
    const name = prompt("Name this version:", `Version ${new Date().toLocaleTimeString()}`);
    if (!name) return;

    updateState({ versions: appendVersion(name, state, 'manual') });
    alert("Version saved!");
  };

  const deleteVersion = (versionId: string) => {
    const updatedVersions = (state.versions || []).filter(v => v.id !== versionId);
    updateState({ versions: updatedVersions });
  };

  const restoreVersion = (version: ProjectVersion) => {
    const restoredFromVersionId = version.id;
    const historyWithCheckpoint = appendVersion(
      `Auto - Before Restore (${new Date().toLocaleTimeString()})`,
      state,
      'manual',
      restoredFromVersionId
    );
    // Preserve versions list when restoring old state
    const mergedState = {
      ...version.state,
      versions: historyWithCheckpoint
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
          onScenesGenerated={(script, scenes) => {
            applyReset('re-analyzing script', (prev) => resetFromScriptAnalysis(prev, script, scenes));
          }}
        />;
      case AppStep.STORY_PLANNING:
        return (
          <StoryPlanning
            script={state.script}
            scenes={state.scenes}
            planning={state.storyPlanning}
            onPlanningChange={(storyPlanning) => updateState({ storyPlanning })}
            onConfirm={() => applyReset('confirming story planning', (prev) => resetFromStoryPlanningConfirm(prev))}
          />
        );
      case AppStep.STYLE_SELECTION:
        return <StyleSelection
          firstScene={state.scenes[0]}
          script={state.script}
          projectId={project.id}
          onScenesGenerated={(scenes, analyzedScript) => {
            applyReset('re-analyzing script', (prev) => resetFromScriptAnalysis(prev, analyzedScript || prev.script, scenes));
          }}
          onScriptUpdate={(script) => updateState({ script })}
          initialVariants={state.styleVariants}
          selectedStyleId={state.selectedStyleId}
          onVariantsChange={(styleVariants) => updateState({ styleVariants })}
          onBackToScript={() => goToStep(AppStep.SCRIPT_INPUT)}
          customAspectRatioEnabled={state.customAspectRatioEnabled}
          customAspectRatio={state.customAspectRatio}
          onCustomAspectRatioChange={(enabled, ratio) => updateState({ customAspectRatioEnabled: enabled, customAspectRatio: ratio })}
          onStyleConfirmed={(style) => {
            applyReset('confirming style', (prev) => resetFromStyleConfirm(prev, style));
          }} />;
      case AppStep.REFERENCE_BUILDER:
        return <ReferenceBuilder
          scenes={state.scenes}
          script={state.script}
          currentStyle={state.stylePrompt}
          styleImageId={state.styleImageId}
          projectId={project.id}
          initialCharacters={state.characters || []} // Ensure defaults
          initialItems={state.items || []}
          initialLocations={state.locations || []}
          initialContinuity={state.continuity}
          onDataUpdate={(data) => updateState({ ...data })}
          onConfirm={() => applyReset('confirming characters', (prev) => resetFromWorldConfirm(prev))} />;
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
          currentGridTemplateId={state.gridTemplateId}
          selectedFormFactor={state.storyPlanning ? getFormFactorDefaultAspectRatio(state.storyPlanning.formFactor) : state.styleAspectRatio}
          scenes={state.scenes}
          currentTextLayout={state.textLayout || 'caption'}
          projectId={project.id}
          onTextLayoutChange={(textLayout) => updateState({ textLayout })}
          currentDialogueMode={state.dialogueMode || 'universal'}
          onDialogueModeChange={(dialogueMode) => updateState({ dialogueMode })}
          currentDialogueStyle={state.universalDialogueStyle || 'speech'}
          onDialogueStyleChange={(universalDialogueStyle) => updateState({ universalDialogueStyle })}
          onLayoutConfirmed={(layoutType, customLayoutPrompt, gridTemplateId) => {
            applyReset('confirming layout', (prev) => resetFromLayoutConfirm(prev, layoutType, customLayoutPrompt, gridTemplateId));
          }} />;
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
          project={project}
          onUpdateProject={onUpdate}
          projectId={project.id}
          projectName={project.name}
          panels={state.panels}
          state={state}
          onReturnToPreview={() => {
            updateState({ step: AppStep.COMBINED_PREVIEW });
          }}
          onUpdatePanel={(id, imageId, imageUrl) => {
            const newPanels = state.panels.map(p => p.id === id ? {
              ...p,
              imageId,
              imageUrl,
              imageIdHistory: [...(p.imageIdHistory || []), imageId],
              imageUrlHistory: [...(p.imageUrlHistory || []), imageUrl]
            } : p);
            const imageSignature = newPanels.map((panel) => panel.imageId || '').join('|');
            const autoKey = `review:${newPanels.length}:${imageSignature}`;
            const shouldAutoSnapshot = autoKey !== lastAutoVersionKeyRef.current;
            if (shouldAutoSnapshot) {
              lastAutoVersionKeyRef.current = autoKey;
            }
            updateState({
              panels: newPanels,
              ...(shouldAutoSnapshot ? {
                versions: appendVersion(
                  `Auto - Review Update (${new Date().toLocaleTimeString()})`,
                  { ...state, panels: newPanels },
                  'regen'
                )
              } : {})
            });
          }} />;
      default: return null;
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      <StepIndicator currentStep={state.step} maxStepReached={state.maxStepReached} onStepClick={goToStep} />
      <div className="p-4 border-b border-slate-200 bg-white/50 backdrop-blur-sm sticky top-24 z-30 flex items-center">
        <button onClick={onBack} className="flex items-center text-sm font-bold text-slate-500 hover:text-black transition-colors">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to Dashboard
        </button>
        <span className="mx-4 text-slate-300">|</span>
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
          className="font-display text-xl bg-transparent border-b-2 border-transparent focus:border-black outline-none"
        />
        {state.generationStatus?.isActive && (
          <div className="ml-auto flex items-center gap-2 px-3 py-1 bg-brand-yellow rounded-full border border-black text-xs font-bold mr-4">
            <div className="w-2 h-2 bg-black rounded-full animate-pulse" /> Building in background...
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
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
      <main className="p-6 max-w-7xl mx-auto w-full flex-1 space-y-4">
        {deploymentParity?.mismatch && (
          <div className="max-w-7xl mx-auto border-2 border-amber-500 bg-amber-50 rounded-lg p-3 text-xs font-bold text-amber-800">
            Deployment mismatch detected: frontend `{deploymentParity.frontendGitSha}` vs backend `{deploymentParity.backendGitSha}`.
            Some features may behave inconsistently until both deployments use the same commit.
          </div>
        )}
        {navError && (
          <div className="mx-4 mt-3 text-sm bg-amber-100 border-2 border-black rounded-lg p-2 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="flex-1">{navError}</span>
            <button onClick={() => setNavError(null)} className="font-bold text-slate-600 hover:text-black" aria-label="Dismiss">×</button>
          </div>
        )}
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
