// Editorial layer over the raw OpenRouter model catalog.
//
// This is the "from our product's perspective" commentary the Model Library
// surfaces: what each model is good for in a comic pipeline, what's possible,
// and the real drawbacks. Most fields are *derived* from the model's
// capabilities so the catalog stays correct as OpenRouter's list changes;
// a small overrides table adds hand-written notes for notable models.

import type { CatalogModel } from './providers/types.js';

export type DreamStreamRole = 'text-brain' | 'dialogue' | 'panel-art' | 'cover' | 'qc';
export type Band = 'free' | 'low' | 'medium' | 'high';

export type AnnotatedModel = CatalogModel & {
  /** Where this model fits in the comic pipeline. */
  roles: DreamStreamRole[];
  costBand: Band;
  /** Plain-language, product-POV limitations. */
  drawbacks: string[];
  /** What this model unlocks for comics. */
  possibilities: string[];
  /** Optional hand-written editorial note for notable models. */
  editorialNote?: string;
};

type AnnotationOverride = {
  /** Substring matched against the model id (case-insensitive). */
  match: string;
  note?: string;
  roles?: DreamStreamRole[];
};

// Curated notes for notable models. Keep short; derived fields cover the rest.
const ANNOTATION_OVERRIDES: AnnotationOverride[] = [
  {
    match: 'gemini-2.5-flash-image',
    roles: ['panel-art', 'cover'],
    note: 'Nano Banana — best-in-class character consistency via multi-image reference input. Default panel artist.'
  },
  {
    match: 'gemini-3-pro-image',
    roles: ['panel-art', 'cover'],
    note: 'Premium image quality with reference support. Use for hero pages / covers where cost is justified.'
  },
  {
    match: 'seedream',
    roles: ['panel-art'],
    note: 'Strong standalone stills at a flat per-image price; weaker at holding a character across many panels.'
  },
  {
    match: 'gpt-image',
    roles: ['panel-art', 'cover'],
    note: 'Good prompt adherence; reference-image control is more limited than Gemini image models.'
  },
  {
    match: 'gemini-2.5-flash',
    roles: ['text-brain', 'dialogue'],
    note: 'Fast, reliable structured output. Solid default for script analysis and panel breakdowns.'
  }
];

const PER_TOKEN_LOW = 0.000001; // < $1 / 1M tokens
const PER_TOKEN_MEDIUM = 0.000005; // < $5 / 1M tokens
const PER_IMAGE_LOW = 0.01;
const PER_IMAGE_MEDIUM = 0.04;

const costBandFor = (model: CatalogModel): Band => {
  if (model.isFree) return 'free';
  if (model.supportsImageOutput) {
    const price = model.pricing.imagePerImage;
    if (price === 0) return 'free';
    if (price < PER_IMAGE_LOW) return 'low';
    if (price < PER_IMAGE_MEDIUM) return 'medium';
    return 'high';
  }
  const price = model.pricing.completionPerToken;
  if (price === 0) return 'free';
  if (price < PER_TOKEN_LOW) return 'low';
  if (price < PER_TOKEN_MEDIUM) return 'medium';
  return 'high';
};

const deriveRoles = (model: CatalogModel): DreamStreamRole[] => {
  const roles: DreamStreamRole[] = [];
  if (model.supportsImageOutput) {
    roles.push('panel-art', 'cover');
  } else {
    roles.push('text-brain', 'dialogue', 'qc');
  }
  return roles;
};

const deriveDrawbacks = (model: CatalogModel): string[] => {
  const drawbacks: string[] = [];
  if (model.supportsImageOutput && !model.supportsImageInput) {
    drawbacks.push(
      'Text→image only: cannot take reference images, so holding a character/world consistent across panels is weak.'
    );
  }
  if (!model.supportsImageOutput && !model.supportsJsonOutput) {
    drawbacks.push('No structured-output mode: planning steps rely on JSON repair and are less reliable.');
  }
  if (model.isFree) {
    drawbacks.push('Free tier: subject to rate limits and may be slow, deprioritized, or temporarily unavailable.');
  }
  if (costBandFor(model) === 'high') {
    drawbacks.push('Premium cost — use deliberately (covers, hero pages, final exports).');
  }
  return drawbacks;
};

const derivePossibilities = (model: CatalogModel): string[] => {
  const possibilities: string[] = [];
  if (model.supportsImageInput && model.supportsImageOutput) {
    possibilities.push('Accepts reference images → strong character and world consistency across panels.');
  }
  if (model.supportsJsonOutput) {
    possibilities.push('Reliable structured output for script analysis and panel planning.');
  }
  if ((model.contextLength || 0) >= 200_000) {
    possibilities.push('Large context window: can plan a long script in a single pass.');
  }
  if (model.isFree) {
    possibilities.push('Free to run — ideal for the script/planning pipeline on the BYOK free tier.');
  }
  return possibilities;
};

export const annotateModel = (model: CatalogModel): AnnotatedModel => {
  const override = ANNOTATION_OVERRIDES.find((entry) =>
    model.id.toLowerCase().includes(entry.match.toLowerCase())
  );
  return {
    ...model,
    roles: override?.roles || deriveRoles(model),
    costBand: costBandFor(model),
    drawbacks: deriveDrawbacks(model),
    possibilities: derivePossibilities(model),
    editorialNote: override?.note
  };
};

export const annotateModels = (models: CatalogModel[]): AnnotatedModel[] => models.map(annotateModel);
