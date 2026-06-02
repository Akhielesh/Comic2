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
import type { CostClass } from '../shared/pricing';

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
  /** Exposes step-by-step reasoning / thinking (o1/o3, DeepSeek-R1, QwQ, etc.). */
  reasoning: boolean;
  longContext: boolean;
  contextLength: number;
  /** True only when the strict shared classification is free_verified. */
  isFree: boolean;
  /** Full multi-dimensional class — never collapse to free/paid in UI. */
  costClass: CostClass;
  isPremium: boolean;
}

export type AppFeature =
  | 'reference-images'
  | 'character-consistency'
  | 'image-editing'
  | 'structured-planning'
  | 'reasoning'
  | 'high-context';

export interface FeatureSupport {
  supported: boolean;
  reason?: string;
}

// Curated hints for capabilities the catalog API doesn't expose directly.
const MULTI_REF_STRONG = ['gemini-2.5-flash-image', 'gemini-3-pro-image', 'gpt-image', 'seedream'];
const PREMIUM_HINTS = ['gpt-image', 'gemini-3-pro', 'dall-e-3', 'imagen-3', 'gpt-4o', 'claude-3.7', 'opus'];
// Reasoning/thinking model families (id-based) for catalogs that don't advertise it in params.
const REASONING_RE = /(?:^|[/:_-])(?:o1|o3|o4-mini|r1|qwq|deepseek-r1?|magistral|phi-4-reasoning|grok-3-mini)(?:[:_-]|$)|reasoning|thinking/i;

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
    reasoning:
      params.includes('reasoning') || params.includes('include_reasoning') || params.includes('reasoning_effort') || REASONING_RE.test(id),
    longContext: contextLength >= 200_000,
    contextLength,
    // Strict: free only when the server classified the model as free_verified.
    // Do NOT fall back to costBand === 'free' here — that conflated zero-priced
    // token-billed image models with truly-free ones.
    isFree: model.costClass === 'free_verified',
    costClass: model.costClass,
    isPremium: model.costBand === 'high' || includesAny(id, PREMIUM_HINTS)
  };
};

export type CapabilityTone = 'free' | 'image' | 'text' | 'vision' | 'edit' | 'reason' | 'json' | 'tools' | 'context';
export interface CapabilityBadge { label: string; tone: CapabilityTone; }

/** Display badges that showcase what a model can actually do (modality flow + reasoning). */
export const capabilityBadges = (model: CatalogModel): CapabilityBadge[] => {
  const c = getCapabilities(model);
  const out: CapabilityBadge[] = [];
  if (c.isFree) out.push({ label: 'Free', tone: 'free' });
  if (c.imageOutput) out.push({ label: 'Text→Image', tone: 'image' });
  else out.push({ label: 'Text', tone: 'text' });
  if (c.imageInput && !c.imageOutput) out.push({ label: 'Image→Text (vision)', tone: 'vision' });
  else if (c.imageInput) out.push({ label: 'Refs', tone: 'vision' });
  if (c.imageEditing) out.push({ label: 'Image editing', tone: 'edit' });
  if (c.reasoning) out.push({ label: 'Reasoning', tone: 'reason' });
  if (c.structuredJson && !c.imageOutput) out.push({ label: 'JSON', tone: 'json' });
  if (c.toolUse) out.push({ label: 'Tools', tone: 'tools' });
  if (c.longContext) out.push({ label: `${Math.round(c.contextLength / 1000)}K ctx`, tone: 'context' });
  return out;
};

/** Search facet keywords → capability predicate, so "free image" auto-filters semantically. */
export const QUERY_FACETS: { keys: string[]; test: (c: ModelCapabilities, m: CatalogModel) => boolean }[] = [
  { keys: ['free'], test: (c) => c.isFree },
  { keys: ['paid'], test: (c) => !c.isFree },
  { keys: ['text'], test: (c) => c.textOutput && !c.imageOutput },
  { keys: ['image', 'text-to-image', 'text2image', 'generate'], test: (c) => c.imageOutput },
  { keys: ['vision', 'image-to-text', 'multimodal'], test: (c) => c.imageInput },
  { keys: ['edit', 'editing', 'inpaint', 'inpainting'], test: (c) => c.imageEditing },
  { keys: ['reasoning', 'reason', 'thinking'], test: (c) => c.reasoning },
  { keys: ['json', 'structured'], test: (c) => c.structuredJson },
  { keys: ['tools', 'tool', 'function', 'functions'], test: (c) => c.toolUse },
  { keys: ['cheap', 'low-cost', 'budget'], test: (c, m) => m.costBand === 'free' || m.costBand === 'low' },
  { keys: ['openrouter'], test: (_c, m) => m.source === 'openrouter' },
  { keys: ['nvidia'], test: (_c, m) => m.source === 'nvidia' }
];

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
    case 'reasoning':
      return caps.reasoning
        ? { supported: true }
        : { supported: false, reason: 'No step-by-step reasoning mode — fine for most stages, but complex planning may benefit from a reasoning model.' };
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
  { feature: 'reasoning', label: 'Step-by-step reasoning' },
  { feature: 'high-context', label: 'Long-context (full script)' }
];
