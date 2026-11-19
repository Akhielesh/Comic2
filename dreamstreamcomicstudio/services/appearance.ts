// The person's appearance (navtheme NT-Q): Light, Dark, Paper or System, one choice for every Comic Studio screen in
// this browser. It is stored in the two keys that already exist, so nothing saved today breaks and public/theme-boot.js
// keeps painting the first frame from them:
//   ds.theme.v1        light | dark | system   (services/theme.ts: the `.dark` class on <html>)
//   ds.comic-theme.v1  atlas | paper           (services/comicMaterial.ts: Comic Studio's material)
// services/theme.ts setThemePreference writes both, Atlas unless Paper is asked for; this module maps the four choices
// onto it. Paper is the light Paper look (its dark CSS stays unused until the Paper pass), so a legacy Paper + dark
// browser reads as its mode and renders as before until the person picks again (see `appearanceSettled`).
// The look lands at once on every screen, in one cross-fade under the skin: the class through services/theme.ts, and
// the material through its change event, which the scope hook (components/comicstudio/useComicTheme.ts) turns into
// <html data-comic-theme>: App mounts it for the whole app on the comics host (useComicsHost), and off the comics host
// Comic Studio mounts it for its own screens. A device choice: no account sync, no cookie (navtheme SPEC §4).

import { useSyncExternalStore } from 'react';
import { loadComicMaterial, subscribeComicMaterial, type ComicTheme } from './comicMaterial';
import { loadThemePreference, setThemePreference, subscribeThemePreference, THEME_DEFAULT, type ThemePreference } from './theme';

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

/**
 * False for a pair no choice writes (a legacy Paper with the dark or System mode): it reads as its mode, but the
 * controls check nothing, so pressing that mode still writes it with Atlas.
 */
export const appearanceSettled = (): boolean => loadThemePreference() === 'light' || loadComicMaterial() === 'atlas';

/** Both keys, then the page, in one flip. */
export const setAppearance = (appearance: Appearance): void => {
  const [mode, material] = WRITES[appearance];
  setThemePreference(mode, material);
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

const serverSettled = (): boolean => true;

/** The current choice and its setter, following changes made anywhere on the page or in another tab. `settled`: see appearanceSettled. */
export function useAppearance(): { appearance: Appearance; settled: boolean; set: (appearance: Appearance) => void } {
  const appearance = useSyncExternalStore(subscribe, loadAppearance, serverSnapshot);
  const settled = useSyncExternalStore(subscribe, appearanceSettled, serverSettled);
  return { appearance, settled, set: setAppearance };
}
