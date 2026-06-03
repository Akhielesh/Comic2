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

import { ALL_PROVIDERS, type ApiKeyProvider } from './apiKeys';

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
