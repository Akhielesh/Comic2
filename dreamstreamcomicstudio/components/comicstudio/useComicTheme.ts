import { useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import { COMIC_THEME_ATTRIBUTE, loadComicMaterial, subscribeComicMaterial, type ComicTheme } from '../../services/comicMaterial';
import { loadThemePreference, syncThemeColorMeta } from '../../services/theme';
import { setAppearance } from '../../services/appearance';

// Comic Studio's material, Atlas or the Paper look: the store is services/comicMaterial.ts (re-exported here for the
// screens that read it); the person picks it with the mode through services/appearance.ts.
export { COMIC_THEME_ATTRIBUTE, loadComicMaterial, setComicMaterial, subscribeComicMaterial, type ComicTheme } from '../../services/comicMaterial';

const defaultTheme = (): ComicTheme => 'atlas';

/** Atlas keeps the person's mode; Paper is the light Paper look. Either way both keys are written by the one writer. */
const setTheme = (theme: ComicTheme): void => setAppearance(theme === 'paper' ? 'paper' : loadThemePreference());

export function useComicTheme() {
  return { theme: useSyncExternalStore(subscribeComicMaterial, loadComicMaterial, defaultTheme), setTheme };
}

const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Scope the full document when Comic Studio owns the screen, including dialogs portaled to body: the one writer of
 * <html data-comic-theme> after boot (App keeps it on for the whole comics host). The canvas changes with it, so the
 * browser chrome follows, also when only the material changed (another tab picked Paper on the same light mode).
 */
export function useComicThemeScope(active: boolean): void {
  useBeforePaint(() => {
    if (!active) return;
    const root = document.documentElement;
    const sync = () => {
      if (loadComicMaterial() === 'paper') root.setAttribute(COMIC_THEME_ATTRIBUTE, 'paper');
      else root.removeAttribute(COMIC_THEME_ATTRIBUTE);
      syncThemeColorMeta();
    };
    sync();
    const unsubscribe = subscribeComicMaterial(sync);
    return () => {
      unsubscribe();
      root.removeAttribute(COMIC_THEME_ATTRIBUTE);
      syncThemeColorMeta();
    };
  }, [active]);
}
