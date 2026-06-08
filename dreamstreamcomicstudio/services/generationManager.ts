import { Project, GenerationStatus, ComicPanel } from "../types";
import { generatePanelBreakdown, updateContinuitySummary } from "./geminiService";
import { generateImage } from "./imageService";
import { buildImagePrompt } from "./imagePrompt";
import { classifyStoryMood } from "./storyMood";
import { buildGenerationInsight, appendGenerationInsight, formatInsightLogLine } from "./contextLog";
import { stableHash, hashScenes, hashWorld, hasStaleDownstreamFingerprint } from "./pipelineFingerprint";
import { resolveAspectRatio } from "./imageUtils";
import { getGridTemplate } from "./panelLayout";
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

  // Read the story's mood once so every panel render gets a palette/lighting guardrail
  // (keeps a happy story from rendering dark & moody). Persist + log it for later analysis.
  const storyMood = classifyStoryMood(state.script, state.creativeDirection);

  try {
    addLog("Starting generation process...");
    addLog(`Story mood: ${storyMood.label} (${storyMood.brightness} palette). ${storyMood.summary}`);
    // Snapshot the world/style/continuity exactly as used for this run, so single-panel
    // re-rolls later stay faithful even if the user edits or deletes entities/styles.
    const generationSnapshot = {
      takenAt: Date.now(),
      styleImageId: state.styleImageId,
      stylePrompt: state.stylePrompt,
      selectedStyleId: state.selectedStyleId,
      styleAspectRatio: state.styleAspectRatio,
      imageResolution: state.imageResolution,
      gridTemplateId: state.gridTemplateId,
      storyMood,
      characters: state.characters || [],
      items: state.items || [],
      locations: state.locations || [],
      continuity: state.continuity
    };
    onUpdate(project.id, (prev) => ({ state: { ...prev.state, storyMood, generationSnapshot } }));
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
      addLog(`Continuity validation failed (${validation.issues.length} issue${validation.issues.length === 1 ? '' : 's'}).`);
      // Name the specific blockers so the user knows exactly what to fix instead of a
      // bare "Failed: Continuity". Missing reference images are the #1 cause.
      const needsRefs = validation.issues
        .filter((issue) => issue.code === 'ENTITY_REFERENCE_MISSING' || issue.code === 'ENTITY_NOT_FOUND')
        .map((issue) => issue.message);
      validation.issues.slice(0, 6).forEach((issue) => addLog(`• ${issue.message}`));
      const refHint = needsRefs.length
        ? ` Generate reference images for: ${[...new Set(needsRefs)].slice(0, 6).join('; ')}.`
        : '';
      void createSystemNotification(
        `Generation blocked: continuity needs attention (${validation.issues.length} issue${validation.issues.length === 1 ? '' : 's'}).${refHint} Fix in the World stage, then start again.`,
        { projectId: project.id, stage: 'generation' }
      );
      stopWithStatus(needsRefs.length ? "Failed: missing reference images (see World stage)" : "Failed: Continuity");
      return;
    }

    const existingPanels = state.panels.map(panelToPlan);
    const planByScene = groupPanelsByScene(existingPanels);
    // Seed the estimate per-scene: a scene with an existing plan contributes its real
    // panel count; a scene still needing planning is assumed to be 3. This generalizes
    // both the fresh run (scenes*3) and the resume case, so the later
    // `-3 + breakdown.length` adjustment (which assumes a seeded 3) stays correct instead
    // of skewing the total — previously a resume seeded `existingPanels.length` yet still
    // subtracted 3 per replanned scene, corrupting the progress %/ETA.
    let totalPanelsEstimate = state.scenes.reduce(
      (sum, scene) => sum + (planByScene.get(scene.id)?.length || 3),
      0
    );
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
              creativeDirection: state.creativeDirection,
              continuitySummary: continuitySummary || undefined,
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
              title: panel.title,
              description: sanitized.text,
              prompt: sanitized.text,
              focalSubject: panel.focalSubject,
              shotType: panel.shotType,
              cameraAngle: panel.cameraAngle,
              composition: panel.composition,
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
      const sceneFreshStart = freshPanels.length;

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

          // Per-panel aspect ratio: use THIS panel's layout-slot shape (cycling the
          // template's slots per page) instead of forcing every panel to the single
          // style-stage ratio. Falls back to the style ratio when no template is set.
          const gridTemplate = state.gridTemplateId ? getGridTemplate(state.gridTemplateId) : null;
          const slotCount = gridTemplate?.panelSlots.length || 0;
          const panelSlot = slotCount > 0 ? gridTemplate!.panelSlots[panelIndex % slotCount] : null;
          const panelRatioConfig = resolveAspectRatio(state, panelSlot?.effectiveRatio || state.styleAspectRatio);

          // Story-grounding fields from the breakdown (keep the subject from drifting off-genre).
          const panelFocalSubject = normalizedPanel.focalSubject;
          const panelShotType = normalizedPanel.shotType;
          const panelCameraAngle = normalizedPanel.cameraAngle;
          const panelComposition = normalizedPanel.composition;

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
            focalSubject: panelFocalSubject,
            sceneSynopsis: scene.synopsis || undefined,
            creativeDirection: state.creativeDirection || undefined,
            moodGuidance: storyMood.promptGuidance,
            shotType: panelShotType,
            cameraAngle: panelCameraAngle,
            composition: panelComposition,
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
              panelRatioConfig.modelRatio,
              state.imageResolution,
              referencePack.imageIds,
              project.id,
              {
                abortSignal: controller.signal,
                stage: "panel",
                cropToRatio: panelRatioConfig.cropRatio,
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

        // Only the last MAX_CONTINUITY_PANELS entries are ever read (via slice(-N)), so
        // cap these here to keep memory flat on long scripts instead of growing per panel.
        if (recentPanelImageIds.length > MAX_CONTINUITY_PANELS) {
          recentPanelImageIds.splice(0, recentPanelImageIds.length - MAX_CONTINUITY_PANELS);
        }
        if (recentPanelDescriptions.length > MAX_CONTINUITY_PANELS) {
          recentPanelDescriptions.splice(0, recentPanelDescriptions.length - MAX_CONTINUITY_PANELS);
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
          // Previously this threw and discarded the ENTIRE run for one bad panel. The
          // offending panels are already saved with a failureReason, so instead we keep
          // going and let the user retry just those from the Done stage — losing the whole
          // comic over a single missing reference was the worst "comics keep failing" case.
          addLog("Some panels couldn't satisfy strict continuity (missing references or multi-frame text). They're flagged — continuing with the rest.");
        }

        // Stop if billing limit hit — remaining panels would all fail
        if (batchHadBillingError) {
          addLog("Stopping remaining generation due to billing limit. Completed panels are saved.");
          break;
        }
      }

      // Summarize only the panels that actually rendered this scene — feeding failed
      // (image-less) panels into the running continuity summary would describe panels
      // that don't exist and poison downstream prompts.
      const sceneGeneratedPanels = freshPanels
        .slice(sceneFreshStart)
        .filter((panel) => panel.imageId && !panel.failureReason);
      continuitySummary = await updateContinuitySummary(
        continuitySummary,
        scene,
        sceneGeneratedPanels.map((panel) => ({ description: panel.description, dialogue: panel.dialogue })),
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

    // Persist a compact record of this run's understanding + outcome (mood -> style ->
    // result) so issues like "happy story rendered dark" can be analysed later.
    const runInsight = buildGenerationInsight({
      panels: freshPanels,
      mood: storyMood,
      styleId: state.selectedStyleId,
      stylePrompt: state.stylePrompt,
      modelsUsed: [...panelModelsUsed],
      fallbacks: currentStatus.logs.filter((entry) => /Model fallback/i.test(entry.message)).length
    });
    addLog(formatInsightLogLine(runInsight));
    onUpdate(project.id, (prev) => ({
      state: { ...prev.state, generationInsights: appendGenerationInsight(prev.state.generationInsights, runInsight) }
    }));

    const flaggedPanels = freshPanels.filter((panel) => panel.failureReason && !panel.imageId);
    if (flaggedPanels.length > 0) {
      addLog(`Build complete with ${flaggedPanels.length} panel${flaggedPanels.length === 1 ? '' : 's'} to retry — open the Done stage to re-roll ${flaggedPanels.length === 1 ? 'it' : 'them'}.`);
      void createSystemNotification(
        `Comic finished — ${flaggedPanels.length} panel${flaggedPanels.length === 1 ? '' : 's'} need a retry (missing references or a description fix). Completed panels are saved.`,
        { projectId: project.id, stage: 'generation' }
      );
    } else {
      addLog("Build Complete!");
    }
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

  // Prefer the generation-time snapshot for world/style/continuity so a re-roll matches how
  // the comic was originally drawn — even if entities/styles were edited or deleted since.
  // Older comics without a snapshot fall back to live state (behaviour unchanged). The panel
  // text and scenes stay live so the user's edits to THIS panel are still honoured.
  const snap = state.generationSnapshot;
  const refState = snap
    ? {
        ...state,
        characters: snap.characters,
        items: snap.items,
        locations: snap.locations,
        continuity: snap.continuity ?? state.continuity,
        styleImageId: snap.styleImageId ?? state.styleImageId,
        stylePrompt: snap.stylePrompt ?? state.stylePrompt,
        styleAspectRatio: snap.styleAspectRatio ?? state.styleAspectRatio,
        imageResolution: snap.imageResolution ?? state.imageResolution,
        gridTemplateId: snap.gridTemplateId ?? state.gridTemplateId,
        storyMood: snap.storyMood ?? state.storyMood
      }
    : state;

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
  const sceneBinding = scene ? getSceneBinding(refState, scene.id) : undefined;
  const panelContinuity = resolvePanelContinuity(refState, normalizedTargetPanel);
  const panelScopedContext = buildPanelScopedContext(refState, normalizedTargetPanel);
  const referencePack = buildPanelReferencePack(refState, normalizedTargetPanel, {
    styleImageId: refState.styleImageId,
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
  const entityVisualContext = buildEntityTextContext(refState, normalizedTargetPanel);
  const recentPanels = state.panels
    .slice(Math.max(0, panelIndex - 3), panelIndex)
    .map((panel) => sanitizePanelDescription(panel.description || panel.prompt || '').text)
    .join(" | ");

  const imagePrompt = buildImagePrompt({
    stage: "panel_regen",
    stylePrompt: refState.stylePrompt,
    sceneSynopsis: scene?.synopsis || undefined,
    creativeDirection: state.creativeDirection || undefined,
    moodGuidance: (refState.storyMood?.promptGuidance) || classifyStoryMood(state.script, state.creativeDirection).promptGuidance,
    focalSubject: normalizedTargetPanel.focalSubject,
    shotType: normalizedTargetPanel.shotType,
    cameraAngle: normalizedTargetPanel.cameraAngle,
    composition: normalizedTargetPanel.composition,
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

  // 2. Generate Image — match this panel's layout-slot aspect ratio (same as the main run).
  const regenGridTemplate = refState.gridTemplateId ? getGridTemplate(refState.gridTemplateId) : null;
  const regenSlotCount = regenGridTemplate?.panelSlots.length || 0;
  const regenSlot = regenSlotCount > 0 ? regenGridTemplate!.panelSlots[panelIndex % regenSlotCount] : null;
  const ratioConfig = resolveAspectRatio(refState, regenSlot?.effectiveRatio || refState.styleAspectRatio);
  const lockedModelId = resolveLockedPanelModelId();
  const runId = crypto.randomUUID();

  const generated = await generateImage(
    imagePrompt,
    ratioConfig.modelRatio,
    refState.imageResolution,
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
          ...resolvePanelContinuity(refState, normalizedTargetPanel),
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
