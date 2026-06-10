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

// --- Adaptive model health: skip recently-failed (404/429) models ----------------
// Free models are frequently rate-limited; leading the fallback chain with one that's
// down makes OpenRouter burn ~15-20s waiting before it routes to a working model. We
// learn from that: when a chain falls OVER (the served model isn't the free one we led
// with), mark that model "down" for a short window so the next requests skip it and stay
// fast — then retry it once the window passes. Process-local, best-effort, self-healing.
const MODEL_DOWN_TTL_MS = 8 * 60_000;
const downUntil = new Map<string, number>();
export const markModelDown = (id: string, ttlMs = MODEL_DOWN_TTL_MS): void => {
  if (id) downUntil.set(id, Date.now() + ttlMs);
};
export const isModelDown = (id: string): boolean => {
  const until = downUntil.get(id);
  if (!until) return false;
  if (Date.now() > until) {
    downUntil.delete(id);
    return false;
  }
  return true;
};

// Preference order among FREE text models (capable, generally reliable families), refreshed
// for 2026: strong open generalists first. Needles are matched with id.includes(), so they must
// appear in real catalog ids (e.g. 'deepseek/deepseek-chat-v3.1:free', 'z-ai/glm-4.5-air:free').
// FAST generalists lead: Auto serves everyday chat, where a snappy capable model beats a
// heavyweight reasoner that queues for minutes on the free tier (the #1 'Auto feels broken'
// complaint). Reasoning-class frees (r1) sit late; users who want them can pin them.
const FREE_TEXT_PRIORITY = [
  'v3.1', 'deepseek-chat', 'glm-4.6', 'glm-4.5-air', 'glm-4.5', 'glm',
  'qwen3', 'qwen-2.5', 'qwen', 'kimi-k2', 'gpt-oss', 'llama-3.3', 'llama-3.1',
  'gemini-2.0-flash', 'gemini', 'mistral', 'gemma', 'deepseek-r1', 'deepseek'
];

// A free model advertising a huge param count in its id (550B-class) routinely sits queued
// past the request timeout on the free tier — never AUTO-route to it (pinning still works).
const paramCountB = (id: string): number => {
  let max = 0;
  for (const m of id.toLowerCase().matchAll(/(\d+(?:\.\d+)?)\s*b\b/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
};
const isTimeoutProneFree = (m: AnnotatedModel): boolean => isFreeVerified(m) && paramCountB(m.id) >= 200;

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
  /**
   * Tie-break order among free candidates (id.includes() needles, best-first). Defaults to
   * FREE_TEXT_PRIORITY (good general text); pickCodingModel passes CODING_MODEL_PRIORITY so the
   * strongest *coder* wins for code work without changing general-text picks.
   */
  rankOrder?: string[];
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
    for (const needle of (opts?.rankOrder ?? FREE_TEXT_PRIORITY)) {
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
      // Honor an explicit strength ranking (the studio passes STRONG_CODING_PRIORITY so the best
      // available coder wins, free or paid) before falling back to the largest-context model.
      for (const needle of (opts?.rankOrder ?? [])) {
        const hit = text.find((m) => m.id.toLowerCase().includes(needle));
        if (hit) return hit.id;
      }
      return [...text].sort(byContextDesc)[0]?.id || TEXT_FALLBACK;
    }
    if (costPref === 'free') {
      const free = text.filter(isFreeVerified);
      if (free.length) {
        for (const needle of (opts?.rankOrder ?? FREE_TEXT_PRIORITY)) {
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

/**
 * An ordered fallback CHAIN of text models for OpenRouter's `models` array (≤3), so a
 * single dead/rate-limited free model never means "no response": OpenRouter routes to the
 * first available one server-side. Free-first; unless `freeOnly`, the cheap paid
 * TEXT_FALLBACK is appended as the guaranteed last resort.
 */
export const pickTextModelChain = async (
  opts?: PickOpts & { freeOnly?: boolean; max?: number }
): Promise<string[]> => {
  const max = Math.min(opts?.max ?? 3, 3);
  const gate = opts?.filter ?? (() => true);
  let models: AnnotatedModel[] = [];
  try {
    ({ models } = await getCatalog());
  } catch {
    return [TEXT_FALLBACK];
  }
  let text = models.filter(isTextModel).filter(gate);
  if (opts?.prefer) {
    const preferred = text.filter(opts.prefer);
    if (preferred.length) text = preferred;
  }
  // Skip models we recently saw fail (404/429) so we don't lead the chain with a known-bad
  // free model and pay OpenRouter's ~15-20s wait before it routes onward.
  const free = text.filter(isFreeVerified).filter((m) => !isModelDown(m.id) && !isTimeoutProneFree(m));
  const ranked: string[] = [];
  const push = (id: string) => { if (id && !ranked.includes(id)) ranked.push(id); };
  for (const needle of (opts?.rankOrder ?? FREE_TEXT_PRIORITY)) {
    for (const m of free) if (m.id.toLowerCase().includes(needle)) push(m.id);
  }
  for (const m of free) push(m.id);
  // Reserve the last slot for the paid safety net unless we're strictly free-only.
  const freeSlots = opts?.freeOnly ? max : Math.max(1, max - 1);
  const chain = ranked.slice(0, freeSlots);
  if (!opts?.freeOnly) chain.push(TEXT_FALLBACK);
  if (chain.length === 0) chain.push(TEXT_FALLBACK);
  return Array.from(new Set(chain)).slice(0, max);
};

// Strong coding-model families, best-first — used by Code Studio (generation + the agentic build
// loop's FIX stage), where code quality matters most. Free-first still applies (strong-open default;
// frontier coders via BYOK), but among eligible models these are preferred AND ranked in this order.
// Refreshed for 2026 with the proven open agentic coders (Qwen3-Coder, DeepSeek V3.1, GLM-4.6,
// MiniMax M2, Kimi K2, Devstral, gpt-oss). Needles match catalog ids via id.includes().
export const CODING_MODEL_PRIORITY = [
  'qwen3-coder', 'deepseek-coder', 'glm-4.6', 'glm-4.5', 'minimax-m2', 'kimi-k2',
  'devstral', 'codestral', 'v3.1', 'v3.2', 'deepseek-chat', 'qwen-2.5-coder', 'qwen-coder',
  'codellama', 'code-llama', 'gpt-oss', 'deepseek-r1', 'deepseek', 'qwen3', 'qwen-2.5', 'qwen',
  'minimax', 'glm', 'llama-3.3',
  'gpt-4o', 'claude', 'gemini-2.0-flash', 'gemini'
];

// STRONGEST coders first (frontier, then top open coders) — used in 'quality' mode so BYOK/credit
// users get the most capable available coder, not just the best FREE one. Needles match catalog ids.
export const STRONG_CODING_PRIORITY = [
  'claude-opus-4', 'claude-sonnet-4', 'claude-3.7', 'claude-sonnet', 'claude',
  'gpt-5', 'gpt-4.1', 'o4-mini', 'o3', 'gpt-4o',
  'deepseek-coder', 'deepseek-chat', 'v3.2', 'v3.1',
  'qwen3-coder', 'qwen-2.5-coder', 'glm-4.6', 'minimax-m2', 'kimi-k2',
  'devstral', 'codestral', 'gemini-2.5-pro', 'gemini-2.5', 'gemini-2.0-flash', 'qwen3'
];

/** True when a model id looks like a strong coding model. */
export const prefersCodingModel = (m: AnnotatedModel): boolean => {
  const id = m.id.toLowerCase();
  return CODING_MODEL_PRIORITY.some((needle) => id.includes(needle));
};

/**
 * True when a model id is a STRONG/frontier coder (matches STRONG_CODING_PRIORITY — Claude/GPT-class
 * or a top open coder). Used to warn when a build is about to run on a weak/free model, which is the
 * dominant cause of "terrible generated code". A plain id check (no catalog) so it's pure + cheap.
 */
export const isStrongCoder = (modelId: string): boolean => {
  const id = (modelId || '').toLowerCase();
  return STRONG_CODING_PRIORITY.some((needle) => id.includes(needle));
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
  // Quality → rank by STRONGEST coder first (frontier, BYOK); free/cheap → best FREE coder first.
  const quality = resolveCostPref(opts) === 'quality';
  const rankOrder = opts?.rankOrder ?? (quality ? STRONG_CODING_PRIORITY : CODING_MODEL_PRIORITY);
  return pickTextModel({ ...opts, rankOrder, prefer });
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
