import { useEffect, useState } from 'react';
import { announceComicMaterial, storeComicMaterial, type ComicTheme } from './comicMaterial';
import { switchDsTheme, type ThemeSwitchEnv } from './dsSkin';

// The app theme: light (paper) / dark / system. The choice is persisted (KEY below; public/theme-boot.js
// reads the same key and values to set `dark` before first paint) and applied as a `dark` class on <html>,
// which flips the --ds-* token set in index.css — every surface and widget reads colors from those vars.
// Under a design skin on <html> (every host since bridge D5) a change the person makes is one cross-fade
// of the page (services/dsSkin.ts switchDsTheme); without it the class is simply toggled.
// The person picks Light, Dark, Paper or System through services/appearance.ts. setThemePreference writes this
// key and Comic Studio's material (services/comicMaterial.ts, Atlas unless Paper is asked for) together, and the
// material reaches the page inside the same flip as the class, so a change is one cross-fade and never makes a new
// Dark + Paper pair. After every flip the look's own browser-chrome colours (index.html's two
// `<meta name="theme-color" media>`) take the page's canvas, so the status bar follows the choice rather than
// the OS; a screen that owns the colour for a while (the immersive reader's room) holds it. System follows the
// OS from one listener initTheme() registers, whatever is mounted.

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

// Screens that own the chrome colour while they are open (the immersive reader's room, an explicit useThemeColor
// colour). While any holds it, the look's sync leaves the metas alone.
let colourHolds = 0;

/** Take the chrome colour for a while; the returned release (safe to call twice) hands it back. */
export const holdThemeColor = (): (() => void) => {
  colourHolds += 1;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    colourHolds -= 1;
  };
};

/** Whether a screen holds the chrome colour now (useThemeColor's canvas tint waits too). */
export const themeColorHeld = (): boolean => colourHolds > 0;

/**
 * The look's own `<meta name="theme-color" media>` (index.html ships one per OS scheme) take the page's computed
 * `--ds-canvas`, so the status bar and the installed app's title bar match the look the person chose, not the OS.
 * An unscoped theme-color belongs to someone else (a share page's head carries its comic's colour) and is left
 * alone, as is everything while a screen holds the colour. Nothing is written before the stylesheet has given the
 * canvas a value.
 */
export const syncThemeColorMeta = (): void => {
  if (typeof document === 'undefined' || colourHolds > 0) return;
  try {
    const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"][media]');
    if (!metas.length) return;
    const canvas = getComputedStyle(document.documentElement).getPropertyValue('--ds-canvas').trim();
    if (!canvas) return;
    for (const meta of metas) meta.setAttribute('content', canvas);
  } catch {
    /* the chrome keeps its colour */
  }
};

/** The browser's view transition with `alongside` and the theme-color sync inside its update, so the whole look changes in the one cross-fade. */
const viewTransitionWith = (alongside: () => void): ThemeSwitchEnv['startViewTransition'] => {
  const doc = document as Document & { startViewTransition?: NonNullable<ThemeSwitchEnv['startViewTransition']> };
  if (typeof doc.startViewTransition !== 'function') return null;
  const start = doc.startViewTransition.bind(doc);
  return (update) =>
    start(() => {
      update();
      alongside();
      syncThemeColorMeta();
    });
};

/**
 * Apply a preference. `animate`: the person just chose it (a cross-fade under the skin); boot syncs and system-theme
 * corrections land at once. `alongside` runs with the class flip: inside the cross-fade's update when there is one,
 * otherwise straight after the flip (also when the class does not change).
 */
export const applyTheme = (pref: ThemePreference, opts: { animate?: boolean; alongside?: () => void } = {}): void => {
  const animate = opts.animate === true;
  let pending = opts.alongside;
  const runAlongside = () => {
    const run = pending;
    pending = undefined;
    run?.();
  };
  const result = switchDsTheme(
    document.documentElement,
    resolveIsDark(pref),
    animate ? { animate, env: { startViewTransition: viewTransitionWith(runAlongside) } } : { animate }
  );
  // A cross-fade changes the rest of the look, chrome included, in its update; nothing moves before the browser's snapshot.
  if (result === 'cross-fade') return;
  runAlongside();
  syncThemeColorMeta();
};

/**
 * The person's choice: the mode and Comic Studio's material, stored together and shown in one flip. The material is
 * Atlas unless Paper is asked for (services/appearance.ts maps Light, Dark, Paper and System onto this), so Chat's own
 * Light/Dark/System also clears a leftover Paper.
 */
export const setThemePreference = (pref: ThemePreference, material: ComicTheme = 'atlas'): void => {
  try {
    localStorage.setItem(KEY, pref);
    unsaved = undefined;
  } catch {
    unsaved = pref; // the preference just won't persist past this tab
  }
  storeComicMaterial(material);
  applyTheme(pref, { animate: true, alongside: announceComicMaterial });
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

/** Chat's Light/Dark/System: the same writer as the four-way choice, with Atlas. */
const setPreference = (pref: ThemePreference): void => setThemePreference(pref);

export const useTheme = (): { preference: ThemePreference; isDark: boolean; setPreference: (p: ThemePreference) => void } => {
  const [preference, setPref] = useState<ThemePreference>(loadThemePreference);
  useEffect(() => {
    followSystem();
    return subscribeThemePreference(() => setPref(loadThemePreference()));
  }, []);
  return { preference, isDark: resolveIsDark(preference), setPreference };
};
