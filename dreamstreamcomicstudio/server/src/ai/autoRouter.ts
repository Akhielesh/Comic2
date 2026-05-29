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

const byContextDesc = (a: AnnotatedModel, b: AnnotatedModel) =>
  (b.contextLength || 0) - (a.contextLength || 0);

/** Spend preference for auto-selection. `free` preserves today's free-first behavior. */
export type CostPref = 'free' | 'cheap' | 'quality';

type PickOpts = {
  /** Back-compat: true ⇒ costPref 'free', false ⇒ 'cheap'. Ignored when costPref is set. */
  preferFree?: boolean;
  costPref?: CostPref;
  /** Hard capability gate — only models passing this are eligible. */
  filter?: (m: AnnotatedModel) => boolean;
  /** Soft preference — when some eligible models pass, rank those first. */
  prefer?: (m: AnnotatedModel) => boolean;
};

const resolveCostPref = (opts?: PickOpts): CostPref =>
  opts?.costPref ?? (opts?.preferFree === false ? 'cheap' : 'free');

/**
 * Best text model for the budget AND capabilities, chosen from the live catalog.
 * `filter` gates by required capabilities (e.g. structured-JSON for analyze/panel
 * stages) so an incapable model is never auto-selected; `costPref` controls free-first
 * vs cheapest vs quality. Falls back to TEXT_FALLBACK when the catalog is empty/unreachable.
 */
export const pickTextModel = async (opts?: PickOpts): Promise<string> => {
  const costPref = resolveCostPref(opts);
  const gate = opts?.filter ?? (() => true);
  try {
    const { models } = await getCatalog();
    let text = models.filter(isTextModel).filter(gate);
    if (text.length === 0) return TEXT_FALLBACK;
    if (opts?.prefer) {
      const preferred = text.filter(opts.prefer);
      if (preferred.length) text = preferred;
    }
    if (costPref === 'quality') {
      return [...text].sort(byContextDesc)[0]?.id || TEXT_FALLBACK;
    }
    if (costPref === 'free') {
      const free = text.filter((m) => m.isFree);
      if (free.length) {
        for (const needle of FREE_TEXT_PRIORITY) {
          const hit = free.find((m) => m.id.toLowerCase().includes(needle));
          if (hit) return hit.id;
        }
        return free[0].id;
      }
    }
    // 'cheap' (or 'free' with no free model available) → cheapest eligible text model.
    return [...text].sort(byCompletionPrice)[0]?.id || TEXT_FALLBACK;
  } catch {
    return TEXT_FALLBACK;
  }
};

/** Best image model for the budget and capabilities (gate with `filter` for image output). */
export const pickImageModel = async (opts?: PickOpts): Promise<string> => {
  const costPref = resolveCostPref(opts);
  const gate = opts?.filter ?? (() => true);
  try {
    const { models } = await getCatalog();
    let image = models.filter(isImageModel).filter(gate);
    if (image.length === 0) return IMAGE_FALLBACK;
    if (opts?.prefer) {
      const preferred = image.filter(opts.prefer);
      if (preferred.length) image = preferred;
    }
    if (costPref === 'free') {
      const free = image.filter((m) => m.isFree);
      if (free.length) return free[0].id;
    }
    return [...image].sort(byImagePrice)[0]?.id || IMAGE_FALLBACK;
  } catch {
    return IMAGE_FALLBACK;
  }
};
