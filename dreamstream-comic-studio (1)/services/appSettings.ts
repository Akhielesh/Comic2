import { ImageProviderId } from "../types";
import { DEFAULT_IMAGE_PROVIDER, IMAGE_PROVIDER_LOCK } from "./imageModels";

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

export const getLockedImageProvider = () => IMAGE_PROVIDER_LOCK;

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
};

export const deleteModelKey = (modelId: string) => {
  const keys = getAllModelKeys();
  delete keys[modelId];
  setInStorage(MODEL_KEYS_STORAGE, JSON.stringify(keys));
};

export const getFluxKeyInfo = (): { key: string | null; source: KeySource } => {
  const stored = getFromStorage(FLUX_KEY_STORAGE);
  if (stored) return { key: stored, source: "localStorage" };
  return { key: null, source: "none" };
};

export const getFluxKey = (): string | null => getFluxKeyInfo().key;

export const setFluxKey = (key: string) => {
  setInStorage(FLUX_KEY_STORAGE, key.trim());
};

export const clearFluxKey = () => {
  removeFromStorage(FLUX_KEY_STORAGE);
};

export const getFluxKeySuffix = () => {
  const key = getFluxKey();
  return key ? key.slice(-4) : null;
};

export const getSettingsState = (): {
  showGeminiKey?: boolean;
  showFluxKey?: boolean;
  modelRouting?: Record<string, string>;
  showAssistant?: boolean;
  defaultImageModel?: string;
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
  showAssistant?: boolean;
  defaultImageModel?: string;
}) => {
  setInStorage(SETTINGS_KEY, JSON.stringify(next));
};

export const getShowAssistant = (): boolean => {
  const settings = getSettingsState();
  // Default to true if undefined
  return settings.showAssistant !== false;
};

export const getDefaultImageModel = (): string => {
  const settings = getSettingsState();
  return settings.defaultImageModel || "pixazo/flux-1-schnell";
};

export const getModelForTask = (task: string): string => {
  const settings = getSettingsState();
  const routing = settings.modelRouting || {};
  return routing[task] || getDefaultImageModel();
};
