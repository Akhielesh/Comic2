import { Project, GenerationStatus, ComicPanel } from "../types";
import { generatePanelBreakdown, updateContinuitySummary } from "./geminiService";
import { generateImage } from "./imageService";
import { buildImagePrompt } from "./imagePrompt";
import { resolveAspectRatio } from "./imageUtils";
import { normalizePanelDialogue } from "./dialogueUtils";
import { MAX_CONTINUITY_PANELS } from "./modelPolicy";
import { createSystemNotification } from "./db";
import { prependCappedHistory, appendCappedHistory } from "./projectStorage";
import { ApiError } from "./apiClient";
import { computeDefaultBubblePositions } from "./bubbleLayout";
import {
  buildPanelReferencePack,
  buildPanelScopedContext,
  getEntityById,
  getSceneBinding,
  resolvePanelContinuity,
  buildEntityTextContext,
  validateContinuityState
} from "./continuity";
import { applyStyleLockResolution } from "./styleLock";
import { hasMultiFrameLanguage, sanitizePanelDescription } from "./panelDescription";
import { getModelForTask } from "./appSettings";
import { GEMINI_IMAGE_MODEL_ID, getImageModelById } from "./imageModels";

const generationControllers = new Map<string, AbortController>();
const generationCanceled = new Set<string>();

const STRICT_STYLE_LOCK_ERROR = "STRICT_STYLE_LOCK_UNRESOLVED";
const STRICT_REFERENCE_ERROR = "STRICT_REFERENCE_REQUIRED";
const MULTI_FRAME_ERROR = "MULTI_FRAME_DESCRIPTION";

const stableHash = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return `h${Math.abs(hash >>> 0).toString(16)}`;
};

const hashScenes = (state: Project["state"]) =>
  stableHash(
    JSON.stringify(
      (state.scenes || []).map((scene) => ({
        id: scene.id,
        rawText: scene.rawText || "",
        synopsis: scene.synopsis || "",
        setting: scene.setting || "",
        characters: scene.characters || []
      }))
    )
  );

const hashWorld = (state: Project["state"]) =>
  stableHash(
    JSON.stringify({
      characters: (state.characters || []).map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        bio: entry.bio,
        referenceImageIds: entry.referenceImageIds || []
      })),
      items: (state.items || []).map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        referenceImageIds: entry.referenceImageIds || []
      })),
      locations: (state.locations || []).map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        referenceImageIds: entry.referenceImageIds || []
      }))
    })
  );

const hasStaleDownstreamFingerprint = (state: Project["state"]) => {
  const expectedScriptHash = stableHash(state.script || "");
  const expectedSceneHash = hashScenes(state);
  const expectedWorldHash = hashWorld(state);
  if (!state.scriptHash || !state.sceneHash || !state.worldHash) return true;
  return (
    state.scriptHash !== expectedScriptHash ||
    state.sceneHash !== expectedSceneHash ||
    state.worldHash !== expectedWorldHash
  );
};

const countUngroundedEntities = (state: Project["state"]) =>
  (state.continuity?.validation?.issues || []).filter((issue) => issue.code === "ENTITY_NOT_FOUND").length;

const countDroppedEntities = (state: Project["state"]) =>
  (state.continuity?.validation?.issues || []).filter((issue) =>
    issue.code === "ENTITY_NOT_FOUND" || issue.code === "ENTITY_REFERENCE_MISSING"
  ).length;

const resolveLockedPanelModelId = (): string => {
  const configured = getModelForTask("panel");
  const model = getImageModelById(configured);
  if (model?.supportsReferences) {
    return model.id;
  }
  return GEMINI_IMAGE_MODEL_ID;
};

export const cancelGeneration = (projectId: string) => {
  generationCanceled.add(projectId);
  const controller = generationControllers.get(projectId);
  if (controller) {
    controller.abort();
  }
};

const isCanceled = (projectId: string) => generationCanceled.has(projectId);

const groupPanelsByScene = (panels: ComicPanel[]) => {
  const map = new Map<number, ComicPanel[]>();
  panels.forEach((panel) => {
    if (!map.has(panel.sceneId)) map.set(panel.sceneId, []);
    map.get(panel.sceneId)!.push(panel);
  });
  return map;
};

const panelToPlan = (panel: ComicPanel) => ({
  ...panel,
  description: panel.description || panel.prompt || "",
  prompt: panel.prompt || panel.description || "",
  isPlanned: panel.isPlanned ?? true
});

export const startBackgroundGeneration = async (
  project: Project,
  onUpdate: (projectId: string, updates: Partial<Project> | ((prev: Project) => Partial<Project>)) => void,
  onComplete: (projectId: string, panels: ComicPanel[]) => void
) => {
  let state = project.state;
  const startTime = Date.now();
  const initialStyleResolution = applyStyleLockResolution(state);
  state = initialStyleResolution.state;
  const strictMode = (state.continuity?.lockLevel || "strict") === "strict";
  const ratioConfig = resolveAspectRatio(state, state.styleAspectRatio);
  const panelRunId = crypto.randomUUID();
  const configuredPanelModelId = getModelForTask("panel");
  const lockedPanelModelId = resolveLockedPanelModelId();
  const staleDownstreamFingerprint = hasStaleDownstreamFingerprint(state);
  const droppedEntityCount = countDroppedEntities(state);
  const ungroundedEntityCount = countUngroundedEntities(state);
  const panelModelsUsed = new Set<string>();
  const panelReferenceCounts: number[] = [];
  let zeroRefPanelCount = 0;
  let multiFrameDetectedCount = 0;

  generationCanceled.delete(project.id);
  const controller = new AbortController();
  generationControllers.set(project.id, controller);

  let currentStatus: GenerationStatus = {
    isActive: true,
    progress: 0,
    startTime,
    estimatedTimeRemaining: "Calculating...",
    currentStepDescription: "Initializing...",
    logs: [],
    completedPanels: 0,
    totalPanels: state.scenes.length * 3
  };

  const updateStatus = (overrides: Partial<GenerationStatus>) => {
    currentStatus = { ...currentStatus, ...overrides };
    onUpdate(project.id, (prev) => ({
      state: { ...prev.state, generationStatus: currentStatus }
    }));
  };

  const addLog = (message: string) => {
    const newLog = { timestamp: Date.now(), message };
    updateStatus({ logs: [...currentStatus.logs, newLog] });
  };

  const stopWithStatus = (description: string) => {
    updateStatus({
      isActive: false,
      currentStepDescription: description,
      estimatedTimeRemaining: description,
      progress: Math.min(currentStatus.progress, 100)
    });
  };

  try {
    addLog("Starting generation process...");
    if (staleDownstreamFingerprint) {
      addLog("Warning: generation started with stale script/scene/world fingerprints.");
    }
    if (configuredPanelModelId !== lockedPanelModelId) {
      addLog(`Configured panel model "${configuredPanelModelId}" does not support references. Locking run to "${lockedPanelModelId}".`);
    }
    if (initialStyleResolution.changed) {
      onUpdate(project.id, (prev) => ({
        state: {
          ...prev.state,
          selectedStyleId: state.selectedStyleId,
          stylePrompt: state.stylePrompt,
          styleImageId: state.styleImageId,
          styleImageUrl: state.styleImageUrl,
          styleCategory: state.styleCategory,
          styleAspectRatio: state.styleAspectRatio,
          imageResolution: state.imageResolution,
          styleLockStatus: state.styleLockStatus,
          styleLockResolvedAt: state.styleLockResolvedAt
        }
      }));
    }
    if (strictMode && !initialStyleResolution.resolution.resolved) {
      addLog("Generation blocked: strict mode requires a resolved style lock.");
      void createSystemNotification(
        "Generation blocked: style lock is unresolved. Select a style variant with a generated style image.",
        { projectId: project.id, stage: "generation" }
      );
      stopWithStatus(`Failed: ${STRICT_STYLE_LOCK_ERROR}`);
      return;
    }

    const validation = validateContinuityState(state);
    onUpdate(project.id, (prev) => ({
      state: {
        ...prev.state,
        continuity: prev.state.continuity
          ? { ...prev.state.continuity, validation }
          : prev.state.continuity
      }
    }));
    if (strictMode && !validation.isValid) {
      addLog(`Continuity validation failed (${validation.issues.length} issues).`);
      void createSystemNotification(
        `Generation blocked: continuity validation failed (${validation.issues.length} issue${validation.issues.length === 1 ? '' : 's'}).`,
        { projectId: project.id, stage: 'generation' }
      );
      stopWithStatus("Failed: Continuity");
      return;
    }

    const existingPanels = state.panels.map(panelToPlan);
    const planByScene = groupPanelsByScene(existingPanels);
    let totalPanelsEstimate = existingPanels.length > 0 ? existingPanels.length : state.scenes.length * 3;
    let stepsCompleted = 0;

    const freshPanels: ComicPanel[] = [];
    const recentPanelImageIds: string[] = [];
    const recentPanelDescriptions: string[] = [];
    let continuitySummary = state.continuitySummary || "";

    if (state.scenes.length === 0) {
      addLog("Error: No scenes found to generate. Please analyze script first.");
      stopWithStatus("Failed: No scenes");
      return;
    }

    for (const scene of state.scenes) {
      if (isCanceled(project.id)) {
        addLog("Generation stopped by user.");
        stopWithStatus("Stopped");
        return;
      }
      if (!scene || !scene.synopsis) {
        addLog(`Skipping invalid scene data (ID: ${scene?.id})...`);
        continue;
      }

      let breakdown = planByScene.get(scene.id) || [];
      if (breakdown.length === 0) {
        updateStatus({ currentStepDescription: `Planning Scene ${scene.id}` });
        addLog(`Planning Scene ${scene.id}: ${scene.synopsis.substring(0, 30)}...`);

        try {
          const panelData = await generatePanelBreakdown(
            scene,
            state.stylePrompt,
            state.layoutType,
            project.id,
            3,
            {
              abortSignal: controller.signal,
              stage: "preview",
              continuityBible: state.continuity?.bible,
              sceneBindings: state.continuity?.bible.sceneBindings,
              previousPanelContext: freshPanels
                .slice(-MAX_CONTINUITY_PANELS)
                .map((panel) => ({
                  panelId: panel.id,
                  sceneId: panel.sceneId,
                  description: panel.description,
                  dialogue: panel.dialogue
                }))
            }
          );
          breakdown = panelData.map((panel, idx) => {
            const sanitized = sanitizePanelDescription(panel.description || "");
            if (sanitized.flagged) multiFrameDetectedCount += 1;
            return {
              id: `s${scene.id}-p${idx}-${Date.now()}`,
              sceneId: scene.id,
              description: sanitized.text,
              prompt: sanitized.text,
              dialogue: panel.dialogue || "",
              dialogueBlocks: panel.dialogueBlocks,
              imageIdHistory: [],
              imageUrlHistory: [],
              isPlanned: true,
              continuity: {
                requiredEntityIds: panel.requiredEntityIds || [],
                referenceImageIds: [],
                locationId: panel.locationId,
                continuityNotes: panel.continuityNotes,
                flaggedIssues: []
              }
            };
          }).map(normalizePanelDialogue);

          totalPanelsEstimate = totalPanelsEstimate - 3 + breakdown.length;
        } catch (e: any) {
          addLog(`Error planning scene ${scene.id}: ${e.message}`);
          throw e; // Stop generation if planning fails
        }
      }

      // --- Batched parallel generation (GENERATION_BATCH_SIZE at a time) ---
      const GENERATION_BATCH_SIZE = 3;
      const sceneBinding = getSceneBinding(state, scene.id);

      for (let batchStart = 0; batchStart < breakdown.length; batchStart += GENERATION_BATCH_SIZE) {
        if (isCanceled(project.id)) {
          addLog("Generation stopped by user.");
          stopWithStatus("Stopped");
          return;
        }

        const batch = breakdown.slice(batchStart, batchStart + GENERATION_BATCH_SIZE);
        const batchEnd = Math.min(batchStart + GENERATION_BATCH_SIZE, breakdown.length);
        updateStatus({ currentStepDescription: `Scene ${scene.id} — panels ${batchStart + 1}–${batchEnd} of ${breakdown.length}` });
        addLog(`Generating batch: Scene ${scene.id}, panels ${batchStart + 1}–${batchEnd}…`);

        // Capture continuity context snapshot BEFORE batch starts
        const continuityText = recentPanelDescriptions.slice(-MAX_CONTINUITY_PANELS).join(" | ");
        const continuityImageIdsSnapshot = [...recentPanelImageIds.slice(-MAX_CONTINUITY_PANELS)];

        const batchPromises = batch.map(async (panelData, idxInBatch) => {
          const panelIndex = batchStart + idxInBatch;
          const sanitizedDescription = sanitizePanelDescription(panelData.description || panelData.prompt || "");
          if (sanitizedDescription.flagged) multiFrameDetectedCount += 1;
          if (hasMultiFrameLanguage(sanitizedDescription.text)) {
            throw new Error(`${MULTI_FRAME_ERROR}: Scene ${scene.id} panel ${panelIndex + 1} contains multi-frame directives.`);
          }
          const normalizedPanel = normalizePanelDialogue({
            ...panelData,
            description: sanitizedDescription.text,
            prompt: sanitizedDescription.text
          });
          const panelContinuity = resolvePanelContinuity(state, normalizedPanel);
          const continuityEntityNames = (panelContinuity.requiredEntityIds || [])
            .map((entityId) => getEntityById(state, entityId)?.name)
            .filter((name): name is string => !!name);
          const lockedLocationName = panelContinuity.locationId
            ? getEntityById(state, panelContinuity.locationId)?.name
            : undefined;
          const panelScopedContext = buildPanelScopedContext(state, normalizedPanel);

          const entityVisualContext = buildEntityTextContext(state, normalizedPanel);
          const lastPanelImageId = continuityImageIdsSnapshot[continuityImageIdsSnapshot.length - 1];
          const referencePack = buildPanelReferencePack(state, normalizedPanel, {
            styleImageId: state.styleImageId,
            lastPanelImageId,
            maxReferences: 8
          });
          panelReferenceCounts.push(referencePack.imageIds.length);

          const requiredReferences = strictMode && (panelContinuity.requiredEntityIds?.length || 0) > 0;
          if (requiredReferences && referencePack.imageIds.length === 0) {
            zeroRefPanelCount += 1;
            throw new Error(
              `${STRICT_REFERENCE_ERROR}: Scene ${scene.id} panel ${panelIndex + 1} requires entity references but none were resolved.`
            );
          }
          if (strictMode && referencePack.imageIds.length === 0) {
            zeroRefPanelCount += 1;
          }

          const imagePrompt = buildImagePrompt({
            stage: "panel",
            stylePrompt: state.stylePrompt,
            characters: panelScopedContext.characters || undefined,
            items: panelScopedContext.items || undefined,
            locations: panelScopedContext.location || undefined,
            sceneAction: normalizedPanel.description,
            setting: scene.setting,
            continuitySummary: continuitySummary || undefined,
            recentPanels: continuityText || undefined,
            requiredEntityNames: continuityEntityNames.join(", ") || undefined,
            lockedLocation: lockedLocationName,
            continuityLock: panelContinuity.continuityNotes || (sceneBinding ? `Scene ${sceneBinding.sceneId} strict lock` : "strict"),
            entityVisualRef: entityVisualContext
          });

          let generatedImageId = normalizedPanel.imageId;
          let generatedImageUrl = normalizedPanel.imageUrl;

          if (!generatedImageId || !generatedImageUrl) {
            const generated = await generateImage(
              imagePrompt,
              ratioConfig.modelRatio,
              state.imageResolution,
              referencePack.imageIds,
              project.id,
              {
                abortSignal: controller.signal,
                stage: "panel",
                cropToRatio: ratioConfig.cropRatio,
                continuitySensitive: true,
                requiredReferences,
                lockedModelId: lockedPanelModelId,
                meta: {
                  source: {
                    type: "panel",
                    id: normalizedPanel.id,
                    label: `Scene ${scene.id} Panel ${panelIndex + 1}`
                  },
                  sceneId: scene.id,
                  panelIndex,
                  regen: false,
                  runId: panelRunId,
                  panel_ref_count: referencePack.imageIds.length,
                  zero_ref_panel: referencePack.imageIds.length === 0 ? 1 : 0,
                  multi_frame_description_detected: sanitizedDescription.flagged ? 1 : 0,
                  style_lock_resolved: initialStyleResolution.resolution.resolved,
                  style_lock_used: Boolean(referencePack.styleImageId),
                  requiredReferences,
                  referenceCount: referencePack.imageIds.length,
                  styleLockUsed: Boolean(referencePack.styleImageId),
                  script_hash: state.scriptHash || stableHash(state.script || ""),
                  scene_hash: state.sceneHash || hashScenes(state),
                  world_hash: state.worldHash || hashWorld(state),
                  reset_source_stage: state.lastResetSourceStage || "unknown",
                  dropped_entity_count: droppedEntityCount,
                  ungrounded_entity_count: ungroundedEntityCount,
                  stale_downstream_fingerprint: staleDownstreamFingerprint
                }
              }
            );
            generatedImageId = generated?.imageId;
            generatedImageUrl = generated?.imageUrl;
            if (generated?.modelId) {
              panelModelsUsed.add(generated.modelId);
            } else {
              panelModelsUsed.add(lockedPanelModelId);
            }
            if (generated?.fallbackOccurred) {
              addLog(
                `Model fallback on Scene ${scene.id} Panel ${panelIndex + 1}: ${generated.fallbackFromModel || lockedPanelModelId} -> ${generated.fallbackToModel || generated.modelId || lockedPanelModelId}`
              );
            }
          }

          return normalizePanelDialogue({
            ...normalizedPanel,
            continuity: {
              ...panelContinuity,
              referenceImageIds: referencePack.imageIds
            },
            dialogueBlocks: normalizedPanel.dialogueBlocks?.length
              ? computeDefaultBubblePositions(normalizedPanel.dialogueBlocks)
              : normalizedPanel.dialogueBlocks,
            imageId: generatedImageId,
            imageUrl: generatedImageUrl,
            imageIdHistory: prependCappedHistory(normalizedPanel.imageIdHistory, generatedImageId),
            imageUrlHistory: prependCappedHistory(normalizedPanel.imageUrlHistory, generatedImageUrl),
            isPlanned: false
          });
        });

        const batchResults = await Promise.allSettled(batchPromises);

        // Process batch results — failed panels still get added with failureReason
        let batchHadBillingError = false;
        let batchHadStrictFailure = false;
        for (let i = 0; i < batchResults.length; i++) {
          const result = batchResults[i];
          const panelData = batch[i];
          const sanitizedPanelDescription = sanitizePanelDescription(panelData.description || panelData.prompt || '');

          if (result.status === 'fulfilled') {
            const newPanel = result.value;
            freshPanels.push(newPanel);
            if (newPanel.imageId) {
              recentPanelImageIds.push(newPanel.imageId);
            }
            recentPanelDescriptions.push(newPanel.description || sanitizedPanelDescription.text || "");
          } else {
            // Panel failed — add it with failure marker so user can retry later
            const error = result.reason;
            const errorMessage = String(error?.message || error || 'Unknown error');
            if (errorMessage.includes(STRICT_REFERENCE_ERROR) || errorMessage.includes(MULTI_FRAME_ERROR)) {
              batchHadStrictFailure = true;
            }
            const billingDetails = error instanceof ApiError
              ? ((error.details as any)?.details || error.details)
              : null;
            if (billingDetails && typeof billingDetails === 'object' && typeof (billingDetails as any).reason === 'string') {
              batchHadBillingError = true;
              const resetAt = (billingDetails as any).resetAt ? new Date((billingDetails as any).resetAt).toLocaleString() : 'next reset';
              addLog(`Token limit reached (${(billingDetails as any).reason}). Wait until ${resetAt} or upgrade.`);
            }
            addLog(`⚠ Panel failed: ${(sanitizedPanelDescription.text || "").substring(0, 40)}… — ${errorMessage}`);

            const panelContinuity = resolvePanelContinuity(state, panelData);
            const failurePack = buildPanelReferencePack(state, panelData, {
              styleImageId: state.styleImageId,
              lastPanelImageId: recentPanelImageIds[recentPanelImageIds.length - 1],
              maxReferences: 8
            });
            freshPanels.push(normalizePanelDialogue({
              ...panelData,
              description: sanitizedPanelDescription.text || panelData.description,
              prompt: sanitizedPanelDescription.text || panelData.prompt,
              continuity: { ...panelContinuity, referenceImageIds: failurePack.imageIds },
              imageId: undefined as any,
              imageUrl: undefined as any,
              imageIdHistory: panelData.imageIdHistory || [],
              imageUrlHistory: panelData.imageUrlHistory || [],
              isPlanned: false,
              failureReason: errorMessage || 'Generation failed'
            }));
            recentPanelDescriptions.push(sanitizedPanelDescription.text || "");
          }

          stepsCompleted++;
        }

        // Update progress after batch
        const elapsedSeconds = (Date.now() - startTime) / 1000;
        const ratePerStep = stepsCompleted ? elapsedSeconds / stepsCompleted : 0;
        const remainingSteps = Math.max(totalPanelsEstimate - stepsCompleted, 0);
        const estSecondsLeft = remainingSteps * ratePerStep;
        const timeString = estSecondsLeft < 60
          ? `${Math.ceil(estSecondsLeft)}s`
          : `${Math.ceil(estSecondsLeft / 60)}m ${Math.ceil(estSecondsLeft % 60)}s`;

        updateStatus({
          progress: Math.min((stepsCompleted / Math.max(totalPanelsEstimate, 1)) * 100, 100),
          estimatedTimeRemaining: timeString,
          completedPanels: freshPanels.filter(p => p.imageId).length,
          totalPanels: totalPanelsEstimate
        });

        onUpdate(project.id, (prev) => ({
          state: { ...prev.state, panels: freshPanels }
        }));

        if (batchHadStrictFailure) {
          throw new Error(`${STRICT_REFERENCE_ERROR}: Strict continuity constraints were violated in this batch.`);
        }

        // Stop if billing limit hit — remaining panels would all fail
        if (batchHadBillingError) {
          addLog("Stopping remaining generation due to billing limit. Completed panels are saved.");
          break;
        }
      }

      continuitySummary = await updateContinuitySummary(
        continuitySummary,
        scene,
        breakdown.map((b) => ({ description: b.description, dialogue: b.dialogue })),
        project.id
      );
      onUpdate(project.id, (prev) => ({
        state: { ...prev.state, continuitySummary }
      }));
    }

    const mixedModelInRun = panelModelsUsed.size > 1 ? 1 : 0;
    const averageRefCount = panelReferenceCounts.length
      ? Number((panelReferenceCounts.reduce((sum, value) => sum + value, 0) / panelReferenceCounts.length).toFixed(2))
      : 0;
    addLog(
      `[METRICS] panel_ref_count=${averageRefCount} zero_ref_panel=${zeroRefPanelCount} mixed_model_in_run=${mixedModelInRun} multi_frame_description_detected=${multiFrameDetectedCount} style_lock_resolved=${initialStyleResolution.resolution.resolved ? 1 : 0} stale_downstream_fingerprint=${staleDownstreamFingerprint ? 1 : 0} dropped_entity_count=${droppedEntityCount} ungrounded_entity_count=${ungroundedEntityCount}`
    );

    addLog("Build Complete!");
    updateStatus({
      isActive: false,
      progress: 100,
      estimatedTimeRemaining: "Done",
      currentStepDescription: "Complete",
      completedPanels: freshPanels.filter(p => p.imageId).length,
      totalPanels: totalPanelsEstimate
    });

    onComplete(project.id, freshPanels);
  } catch (error: any) {
    console.error("Generation Error", error);
    addLog(`Error: ${error.message || String(error)}`);
    void createSystemNotification(
      `Generation failed: ${error?.message || 'Unknown error'}`,
      { projectId: project.id, stage: 'generation' }
    );
    updateStatus({
      isActive: false,
      currentStepDescription: `Failed: ${error.message || "Unknown error"}`,
      estimatedTimeRemaining: "Error"
    });
  } finally {
    generationControllers.delete(project.id);
    generationCanceled.delete(project.id);
  }
};

export const regenerateSinglePanel = async (
  project: Project,
  panelId: string,
  instructions: string,
  onUpdate: (projectId: string, updateOrFn: Partial<Project> | ((prev: Project) => Partial<Project>)) => void
) => {
  const styleApplied = applyStyleLockResolution(project.state);
  const state = styleApplied.state;
  const strictMode = (state.continuity?.lockLevel || "strict") === "strict";
  const staleDownstreamFingerprint = hasStaleDownstreamFingerprint(state);
  const droppedEntityCount = countDroppedEntities(state);
  const ungroundedEntityCount = countUngroundedEntities(state);
  if (strictMode && !styleApplied.resolution.resolved) {
    throw new Error(`${STRICT_STYLE_LOCK_ERROR}: Style lock must be resolved before panel regeneration.`);
  }
  if (styleApplied.changed) {
    onUpdate(project.id, { state });
  }

  const panelIndex = state.panels.findIndex((p) => p.id === panelId);
  if (panelIndex === -1) throw new Error("Panel not found");

  const targetPanel = state.panels[panelIndex];
  const sanitizedDescription = sanitizePanelDescription(targetPanel.description || targetPanel.prompt || "");
  if (sanitizedDescription.flagged && hasMultiFrameLanguage(sanitizedDescription.text)) {
    throw new Error(`${MULTI_FRAME_ERROR}: Panel description must describe a single frame.`);
  }
  const normalizedTargetPanel: ComicPanel = normalizePanelDialogue({
    ...targetPanel,
    description: sanitizedDescription.text || targetPanel.description,
    prompt: sanitizedDescription.text || targetPanel.prompt
  });
  const scene = state.scenes.find((s) => s.id === targetPanel.sceneId);
  const sceneBinding = scene ? getSceneBinding(state, scene.id) : undefined;
  const panelContinuity = resolvePanelContinuity(state, normalizedTargetPanel);
  const panelScopedContext = buildPanelScopedContext(state, normalizedTargetPanel);
  const referencePack = buildPanelReferencePack(state, normalizedTargetPanel, {
    styleImageId: state.styleImageId,
    lastPanelImageId: state.panels
      .slice(0, panelIndex)
      .map((panel) => panel.imageId)
      .filter((imageId): imageId is string => !!imageId)
      .at(-1),
    maxReferences: 8
  });
  const requiredReferences = strictMode && (panelContinuity.requiredEntityIds?.length || 0) > 0;
  if (requiredReferences && referencePack.imageIds.length === 0) {
    throw new Error(`${STRICT_REFERENCE_ERROR}: Required continuity references are missing for this panel.`);
  }

  // 1. Gather Context
  const entityVisualContext = buildEntityTextContext(state, normalizedTargetPanel);
  const recentPanels = state.panels
    .slice(Math.max(0, panelIndex - 3), panelIndex)
    .map((panel) => sanitizePanelDescription(panel.description || panel.prompt || '').text)
    .join(" | ");

  const imagePrompt = buildImagePrompt({
    stage: "panel_regen",
    stylePrompt: state.stylePrompt,
    characters: panelScopedContext.characters || undefined,
    items: panelScopedContext.items || undefined,
    locations: panelScopedContext.location || undefined,
    sceneAction: normalizedTargetPanel.description,
    setting: scene ? scene.setting : "",
    recentPanels: recentPanels,
    instructions: instructions,
    entityVisualRef: entityVisualContext,
    continuityLock: normalizedTargetPanel.continuity?.continuityNotes || (sceneBinding ? `Scene ${sceneBinding.sceneId} strict lock` : "strict")
  });

  // 2. Generate Image
  const ratioConfig = resolveAspectRatio(state, state.styleAspectRatio);
  const lockedModelId = resolveLockedPanelModelId();
  const runId = crypto.randomUUID();

  const generated = await generateImage(
    imagePrompt,
    ratioConfig.modelRatio,
    state.imageResolution,
    referencePack.imageIds,
    project.id,
    {
      stage: "panel_regen",
      cropToRatio: ratioConfig.cropRatio,
      continuitySensitive: true,
      requiredReferences,
      lockedModelId,
      meta: {
        source: {
          type: "panel",
          id: normalizedTargetPanel.id,
          label: `Regenerate Panel ${panelIndex + 1}`
        },
        sceneId: scene?.id,
        panelId: normalizedTargetPanel.id,
        runId,
        panel_ref_count: referencePack.imageIds.length,
        zero_ref_panel: referencePack.imageIds.length === 0 ? 1 : 0,
        multi_frame_description_detected: sanitizedDescription.flagged ? 1 : 0,
        style_lock_resolved: styleApplied.resolution.resolved,
        style_lock_used: Boolean(referencePack.styleImageId),
        requiredReferences,
        referenceCount: referencePack.imageIds.length,
        styleLockUsed: Boolean(referencePack.styleImageId),
        script_hash: state.scriptHash || stableHash(state.script || ""),
        scene_hash: state.sceneHash || hashScenes(state),
        world_hash: state.worldHash || hashWorld(state),
        reset_source_stage: state.lastResetSourceStage || "unknown",
        dropped_entity_count: droppedEntityCount,
        ungrounded_entity_count: ungroundedEntityCount,
        stale_downstream_fingerprint: staleDownstreamFingerprint
      }
    }
  );

  // 4. Update State
  if (generated?.imageUrl) {
    onUpdate(project.id, (prev) => {
      const existing = prev.state.panels.find((p) => p.id === panelId);
      if (!existing) return {}; // Should not happen

      const newPanels = prev.state.panels.map((p) => p.id === panelId ? {
        ...p,
        description: normalizedTargetPanel.description,
        prompt: normalizedTargetPanel.prompt,
        imageId: generated.imageId,
        imageUrl: generated.imageUrl,
        imageIdHistory: appendCappedHistory(p.imageIdHistory, generated.imageId),
        imageUrlHistory: appendCappedHistory(p.imageUrlHistory, generated.imageUrl),
        continuity: {
          ...resolvePanelContinuity(prev.state, normalizedTargetPanel),
          referenceImageIds: referencePack.imageIds
        },
        dialogueBlocks: p.dialogueBlocks?.length
          ? computeDefaultBubblePositions(p.dialogueBlocks)
          : p.dialogueBlocks,
        failureReason: undefined // Clear any failure flag
      } : p);

      return {
        state: { ...prev.state, panels: newPanels }
      };
    });
  } else {
    throw new Error("Generation failed to produce an image URL.");
  }
};
