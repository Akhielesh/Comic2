import React, { useEffect, useRef, useState } from 'react';
import { StepIndicator } from './StepIndicator';
import { ScriptInput } from './steps/ScriptInput';
import { StyleSelection } from './steps/StyleSelection';
import { CoverDesigner } from './steps/CoverDesigner';
import { ReferenceBuilder } from './steps/ReferenceBuilder';
import { LayoutSelector } from './steps/LayoutSelector';
import { ComicGenerator } from './ComicGenerator';
import { ComicStreamView } from './studio/comic/ComicStreamView';
import { AgentSettingsPanel } from './studio/comic/AgentSettingsPanel';
import { ReviewExport } from './steps/ReviewExport';
import { AppStep, Project } from '../types';
import { assignImageTags, collectStateImageEntries } from '../services/imageTags';
import {
  resetFromLayoutConfirm,
  resetFromScriptAnalysis,
  resetFromStyleConfirm,
  resetFromWorldConfirm
} from '../services/pipelineReset';
import { transitionAgentRun } from '../services/comicAgentRun';
import { ArrowLeft, Save, History, AlertTriangle, ImageIcon } from 'lucide-react';
import { VersionHistoryModal } from './modals/VersionHistoryModal';
import { ProjectVersion } from '../types';
import { analyzeScriptDetailed, checkDeploymentParity, DeploymentParityStatus } from '../services/geminiService';
import { confirmGateNeeded } from '../services/comicAgentSettings';
import { estimateComicCostUsd, planBeats } from '../services/beatPlanner';
import { getFormFactorDefaultAspectRatio } from '../services/storyPlanning';
import { TokenAvailabilityPill } from './TokenAvailabilityPill';
import { getSelectedImageModel, MODEL_SELECTION_CHANGED } from '../services/modelSelection';
import { getComicCost, BILLING_SUMMARY_REFRESH_EVENT } from '../services/billing';
import { DollarSign } from 'lucide-react';

// Always-visible "what has THIS comic cost so far" chip — real settled spend from the
// billing ledger, refreshed after every generation. Hover shows the per-stage split.
const ComicCostChip: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [totalUsd, setTotalUsd] = useState<number | null>(null);
  const [byStage, setByStage] = useState<Array<{ stage: string; usd: number }>>([]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const report = await getComicCost(projectId);
        if (!active) return;
        setTotalUsd(report.totalBillableUsd ?? 0);
        setByStage(
          Object.entries(report.byStage || {})
            .map(([stage, v]) => ({ stage, usd: v.usd }))
            .filter((s) => s.usd > 0)
            .sort((a, b) => b.usd - a.usd)
        );
      } catch {
        // Billing backend unavailable → hide rather than show a broken chip.
        if (active) setTotalUsd(null);
      }
    };
    void load();
    window.addEventListener(BILLING_SUMMARY_REFRESH_EVENT, load);
    return () => {
      active = false;
      window.removeEventListener(BILLING_SUMMARY_REFRESH_EVENT, load);
    };
  }, [projectId]);
  if (totalUsd === null) return null;
  return (
    <div className="relative group hidden md:block">
      <div className="flex items-center gap-1 rounded-full border-2 border-black bg-white px-2.5 py-1 text-[11px] font-bold text-slate-700 cursor-default" title="What this comic has cost so far">
        <DollarSign size={12} className="text-green-600" />
        <span className="tabular-nums">This comic: ${totalUsd.toFixed(2)}</span>
      </div>
      {byStage.length > 0 && (
        <div className="absolute right-0 mt-2 w-56 z-50 hidden group-hover:block">
          <div className="bg-white border-2 border-black rounded-xl shadow-comic p-3 text-left space-y-1">
            <div className="text-[10px] font-bold uppercase text-slate-500">Cost by stage</div>
            {byStage.map((s) => (
              <div key={s.stage} className="flex justify-between text-[11px] text-slate-600 tabular-nums">
                <span className="capitalize truncate">{s.stage.replace(/_/g, ' ')}</span>
                <span>${s.usd.toFixed(3)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// Always-visible chip showing the active image model, refreshed when the selection changes.
const ActiveImageModelChip: React.FC = () => {
  const [model, setModel] = useState<string>(() => getSelectedImageModel() || 'Auto (default)');
  useEffect(() => {
    const sync = () => setModel(getSelectedImageModel() || 'Auto (default)');
    window.addEventListener(MODEL_SELECTION_CHANGED, sync);
    window.addEventListener('focus', sync);
    return () => {
      window.removeEventListener(MODEL_SELECTION_CHANGED, sync);
      window.removeEventListener('focus', sync);
    };
  }, []);
  return (
    <div
      className="hidden lg:flex items-center gap-1 rounded-full border-2 border-black bg-white px-2.5 py-1 text-[11px] font-bold text-slate-700"
      title={`Active image model: ${model}`}
    >
      <ImageIcon size={12} className="text-brand-blue" />
      <span className="font-mono truncate max-w-[11rem]">{model}</span>
    </div>
  );
};

interface ComicEditorProps {
  project: Project;
  onUpdate: (updates: Partial<Project> | ((prev: Project) => Partial<Project>)) => void;
  onStartGeneration: (projectId: string) => void;
  onStopGeneration: (projectId: string) => void;
  onBack: () => void;
}

// The live step order. STORY_PLANNING and COMBINED_PREVIEW were removed from the flow
// (scene review is automatic; panel planning happens inside generation Phase 1) — their
// enum values stay reserved so saved projects keep parsing, and the remap effect below
// routes any legacy saved step onto this sequence.
const STEP_SEQUENCE: AppStep[] = [
  AppStep.SCRIPT_INPUT,
  AppStep.STYLE_SELECTION,
  AppStep.REFERENCE_BUILDER,
  AppStep.COVER,
  AppStep.LAYOUT_SELECTION,
  AppStep.FULL_GENERATION,
  AppStep.REVIEW_EXPORT
];

// Legacy saved steps → their nearest live equivalent. COMBINED_PREVIEW maps to LAYOUT
// (not straight into generation) so an old project never starts spending on load.
const LEGACY_STEP_REMAP: Partial<Record<AppStep, AppStep>> = {
  [AppStep.STORY_PLANNING]: AppStep.STYLE_SELECTION,
  [AppStep.COMBINED_PREVIEW]: AppStep.LAYOUT_SELECTION
};

export const ComicEditor: React.FC<ComicEditorProps> = ({ project, onUpdate, onStartGeneration, onStopGeneration, onBack }) => {
  const state = project.state;
  const [titleDraft, setTitleDraft] = useState(project.name);
  const [showVersions, setShowVersions] = useState(false);
  // v3 Agent Stream is now the DEFAULT centralized surface; the classic step wizard stays
  // available as "Detailed mode" (via the gear / settings escape hatch). Set
  // VITE_COMIC_AGENT_ENABLED=false to fall back to the wizard by default.
  const [viewMode, setViewMode] = useState<'stream' | 'detailed'>(
    import.meta.env.VITE_COMIC_AGENT_ENABLED === 'false' ? 'detailed' : 'stream',
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [streamAnalyzing, setStreamAnalyzing] = useState(false);
  const [pendingGate, setPendingGate] = useState<{ estimateUsd: number } | null>(null);

  // Approving the plan requests a build, but per the confirm policy we may pause with a
  // spend gate first (the spec's trust feature). This only gates the *start* — it never
  // touches the render loop.
  const requestBuild = () => {
    const estimateUsd = estimateComicCostUsd(planBeats(state.scenes || [], state.pageCount || 0, 3).totalPanels);
    if (confirmGateNeeded(state.agentSettings, estimateUsd)) {
      setPendingGate({ estimateUsd });
    } else {
      onStartGeneration(project.id);
    }
  };

  // Run script analysis directly from the stream's prompt bar so a comic starts end-to-end
  // inside the new surface (no bridge to Detailed mode). On success it reuses the same
  // reset path as the wizard, so scenes/world/continuity are populated identically.
  const runStreamAnalysis = async (text: string) => {
    const script = text.trim();
    if (!script || streamAnalyzing) return;
    setStreamAnalyzing(true);
    setNavError(null);
    try {
      const result = await analyzeScriptDetailed(script, project.id, undefined, (state.creativeDirection || '').trim() || undefined);
      if (result?.scenes?.length) {
        applyReset('analyze from stream', (prev) => resetFromScriptAnalysis(prev, script, result.scenes));
      } else {
        setNavError('Could not analyze that script — add a little more detail and try again.');
      }
    } catch {
      setNavError('Failed to analyze the script. Please try again.');
    } finally {
      setStreamAnalyzing(false);
    }
  };
  const [deploymentParity, setDeploymentParity] = useState<DeploymentParityStatus | null>(null);
  const [navError, setNavError] = useState<string | null>(null);
  const previousStepRef = useRef<AppStep>(state.step);
  const previousGenerationActiveRef = useRef<boolean>(!!state.generationStatus?.isActive);
  const lastAutoVersionKeyRef = useRef<string>('');

  const updateState = (updates: Partial<Project['state']> | ((prev: Project['state']) => Partial<Project['state']>)) => {
    onUpdate((prevProject) => {
      const patch = typeof updates === 'function' ? updates(prevProject.state) : updates;
      return {
        state: { ...prevProject.state, ...patch }
      };
    });
  };

  // Hard prerequisites for leaving a step — keeps the pipeline from advancing into a
  // state generation can't use (e.g. entering generation with no scenes).
  const advanceBlockReason = (s: Project['state']): string | null => {
    switch (s.step) {
      case AppStep.SCRIPT_INPUT:
        return (s.scenes?.length || 0) > 0 ? null : 'Start the comic agent first.';
      case AppStep.STYLE_SELECTION:
        return s.selectedStyleId || s.stylePrompt ? null : 'Choose a style direction first.';
      case AppStep.LAYOUT_SELECTION:
        return (s.scenes?.length || 0) > 0 ? null : 'Start the comic agent before building pages.';
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
    const idx = STEP_SEQUENCE.indexOf(state.step);
    const next = idx >= 0 && idx < STEP_SEQUENCE.length - 1 ? STEP_SEQUENCE[idx + 1] : state.step;
    if (next === state.step) return;
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

  // Route projects saved on a removed step (Story-Planning / Preview) onto the live flow.
  useEffect(() => {
    const remapped = LEGACY_STEP_REMAP[state.step as AppStep];
    if (remapped !== undefined) {
      updateState({ step: remapped, maxStepReached: Math.max(state.maxStepReached, remapped) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.step]);

  useEffect(() => {
    const status = state.generationStatus;
    // Only advance once something actually rendered: planned-but-imageless panels (a
    // failed/stalled run) must keep the user on the Build screen with its retry, not
    // dump them on an empty Review page.
    const hasRenderedPanels = state.panels.some((panel) => panel.imageUrl);
    const shouldAdvance = status && !status.isActive && hasRenderedPanels && state.step === AppStep.FULL_GENERATION;
    if (shouldAdvance) {
      updateState((prev) => ({
        step: AppStep.REVIEW_EXPORT,
        maxStepReached: Math.max(prev.maxStepReached, AppStep.REVIEW_EXPORT),
        agentRun: transitionAgentRun(
          { ...prev, panels: state.panels, step: AppStep.REVIEW_EXPORT },
          [
            {
              kind: 'build',
              status: 'done',
              summary: `${state.panels.filter((panel) => panel.imageUrl).length} rendered panel${state.panels.filter((panel) => panel.imageUrl).length === 1 ? '' : 's'} saved.`,
              progress: 100
            },
            { kind: 'export', status: 'active', summary: 'Ready to review, download, publish, or export.' }
          ],
          {
            kind: 'build',
            status: 'info',
            message: 'Build finished and moved to review.'
          }
        )
      }));
    }
  }, [state.generationStatus?.isActive, state.panels, state.step, state.maxStepReached]);

  useEffect(() => {
    const previousStep = previousStepRef.current;
    if (previousStep === state.step) return;

    let nextVersionName: string | null = null;
    let autoKey = '';

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
          initialCreativeDirection={state.creativeDirection}
          onCreativeDirectionChange={(creativeDirection) => updateState({ creativeDirection })}
          initialAgentSettings={state.agentSettings}
          onAgentSettingsChange={(agentSettings) => updateState({ agentSettings })}
          initialChecklist={state.scriptChecklist}
          onChecklistUpdate={(scriptChecklist) => updateState({ scriptChecklist })}
          onScenesGenerated={(script, scenes) => {
            applyReset('re-analyzing script', (prev) => resetFromScriptAnalysis(prev, script, scenes));
          }}
        />;
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
          agentSettings={state.agentSettings}
          customAspectRatioEnabled={state.customAspectRatioEnabled}
          customAspectRatio={state.customAspectRatio}
          onCustomAspectRatioChange={(enabled, ratio) => updateState({ customAspectRatioEnabled: enabled, customAspectRatio: ratio })}
          onStyleConfirmed={(style) => {
            // Re-confirming the SAME locked style must not nuke downstream work (world
            // reference art, cover, panels) — that reset is for actual style changes.
            if (style.id === state.selectedStyleId && state.styleLockStatus === 'resolved') {
              nextStep();
              return;
            }
            applyReset('confirming style', (prev) => resetFromStyleConfirm(prev, style));
          }} />;
      case AppStep.REFERENCE_BUILDER:
        return <ReferenceBuilder
          scenes={state.scenes}
          script={state.script}
          creativeDirection={state.creativeDirection}
          currentStyle={state.stylePrompt}
          styleImageId={state.styleImageId}
          projectId={project.id}
          initialCharacters={state.characters || []} // Ensure defaults
          initialItems={state.items || []}
          initialLocations={state.locations || []}
          initialContinuity={state.continuity}
          agentSettings={state.agentSettings}
          onDataUpdate={(data) => updateState({ ...data })}
          onConfirm={() => applyReset('confirming characters', (prev) => resetFromWorldConfirm(prev))} />;
      case AppStep.COVER:
        return (
          <CoverDesigner
            state={state}
            projectId={project.id}
            projectName={project.name}
            agentSettings={state.agentSettings}
            onUpdate={(updates) => updateState(updates)}
            onConfirm={() => {
              updateState((prev) => ({
                step: AppStep.LAYOUT_SELECTION,
                maxStepReached: Math.max(prev.maxStepReached, AppStep.LAYOUT_SELECTION),
                agentRun: transitionAgentRun(
                  prev,
                  [
                    {
                      kind: 'cover',
                      status: 'done',
                      summary: prev.coverImageId || prev.coverImageUrl ? 'Cover image is ready.' : 'Cover step confirmed.',
                      progress: 100
                    },
                    { kind: 'layout', status: 'active', summary: 'Ready to choose pages, panel density, and outputs.' }
                  ],
                  {
                    kind: 'cover',
                    status: 'info',
                    message: 'Confirmed the cover direction.'
                  }
                )
              }));
            }}
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
          currentPageCount={state.pageCount}
          agentSettings={state.agentSettings}
          pricingConfig={state.pricingConfig}
          onLayoutConfirmed={(layoutType, customLayoutPrompt, gridTemplateId, pageCount) => {
            applyReset('confirming layout', (prev) => resetFromLayoutConfirm(prev, layoutType, customLayoutPrompt, gridTemplateId, pageCount));
          }} />;
      case AppStep.FULL_GENERATION:
        return <ComicGenerator
          state={state}
          onStart={() => onStartGeneration(project.id)}
          onCancel={() => onStopGeneration(project.id)}
          onGenerationComplete={(panels) => {
            updateState((prev) => ({
              panels,
              step: AppStep.REVIEW_EXPORT,
              maxStepReached: Math.max(prev.maxStepReached, AppStep.REVIEW_EXPORT),
              agentRun: transitionAgentRun(
                { ...prev, panels, step: AppStep.REVIEW_EXPORT },
                [
                  {
                    kind: 'build',
                    status: 'done',
                    summary: `${panels.filter((panel) => panel.imageUrl).length} rendered panel${panels.filter((panel) => panel.imageUrl).length === 1 ? '' : 's'} saved.`,
                    progress: 100
                  },
                  { kind: 'export', status: 'active', summary: 'Ready to review, download, publish, or export.' }
                ],
                {
                  kind: 'build',
                  status: 'info',
                  message: 'Build finished and moved to review.'
                }
              )
            }));
          }}
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
            // The manual preview stage is gone — re-planning starts from Layout.
            updateState({ step: AppStep.LAYOUT_SELECTION });
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

  if (viewMode === 'stream') {
    return (
      <div className="h-screen">
        <ComicStreamView
          state={state}
          projectTitle={project.name}
          analyzing={streamAnalyzing}
          pendingGate={pendingGate}
          onConfirmGate={() => { setPendingGate(null); onStartGeneration(project.id); }}
          onCancelGate={() => setPendingGate(null)}
          onBack={onBack}
          onOpenSettings={() => setSettingsOpen(true)}
          onSend={(text) => {
            // No scenes yet → analyze the script right here (the comic starts in the stream).
            // Once scenes exist, a typed note becomes creative direction for the next run.
            if ((state.scenes?.length || 0) === 0) {
              void runStreamAnalysis(text);
            } else {
              updateState({ creativeDirection: text });
            }
          }}
          handlers={{
            onApprovePlan: () => requestBuild(),
            onSelectStyle: (id) => updateState({ selectedStyleId: id }),
            onMoreStyles: () => { setViewMode('detailed'); goToStep(AppStep.STYLE_SELECTION); },
            onEditEntity: () => { setViewMode('detailed'); goToStep(AppStep.REFERENCE_BUILDER); },
            onSelectCover: () => { setViewMode('detailed'); goToStep(AppStep.COVER); },
            onAdjust: () => setViewMode('detailed'),
            onRead: () => { setViewMode('detailed'); goToStep(AppStep.REVIEW_EXPORT); },
            onExport: () => { setViewMode('detailed'); goToStep(AppStep.REVIEW_EXPORT); },
            onPublish: () => { setViewMode('detailed'); goToStep(AppStep.REVIEW_EXPORT); },
          }}
        />
        <AgentSettingsPanel
          open={settingsOpen}
          settings={state.agentSettings}
          onChange={(next) => updateState({ agentSettings: next })}
          onClose={() => setSettingsOpen(false)}
          onOpenDetailed={() => { setSettingsOpen(false); setViewMode('detailed'); }}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <StepIndicator currentStep={state.step} maxStepReached={state.maxStepReached} onStepClick={goToStep} />
      <div className="py-1.5 px-4 border-b border-slate-200 bg-white/60 backdrop-blur-sm sticky top-[50px] z-30 flex items-center gap-3">
        <button onClick={onBack} title="Back to Dashboard" className="flex items-center shrink-0 text-xs font-bold text-slate-500 hover:text-black transition-colors">
          <ArrowLeft className="w-4 h-4 sm:mr-1" /> <span className="hidden sm:inline">Dashboard</span>
        </button>
        <span className="text-slate-300 shrink-0">|</span>
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
          className="font-display text-lg bg-transparent border-b-2 border-transparent focus:border-black outline-none min-w-0 flex-1 sm:max-w-[16rem] truncate"
        />

        {state.generationStatus?.isActive && (
          <div className="hidden sm:flex items-center gap-2 px-2.5 py-1 bg-brand-yellow rounded-full border border-black text-[11px] font-bold shrink-0">
            <div className="w-2 h-2 bg-black rounded-full animate-pulse" /> Building…
          </div>
        )}

        {/* Active model + usage/limit, surfaced on the studio page */}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <button
            onClick={() => setViewMode('stream')}
            className="px-2.5 py-1 text-[11px] font-bold rounded-full border-2 border-black bg-brand-yellow hover:-translate-y-px transition-transform shrink-0"
            title="Switch to the new Agent Stream view"
          >
            ✨ Stream view
          </button>
          <ComicCostChip projectId={project.id} />
          <ActiveImageModelChip />
          <TokenAvailabilityPill />
          <button
            onClick={saveVersion}
            className="p-1.5 hover:bg-slate-100 rounded-full text-slate-600 hover:text-black transition-colors"
            title="Save Version Snapshot"
          >
            <Save size={18} />
          </button>
          <button
            onClick={() => setShowVersions(true)}
            className="p-1.5 hover:bg-slate-100 rounded-full text-slate-600 hover:text-black transition-colors relative"
            title="Version History"
          >
            <History size={18} />
            {(state.versions?.length || 0) > 0 && (
              <span className="absolute top-0.5 right-0.5 w-2 h-2 bg-brand-blue rounded-full" />
            )}
          </button>
        </div>
      </div>
      <main className="p-3 sm:p-6 max-w-7xl mx-auto w-full flex-1 space-y-4">
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
