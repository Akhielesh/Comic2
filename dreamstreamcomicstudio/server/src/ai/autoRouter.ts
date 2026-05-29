// Auto-router: the app picks the best currently-available model for a task from the
// live OpenRouter catalog, free-first to stay under budget. This replaces hardcoded
// model defaults (which break when a model is retired, e.g. a 404 "No endpoints
// found") — we only ever choose from models the catalog says exist right now.
//
// Pair with the provider's fallbackModel (see ai/providers/openrouter.ts): if a
// free model is rate-limited (429) or unavailable (404), generation retries on a
// reliable fallback so the flow never hard-fails.

import { getCatalog } from '../services/modelCatalog.js';
import type { AnnotatedModel } from './catalogAnnotations.js';

// Last-resort fallbacks if the live catalog can't be reached. Kept to current,
// widely-available, low-cost models (not the retired Gemini free experiment).
export const TEXT_FALLBACK = 'openai/gpt-4o-mini';
export const IMAGE_FALLBACK = 'google/gemini-2.5-flash-image';

// Preference order among FREE text models (capable, generally reliable families).
const FREE_TEXT_PRIORITY = [
  'llama-3.3', 'llama-3.1', 'deepseek-chat', 'deepseek', 'qwen-2.5', 'qwen',
  'gemini-2.0-flash', 'gemini', 'mistral', 'gemma'
];

const isTextModel = (m: AnnotatedModel) =>
  !m.supportsImageOutput && (m.outputModalities?.includes('text') ?? true);

const isImageModel = (m: AnnotatedModel) => m.supportsImageOutput;

const byCompletionPrice = (a: AnnotatedModel, b: AnnotatedModel) =>
  (a.pricing?.completionPerToken || 0) - (b.pricing?.completionPerToken || 0);

const byImagePrice = (a: AnnotatedModel, b: AnnotatedModel) =>
  (a.pricing?.imagePerImage || 0) - (b.pricing?.imagePerImage || 0);

/**
 * Best text model for the budget. `preferFree` (default true) picks a capable free
 * model from the live catalog; if none/empty it falls back to the cheapest text model.
 */
export const pickTextModel = async (opts?: { preferFree?: boolean }): Promise<string> => {
  const preferFree = opts?.preferFree !== false;
  try {
    const { models } = await getCatalog();
    const text = models.filter(isTextModel);
    if (text.length === 0) return preferFree ? TEXT_FALLBACK : TEXT_FALLBACK;

    if (preferFree) {
      const free = text.filter((m) => m.isFree);
      if (free.length) {
        for (const needle of FREE_TEXT_PRIORITY) {
          const hit = free.find((m) => m.id.toLowerCase().includes(needle));
          if (hit) return hit.id;
        }
        return free[0].id;
      }
    }
    // No free (or not preferred) → cheapest capable text model.
    return [...text].sort(byCompletionPrice)[0]?.id || TEXT_FALLBACK;
  } catch {
    return TEXT_FALLBACK;
  }
};

/** Best image model for the budget: free image model if one exists, else cheapest per-image. */
export const pickImageModel = async (opts?: { preferFree?: boolean }): Promise<string> => {
  const preferFree = opts?.preferFree !== false;
  try {
    const { models } = await getCatalog();
    const image = models.filter(isImageModel);
    if (image.length === 0) return IMAGE_FALLBACK;
    if (preferFree) {
      const free = image.filter((m) => m.isFree);
      if (free.length) return free[0].id;
    }
    return [...image].sort(byImagePrice)[0]?.id || IMAGE_FALLBACK;
  } catch {
    return IMAGE_FALLBACK;
  }
};
