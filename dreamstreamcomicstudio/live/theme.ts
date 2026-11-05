/**
 * Appearance: theme / accent / density / corners — persisted, applied to <html>.
 *
 * Two looks, one switch: `data-ds-skin="atlas"` on <html> (static in live.html; the build's kill
 * switch strips it) puts Stream Studio in the Atlas language (live/styles/atlas-skin.css):
 * monochrome, hue only for status. Under it the accent picker is gone and no `--accent*` is written
 * inline (an inline style would beat the skin's tokens); a stored accent is kept, never deleted, so
 * turning the skin off brings it back. Density (calm / pro) and corners (soft / sharp) stay the
 * person's choice in both looks. Without the attribute everything is exactly as it was.
 *
 * public/live-theme-boot.js applies the same stored appearance before first paint (the page allows
 * no inline script); live/themeBoot.unit.test.ts keeps its key and parsing equal to parseAppearance.
 */

export type Theme = 'light' | 'dark';
export type Density = 'calm' | 'pro';
export type Corners = 'soft' | 'sharp';
export type StudioLayout = 'chat-right' | 'chat-left' | 'cinema';

export interface Appearance {
  theme: Theme;
  accent: string;
  density: Density;
  corners: Corners;
  studioLayout: StudioLayout;
}

interface AccentDef {
  label: string;
  sw: string;
  l: { a: string; a2: string; ink: string; wash: string };
  d: { a: string; a2: string; ink: string; wash: string };
}

export const ACCENTS: Record<string, AccentDef> = {
  clay:  { label: 'Clay',  sw: '#c2603f', l: { a: '#c2603f', a2: '#d8795a', ink: '#a64e30', wash: '#f3e3d8' }, d: { a: '#d8795a', a2: '#e08a6d', ink: '#e89c80', wash: '#3a2c25' } },
  sage:  { label: 'Sage',  sw: '#5f7d4f', l: { a: '#5f7d4f', a2: '#6f9159', ink: '#4d6740', wash: '#e6ecdc' }, d: { a: '#86a86f', a2: '#95b87d', ink: '#9cc081', wash: '#2d3526' } },
  slate: { label: 'Slate', sw: '#4f6f96', l: { a: '#4f6f96', a2: '#5f80a8', ink: '#3f5c80', wash: '#e0e7f0' }, d: { a: '#7d9dc2', a2: '#8eaecf', ink: '#9bb6d4', wash: '#283440' } },
  plum:  { label: 'Plum',  sw: '#7d5577', l: { a: '#7d5577', a2: '#916589', ink: '#684463', wash: '#efe4ed' }, d: { a: '#b288a8', a2: '#c098b6', ink: '#c7a3bd', wash: '#352a33' } },
};

/** The accent properties applyAppearance writes inline when the skin is off. */
const ACCENT_PROPS = ['--accent', '--accent-2', '--accent-ink', '--accent-wash'] as const;

/** Cover-theme gradients shared by the create form, invite page and join gate. */
export const COVER_THEMES: [string, string][] = [
  ['#c2603f', '#8a4a2f'], ['#4f7396', '#37536f'], ['#5f8a5a', '#3f6b3c'],
  ['#7d5577', '#553a52'], ['#b5832c', '#7d5a1c'], ['#3d3a35', '#1f1c19'],
];

/** The ink cover: the default for a new event under the Atlas skin (covers stay the host's choice). */
export const INK_COVER = COVER_THEMES.length - 1;

/** Under the Atlas skin the ink cover is true ink (the cream studio's is a warm near-black). */
const ATLAS_INK_COVER: [string, string] = ['#3a3a3a', '#0a0a0a'];

/** A cover's two gradient stops (index clamped); the other covers are the host's choice, kept as they are. */
export const coverStops = (i: number): [string, string] => {
  const at = Math.min(COVER_THEMES.length - 1, Math.max(0, Number.isFinite(i) ? Math.trunc(i) : 0));
  if (at === INK_COVER && atlasSkin()) return ATLAS_INK_COVER;
  return COVER_THEMES[at] || COVER_THEMES[0];
};

export const coverGradient = (i: number): string => {
  const c = coverStops(i);
  return `linear-gradient(135deg, ${c[0]}, ${c[1]})`;
};

/** Stream Studio is in the Atlas language (the attribute live.html carries on <html>). */
export function atlasSkin(): boolean {
  try {
    return document.documentElement.getAttribute('data-ds-skin') === 'atlas';
  } catch {
    return false; // no document (workers, node)
  }
}

/** The cover a new event starts with: the ink one under the skin, clay without it (as before). */
export const defaultCover = (): number => (atlasSkin() ? INK_COVER : 0);

export const APPEARANCE_KEY = 'ds-live-appearance';
/** The single-key theme setting older builds wrote; read once when there is no appearance yet. */
export const LEGACY_THEME_KEY = 'ds-live-theme';

const DEFAULTS: Appearance = { theme: 'light', accent: 'clay', density: 'calm', corners: 'soft', studioLayout: 'chat-right' };

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

/**
 * The stored appearance → a valid one. Light by default whatever the OS says (as Atlas). A value
 * this build doesn't know (a hand-edited or corrupted entry) falls back to its default instead of
 * reaching the page as an attribute; the accent is kept as stored (it is only read without the skin).
 * public/live-theme-boot.js mirrors this exactly — change both together.
 */
export function parseAppearance(raw: string | null, legacy: string | null): Appearance {
  let parsed: Record<string, unknown> = {};
  if (raw) {
    try {
      const v: unknown = JSON.parse(raw);
      if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as Record<string, unknown>;
    } catch {
      /* unreadable: defaults */
    }
  }
  // Migrate the old single-key theme setting if present (only when there's no appearance yet).
  const legacyTheme: Theme | null = legacy && !raw ? (legacy === 'light' ? 'light' : 'dark') : null;
  return {
    theme: pick(parsed.theme, ['light', 'dark'], legacyTheme ?? DEFAULTS.theme),
    accent: typeof parsed.accent === 'string' ? parsed.accent : DEFAULTS.accent,
    density: pick(parsed.density, ['calm', 'pro'], DEFAULTS.density),
    corners: pick(parsed.corners, ['soft', 'sharp'], DEFAULTS.corners),
    studioLayout: pick(parsed.studioLayout, ['chat-right', 'chat-left', 'cinema'], DEFAULTS.studioLayout),
  };
}

export function loadAppearance(): Appearance {
  try {
    return parseAppearance(localStorage.getItem(APPEARANCE_KEY), localStorage.getItem(LEGACY_THEME_KEY));
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAppearance(a: Appearance): void {
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(a));
  } catch {
    /* storage unavailable (private mode) */
  }
}

/**
 * The browser chrome's colour (<meta name="theme-color">) for a theme: the page background, so the
 * status bar and the page are one surface. public/live-theme-boot.js holds the same four values.
 */
export function themeColorFor(theme: Theme, skin: boolean = atlasSkin()): string {
  if (skin) return theme === 'dark' ? '#0a0a0a' : '#ffffff';
  return theme === 'dark' ? '#211e1a' : '#f4f2ea';
}

function syncThemeColor(theme: Theme, skin: boolean): void {
  const color = themeColorFor(theme, skin);
  // Every theme-color meta (live.html has one per colour scheme): the in-app theme wins over the OS.
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    if (m.getAttribute('content') !== color) m.setAttribute('content', color);
  });
}

/** Writes theme/density/corners onto <html> as data-attrs, and the accent as CSS vars (skin off only). */
export function applyAppearance(a: Appearance): void {
  const el = document.documentElement;
  const skin = atlasSkin();
  el.setAttribute('data-theme', a.theme);
  el.setAttribute('data-density', a.density);
  el.setAttribute('data-corners', a.corners);
  syncThemeColor(a.theme, skin);
  if (skin) {
    // Hue never decorates under the skin: an inline accent would beat its tokens (P8). Clear any
    // left by an earlier call; the stored accent itself stays.
    for (const p of ACCENT_PROPS) el.style.removeProperty(p);
    return;
  }
  const ac = ACCENTS[a.accent] || ACCENTS.clay;
  const v = a.theme === 'dark' ? ac.d : ac.l;
  el.style.setProperty('--accent', v.a);
  el.style.setProperty('--accent-2', v.a2);
  el.style.setProperty('--accent-ink', v.ink);
  el.style.setProperty('--accent-wash', v.wash);
}

/**
 * A theme flip under the skin: one cross-fade of the whole page (Atlas's view transition), with
 * every element's own colour transition held for that one change, so nothing fades twice. Without
 * the skin, the View Transitions API or under reduced motion, `apply` simply runs.
 */
export function switchTheme(apply: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };
  let reduced = false;
  try {
    reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    /* no matchMedia (tests) */
  }
  if (!atlasSkin() || reduced || typeof doc.startViewTransition !== 'function' || document.visibilityState === 'hidden') {
    apply();
    return;
  }
  const el = document.documentElement;
  el.classList.add('live-theme-transition', 'live-no-transitions');
  try {
    const t = doc.startViewTransition(() => {
      apply();
    });
    const done = () => el.classList.remove('live-theme-transition', 'live-no-transitions');
    t.finished.then(done, done);
  } catch {
    el.classList.remove('live-theme-transition', 'live-no-transitions');
    apply();
  }
}
