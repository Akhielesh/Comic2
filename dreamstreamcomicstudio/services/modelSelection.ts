// User model selection (which OpenRouter models to use for image / text).
//
// "Use this model" in the Model Library and the Image/Text pickers write here.
// Stored as concrete OpenRouter model ids so generation can use them directly;
// null = let the server pick its default. `mode` is a UI hint (default/free/specific).
//
// See docs/decisions/0003-multi-key-api-configuration-and-usage-limits.md

export type ModelMode = 'default' | 'free' | 'specific';
export type ModelSlot = 'image' | 'text';
export type ModelSourceId = 'openrouter' | 'nvidia';

export interface ModelSelection {
  mode: ModelMode;
  imageModel: string | null;
  textModel: string | null;
  /** Which source the selected models came from, so the server routes to the right provider. */
  imageSource?: ModelSourceId | null;
  textSource?: ModelSourceId | null;
  /**
   * Standing default source per slot, used when no specific model is pinned (Auto).
   * Lets a user say "always prefer NVIDIA for text" without picking a model each time;
   * an explicit model's source always wins over this default.
   */
  preferredImageSource?: ModelSourceId | null;
  preferredTextSource?: ModelSourceId | null;
  /**
   * Hard lock: when set, generation is restricted to THIS source for both image and text.
   * Unlike preferred*Source (a soft Auto default that can fall back), a lock forces every
   * route (image, text, per-stage) to the locked source — overriding pins and preferences —
   * and the model library only shows that source. null = no lock (free routing).
   */
  lockedSource?: ModelSourceId | null;
  /** Sparse per-stage text-model overrides (advanced). Each falls back to textModel. */
  byStage?: Record<string, string>;
  /** Per-stage source overrides, paired with byStage, so per-stage picks route to the right provider. */
  byStageSource?: Record<string, ModelSourceId>;
}

const STORAGE = 'dreamstream_model_selection';
export const MODEL_SELECTION_CHANGED = 'dreamstream:model-selection-changed';

const DEFAULTS: ModelSelection = {
  mode: 'default',
  imageModel: null,
  textModel: null,
  imageSource: null,
  textSource: null,
  preferredImageSource: null,
  preferredTextSource: null,
  lockedSource: null
};

const read = (): ModelSelection => {
  if (typeof window === 'undefined') return { ...DEFAULTS };
  try {
    const raw = window.localStorage.getItem(STORAGE);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<ModelSelection>) };
  } catch {
    return { ...DEFAULTS };
  }
};

const write = (next: ModelSelection) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(MODEL_SELECTION_CHANGED));
  } catch {
    /* ignore */
  }
};

export const getModelSelection = (): ModelSelection => read();

/** Replace the whole selection at once (used when applying a cloud snapshot). */
export const replaceModelSelection = (next: ModelSelection) => {
  write({ ...DEFAULTS, ...next });
};

/** Forget this account's model choices (sign-out: prevents bleed into the next user). */
export const clearModelSelection = () => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE);
    window.dispatchEvent(new CustomEvent(MODEL_SELECTION_CHANGED));
  } catch {
    /* ignore */
  }
};

export const getSelectedImageModel = (): string | null => read().imageModel;
export const getSelectedTextModel = (): string | null => read().textModel;
// A hard lock wins over everything; then an explicit model's source; then the preferred default.
export const getSelectedImageSource = (): ModelSourceId | null => {
  const s = read();
  return s.lockedSource ?? s.imageSource ?? s.preferredImageSource ?? null;
};
export const getSelectedTextSource = (): ModelSourceId | null => {
  const s = read();
  return s.lockedSource ?? s.textSource ?? s.preferredTextSource ?? null;
};

export const getLockedSource = (): ModelSourceId | null => read().lockedSource ?? null;

/**
 * Lock (or unlock) generation to a single source. Locking clears any pinned model — global
 * or per-stage — whose source differs, so the server never receives a model id from one
 * source paired with a locked header for another. null unlocks.
 */
export const setLockedSource = (source: ModelSourceId | null) => {
  const next = read();
  next.lockedSource = source;
  if (source) {
    if (next.imageSource && next.imageSource !== source) { next.imageModel = null; next.imageSource = null; }
    if (next.textSource && next.textSource !== source) { next.textModel = null; next.textSource = null; }
    if (next.byStageSource) {
      const byStage = { ...(next.byStage || {}) };
      const byStageSource = { ...next.byStageSource };
      for (const stage of Object.keys(byStageSource)) {
        if (byStageSource[stage] !== source) { delete byStage[stage]; delete byStageSource[stage]; }
      }
      next.byStage = Object.keys(byStage).length ? byStage : undefined;
      next.byStageSource = Object.keys(byStageSource).length ? byStageSource : undefined;
    }
  }
  write(next);
};

export const getPreferredSource = (slot: ModelSlot): ModelSourceId | null =>
  slot === 'image' ? (read().preferredImageSource ?? null) : (read().preferredTextSource ?? null);

/** Set the standing default source for a slot (Auto picks route here). null = no preference. */
export const setPreferredSource = (slot: ModelSlot, source: ModelSourceId | null) => {
  const next = read();
  if (slot === 'image') next.preferredImageSource = source;
  else next.preferredTextSource = source;
  write(next);
};

/**
 * A "truly free" model costs nothing to call (OpenRouter ':free' variant). Such models are
 * exempt from the per-key USD spend limit — you can keep using them past a key's cap because
 * they don't spend anything. Paid models still enforce the key's limit. (OpenRouter's own
 * global free-request caps still apply upstream; those are not ours to bypass.)
 */
export const isTrulyFreeModelId = (modelId?: string | null): boolean =>
  Boolean(modelId && modelId.trim().toLowerCase().endsWith(':free'));

export const setSelectedModel = (
  slot: ModelSlot,
  modelId: string | null,
  mode: ModelMode = 'specific',
  source?: ModelSourceId | null
) => {
  const next = read();
  if (slot === 'image') {
    next.imageModel = modelId;
    next.imageSource = modelId ? (source ?? null) : null;
  } else {
    next.textModel = modelId;
    next.textSource = modelId ? (source ?? null) : null;
  }
  next.mode = mode;
  write(next);
};

export const setSelectionMode = (mode: ModelMode) => {
  const next = read();
  next.mode = mode;
  // 'default' clears explicit choices (server picks); 'free'/'specific' keep ids.
  if (mode === 'default') {
    next.imageModel = null;
    next.textModel = null;
    next.imageSource = null;
    next.textSource = null;
    next.byStage = undefined;
    next.byStageSource = undefined;
  }
  write(next);
};

export const getStageOverrides = (): Record<string, string> => ({ ...(read().byStage || {}) });

/** Resolve the text model for a pipeline stage: a per-stage override if set, else the global text model. */
export const getModelForStage = (stage?: string): string | null => {
  const sel = read();
  const override = stage && sel.byStage ? sel.byStage[stage] : undefined;
  return typeof override === 'string' && override.trim() ? override : sel.textModel;
};

/** Resolve the SOURCE for a stage: per-stage override → pinned text source → preferred default. */
export const getSourceForStage = (stage?: string): ModelSourceId | null => {
  const sel = read();
  if (sel.lockedSource) return sel.lockedSource; // a hard lock overrides per-stage picks too
  const override = stage && sel.byStageSource ? sel.byStageSource[stage] : undefined;
  return override ?? sel.textSource ?? sel.preferredTextSource ?? null;
};

export const setStageModel = (stage: string, modelId: string | null, source?: ModelSourceId | null) => {
  const next = read();
  const byStage = { ...(next.byStage || {}) };
  const byStageSource = { ...(next.byStageSource || {}) };
  if (modelId && modelId.trim()) {
    byStage[stage] = modelId;
    if (source) byStageSource[stage] = source; else delete byStageSource[stage];
  } else {
    delete byStage[stage];
    delete byStageSource[stage];
  }
  next.byStage = Object.keys(byStage).length ? byStage : undefined;
  next.byStageSource = Object.keys(byStageSource).length ? byStageSource : undefined;
  write(next);
};
