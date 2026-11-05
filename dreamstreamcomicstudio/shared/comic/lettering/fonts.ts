// Font registry — metadata only (contract §10.2, lettering.md §6.5). Files live in the client loader
// (components/comicstudio/lettering/fontLoader.ts) / the print + export pipelines, never in the doc.
//
// - Latin faces are the 12 self-hosted @fontsource packages pinned in package.json (5.3.0). Their
//   weights, italics, subsets and licences below are copied from each package's metadata.json
//   (verified 2026-10-22); `fonts.test.ts` re-reads node_modules and fails on any drift.
// - Script faces are Google Noto families loaded lazily through the Google Fonts CSS2 API (owner
//   decision: per-script Noto). Licence: SIL OFL 1.1 (google/fonts METADATA.pb, i18n.md §6.2).
// - ONLY 'OFL-1.1' and 'Apache-2.0' are allowed (vitest licence gate). Never Blambot/Comicraft faces
//   and never a shipped "Comic Sans" file (it is only a CSS fallback name for system copies).
//
// Metrics: `avgAdvanceEm` is the calibrated average advance per grapheme of UPPERCASE comic dialogue
// (the classic look). comic-neue is pinned to the server's historical estimate 0.0105 / 0.017; every
// other Latin face is that value × (its measured hmtx advance ÷ Comic Neue Bold's), measured from the
// installed WOFF files on a 140-character dialogue sample. `mixedCaseEm` is the same for as-typed text.
// Non-Latin graphemes use the script's `widthFactor` (languages.ts) relative to the comic-neue value.

import type { ComicDoc, LineKind } from '../doc.js';
import type { ScriptId } from '../languages.js';
import { languageSpec, scriptOf } from '../languages.js';
import { FONT_IDS, resolveLetterStyle, type FontId } from './style.js';

export interface FontFaceMeta {
  id: FontId;
  family: string; // registered family: Latin 'DSL Comic Neue'…; script faces use Google names ('Noto Sans Telugu')
  source: 'fontsource' | 'google-css2';
  license: 'OFL-1.1' | 'Apache-2.0'; // vitest fails on anything else
  weights: number[];
  italic: boolean;
  scripts: ScriptId[]; // coverage
  avgAdvanceEm: number; // metrics estimates (comic-neue = 0.0105 / 0.017 calibrated)
  fallback: string; // CSS fallback stack
  /** npm package that ships the files (fontsource faces only). */
  pkg?: string;
  /** Unicode subsets the files cover (fontsource subset names; Google serves per-script slices). */
  subsets?: string[];
  /** Calibrated average advance for mixed-case (as-typed) text, em. Defaults to avgAdvanceEm. */
  mixedCaseEm?: number;
  /** Display name for pickers and director results ("Comic Neue"). */
  label?: string;
}

/** Licences the registry may carry (anything else fails fonts.test.ts). */
export const LETTERING_FONT_LICENSES: readonly FontFaceMeta['license'][] = ['OFL-1.1', 'Apache-2.0'];

const LATIN_FALLBACK = '"Comic Sans MS", "Chalkboard SE", system-ui, sans-serif';
const DISPLAY_FALLBACK = 'Impact, "Arial Black", system-ui, sans-serif';
const TYPEWRITER_FALLBACK = '"Courier New", ui-monospace, monospace';
const SANS_FALLBACK = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** Calibrated comic-neue advance (the server's historical CHAR_W / fontScale). */
const CN_EM = 0.0105 / 0.017;

const latin = (
  id: FontId,
  name: string,
  pkg: string,
  o: { weights: number[]; italic?: boolean; license?: FontFaceMeta['license']; subsets: string[]; avg: number; mixed: number; scripts?: ScriptId[]; fallback?: string }
): FontFaceMeta => ({
  id,
  family: `DSL ${name}`,
  label: name,
  source: 'fontsource',
  license: o.license ?? 'OFL-1.1',
  weights: o.weights,
  italic: !!o.italic,
  scripts: o.scripts ?? ['Latn'],
  avgAdvanceEm: o.avg,
  mixedCaseEm: o.mixed,
  fallback: o.fallback ?? LATIN_FALLBACK,
  pkg: `@fontsource/${pkg}`,
  subsets: o.subsets
});

/** Noto Sans (Latin) measured 0.5359 em upper / 0.4595 mixed vs Comic Neue Bold 0.5313 → calibrated. */
const NOTO_LATIN_EM = 0.623;
const NOTO_LATIN_MIXED_EM = 0.5342;
const script = (id: FontId, family: string, scripts: ScriptId[], weights: number[]): FontFaceMeta => ({
  id,
  family,
  label: family,
  source: 'google-css2',
  license: 'OFL-1.1',
  weights,
  italic: false,
  scripts,
  avgAdvanceEm: NOTO_LATIN_EM,
  mixedCaseEm: NOTO_LATIN_MIXED_EM,
  fallback: SANS_FALLBACK
});
/** Noto Sans script families are variable (100–900) on Google Fonts; we request the lettering range. */
const NOTO_WEIGHTS = [400, 500, 600, 700, 800, 900];
/** Noto Naskh Arabic / Noto Nastaliq Urdu ship 400–700. */
const ARABIC_WEIGHTS = [400, 500, 600, 700];

export const FONT_REGISTRY: Record<FontId, FontFaceMeta> = {
  'comic-neue': latin('comic-neue', 'Comic Neue', 'comic-neue', { weights: [300, 400, 700], italic: true, subsets: ['latin'], avg: CN_EM, mixed: 0.5024 }),
  bangers: latin('bangers', 'Bangers', 'bangers', { weights: [400], subsets: ['latin', 'latin-ext', 'vietnamese'], avg: 0.4099, mixed: 0.4099, fallback: DISPLAY_FALLBACK }),
  'patrick-hand': latin('patrick-hand', 'Patrick Hand', 'patrick-hand', { weights: [400], subsets: ['latin', 'latin-ext', 'vietnamese'], avg: 0.4771, mixed: 0.4087 }),
  kalam: latin('kalam', 'Kalam', 'kalam', { weights: [300, 400, 700], subsets: ['devanagari', 'latin', 'latin-ext'], avg: 0.6222, mixed: 0.5027, scripts: ['Latn', 'Deva'] }),
  'shantell-sans': latin('shantell-sans', 'Shantell Sans', 'shantell-sans', {
    weights: [300, 400, 500, 600, 700, 800], italic: true, subsets: ['cyrillic', 'cyrillic-ext', 'latin', 'latin-ext', 'vietnamese'], avg: 0.6896, mixed: 0.6014
  }),
  andika: latin('andika', 'Andika', 'andika', { weights: [400, 700], italic: true, subsets: ['cyrillic', 'cyrillic-ext', 'latin', 'latin-ext', 'vietnamese'], avg: 0.6674, mixed: 0.553, fallback: SANS_FALLBACK }),
  atkinson: latin('atkinson', 'Atkinson Hyperlegible', 'atkinson-hyperlegible', { weights: [400, 700], italic: true, subsets: ['latin', 'latin-ext'], avg: 0.6201, mixed: 0.5003, fallback: SANS_FALLBACK }),
  'luckiest-guy': latin('luckiest-guy', 'Luckiest Guy', 'luckiest-guy', { weights: [400], license: 'Apache-2.0', subsets: ['latin', 'latin-ext'], avg: 0.5568, mixed: 0.5717, fallback: DISPLAY_FALLBACK }),
  'permanent-marker': latin('permanent-marker', 'Permanent Marker', 'permanent-marker', { weights: [400], license: 'Apache-2.0', subsets: ['latin'], avg: 0.6737, mixed: 0.5765 }),
  'special-elite': latin('special-elite', 'Special Elite', 'special-elite', { weights: [400], license: 'Apache-2.0', subsets: ['latin', 'latin-ext'], avg: 0.6202, mixed: 0.5863, fallback: TYPEWRITER_FALLBACK }),
  ultra: latin('ultra', 'Ultra', 'ultra', { weights: [400], license: 'Apache-2.0', subsets: ['latin', 'latin-ext'], avg: 0.8081, mixed: 0.7112, fallback: `Georgia, ${DISPLAY_FALLBACK}` }),
  'dela-gothic-one': latin('dela-gothic-one', 'Dela Gothic One', 'dela-gothic-one', {
    weights: [400], subsets: ['cyrillic', 'greek', 'japanese', 'latin', 'latin-ext', 'vietnamese'], avg: 0.8557, mixed: 0.653, scripts: ['Latn', 'Jpan'], fallback: DISPLAY_FALLBACK
  }),
  'noto-sans': script('noto-sans', 'Noto Sans', ['Latn'], NOTO_WEIGHTS),
  'noto-sans-devanagari': script('noto-sans-devanagari', 'Noto Sans Devanagari', ['Deva', 'Latn'], NOTO_WEIGHTS),
  'noto-sans-telugu': script('noto-sans-telugu', 'Noto Sans Telugu', ['Telu', 'Latn'], NOTO_WEIGHTS),
  'noto-sans-tamil': script('noto-sans-tamil', 'Noto Sans Tamil', ['Taml', 'Latn'], NOTO_WEIGHTS),
  'noto-sans-kannada': script('noto-sans-kannada', 'Noto Sans Kannada', ['Knda', 'Latn'], NOTO_WEIGHTS),
  'noto-sans-malayalam': script('noto-sans-malayalam', 'Noto Sans Malayalam', ['Mlym', 'Latn'], NOTO_WEIGHTS),
  'noto-sans-bengali': script('noto-sans-bengali', 'Noto Sans Bengali', ['Beng', 'Latn'], NOTO_WEIGHTS),
  'noto-sans-gujarati': script('noto-sans-gujarati', 'Noto Sans Gujarati', ['Gujr', 'Latn'], NOTO_WEIGHTS),
  'noto-sans-gurmukhi': script('noto-sans-gurmukhi', 'Noto Sans Gurmukhi', ['Guru', 'Latn'], NOTO_WEIGHTS),
  'noto-naskh-arabic': script('noto-naskh-arabic', 'Noto Naskh Arabic', ['Arab', 'Aran'], ARABIC_WEIGHTS),
  'noto-nastaliq-urdu': script('noto-nastaliq-urdu', 'Noto Nastaliq Urdu', ['Aran', 'Arab'], ARABIC_WEIGHTS),
  'noto-sans-jp': script('noto-sans-jp', 'Noto Sans JP', ['Jpan', 'Latn'], NOTO_WEIGHTS),
  'noto-sans-kr': script('noto-sans-kr', 'Noto Sans KR', ['Kore', 'Latn'], NOTO_WEIGHTS),
  'noto-sans-sc': script('noto-sans-sc', 'Noto Sans SC', ['Hans', 'Latn'], NOTO_WEIGHTS)
};

const fontMeta = (fontId: FontId | string | undefined): FontFaceMeta =>
  (typeof fontId === 'string' && Object.prototype.hasOwnProperty.call(FONT_REGISTRY, fontId) ? FONT_REGISTRY[fontId as FontId] : undefined) ??
  FONT_REGISTRY['comic-neue'];

const nearestWeight = (meta: FontFaceMeta, want: number): number => {
  const target = Number.isFinite(want) ? want : 400;
  return meta.weights.reduce((best, w) => (Math.abs(w - target) < Math.abs(best - target) ? w : best), meta.weights[0] ?? 400);
};

/** True when the face has glyphs for the script of `lang` (registry coverage). */
export function fontCoversLanguage(fontId: FontId, lang: string): boolean {
  return fontMeta(fontId).scripts.includes(scriptOf(lang).id);
}

/**
 * Style font kept iff it covers the line's script; else the language's role font (dialogue | sfx).
 * `want` carries the resolved style's weight/italic: the weight snaps to the face's nearest shipped
 * weight (no faux bold) and italic is honoured only for scripts that allow it on faces that ship it
 * (a Latin face without italics gets a synthesized skew from the plan instead).
 */
export function resolveLetteringFont(
  fontId: FontId,
  kind: LineKind,
  lang: string,
  want?: { weight?: number; italic?: boolean }
): { fontId: FontId; family: string; weight: number; italic: boolean } {
  const spec = scriptOf(lang);
  const requested = fontMeta(fontId);
  let meta = requested;
  if (!requested.scripts.includes(spec.id)) {
    const roles = languageSpec(lang)?.fonts;
    const roleId: FontId = roles ? (kind === 'sfx' ? roles.sfx : roles.dialogue) : kind === 'sfx' ? 'bangers' : 'comic-neue';
    meta = fontMeta(roleId);
  }
  const weight = nearestWeight(meta, want?.weight ?? (kind === 'sfx' ? 900 : 700));
  const italic = !!want?.italic && spec.allowItalic && meta.italic;
  return { fontId: meta.id, family: meta.family, weight, italic };
}

/** CSS font-family value: the registered family, then the face's fallback stack. */
export function fontFamilyStack(fontId: FontId): string {
  const meta = fontMeta(fontId);
  return `"${meta.family}", ${meta.fallback}`;
}

/** Canvas/CSS font shorthand with fallbacks. */
export function fontString(fontId: FontId, px: number, weight: number, italic: boolean): string {
  const meta = fontMeta(fontId);
  const size = Number.isFinite(px) ? Math.max(1, Math.round(px * 100) / 100) : 1;
  return `${italic ? 'italic ' : ''}${nearestWeight(meta, weight)} ${size}px ${fontFamilyStack(meta.id)}`;
}

/** Registry entry for a registered family name ('DSL Bangers', 'Noto Sans Telugu'); used by estimators. */
let BY_FAMILY: Map<string, FontFaceMeta> | undefined;
export function fontByFamily(family: string): FontFaceMeta | undefined {
  const key = typeof family === 'string' ? family.trim().toLowerCase() : '';
  if (!key) return undefined;
  if (!BY_FAMILY) BY_FAMILY = new Map(FONT_IDS.map((id) => [FONT_REGISTRY[id].family.toLowerCase(), FONT_REGISTRY[id]]));
  return BY_FAMILY.get(key);
}

/**
 * Google Fonts CSS2 href for the lazily loaded script faces among `ids` (fontsource faces are
 * self-hosted and skipped). Undefined when none are needed. Weights are clamped to each face's range.
 */
export function googleFontsHref(ids: readonly FontId[], weights: readonly number[] = [400, 700]): string | undefined {
  const families: string[] = [];
  for (const id of [...new Set(ids)].filter((x) => FONT_IDS.includes(x)).sort()) {
    const meta = FONT_REGISTRY[id];
    if (meta.source !== 'google-css2') continue;
    const ws = [...new Set(weights.map((w) => nearestWeight(meta, w)))].sort((a, b) => a - b);
    families.push(`family=${meta.family.replace(/ /g, '+')}:wght@${ws.join(';')}`);
  }
  return families.length ? `https://fonts.googleapis.com/css2?${families.join('&')}&display=swap` : undefined;
}

/** What a page/export needs: every resolved line font, mapped through each language's script coverage. */
export function fontsForDoc(doc: ComicDoc, langs?: string[]): FontId[] {
  const out = new Set<FontId>();
  const base = [doc.format.language, ...(langs || [])].filter((l): l is string => typeof l === 'string' && !!l);
  for (const page of doc.pages)
    for (const panel of page.panels)
      for (const line of panel.lines) {
        const style = resolveLetterStyle(doc, line);
        const languages = line.lang ? [...base, line.lang] : base;
        for (const lang of languages) out.add(resolveLetteringFont(style.font, line.kind, lang).fontId);
      }
  // Overlay cover title / tagline faces chosen explicitly (CoverTitleLayer).
  const cover = doc.cover?.titleStyle;
  for (const patch of [cover?.title, cover?.tagline]) {
    const id = patch?.font;
    if (!id || !FONT_IDS.includes(id)) continue;
    for (const lang of base) out.add(resolveLetteringFont(id, 'caption', lang).fontId);
  }
  return FONT_IDS.filter((id) => out.has(id));
}
