// Text-model routing for Comic Studio (v4).
//
// Three roles, each pinned to models that are actually good at the job (see
// docs/features/comic-studio-v4.md §5). The old studio planned on whatever the client's
// X-Text-Model header said — which is how page breakdowns ended up on free coding
// models at temperature 0.1. Here the client has NO say: the chain comes from these
// defaults or from server env (COMIC_DIRECTOR_MODEL / COMIC_WRITER_MODEL /
// COMIC_VISION_MODEL, each optionally a comma-separated fallback chain).
//
// Routing: OpenRouter whenever a key exists (the whole chain is passed as its
// server-side `models` fallback list, ≤3), else Gemini direct — which can only run
// google/* models, addressed without the `google/` prefix.

import type { ResolvedKey, StudioKeys, TextRole } from './types.js';

export interface TextRoleDefaults {
  /** Env var that overrides the chain (comma-separated, first = primary). */
  envVar: string;
  /** OpenRouter ids, primary first. Verified live on OpenRouter 2026-10-21. */
  models: readonly string[];
  /** Wall-clock budget for one model call (streaming: idle window). */
  timeoutMs: number;
  temperature: number;
  maxTokens: number;
  /** Friendly name used in user-facing error messages. */
  label: string;
}

export const TEXT_ROLE_DEFAULTS: Readonly<Record<TextRole, TextRoleDefaults>> = {
  director: {
    envVar: 'COMIC_DIRECTOR_MODEL',
    models: ['google/gemini-3.8-flash', 'anthropic/claude-sonnet-5.5', 'openai/gpt-6-luna'],
    timeoutMs: 90_000,
    temperature: 0.6,
    maxTokens: 2500,
    label: 'studio assistant'
  },
  writer: {
    envVar: 'COMIC_WRITER_MODEL',
    models: ['anthropic/claude-sonnet-5.5', 'google/gemini-4-argon', 'google/gemini-3.8-flash'],
    // Planning a 20-page script with a strong model legitimately takes minutes; this is
    // deliberately NOT capped by TEXT_REQUEST_TIMEOUT_MS (that 55s cap exists for
    // non-streaming browser→API requests behind an edge proxy, not server→model calls).
    timeoutMs: 150_000,
    temperature: 0.8,
    maxTokens: 16_000,
    label: 'story planner'
  },
  vision: {
    envVar: 'COMIC_VISION_MODEL',
    models: ['google/gemini-3.8-flash', 'google/gemini-3.7-flash'],
    timeoutMs: 60_000,
    temperature: 0.1,
    maxTokens: 2500,
    label: 'page checker'
  }
};

/** OpenRouter's `models` fallback list is capped at 3 entries. */
export const MAX_TEXT_FALLBACK_MODELS = 3;

const GOOGLE_PREFIX = 'google/';

/** Normalize one configured id: bare `gemini-*` ids are Google models on OpenRouter. */
const normalizeModelId = (raw: string): string => {
  const id = raw.trim();
  if (!id) return '';
  if (!id.includes('/') && /^gemini[-.]/i.test(id)) return `${GOOGLE_PREFIX}${id}`;
  return id;
};

const dedupe = (ids: string[]): string[] => Array.from(new Set(ids.filter(Boolean)));

/** The ordered OpenRouter-style chain for a role (env override, else defaults). */
export const roleModelChain = (role: TextRole, env: NodeJS.ProcessEnv = process.env): string[] => {
  const defaults = TEXT_ROLE_DEFAULTS[role];
  const raw = (env[defaults.envVar] || '').trim();
  const fromEnv = raw ? dedupe(raw.split(',').map(normalizeModelId)) : [];
  return fromEnv.length ? fromEnv : [...defaults.models];
};

/** Gemini-direct ids (prefix stripped) for the google/* entries of a chain. */
const geminiDirectIds = (chain: readonly string[]): string[] =>
  dedupe(chain.filter((id) => id.startsWith(GOOGLE_PREFIX)).map((id) => id.slice(GOOGLE_PREFIX.length)));

export interface TextRoute {
  route: 'openrouter' | 'gemini';
  /** Primary model id in the route's own namespace. */
  model: string;
  /** Ordered fallback chain (primary first, ≤3) in the route's namespace. */
  models: string[];
  key: ResolvedKey;
}

/**
 * Which upstream + model chain a role runs on for these keys, or null when no usable
 * key exists. Deliberately takes no request: client headers can never steer it.
 */
export function resolveTextRoute(role: TextRole, keys: StudioKeys, env: NodeJS.ProcessEnv = process.env): TextRoute | null {
  if (!TEXT_ROLE_DEFAULTS[role]) return null;
  const chain = roleModelChain(role, env);

  if (keys.openrouter?.key) {
    const models = chain.slice(0, MAX_TEXT_FALLBACK_MODELS);
    return { route: 'openrouter', model: models[0], models, key: keys.openrouter };
  }

  if (keys.gemini?.key) {
    // Only Google models run on Gemini direct. If an env override named none, fall back
    // to the role's default Google models rather than refusing to work.
    let direct = geminiDirectIds(chain);
    if (!direct.length) direct = geminiDirectIds(TEXT_ROLE_DEFAULTS[role].models);
    if (!direct.length) direct = geminiDirectIds(TEXT_ROLE_DEFAULTS.vision.models);
    if (!direct.length) return null;
    const models = direct.slice(0, MAX_TEXT_FALLBACK_MODELS);
    return { route: 'gemini', model: models[0], models, key: keys.gemini };
  }

  return null;
}

// ── Cost estimation ──────────────────────────────────────────────────────────

/**
 * Provider list prices (USD per 1M tokens) for the studio's text models, as listed on
 * OpenRouter 2026-10-21. Used only to ESTIMATE spend when the provider does not report
 * a cost (Gemini direct never does); billing uses services/pricingCatalog.ts.
 */
export const TEXT_MODEL_PRICES_PER_M: Readonly<Record<string, { input: number; output: number }>> = {
  'google/gemini-3.8-flash': { input: 0.825, output: 4.125 },
  'anthropic/claude-sonnet-5.5': { input: 2, output: 10 },
  'openai/gpt-6-luna': { input: 0.1, output: 0.5 },
  'google/gemini-4-argon': { input: 2, output: 10 },
  'google/gemini-3.7-flash': { input: 0.75, output: 3.75 }
};

/** Estimated USD for a call, or undefined when the model's price is unknown. */
export const estimateTextCostUsd = (model: string, promptTokens = 0, completionTokens = 0): number | undefined => {
  const id = normalizeModelId(model);
  const price = TEXT_MODEL_PRICES_PER_M[id];
  if (!price) return undefined;
  const usd = (Math.max(0, promptTokens) * price.input + Math.max(0, completionTokens) * price.output) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
};
