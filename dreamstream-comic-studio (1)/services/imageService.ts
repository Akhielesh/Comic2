import { AspectRatio, ImageResolution } from "../types";
import { ApiTimings } from "../apiTypes";
import { IMAGE_TEXT_BLOCKER } from "./modelPolicy";
import { getImageProvider } from "./appSettings";
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
  const provider = getImageProvider();

  if (provider === "flux") {
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

  return generateGeminiImage(prompt, aspectRatio, resolution, referenceImageIds, projectId, options);
};
