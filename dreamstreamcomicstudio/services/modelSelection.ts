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
  /** Sparse per-stage text-model overrides (advanced). Each falls back to textModel. */
  byStage?: Record<string, string>;
  /** Per-stage source overrides, paired with byStage, so per-stage picks route to the right provider. */
  byStageSource?: Record<string, ModelSourceId>;
}

const STORAGE = 'dreamstream_model_selection';
export const MODEL_SELECTION_CHANGED = 'dreamstream:model-selection-changed';

const DEFAULTS: ModelSelection = { mode: 'default', imageModel: null, textModel: null, imageSource: null, textSource: null };

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

export const getSelectedImageModel = (): string | null => read().imageModel;
export const getSelectedTextModel = (): string | null => read().textModel;
export const getSelectedImageSource = (): ModelSourceId | null => read().imageSource ?? null;
export const getSelectedTextSource = (): ModelSourceId | null => read().textSource ?? null;

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

/** Resolve the SOURCE for a stage: a per-stage source if set, else the global text source. */
export const getSourceForStage = (stage?: string): ModelSourceId | null => {
  const sel = read();
  const override = stage && sel.byStageSource ? sel.byStageSource[stage] : undefined;
  return override ?? sel.textSource ?? null;
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
