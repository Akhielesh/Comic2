// Source/provider governance — a central "allowed sources" control.
//
// Lets the user explicitly enable/disable each AI source (OpenRouter, NVIDIA,
// Gemini, Pixazo) so neither they nor the app accidentally use a source/key they
// didn't intend. Enforced two ways:
//   1. Client: a disabled provider's BYOK key is never attached to a request.
//   2. Server: the `X-Allowed-Sources` header (sent on every call) makes the
//      keys middleware null out disabled providers' keys — covering platform keys
//      too, not just BYOK — so the restriction is truly central.
//
// Default: every source enabled (no behaviour change until the user opts in).

import { ALL_PROVIDERS, hasUsableKey, type ApiKeyProvider } from './apiKeys';

const STORAGE = 'dreamstream_source_governance';
export const SOURCE_GOVERNANCE_CHANGED = 'dreamstream:source-governance:changed';

type GovernanceMap = Partial<Record<ApiKeyProvider, boolean>>;

const read = (): GovernanceMap => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE);
    return raw ? (JSON.parse(raw) as GovernanceMap) : {};
  } catch {
    return {};
  }
};

const write = (map: GovernanceMap) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE, JSON.stringify(map));
    window.dispatchEvent(new CustomEvent(SOURCE_GOVERNANCE_CHANGED));
  } catch {
    /* ignore */
  }
};

/** A source is enabled unless explicitly turned off. */
export const isProviderEnabled = (provider: ApiKeyProvider): boolean => read()[provider] !== false;

export const setProviderEnabled = (provider: ApiKeyProvider, on: boolean): void => {
  const map = read();
  map[provider] = on;
  write(map);
};

export const getEnabledProviders = (): ApiKeyProvider[] => ALL_PROVIDERS.filter(isProviderEnabled);

/** Comma-separated allowed-source list for the `X-Allowed-Sources` request header. */
export const allowedSourcesHeader = (): string => getEnabledProviders().join(',');

export const onSourceGovernanceChanged = (handler: () => void): (() => void) => {
  if (typeof window === 'undefined') return () => undefined;
  const wrapped = () => handler();
  window.addEventListener(SOURCE_GOVERNANCE_CHANGED, wrapped);
  return () => window.removeEventListener(SOURCE_GOVERNANCE_CHANGED, wrapped);
};

// ── Model-source scope ─────────────────────────────────────────────────────────
//
// THE one rule for which sources' models are listed anywhere (Model Library,
// comic Model panel, chat picker, Auto candidates), so every surface agrees with
// the Settings toggles instead of each filtering its own way:
//
//   1. A source must be enabled in Settings (governance toggle).
//   2. If at least one enabled source has a usable key (local, legacy, or
//      on-account), show ONLY those connected sources — the user clearly intends
//      to work with them.
//   3. If no enabled source has a key, show every enabled source — browsing and
//      platform-allowance generation still work without BYOK.
//
// When several active sources offer the same model, the pickers' cross-source
// grouping (services/modelGrouping.ts) asks the user to choose — never silent.

/** The sources that actually serve catalog models (gemini/pixazo/ideogram are legacy image paths). */
export const MODEL_SOURCES = ['openrouter', 'nvidia'] as const;
export type ModelSourceProvider = (typeof MODEL_SOURCES)[number];

export interface ModelSourceScope {
  /** Sources whose models should be listed/selectable right now. */
  active: ModelSourceProvider[];
  /** Enabled-in-Settings sources that are hidden only because another source is connected. */
  hidden: ModelSourceProvider[];
  /**
   * Why the scope is what it is:
   *  - 'connected': scoped to the enabled sources that have a usable key.
   *  - 'enabled':   no keys anywhere — every enabled source is browsable.
   *  - 'none':      every model source is turned off in Settings.
   */
  reason: 'connected' | 'enabled' | 'none';
}

export const getModelSourceScope = (): ModelSourceScope => {
  const enabled = MODEL_SOURCES.filter(isProviderEnabled);
  if (enabled.length === 0) return { active: [], hidden: [], reason: 'none' };
  const connected = enabled.filter((s) => hasUsableKey(s));
  if (connected.length === 0) return { active: enabled, hidden: [], reason: 'enabled' };
  return {
    active: connected,
    hidden: enabled.filter((s) => !connected.includes(s)),
    reason: 'connected'
  };
};

/** Convenience predicate for filtering catalog lists. */
export const isSourceInScope = (source: string): boolean =>
  getModelSourceScope().active.includes(source as ModelSourceProvider);
