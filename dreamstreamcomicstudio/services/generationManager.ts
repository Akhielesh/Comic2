import { ComicState, Project, GenerationStatus, ComicPanel, Scene } from "../types";
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
  collectPanelReferenceImageIds,
  getEntityById,
  getSceneBinding,
  resolvePanelContinuity,
  validateContinuityState
} from "./continuity";

const generationControllers = new Map<string, AbortController>();
const generationCanceled = new Set<string>();

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
  const state = project.state;
  const startTime = Date.now();
  const ratioConfig = resolveAspectRatio(state, state.styleAspectRatio);

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

    const validation = validateContinuityState(state);
    onUpdate(project.id, (prev) => ({
      state: {
        ...prev.state,
        continuity: prev.state.continuity
          ? { ...prev.state.continuity, validation }
          : prev.state.continuity
      }
    }));
    if ((state.continuity?.lockLevel || "strict") === "strict" && !validation.isValid) {
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
          breakdown = panelData.map((panel, idx) => ({
            id: `s${scene.id}-p${idx}-${Date.now()}`,
            sceneId: scene.id,
            description: panel.description,
            prompt: panel.description,
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
          })).map(normalizePanelDialogue);

          totalPanelsEstimate = totalPanelsEstimate - 3 + breakdown.length;
        } catch (e: any) {
          addLog(`Error planning scene ${scene.id}: ${e.message}`);
          throw e; // Stop generation if planning fails
        }
      }

      // --- Batched parallel generation (GENERATION_BATCH_SIZE at a time) ---
      const GENERATION_BATCH_SIZE = 3;
      const sceneBinding = getSceneBinding(state, scene.id);
      const characterContext = state.characters.map(c => `${c.name}: ${c.description}`).join('. ');
      const itemContext = state.items.map(i => `${i.name}: ${i.description}`).join('. ');
      const locContext = state.locations.map(l => `${l.name}: ${l.description}`).join('. ');

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
          const panelContinuity = resolvePanelContinuity(state, panelData);
          const continuityEntityNames = (panelContinuity.requiredEntityIds || [])
            .map((entityId) => getEntityById(state, entityId)?.name)
            .filter((name): name is string => !!name);
          const lockedLocationName = panelContinuity.locationId
            ? getEntityById(state, panelContinuity.locationId)?.name
            : undefined;

          const imagePrompt = buildImagePrompt({
            stage: "panel",
            stylePrompt: state.stylePrompt,
            layoutType: state.layoutType === 'custom' ? state.customLayoutPrompt : state.layoutType,
            characters: characterContext,
            items: itemContext,
            locations: locContext,
            sceneAction: panelData.description,
            setting: scene.setting,
            continuitySummary: continuitySummary || undefined,
            recentPanels: continuityText || undefined,
            requiredEntityNames: continuityEntityNames.join(", ") || undefined,
            lockedLocation: lockedLocationName,
            continuityLock: panelContinuity.continuityNotes || (sceneBinding ? `Scene ${sceneBinding.sceneId} strict lock` : "strict")
          });

          let generatedImageId = panelData.imageId;
          let generatedImageUrl = panelData.imageUrl;

          if (!generatedImageId || !generatedImageUrl) {
            const continuityImageIds = [
              ...(state.styleImageId ? [state.styleImageId] : []),
              ...collectPanelReferenceImageIds(state, panelData),
              ...continuityImageIdsSnapshot
            ];
            const generated = await generateImage(
              imagePrompt,
              ratioConfig.modelRatio,
              state.imageResolution,
              continuityImageIds,
              project.id,
              {
                abortSignal: controller.signal,
                stage: "panel",
                cropToRatio: ratioConfig.cropRatio,
                meta: {
                  source: {
                    type: "panel",
                    id: panelData.id,
                    label: `Scene ${scene.id} Panel ${panelIndex + 1}`
                  },
                  sceneId: scene.id,
                  panelIndex,
                  regen: false
                }
              }
            );
            generatedImageId = generated?.imageId;
            generatedImageUrl = generated?.imageUrl;
          }

          return normalizePanelDialogue({
            ...panelData,
            continuity: {
              ...panelContinuity,
              referenceImageIds: collectPanelReferenceImageIds(state, panelData)
            },
            dialogueBlocks: panelData.dialogueBlocks?.length
              ? computeDefaultBubblePositions(panelData.dialogueBlocks)
              : panelData.dialogueBlocks,
            imageId: generatedImageId,
            imageUrl: generatedImageUrl,
            imageIdHistory: prependCappedHistory(panelData.imageIdHistory, generatedImageId),
            imageUrlHistory: prependCappedHistory(panelData.imageUrlHistory, generatedImageUrl),
            isPlanned: false
          });
        });

        const batchResults = await Promise.allSettled(batchPromises);

        // Process batch results — failed panels still get added with failureReason
        let batchHadBillingError = false;
        for (let i = 0; i < batchResults.length; i++) {
          const result = batchResults[i];
          const panelData = batch[i];

          if (result.status === 'fulfilled') {
            const newPanel = result.value;
            freshPanels.push(newPanel);
            if (newPanel.imageId) {
              recentPanelImageIds.push(newPanel.imageId);
            }
            recentPanelDescriptions.push(panelData.description || "");
          } else {
            // Panel failed — add it with failure marker so user can retry later
            const error = result.reason;
            const billingDetails = error instanceof ApiError
              ? ((error.details as any)?.details || error.details)
              : null;
            if (billingDetails && typeof billingDetails === 'object' && typeof (billingDetails as any).reason === 'string') {
              batchHadBillingError = true;
              const resetAt = (billingDetails as any).resetAt ? new Date((billingDetails as any).resetAt).toLocaleString() : 'next reset';
              addLog(`Token limit reached (${(billingDetails as any).reason}). Wait until ${resetAt} or upgrade.`);
            }
            addLog(`⚠ Panel failed: ${(panelData.description || "").substring(0, 40)}… — ${error?.message || 'Unknown error'}`);

            const panelContinuity = resolvePanelContinuity(state, panelData);
            freshPanels.push(normalizePanelDialogue({
              ...panelData,
              continuity: { ...panelContinuity, referenceImageIds: collectPanelReferenceImageIds(state, panelData) },
              imageId: undefined as any,
              imageUrl: undefined as any,
              imageIdHistory: panelData.imageIdHistory || [],
              imageUrlHistory: panelData.imageUrlHistory || [],
              isPlanned: false,
              failureReason: error?.message || 'Generation failed'
            }));
            recentPanelDescriptions.push(panelData.description || "");
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
  const state = project.state;
  const panelIndex = state.panels.findIndex((p) => p.id === panelId);
  if (panelIndex === -1) throw new Error("Panel not found");

  const targetPanel = state.panels[panelIndex];
  const scene = state.scenes.find((s) => s.id === targetPanel.sceneId);
  const sceneBinding = scene ? getSceneBinding(state, scene.id) : undefined;

  // 1. Gather Context
  const continuityRefIds = collectPanelReferenceImageIds(state, targetPanel);
  const previousIds = state.panels
    .slice(Math.max(0, panelIndex - 2), panelIndex)
    .map((p) => p.imageId)
    .filter((id): id is string => !!id);

  // Deduplicate reference IDs
  const referenceIds = Array.from(new Set([
    ...(state.styleImageId ? [state.styleImageId] : []),
    ...continuityRefIds,
    ...previousIds
  ]));

  // Context strings
  const characterContext = state.characters.map((c) => `${c.name}: ${c.description}`).join('. ');
  const itemContext = state.items.map((i) => `${i.name}: ${i.description}`).join('. ');
  const locContext = state.locations.map((l) => `${l.name}: ${l.description}`).join('. ');
  const recentPanels = state.panels
    .slice(Math.max(0, panelIndex - 3), panelIndex)
    .map(p => p.description)
    .join(" | ");

  const panelContinuity = resolvePanelContinuity(state, targetPanel);
  const requiredEntityNames = (panelContinuity.requiredEntityIds || [])
    .map((entityId) => getEntityById(state, entityId)?.name)
    .filter((name): name is string => !!name)
    .join(', ');

  const lockedLocation = panelContinuity.locationId
    ? getEntityById(state, panelContinuity.locationId)?.name
    : undefined;

  // 2. Build Prompt
  const prompt = buildImagePrompt({
    stage: "panel_regen",
    stylePrompt: state.stylePrompt,
    layoutType: state.layoutType === 'custom' ? state.customLayoutPrompt : state.layoutType,
    sceneAction: targetPanel.description,
    characters: characterContext, // Full context for regen to be safe
    items: itemContext,
    locations: locContext,
    setting: scene?.setting,
    continuitySummary: state.continuitySummary || undefined,
    recentPanels: recentPanels || undefined,
    instructions, // USER INSTRUCTIONS
    requiredEntityNames: requiredEntityNames || undefined,
    lockedLocation,
    continuityLock: panelContinuity.continuityNotes || (sceneBinding ? `Scene ${sceneBinding.sceneId} strict lock` : "strict")
  });

  const ratioConfig = resolveAspectRatio(state, state.styleAspectRatio);

  // 3. Generate
  const generated = await generateImage(
    prompt,
    ratioConfig.modelRatio,
    state.imageResolution,
    referenceIds,
    project.id,
    {
      stage: 'panel_regen',
      cropToRatio: ratioConfig.cropRatio,
      meta: {
        source: {
          type: 'panel',
          id: targetPanel.id,
          label: `Scene ${targetPanel.sceneId} Panel ${panelIndex + 1}`
        },
        sceneId: targetPanel.sceneId,
        panelIndex,
        regen: true
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
        imageId: generated.imageId,
        imageUrl: generated.imageUrl,
        imageIdHistory: appendCappedHistory(p.imageIdHistory, generated.imageId),
        imageUrlHistory: appendCappedHistory(p.imageUrlHistory, generated.imageUrl),
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
