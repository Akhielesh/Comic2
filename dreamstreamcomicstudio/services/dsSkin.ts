// Design-skin boot (docs/design/atlas-skin.md). Runs synchronously at the very top of index.tsx,
// before React renders, so the page never flickers between looks:
//   1. `data-ds-skin="atlas"` goes on <html> when the page runs on the comics host (productHost
//      `comicsSkin`); nothing happens on the apex — there only the Comic Studio roots carry the
//      attribute (ComicStudio, PublicComicReader, ImmersiveReader).
//   2. The colour tokens are registered as typed <color> properties (CSS.registerProperty, the
//      script form of @property) so index.css's 260 ms theme cross-fade can animate them. It is
//      done here and not as a CSS @property block because a registration is document-wide and
//      Chromium animates registered properties under `transition: all`, which would give every
//      `transition-all` element OUTSIDE the skin a theme cross-fade. The initial values are the
//      :root defaults, so registering changes nothing visually.
//   3. The 400 and 600 body weights of IBM Plex Sans are preloaded (no inline script in
//      index.html: its only inline script is hashed in the CSP).
//   4. Two frames later `data-ds-skin-fade` enables the cross-fade on <html>: adding an attribute
//      that both declares a transition and changes the tokens would animate the boot itself.
// Pure helpers take their collaborators as arguments so productHost.skin.test.ts can run them in
// jsdom without a comics hostname.

import { comicsSkin, DS_SKIN_ATTR, type DsSkin } from './productHost';

export { DS_SKIN_ATTR };
export const DS_SKIN_FADE_ATTR = 'data-ds-skin-fade';

/** Preloaded by the boot code when the skin is on (the other weights load on demand, swap). */
export const ATLAS_PRELOAD_FONTS: readonly string[] = [
  '/fonts/ibm-plex-sans-latin-400-normal.woff2',
  '/fonts/ibm-plex-sans-latin-600-normal.woff2'
];

/**
 * The colour tokens the theme cross-fade animates, with their :root defaults as initial values
 * (index.css is the source of truth; tests/config/atlasSkin.test.ts keeps the two in step).
 */
export const DS_COLOR_TOKENS: ReadonlyArray<{ name: string; initialValue: string }> = [
  { name: '--ds-canvas', initialValue: '#FAF9F5' },
  { name: '--ds-sidebar', initialValue: '#F4F2EC' },
  { name: '--ds-surface', initialValue: 'rgba(255,255,255,0.85)' },
  { name: '--ds-surface-soft', initialValue: 'rgba(255,255,255,0.70)' },
  { name: '--ds-surface-strong', initialValue: 'rgba(255,255,255,0.95)' },
  { name: '--ds-raised', initialValue: '#ffffff' },
  { name: '--ds-ink', initialValue: '#1a1915' },
  { name: '--ds-muted', initialValue: '#67635a' },
  { name: '--ds-hairline', initialValue: 'rgba(0,0,0,0.10)' },
  { name: '--ds-hairline-soft', initialValue: 'rgba(0,0,0,0.05)' },
  { name: '--ds-well', initialValue: 'rgba(0,0,0,0.03)' },
  { name: '--ds-well-strong', initialValue: 'rgba(0,0,0,0.04)' },
  { name: '--ds-hover', initialValue: 'rgba(0,0,0,0.05)' },
  { name: '--ds-faint', initialValue: 'rgba(0,0,0,0.28)' },
  { name: '--ds-accent', initialValue: '#D97757' },
  { name: '--ds-accent-hover', initialValue: '#c2643f' },
  { name: '--ds-on-accent', initialValue: '#ffffff' },
  { name: '--ds-accent-soft', initialValue: 'rgba(217,119,87,0.10)' },
  { name: '--ds-active', initialValue: 'rgba(0,0,0,0.07)' },
  { name: '--ds-success', initialValue: '#16a34a' },
  { name: '--ds-warning', initialValue: '#d97706' },
  { name: '--ds-danger', initialValue: '#dc2626' },
  { name: '--ds-info', initialValue: '#2563eb' },
  { name: '--ds-ring', initialValue: 'rgba(217,119,87,0.45)' }
];

type PropertyRegistry = { registerProperty(def: { name: string; syntax: string; inherits: boolean; initialValue: string }): void };

export interface BootDsSkinOptions {
  document: Document;
  /** Defaults to the page's hostname (productHost.comicsSkin). */
  hostname?: string;
  /** Defaults to the page's `CSS` object; null skips registration. */
  css?: PropertyRegistry | null;
  /** Defaults to window.requestAnimationFrame; null applies the cross-fade attribute at once. */
  raf?: ((cb: () => void) => void) | null;
}

/** Register the colour tokens as typed, inherited <color> properties (idempotent, never throws). */
export const registerDsColorTokens = (css: PropertyRegistry | null | undefined): number => {
  if (!css || typeof css.registerProperty !== 'function') return 0;
  let n = 0;
  for (const { name, initialValue } of DS_COLOR_TOKENS) {
    try {
      css.registerProperty({ name, syntax: '<color>', inherits: true, initialValue });
      n += 1;
    } catch {
      /* already registered (hot reload) or unsupported: the tokens simply switch instantly */
    }
  }
  return n;
};

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
  const root = doc.documentElement;
  root.setAttribute(DS_SKIN_ATTR, skin);
  const css = opts.css === undefined ? ((globalThis as { CSS?: PropertyRegistry }).CSS ?? null) : opts.css;
  registerDsColorTokens(css);
  preloadSkinFonts(doc);
  const raf = opts.raf === undefined ? (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null) : opts.raf;
  const enableFade = () => root.setAttribute(DS_SKIN_FADE_ATTR, '');
  if (raf) raf(() => raf(enableFade));
  else enableFade();
  return skin;
};
