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
}

const STORAGE = 'dreamstream_studio_model';
export const STUDIO_MODEL_CHANGED = 'dreamstream:studio-model-changed';

export const STUDIO_DEFAULT_CREATIVITY = 0.3;
export const STUDIO_DEFAULT_MAX_ITERATIONS = 4;
export const STUDIO_MAX_ITERATIONS_CEILING = 6;

const DEFAULTS: StudioModelSelection = {
  mode: 'auto',
  model: null,
  source: null,
  costPref: 'free',
  creativity: STUDIO_DEFAULT_CREATIVITY,
  maxIterations: STUDIO_DEFAULT_MAX_ITERATIONS,
  defaultTemplate: null
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const sanitize = (raw: Partial<StudioModelSelection>): StudioModelSelection => {
  const merged = { ...DEFAULTS, ...raw };
  return {
    ...merged,
    mode: merged.mode === 'specific' ? 'specific' : 'auto',
    model: merged.mode === 'specific' && typeof merged.model === 'string' && merged.model.trim() ? merged.model : null,
    source: merged.source === 'openrouter' || merged.source === 'nvidia' ? merged.source : null,
    costPref: merged.costPref === 'cheap' || merged.costPref === 'quality' ? merged.costPref : 'free',
    creativity: Number.isFinite(merged.creativity) ? clamp(Number(merged.creativity), 0, 1) : STUDIO_DEFAULT_CREATIVITY,
    maxIterations: Number.isInteger(merged.maxIterations)
      ? clamp(merged.maxIterations, 1, STUDIO_MAX_ITERATIONS_CEILING)
      : STUDIO_DEFAULT_MAX_ITERATIONS
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
}

export const studioModelRequest = (): StudioModelRequest => {
  const s = read();
  const req: StudioModelRequest = {
    costPref: s.costPref,
    temperature: s.creativity,
    maxIterations: s.maxIterations
  };
  if (s.mode === 'specific' && s.model) {
    req.model = s.model;
    if (s.source) req.source = s.source;
  } else if (s.source) {
    // Auto mode with a standing source preference (e.g. "always use NVIDIA for code").
    req.source = s.source;
  }
  return req;
};
