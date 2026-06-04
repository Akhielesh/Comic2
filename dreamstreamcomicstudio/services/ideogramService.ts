import { AspectRatio, GenerationArtifact, ImageResolution } from "../types";
import { cropImageToRatio } from "./imageUtils";
import { saveArtifact, saveImage, getImageUrl, saveTestImage, getTestImageUrl } from "./db";
import { IDEOGRAM_V2_MODEL_ID } from "./imageModels";
import { post } from "./apiClient";
import { IdeogramGenerateRequest, IdeogramGenerateResponse } from "../apiTypes";
import { updateDebugState } from "./debugStore";

const recordArtifact = async (artifact: Omit<GenerationArtifact, "id">) => {
  try {
    await saveArtifact({ id: crypto.randomUUID(), ...artifact });
  } catch (e) {
    console.warn("Failed to record Ideogram artifact", e);
  }
};

type IdeogramGenerateArgs = {
  prompt: string;
  aspectRatio?: AspectRatio;
  resolution?: ImageResolution;
  negativePrompt?: string;
  seed?: number;
  modelId?: string;
  projectId?: string;
  stage?: string;
  cropToRatio?: string;
  abortSignal?: AbortSignal;
  storage?: "project" | "test";
  meta?: Record<string, unknown>;
};

export const generateIdeogramImage = async ({
  prompt,
  aspectRatio = "1:1",
  resolution = "1K",
  negativePrompt,
  seed,
  modelId = IDEOGRAM_V2_MODEL_ID,
  projectId,
  stage,
  cropToRatio,
  abortSignal,
  storage = "project",
  meta
}: IdeogramGenerateArgs): Promise<{ imageId: string; imageUrl: string; timings?: { apiMs: number; saveMs: number; totalMs: number } }> => {
  const startPerf = performance.now();
  try {
    updateDebugState('ideogram', { lastRequestAt: Date.now(), lastRequestType: 'generate_ideogram', lastError: undefined });

    const response = await post<IdeogramGenerateRequest, IdeogramGenerateResponse>('/api/image/ideogram', {
      prompt,
      aspectRatio,
      resolution,
      negativePrompt,
      seed,
      modelId,
      stage,
      projectId,
      storage,
      cropToRatio
    }, { signal: abortSignal });

    const saveStart = performance.now();
    let imageId = response.imageId;
    let imageUrl = response.imageUrl;
    let usedLocalSave = false;

    if (!imageId || !imageUrl || storage === "test") {
      usedLocalSave = true;
      let dataUrl = response.dataUrl;
      if (!dataUrl) {
        throw new Error('Ideogram response did not include image payload.');
      }
      if (cropToRatio) {
        dataUrl = await cropImageToRatio(dataUrl, cropToRatio);
      }
      imageId = storage === "test" ? await saveTestImage(dataUrl) : await saveImage(dataUrl);
      imageUrl = storage === "test"
        ? (await getTestImageUrl(imageId)) || dataUrl
        : (await getImageUrl(imageId)) || dataUrl;
    }

    const localSaveMs = Math.round(performance.now() - saveStart);
    const saveMs = usedLocalSave ? localSaveMs : (response.timings?.saveMs ?? localSaveMs);
    const apiMs = response.timings?.apiMs ?? 0;
    const totalMs = response.timings?.totalMs ?? apiMs + saveMs;
    const durationMs = Math.round(performance.now() - startPerf);

    if (projectId) {
      void recordArtifact({
        projectId,
        timestamp: Date.now(),
        type: "image",
        provider: "ideogram",
        model: response.model || modelId,
        stage: stage || "generation",
        prompt: response.prompt || prompt,
        outputImageId: imageId,
        inputImageIds: [],
        aspectRatio,
        resolution,
        success: true,
        timings: { apiMs, saveMs, totalMs, durationMs },
        meta,
        usage: { promptChars: prompt.length }
      });
    }

    return { imageId, imageUrl, timings: { apiMs, saveMs, totalMs } };
  } catch (error) {
    if (projectId) {
      const durationMs = Math.round(performance.now() - startPerf);
      void recordArtifact({
        projectId,
        timestamp: Date.now(),
        type: "image",
        provider: "ideogram",
        model: modelId,
        stage: stage || "generation",
        prompt,
        inputImageIds: [],
        aspectRatio,
        resolution,
        success: false,
        error: (error as Error)?.message || String(error),
        timings: { durationMs },
        meta
      });
    }
    updateDebugState('ideogram', { lastError: String(error) });
    throw error;
  }
};
