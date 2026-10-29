// The `open_settings` client action (shared/comic/doc.ts ClientAction): a "Raise the budget" chip on a
// budget-cap notice opens Comic settings with the budget cap focused; section 'keys' is the account's
// Settings → API keys, which lives outside the studio. useStudio's runClientAction raises the request;
// the mounted studio shell answers it (useOpenSettingsRequests), the same pattern as the Share sheet.

import { useEffect, useRef } from 'react';

export const OPEN_SETTINGS_EVENT = 'ds:open-settings';
export type SettingsSection = 'budget' | 'keys';
/** The budget cap input in Comic settings (SettingsPanel). */
export const BUDGET_INPUT_ID = 'comicstudio-budget';

/** Only a known section: chips can come from the model. */
export const settingsSectionOf = (value: unknown): SettingsSection | undefined => (value === 'budget' || value === 'keys' ? value : undefined);

/** Ask the mounted shell to open Settings; true when something handled it. */
export const requestOpenSettings = (section?: SettingsSection): boolean => {
  if (typeof window === 'undefined' || typeof CustomEvent !== 'function') return false;
  return !window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { cancelable: true, detail: section ? { section } : {} }));
};

/** Focus an element once it is mounted (a sheet animates in), for at most ~20 frames. */
const focusWhenMounted = (id: string): void => {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return;
  let frames = 0;
  const tick = () => {
    const el = document.getElementById(id);
    if (el) {
      el.focus({ preventScroll: true });
      el.scrollIntoView?.({ block: 'center' });
      return;
    }
    if ((frames += 1) < 20) window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
};

/**
 * The shell's side: open Comic settings (and focus the budget cap) for any request that is not the account's
 * API keys. A 'keys' request is left unhandled, so the studio falls back to Settings → API keys.
 */
export const useOpenSettingsRequests = (open: () => void): void => {
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onRequest = (e: Event) => {
      const section = settingsSectionOf((e as CustomEvent<{ section?: unknown }>).detail?.section);
      if (section === 'keys') return;
      e.preventDefault();
      openRef.current();
      focusWhenMounted(BUDGET_INPUT_ID);
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, onRequest);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onRequest);
  }, []);
};
