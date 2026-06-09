// Code Studio model selection — INDEPENDENT of the comics/chat model selection.
//
// The comics pipeline and chat read services/modelSelection.ts. Code Studio is a different job
// (writing and fixing real code), so it gets its own pinned coding model, source, and build
// knobs, stored under a separate key. "Auto" keeps the seamless default — the server picks the
// best free-first proven coder — while "specific" lets power users pin any model from the live
// catalog and choose whether it routes through OpenRouter or NVIDIA.
//
// Nothing here is required for Studio to work: with no saved selection, callers send no overrides
// and the server falls back to its free-first pickCodingModel(). Pinning is purely additive.

import type { ModelSourceId } from './modelSelection';
import { clampProjectLimit, resolveBuildTier } from './modelBudget';

/** auto = server free-first proven coder (seamless). specific = a pinned model id. */
export type StudioModelMode = 'auto' | 'specific';

/**
 * Spend preference for the studio's auto-pick, mirroring the server CostPref:
 *  - 'free'    free-first, falls back to cheapest paid (recommended default)
 *  - 'cheap'   cheapest eligible coder
 *  - 'quality' strongest available coder regardless of cost (needs a funded key)
 */
export type StudioCostPref = 'free' | 'cheap' | 'quality';

export interface StudioModelSelection {
  mode: StudioModelMode;
  /** Pinned model id (when mode === 'specific'). */
  model: string | null;
  /** Source to route the pinned model (or the standing default source for auto). */
  source: ModelSourceId | null;
  /** Auto-pick spend preference. */
  costPref: StudioCostPref;
  /** Sampling temperature for generation/fix (0 = deterministic, 1 = creative). */
  creativity: number;
  /** Max self-heal iterations for the agentic build loop (server clamps to 1–6). */
  maxIterations: number;
  /** Default scaffold for new apps; null/undefined = let the AI choose from the prompt. */
  defaultTemplate?: string | null;
  /** Pinned design-system preset id (null/undefined = let the AI pick the best fit per prompt). */
  designPreset?: string | null;
  /** Enabled multi-agent refinement agents (ids). null = the default team. */
  agents?: string[] | null;
  /** Free-text preferences the refinement agents should honor (style, stack, constraints). */
  agentPreferences?: string;
  /** Automatically run the agent team after each brand-new build (seamless mode). */
  autoRunAgents?: boolean;
  /**
   * Sandbox runtime preference:
   *  - 'auto'    run in the cloud worker container when available, else the in-browser preview
   *  - 'worker'  always use the cloud worker container (real terminal/backends)
   *  - 'browser' always use the in-browser preview (no hosted worker needed)
   */
  runtime?: 'auto' | 'worker' | 'browser';
  /**
   * Per-project spend limit in USD the user sets right in the studio. null = no explicit cap (use
   * the key's remaining credit). 0 = free models only. >0 = paid/frontier allowed up to this cap.
   * Always clamped to the OpenRouter key's real remaining credit (see services/modelBudget.ts).
   */
  projectLimitUsd?: number | null;
}

export type StudioRuntime = 'auto' | 'worker' | 'browser';

const STORAGE = 'dreamstream_studio_model';
export const STUDIO_MODEL_CHANGED = 'dreamstream:studio-model-changed';

export const STUDIO_DEFAULT_CREATIVITY = 0.3;
export const STUDIO_DEFAULT_MAX_ITERATIONS = 4;
export const STUDIO_MAX_ITERATIONS_CEILING = 6;

const DEFAULTS: StudioModelSelection = {
  mode: 'auto',
  model: null,
  source: null,
  // Default to the STRONGEST available coder — weak free coders can't build real apps. The server
  // owns the (creative) temperature now, so the client no longer sends one.
  costPref: 'quality',
  creativity: STUDIO_DEFAULT_CREATIVITY,
  maxIterations: STUDIO_DEFAULT_MAX_ITERATIONS,
  defaultTemplate: null,
  designPreset: null,
  agents: null,
  agentPreferences: '',
  // Default ON: the agent team reviews/hardens every new build so code isn't shipped on the
  // model's first answer. (This was effectively OFF before — the sanitizer forced it false even
  // though the docs/getter intended ON — which is why agents "didn't deploy automatically".)
  autoRunAgents: true,
  runtime: 'auto'
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const sanitize = (raw: Partial<StudioModelSelection>): StudioModelSelection => {
  const merged = { ...DEFAULTS, ...raw };
  return {
    ...merged,
    mode: merged.mode === 'specific' ? 'specific' : 'auto',
    model: merged.mode === 'specific' && typeof merged.model === 'string' && merged.model.trim() ? merged.model : null,
    source: merged.source === 'openrouter' || merged.source === 'nvidia' ? merged.source : null,
    costPref: merged.costPref === 'cheap' || merged.costPref === 'free' || merged.costPref === 'quality' ? merged.costPref : 'quality',
    creativity: Number.isFinite(merged.creativity) ? clamp(Number(merged.creativity), 0, 1) : STUDIO_DEFAULT_CREATIVITY,
    maxIterations: Number.isInteger(merged.maxIterations)
      ? clamp(merged.maxIterations, 1, STUDIO_MAX_ITERATIONS_CEILING)
      : STUDIO_DEFAULT_MAX_ITERATIONS,
    designPreset: typeof merged.designPreset === 'string' && merged.designPreset.trim() ? merged.designPreset : null,
    agents: Array.isArray(merged.agents) ? merged.agents.filter((x): x is string => typeof x === 'string') : null,
    agentPreferences: typeof merged.agentPreferences === 'string' ? merged.agentPreferences : '',
    // Default ON: only an explicit `false` disables the auto-review (undefined → ON).
    autoRunAgents: merged.autoRunAgents !== false,
    runtime: merged.runtime === 'worker' || merged.runtime === 'browser' ? merged.runtime : 'auto'
  };
};

const read = (): StudioModelSelection => {
  if (typeof window === 'undefined') return { ...DEFAULTS };
  try {
    const raw = window.localStorage.getItem(STORAGE);
    if (!raw) return { ...DEFAULTS };
    return sanitize(JSON.parse(raw) as Partial<StudioModelSelection>);
  } catch {
    return { ...DEFAULTS };
  }
};

const write = (next: StudioModelSelection) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(STUDIO_MODEL_CHANGED));
  } catch {
    /* ignore */
  }
};

export const getStudioModelSelection = (): StudioModelSelection => read();

/** Pin a specific coding model + source for the studio (mode → 'specific'). null model → back to auto. */
export const setStudioModel = (model: string | null, source?: ModelSourceId | null) => {
  const next = read();
  if (model && model.trim()) {
    next.mode = 'specific';
    next.model = model;
    next.source = source ?? next.source ?? null;
  } else {
    next.mode = 'auto';
    next.model = null;
  }
  write(next);
};

/** Switch back to the seamless free-first auto-pick (keeps creativity/iteration knobs). */
export const setStudioAuto = () => {
  const next = read();
  next.mode = 'auto';
  next.model = null;
  write(next);
};

export const setStudioSource = (source: ModelSourceId | null) => {
  const next = read();
  next.source = source === 'openrouter' || source === 'nvidia' ? source : null;
  write(next);
};

export const setStudioCostPref = (costPref: StudioCostPref) => {
  const next = read();
  next.costPref = costPref;
  write(next);
};

export const setStudioCreativity = (creativity: number) => {
  const next = read();
  next.creativity = clamp(Number(creativity) || 0, 0, 1);
  write(next);
};

export const setStudioMaxIterations = (maxIterations: number) => {
  const next = read();
  const n = Math.round(Number(maxIterations));
  next.maxIterations = Number.isFinite(n) ? clamp(n, 1, STUDIO_MAX_ITERATIONS_CEILING) : STUDIO_DEFAULT_MAX_ITERATIONS;
  write(next);
};

export const setStudioDefaultTemplate = (template: string | null) => {
  const next = read();
  next.defaultTemplate = template && template.trim() ? template : null;
  write(next);
};

/** Pin a design-system preset id (null = let the AI auto-pick the best fit per prompt). */
export const setStudioDesignPreset = (id: string | null) => {
  const next = read();
  next.designPreset = id && id.trim() ? id : null;
  write(next);
};

/** Enabled refinement agent ids, or null when using the default team. */
export const getStudioAgents = (): string[] | null => read().agents ?? null;

/** Set the enabled refinement agents (null = default team). */
export const setStudioAgents = (ids: string[] | null) => {
  const next = read();
  next.agents = Array.isArray(ids) ? ids : null;
  write(next);
};

export const getStudioAgentPreferences = (): string => read().agentPreferences ?? '';

export const setStudioAgentPreferences = (text: string) => {
  const next = read();
  next.agentPreferences = typeof text === 'string' ? text : '';
  write(next);
};

// Default ON: the agent team reviews/hardens new builds so code isn't shipped on the model's first
// answer. Set false to disable for faster (lower-quality) builds.
export const getStudioAutoRunAgents = (): boolean => read().autoRunAgents !== false;

export const setStudioAutoRunAgents = (on: boolean) => {
  const next = read();
  next.autoRunAgents = !!on;
  write(next);
};

// --- Live key status (cached) — the project budget is enforced against the REAL key ----------
// Set from the studio (fetchKeyStatus → setStudioKeyStatus) so the build request builder + the
// clamp use the key's actual remaining credit + free-tier flag without needing live context.
let keyStatusCache: { remainingUsd: number | null; isFreeTier: boolean } = { remainingUsd: null, isFreeTier: false };

export const getStudioKeyStatus = () => keyStatusCache;

export const setStudioKeyStatus = (remainingUsd: number | null, isFreeTier: boolean): void => {
  keyStatusCache = { remainingUsd, isFreeTier };
  // Re-clamp any existing project limit down to the (possibly smaller) key remaining.
  const cur = getStudioProjectLimit();
  if (cur != null && remainingUsd != null && cur > remainingUsd) setStudioProjectLimit(remainingUsd, remainingUsd);
};

// --- Per-project spend limit (the inline cap the user sets in the studio) -----------------
/** The user's project spend cap in USD (null = no cap, use the key's remaining credit). */
export const getStudioProjectLimit = (): number | null => {
  const v = read().projectLimitUsd;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
};

/** Set the project spend cap, HARD-clamped to the key's remaining credit (defaults to the cached
 *  live key remaining) so a project can never be allowed to outspend the key. Returns what was stored. */
export const setStudioProjectLimit = (
  usd: number | null,
  keyRemainingUsd: number | null = keyStatusCache.remainingUsd
): number | null => {
  const { limitUsd } = clampProjectLimit(usd, keyRemainingUsd);
  const next = read();
  next.projectLimitUsd = limitUsd;
  write(next);
  return limitUsd;
};

/**
 * The effective cost preference a build should use, honoring the project limit + the key's nature:
 * a free-tier key (defaults from the cached live key) or an exhausted/zero project budget → 'free';
 * a funded cap → 'quality'; no cap → the user's standing costPref. This is what makes the AI use
 * models within the limit AND respect a free-tier key automatically.
 */
export const getStudioBuildCostPref = (
  keyIsFreeTier: boolean = keyStatusCache.isFreeTier,
  spentUsd = 0
): StudioCostPref => {
  const limit = getStudioProjectLimit();
  if (limit == null) return keyIsFreeTier ? 'free' : read().costPref;
  return resolveBuildTier({ projectLimitUsd: limit, spentUsd, keyIsFreeTier }) === 'free' ? 'free' : 'quality';
};

export const getStudioRuntime = (): StudioRuntime => read().runtime ?? 'auto';

export const setStudioRuntime = (runtime: StudioRuntime) => {
  const next = read();
  next.runtime = runtime === 'worker' || runtime === 'browser' ? runtime : 'auto';
  write(next);
};

/** Reset every studio model/build setting back to the seamless defaults. */
export const resetStudioModelSelection = () => write({ ...DEFAULTS });

/**
 * The request overrides Code Studio API calls should send. In 'auto' mode we send no model id
 * (the server free-first picks a proven coder); we still pass the spend preference, sampling
 * temperature and per-source default so auto stays user-tunable. In 'specific' mode the pinned
 * model + source are sent verbatim.
 */
export interface StudioModelRequest {
  model?: string;
  source?: ModelSourceId;
  costPref?: StudioCostPref;
  temperature?: number;
  maxIterations?: number;
  designPreset?: string;
}

export const studioModelRequest = (): StudioModelRequest => {
  const s = read();
  // Temperature is deliberately NOT sent: the server applies a single creative default so every
  // build is ambitious by default (the per-user creativity knob was removed).
  const req: StudioModelRequest = {
    // Budget-aware: a project spend limit (or a free-tier key) forces 'free'; a funded cap allows
    // 'quality'; no cap falls back to the user's standing costPref. This is what makes the build
    // respect the per-project limit the user set.
    costPref: getStudioBuildCostPref(),
    maxIterations: s.maxIterations
  };
  if (s.designPreset) req.designPreset = s.designPreset;
  if (s.mode === 'specific' && s.model) {
    req.model = s.model;
    if (s.source) req.source = s.source;
  } else if (s.source) {
    // Auto mode with a standing source preference (e.g. "always use NVIDIA for code").
    req.source = s.source;
  }
  return req;
};
