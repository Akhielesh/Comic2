import { Project, GenerationStatus, ComicPanel, ComicAgentCardStatus } from "../types";
import { generatePanelBreakdown, updateContinuitySummary } from "./geminiService";
import { generateImage } from "./imageService";
import { buildImagePrompt } from "./imagePrompt";
import { classifyStoryMood } from "./storyMood";
import { buildGenerationInsight, appendGenerationInsight, formatInsightLogLine } from "./contextLog";
import { stableHash, hashScenes, hashWorld, hasStaleDownstreamFingerprint } from "./pipelineFingerprint";
import { resolveAspectRatio } from "./imageUtils";
import { getGridTemplate } from "./panelLayout";
import { normalizePanelDialogue } from "./dialogueUtils";
import { CHARACTER_SHEET_MODEL, FEATURE_FLAGS, MAX_CONTINUITY_PANELS } from "./modelPolicy";
import { applyGeneratedReference, collectAutoReferenceTasks } from "./autoReferences";
import { createSystemNotification } from "./db";
import { prependCappedHistory, appendCappedHistory } from "./projectStorage";
import { ApiError } from "./apiClient";
import { computeDefaultBubblePositions } from "./bubbleLayout";
import {
  buildContinuityFromWorld,
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
import { appendAgentEvent, patchAgentCard, transitionAgentRun } from "./comicAgentRun";

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

  const buildCardStatus = (status: GenerationStatus): ComicAgentCardStatus => {
    if (status.isActive) return "active";
    if (/^failed/i.test(status.currentStepDescription)) return "failed";
    if (/^stopped/i.test(status.currentStepDescription)) return "blocked";
    if (status.progress >= 99 || status.currentStepDescription === "Complete") return "done";
    return "blocked";
  };

  const updateStatus = (overrides: Partial<GenerationStatus>) => {
    currentStatus = { ...currentStatus, ...overrides };
    onUpdate(project.id, (prev) => ({
      state: {
        ...prev.state,
        generationStatus: currentStatus,
        agentRun: patchAgentCard(prev.state.agentRun, "build", {
          status: buildCardStatus(currentStatus),
          summary: currentStatus.currentStepDescription,
          progress: Math.round(Math.min(Math.max(currentStatus.progress || 0, 0), 100))
        })
      }
    }));
  };

  // Cap the in-memory log buffer so a long run can't grow status (and the per-tick state writes)
  // without bound. Storage drops logs entirely (see sanitizeProjectForStorage); this bounds memory.
  const MAX_RUN_LOGS = 200;
  const persistedLogStatus = (message: string): "info" | "blocked" | "failed" => {
    if (/error|failed/i.test(message)) return "failed";
    if (/warning|stopped|limit|timeout|⚠/i.test(message)) return "blocked";
    return "info";
  };

  const addLog = (message: string) => {
    const newLog = { timestamp: Date.now(), message };
    const logs = [...currentStatus.logs, newLog];
    updateStatus({ logs: logs.length > MAX_RUN_LOGS ? logs.slice(-MAX_RUN_LOGS) : logs });
    onUpdate(project.id, (prev) => ({
      state: {
        ...prev.state,
        agentRun: appendAgentEvent(prev.state.agentRun, {
          kind: "build",
          status: persistedLogStatus(message),
          message,
          timestamp: newLog.timestamp
        })
      }
    }));
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
    onUpdate(project.id, (prev) => ({
      state: {
        ...prev.state,
        agentRun: transitionAgentRun(
          prev.state,
          [{ kind: "build", status: "active", summary: "Starting build run.", progress: 0 }],
          {
            kind: "build",
            status: "info",
            message: "Started the build agent."
          }
        )
      }
    }));
    addLog("Starting generation process...");
    addLog(`Story mood: ${storyMood.label} (${storyMood.brightness} palette). ${storyMood.summary}`);

    // --- Phase 0a: auto style anchor -------------------------------------------------
    // Strict mode used to hard-fail the whole run when no style image existed. Instead,
    // generate one style anchor from the chosen style prompt so the run can proceed with
    // a real visual lock — the #1 "generation blocked" cause for new users.
    let styleResolved = initialStyleResolution.resolution.resolved;
    if (!styleResolved && !state.styleImageId && (state.stylePrompt || "").trim()) {
      updateStatus({ currentStepDescription: "Creating style anchor…" });
      addLog("No style image found — generating a style anchor from your chosen style.");
      try {
        const anchorPrompt = buildImagePrompt({
          stage: "style",
          stylePrompt: state.stylePrompt,
          moodGuidance: storyMood.promptGuidance,
          creativeDirection: state.creativeDirection || undefined,
          sceneContext: state.scenes[0]?.synopsis || undefined
        });
        const anchor = await generateImage(
          anchorPrompt,
          state.styleAspectRatio || "1:1",
          state.imageResolution || "1K",
          [],
          project.id,
          {
            abortSignal: controller.signal,
            stage: "style",
            meta: { source: { type: "style", id: state.selectedStyleId || "auto_style", label: "Auto style anchor" }, auto_reference: 1, runId: panelRunId }
          }
        );
        if (anchor?.imageId && anchor.imageUrl) {
          const anchorVariant = {
            id: state.selectedStyleId || `auto_style_${Date.now()}`,
            prompt: state.stylePrompt,
            imageId: anchor.imageId,
            imageUrl: anchor.imageUrl,
            category: state.styleCategory || "Auto",
            aspectRatio: state.styleAspectRatio || "1:1",
            resolution: state.imageResolution || "1K",
            generatedAt: Date.now()
          };
          const existingVariant = (state.styleVariants || []).find((variant) => variant.id === anchorVariant.id);
          const styleVariants = existingVariant
            ? (state.styleVariants || []).map((variant) => (variant.id === anchorVariant.id ? { ...variant, ...anchorVariant } : variant))
            : [...(state.styleVariants || []), anchorVariant];
          state = {
            ...state,
            styleVariants,
            selectedStyleId: anchorVariant.id,
            styleImageId: anchor.imageId,
            styleImageUrl: anchor.imageUrl,
            styleLockStatus: "resolved",
            styleLockResolvedAt: Date.now()
          };
          styleResolved = true;
          addLog("Style anchor created and locked for this run.");
          onUpdate(project.id, (prev) => ({
            state: {
              ...prev.state,
              styleVariants: state.styleVariants,
              selectedStyleId: state.selectedStyleId,
              styleImageId: state.styleImageId,
              styleImageUrl: state.styleImageUrl,
              styleLockStatus: state.styleLockStatus,
              styleLockResolvedAt: state.styleLockResolvedAt
            }
          }));
        }
      } catch (error: any) {
        addLog(`Style anchor generation failed (${error?.message || "unknown error"}) — continuing with the style prompt only.`);
      }
    }

    // --- Phase 0b: auto character/world reference sheets ------------------------------
    // Generate a turnaround/concept sheet for every entity that has no visual reference,
    // so the continuity system has something to inject into panel prompts. Missing
    // references used to block strict runs outright; now they're created on demand.
    if (FEATURE_FLAGS.ENABLE_CHAR_SHEETS) {
      const referenceTasks = collectAutoReferenceTasks(state);
      if (referenceTasks.length > 0) {
        updateStatus({ currentStepDescription: `Creating ${referenceTasks.length} reference sheet${referenceTasks.length === 1 ? "" : "s"}…` });
        addLog(`Creating reference sheets for: ${referenceTasks.map((task) => task.name).join(", ")}.`);
        const queue = [...referenceTasks];
        const workers = new Array(Math.min(3, queue.length)).fill(null).map(async () => {
          while (queue.length > 0) {
            if (isCanceled(project.id)) return;
            const task = queue.shift();
            if (!task) return;
            try {
              const sheetPrompt = buildImagePrompt({
                stage: task.kind === "character" ? "character_sheet" : "world",
                stylePrompt: state.stylePrompt,
                subjectName: task.name,
                subjectDescription: task.description,
                extraNotes: task.kind !== "character" ? `Concept art for ${task.kind === "item" ? "Item" : "Location"}` : undefined
              });
              const refIds = [state.styleImageId, ...task.uploadedReferenceIds].filter((id): id is string => Boolean(id));
              const generated = await generateImage(sheetPrompt, "1:1", "1K", refIds, project.id, {
                abortSignal: controller.signal,
                stage: "world",
                lockedModelId: CHARACTER_SHEET_MODEL,
                meta: {
                  source: { type: task.kind, id: task.id, label: task.name },
                  auto_reference: 1,
                  runId: panelRunId
                }
              });
              if (generated?.imageId && generated.imageUrl) {
                state = { ...state, ...applyGeneratedReference(state, task, generated.imageId, generated.imageUrl) };
                addLog(`Reference ready: ${task.name}`);
              } else {
                addLog(`⚠ Reference generation returned no image for ${task.name} — its panels may drift.`);
              }
            } catch (error: any) {
              addLog(`⚠ Reference generation failed for ${task.name} (${error?.message || "unknown error"}) — its panels may drift.`);
            }
          }
        });
        await Promise.all(workers);
        if (isCanceled(project.id)) {
          addLog("Generation stopped by user.");
          stopWithStatus("Stopped");
          return;
        }
        const rebuiltContinuity = buildContinuityFromWorld(state.scenes, state.characters, state.items, state.locations, state.continuity);
        state = { ...state, continuity: rebuiltContinuity };
        state = { ...state, worldHash: hashWorld(state) };
        onUpdate(project.id, (prev) => ({
          state: {
            ...prev.state,
            characters: state.characters,
            items: state.items,
            locations: state.locations,
            continuity: rebuiltContinuity,
            worldHash: state.worldHash
          }
        }));
      }
    }

    // Snapshot only the small STYLE inputs used for this run, so single-panel re-rolls stay
    // faithful even if the style/mood is edited later. References are NOT duplicated here —
    // each panel already stores its own continuity.referenceImageIds (see regen below), which
    // keeps project state lean instead of copying the whole world on every generation.
    const generationSnapshot = {
      takenAt: Date.now(),
      styleImageId: state.styleImageId,
      stylePrompt: state.stylePrompt,
      selectedStyleId: state.selectedStyleId,
      styleAspectRatio: state.styleAspectRatio,
      imageResolution: state.imageResolution,
      gridTemplateId: state.gridTemplateId,
      storyMood
    };
    const newSessionId = `sess_${(crypto.randomUUID?.() || Date.now().toString(36))}`;
    onUpdate(project.id, (prev) => ({
      state: {
        ...prev.state,
        storyMood,
        generationSnapshot,
        // Stamp a stable session id the first time this comic is generated; keep it on re-runs.
        sessionId: prev.state.sessionId || newSessionId
      }
    }));
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
    if (strictMode && !styleResolved) {
      // Previously a hard stop (STRICT_STYLE_LOCK_UNRESOLVED). The auto style anchor above
      // already tried to fix this; if it couldn't, generating with the style prompt alone
      // beats failing the whole run.
      addLog("Warning: no resolved style image — continuing with the style prompt only. Pick a style with a generated image for tighter consistency.");
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
      // Previously a hard stop ("Failed: Continuity" / missing references) — the worst
      // "my comic never generates" failure mode. Phase 0 above already auto-generated
      // what it could; remaining issues are logged honestly and the affected panels get
      // individually flagged for retry by the per-panel strict checks below.
      addLog(`Continuity has ${validation.issues.length} unresolved issue${validation.issues.length === 1 ? '' : 's'} — continuing; affected panels will be flagged for retry.`);
      validation.issues.slice(0, 6).forEach((issue) => addLog(`• ${issue.message}`));
    }

    const existingPanels = state.panels.map(panelToPlan);
    const planByScene = groupPanelsByScene(existingPanels);
    // Panels come from the user's page count times the layout's panels-per-page, then
    // get distributed across scenes. A target smaller than the scene count is raised so
    // every scene has at least one beat; otherwise a full comic can feel like it stopped
    // early after only one tiny page.
    const panelsPerPage = getGridTemplate(state.gridTemplateId)?.panelCount || 3;
    const requestedPages = Math.max(0, Math.floor(state.pageCount || 0));
    const sceneCount = state.scenes.length;
    const requestedPanelTarget = requestedPages > 0 && sceneCount > 0
      ? Math.max(sceneCount, requestedPages * panelsPerPage)
      : sceneCount * 3;
    const basePanelsPerScene = sceneCount > 0 ? Math.floor(requestedPanelTarget / sceneCount) : 0;
    const extraPanelScenes = sceneCount > 0 ? requestedPanelTarget % sceneCount : 0;
    const panelTargetsByScene = state.scenes.map((_, index) =>
      Math.max(1, basePanelsPerScene + (index < extraPanelScenes ? 1 : 0))
    );
    if (requestedPages > 0) {
      addLog(`Plan target: ${requestedPages} page${requestedPages === 1 ? '' : 's'} x ${panelsPerPage} panels = ${requestedPanelTarget} total panels across ${sceneCount} scene${sceneCount === 1 ? '' : 's'}.`);
    }
    // Seed the estimate per-scene: a scene with an existing plan contributes its real
    // panel count; a scene still needing planning is assumed to be its distributed
    // target. This generalizes both the fresh run and the resume case.
    let totalPanelsEstimate = state.scenes.reduce(
      (sum, scene, index) => sum + (planByScene.get(scene.id)?.length || panelTargetsByScene[index] || 3),
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

	    for (const [sceneIndex, scene] of state.scenes.entries()) {
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
	      const targetPanelsForScene = panelTargetsByScene[sceneIndex] || 3;
	      if (breakdown.length === 0) {
        updateStatus({ currentStepDescription: `Planning Scene ${scene.id}` });
        addLog(`Planning Scene ${scene.id}: ${scene.synopsis.substring(0, 30)}...`);

        try {
          const panelData = await generatePanelBreakdown(
            scene,
            state.stylePrompt,
            state.layoutType,
            project.id,
	            targetPanelsForScene,
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

	          totalPanelsEstimate = totalPanelsEstimate - targetPanelsForScene + breakdown.length;
        } catch (e: any) {
          addLog(`Error planning scene ${scene.id}: ${e.message}`);
          throw e; // Stop generation if planning fails
        }
      }

      // --- Batched parallel generation (GENERATION_BATCH_SIZE at a time) ---
      // 4 panels in flight at once: fewer batches => less wall-clock wait. Individual failures
      // are isolated by Promise.allSettled below and flagged for retry, so a larger batch can't
      // sink the whole run if one panel rate-limits.
      const GENERATION_BATCH_SIZE = 4;
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
                  style_lock_resolved: styleResolved,
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
    if (import.meta.env.DEV) {
      console.info(
        `[METRICS] panel_ref_count=${averageRefCount} zero_ref_panel=${zeroRefPanelCount} mixed_model_in_run=${mixedModelInRun} multi_frame_description_detected=${multiFrameDetectedCount} style_lock_resolved=${styleResolved ? 1 : 0} stale_downstream_fingerprint=${staleDownstreamFingerprint ? 1 : 0} dropped_entity_count=${droppedEntityCount} ungrounded_entity_count=${ungroundedEntityCount}`
      );
    }

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

  // Prefer the generation-time STYLE snapshot so a re-roll matches how the comic was
  // originally drawn — even if the style/mood was edited since. References themselves come
  // from the panel's own stored continuity.referenceImageIds (below), so we don't need to
  // duplicate the world here. Older comics without a snapshot fall back to live state.
  const snap = state.generationSnapshot;
  const refState = snap
    ? {
        ...state,
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
  const builtReferencePack = buildPanelReferencePack(refState, normalizedTargetPanel, {
    styleImageId: refState.styleImageId,
    lastPanelImageId: state.panels
      .slice(0, panelIndex)
      .map((panel) => panel.imageId)
      .filter((imageId): imageId is string => !!imageId)
      .at(-1),
    maxReferences: 8
  });
  // Prefer the references this panel was actually drawn with (captured at generation onto
  // the panel) so a re-roll reproduces the original look even if entities were edited or
  // deleted since. Only rebuild from live state when the panel never recorded any.
  const storedReferenceIds = (normalizedTargetPanel.continuity?.referenceImageIds || [])
    .filter((id): id is string => !!id);
  const referencePack = storedReferenceIds.length
    ? { ...builtReferencePack, imageIds: storedReferenceIds.slice(0, 8) }
    : builtReferencePack;
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
