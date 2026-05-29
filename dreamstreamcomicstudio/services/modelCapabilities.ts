// Model capability index.
//
// Derives a structured capability profile per model from the live OpenRouter catalog
// (modalities, supported_parameters, context, pricing) plus a small curated overrides
// table for things the API doesn't advertise. Feature gating across the app reads from
// here so controls enable/disable per the active model and the experience stays
// consistent (shown-but-disabled-with-reason instead of silent breakage).
//
// See docs/decisions/0003 and docs/features/models-and-api-configuration.md

import type { CatalogModel } from './modelCatalog';

export interface ModelCapabilities {
  id: string;
  textOutput: boolean;
  imageOutput: boolean;
  /** Accepts reference images as input. */
  imageInput: boolean;
  /** Strong at holding a character/world across multiple reference images. */
  multiImageRefs: boolean;
  /** Can edit/transform an existing image (image in + image out). */
  imageEditing: boolean;
  structuredJson: boolean;
  toolUse: boolean;
  longContext: boolean;
  contextLength: number;
  isFree: boolean;
  isPremium: boolean;
}

export type AppFeature =
  | 'reference-images'
  | 'character-consistency'
  | 'image-editing'
  | 'structured-planning'
  | 'high-context';

export interface FeatureSupport {
  supported: boolean;
  reason?: string;
}

// Curated hints for capabilities the catalog API doesn't expose directly.
const MULTI_REF_STRONG = ['gemini-2.5-flash-image', 'gemini-3-pro-image', 'gpt-image', 'seedream'];
const PREMIUM_HINTS = ['gpt-image', 'gemini-3-pro', 'dall-e-3', 'imagen-3', 'gpt-4o', 'claude-3.7', 'opus'];

const includesAny = (value: string, needles: string[]) =>
  needles.some((n) => value.toLowerCase().includes(n));

export const getCapabilities = (model: CatalogModel): ModelCapabilities => {
  const id = model.id;
  const params = model.supportedParameters || [];
  const imageOutput = model.supportsImageOutput || model.outputModalities.includes('image');
  const imageInput = model.supportsImageInput || model.inputModalities.includes('image');
  const contextLength = model.contextLength || 0;
  return {
    id,
    textOutput: model.outputModalities.includes('text') || !imageOutput,
    imageOutput,
    imageInput,
    // Multi-ref consistency: needs image input, and either a known-strong model or
    // an image-output model (which round-trips references for consistency).
    multiImageRefs: imageInput && (includesAny(id, MULTI_REF_STRONG) || imageOutput),
    imageEditing: imageInput && imageOutput,
    structuredJson:
      model.supportsJsonOutput || params.includes('response_format') || params.includes('structured_outputs'),
    toolUse: params.includes('tools') || params.includes('tool_choice') || params.includes('functions'),
    longContext: contextLength >= 200_000,
    contextLength,
    isFree: model.isFree || model.costBand === 'free',
    isPremium: model.costBand === 'high' || includesAny(id, PREMIUM_HINTS)
  };
};

/** Whether an app feature is usable with the given model, and why not when it isn't. */
export const featureSupport = (caps: ModelCapabilities | null, feature: AppFeature): FeatureSupport => {
  if (!caps) return { supported: false, reason: 'No model selected.' };
  switch (feature) {
    case 'reference-images':
      return caps.imageInput
        ? { supported: true }
        : { supported: false, reason: "This model can't take reference images — pick a reference-capable image model." };
    case 'character-consistency':
      return caps.multiImageRefs
        ? { supported: true }
        : { supported: false, reason: 'Weak at holding a character across panels — use a multi-reference image model (e.g. a Gemini image model).' };
    case 'image-editing':
      return caps.imageEditing
        ? { supported: true }
        : { supported: false, reason: "Can't edit an existing image — pick a model that accepts image input and outputs images." };
    case 'structured-planning':
      return caps.structuredJson
        ? { supported: true }
        : { supported: false, reason: 'No structured/JSON output — planning relies on repair and is less reliable.' };
    case 'high-context':
      return caps.longContext
        ? { supported: true }
        : { supported: false, reason: 'Short context window — long scripts may be truncated.' };
    default:
      return { supported: false, reason: 'Unknown feature.' };
  }
};

/** The app features this model unlocks, for display in the Model Library. */
export const FEATURE_LABELS: { feature: AppFeature; label: string }[] = [
  { feature: 'reference-images', label: 'Reference images' },
  { feature: 'character-consistency', label: 'Character consistency' },
  { feature: 'image-editing', label: 'Image editing / inpaint' },
  { feature: 'structured-planning', label: 'Structured planning' },
  { feature: 'high-context', label: 'Long-context (full script)' }
];
