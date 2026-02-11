import { AspectRatio, ImageResolution } from "../types";
import { ApiTimings } from "../apiTypes";
import { IMAGE_TEXT_BLOCKER } from "./modelPolicy";
import { getModelForTask } from "./appSettings";
import { createSystemNotification } from "./db";
import {
  GEMINI_IMAGE_MODEL_ID,
  IMAGE_MODELS,
  getDefaultImageModelByProvider,
  getImageModelById
} from "./imageModels";
import { generateFluxImage } from "./fluxService";
import { generateImage as generateGeminiImage } from "./geminiService";
import { ApiError } from "./apiClient";

export const generateImage = async (
  prompt: string,
  aspectRatio: AspectRatio = "1:1",
  resolution: ImageResolution = "1K",
  referenceImageIds: string[] = [],
  projectId?: string,
  options?: { abortSignal?: AbortSignal; stage?: string; cropToRatio?: string; storage?: "project" | "test"; meta?: Record<string, unknown> }
): Promise<{ imageId: string; imageUrl: string; timings?: ApiTimings } | undefined> => {
  const stage = options?.stage || 'general';
  const requestedModelId = getModelForTask(stage);
  const hasReferences = referenceImageIds.length > 0;
  const requestedModel = getImageModelById(requestedModelId);
  const fallbackGeminiModel = getImageModelById(GEMINI_IMAGE_MODEL_ID) || getDefaultImageModelByProvider("gemini");
  const fallbackFluxModel = getDefaultImageModelByProvider("flux");

  const notifyFallback = async (message: string) => {
    console.warn(`[Image Fallback] ${message}`);
    try {
      await createSystemNotification(message, projectId ? { projectId, stage } : undefined);
    } catch (error) {
      console.warn("Failed to publish fallback notification", error);
    }
  };

  const resolveInitialModel = () => {
    if (requestedModel) {
      if (hasReferences && !requestedModel.supportsReferences) {
        void notifyFallback(
          `Requested model "${requestedModel.label}" does not support reference images. Auto-switched to "${fallbackGeminiModel.label}".`
        );
        return fallbackGeminiModel;
      }
      return requestedModel;
    }
    if (hasReferences) {
      void notifyFallback(
        `No compatible image model configured for reference-guided generation. Auto-switched to "${fallbackGeminiModel.label}".`
      );
      return fallbackGeminiModel;
    }
    void notifyFallback(
      `Configured model "${requestedModelId}" is unavailable. Auto-switched to "${fallbackFluxModel.label}".`
    );
    return fallbackFluxModel;
  };

  const runModel = async (modelId: string, provider: "flux" | "gemini") => {
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
        meta: {
          ...(options?.meta || {}),
          modelId
        }
      });
    }
    return generateGeminiImage(prompt, aspectRatio, resolution, referenceImageIds, projectId, {
      ...options,
      modelId
    });
  };

  const isKeyError = (error: unknown) => {
    const detail = error instanceof ApiError
      ? `${error.message} ${JSON.stringify(error.details || {})}`.toLowerCase()
      : String(error).toLowerCase();
    return detail.includes("api key") || detail.includes("invalid api key") || detail.includes("api_key_invalid");
  };

  const isModelError = (error: unknown) => {
    const detail = error instanceof ApiError
      ? `${error.message} ${JSON.stringify(error.details || {})}`.toLowerCase()
      : String(error).toLowerCase();
    return detail.includes("model") && (detail.includes("not found") || detail.includes("not supported"));
  };

  const isRateOrServerError = (error: unknown) =>
    error instanceof ApiError && (error.status === 429 || error.status >= 500);

  const shouldAutoFallback = (error: unknown) =>
    isKeyError(error) || isModelError(error) || isRateOrServerError(error);

  const primaryModel = resolveInitialModel();
  const fallbackOrder = IMAGE_MODELS
    .filter((model) => model.id !== primaryModel.id)
    .filter((model) => !hasReferences || model.supportsReferences);

  try {
    return await runModel(primaryModel.id, primaryModel.provider);
  } catch (primaryError) {
    if (!shouldAutoFallback(primaryError) || fallbackOrder.length === 0) {
      throw primaryError;
    }

    for (const candidate of fallbackOrder) {
      try {
        await notifyFallback(
          `Image generation fallback: "${primaryModel.label}" failed (${primaryError instanceof Error ? primaryError.message : String(primaryError)}). Retrying with "${candidate.label}".`
        );
        return await runModel(candidate.id, candidate.provider);
      } catch (fallbackError) {
        if (!shouldAutoFallback(fallbackError)) {
          throw fallbackError;
        }
      }
    }

    throw primaryError;
  }
};
