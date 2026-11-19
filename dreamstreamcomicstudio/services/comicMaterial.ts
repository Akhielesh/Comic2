// Comic Studio's material (navtheme NT-Q): Atlas, or the Paper look. The store alone: its key, read, write and change
// events. public/theme-boot.js reads the same key on the comics host before first paint. The person picks the material
// together with the light/dark mode through services/appearance.ts; services/theme.ts writes both in one flip, so this
// module imports neither of them.

export type ComicTheme = 'atlas' | 'paper';

const KEY = 'ds.comic-theme.v1';
const CHANGED = 'dreamstream:comic-theme-changed';
/** The attribute on <html> (or a screen's root) that the Paper tokens in styles/comic-theme.css key on. */
export const COMIC_THEME_ATTRIBUTE = 'data-comic-theme';

// A choice made while storage is blocked (private mode, a sandboxed frame) holds for this tab.
let unsaved: ComicTheme | undefined;

/** The stored material (Atlas when nothing or something unknown is stored). */
export const loadComicMaterial = (): ComicTheme => {
  if (unsaved) return unsaved;
  try {
    return window.localStorage.getItem(KEY) === 'paper' ? 'paper' : 'atlas';
  } catch {
    return 'atlas';
  }
};

/** Store the material without telling the page yet (services/theme.ts tells it inside the theme flip). */
export const storeComicMaterial = (theme: ComicTheme): void => {
  try {
    window.localStorage.setItem(KEY, theme);
    unsaved = undefined;
  } catch {
    unsaved = theme;
  }
};

/** Tell this page the material changed: every scope and screen re-reads it. */
export const announceComicMaterial = (): void => {
  window.dispatchEvent(new Event(CHANGED));
};

/** Store the material alone and repaint at once (tests and the QA harness; the person's choice goes through services/appearance.ts). */
export const setComicMaterial = (theme: ComicTheme): void => {
  storeComicMaterial(theme);
  announceComicMaterial();
};

/** Calls `notify` when the material changes here or in another tab. */
export const subscribeComicMaterial = (notify: () => void): (() => void) => {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) notify();
  };
  window.addEventListener(CHANGED, notify);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGED, notify);
    window.removeEventListener('storage', onStorage);
  };
};
