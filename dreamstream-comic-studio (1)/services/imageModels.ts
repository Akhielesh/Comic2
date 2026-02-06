import { ImageModelDefinition, ImageProviderId } from "../types";
import { IMAGE_MODEL } from "./modelPolicy";

export const FLUX_SCHNELL_MODEL_ID = "pixazo/flux-1-schnell";
export const GEMINI_IMAGE_MODEL_ID = IMAGE_MODEL;

export const IMAGE_PROVIDER_LOCK: ImageProviderId | null = "flux";
export const DEFAULT_IMAGE_PROVIDER: ImageProviderId = "flux";

export const IMAGE_MODELS: ImageModelDefinition[] = [
  {
    id: FLUX_SCHNELL_MODEL_ID,
    label: "Flux Schnell (Pixazo Free)",
    provider: "flux",
    supportsReferences: false,
    supportsAspectRatio: true,
    defaultSteps: 4,
    isFree: true
  },
  {
    id: GEMINI_IMAGE_MODEL_ID,
    label: "Gemini 2.5 Flash Image",
    provider: "gemini",
    supportsReferences: true,
    supportsAspectRatio: true,
    defaultSteps: 1
  }
];

export const getImageModelByProvider = (provider: ImageProviderId) =>
  IMAGE_MODELS.find((model) => model.provider === provider) || IMAGE_MODELS[0];
