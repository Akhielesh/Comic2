// User model selection (which OpenRouter models to use for image / text).
//
// "Use this model" in the Model Library and the Image/Text pickers write here.
// Stored as concrete OpenRouter model ids so generation can use them directly;
// null = let the server pick its default. `mode` is a UI hint (default/free/specific).
//
// See docs/decisions/0003-multi-key-api-configuration-and-usage-limits.md

export type ModelMode = 'default' | 'free' | 'specific';
export type ModelSlot = 'image' | 'text';

export interface ModelSelection {
  mode: ModelMode;
  imageModel: string | null;
  textModel: string | null;
  /** Sparse per-stage text-model overrides (advanced). Each falls back to textModel. */
  byStage?: Record<string, string>;
}

const STORAGE = 'dreamstream_model_selection';
export const MODEL_SELECTION_CHANGED = 'dreamstream:model-selection-changed';

const DEFAULTS: ModelSelection = { mode: 'default', imageModel: null, textModel: null };

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

export const setSelectedModel = (slot: ModelSlot, modelId: string | null, mode: ModelMode = 'specific') => {
  const next = read();
  if (slot === 'image') next.imageModel = modelId;
  else next.textModel = modelId;
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
    next.byStage = undefined;
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

export const setStageModel = (stage: string, modelId: string | null) => {
  const next = read();
  const byStage = { ...(next.byStage || {}) };
  if (modelId && modelId.trim()) byStage[stage] = modelId;
  else delete byStage[stage];
  next.byStage = Object.keys(byStage).length ? byStage : undefined;
  write(next);
};
