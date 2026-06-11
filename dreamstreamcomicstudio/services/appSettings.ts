import { ImageProviderId } from "../types";
import { DEFAULT_IMAGE_PROVIDER, IMAGE_MODELS, IMAGE_PROVIDER_LOCK } from "./imageModels";
import { IMAGE_MODEL, TEXT_MODEL, TEXT_MODELS } from "./modelPolicy";

const IMAGE_PROVIDER_KEY = "dreamstream_image_provider";
const FLUX_KEY_STORAGE = "dreamstream_flux_key";
const SETTINGS_KEY = "dreamstream_settings";

type KeySource = "localStorage" | "none";

const getFromStorage = (key: string) => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const setInStorage = (key: string, value: string) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
};

const removeFromStorage = (key: string) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
};

// Cloud-sync hook: AuthContext registers a listener so settings/model changes are
// mirrored to the user's account. `suspended` avoids a loop while applying a cloud pull.
let settingsChangeListener: (() => void) | null = null;
let settingsSyncSuspended = false;
export const setSettingsChangeListener = (fn: (() => void) | null) => { settingsChangeListener = fn; };
export const suspendSettingsSync = (value: boolean) => { settingsSyncSuspended = value; };
const notifySettingsChanged = () => {
  if (settingsChangeListener && !settingsSyncSuspended) {
    try { settingsChangeListener(); } catch { /* never break local writes */ }
  }
};

export const getLockedImageProvider = () => IMAGE_PROVIDER_LOCK;

/**
 * SECURITY/HYGIENE: forget every account-scoped preference stored under global keys.
 * Called on sign-out. Without this, the next user to sign in on a shared device
 * inherited the previous user's preferences — and worse, the login-time cloud merge
 * uploaded those leftovers INTO the new user's account.
 */
export const clearUserScopedSettings = () => {
  removeFromStorage(SETTINGS_KEY);
  removeFromStorage(MODEL_KEYS_STORAGE);
  removeFromStorage(IMAGE_MODEL_KEY);
  removeFromStorage(IMAGE_PROVIDER_KEY);
};

const IMAGE_MODEL_KEY = "dreamstream_image_model_id";

export const getImageProvider = (): ImageProviderId => {
  if (IMAGE_PROVIDER_LOCK) return IMAGE_PROVIDER_LOCK;
  const stored = getFromStorage(IMAGE_PROVIDER_KEY) as ImageProviderId | null;
  return stored || DEFAULT_IMAGE_PROVIDER;
};

export const setImageProvider = (provider: ImageProviderId) => {
  const effective = IMAGE_PROVIDER_LOCK || provider;
  setInStorage(IMAGE_PROVIDER_KEY, effective);
  return effective;
};

export const getImageModelId = (): string | null => {
  return getFromStorage(IMAGE_MODEL_KEY);
};

export const setImageModelId = (modelId: string) => {
  setInStorage(IMAGE_MODEL_KEY, modelId);
  notifySettingsChanged();
};

// Model-Specific Key Management
const MODEL_KEYS_STORAGE = "dreamstream_model_keys";

export const getAllModelKeys = (): Record<string, string> => {
  const stored = getFromStorage(MODEL_KEYS_STORAGE);
  if (!stored) return {};
  try {
    return JSON.parse(stored);
  } catch {
    return {};
  }
};

export const getModelSpecificKey = (modelId: string): string | null => {
  const keys = getAllModelKeys();
  return keys[modelId] || null;
};

export const setModelSpecificKey = (modelId: string, key: string) => {
  const keys = getAllModelKeys();
  if (key) {
    keys[modelId] = key.trim();
  } else {
    delete keys[modelId];
  }
  setInStorage(MODEL_KEYS_STORAGE, JSON.stringify(keys));
  notifySettingsChanged();
};

export const deleteModelKey = (modelId: string) => {
  const keys = getAllModelKeys();
  delete keys[modelId];
  setInStorage(MODEL_KEYS_STORAGE, JSON.stringify(keys));
  notifySettingsChanged();
};

/** Replace the whole model-keys map at once (used when applying a cloud snapshot). */
export const setAllModelKeys = (keys: Record<string, string>) => {
  setInStorage(MODEL_KEYS_STORAGE, JSON.stringify(keys || {}));
};

export const getFluxKeyInfo = (): { key: string | null; source: KeySource } => {
  const stored = getFromStorage(FLUX_KEY_STORAGE);
  if (stored) return { key: stored, source: "localStorage" };
  return { key: null, source: "none" };
};

export const getFluxKey = (): string | null => getFluxKeyInfo().key;

export const setFluxKey = (key: string | null) => {
  const normalized = typeof key === "string" ? key.trim() : "";
  if (!normalized) {
    removeFromStorage(FLUX_KEY_STORAGE);
    return;
  }
  setInStorage(FLUX_KEY_STORAGE, normalized);
};

export const clearFluxKey = () => {
  removeFromStorage(FLUX_KEY_STORAGE);
};

export const getFluxKeySuffix = () => {
  const key = getFluxKey();
  return key ? key.slice(-4) : null;
};

// OpenRouter unified-gateway key (BYOK). Sent to the server as X-OpenRouter-Key,
// which bypasses platform billing when present.
const OPENROUTER_KEY_STORAGE = "dreamstream_openrouter_key";

export const getOpenRouterKeyInfo = (): { key: string | null; source: KeySource } => {
  const stored = getFromStorage(OPENROUTER_KEY_STORAGE);
  if (stored) return { key: stored, source: "localStorage" };
  return { key: null, source: "none" };
};

export const getOpenRouterKey = (): string | null => getOpenRouterKeyInfo().key;

export const setOpenRouterKey = (key: string | null) => {
  const normalized = typeof key === "string" ? key.trim() : "";
  if (!normalized) {
    removeFromStorage(OPENROUTER_KEY_STORAGE);
    return;
  }
  setInStorage(OPENROUTER_KEY_STORAGE, normalized);
};

export const clearOpenRouterKey = () => {
  removeFromStorage(OPENROUTER_KEY_STORAGE);
};

export const getOpenRouterKeySuffix = () => {
  const key = getOpenRouterKey();
  return key ? key.slice(-4) : null;
};

export const getSettingsState = (): {
  showGeminiKey?: boolean;
  showFluxKey?: boolean;
  modelRouting?: Record<string, string>;
  defaultImageModel?: string;
  defaultTextModel?: string;
  defaultTextModelKey?: string;
} => {
  const raw = getFromStorage(SETTINGS_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

export const setSettingsState = (next: {
  showGeminiKey?: boolean;
  showFluxKey?: boolean;
  modelRouting?: Record<string, string>;
  defaultImageModel?: string;
  defaultTextModel?: string;
  defaultTextModelKey?: string;
}) => {
  setInStorage(SETTINGS_KEY, JSON.stringify(next));
  notifySettingsChanged();
};

export const getDefaultImageModel = (): string => {
  const settings = getSettingsState();
  const configured = settings.defaultImageModel?.trim();
  if (configured) {
    const isSupported = IMAGE_MODELS.some((model) => model.id === configured);
    if (isSupported) return configured;
    if (configured.toLowerCase().includes("gemini")) return IMAGE_MODEL;
  }
  return "pixazo/flux-1-schnell";
};

export const getDefaultTextModel = (): string => {
  const settings = getSettingsState();
  const configured = (settings.defaultTextModel || settings.defaultTextModelKey || TEXT_MODEL).trim();
  const supportedTextModelIds = new Set(TEXT_MODELS.map((model) => model.id));
  return supportedTextModelIds.has(configured) ? configured : TEXT_MODEL;
};

export const getDefaultTextModelKey = getDefaultTextModel;

const TASK_ALIASES: Record<string, string> = {
  style: "style",
  world: "world",
  cover: "cover",
  panel: "panel",
  panel_regen: "panel_regen",
  generation: "panel",
  preview: "panel",
  script: "script_analysis",
  script_analysis: "script_analysis",
  story_builder: "story_builder",
  layout: "panel_breakdown",
  panel_breakdown: "panel_breakdown",
  image_generation: "panel"
};

export const normalizeTaskKey = (task: string) => {
  const key = (task || "").trim().toLowerCase();
  return TASK_ALIASES[key] || key;
};

export const getModelForTask = (task: string): string => {
  const settings = getSettingsState();
  const routing = settings.modelRouting || {};
  const normalized = normalizeTaskKey(task);
  return routing[normalized] || getDefaultImageModel();
};
