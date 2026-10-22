// Font registry — metadata only (contract §10.2). WAVE-0 STUB (minimal registry: ids → families);
// P1-LETTER-ENGINE fills the calibrated metrics. Files live in the client loader / server image.
// Latin faces are self-hosted (@fontsource); script faces load lazily via Google Fonts CSS2.

import type { ComicDoc, LineKind } from '../doc.js';
import type { ScriptId } from '../languages.js';
import { languageSpec, scriptOf } from '../languages.js';
import { FONT_IDS, resolveLetterStyle, type FontId } from './style.js';

export interface FontFaceMeta {
  id: FontId; family: string; // registered family: Latin 'DSL Comic Neue'…; script faces use Google names ('Noto Sans Telugu')
  source: 'fontsource' | 'google-css2';
  license: 'OFL-1.1' | 'Apache-2.0'; // vitest fails on anything else
  weights: number[]; italic: boolean;
  scripts: ScriptId[]; // coverage
  avgAdvanceEm: number; // metrics estimates (comic-neue = 0.0105 / 0.017 calibrated)
  fallback: string; // CSS fallback stack
}

const LATIN_FALLBACK = '"Comic Sans MS", "Chalkboard SE", system-ui, sans-serif';
const latin = (id: FontId, name: string, weights: number[], italic = false, avg = 0.6): FontFaceMeta => ({
  id, family: `DSL ${name}`, source: 'fontsource', license: 'OFL-1.1', weights, italic, scripts: ['Latn'], avgAdvanceEm: avg, fallback: LATIN_FALLBACK
});
const script = (id: FontId, family: string, scripts: ScriptId[], weights: number[], avg = 0.7): FontFaceMeta => ({
  id, family, source: 'google-css2', license: 'OFL-1.1', weights, italic: false, scripts, avgAdvanceEm: avg, fallback: 'system-ui, sans-serif'
});
const NOTO_WEIGHTS = [400, 500, 600, 700, 800, 900];

export const FONT_REGISTRY: Record<FontId, FontFaceMeta> = {
  'comic-neue': latin('comic-neue', 'Comic Neue', [400, 700], true, 0.0105 / 0.017),
  bangers: latin('bangers', 'Bangers', [400]),
  'patrick-hand': latin('patrick-hand', 'Patrick Hand', [400]),
  kalam: { ...latin('kalam', 'Kalam', [400, 700]), scripts: ['Latn', 'Deva'] },
  'shantell-sans': latin('shantell-sans', 'Shantell Sans', [400, 500, 600, 700, 800], true),
  andika: latin('andika', 'Andika', [400, 700], true),
  atkinson: latin('atkinson', 'Atkinson Hyperlegible', [400, 700], true),
  'luckiest-guy': latin('luckiest-guy', 'Luckiest Guy', [400]),
  'permanent-marker': latin('permanent-marker', 'Permanent Marker', [400]),
  'special-elite': latin('special-elite', 'Special Elite', [400]),
  ultra: latin('ultra', 'Ultra', [400]),
  'dela-gothic-one': { ...latin('dela-gothic-one', 'Dela Gothic One', [400]), scripts: ['Latn', 'Jpan'] },
  'noto-sans': script('noto-sans', 'Noto Sans', ['Latn'], NOTO_WEIGHTS, 0.6),
  'noto-sans-devanagari': script('noto-sans-devanagari', 'Noto Sans Devanagari', ['Deva', 'Latn'], NOTO_WEIGHTS),
  'noto-sans-telugu': script('noto-sans-telugu', 'Noto Sans Telugu', ['Telu', 'Latn'], NOTO_WEIGHTS),
  'noto-sans-tamil': script('noto-sans-tamil', 'Noto Sans Tamil', ['Taml', 'Latn'], NOTO_WEIGHTS),
  'noto-sans-kannada': script('noto-sans-kannada', 'Noto Sans Kannada', ['Knda', 'Latn'], NOTO_WEIGHTS),
  'noto-sans-malayalam': script('noto-sans-malayalam', 'Noto Sans Malayalam', ['Mlym', 'Latn'], NOTO_WEIGHTS),
  'noto-sans-bengali': script('noto-sans-bengali', 'Noto Sans Bengali', ['Beng', 'Latn'], NOTO_WEIGHTS),
  'noto-sans-gujarati': script('noto-sans-gujarati', 'Noto Sans Gujarati', ['Gujr', 'Latn'], NOTO_WEIGHTS),
  'noto-sans-gurmukhi': script('noto-sans-gurmukhi', 'Noto Sans Gurmukhi', ['Guru', 'Latn'], NOTO_WEIGHTS),
  'noto-naskh-arabic': script('noto-naskh-arabic', 'Noto Naskh Arabic', ['Arab', 'Aran'], [400, 500, 600, 700]),
  'noto-nastaliq-urdu': script('noto-nastaliq-urdu', 'Noto Nastaliq Urdu', ['Aran', 'Arab'], [400, 500, 600, 700]),
  'noto-sans-jp': script('noto-sans-jp', 'Noto Sans JP', ['Jpan', 'Latn'], NOTO_WEIGHTS, 1),
  'noto-sans-kr': script('noto-sans-kr', 'Noto Sans KR', ['Kore', 'Latn'], NOTO_WEIGHTS, 0.95),
  'noto-sans-sc': script('noto-sans-sc', 'Noto Sans SC', ['Hans', 'Latn'], NOTO_WEIGHTS, 1)
};

const nearestWeight = (meta: FontFaceMeta, want: number): number =>
  meta.weights.reduce((best, w) => (Math.abs(w - want) < Math.abs(best - want) ? w : best), meta.weights[0] ?? 400);

/** Style font kept iff it covers the line's script; else the language's role font (dialogue | sfx). */
export function resolveLetteringFont(fontId: FontId, kind: LineKind, lang: string): { fontId: FontId; family: string; weight: number; italic: boolean } {
  const s = scriptOf(lang).id;
  const requested = FONT_REGISTRY[fontId] ?? FONT_REGISTRY['comic-neue'];
  let meta = requested;
  if (!requested.scripts.includes(s)) {
    const roles = languageSpec(lang)?.fonts;
    const roleId = roles ? (kind === 'sfx' ? roles.sfx : roles.dialogue) : kind === 'sfx' ? 'bangers' : 'comic-neue';
    meta = FONT_REGISTRY[roleId] ?? requested;
  }
  return { fontId: meta.id, family: meta.family, weight: nearestWeight(meta, kind === 'sfx' ? 900 : 700), italic: false };
}

/** Canvas/CSS font shorthand with fallbacks. */
export function fontString(fontId: FontId, px: number, weight: number, italic: boolean): string {
  const meta = FONT_REGISTRY[fontId] ?? FONT_REGISTRY['comic-neue'];
  return `${italic ? 'italic ' : ''}${nearestWeight(meta, weight)} ${Math.max(1, Math.round(px * 100) / 100)}px "${meta.family}", ${meta.fallback}`;
}

/** What a page/export needs: every resolved line font, mapped through each language's script coverage. */
export function fontsForDoc(doc: ComicDoc, langs?: string[]): FontId[] {
  const out = new Set<FontId>();
  const languages = [doc.format.language, ...(langs || [])];
  for (const page of doc.pages)
    for (const panel of page.panels)
      for (const line of panel.lines) {
        const style = resolveLetterStyle(doc, line);
        for (const lang of languages) out.add(resolveLetteringFont(style.font, line.kind, lang).fontId);
      }
  return FONT_IDS.filter((id) => out.has(id));
}
