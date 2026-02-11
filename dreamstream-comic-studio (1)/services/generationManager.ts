import { ComicState, Project, GenerationStatus, ComicPanel, Scene } from "../types";
import { generatePanelBreakdown, updateContinuitySummary } from "./geminiService";
import { generateImage } from "./imageService";
import { buildImagePrompt } from "./imagePrompt";
import { resolveAspectRatio, sliceGridImage } from "./imageUtils";
import { normalizePanelDialogue } from "./dialogueUtils";
import { MAX_CONTINUITY_PANELS } from "./modelPolicy";
import { saveImage, getImageUrl } from "./db";

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
            { abortSignal: controller.signal, stage: "preview" }
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
            isPlanned: true
          })).map(normalizePanelDialogue);

          totalPanelsEstimate = totalPanelsEstimate - 3 + breakdown.length;
        } catch (e: any) {
          addLog(`Error planning scene ${scene.id}: ${e.message}`);
          throw e; // Stop generation if planning fails
        }
      }

      const BATCH_SIZE = 4;
      for (let i = 0; i < breakdown.length; i += BATCH_SIZE) {
         if (isCanceled(project.id)) {
            addLog("Generation stopped by user.");
            stopWithStatus("Stopped");
            return;
         }

         const batch = breakdown.slice(i, i + BATCH_SIZE);
         const batchContainsNew = batch.some(p => !p.imageId);

         if (!batchContainsNew) {
            addLog(`Skipping existing panels ${i+1}-${Math.min(i+BATCH_SIZE, breakdown.length)}`);
            batch.forEach(p => {
                 const newPanel = normalizePanelDialogue({ ...p, isPlanned: false });
                 freshPanels.push(newPanel);
                 if (newPanel.imageId) recentPanelImageIds.push(newPanel.imageId);
                 recentPanelDescriptions.push(newPanel.description || "");
            });
            stepsCompleted += batch.length;
            continue;
         }

         updateStatus({ currentStepDescription: `Generating Scene ${scene.id} (Page Batch ${Math.floor(i/BATCH_SIZE) + 1})` });
         addLog(`Generating page grid for Scene ${scene.id} (Panels ${i+1}-${i+batch.length})...`);

         const characterContext = state.characters.map(c => `${c.name}: ${c.description}`).join('. ');
         const itemContext = state.items.map(i => `${i.name}: ${i.description}`).join('. ');
         const locContext = state.locations.map(l => `${l.name}: ${l.description}`).join('. ');
         const continuityText = recentPanelDescriptions.slice(-MAX_CONTINUITY_PANELS).join(" | ");

         // Use "Page Grid" prompt if batch is full (4 panels) or nearly full
         const usePageGrid = batch.length >= 2;

         if (usePageGrid) {
             try {
                 const promptOptions = {
                    stage: "page_grid" as const,
                    stylePrompt: state.stylePrompt,
                    // Use a layout prompt that encourages grid
                    layoutType: "grid",
                    characters: characterContext,
                    items: itemContext,
                    locations: locContext,
                    sceneAction: "Comic page layout",
                    setting: scene.setting,
                    continuitySummary: continuitySummary || undefined,
                    recentPanels: continuityText || undefined,
                    panels: batch.map((p, idx) => ({ index: idx, description: p.description || "" })),
                    extraNotes: "Generate a 2x2 grid comic page. 4 equal panels. Borders. High quality."
                 };
                 const imagePrompt = buildImagePrompt(promptOptions);

                 // Generate 1 big image
                 const generated = await generateImage(
                    imagePrompt,
                    "1:1", // Force square for 2x2 grid
                    state.imageResolution,
                    recentPanelImageIds.slice(-MAX_CONTINUITY_PANELS),
                    project.id,
                    {
                        abortSignal: controller.signal,
                        stage: "page_grid",
                        meta: {
                            sceneId: scene.id,
                            batchIndex: i
                        }
                    }
                 );

                 if (generated?.imageUrl) {
                     // Slice it!
                     // Determine grid size based on batch length (2-4 = 2x2, 1 = 1x1 fallback)
                     const slices = await sliceGridImage(generated.imageUrl, 2, 2);

                     for (let j = 0; j < batch.length; j++) {
                         const panelData = batch[j];
                         const sliceUrl = slices[j]; // Grab corresponding slice
                         if (!sliceUrl) continue;

                         // Save slice as new image
                         const sliceId = await saveImage(sliceUrl);
                         const slicePublicUrl = await getImageUrl(sliceId) || sliceUrl;

                         const newPanel: ComicPanel = normalizePanelDialogue({
                            ...panelData,
                            imageId: sliceId,
                            imageUrl: slicePublicUrl,
                            imageIdHistory: [sliceId, ...(panelData.imageIdHistory || [])],
                            imageUrlHistory: [slicePublicUrl, ...(panelData.imageUrlHistory || [])],
                            isPlanned: false
                         });
                         freshPanels.push(newPanel);
                         recentPanelImageIds.push(sliceId);
                         recentPanelDescriptions.push(newPanel.description || "");
                     }
                     stepsCompleted += batch.length;
                 } else {
                     throw new Error("Grid generation returned no image.");
                 }
             } catch (e: any) {
                 addLog(`Batch failed (${e.message}), falling back to individual...`);
                 // Fallback to individual
                 for (const panelData of batch) {
                    // ... (existing fallback code logic) ...
                    // Shortened for brevity, assuming standard fallback logic similar to previous implementation
                    // For safety, let's just push them as planned/failed or re-try individually?
                    // Let's implement robust fallback:
                    try {
                        const singlePrompt = buildImagePrompt({
                            stage: "panel",
                            stylePrompt: state.stylePrompt,
                            sceneAction: panelData.description,
                            setting: scene.setting
                        });
                        const singleGen = await generateImage(singlePrompt, ratioConfig.modelRatio, "1K", [], project.id, { stage: "panel" });
                        const newPanel = normalizePanelDialogue({
                            ...panelData,
                            imageId: singleGen.imageId,
                            imageUrl: singleGen.imageUrl,
                            isPlanned: false
                        });
                        freshPanels.push(newPanel);
                    } catch (err) {
                        freshPanels.push(normalizePanelDialogue(panelData)); // Keep as planned if fails
                    }
                    stepsCompleted++;
                 }
             }
         } else {
             // Single panel batch, just generate normally
             for (const panelData of batch) {
                 if (isCanceled(project.id)) return;
                 // ... single generation logic ...
                 // (Re-using the logic from before for single items)
                 const imagePrompt = buildImagePrompt({
                    stage: "panel",
                    stylePrompt: state.stylePrompt,
                    sceneAction: panelData.description,
                    setting: scene.setting,
                    continuitySummary: continuitySummary
                 });
                 try {
                    const generated = await generateImage(
                        imagePrompt,
                        ratioConfig.modelRatio,
                        state.imageResolution,
                        recentPanelImageIds.slice(-2),
                        project.id,
                        { abortSignal: controller.signal, stage: "panel" }
                    );
                    freshPanels.push(normalizePanelDialogue({
                        ...panelData,
                        imageId: generated.imageId,
                        imageUrl: generated.imageUrl,
                        isPlanned: false
                    }));
                    if(generated.imageId) recentPanelImageIds.push(generated.imageId);
                    recentPanelDescriptions.push(panelData.description || "");
                 } catch (e) {
                     addLog(`Panel failed: ${(e as Error).message}`);
                     freshPanels.push(normalizePanelDialogue(panelData));
                 }
                 stepsCompleted++;
             }
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
