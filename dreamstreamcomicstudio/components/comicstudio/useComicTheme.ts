import { useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import { loadThemePreference } from '../../services/theme';
import { setAppearance } from '../../services/appearance';

/** Comic Studio's material: Atlas, or the Paper look. The person picks it with the mode through services/appearance.ts. */
export type ComicTheme = 'atlas' | 'paper';

// The blocking script in public/theme-boot.js reads the same key on the comics host.
const THEME_KEY = 'ds.comic-theme.v1';
const THEME_CHANGED = 'dreamstream:comic-theme-changed';
export const COMIC_THEME_ATTRIBUTE = 'data-comic-theme';
const THEME_ATTRIBUTE = COMIC_THEME_ATTRIBUTE;
const defaultTheme = (): ComicTheme => 'atlas';
let temporaryTheme: ComicTheme | undefined;

/** The stored material (Atlas when nothing or something unknown is stored). */
export const loadComicMaterial = (): ComicTheme => readTheme();

function readTheme(): ComicTheme {
  if (temporaryTheme) return temporaryTheme;
  try {
    return window.localStorage.getItem(THEME_KEY) === 'paper' ? 'paper' : 'atlas';
  } catch {
    return 'atlas';
  }
}

/** Store the material alone (services/appearance.ts calls it with the mode; nothing else should). */
export const setComicMaterial = (theme: ComicTheme): void => {
  try {
    window.localStorage.setItem(THEME_KEY, theme);
    temporaryTheme = undefined;
  } catch {
    // Keep the chosen appearance for this tab if the browser blocks storage.
    temporaryTheme = theme;
  }
  window.dispatchEvent(new Event(THEME_CHANGED));
};

/** Calls `notify` when the material changes here or in another tab. */
export const subscribeComicMaterial = (notify: () => void): (() => void) => {
  const syncStorage = (event: StorageEvent) => {
    if (event.key === THEME_KEY || event.key === null) notify();
  };
  window.addEventListener(THEME_CHANGED, notify);
  window.addEventListener('storage', syncStorage);
  return () => {
    window.removeEventListener(THEME_CHANGED, notify);
    window.removeEventListener('storage', syncStorage);
  };
};

const subscribe = subscribeComicMaterial;

/** Atlas keeps the person's mode; Paper is the light Paper look. Either way both keys are written by the one writer. */
const setTheme = (theme: ComicTheme): void => setAppearance(theme === 'paper' ? 'paper' : loadThemePreference());

export function useComicTheme() {
  return { theme: useSyncExternalStore(subscribe, readTheme, defaultTheme), setTheme };
}

const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Scope the full document when Comic Studio owns the screen, including dialogs portaled to body. */
export function useComicThemeScope(active: boolean): void {
  useBeforePaint(() => {
    if (!active) return;
    const root = document.documentElement;
    const sync = () => {
      if (readTheme() === 'paper') root.setAttribute(THEME_ATTRIBUTE, 'paper');
      else root.removeAttribute(THEME_ATTRIBUTE);
    };
    sync();
    const unsubscribe = subscribe(sync);
    return () => {
      unsubscribe();
      root.removeAttribute(THEME_ATTRIBUTE);
    };
  }, [active]);
}
