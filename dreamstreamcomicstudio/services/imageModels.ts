import type { ImageModelDefinition, ImageProviderId } from '../types';
import { IMAGE_MODEL, isProPlanTier } from './modelPolicy';

export const FLUX_SCHNELL_MODEL_ID = 'pixazo/flux-1-schnell';
export const GEMINI_IMAGE_MODEL_ID = IMAGE_MODEL;
export const NANO_BANANA_PRO_MODEL_ID = 'gemini-3-pro-image-preview';
export const IDEOGRAM_V2_MODEL_ID = 'ideogram/ideogram-v2';
export const IDEOGRAM_V2_TURBO_MODEL_ID = 'ideogram/ideogram-v2-turbo';

export const IMAGE_PROVIDER_LOCK: ImageProviderId | null = null;
export const DEFAULT_IMAGE_PROVIDER: ImageProviderId = 'flux';

export const IMAGE_MODELS: ImageModelDefinition[] = [
  {
    id: FLUX_SCHNELL_MODEL_ID,
    label: 'Flux Schnell (Pixazo Free)',
    provider: 'flux',
    supportsReferences: false,
    supportsAspectRatio: true,
    defaultSteps: 4,
    isFree: true
  },
  {
    id: GEMINI_IMAGE_MODEL_ID,
    label: 'Gemini 2.5 Flash Image (Nano Banana)',
    provider: 'gemini',
    supportsReferences: true,
    supportsAspectRatio: true,
    defaultSteps: 1
  },
  {
    id: NANO_BANANA_PRO_MODEL_ID,
    label: 'Gemini 3 Pro Image (Nano Banana Pro)',
    provider: 'gemini',
    supportsReferences: true,
    supportsAspectRatio: true,
    defaultSteps: 1,
    minimumPlanTier: 'pro'
  },
  {
    id: IDEOGRAM_V2_MODEL_ID,
    label: 'Ideogram 2.0',
    provider: 'ideogram',
    supportsReferences: false,
    supportsAspectRatio: true,
    defaultSteps: 1
  },
  {
    id: IDEOGRAM_V2_TURBO_MODEL_ID,
    label: 'Ideogram 2.0 Turbo',
    provider: 'ideogram',
    supportsReferences: false,
    supportsAspectRatio: true,
    defaultSteps: 1
  }
];

export const isImageModelAllowedForPlan = (modelId: string, planTier?: string | null) => {
  const model = IMAGE_MODELS.find((entry) => entry.id === modelId);
  if (!model) return false;
  if (model.minimumPlanTier === 'pro') {
    return isProPlanTier(planTier);
  }
  return true;
};

export const getAllowedImageModelsForPlan = (planTier?: string | null) =>
  IMAGE_MODELS.filter((model) => isImageModelAllowedForPlan(model.id, planTier));

export const getDefaultImageModelForPlan = (planTier?: string | null) => {
  const allowed = getAllowedImageModelsForPlan(planTier);
  if (!allowed.length) return IMAGE_MODELS[0];
  if (!isProPlanTier(planTier)) {
    return allowed.find((model) => model.provider === 'flux') || allowed[0];
  }
  return allowed.find((model) => model.id === GEMINI_IMAGE_MODEL_ID) || allowed[0];
};

export const getImageModelByProvider = (provider: ImageProviderId) =>
  IMAGE_MODELS.find((model) => model.provider === provider) || IMAGE_MODELS[0];

export const getImageModelById = (modelId: string) =>
  IMAGE_MODELS.find((model) => model.id === modelId);

export const getDefaultImageModelByProvider = (provider: ImageProviderId) =>
  IMAGE_MODELS.find((model) => model.provider === provider) || IMAGE_MODELS[0];
