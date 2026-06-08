import React, { useEffect, useMemo, useState } from 'react';
import { Play, Coins, AlertCircle, RefreshCw } from 'lucide-react';
import { AppStep, ComicPanel, ComicState, DialogueBlock, TextLayout } from '../../types';
import { generatePanelBreakdown } from '../../services/geminiService';
import { Button } from '../Button';
import { ensureDialogueBlocks, normalizePanelDialogue } from '../../services/dialogueUtils';
import { buildDefaultContinuityState, resolvePanelContinuity, validateContinuityState } from '../../services/continuity';
import { hasDownstreamDrift } from '../../services/pipelineFingerprint';
import {
  DEFAULT_PRICING_CONFIG,
  normalizePricingConfig,
  PRICING_AS_OF
} from '../../services/pricingConfig';
import { estimateUsd, fromLegacyPer1k } from '../../shared/pricing';
import { estimateTokensFromTextInput } from '../../services/reporting';
import { IMAGE_MODEL, TEXT_MODEL } from '../../services/modelPolicy';
import { getImageProvider } from '../../services/appSettings';
import { getImageModelByProvider } from '../../services/imageModels';
import { getGridTemplate } from '../../services/panelLayout';
import { loadArtifactsForProject } from '../../services/db';
import { buildProjectReport } from '../../services/reporting';
import { ApiError } from '../../services/apiClient';
import { LimitExceededModal } from '../modals/LimitExceededModal';
import { applyStyleLockResolution, resolveStyleLock } from '../../services/styleLock';
import { hasMultiFrameLanguage, sanitizePanelDescription } from '../../services/panelDescription';
import { buildCostViewModel } from '../../services/costViewModel';

interface CombinedPreviewProps {
  state: ComicState;
  projectId: string;
  onConfirm: () => void;
  onStateUpdate: (updates: Partial<ComicState>) => void;
}

const computePanelPlanVersion = (scenes: ComicState['scenes']) => {
  return scenes.reduce((acc, scene) => acc + scene.synopsis.length + scene.setting.length + scene.characters.join('|').length, 0) + scenes.length;
};

// Turn a raw planning error into a short, actionable message for the banner. Timeouts are
// the common case (the text model takes >60s on a complex scene) and have a specific fix.
const friendlyPlanError = (error: unknown): string => {
  const msg = (error instanceof Error ? error.message : String(error || '')).trim();
  if (!msg) return 'Panel planning failed. Please try again.';
  if (/timed out|took too long|timeout/i.test(msg)) {
    return 'Panel planning timed out — the text model took too long. Try again, or switch to a faster text model in Settings.';
  }
  if (/no image|image output/i.test(msg)) return msg;
  if (/network|couldn.?t reach|failed to fetch/i.test(msg)) {
    return 'Couldn\'t reach the AI server. Check your connection and try again.';
  }
  return `Couldn't plan panels: ${msg}`;
};

const normalizePanel = (panel: ComicPanel): ComicPanel => {
  const base = {
    ...panel,
    prompt: panel.prompt || panel.description || '',
    description: panel.description || panel.prompt || '',
    isPlanned: panel.isPlanned ?? true
  };
  return normalizePanelDialogue(base);
};

const PanelWireframe: React.FC<{ panel: ComicPanel; textLayout: TextLayout }> = ({ panel, textLayout }) => {
  const blocks = ensureDialogueBlocks(panel.dialogue, panel.dialogueBlocks, panel.description);
  return (
    <div className="relative border-2 border-black rounded-lg bg-white p-3 min-h-[140px]">
      <div className="text-[10px] font-mono text-slate-500 mb-2">Prompt</div>
      <div className="text-xs font-comic text-slate-700">{panel.description}</div>
      {textLayout !== 'none' && blocks.length > 0 && (
        <div className="mt-2 space-y-1">
          {blocks.map((block) => (
            <div
              key={block.id}
              className={`text-[10px] border border-black rounded px-2 py-1 ${textLayout === 'chat_bubbles'
                  ? block.side === 'right'
                    ? 'bg-brand-blue text-white ml-auto'
                    : 'bg-brand-yellow text-black'
                  : 'bg-white text-black'
                }`}
            >
              <strong className="mr-1">{block.speaker || block.kind}:</strong> {block.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const CombinedPreview: React.FC<CombinedPreviewProps> = ({ state, projectId, onConfirm, onStateUpdate }) => {
  // Panel count is owned by the Layout stage (state.gridTemplateId / state.layoutType).
  // Source of truth: getGridTemplate(...).panelCount; fallback when no template is chosen.
  const PANEL_COUNT_FALLBACK = 3;
  const layoutPanelCount = useMemo(() => {
    const template = getGridTemplate(state.gridTemplateId);
    if (template) return Math.min(9, Math.max(1, template.panelCount));
    return PANEL_COUNT_FALLBACK;
  }, [state.gridTemplateId]);
  const [isPlanning, setIsPlanning] = useState(false);
  const [planningSceneId, setPlanningSceneId] = useState<number | null>(null);
  const [costSummary, setCostSummary] = useState<{ accrued: number; projectedRemaining: number; totalProjected: number; estimated: boolean }>({
    accrued: 0,
    projectedRemaining: 0,
    totalProjected: 0,
    estimated: true
  });
  const [limitDetails, setLimitDetails] = useState<Record<string, unknown> | null>(null);
  // Non-billing planning failures (timeouts, 500s, network) used to fail silently —
  // the spinner stopped and nothing appeared. Surface them so the user can retry.
  // sceneId remembers which scene to re-run (null = "Generate All Plans").
  const [planError, setPlanError] = useState<{ message: string; sceneId: number | null } | null>(null);
  const pricing = useMemo(() => normalizePricingConfig(state.pricingConfig || DEFAULT_PRICING_CONFIG), [state.pricingConfig]);
  const plannedPanelCount = state.panels.length;
  const estimatedTokens = useMemo(() => {
    return state.panels.reduce(
      (sum, panel) =>
        sum +
        estimateTokensFromTextInput(panel.description || '') +
        estimateTokensFromTextInput(panel.dialogue || ''),
      0
    );
  }, [state.panels]);

  // Cost estimates come from the live pricingConfig (which buildProjectReport also uses)
  // routed through shared/pricing.ts. We split tokens roughly 1:3 input:output for a
  // generation pass — the council/reconciliation check will tighten this with real ratios.
  const provider = getImageProvider();
  const activeImageModel = getImageModelByProvider(provider);
  const inputTokenSplit = Math.round(estimatedTokens * 0.25);
  const outputTokenSplit = estimatedTokens - inputTokenSplit;
  const estimateForModel = (modelKey: string, imageCount = 0): number => {
    const legacy = pricing.models[modelKey];
    if (!legacy) return 0;
    return estimateUsd({
      pricing: fromLegacyPer1k(legacy),
      inputTokens: inputTokenSplit,
      outputTokens: outputTokenSplit,
      imageCount
    });
  };
  const textCostLite = estimateForModel('gemini-2.5-flash-lite');
  const textCostFlash = estimateForModel('gemini-2.5-flash');
  const imageCostCurrent = provider === 'flux'
    ? 0
    : estimateForModel(IMAGE_MODEL, plannedPanelCount) - estimateForModel(IMAGE_MODEL, 0);
  const imageCostBatch = imageCostCurrent / 2; // OpenRouter batch tier — half price (existing convention).
  const imageCostBananaPro = (() => {
    const legacy = pricing.models['gemini-3-pro-image-preview'];
    if (!legacy) return 0;
    return (legacy.imagePerOutput || 0) * plannedPanelCount;
  })();
  const estimatedCt = Math.ceil(costSummary.totalProjected / 0.0001);
  // True when the script/scenes/world were edited AFTER the panels were planned — generating
  // now would bake stale references into the comic (a quiet but common corruption).
  const downstreamDrift = useMemo(() => hasDownstreamDrift(state), [state]);
  const continuityValidation = useMemo(
    () => validateContinuityState(state),
    [state]
  );
  const styleLockResolution = useMemo(
    () => resolveStyleLock(state),
    [state.selectedStyleId, state.styleVariants]
  );
  const multiFramePanels = useMemo(
    () => state.panels.filter((panel) => hasMultiFrameLanguage(panel.description || panel.prompt || "")),
    [state.panels]
  );

  useEffect(() => {
    const expectedEntityCount = (state.characters?.length || 0) + (state.items?.length || 0) + (state.locations?.length || 0);
    const needsBibleRefresh =
      !state.continuity ||
      state.continuity.bible.entities.length !== expectedEntityCount ||
      state.continuity.bible.sceneBindings.length !== (state.scenes?.length || 0);

    if (needsBibleRefresh) {
      onStateUpdate({ continuity: buildDefaultContinuityState(state) });
      return;
    }
    const currentValidation = state.continuity.validation;
    const hasChanged =
      !currentValidation ||
      currentValidation.isValid !== continuityValidation.isValid ||
      currentValidation.issues.length !== continuityValidation.issues.length;
    if (hasChanged) {
      onStateUpdate({
        continuity: {
          ...state.continuity,
          lockLevel: 'strict',
          fallbackPolicy: 'auto',
          validation: continuityValidation
        }
      });
    }
  }, [state, state.continuity, continuityValidation, onStateUpdate]);

  useEffect(() => {
    const legacyPricing = !state.pricingConfig ||
      (state.pricingConfig.models?.[TEXT_MODEL]?.inputPer1k ?? 0) === 0 ||
      (state.pricingConfig.models?.[IMAGE_MODEL]?.imagePerOutput ?? 0) === 0;
    if (legacyPricing) {
      onStateUpdate({ pricingConfig: pricing });
    }
  }, [state.pricingConfig, pricing, onStateUpdate]);

  useEffect(() => {
    const version = computePanelPlanVersion(state.scenes);
    if (!state.panelPlanVersion && state.panels.length === 0) {
      onStateUpdate({ panelPlanVersion: version });
    }
  }, [state.scenes, state.panelPlanVersion, state.panels.length, onStateUpdate]);

  useEffect(() => {
    const computeCost = async () => {
      try {
        const artifacts = await loadArtifactsForProject(projectId);
        const report = await buildProjectReport(
          {
            id: projectId,
            name: 'preview',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            state: state
          },
          artifacts,
          {},
          pricing
        );
        const pendingPanelCount = state.panels.filter((panel) => !panel.imageId).length;
        const model = buildCostViewModel({
          accruedUsd: (report.cost_summary as any).totalCost,
          estimatedTokens,
          pendingPanelCount,
          pricingConfig: pricing
        });
        setCostSummary({
          accrued: model.accruedUsd,
          projectedRemaining: model.projectedRemainingUsd,
          totalProjected: model.totalProjectedUsd,
          estimated: true
        });
      } catch {
        setCostSummary({ accrued: 0, projectedRemaining: 0, totalProjected: 0, estimated: true });
      }
    };
    computeCost();
  }, [projectId, plannedPanelCount, pricing, state, estimatedTokens]);

  const generatePlanForScene = async (sceneId: number) => {
    const scene = state.scenes.find(s => s.id === sceneId);
    if (!scene) return;
    setIsPlanning(true);
    setPlanningSceneId(sceneId);
    setPlanError(null);
    try {
      const count = layoutPanelCount;
      const result = await generatePanelBreakdown(scene, state.stylePrompt, state.layoutType, projectId, count, {
        stage: 'preview',
        creativeDirection: state.creativeDirection,
        continuityBible: state.continuity?.bible,
        sceneBindings: state.continuity?.bible.sceneBindings,
        previousPanelContext: state.panels
          .filter((panel) => panel.sceneId === sceneId)
          .slice(-2)
          .map((panel) => ({
            panelId: panel.id,
            sceneId: panel.sceneId,
            description: panel.description,
            dialogue: panel.dialogue
          }))
      });
      const newPanels = result.map((panel, index) => ({
        ...(() => {
          const sanitized = sanitizePanelDescription(panel.description);
          return {
            description: sanitized.text,
            prompt: sanitized.text
          };
        })(),
        id: `s${scene.id}-p${index}-${Date.now()}`,
        sceneId: scene.id,
        dialogue: panel.dialogue || '',
        dialogueBlocks: panel.dialogueBlocks,
        imageIdHistory: [],
        imageUrlHistory: [],
        isPlanned: true,
        continuity: {
          requiredEntityIds: panel.requiredEntityIds || [],
          locationId: panel.locationId,
          continuityNotes: panel.continuityNotes,
          referenceImageIds: [],
          flaggedIssues: []
        }
      } as ComicPanel));

      const merged = [
        ...state.panels.filter(p => p.sceneId !== scene.id),
        ...newPanels
      ].map((panel) => {
        const normalized = normalizePanel(panel);
        return {
          ...normalized,
          continuity: resolvePanelContinuity(state, normalized)
        };
      });

      onStateUpdate({ panels: merged, panelPlanVersion: computePanelPlanVersion(state.scenes) });
    } catch (e) {
      console.error(e);
      const details = extractLimitDetails(e);
      if (details) setLimitDetails(details);
      else setPlanError({ message: friendlyPlanError(e), sceneId });
    } finally {
      setIsPlanning(false);
      setPlanningSceneId(null);
    }
  };

  const generateAllPlans = async () => {
    setIsPlanning(true);
    setPlanError(null);
    try {
      const allPanels: ComicPanel[] = [];
      for (const scene of state.scenes) {
        const count = layoutPanelCount;
        const result = await generatePanelBreakdown(scene, state.stylePrompt, state.layoutType, projectId, count, {
          stage: 'preview',
          creativeDirection: state.creativeDirection,
          continuityBible: state.continuity?.bible,
          sceneBindings: state.continuity?.bible.sceneBindings,
          previousPanelContext: allPanels
            .slice(-2)
            .map((panel) => ({
              panelId: panel.id,
              sceneId: panel.sceneId,
              description: panel.description,
              dialogue: panel.dialogue
            }))
        });
        result.forEach((panel, index) => {
          const sanitized = sanitizePanelDescription(panel.description);
          allPanels.push(normalizePanel({
            id: `s${scene.id}-p${index}-${Date.now()}`,
            sceneId: scene.id,
            description: sanitized.text,
            prompt: sanitized.text,
            dialogue: panel.dialogue || '',
            dialogueBlocks: panel.dialogueBlocks,
            imageIdHistory: [],
            imageUrlHistory: [],
            isPlanned: true,
            continuity: {
              requiredEntityIds: panel.requiredEntityIds || [],
              locationId: panel.locationId,
              continuityNotes: panel.continuityNotes,
              referenceImageIds: [],
              flaggedIssues: []
            }
          } as ComicPanel));
        });
      }
      const normalizedPanels = allPanels.map((panel) => ({
        ...panel,
        continuity: resolvePanelContinuity(state, panel)
      }));
      onStateUpdate({ panels: normalizedPanels, panelPlanVersion: computePanelPlanVersion(state.scenes) });
    } catch (e) {
      console.error(e);
      const details = extractLimitDetails(e);
      if (details) setLimitDetails(details);
      else setPlanError({ message: friendlyPlanError(e), sceneId: null });
    } finally {
      setIsPlanning(false);
    }
  };

  const updatePanel = (panelId: string, updates: Partial<ComicPanel>) => {
    const updated = state.panels.map(panel => {
      if (panel.id !== panelId) return panel;
      const mergedInput: ComicPanel = { ...panel, ...updates };
      if (typeof mergedInput.description === 'string') {
        const sanitized = sanitizePanelDescription(mergedInput.description);
        mergedInput.description = sanitized.text;
        mergedInput.prompt = sanitized.text;
      }
      const merged = normalizePanel(mergedInput);
      const continuity = resolvePanelContinuity(state, merged);
      const next = { ...merged, continuity };
      return next;
    });
    onStateUpdate({ panels: updated });
  };

  const addDialogueBlock = (panelId: string) => {
    const panel = state.panels.find(p => p.id === panelId);
    if (!panel) return;
    const blocks = ensureDialogueBlocks(panel.dialogue, panel.dialogueBlocks, panel.description);
    const nextBlocks: DialogueBlock[] = [
      ...blocks,
      { id: crypto.randomUUID(), kind: 'speech', text: '', side: 'left' }
    ];
    updatePanel(panelId, { dialogueBlocks: nextBlocks, dialogue: nextBlocks.map(b => b.text).join(' ') });
  };

  const removeDialogueBlock = (panelId: string, blockId: string) => {
    const panel = state.panels.find(p => p.id === panelId);
    if (!panel) return;
    const blocks = ensureDialogueBlocks(panel.dialogue, panel.dialogueBlocks, panel.description).filter(b => b.id !== blockId);
    updatePanel(panelId, { dialogueBlocks: blocks, dialogue: blocks.map(b => b.text).join(' ') });
  };

  const updateDialogueBlock = (panelId: string, blockId: string, updates: Partial<DialogueBlock>) => {
    const panel = state.panels.find(p => p.id === panelId);
    if (!panel) return;
    const blocks = ensureDialogueBlocks(panel.dialogue, panel.dialogueBlocks, panel.description)
      .map(block => block.id === blockId ? { ...block, ...updates } : block);
    updatePanel(panelId, { dialogueBlocks: blocks, dialogue: blocks.map(b => b.text).join(' ') });
  };

  const handleTextLayoutChange = (layout: TextLayout) => {
    onStateUpdate({ textLayout: layout });
  };

  const extractLimitDetails = (error: unknown): Record<string, unknown> | null => {
    if (!(error instanceof ApiError)) return null;
    const details = error.details as Record<string, unknown> | undefined;
    if (!details) return null;
    if (typeof details.reason === 'string' && typeof details.requiredCt === 'number') return details;
    if (details.details && typeof details.details === 'object') return details.details as Record<string, unknown>;
    return null;
  };

  const handleStartGeneration = () => {
    const styleApplied = applyStyleLockResolution(state);
    const sanitizedPanels = styleApplied.state.panels.map((panel) => {
      const sanitized = sanitizePanelDescription(panel.description || panel.prompt || '');
      return {
        ...panel,
        description: sanitized.text || panel.description,
        prompt: sanitized.text || panel.prompt
      };
    });
    const hasRemainingMultiFrame = sanitizedPanels.some((panel) =>
      hasMultiFrameLanguage(panel.description || panel.prompt || "")
    );
    const validation = validateContinuityState({
      ...styleApplied.state,
      panels: sanitizedPanels
    });

    onStateUpdate({
      selectedStyleId: styleApplied.state.selectedStyleId,
      stylePrompt: styleApplied.state.stylePrompt,
      styleImageId: styleApplied.state.styleImageId,
      styleImageUrl: styleApplied.state.styleImageUrl,
      styleCategory: styleApplied.state.styleCategory,
      styleAspectRatio: styleApplied.state.styleAspectRatio,
      imageResolution: styleApplied.state.imageResolution,
      styleLockStatus: styleApplied.state.styleLockStatus,
      styleLockResolvedAt: styleApplied.state.styleLockResolvedAt,
      panels: sanitizedPanels,
      continuity: styleApplied.state.continuity
        ? {
          ...styleApplied.state.continuity,
          lockLevel: 'strict',
          fallbackPolicy: 'auto',
          validation
        }
        : buildDefaultContinuityState(styleApplied.state)
    });
    if (!styleApplied.resolution.resolved) return;
    if (hasRemainingMultiFrame) return;
    if (styleApplied.state.continuity?.lockLevel === 'strict' || !styleApplied.state.continuity) {
      if (!validation.isValid) return;
    }
    onConfirm();
  };

  const formatCurrency = (value: number) => `${pricing.currency} ${value.toFixed(4)}`;

  return (
    <div className="max-w-6xl mx-auto space-y-6 animate-fade-in">
      <div className="bg-white rounded-xl border-4 border-black shadow-comic p-6">
        <div className="flex flex-col md:flex-row justify-between items-start gap-4">
          <div>
            <h2 className="text-4xl font-display text-black">Panel Plan</h2>
            <p className="text-slate-600 font-comic">Review every panel before we draw. Edit prompts, dialogue, and layout.</p>
            <div className="flex items-center gap-2 mt-1 text-xs font-mono text-slate-500">
              <span className="inline-block w-2 h-2 rounded-full bg-brand-blue" />
              <span className="font-bold text-slate-600">Active Model:</span> {activeImageModel?.label || provider}
              <span className="text-slate-300">·</span>
              <span>{plannedPanelCount} panels planned</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={generateAllPlans} isLoading={isPlanning} icon={<RefreshCw className="w-4 h-4" />}>Generate All Plans</Button>
            <Button
              onClick={handleStartGeneration}
              className="bg-brand-yellow"
              icon={<Play fill="currentColor" />}
              disabled={
                (state.continuity?.lockLevel === 'strict' && !continuityValidation.isValid) ||
                !styleLockResolution.resolved ||
                multiFramePanels.length > 0
              }
            >
              Start Generation
            </Button>
          </div>
        </div>
        {planError && (
          <div className="mt-4 rounded-lg border-2 border-red-300 bg-red-50 p-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-sm font-bold text-red-700">Panel planning failed.</div>
              <div className="text-xs text-red-700 mt-1">{planError.message}</div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => (planError.sceneId != null ? generatePlanForScene(planError.sceneId) : generateAllPlans())}
                  disabled={isPlanning}
                  className="text-xs font-bold border border-red-400 text-red-700 bg-white rounded px-2 py-1 hover:bg-red-100 disabled:opacity-50"
                >
                  Retry
                </button>
                <button
                  onClick={() => setPlanError(null)}
                  className="text-xs font-bold border border-red-300 text-red-600 bg-white rounded px-2 py-1 hover:bg-red-100"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        )}
        {!styleLockResolution.resolved && (
          <div className="mt-4 rounded-lg border-2 border-amber-400 bg-amber-50 p-3">
            <div className="text-sm font-bold text-amber-800">Style lock is unresolved.</div>
            <div className="text-xs text-amber-700 mt-1">
              Select or regenerate a style variant with a valid style reference image before starting generation.
            </div>
            <div className="mt-2">
              <button
                onClick={() => onStateUpdate({ step: AppStep.STYLE_SELECTION })}
                className="text-xs font-bold border border-amber-500 text-amber-800 bg-white rounded px-2 py-1 hover:bg-amber-100"
              >
                Fix In Style Stage
              </button>
            </div>
          </div>
        )}
        {downstreamDrift && plannedPanelCount > 0 && (
          <div className="mt-4 rounded-lg border-2 border-amber-400 bg-amber-50 p-3">
            <div className="text-sm font-bold text-amber-800">Your script or world changed after these panels were planned.</div>
            <div className="text-xs text-amber-700 mt-1">
              Generating now can bake in stale character names or references. Re-plan the panels so they match your latest edits.
            </div>
            <div className="mt-2">
              <button
                onClick={generateAllPlans}
                disabled={isPlanning}
                className="text-xs font-bold border border-amber-500 text-amber-800 bg-white rounded px-2 py-1 hover:bg-amber-100 disabled:opacity-50"
              >
                Re-plan All Panels
              </button>
            </div>
          </div>
        )}
        {multiFramePanels.length > 0 && (
          <div className="mt-4 rounded-lg border-2 border-orange-300 bg-orange-50 p-3">
            <div className="text-sm font-bold text-orange-800">Multi-frame panel descriptions detected.</div>
            <div className="text-xs text-orange-700 mt-1">
              Remove split-panel/montage language before generation. Detected in {multiFramePanels.length} panel{multiFramePanels.length === 1 ? '' : 's'}.
            </div>
          </div>
        )}
        {!continuityValidation.isValid && (() => {
          const refIssues = continuityValidation.issues.filter(
            (issue) => issue.code === 'ENTITY_REFERENCE_MISSING' || issue.code === 'ENTITY_NOT_FOUND'
          );
          const missingRefCount = refIssues.length;
          return (
            <div className="mt-4 rounded-lg border-2 border-red-300 bg-red-50 p-3">
              <div className="text-sm font-bold text-red-700">
                {missingRefCount > 0
                  ? `${missingRefCount} character/item${missingRefCount === 1 ? '' : 's'} need a reference image before generating.`
                  : 'Continuity lock is blocking generation.'}
              </div>
              <div className="text-xs text-red-700 mt-1">
                {missingRefCount > 0
                  ? 'In strict mode, generation stops on any subject without a reference image (the #1 reason a comic fails). Generate their reference art in the World stage, then come back.'
                  : 'Resolve required references or scene bindings first.'}
              </div>
              <div className="mt-2">
                <button
                  onClick={() => onStateUpdate({ step: AppStep.REFERENCE_BUILDER })}
                  className="text-xs font-bold border border-red-400 text-red-700 bg-white rounded px-2 py-1 hover:bg-red-100"
                >
                  Fix In World Builder
                </button>
              </div>
              <ul className="mt-2 space-y-1 text-xs text-red-700 list-disc pl-5">
                {continuityValidation.issues.slice(0, 5).map((issue, index) => (
                  <li key={`${issue.code}-${index}`}>{issue.message}</li>
                ))}
              </ul>
            </div>
          );
        })()}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {state.scenes.map((scene) => {
            const scenePanels = state.panels.filter(panel => panel.sceneId === scene.id);
            return (
              <div key={scene.id} className="bg-white rounded-xl border-4 border-black shadow-comic overflow-hidden">
                <div className="p-4 border-b-4 border-black bg-slate-100 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                  <div>
                    <div className="font-display text-xl">Scene {scene.id}</div>
                    <div className="text-xs text-slate-600 font-comic">{scene.synopsis}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div
                      className="flex items-center gap-2 bg-white border-2 border-black rounded px-2 py-1 text-xs font-bold"
                      title="Panel count is set in the Layout stage. Go back to Layout to change it."
                    >
                      <span>{layoutPanelCount} Panels</span>
                      <span className="text-[10px] text-slate-500 font-comic font-normal">from layout</span>
                    </div>
                    <Button
                      variant="secondary"
                      onClick={() => generatePlanForScene(scene.id)}
                      isLoading={isPlanning && planningSceneId === scene.id}
                      icon={<RefreshCw className="w-4 h-4" />}
                    >
                      Regenerate
                    </Button>
                  </div>
                </div>
                <div className="p-4 space-y-4">
                  {scenePanels.length === 0 && (
                    <div className="text-sm text-slate-500 font-comic">No plan yet — click Regenerate to create panel prompts.</div>
                  )}
                  {scenePanels.map((panel, idx) => (
                    <div key={panel.id} className="border-2 border-black rounded-lg p-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
                      <div className="space-y-3">
                        <div className="text-xs font-bold text-slate-500">Panel {idx + 1}</div>
                        {(panel.continuity?.requiredEntityIds?.length || 0) > 0 && (
                          <div className="text-[11px] text-slate-600">
                            Required: {panel.continuity?.requiredEntityIds
                              ?.map((entityId) => state.continuity?.bible.entities.find((entity) => entity.id === entityId)?.name || entityId)
                              .join(', ')}
                          </div>
                        )}
                        <textarea
                          value={panel.description}
                          onChange={(e) => updatePanel(panel.id, { description: e.target.value, prompt: e.target.value })}
                          className="w-full border-2 border-black rounded p-2 text-sm font-mono min-h-[80px]"
                          placeholder="Image prompt / visual description"
                        />
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <div className="text-xs font-bold text-slate-500">Dialogue Blocks</div>
                            <button
                              onClick={() => addDialogueBlock(panel.id)}
                              className="text-xs font-bold border-2 border-black rounded px-2 py-1"
                            >
                              + Add
                            </button>
                          </div>
                          {ensureDialogueBlocks(panel.dialogue, panel.dialogueBlocks, panel.description).map((block) => (
                            <div key={block.id} className="border-2 border-black rounded p-2 space-y-2">
                              <div className="flex flex-wrap gap-2">
                                <select
                                  value={block.kind}
                                  onChange={(e) => updateDialogueBlock(panel.id, block.id, { kind: e.target.value as DialogueBlock['kind'] })}
                                  className="border-2 border-black rounded px-2 py-1 text-xs"
                                >
                                  <option value="speech">Speech</option>
                                  <option value="caption">Caption</option>
                                  <option value="narration">Narration</option>
                                </select>
                                <select
                                  value={block.side || 'left'}
                                  onChange={(e) => updateDialogueBlock(panel.id, block.id, { side: e.target.value as DialogueBlock['side'] })}
                                  className="border-2 border-black rounded px-2 py-1 text-xs"
                                >
                                  <option value="left">Left</option>
                                  <option value="right">Right</option>
                                  <option value="center">Center</option>
                                </select>
                                <input
                                  value={block.speaker || ''}
                                  onChange={(e) => updateDialogueBlock(panel.id, block.id, { speaker: e.target.value })}
                                  placeholder="Speaker"
                                  className="border-2 border-black rounded px-2 py-1 text-xs flex-1"
                                />
                              </div>
                              <textarea
                                value={block.text}
                                onChange={(e) => updateDialogueBlock(panel.id, block.id, { text: e.target.value })}
                                className="w-full border-2 border-black rounded p-2 text-xs"
                                placeholder="Dialogue or narration"
                              />
                              <button
                                onClick={() => removeDialogueBlock(panel.id, block.id)}
                                className="text-xs font-bold text-brand-red"
                              >
                                Remove
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                      <PanelWireframe panel={panel} textLayout={state.textLayout || 'caption'} />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div className="space-y-6">
          <div className="bg-white rounded-xl border-4 border-black shadow-comic p-4 space-y-4">
            <h3 className="font-display text-xl">Text Layout</h3>
            <div className="grid grid-cols-2 gap-2">
              {(['caption', 'speech_bubbles', 'chat_bubbles', 'none'] as TextLayout[]).map(layout => (
                <button
                  key={layout}
                  onClick={() => handleTextLayoutChange(layout)}
                  className={`border-2 border-black rounded px-2 py-2 text-xs font-bold uppercase ${state.textLayout === layout ? 'bg-brand-yellow' : 'bg-white'}`}
                >
                  {layout.replace('_', ' ')}
                </button>
              ))}
            </div>
          </div>

          <div className="bg-brand-yellow p-6 rounded-xl border-4 border-black shadow-comic relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4 opacity-10">
              <Coins size={100} />
            </div>
            <h3 className="text-2xl font-display mb-6 border-b-2 border-black pb-2">Cost Projection</h3>
            <div className="space-y-3 relative z-10">
              <div className="flex items-center justify-between text-sm font-bold">
                <span>Panels Planned</span>
                <span className="font-mono">{plannedPanelCount}</span>
              </div>
              <div className="flex items-center justify-between text-sm font-bold">
                <span>Estimated Tokens</span>
                <span className="font-mono">{estimatedTokens}</span>
              </div>
              <div className="flex items-center justify-between text-sm font-bold">
                <span>Default Image Model</span>
                <span className="font-mono">{activeImageModel.label}</span>
              </div>
              <div className="flex items-center justify-between text-sm font-bold">
                <span>Accrued (to date)</span>
                <span className="font-mono">{formatCurrency(costSummary.accrued)}</span>
              </div>
              <div className="flex items-center justify-between text-sm font-bold">
                <span>Projected Remaining</span>
                <span className="font-mono">{formatCurrency(costSummary.projectedRemaining)}</span>
              </div>
              <div className="flex items-center justify-between text-sm font-bold">
                <span>Total Projected</span>
                <span className="font-mono">{formatCurrency(costSummary.totalProjected)}</span>
              </div>
              <div className="flex items-center justify-between text-sm font-bold">
                <span>Estimated CT</span>
                <span className="font-mono">{estimatedCt.toLocaleString()} CT</span>
              </div>
              <div className="text-[10px] text-amber-900 font-mono">
                Accrued values come from recorded artifacts; projected remaining is model-based. 1 CT = $0.0001. Pricing as of {PRICING_AS_OF}.
              </div>
            </div>
          </div>

          <div className="bg-white p-4 rounded-xl border-4 border-black shadow-comic space-y-4">
            <div>
              <h3 className="font-display text-lg">Premium Model Comparison</h3>
              <p className="text-[11px] text-slate-500 font-comic">Estimates based on panel count and prompt length.</p>
            </div>

            <div className="border-2 border-black rounded-lg p-3 space-y-2">
              <div className="text-xs font-bold uppercase">Image Models</div>
              <div className="grid grid-cols-3 text-[11px] font-bold bg-slate-100 border border-black rounded px-2 py-1">
                <div>Model</div>
                <div>Rate</div>
                <div className="text-right">Est. Total</div>
              </div>
              <div className="grid grid-cols-3 text-[11px] font-bold px-2 py-1">
                <div>Flux Schnell (Pixazo Free)</div>
                <div>$0.00 / img</div>
                <div className="text-right">{formatCurrency(textCostLite)}</div>
              </div>
              <div className="grid grid-cols-3 text-[11px] font-bold px-2 py-1">
                <div>Nano Banana (Flash Image)</div>
                <div>{formatCurrency(pricing.models[IMAGE_MODEL]?.imagePerOutput || 0)} / img</div>
                <div className="text-right">{formatCurrency(imageCostCurrent + textCostLite)}</div>
              </div>
              <div className="grid grid-cols-3 text-[11px] font-bold px-2 py-1">
                <div>Nano Banana Batch</div>
                <div>{formatCurrency((pricing.models[IMAGE_MODEL]?.imagePerOutput || 0) / 2)} / img</div>
                <div className="text-right">{formatCurrency(imageCostBatch + textCostLite)}</div>
              </div>
              <div className="grid grid-cols-3 text-[11px] font-bold px-2 py-1">
                <div>Banana Pro (3 Pro Image)</div>
                <div>{formatCurrency(pricing.models['gemini-3-pro-image-preview']?.imagePerOutput || 0)} / img</div>
                <div className="text-right">{formatCurrency(imageCostBananaPro + textCostLite)}</div>
              </div>
              <div className="text-[10px] text-slate-500 font-mono">Rates pulled from the live pricing config. Cost is per-axis: tokens + per-image are independent.</div>
            </div>

            <div className="border-2 border-black rounded-lg p-3 space-y-2">
              <div className="text-xs font-bold uppercase">Text Models</div>
              <div className="grid grid-cols-3 text-[11px] font-bold bg-slate-100 border border-black rounded px-2 py-1">
                <div>Model</div>
                <div>Rate (in/out)</div>
                <div className="text-right">Est. Total</div>
              </div>
              <div className="grid grid-cols-3 text-[11px] font-bold px-2 py-1">
                <div>Economy text model</div>
                <div>{formatCurrency(pricing.models['gemini-2.5-flash-lite']?.inputPer1k || 0)} / {formatCurrency(pricing.models['gemini-2.5-flash-lite']?.outputPer1k || 0)} per 1K</div>
                <div className="text-right">{formatCurrency(imageCostCurrent + textCostLite)}</div>
              </div>
              <div className="grid grid-cols-3 text-[11px] font-bold px-2 py-1">
                <div>Standard text model</div>
                <div>{formatCurrency(pricing.models['gemini-2.5-flash']?.inputPer1k || 0)} / {formatCurrency(pricing.models['gemini-2.5-flash']?.outputPer1k || 0)} per 1K</div>
                <div className="text-right">{formatCurrency(imageCostCurrent + textCostFlash)}</div>
              </div>
              <div className="text-[10px] text-slate-500 font-mono">Costs are estimates: tokens use input/output rates, images use per-image rate. Each axis is independent.</div>
            </div>
          </div>

          <div className="bg-white p-4 rounded-xl border-4 border-black shadow-comic flex gap-3 items-start">
            <AlertCircle className="text-brand-blue shrink-0 mt-1" />
            <p className="text-xs font-comic text-slate-700 leading-relaxed">
              This preview is fully editable. Update prompts and dialogue until the plan is perfect, then start generation.
            </p>
          </div>
        </div>
      </div>
      {limitDetails && (
        <LimitExceededModal
          details={limitDetails}
          onClose={() => setLimitDetails(null)}
          onUpgrade={() => {
            setLimitDetails(null);
            window.alert('Open Account Settings > Billing to upgrade your plan.');
          }}
          onAddCredits={() => {
            setLimitDetails(null);
            window.alert('Open Account Settings > Billing to add credits.');
          }}
          onWait={() => setLimitDetails(null)}
        />
      )}
    </div>
  );
};
