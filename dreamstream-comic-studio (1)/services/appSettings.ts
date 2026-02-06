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
}) => {
  setInStorage(SETTINGS_KEY, JSON.stringify(next));
};
