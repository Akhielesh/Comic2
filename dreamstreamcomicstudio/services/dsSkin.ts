// Design-skin boot and theme switch (docs/design/atlas-skin.md). The boot runs synchronously at the
// very top of index.tsx, before React renders, so the page never flickers between looks:
//   1. `data-ds-skin="atlas"` goes on <html> when the page runs on the comics host (productHost
//      `comicsSkin`); nothing happens on the apex — there only the Comic Studio roots carry the
//      attribute (ComicStudio, PublicComicReader, ImmersiveReader).
//   2. The 400 and 600 body weights of IBM Plex Sans are preloaded (no inline script in
//      index.html: its only inline script is hashed in the CSP).
// The theme switch (Atlas wave 5, providers/ThemeProvider.tsx there): changing light/dark under the
// skin is ONE cross-fade of the whole page — `.dark` flips inside document.startViewTransition, the
// two root snapshots fade over --ds-motion-theme on the compositor, and `ds-no-transitions` holds
// every element's own colour transition for that one style change. Only a change the person just
// asked for fades; a boot sync or a system-theme correction, reduced motion, a hidden page or a
// browser without the API switch at once (still with transitions held, so hundreds of TRANSITION
// elements never animate their colours one by one). Outside the skin the switch is exactly the old
// `.dark` toggle. (D0 registered the colour tokens as typed properties and transitioned them; Atlas
// dropped that because it restyled every element on every frame of the fade.)
// Pure helpers take their collaborators as arguments so the tests run them in jsdom.

import { comicsSkin, DS_SKIN_ATTR, type DsSkin } from './productHost';

export { DS_SKIN_ATTR };

/** Preloaded by the boot code when the skin is on (the other weights load on demand, swap). */
export const ATLAS_PRELOAD_FONTS: readonly string[] = [
  '/fonts/ibm-plex-sans-latin-400-normal.woff2',
  '/fonts/ibm-plex-sans-latin-600-normal.woff2'
];

/** On <html> while light and dark cross-fade (index.css styles the root view transition). */
export const DS_THEME_TRANSITION_CLASS = 'ds-theme-transition';
/** On <html> for the one style change that flips the theme: no element runs a CSS transition. */
export const DS_NO_TRANSITIONS_CLASS = 'ds-no-transitions';

export interface BootDsSkinOptions {
  document: Document;
  /** Defaults to the page's hostname (productHost.comicsSkin). */
  hostname?: string;
}

/** Append `<link rel="preload" as="font">` for the body weights, once per href. */
export const preloadSkinFonts = (doc: Document, hrefs: readonly string[] = ATLAS_PRELOAD_FONTS): number => {
  const head = doc.head;
  if (!head) return 0;
  let n = 0;
  for (const href of hrefs) {
    if (head.querySelector(`link[rel="preload"][href="${href}"]`)) continue;
    const link = doc.createElement('link');
    // Attributes, not properties: `as` is not reflected by every DOM (jsdom), and the test asserts
    // the markup the browser's preload scanner sees.
    link.setAttribute('rel', 'preload');
    link.setAttribute('as', 'font');
    link.setAttribute('type', 'font/woff2');
    link.setAttribute('href', href);
    link.setAttribute('crossorigin', 'anonymous');
    head.appendChild(link);
    n += 1;
  }
  return n;
};

/**
 * Put the page under its host's skin. Returns the skin applied (null on the apex, where nothing is
 * touched). Safe to call more than once (the QA harness boots it per page).
 */
export const bootDsSkin = (opts: BootDsSkinOptions): DsSkin | null => {
  const { document: doc } = opts;
  const skin = opts.hostname === undefined ? comicsSkin() : comicsSkin(opts.hostname);
  if (!skin) return null;
  doc.documentElement.setAttribute(DS_SKIN_ATTR, skin);
  preloadSkinFonts(doc);
  return skin;
};

// ── Theme switch ─────────────────────────────────────────────────────────────────────────────────

export interface ViewTransitionLike {
  ready: Promise<unknown>;
  finished: Promise<unknown>;
  updateCallbackDone: Promise<unknown>;
}

/** What the switch reads from the browser (injected by the tests). */
export interface ThemeSwitchEnv {
  /** document.startViewTransition, bound; null where the browser has none. */
  startViewTransition: ((update: () => void) => ViewTransitionLike) | null;
  reducedMotion: boolean;
  /** document.visibilityState is not 'hidden'. */
  visible: boolean;
  /** navigator.userActivation.isActive — the person clicked or pressed a key moments ago (true where the API is missing). */
  userActive: boolean;
  raf: ((cb: () => void) => void) | null;
}

export type ThemeSwitchResult = 'toggled' | 'unchanged' | 'instant' | 'cross-fade';

const browserEnv = (): ThemeSwitchEnv => {
  const doc = typeof document === 'undefined' ? null : (document as Document & { startViewTransition?: (update: () => void) => ViewTransitionLike });
  const start = doc && typeof doc.startViewTransition === 'function' ? doc.startViewTransition.bind(doc) : null;
  const win = typeof window === 'undefined' ? null : window;
  const activation = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  return {
    startViewTransition: start,
    reducedMotion: !!win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    visible: !doc || doc.visibilityState !== 'hidden',
    userActive: activation ? activation.isActive : true,
    raf: win && typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : null
  };
};

/** Lets transitions run again once the frame that carries the theme change has been styled. */
const releaseAfterFrame = (root: HTMLElement, raf: ThemeSwitchEnv['raf']) => {
  const release = () => root.classList.remove(DS_NO_TRANSITIONS_CLASS);
  if (raf) raf(() => raf(release));
  else setTimeout(release, 32);
};

let latestCrossFade = 0;

/**
 * Flip `.dark` on `root`. Outside the skin (no `data-ds-skin` on it) this is exactly the old
 * `classList.toggle('dark', isDark)`. Under the skin: nothing when the theme is already right; one
 * view-transition cross-fade when `animate` (the person asked for it) and the browser, the motion
 * setting, the page's visibility and a recent user activation allow; otherwise an instant switch
 * with every element transition held for that frame.
 */
export const switchDsTheme = (
  root: HTMLElement,
  isDark: boolean,
  opts: { animate?: boolean; env?: Partial<ThemeSwitchEnv> } = {}
): ThemeSwitchResult => {
  if (!root.hasAttribute(DS_SKIN_ATTR)) {
    root.classList.toggle('dark', isDark);
    return 'toggled';
  }
  if (root.classList.contains('dark') === isDark) return 'unchanged';
  const env: ThemeSwitchEnv = { ...browserEnv(), ...opts.env };
  const flip = () => {
    root.classList.add(DS_NO_TRANSITIONS_CLASS);
    root.classList.toggle('dark', isDark);
  };
  const instant = (): ThemeSwitchResult => {
    flip();
    releaseAfterFrame(root, env.raf);
    return 'instant';
  };
  const start = env.startViewTransition;
  if (!opts.animate || !start || env.reducedMotion || !env.visible || !env.userActive) return instant();

  const id = ++latestCrossFade;
  root.classList.add(DS_THEME_TRANSITION_CLASS);
  const cleanUp = () => {
    if (id === latestCrossFade) root.classList.remove(DS_THEME_TRANSITION_CLASS);
  };
  try {
    const transition = start(flip);
    transition.ready.catch(() => undefined);
    const release = () => releaseAfterFrame(root, env.raf);
    transition.updateCallbackDone.then(release, release);
    transition.finished.then(cleanUp, cleanUp);
    return 'cross-fade';
  } catch {
    cleanUp();
    return instant();
  }
};
