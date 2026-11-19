// One quiet line on My comics in Comic Studio, shown only when the member's own key (BYOK) has reached its monthly limit.
// Members draw on the platform allowance by default, so with no key of their own, or a key under its limit, this renders
// nothing. No colour, no amount: the words and a way to the key settings.

import React, { createContext, useContext, useEffect, useState } from 'react';
import { cn } from '../../../lib/utils';
import { ALL_PROVIDERS, API_KEYS_CHANGED, getActiveKey, isOverLimit, PROVIDER_META, type ManagedApiKey } from '../../../services/apiKeys';
import { getProviderDef } from '../../../shared/providers';
import { Button } from '../../ds/Button';
import { MUTED, WRAP_TEXT } from '../../chat/studioDesign';

/** The first active own key that is over its monthly limit, or null. */
export const overLimitOwnKey = (): ManagedApiKey | null => {
  for (const provider of ALL_PROVIDERS) {
    const key = getActiveKey(provider);
    if (key && isOverLimit(key)) return key;
  }
  return null;
};

/** The provider's short name ("Gemini", not "Google · Gemini"); the full label for the image-only key kinds. */
const providerName = (key: ManagedApiKey): string => getProviderDef(key.provider)?.short ?? PROVIDER_META[key.provider].label;

/**
 * Where the line reads the over-limit key from: the browser's key store. A QA scene provides a fixture instead, so it
 * never writes to (or shows) the keys stored on its origin.
 */
export const OwnKeySource = createContext<() => ManagedApiKey | null>(overLimitOwnKey);

/** Re-reads the key store when it changes here, in another tab, or when the window regains focus (no timer). */
const useKeyStoreVersion = (): number => {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(API_KEYS_CHANGED, bump);
    window.addEventListener('storage', bump);
    window.addEventListener('focus', bump);
    return () => {
      window.removeEventListener(API_KEYS_CHANGED, bump);
      window.removeEventListener('storage', bump);
      window.removeEventListener('focus', bump);
    };
  }, []);
  return version;
};

export function OwnKeyLimitLine({ onManageKeys }: { onManageKeys(): void }) {
  useKeyStoreVersion();
  const key = useContext(OwnKeySource)();
  if (!key) return null;
  return (
    <p className={cn('mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--ds-text-sm)] leading-5', MUTED, WRAP_TEXT)}>
      <span>Your {providerName(key)} key reached its monthly limit.</span>
      <Button variant="ghost" size="sm" className="-my-1 -ml-3 text-[var(--ds-ink)]" onClick={onManageKeys}>
        Manage keys
      </Button>
    </p>
  );
}
