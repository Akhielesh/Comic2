// Auto-router: the app picks the best currently-available model for a task from the
// live OpenRouter catalog, free-first to stay under budget. This replaces hardcoded
// model defaults (which break when a model is retired, e.g. a 404 "No endpoints
// found") — we only ever choose from models the catalog says exist right now.
//
// Pair with the provider's fallbackModel (see ai/providers/openrouter.ts): if a
// free model is rate-limited (429) or unavailable (404), generation retries on a
// reliable fallback so the flow never hard-fails — EXCEPT under 'free-only' mode,
// where we deliberately surface NoFreeModelAvailableError instead of silently
// charging the caller's key.

import { getCatalog } from '../services/modelCatalog.js';
import type { AnnotatedModel } from './catalogAnnotations.js';

// Last-resort fallbacks if the live catalog can't be reached. Kept to current,
// widely-available, low-cost models (not the retired Gemini free experiment).
// NOTE: these are PAID — never used under 'free-only' mode.
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

const isFreeVerified = (m: AnnotatedModel) =>
  m.costClass === 'free_verified' || m.id.toLowerCase().endsWith(':free');

const byCompletionPrice = (a: AnnotatedModel, b: AnnotatedModel) =>
  (a.pricing?.completionPerToken || 0) - (b.pricing?.completionPerToken || 0);

const byImagePrice = (a: AnnotatedModel, b: AnnotatedModel) =>
  (a.pricing?.imagePerImage || 0) - (b.pricing?.imagePerImage || 0);

const byContextDesc = (a: AnnotatedModel, b: AnnotatedModel) =>
  (b.contextLength || 0) - (a.contextLength || 0);

/**
 * Spend preference for auto-selection.
 *  - 'free'      free-first; falls back to cheapest paid when no free model exists.
 *  - 'cheap'     cheapest eligible model.
 *  - 'quality'   best-fit model regardless of cost.
 *  - 'free-only' STRICT free-only — never returns a paid id. Throws
 *                NoFreeModelAvailableError if no genuinely-free model passes the gate.
 */
export type CostPref = 'free' | 'cheap' | 'quality' | 'free-only';

/** Thrown by pickTextModel / pickImageModel under 'free-only' when no truly-free model exists. */
export class NoFreeModelAvailableError extends Error {
  readonly code = 'NO_FREE_MODEL_AVAILABLE' as const;
  readonly kind: 'text' | 'image';
  readonly stageHint?: string;
  constructor(kind: 'text' | 'image', stageHint?: string) {
    super(
      `No genuinely-free ${kind} model is currently available in the catalog` +
        (stageHint ? ` for ${stageHint}` : '') +
        '. Free-only mode is on, so the request is blocked rather than charging your key.'
    );
    this.name = 'NoFreeModelAvailableError';
    this.kind = kind;
    this.stageHint = stageHint;
  }
}

type PickOpts = {
  /** Back-compat: true ⇒ costPref 'free', false ⇒ 'cheap'. Ignored when costPref is set. */
  preferFree?: boolean;
  costPref?: CostPref;
  /** Hard capability gate — only models passing this are eligible. */
  filter?: (m: AnnotatedModel) => boolean;
  /** Soft preference — when some eligible models pass, rank those first. */
  prefer?: (m: AnnotatedModel) => boolean;
  /** Optional stage hint for the error message under 'free-only'. */
  stageHint?: string;
};

const resolveCostPref = (opts?: PickOpts): CostPref =>
  opts?.costPref ?? (opts?.preferFree === false ? 'cheap' : 'free');

/**
 * Best text model for the budget AND capabilities, chosen from the live catalog.
 * `filter` gates by required capabilities (e.g. structured-JSON for analyze/panel
 * stages) so an incapable model is never auto-selected; `costPref` controls free-first
 * vs cheapest vs quality vs free-only. Throws NoFreeModelAvailableError under 'free-only'
 * when no truly-free model passes the gate.
 */
export const pickTextModel = async (opts?: PickOpts): Promise<string> => {
  const costPref = resolveCostPref(opts);
  const gate = opts?.filter ?? (() => true);
  if (costPref === 'free-only') {
    // Strict: only free_verified models; no catalog → block (we can't prove it's free).
    let models: AnnotatedModel[];
    try {
      ({ models } = await getCatalog());
    } catch {
      throw new NoFreeModelAvailableError('text', opts?.stageHint);
    }
    const text = models.filter(isTextModel).filter(gate).filter(isFreeVerified);
    if (text.length === 0) throw new NoFreeModelAvailableError('text', opts?.stageHint);
    const ranked = opts?.prefer ? [...text.filter(opts.prefer), ...text.filter((m) => !opts.prefer!(m))] : text;
    for (const needle of FREE_TEXT_PRIORITY) {
      const hit = ranked.find((m) => m.id.toLowerCase().includes(needle));
      if (hit) return hit.id;
    }
    return ranked[0].id;
  }
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
      const free = text.filter(isFreeVerified);
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

// Strong coding-model families, best-first — used by the Studio agentic build loop's FIX
// stage, where code quality matters most. Free-first still applies (strong-open default;
// frontier coders via BYOK), but among eligible models these are preferred.
export const CODING_MODEL_PRIORITY = [
  'deepseek-coder', 'qwen-2.5-coder', 'qwen-coder', 'codestral', 'codellama', 'code-llama',
  'deepseek-v3', 'deepseek-chat', 'deepseek', 'qwen-2.5', 'qwen', 'llama-3.3',
  'gpt-4o', 'claude', 'gemini-2.0-flash', 'gemini'
];

/** True when a model id looks like a strong coding model. */
export const prefersCodingModel = (m: AnnotatedModel): boolean => {
  const id = m.id.toLowerCase();
  return CODING_MODEL_PRIORITY.some((needle) => id.includes(needle));
};

/**
 * Best model for code generation / fixing (the Studio build loop's FIX stage). Prefers
 * strong coding families; free-first by default — pass `costPref:'quality'` for BYOK/credit
 * users who want the strongest available coder. Falls back gracefully (via pickTextModel)
 * when no coding-specific model is in the catalog.
 */
export const pickCodingModel = async (opts?: PickOpts): Promise<string> => {
  const userPrefer = opts?.prefer;
  const prefer = userPrefer
    ? (m: AnnotatedModel) => prefersCodingModel(m) || userPrefer(m)
    : prefersCodingModel;
  return pickTextModel({ ...opts, prefer });
};

/**
 * Best image model. Under 'free-only', prefers NVIDIA's free-tier image models
 * (billing-bypassed via /api/image/nvidia, the genuinely-free image path) over
 * OpenRouter :free image models. Throws NoFreeModelAvailableError when none exist.
 */
export const pickImageModel = async (opts?: PickOpts): Promise<string> => {
  const costPref = resolveCostPref(opts);
  const gate = opts?.filter ?? (() => true);
  if (costPref === 'free-only') {
    let models: AnnotatedModel[];
    try {
      ({ models } = await getCatalog());
    } catch {
      throw new NoFreeModelAvailableError('image', opts?.stageHint);
    }
    const candidates = models.filter(isImageModel).filter(gate).filter(isFreeVerified);
    if (candidates.length === 0) throw new NoFreeModelAvailableError('image', opts?.stageHint);
    // NVIDIA free-tier image models are billing-bypassed in /api/image/nvidia, so they
    // are the cleanest genuinely-free path. Prefer them when both an NVIDIA and an
    // OpenRouter :free image model are present.
    const nvidia = candidates.filter((m) => m.source === 'nvidia');
    const ranked = nvidia.length ? nvidia : candidates;
    return (opts?.prefer ? ranked.find(opts.prefer) || ranked[0] : ranked[0]).id;
  }
  try {
    const { models } = await getCatalog();
    let image = models.filter(isImageModel).filter(gate);
    if (image.length === 0) return IMAGE_FALLBACK;
    if (opts?.prefer) {
      const preferred = image.filter(opts.prefer);
      if (preferred.length) image = preferred;
    }
    if (costPref === 'free') {
      const free = image.filter(isFreeVerified);
      if (free.length) return free[0].id;
    }
    return [...image].sort(byImagePrice)[0]?.id || IMAGE_FALLBACK;
  } catch {
    return IMAGE_FALLBACK;
  }
};
