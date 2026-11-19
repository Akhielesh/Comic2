// The person's appearance (navtheme NT-Q): Light, Dark, Paper or System, one choice for every Comic Studio screen in
// this browser. It is stored in the two keys that already exist, so nothing saved today breaks and public/theme-boot.js
// keeps painting the first frame from them:
//   ds.theme.v1        light | dark | system   (services/theme.ts: the `.dark` class on <html>)
//   ds.comic-theme.v1  atlas | paper           (components/comicstudio/useComicTheme.ts: Comic Studio's material)
// This module is the one writer of both. Paper is the light Paper look (its dark CSS stays unused until the Paper pass),
// so a legacy Paper + dark browser reads as its mode and renders as before until the person picks again.
// The look lands at once on every screen: the class through services/theme.ts (one cross-fade under the skin), and on
// the comics host the material on <html> directly (the Paper tokens key on it there; off the comics host the studio's
// scope hook keeps Paper to Comic Studio screens). A device choice: no account sync, no cookie (navtheme SPEC §4).

import { useSyncExternalStore } from 'react';
import { isComicsHost } from './productHost';
import { loadThemePreference, setThemePreference, subscribeThemePreference, THEME_DEFAULT, type ThemePreference } from './theme';
import { COMIC_THEME_ATTRIBUTE, loadComicMaterial, setComicMaterial, subscribeComicMaterial, type ComicTheme } from '../components/comicstudio/useComicTheme';

export type Appearance = 'light' | 'dark' | 'paper' | 'system';

/** In the order the controls offer them. */
export const APPEARANCES: readonly Appearance[] = ['light', 'dark', 'paper', 'system'];

export const APPEARANCE_LABEL: Record<Appearance, string> = {
  light: 'Light',
  dark: 'Dark',
  paper: 'Paper',
  system: 'System'
};

/** What each choice writes: the light/dark/system mode and the material. */
const WRITES: Record<Appearance, readonly [ThemePreference, ComicTheme]> = {
  light: ['light', 'atlas'],
  dark: ['dark', 'atlas'],
  system: ['system', 'atlas'],
  paper: ['light', 'paper']
};

/** The stored choice: Paper when the material is Paper on the light mode, otherwise the mode. Reading never rewrites. */
export const loadAppearance = (): Appearance => {
  const mode = loadThemePreference();
  return mode === 'light' && loadComicMaterial() === 'paper' ? 'paper' : mode;
};

/** The one writer: both keys, then the page, at once. */
export const setAppearance = (appearance: Appearance): void => {
  const [mode, material] = WRITES[appearance];
  setComicMaterial(material);
  if (isComicsHost() && typeof document !== 'undefined') {
    const root = document.documentElement;
    if (material === 'paper') root.setAttribute(COMIC_THEME_ATTRIBUTE, 'paper');
    else root.removeAttribute(COMIC_THEME_ATTRIBUTE);
  }
  // Last: the material is already on the page, so the theme-color sync that follows the class flip reads the right canvas.
  setThemePreference(mode);
};

const subscribe = (notify: () => void): (() => void) => {
  const offMode = subscribeThemePreference(notify);
  const offMaterial = subscribeComicMaterial(notify);
  return () => {
    offMode();
    offMaterial();
  };
};

const serverSnapshot = (): Appearance => THEME_DEFAULT;

/** The current choice and its setter, following changes made anywhere on the page or in another tab. */
export function useAppearance(): { appearance: Appearance; set: (appearance: Appearance) => void } {
  return { appearance: useSyncExternalStore(subscribe, loadAppearance, serverSnapshot), set: setAppearance };
}
