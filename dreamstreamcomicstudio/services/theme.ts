import { useEffect, useState } from 'react';
import { switchDsTheme, type ThemeSwitchEnv } from './dsSkin';

// The app theme: light (paper) / dark / system. The choice is persisted (KEY below; public/theme-boot.js
// reads the same key and values to set `dark` before first paint) and applied as a `dark` class on <html>,
// which flips the --ds-* token set in index.css — every surface and widget reads colors from those vars.
// Under a design skin on <html> (every host since bridge D5) a change the person makes is one cross-fade
// of the page (services/dsSkin.ts switchDsTheme); without it the class is simply toggled.
// The person picks Light, Dark, Paper or System through services/appearance.ts, the one writer of this key
// and of Comic Studio's Paper material. After every flip the browser chrome (`<meta name="theme-color">`)
// takes the page's own canvas, so the status bar follows the choice rather than the OS. System follows the OS
// from one listener initTheme() registers, whatever is mounted.

export type ThemePreference = 'light' | 'dark' | 'system';

/** What a browser that never chose reads as (theme-boot.js spells the same value). */
export const THEME_DEFAULT: ThemePreference = 'light';

const KEY = 'ds.theme.v1';
/** Fired on window after every write (the appearance store listens). */
export const THEME_CHANGED_EVENT = 'dreamstream:theme-changed';

// A choice made while storage is blocked (private mode, a sandboxed frame) holds for this tab.
let unsaved: ThemePreference | undefined;

const isPreference = (v: unknown): v is ThemePreference => v === 'light' || v === 'dark' || v === 'system';

export const loadThemePreference = (): ThemePreference => {
  if (unsaved) return unsaved;
  try {
    const v = localStorage.getItem(KEY);
    return isPreference(v) ? v : THEME_DEFAULT;
  } catch {
    return THEME_DEFAULT;
  }
};

const DARK_QUERY = '(prefers-color-scheme: dark)';

const systemDark = (): boolean => {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.(DARK_QUERY).matches;
  } catch {
    return false;
  }
};

export const resolveIsDark = (pref: ThemePreference): boolean =>
  pref === 'dark' || (pref === 'system' && systemDark());

/**
 * Every `<meta name="theme-color">` (index.html ships one per OS scheme) takes the page's computed `--ds-canvas`,
 * so the status bar and the installed app's title bar match the look the person chose, not the OS. Nothing is
 * written before the stylesheet has given the canvas a value.
 */
export const syncThemeColorMeta = (): void => {
  if (typeof document === 'undefined') return;
  try {
    const canvas = getComputedStyle(document.documentElement).getPropertyValue('--ds-canvas').trim();
    if (!canvas) return;
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.setAttribute('content', canvas);
  } catch {
    /* the chrome keeps its colour */
  }
};

/** The browser's view transition with the theme-color sync inside its update, so a cross-fade moves the chrome when the page changes. */
const viewTransitionThenSync = (): ThemeSwitchEnv['startViewTransition'] => {
  const doc = document as Document & { startViewTransition?: NonNullable<ThemeSwitchEnv['startViewTransition']> };
  if (typeof doc.startViewTransition !== 'function') return null;
  const start = doc.startViewTransition.bind(doc);
  return (update) =>
    start(() => {
      update();
      syncThemeColorMeta();
    });
};

/** Apply a preference. `animate`: the person just chose it (a cross-fade under the skin); boot syncs and system-theme corrections land at once. */
export const applyTheme = (pref: ThemePreference, opts: { animate?: boolean } = {}): void => {
  const animate = opts.animate === true;
  switchDsTheme(document.documentElement, resolveIsDark(pref), animate ? { animate, env: { startViewTransition: viewTransitionThenSync() } } : { animate });
  syncThemeColorMeta();
};

export const setThemePreference = (pref: ThemePreference): void => {
  try {
    localStorage.setItem(KEY, pref);
    unsaved = undefined;
  } catch {
    unsaved = pref; // the preference just won't persist past this tab
  }
  applyTheme(pref, { animate: true });
  if (pref === 'system') followSystem(); // also where initTheme never ran (an embed, the QA harness)
  window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT));
};

// One OS-scheme listener for the page's lifetime: System follows a live switch with nothing mounted (it used to
// live in the Chat hook only). It re-applies only while the stored choice is System.
let followingSystem = false;
const followSystem = (): void => {
  if (followingSystem || typeof window === 'undefined') return;
  let mq: MediaQueryList | undefined;
  try {
    mq = window.matchMedia?.(DARK_QUERY);
  } catch {
    return;
  }
  if (!mq) return;
  const onChange = () => {
    if (loadThemePreference() === 'system') applyTheme('system');
  };
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
  else if (typeof mq.addListener === 'function') mq.addListener(onChange); // Safari before 14
  else return;
  followingSystem = true;
};

/** Apply the persisted theme: once at the app root (index.tsx), so dark applies on every page. Idempotent, so the chat and Comic Studio shells may call it again. */
export const initTheme = (): void => {
  applyTheme(loadThemePreference());
  followSystem();
};

/**
 * Calls `notify` when the preference changes here or in another tab. A change from another tab is applied to this
 * page too (at once, no cross-fade), so every open tab shows the same look.
 */
export const subscribeThemePreference = (notify: () => void): (() => void) => {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== KEY && event.key !== null) return;
    applyTheme(loadThemePreference());
    notify();
  };
  window.addEventListener(THEME_CHANGED_EVENT, notify);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(THEME_CHANGED_EVENT, notify);
    window.removeEventListener('storage', onStorage);
  };
};

export const useTheme = (): { preference: ThemePreference; isDark: boolean; setPreference: (p: ThemePreference) => void } => {
  const [preference, setPref] = useState<ThemePreference>(loadThemePreference);
  useEffect(() => {
    followSystem();
    return subscribeThemePreference(() => setPref(loadThemePreference()));
  }, []);
  return { preference, isDark: resolveIsDark(preference), setPreference: setThemePreference };
};
