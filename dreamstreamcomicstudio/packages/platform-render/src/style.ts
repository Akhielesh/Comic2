/**
 * What a renderer needs from a BrandKit (plan §6): DOCX styles and the deck theme. The shapes are the `docStyles` and
 * `deckTheme` fields of platform-core's `BrandKit` (src/brand/brandKit.ts), so a whole kit can be passed as is;
 * fonts are font-registry ids (`inter`, `space-grotesk`) or family names, resolved by `fontFamilyOf`.
 *
 * Every value that reaches XML is cleaned here: colours become `RRGGBB` or fall back, font names keep only letters,
 * digits, spaces and `.-_` (PptxGenJS writes `typeface="…"` unescaped).
 */
import type { DeckTheme } from '../../platform-core/src/contract/deck.js';
import type { HexColor } from '../../platform-core/src/contract/schema.js';

/** DOCX styles; sizes are points. Same shape as `BrandKit.docStyles`. */
export interface RenderDocStyles {
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

/** Deck masters, used when a deck's `theme.preset` is `'brand'`. Same shape as `BrandKit.deckTheme`. */
export interface RenderDeckTheme {
  theme: DeckTheme;
  titleFont: string;
  bodyFont: string;
}

/** The part of a `BrandKit` the renderers read; a full `BrandKit` is assignable to it. */
export interface RenderBrand {
  /** Written as the file's author and company when the document names none. */
  name?: string;
  docStyles: RenderDocStyles;
  deckTheme: RenderDeckTheme;
}

/** Font-registry id → installed family name (`platformFont(id)?.family` once the brand registry is wired in). */
export type FontFamilyResolver = (id: string) => string | undefined;

/**
 * The default kit: DreamStream's paper-and-ink with the terracotta accent and Inter, the values platform-core's
 * `DREAMSTREAM_BRAND` derives from the skin tokens.
 */
export const DEFAULT_RENDER_BRAND: RenderBrand = {
  name: 'DreamStream',
  docStyles: {
    headingFont: 'inter',
    bodyFont: 'inter',
    headingColor: '#1A1915',
    bodyColor: '#1A1915',
    mutedColor: '#67635A',
    linkColor: '#A0472A',
    accentColor: '#D97757',
    sizes: { body: 11, lead: 13, caption: 9, h1: 24, h2: 18, h3: 14 },
    lineSpacing: 1.15,
  },
  deckTheme: {
    theme: { preset: 'brand', background: '#FFFFFF', text: '#1A1915', accent: '#D97757' },
    titleFont: 'inter',
    bodyFont: 'inter',
  },
};

const HEX = /^#?([0-9A-Fa-f]{6})$/;

/** `#rrggbb` → `RRGGBB`; anything else → `fallback` (already `RRGGBB`). */
export const hexOf = (color: unknown, fallback: string): string => {
  const m = typeof color === 'string' ? HEX.exec(color) : null;
  return m ? m[1].toUpperCase() : fallback;
};

const SAFE_FONT = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$/;
const REGISTRY_ID = /^[a-z][a-z0-9-]{1,40}$/;

/**
 * A font id or family as the family name a file names. The host's resolver wins; a registry-style id
 * (`space-grotesk`) otherwise becomes its words capitalised (`Space Grotesk`; Office matches family names without
 * regard to case); a family name is kept. Anything that is not a plain name falls back to `fallback`.
 */
export const fontFamilyOf = (id: unknown, resolve: FontFamilyResolver | undefined, fallback: string): string => {
  if (typeof id !== 'string' || !id) return fallback;
  let family: string | undefined;
  if (resolve) {
    try {
      family = resolve(id);
    } catch {
      family = undefined;
    }
  }
  if (family === undefined) {
    family = REGISTRY_ID.test(id)
      ? id
          .split('-')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ')
      : id;
  }
  return SAFE_FONT.test(family) ? family : fallback;
};

/** A positive finite number, else the fallback. */
export const sizeOf = (n: unknown, fallback: number, min = 1, max = 400): number =>
  typeof n === 'number' && isFinite(n) && n >= min && n <= max ? n : fallback;

/** The brand to use: the given one, else the default, with every field the renderers read present. */
export const brandOf = (brand: RenderBrand | undefined): RenderBrand => {
  if (!brand || typeof brand !== 'object' || !brand.docStyles || !brand.deckTheme || !brand.deckTheme.theme) return DEFAULT_RENDER_BRAND;
  return brand;
};

/** WCAG relative luminance of `RRGGBB`. */
export const luminance = (hex: string): number => {
  const ch = (i: number): number => {
    const x = parseInt(hex.slice(i, i + 2), 16) / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
};

/** Black-ish or white text, whichever reads better on `fill` (`RRGGBB`). */
export const textOn = (fill: string): string => (luminance(fill) > 0.4 ? '1A1915' : 'FFFFFF');

/**
 * Text as it may go into an Office XML part: XML 1.0 forbids C0 controls other than tab, LF and CR, and lone
 * surrogates; bidi embedding and override characters could disguise text, so they go too (the contract refuses all
 * of these; this is the renderer's own guard).
 */
export const cleanText = (text: unknown): string => {
  if (typeof text !== 'string') return '';
  let out = '';
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let drop = false;
    if (c < 0x20) drop = c !== 0x09 && c !== 0x0a && c !== 0x0d;
    else if (c >= 0x7f && c <= 0x9f) drop = true;
    else if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfffe || c === 0xffff) drop = true;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
        continue;
      }
      drop = true;
    } else if (c >= 0xdc00 && c <= 0xdfff) drop = true;
    if (drop) {
      out += text.slice(from, i);
      from = i + 1;
    }
  }
  return from === 0 ? text : out + text.slice(from);
};
