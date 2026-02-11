import { AspectRatio, ImageResolution } from "../types";
import { ApiTimings } from "../apiTypes";
import { IMAGE_TEXT_BLOCKER } from "./modelPolicy";
import { getModelForTask } from "./appSettings";
import { getImageModelByProvider } from "./imageModels";
import { generateFluxImage } from "./fluxService";
import { generateImage as generateGeminiImage } from "./geminiService";

export const generateImage = async (
  prompt: string,
  aspectRatio: AspectRatio = "1:1",
  resolution: ImageResolution = "1K",
  referenceImageIds: string[] = [],
  projectId?: string,
  options?: { abortSignal?: AbortSignal; stage?: string; cropToRatio?: string; storage?: "project" | "test"; meta?: Record<string, unknown> }
): Promise<{ imageId: string; imageUrl: string; timings?: ApiTimings } | undefined> => {
  // Determine which model to use based on the stage (task)
  const stage = options?.stage || 'general';
  const modelId = getModelForTask(stage);
  const modelDef = getImageModelByProvider(modelId as any) || getImageModelByProvider('flux'); // Fallback logic needs to handle ID vs Provider

  // Improved Model Resolution: check if ID is known, else rely on provider prefix or default
  const isFlux = modelId.includes('flux') || modelDef.provider === 'flux';

  if (isFlux) {
    return generateFluxImage({
      prompt,
      aspectRatio,
      resolution,
      negativePrompt: IMAGE_TEXT_BLOCKER,
      projectId,
      stage: options?.stage,
      cropToRatio: options?.cropToRatio,
      abortSignal: options?.abortSignal,
      storage: options?.storage,
      meta: options?.meta
    });
  }

  // Otherwise assume Gemini or similar
  return generateGeminiImage(prompt, aspectRatio, resolution, referenceImageIds, projectId, { ...options, modelId });
};
