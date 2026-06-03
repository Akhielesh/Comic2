// Multi-key API configuration store.
//
// Client-side source of truth for BYOK provider keys: multiple keys per provider,
// one active key per provider, and a per-key monthly usage limit that BLOCKS
// generation on that key once reached. Usage is attributed from each generation's
// real provider cost via recordKeyUsage().
//
// See docs/decisions/0003-multi-key-api-configuration-and-usage-limits.md

export type ApiKeyProvider = 'openrouter' | 'nvidia' | 'gemini' | 'pixazo';

/** Result of the last live validity check for a key (see services/keyValidation.ts). */
export type KeyValidationState = 'unknown' | 'valid' | 'invalid' | 'unsupported';

export interface ManagedApiKey {
  id: string;
  provider: ApiKeyProvider;
  label: string;
  /** The secret key value (stored client-side). */
  key: string;
  /** Whether this is the active key for its provider (one active per provider). */
  active: boolean;
  /** Monthly spend cap in USD for this key; null = no limit. */
  limitUsd: number | null;
  /** Spend in USD within the current monthly window. */
  usedUsd: number;
  /** ISO timestamp of the current usage window start (monthly rolling). */
  periodStart: string;
  createdAt: string;
  /** Last live validity verdict ('unknown' until first checked). */
  validation?: KeyValidationState;
  /** Epoch ms of the last validity check (drives "is this stale?" re-checks). */
  validatedAt?: number;
  /** Human-readable detail from the last check (e.g. "Valid — 84 models reachable."). */
  validationMessage?: string;
}

export const PROVIDER_META: Record<ApiKeyProvider, {
  label: string;
  /** Request header the key is sent in. */
  header: string;
  /** Where the user gets a key. */
  keysUrl: string;
  hint: string;
}> = {
  openrouter: {
    label: 'OpenRouter',
    header: 'X-OpenRouter-Key',
    keysUrl: 'https://openrouter.ai/keys',
    hint: 'Unified gateway for text + image models. Recommended.'
  },
  nvidia: {
    label: 'NVIDIA Build',
    header: 'X-Nvidia-Key',
    keysUrl: 'https://build.nvidia.com/settings/api-keys',
    hint: 'Generous free tier for text/LLM models (nvapi- key). Image stays on OpenRouter/Flux.'
  },
  gemini: {
    label: 'Google Gemini',
    header: 'X-Gemini-Key',
    keysUrl: 'https://aistudio.google.com/app/apikey',
    hint: 'Direct Google AI Studio key (legacy text + image path).'
  },
  pixazo: {
    label: 'Pixazo / Flux',
    header: 'X-Pixazo-Key',
    keysUrl: 'https://pixazo.ai',
    hint: 'Legacy Flux image generation.'
  }
};

export const ALL_PROVIDERS: ApiKeyProvider[] = ['openrouter', 'nvidia', 'gemini', 'pixazo'];

const STORAGE = 'dreamstream_api_keys_v2';
const MIGRATED_FLAG = 'dreamstream_api_keys_migrated';

// Legacy single-key storage locations (kept for back-compat + one-time migration).
const LEGACY_KEYS: Record<ApiKeyProvider, string> = {
  openrouter: 'dreamstream_openrouter_key',
  nvidia: 'dreamstream_nvidia_key',
  gemini: 'dreamstream_api_key',
  pixazo: 'dreamstream_flux_key'
};

const read = (k: string): string | null => {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage.getItem(k); } catch { return null; }
};
const write = (k: string, v: string) => {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(k, v); } catch { /* ignore */ }
};

const uuid = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `key_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const monthKey = (iso: string) => iso.slice(0, 7); // YYYY-MM
const nowIso = () => new Date().toISOString();

/** Roll a key's usage window if we've crossed into a new month. */
const applyPeriodReset = (key: ManagedApiKey): ManagedApiKey => {
  if (monthKey(key.periodStart) !== monthKey(nowIso())) {
    return { ...key, usedUsd: 0, periodStart: nowIso() };
  }
  return key;
};

const migrateLegacyKeys = (existing: ManagedApiKey[]): ManagedApiKey[] => {
  if (read(MIGRATED_FLAG) === '1' || existing.length > 0) return existing;
  const imported: ManagedApiKey[] = [];
  for (const provider of ALL_PROVIDERS) {
    const legacy = read(LEGACY_KEYS[provider]);
    if (legacy && legacy.trim()) {
      imported.push({
        id: uuid(),
        provider,
        label: `Imported ${PROVIDER_META[provider].label} key`,
        key: legacy.trim(),
        active: true, // first (only) key for the provider becomes active
        limitUsd: null,
        usedUsd: 0,
        periodStart: nowIso(),
        createdAt: nowIso()
      });
    }
  }
  write(MIGRATED_FLAG, '1');
  if (imported.length > 0) write(STORAGE, JSON.stringify(imported));
  return imported;
};

const readAll = (): ManagedApiKey[] => {
  let keys: ManagedApiKey[] = [];
  const raw = read(STORAGE);
  if (raw) {
    try { keys = JSON.parse(raw) as ManagedApiKey[]; } catch { keys = []; }
  }
  keys = migrateLegacyKeys(keys);
  // Apply monthly resets on read and persist if anything changed.
  let changed = false;
  keys = keys.map((k) => {
    const next = applyPeriodReset(k);
    if (next !== k) changed = true;
    return next;
  });
  if (changed) write(STORAGE, JSON.stringify(keys));
  return keys;
};

const writeAll = (keys: ManagedApiKey[]) => write(STORAGE, JSON.stringify(keys));

// ----- Public API -------------------------------------------------------------

export const listKeys = (): ManagedApiKey[] => readAll();

export const listKeysByProvider = (provider: ApiKeyProvider): ManagedApiKey[] =>
  readAll().filter((k) => k.provider === provider);

export const addKey = (input: {
  provider: ApiKeyProvider;
  label?: string;
  key: string;
  limitUsd?: number | null;
}): ManagedApiKey => {
  const keys = readAll();
  const isFirstForProvider = !keys.some((k) => k.provider === input.provider);
  const entry: ManagedApiKey = {
    id: uuid(),
    provider: input.provider,
    label: (input.label || '').trim() || `${PROVIDER_META[input.provider].label} key`,
    key: input.key.trim(),
    active: isFirstForProvider, // first key of a provider is auto-active
    limitUsd: typeof input.limitUsd === 'number' && input.limitUsd > 0 ? input.limitUsd : null,
    usedUsd: 0,
    periodStart: nowIso(),
    createdAt: nowIso()
  };
  writeAll([...keys, entry]);
  return entry;
};

export const updateKey = (
  id: string,
  patch: Partial<Pick<ManagedApiKey, 'label' | 'key' | 'limitUsd'>>
) => {
  const keys = readAll().map((k) => {
    if (k.id !== id) return k;
    const next = { ...k };
    if (typeof patch.label === 'string') next.label = patch.label.trim() || next.label;
    if (typeof patch.key === 'string' && patch.key.trim()) next.key = patch.key.trim();
    if (patch.limitUsd !== undefined) {
      next.limitUsd = typeof patch.limitUsd === 'number' && patch.limitUsd > 0 ? patch.limitUsd : null;
    }
    return next;
  });
  writeAll(keys);
};

export const deleteKey = (id: string) => {
  const keys = readAll();
  const removed = keys.find((k) => k.id === id);
  let remaining = keys.filter((k) => k.id !== id);
  // If we removed the active key, promote another key of the same provider.
  if (removed?.active) {
    const sibling = remaining.find((k) => k.provider === removed.provider);
    if (sibling) remaining = remaining.map((k) => (k.id === sibling.id ? { ...k, active: true } : k));
  }
  writeAll(remaining);
};

export const setActiveKey = (id: string) => {
  const keys = readAll();
  const target = keys.find((k) => k.id === id);
  if (!target) return;
  writeAll(keys.map((k) => {
    if (k.provider !== target.provider) return k;
    return { ...k, active: k.id === id };
  }));
};

export const getActiveKey = (provider: ApiKeyProvider): ManagedApiKey | null =>
  readAll().find((k) => k.provider === provider && k.active) || null;

/** Active key's secret value, for request headers. Null if none configured. */
export const getActiveKeyValue = (provider: ApiKeyProvider): string | null =>
  getActiveKey(provider)?.key || null;

/** Fraction (0..1+) of a key's monthly limit consumed. 0 when no limit set. */
export const usageFraction = (key: ManagedApiKey): number => {
  if (!key.limitUsd || key.limitUsd <= 0) return 0;
  return key.usedUsd / key.limitUsd;
};

export const isOverLimit = (key: ManagedApiKey): boolean =>
  Boolean(key.limitUsd && key.limitUsd > 0 && key.usedUsd >= key.limitUsd);

/**
 * Resolve the active key for a generation. `key` is null when none is configured;
 * `blocked` is true when the active key has reached its per-key monthly limit.
 */
export const getActiveKeyForUse = (
  provider: ApiKeyProvider
): { key: ManagedApiKey | null; blocked: boolean } => {
  const key = getActiveKey(provider);
  return { key, blocked: key ? isOverLimit(key) : false };
};

/** Attribute spend (USD) to the active key of a provider after a generation. */
export const recordKeyUsage = (provider: ApiKeyProvider, usd: number) => {
  if (!Number.isFinite(usd) || usd <= 0) return;
  const keys = readAll();
  const active = keys.find((k) => k.provider === provider && k.active);
  if (!active) return;
  writeAll(keys.map((k) =>
    k.id === active.id ? { ...k, usedUsd: Number((k.usedUsd + usd).toFixed(6)) } : k
  ));
};

/** Persist the outcome of a live validity check for a key (badge + staleness tracking). */
export const setKeyValidation = (id: string, state: KeyValidationState, message?: string) => {
  const keys = readAll();
  if (!keys.some((k) => k.id === id)) return;
  writeAll(keys.map((k) =>
    k.id === id ? { ...k, validation: state, validatedAt: Date.now(), validationMessage: message } : k
  ));
};
