import { useEffect, useState } from 'react';

// Chat Studio theme: light (paper) / dark (Claude-style) / system. The choice is
// persisted and applied as a `dark` class on <html>, which flips the --ds-* token
// set in index.css — every studio surface and widget reads colors from those vars.

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

export const applyTheme = (pref: ThemePreference): void => {
  document.documentElement.classList.toggle('dark', resolveIsDark(pref));
};

export const setThemePreference = (pref: ThemePreference): void => {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* preference just won't persist */
  }
  applyTheme(pref);
  window.dispatchEvent(new CustomEvent(CHANGED));
};

/** Apply the persisted theme on startup (call once from the chat shell). */
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
