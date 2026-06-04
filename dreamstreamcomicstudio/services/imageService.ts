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
import { emitBillingSummaryRefresh } from "./billing";
import { generateFluxImage } from "./fluxService";
import { generateIdeogramImage } from "./ideogramService";
import { generateImage as generateGeminiImage } from "./geminiService";
import { ApiError } from "./apiClient";

export type GenerateImageOptions = {
  abortSignal?: AbortSignal;
  stage?: string;
  cropToRatio?: string;
  storage?: "project" | "test";
  meta?: Record<string, unknown>;
  continuitySensitive?: boolean;
  requiredReferences?: boolean;
  lockedModelId?: string;
};

export type GenerateImageResult = {
  imageId: string;
  imageUrl: string;
  timings?: ApiTimings;
  modelId?: string;
  fallbackOccurred?: boolean;
  fallbackFromModel?: string;
  fallbackToModel?: string;
  referenceDropped?: boolean;
};

export const generateImage = async (
  prompt: string,
  aspectRatio: AspectRatio = "1:1",
  resolution: ImageResolution = "1K",
  referenceImageIds: string[] = [],
  projectId?: string,
  options?: GenerateImageOptions
): Promise<GenerateImageResult | undefined> => {
  const stage = options?.stage || 'general';
  const requestedModelId = options?.lockedModelId?.trim() || getModelForTask(stage);
  const hasReferences = referenceImageIds.length > 0;
  const continuitySensitive = Boolean(options?.continuitySensitive);
  const requiredReferences = Boolean(options?.requiredReferences);
  const requiresReferenceCapableModel = requiredReferences || (continuitySensitive && hasReferences);
  const requestedModel = getImageModelById(requestedModelId);
  const fallbackGeminiModel = getImageModelById(GEMINI_IMAGE_MODEL_ID)
    || IMAGE_MODELS.find((model) => model.provider === "gemini" && model.supportsReferences)
    || getDefaultImageModelByProvider("gemini");
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
      if (requiresReferenceCapableModel && !requestedModel.supportsReferences) {
        if (!fallbackGeminiModel?.supportsReferences) {
          throw new Error("No reference-capable image model is available for continuity-sensitive generation.");
        }
        void notifyFallback(
          `Requested model "${requestedModel.label}" does not support reference images required for continuity. Auto-switched to "${fallbackGeminiModel.label}".`
        );
        return fallbackGeminiModel;
      }
      if (hasReferences && !requestedModel.supportsReferences) {
        if (!fallbackGeminiModel?.supportsReferences) {
          throw new Error("No reference-capable image model is available while references were supplied.");
        }
        void notifyFallback(
          `Requested model "${requestedModel.label}" does not support reference images. Auto-switched to "${fallbackGeminiModel.label}".`
        );
        return fallbackGeminiModel;
      }
      return requestedModel;
    }
    if (requiresReferenceCapableModel || hasReferences) {
      if (!fallbackGeminiModel?.supportsReferences) {
        throw new Error("No compatible image model is configured for reference-guided generation.");
      }
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

  const runModel = async (
    modelId: string,
    provider: "flux" | "gemini" | "ideogram",
    runtimeMeta?: {
      fallbackOccurred?: boolean;
      fallbackFromModel?: string;
      fallbackToModel?: string;
      referenceDropped?: boolean;
    }
  ) => {
    const meta = {
      ...(options?.meta || {}),
      fallbackOccurred: Boolean(runtimeMeta?.fallbackOccurred),
      fallbackFromModel: runtimeMeta?.fallbackFromModel,
      fallbackToModel: runtimeMeta?.fallbackToModel,
      referenceDropped: Boolean(runtimeMeta?.referenceDropped)
    };
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
          ...meta,
          modelId
        }
      });
    }
    if (provider === "ideogram") {
      return generateIdeogramImage({
        prompt,
        aspectRatio,
        resolution,
        negativePrompt: IMAGE_TEXT_BLOCKER,
        modelId,
        projectId,
        stage: options?.stage,
        cropToRatio: options?.cropToRatio,
        abortSignal: options?.abortSignal,
        storage: options?.storage,
        meta: {
          ...meta,
          modelId
        }
      });
    }
    return generateGeminiImage(prompt, aspectRatio, resolution, referenceImageIds, projectId, {
      ...options,
      meta,
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
  let fallbackOrder = IMAGE_MODELS
    .filter((model) => model.id !== primaryModel.id);
  if (hasReferences || requiresReferenceCapableModel) {
    fallbackOrder = fallbackOrder.filter((model) => model.supportsReferences);
  }

  try {
    const result = await runModel(primaryModel.id, primaryModel.provider, {
      fallbackOccurred: false,
      fallbackFromModel: undefined,
      fallbackToModel: undefined,
      referenceDropped: false
    });
    emitBillingSummaryRefresh();
    return {
      ...result,
      modelId: primaryModel.id,
      fallbackOccurred: false,
      fallbackFromModel: undefined,
      fallbackToModel: undefined,
      referenceDropped: false
    };
  } catch (primaryError) {
    if (!shouldAutoFallback(primaryError) || fallbackOrder.length === 0) {
      throw primaryError;
    }

    for (const candidate of fallbackOrder) {
      try {
        const referenceDropped =
          hasReferences && !candidate.supportsReferences;
        const referenceFallbackNote =
          referenceDropped
            ? ` "${candidate.label}" does not support reference images, so fallback will run without references.`
            : "";
        if ((requiresReferenceCapableModel || requiredReferences) && referenceDropped) {
          continue;
        }
        await notifyFallback(
          `Image generation fallback: "${primaryModel.label}" failed (${primaryError instanceof Error ? primaryError.message : String(primaryError)}). Retrying with "${candidate.label}".${referenceFallbackNote}`
        );
        const result = await runModel(candidate.id, candidate.provider, {
          fallbackOccurred: true,
          fallbackFromModel: primaryModel.id,
          fallbackToModel: candidate.id,
          referenceDropped
        });
        emitBillingSummaryRefresh();
        return {
          ...result,
          modelId: candidate.id,
          fallbackOccurred: true,
          fallbackFromModel: primaryModel.id,
          fallbackToModel: candidate.id,
          referenceDropped
        };
      } catch (fallbackError) {
        if (!shouldAutoFallback(fallbackError)) {
          throw fallbackError;
        }
      }
    }

    throw primaryError;
  }
};
