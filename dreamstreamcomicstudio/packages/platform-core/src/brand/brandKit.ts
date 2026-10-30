/**
 * BrandKit (plan §6): one record that themes the UI skin data AND the files the platform produces (email header,
 * body and button colours; DOCX heading and body styles; deck theme). Pure data plus pure helpers.
 *
 * - Colours are `#RRGGBB` and contrast-checked (`checkBrandKit`, WCAG 2.x ratios, 4.5:1 for text).
 * - Fonts are font-registry ids (`fonts.ts`), never raw CSS, so a kit can never inject CSS into a rendered email.
 * - The logo is an `AssetRef` (a `data:` image or a host asset id), never a URL.
 * - The built-in kits (`dreamstream`, `atlas`) are DERIVED from the skin tokens, so the files we produce match the
 *   app chrome and change with it.
 *
 * Per-workspace and per-creator kits are stored by the host (deferred, plan §3); `checkBrandKit` is the gate a host
 * runs before it saves or uses one.
 */
import type { DeckTheme } from '../contract/deck.js';
import type { AssetRef, HexColor } from '../contract/schema.js';
import { HEX_COLOR_PATTERN, ID_PATTERN } from '../contract/schema.js';
import { check } from '../schema/check.js';
import { s } from '../schema/s.js';
import { platformFont } from './fonts.js';
import { ATLAS_SKIN } from './skins/atlas.js';
import { DREAMSTREAM_SKIN } from './skins/dreamstream.js';

// ── Skins (design tokens as data) ───────────────────────────────────────────────────────────────────────────────

export type SkinId = 'dreamstream' | 'atlas';

/** A `--ds-*` custom property → its CSS value, exactly as written in `index.css`. */
export interface SkinTokenMap {
  readonly [token: string]: string;
}

export interface SkinTokens {
  id: SkinId;
  light: SkinTokenMap;
  dark: SkinTokenMap;
  /** `@media (prefers-contrast: more)` overrides, where the skin has them. */
  highContrast?: { light: SkinTokenMap; dark: SkinTokenMap };
}

export const SKINS: { readonly [K in SkinId]: SkinTokens } = { dreamstream: DREAMSTREAM_SKIN, atlas: ATLAS_SKIN };

/**
 * A token's value with its own `var(--…)` references followed (light mode by default; dark tokens fall back to the
 * light value, as CSS cascades). `undefined` for an unknown token or a reference loop.
 */
export const skinToken = (skin: SkinTokens, name: string, mode: 'light' | 'dark' = 'light'): string | undefined => {
  let value: string | undefined;
  let key = name;
  for (let hop = 0; hop < 8; hop++) {
    value = (mode === 'dark' && Object.prototype.hasOwnProperty.call(skin.dark, key) ? skin.dark[key] : undefined) ??
      (Object.prototype.hasOwnProperty.call(skin.light, key) ? skin.light[key] : undefined);
    if (value === undefined) return undefined;
    const ref = /^var\((--[a-z0-9-]+)\)$/.exec(value.trim());
    if (!ref) return value.trim();
    key = ref[1];
  }
  return undefined;
};

// ── Colours ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const HEX = new RegExp(HEX_COLOR_PATTERN);

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));

/** `#rgb`, `#rrggbb`, `rgb()`/`rgba()` in the comma or the space-and-slash form; anything else (`oklch`, `color-mix`) is `undefined`. */
export const parseCssColor = (value: string): Rgba | undefined => {
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), a: 1 };
  m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: 1 };
  m = /^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*(?:[,/]\s*([0-9.]+)\s*)?\)$/.exec(v);
  if (m) {
    const a = m[4] === undefined ? 1 : Number(m[4]);
    if (![m[1], m[2], m[3]].every((x) => isFinite(Number(x))) || !isFinite(a)) return undefined;
    return { r: clamp255(Number(m[1])), g: clamp255(Number(m[2])), b: clamp255(Number(m[3])), a: Math.max(0, Math.min(1, a)) };
  }
  return undefined;
};

const hex2 = (n: number): string => `0${clamp255(n).toString(16)}`.slice(-2);

/** A colour as `#rrggbb`, with any transparency composited over `over` (default white). */
export const flattenColor = (value: string, over: HexColor = '#ffffff'): HexColor | undefined => {
  const c = parseCssColor(value);
  const base = parseCssColor(over);
  if (!c || !base) return undefined;
  const mix = (x: number, y: number): number => x * c.a + y * (1 - c.a);
  return `#${hex2(mix(c.r, base.r))}${hex2(mix(c.g, base.g))}${hex2(mix(c.b, base.b))}`;
};

const channel = (v: number): number => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};

/** WCAG 2.x relative luminance of an opaque colour; `NaN` when it cannot be read. */
export const relativeLuminance = (color: string): number => {
  const c = parseCssColor(color);
  if (!c) return NaN;
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
};

/** WCAG 2.x contrast ratio (1–21) of two opaque colours; `NaN` when either cannot be read. */
export const contrastRatio = (a: string, b: string): number => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** Text (and a label on a fill) must reach this ratio: WCAG 2.x AA for normal text. */
export const TEXT_CONTRAST_MIN = 4.5;

// ── The kit ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every colour a produced file uses, opaque `#RRGGBB`. */
export interface BrandColors {
  /** The page behind the card. */
  canvas: HexColor;
  /** The card and document paper. */
  surface: HexColor;
  /** Body text. */
  ink: HexColor;
  /** Secondary text (captions, quotes, footers). */
  muted: HexColor;
  /** The brand fill (buttons, accents). */
  accent: HexColor;
  /** Accent-coloured TEXT (links): readable on `surface`. */
  accentText: HexColor;
  /** A label on an `accent` fill. */
  onAccent: HexColor;
  /** Hairlines and dividers, flattened onto `surface`. */
  border: HexColor;
}

/** Registry ids (`fonts.ts`). */
export interface BrandFonts {
  body: string;
  display: string;
}

export interface BrandEmailTheme {
  /** Above the card: nothing, the `logo` image, or the `wordmark` text. A user's own draft has no header by default. */
  header: 'none' | 'logo' | 'wordmark';
  /** One plain-text line under the card (for example a creator's sign-off); absent shows nothing. */
  footer?: string;
  /** Card corner radius, px. */
  radius: number;
  /** Button corner radius, px. */
  buttonRadius: number;
}

/** DOCX styles (W1.7 renders RichDoc with these). Sizes are points. */
export interface BrandDocStyles {
  headingFont: string;
  bodyFont: string;
  headingColor: HexColor;
  bodyColor: HexColor;
  mutedColor: HexColor;
  linkColor: HexColor;
  accentColor: HexColor;
  sizes: { body: number; lead: number; caption: number; h1: number; h2: number; h3: number };
  /** Line spacing multiple. */
  lineSpacing: number;
}

/** Deck masters (W1.7 renders DeckSpec with these when `theme.preset` is `'brand'`). */
export interface BrandDeckTheme {
  theme: DeckTheme;
  titleFont: string;
  bodyFont: string;
}

export interface BrandKit {
  /** `ID_PATTERN`; what `EmailDoc.brand` names. */
  id: string;
  /** Display name (one line, at most `BRAND_LIMITS.name`). */
  name: string;
  /** The UI skin this kit pairs with. */
  skin: SkinId;
  colors: BrandColors;
  fonts: BrandFonts;
  /** The text mark used when there is no logo (one line, at most `BRAND_LIMITS.wordmark`). */
  wordmark: string;
  /** A `data:` image or a host asset id; never a URL. */
  logo?: AssetRef;
  emailTheme: BrandEmailTheme;
  docStyles: BrandDocStyles;
  deckTheme: BrandDeckTheme;
  /** A print profile id (wave 2, `PrintSpec`); absent until print lands. */
  printProfile?: string;
}

export const BRAND_LIMITS = {
  name: 100,
  wordmark: 60,
  footer: 500,
  radiusMax: 32,
  printProfile: 64,
} as const;

// ── Built-in kits, derived from the skins ──────────────────────────────────────────────────────────────────────

const must = (v: string | undefined, what: string): string => {
  if (v === undefined) throw new Error(`brand: cannot derive ${what} from the skin tokens`);
  return v;
};

/** A skin token as an opaque hex colour (composited over `over`). Throws at module load if a skin stops deriving. */
const tokenHex = (skin: SkinTokens, name: string, over?: HexColor): HexColor => must(flattenColor(must(skinToken(skin, name), name), over), name);

/** `1rem` / `0.75rem` / `12px` → px (16 px per rem). */
const tokenPx = (skin: SkinTokens, name: string): number => {
  const v = must(skinToken(skin, name), name);
  const m = /^([0-9.]+)(rem|px)$/.exec(v);
  if (!m) throw new Error(`brand: ${name} is not a length`);
  return Math.round(Number(m[1]) * (m[2] === 'rem' ? 16 : 1));
};

const colorsOf = (skin: SkinTokens): BrandColors => {
  const surface = tokenHex(skin, '--ds-raised');
  return {
    canvas: tokenHex(skin, '--ds-canvas'),
    surface,
    ink: tokenHex(skin, '--ds-ink'),
    muted: tokenHex(skin, '--ds-muted'),
    accent: tokenHex(skin, '--ds-accent-fill'),
    accentText: tokenHex(skin, '--ds-accent-text'),
    onAccent: tokenHex(skin, '--ds-on-accent'),
    border: tokenHex(skin, '--ds-hairline', surface),
  };
};

const docStylesOf = (c: BrandColors, fonts: BrandFonts): BrandDocStyles => ({
  headingFont: fonts.display,
  bodyFont: fonts.body,
  headingColor: c.ink,
  bodyColor: c.ink,
  mutedColor: c.muted,
  linkColor: c.accentText,
  accentColor: c.accent,
  sizes: { body: 11, lead: 13, caption: 9, h1: 24, h2: 18, h3: 14 },
  lineSpacing: 1.15,
});

const kitFrom = (skin: SkinTokens, id: string, name: string, wordmark: string, fonts: BrandFonts): BrandKit => {
  const colors = colorsOf(skin);
  return {
    id,
    name,
    skin: skin.id,
    colors,
    fonts,
    wordmark,
    emailTheme: { header: 'none', radius: tokenPx(skin, '--ds-radius-panel'), buttonRadius: tokenPx(skin, '--ds-radius-control') },
    docStyles: docStylesOf(colors, fonts),
    deckTheme: { theme: { preset: 'brand', background: colors.surface, text: colors.ink, accent: colors.accent }, titleFont: fonts.display, bodyFont: fonts.body },
  };
};

/** DreamStream: paper and ink with the terracotta accent; Inter (the skin's `--ds-font-sans` and `--ds-font-display`). */
export const DREAMSTREAM_BRAND: BrandKit = kitFrom(DREAMSTREAM_SKIN, 'dreamstream', 'DreamStream', 'DreamStream', { body: 'inter', display: 'inter' });

/** Atlas: monochrome ink on white; IBM Plex Sans body and Space Grotesk headings (the skin's font tokens). */
export const ATLAS_BRAND: BrandKit = kitFrom(ATLAS_SKIN, 'atlas', 'Atlas', 'Atlas', { body: 'ibm-plex-sans', display: 'space-grotesk' });

export const BRAND_KITS: readonly BrandKit[] = [DREAMSTREAM_BRAND, ATLAS_BRAND];

/** The default kit when a document names none (or one the host does not know). */
export const DEFAULT_BRAND: BrandKit = DREAMSTREAM_BRAND;

/** The built-in kit with this id, else `DEFAULT_BRAND`. */
export const brandKitById = (id: string | undefined): BrandKit => {
  for (const k of BRAND_KITS) if (k.id === id) return k;
  return DEFAULT_BRAND;
};

// ── Validation ──────────────────────────────────────────────────────────────────────────────────────────────────

export type BrandIssueCode = 'id' | 'text' | 'color' | 'contrast' | 'font' | 'logo' | 'radius';

export interface BrandIssue {
  path: string;
  code: BrandIssueCode;
  message: string;
}

const ID = new RegExp(ID_PATTERN);
const LOGO = s.assetRef();
const NAME = s.text({ max: BRAND_LIMITS.name, min: 1, singleLine: true });
const WORDMARK = s.text({ max: BRAND_LIMITS.wordmark, min: 1, singleLine: true });
const FOOTER = s.text({ max: BRAND_LIMITS.footer, singleLine: true });
const PROFILE = s.id({ max: BRAND_LIMITS.printProfile });

const isObject = (v: unknown): v is { [k: string]: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The text-on-background pairs every kit must clear (`TEXT_CONTRAST_MIN`). */
const CONTRAST_PAIRS: readonly [keyof BrandColors, keyof BrandColors][] = [
  ['ink', 'surface'],
  ['ink', 'canvas'],
  ['muted', 'surface'],
  ['muted', 'canvas'],
  ['accentText', 'surface'],
  ['onAccent', 'accent'],
];

/**
 * Everything wrong with a kit (empty when it is usable): malformed ids and text, colours that are not `#RRGGBB`,
 * text pairs under 4.5:1 (ink, muted and links on the surface; ink and muted (the footer) on the canvas; the button label on the accent;
 * the DOCX and deck text colours on their paper), font ids the registry does not know, a logo that is not a valid
 * `AssetRef`, radii out of range. Never throws, whatever it is given.
 */
export const checkBrandKit = (kit: unknown): BrandIssue[] => {
  const out: BrandIssue[] = [];
  const add = (path: string, code: BrandIssueCode, message: string): void => {
    out.push({ path, code, message });
  };
  if (!isObject(kit)) return [{ path: '', code: 'text', message: 'a BrandKit must be an object' }];
  const k = kit as Partial<BrandKit>;
  if (typeof k.id !== 'string' || !ID.test(k.id)) add('id', 'id', 'must be an id (letters, digits, _ . : -; at most 64)');
  if (!check(NAME, k.name).ok) add('name', 'text', `must be one line of 1–${BRAND_LIMITS.name} characters`);
  if (!check(WORDMARK, k.wordmark).ok) add('wordmark', 'text', `must be one line of 1–${BRAND_LIMITS.wordmark} characters`);
  if (k.skin !== 'dreamstream' && k.skin !== 'atlas') add('skin', 'id', 'must be "dreamstream" or "atlas"');

  const colors = isObject(k.colors) ? (k.colors as { [key: string]: unknown }) : {};
  const keys: (keyof BrandColors)[] = ['canvas', 'surface', 'ink', 'muted', 'accent', 'accentText', 'onAccent', 'border'];
  for (const key of keys) {
    const v = colors[key];
    if (typeof v !== 'string' || !HEX.test(v)) add(`colors.${key}`, 'color', 'must be #RRGGBB');
  }
  for (const [fg, bg] of CONTRAST_PAIRS) {
    const a = colors[fg];
    const b = colors[bg];
    if (typeof a !== 'string' || typeof b !== 'string' || !HEX.test(a) || !HEX.test(b)) continue;
    const ratio = contrastRatio(a, b);
    if (!(ratio >= TEXT_CONTRAST_MIN)) add(`colors.${fg}`, 'contrast', `${fg} on ${bg} is ${ratio.toFixed(2)}:1; text needs at least ${TEXT_CONTRAST_MIN}:1`);
  }

  const fontIds: [string, unknown][] = [];
  if (isObject(k.fonts)) fontIds.push(['fonts.body', k.fonts.body], ['fonts.display', k.fonts.display]);
  else add('fonts', 'font', 'must name a body and a display font');
  if (isObject(k.docStyles)) fontIds.push(['docStyles.headingFont', k.docStyles.headingFont], ['docStyles.bodyFont', k.docStyles.bodyFont]);
  if (isObject(k.deckTheme)) fontIds.push(['deckTheme.titleFont', k.deckTheme.titleFont], ['deckTheme.bodyFont', k.deckTheme.bodyFont]);
  for (const [path, id] of fontIds) if (typeof id !== 'string' || !platformFont(id)) add(path, 'font', 'must be a font registry id (brand/fonts.ts)');

  if (k.logo !== undefined && !check(LOGO, k.logo).ok) add('logo', 'logo', 'must be a data: image (PNG, JPEG or WebP, at most 5 MB) or a host asset id');

  const email = isObject(k.emailTheme) ? (k.emailTheme as Partial<BrandEmailTheme>) : undefined;
  if (!email) add('emailTheme', 'text', 'is required');
  else {
    if (email.header !== 'none' && email.header !== 'logo' && email.header !== 'wordmark') add('emailTheme.header', 'text', 'must be "none", "logo" or "wordmark"');
    if (email.header === 'logo' && k.logo === undefined) add('emailTheme.header', 'logo', 'a logo header needs a logo');
    if (email.footer !== undefined && !check(FOOTER, email.footer).ok) add('emailTheme.footer', 'text', `must be one line of at most ${BRAND_LIMITS.footer} characters`);
    for (const r of ['radius', 'buttonRadius'] as const) {
      const v = email[r];
      if (typeof v !== 'number' || !(v >= 0 && v <= BRAND_LIMITS.radiusMax) || Math.round(v) !== v) add(`emailTheme.${r}`, 'radius', `must be a whole number of px from 0 to ${BRAND_LIMITS.radiusMax}`);
    }
  }

  if (isObject(k.docStyles)) {
    const d = k.docStyles as Partial<BrandDocStyles>;
    for (const c of ['headingColor', 'bodyColor', 'mutedColor', 'linkColor'] as const) {
      const v = d[c];
      if (typeof v !== 'string' || !HEX.test(v)) add(`docStyles.${c}`, 'color', 'must be #RRGGBB');
      else if (!(contrastRatio(v, '#ffffff') >= TEXT_CONTRAST_MIN)) add(`docStyles.${c}`, 'contrast', `is under ${TEXT_CONTRAST_MIN}:1 on white paper`);
    }
  } else add('docStyles', 'text', 'is required');

  if (isObject(k.deckTheme) && isObject(k.deckTheme.theme)) {
    const t = k.deckTheme.theme as Partial<DeckTheme>;
    for (const c of ['background', 'text', 'accent'] as const) {
      const v = t[c];
      if (v !== undefined && (typeof v !== 'string' || !HEX.test(v))) add(`deckTheme.theme.${c}`, 'color', 'must be #RRGGBB');
    }
    if (typeof t.text === 'string' && typeof t.background === 'string' && HEX.test(t.text) && HEX.test(t.background) && !(contrastRatio(t.text, t.background) >= TEXT_CONTRAST_MIN)) {
      add('deckTheme.theme.text', 'contrast', `is under ${TEXT_CONTRAST_MIN}:1 on the deck background`);
    }
  } else add('deckTheme', 'text', 'is required');

  if (k.printProfile !== undefined && !check(PROFILE, k.printProfile).ok) add('printProfile', 'id', 'must be a print profile id');
  return out;
};
