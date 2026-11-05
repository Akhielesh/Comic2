import { useEffect, useState } from 'react';
import { switchDsTheme } from './dsSkin';

// The app theme: light (paper) / dark / system. The choice is persisted (KEY below; public/theme-boot.js
// reads the same key and values to set `dark` before first paint) and applied as a `dark` class on <html>,
// which flips the --ds-* token set in index.css — every surface and widget reads colors from those vars.
// Under a design skin on <html> (every host since bridge D5) a change the person makes is one cross-fade
// of the page (services/dsSkin.ts switchDsTheme); without it the class is simply toggled.

export type ThemePreference = 'light' | 'dark' | 'system';

const KEY = 'ds.theme.v1';
const CHANGED = 'dreamstream:theme-changed';

export const loadThemePreference = (): ThemePreference => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'system' ? v : 'light';
  } catch {
    return 'light';
  }
};

const systemDark = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;

export const resolveIsDark = (pref: ThemePreference): boolean =>
  pref === 'dark' || (pref === 'system' && systemDark());

/** Apply a preference. `animate`: the person just chose it (a cross-fade under the skin); boot syncs and system-theme corrections land at once. */
export const applyTheme = (pref: ThemePreference, opts: { animate?: boolean } = {}): void => {
  switchDsTheme(document.documentElement, resolveIsDark(pref), { animate: opts.animate === true });
};

export const setThemePreference = (pref: ThemePreference): void => {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* preference just won't persist */
  }
  applyTheme(pref, { animate: true });
  window.dispatchEvent(new CustomEvent(CHANGED));
};

/** Apply the persisted theme: once at the app root (index.tsx), so dark applies on every page. Idempotent, so the chat and Comic Studio shells may call it again. */
export const initTheme = (): void => applyTheme(loadThemePreference());

export const useTheme = (): { preference: ThemePreference; isDark: boolean; setPreference: (p: ThemePreference) => void } => {
  const [preference, setPref] = useState<ThemePreference>(loadThemePreference);
  useEffect(() => {
    const sync = () => setPref(loadThemePreference());
    window.addEventListener(CHANGED, sync);
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onSystem = () => applyTheme(loadThemePreference());
    mq?.addEventListener?.('change', onSystem);
    return () => {
      window.removeEventListener(CHANGED, sync);
      mq?.removeEventListener?.('change', onSystem);
    };
  }, []);
  return { preference, isDark: resolveIsDark(preference), setPreference: setThemePreference };
};
