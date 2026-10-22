// Lettering style — ONE `LetteringStyle` for fonts, colours, opacity, bubble shapes and tails.
//
// Contract §10.1 (wave 0, exact). Dependency-free; imports only TYPES from doc.ts (cycle rule §2).
// Resolution order for one line:
//   preset.base → preset.kinds[kind] → doc.base → doc.kinds[kind] → doc.speakers[speakerId] → line.style
// `classic` is regression-locked to the pre-v5 constants (balloonGeometry.ts LETTERING / KIND_FONT_SCALE),
// so every existing doc (normalized to `{ presetId: 'classic' }`) letters exactly as before.

import type { Brief, ComicDoc, Format, Line, LineKind } from '../doc.js';

export type LatinFontId =
  | 'comic-neue' | 'bangers' | 'patrick-hand' | 'kalam' | 'shantell-sans' | 'andika'
  | 'atkinson' | 'luckiest-guy' | 'permanent-marker' | 'special-elite' | 'ultra' | 'dela-gothic-one';
export type ScriptFontId =
  | 'noto-sans' | 'noto-sans-devanagari' | 'noto-sans-telugu' | 'noto-sans-tamil' | 'noto-sans-kannada'
  | 'noto-sans-malayalam' | 'noto-sans-bengali' | 'noto-sans-gujarati' | 'noto-sans-gurmukhi'
  | 'noto-naskh-arabic' | 'noto-nastaliq-urdu' | 'noto-sans-jp' | 'noto-sans-kr' | 'noto-sans-sc';
export type FontId = LatinFontId | ScriptFontId;

/** Ids only; metadata (families, weights, licenses) lives in lettering/fonts.ts. */
export const FONT_IDS: readonly FontId[] = [
  'comic-neue', 'bangers', 'patrick-hand', 'kalam', 'shantell-sans', 'andika',
  'atkinson', 'luckiest-guy', 'permanent-marker', 'special-elite', 'ultra', 'dela-gothic-one',
  'noto-sans', 'noto-sans-devanagari', 'noto-sans-telugu', 'noto-sans-tamil', 'noto-sans-kannada',
  'noto-sans-malayalam', 'noto-sans-bengali', 'noto-sans-gujarati', 'noto-sans-gurmukhi',
  'noto-naskh-arabic', 'noto-nastaliq-urdu', 'noto-sans-jp', 'noto-sans-kr', 'noto-sans-sc'
];

export type TextCase = 'upper' | 'as_typed' | 'lower' | 'title';
export type BubbleShape =
  | 'squircle' | 'oval' | 'rounded_rect' | 'rect' | 'notched' | 'scroll' | 'ribbon' | 'cloud'
  | 'burst' | 'explosion' | 'jagged' | 'wavy' | 'electronic' | 'none';
export type BorderStyle = 'solid' | 'dashed' | 'dotted' | 'double' | 'none';
export type TailStyle = 'auto' | 'curved' | 'straight' | 'pointer' | 'bubbles' | 'lightning' | 'none';
export type SfxEffect = 'filled_stroke' | 'outlined' | 'shadow' | 'skewed' | 'arched' | 'pop';
/** '#rrggbb' | '#rrggbbaa' (alpha = opacity) | 'none' | 'auto' (SFX palette hash). */
export type Color = string;
export interface TextStroke { color: Color; width: number } // em 0..0.3
export interface DropShadow { color: Color; dx: number; dy: number } // em −0.3..0.3

export const TEXT_CASES: readonly TextCase[] = ['upper', 'as_typed', 'lower', 'title'];
export const BUBBLE_SHAPES: readonly BubbleShape[] = [
  'squircle', 'oval', 'rounded_rect', 'rect', 'notched', 'scroll', 'ribbon', 'cloud',
  'burst', 'explosion', 'jagged', 'wavy', 'electronic', 'none'
];
export const BORDER_STYLES: readonly BorderStyle[] = ['solid', 'dashed', 'dotted', 'double', 'none'];
export const TAIL_STYLES: readonly TailStyle[] = ['auto', 'curved', 'straight', 'pointer', 'bubbles', 'lightning', 'none'];
export const SFX_EFFECTS: readonly SfxEffect[] = ['filled_stroke', 'outlined', 'shadow', 'skewed', 'arched', 'pop'];
export const FONT_WEIGHTS = [400, 500, 600, 700, 800, 900] as const;
export const LINE_KINDS: readonly LineKind[] = ['speech', 'thought', 'caption', 'sfx', 'whisper', 'shout'];

/** Fully resolved style of one line (every field present after resolveLetterStyle). */
export interface LetterStyle {
  font: FontId;
  sizeScale: number; // × kind base size (KIND_FONT_SCALE); 0.5..3.5
  weight: 400 | 500 | 600 | 700 | 800 | 900; // snapped to the face's nearest shipped weight
  italic: boolean; // faces without italics get a deterministic skewX(−10°); never for non-Latin scripts
  textCase: TextCase;
  letterSpacing: number; // em −0.05..0.3 (forced 0 where script.allowLetterSpacing is false)
  lineHeight: number; // 0.9..1.8 (× script lineHeight factor)
  align: 'center' | 'left' | 'right';
  textColor: Color;
  textStroke: TextStroke | null;
  shadow: DropShadow | null;
  fill: Color;
  border: Color;
  borderWidth: number; // × base stroke (0.0028 page width); 0..4
  borderStyle: BorderStyle;
  shape: BubbleShape;
  tail: TailStyle;
  tailWidth: number; // × default root width; 0.4..2
  padding: number; // × base padding; 0..3
  rotate: number | 'auto'; // deg −30..30; 'auto' = today's SFX hash tilt
  sfxEffect: SfxEffect; // read only for kind 'sfx'
  arc: number; // −1..1
}
export type LetterStylePatch = Partial<LetterStyle>;

export type LetteringPresetId = 'classic' | 'manga' | 'storybook' | 'noir' | 'webtoon' | 'retro_pulp' | 'minimal' | 'handwritten';
export const LETTERING_PRESET_IDS: readonly LetteringPresetId[] = [
  'classic', 'manga', 'storybook', 'noir', 'webtoon', 'retro_pulp', 'minimal', 'handwritten'
];

export interface LetteringStyle {
  presetId: LetteringPresetId;
  /** true = the director may switch preset when kind/audience changes (never after a manual pick). */
  auto?: boolean;
  base?: LetterStylePatch;
  kinds?: Partial<Record<LineKind, LetterStylePatch>>;
  speakers?: Record<string, LetterStylePatch>; // characterId → overrides
  /** Auto-placement safe margin (fraction of page width). Default 0.03. Manual drags only keep the OUTLINE ≥ 0.008 inside. */
  safeMargin?: number;
}
export interface LetteringPreset {
  id: LetteringPresetId;
  name: string;
  blurb: string;
  base: LetterStyle; // complete
  kinds: Partial<Record<LineKind, LetterStylePatch>>;
  promptHint: string; // in_art lettering hint (prompts.ts); never hashed
}
/** Op patch for `letter_style`: null clears a key; presetId switch clears base/kinds unless keepOverrides. */
export interface LetteringStyleOpPatch {
  presetId?: LetteringPresetId;
  keepOverrides?: boolean;
  auto?: boolean | null;
  base?: LetterStylePatch | null;
  kinds?: Partial<Record<LineKind, LetterStylePatch | null>>;
  speakers?: Record<string, LetterStylePatch | null>;
  safeMargin?: number | null;
}

/** Kind base sizes (unchanged from balloonGeometry.ts KIND_FONT_SCALE). */
export const KIND_FONT_SCALE: Record<LineKind, number> = { speech: 1, thought: 1, whisper: 0.94, shout: 1.08, caption: 0.95, sfx: 2.4 };
/** Base geometry (unchanged LETTERING constants; page-width fractions). */
export const LETTER_METRICS = { fontScale: 0.017, lineHeight: 1.3, padX: 0.015, padY: 0.013, charW: 0.0105, lineH: 0.022, strokeScale: 0.0028 } as const;
export const DEFAULT_SAFE_MARGIN = 0.03;
export const MAX_SAFE_MARGIN = 0.1;

// ── Presets ──────────────────────────────────────────────────────────────────

const INK = '#111111';

/** Today's lettering, exactly (regression-locked). */
const CLASSIC_BASE: LetterStyle = {
  font: 'comic-neue',
  sizeScale: 1,
  weight: 700,
  italic: false,
  textCase: 'upper',
  letterSpacing: 0,
  lineHeight: 1.3,
  align: 'center',
  textColor: INK,
  textStroke: null,
  shadow: null,
  fill: '#ffffff',
  border: INK,
  borderWidth: 1,
  borderStyle: 'solid',
  shape: 'squircle',
  tail: 'curved',
  tailWidth: 1,
  padding: 1,
  rotate: 0,
  sfxEffect: 'filled_stroke',
  arc: 0
};

const SFX_NO_BUBBLE: LetterStylePatch = { shape: 'none', tail: 'none' };

export const LETTERING_PRESETS: Record<LetteringPresetId, LetteringPreset> = {
  classic: {
    id: 'classic',
    name: 'Classic comic',
    blurb: 'Bold uppercase comic lettering in crisp white balloons — the timeless look.',
    base: CLASSIC_BASE,
    kinds: {
      thought: { shape: 'cloud', tail: 'bubbles' },
      shout: { shape: 'burst', tail: 'straight' },
      whisper: { italic: true, borderStyle: 'dashed' },
      caption: { shape: 'rect', fill: '#fff6c8', tail: 'none' },
      sfx: {
        font: 'bangers',
        weight: 400,
        sfxEffect: 'filled_stroke',
        textColor: 'auto',
        textStroke: { color: INK, width: 0.12 },
        shadow: { color: INK, dx: 0.05, dy: 0.05 },
        rotate: 'auto',
        ...SFX_NO_BUBBLE
      }
    },
    promptHint: 'Use a clean comic lettering font in UPPERCASE, black text in white balloons with thin black outlines.'
  },
  manga: {
    id: 'manga',
    name: 'Manga',
    blurb: 'Soft oval balloons, short pointer tails and punchy outlined sound effects.',
    base: { ...CLASSIC_BASE, font: 'shantell-sans', weight: 600, shape: 'oval', padding: 1.3, tail: 'pointer', tailWidth: 0.7 },
    kinds: {
      thought: { shape: 'cloud', tail: 'bubbles', borderWidth: 0.8 },
      shout: { shape: 'explosion', weight: 800, tail: 'straight' },
      whisper: { shape: 'oval', borderStyle: 'dashed' },
      caption: { shape: 'rect', fill: '#ffffff', borderWidth: 0.8, tail: 'none' },
      sfx: {
        font: 'dela-gothic-one',
        weight: 400,
        sfxEffect: 'outlined',
        textColor: '#ffffff',
        textStroke: { color: INK, width: 0.14 },
        shadow: null,
        rotate: -8,
        ...SFX_NO_BUBBLE
      }
    },
    promptHint: 'Letter it like printed manga: soft oval balloons with short pointed tails, clean sans-serif text, bold outlined sound effects.'
  },
  storybook: {
    id: 'storybook',
    name: 'Kids storybook',
    blurb: 'Friendly mixed-case text for early readers in warm, rounded balloons.',
    base: {
      ...CLASSIC_BASE,
      font: 'andika',
      textCase: 'as_typed',
      sizeScale: 1.15,
      lineHeight: 1.35,
      textColor: '#2b2b2b',
      fill: '#fffdf7',
      border: '#6b4f3a',
      borderWidth: 0.8,
      shape: 'rounded_rect',
      tail: 'curved'
    },
    kinds: {
      thought: { shape: 'cloud', tail: 'bubbles', fill: '#fffdf7' },
      shout: { shape: 'burst', fill: '#fff3c4', tail: 'straight' },
      whisper: { italic: true, borderStyle: 'dashed' },
      caption: { shape: 'scroll', fill: '#fbf1d9', border: '#c9a66b', weight: 400, italic: true, tail: 'none' },
      sfx: {
        font: 'luckiest-guy',
        weight: 400,
        sizeScale: 1,
        sfxEffect: 'pop',
        textColor: 'auto',
        textStroke: { color: '#ffffff', width: 0.1 },
        shadow: { color: '#6b4f3a', dx: 0.05, dy: 0.05 },
        rotate: 'auto',
        ...SFX_NO_BUBBLE
      }
    },
    promptHint: 'Letter it like a picture book: friendly rounded mixed-case text in soft cream balloons, gentle playful sound effects.'
  },
  noir: {
    id: 'noir',
    name: 'Noir',
    blurb: 'Heavy outlines, dark typewriter captions and hard-edged sound effects.',
    base: { ...CLASSIC_BASE, borderWidth: 1.3 },
    kinds: {
      thought: { shape: 'cloud', tail: 'bubbles' },
      shout: { shape: 'jagged', tail: 'straight' },
      whisper: { borderStyle: 'dashed' },
      caption: { shape: 'rect', fill: '#111111e0', textColor: '#f2efe6', font: 'special-elite', weight: 400, textCase: 'as_typed', tail: 'none' },
      sfx: {
        font: 'ultra',
        weight: 400,
        sfxEffect: 'outlined',
        textColor: '#ffffff',
        textStroke: { color: INK, width: 0.12 },
        shadow: null,
        rotate: 'auto',
        ...SFX_NO_BUBBLE
      }
    },
    promptHint: 'Letter it like a noir comic: uppercase hand lettering, heavy balloon outlines, dark narration boxes with typewriter text.'
  },
  webtoon: {
    id: 'webtoon',
    name: 'Webtoon',
    blurb: 'Large, airy mixed-case text sized for phones.',
    base: {
      ...CLASSIC_BASE,
      font: 'shantell-sans',
      weight: 500,
      textCase: 'as_typed',
      sizeScale: 1.2,
      shape: 'oval',
      border: '#333333',
      borderWidth: 0.6,
      tail: 'straight',
      tailWidth: 0.6
    },
    kinds: {
      thought: { shape: 'cloud', tail: 'bubbles' },
      shout: { shape: 'burst', tail: 'straight' },
      whisper: { borderStyle: 'dashed' },
      caption: { shape: 'rounded_rect', fill: '#1f1f1fcc', textColor: '#ffffff', borderWidth: 0, tail: 'none' },
      sfx: {
        font: 'bangers',
        weight: 400,
        sizeScale: 1,
        sfxEffect: 'shadow',
        textColor: 'auto',
        textStroke: { color: INK, width: 0.1 },
        shadow: { color: INK, dx: 0.06, dy: 0.06 },
        rotate: 'auto',
        ...SFX_NO_BUBBLE
      }
    },
    promptHint: 'Letter it like a mobile webtoon: large mixed-case text in airy oval balloons with thin outlines.'
  },
  retro_pulp: {
    id: 'retro_pulp',
    name: 'Retro pulp',
    blurb: 'Golden-age yellow captions, cream balloons and big blocky sound effects.',
    base: { ...CLASSIC_BASE, fill: '#fffbe8', borderWidth: 1.2 },
    kinds: {
      thought: { shape: 'cloud', tail: 'bubbles' },
      shout: { shape: 'burst', tail: 'straight', font: 'ultra', weight: 400 },
      whisper: { italic: true, borderStyle: 'dashed' },
      caption: { shape: 'notched', fill: '#ffd84a', tail: 'none' },
      sfx: {
        font: 'ultra',
        weight: 400,
        sfxEffect: 'filled_stroke',
        textColor: 'auto',
        textStroke: { color: INK, width: 0.12 },
        shadow: { color: INK, dx: 0.06, dy: 0.06 },
        rotate: 'auto',
        ...SFX_NO_BUBBLE
      }
    },
    promptHint: 'Letter it like a golden-age pulp comic: uppercase lettering in cream balloons, yellow caption boxes, blocky sound effects.'
  },
  minimal: {
    id: 'minimal',
    name: 'Minimal',
    blurb: 'Plain, highly legible text with no heavy outlines — best for readability.',
    base: {
      ...CLASSIC_BASE,
      font: 'atkinson',
      weight: 400,
      textCase: 'as_typed',
      shape: 'rounded_rect',
      borderWidth: 0,
      fill: '#ffffffef',
      tail: 'straight',
      tailWidth: 0.5
    },
    kinds: {
      thought: { shape: 'oval', borderStyle: 'dotted', borderWidth: 1, tail: 'bubbles' },
      shout: { shape: 'rounded_rect', weight: 700 },
      whisper: { italic: true },
      caption: { shape: 'none', fill: 'none', textStroke: { color: '#ffffff', width: 0.18 }, tail: 'none' },
      sfx: {
        font: 'atkinson',
        weight: 700,
        sfxEffect: 'outlined',
        textColor: '#ffffff',
        textStroke: { color: INK, width: 0.12 },
        shadow: null,
        rotate: 0,
        ...SFX_NO_BUBBLE
      }
    },
    promptHint: 'Letter it minimally: plain, highly legible sans-serif text in borderless rounded boxes.'
  },
  handwritten: {
    id: 'handwritten',
    name: 'Indie handwritten',
    blurb: 'Hand-drawn wobbly balloons and marker lettering with an indie feel.',
    base: { ...CLASSIC_BASE, font: 'patrick-hand', weight: 400, sizeScale: 1.1, textCase: 'as_typed', shape: 'wavy', borderWidth: 0.9 },
    kinds: {
      thought: { shape: 'cloud', tail: 'bubbles' },
      shout: { shape: 'jagged', font: 'permanent-marker', weight: 400, tail: 'straight' },
      whisper: { borderStyle: 'dashed' },
      caption: { shape: 'none', font: 'kalam', weight: 400, tail: 'none' },
      sfx: {
        font: 'permanent-marker',
        weight: 400,
        sizeScale: 1,
        sfxEffect: 'skewed',
        textColor: 'auto',
        textStroke: { color: INK, width: 0.1 },
        shadow: null,
        rotate: 'auto',
        ...SFX_NO_BUBBLE
      }
    },
    promptHint: 'Letter it by hand like an indie comic: casual handwritten text in slightly wobbly balloons, marker sound effects.'
  }
};

export const DEFAULT_LETTERING: LetteringStyle = { presetId: 'classic' };

// ── Colours ──────────────────────────────────────────────────────────────────

/** Named colours a director/user may type (hoisted from prompts.ts NAMED_COLORS, + CSS basics). */
export const NAMED_COLORS: ReadonlyArray<[string, number, number, number]> = [
  ['black', 12, 12, 12], ['charcoal', 54, 69, 79], ['slate grey', 112, 128, 144], ['grey', 150, 150, 150],
  ['silver', 200, 200, 200], ['white', 255, 255, 255], ['off-white', 245, 241, 230], ['cream', 255, 241, 214],
  ['beige', 232, 216, 176], ['tan', 210, 180, 140], ['brown', 139, 90, 43], ['dark brown', 80, 50, 30],
  ['rust', 183, 65, 14], ['crimson', 193, 18, 31], ['red', 230, 57, 70], ['coral', 255, 127, 80],
  ['salmon', 250, 128, 114], ['pink', 255, 143, 171], ['hot pink', 255, 72, 176], ['magenta', 194, 24, 91],
  ['burnt orange', 231, 111, 81], ['orange', 247, 127, 0], ['amber', 255, 183, 3], ['golden yellow', 252, 191, 73],
  ['mustard', 233, 196, 106], ['yellow', 255, 214, 10], ['olive', 128, 128, 0], ['lime green', 138, 201, 38],
  ['leaf green', 144, 190, 109], ['green', 46, 139, 87], ['sage', 129, 178, 154], ['dark green', 20, 70, 40],
  ['teal', 0, 131, 138], ['sea green', 42, 157, 143], ['turquoise', 64, 224, 208], ['sky blue', 162, 210, 255],
  ['blue', 42, 111, 219], ['steel blue', 87, 117, 144], ['navy', 29, 53, 87], ['deep navy', 0, 48, 73],
  ['indigo', 63, 55, 201], ['purple', 106, 76, 147], ['lavender', 205, 180, 219], ['deep purple', 27, 27, 47],
  ['gold', 255, 196, 0], ['violet', 143, 0, 255]
];
const NAMED_HEX: ReadonlyMap<string, string> = new Map(
  NAMED_COLORS.map(([name, r, g, b]) => [name.replace(/[\s-]+/g, ''), toHex(r, g, b)])
);
function toHex(r: number, g: number, b: number, a?: number): string {
  const h = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}${a !== undefined && a < 255 ? h(a) : ''}`;
}

/** 'red', 'navy', '#f00', 'rgb(…)', '#ff000080' → '#rrggbb[aa]'; 'none' / 'auto' / 'transparent' pass through. */
export function normalizeColor(raw: unknown): Color | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  if (!v || v.length > 40) return undefined;
  if (v === 'none' || v === 'transparent') return 'none';
  if (v === 'auto') return 'auto';
  const hex = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (hex) {
    let body = hex[1];
    if (body.length <= 4) body = body.split('').map((c) => c + c).join('');
    const r = parseInt(body.slice(0, 2), 16);
    const g = parseInt(body.slice(2, 4), 16);
    const b = parseInt(body.slice(4, 6), 16);
    const a = body.length === 8 ? parseInt(body.slice(6, 8), 16) : undefined;
    return toHex(r, g, b, a);
  }
  const rgb = /^rgba?\(\s*(\d{1,3}(?:\.\d+)?)\s*[,\s]\s*(\d{1,3}(?:\.\d+)?)\s*[,\s]\s*(\d{1,3}(?:\.\d+)?)\s*(?:[,/]\s*(\d*(?:\.\d+)?%?)\s*)?\)$/.exec(v);
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number);
    if ([r, g, b].some((n) => n > 255)) return undefined;
    let a: number | undefined;
    if (rgb[4]) {
      const alpha = rgb[4].endsWith('%') ? Number(rgb[4].slice(0, -1)) / 100 : Number(rgb[4]);
      if (!Number.isFinite(alpha)) return undefined;
      a = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
    }
    return toHex(r, g, b, a);
  }
  const named = NAMED_HEX.get(v.replace(/gray/g, 'grey').replace(/[\s-]+/g, ''));
  return named;
}

// ── Merge / sanitize ─────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v * 1000) / 1000)) : undefined;
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined;

const snapWeight = (v: unknown): LetterStyle['weight'] | undefined => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return FONT_WEIGHTS.reduce((best, w) => (Math.abs(w - v) < Math.abs(best - v) ? w : best), FONT_WEIGHTS[0]);
};

const sanitizeStroke = (v: unknown): TextStroke | null | undefined => {
  if (v === null) return null;
  if (!isObj(v)) return undefined;
  const color = normalizeColor(v.color);
  const width = num(v.width, 0, 0.3);
  return color && width !== undefined ? { color, width } : undefined;
};
const sanitizeShadow = (v: unknown): DropShadow | null | undefined => {
  if (v === null) return null;
  if (!isObj(v)) return undefined;
  const color = normalizeColor(v.color);
  const dx = num(v.dx, -0.3, 0.3);
  const dy = num(v.dy, -0.3, 0.3);
  return color && dx !== undefined && dy !== undefined ? { color, dx, dy } : undefined;
};

/** Key order of a sanitized patch (stable output → idempotent JSON). */
const STYLE_KEYS: readonly (keyof LetterStyle)[] = [
  'font', 'sizeScale', 'weight', 'italic', 'textCase', 'letterSpacing', 'lineHeight', 'align', 'textColor',
  'textStroke', 'shadow', 'fill', 'border', 'borderWidth', 'borderStyle', 'shape', 'tail', 'tailWidth',
  'padding', 'rotate', 'sfxEffect', 'arc'
];

const sanitizeKey = (key: keyof LetterStyle, v: unknown): unknown => {
  switch (key) {
    case 'font': return oneOf(v, FONT_IDS);
    case 'sizeScale': return num(v, 0.5, 3.5);
    case 'weight': return snapWeight(v);
    case 'italic': return typeof v === 'boolean' ? v : undefined;
    case 'textCase': return oneOf(v, TEXT_CASES);
    case 'letterSpacing': return num(v, -0.05, 0.3);
    case 'lineHeight': return num(v, 0.9, 1.8);
    case 'align': return oneOf(v, ['center', 'left', 'right'] as const);
    case 'textColor':
    case 'fill':
    case 'border': return normalizeColor(v);
    case 'textStroke': return sanitizeStroke(v);
    case 'shadow': return sanitizeShadow(v);
    case 'borderWidth': return num(v, 0, 4);
    case 'borderStyle': return oneOf(v, BORDER_STYLES);
    case 'shape': return oneOf(v, BUBBLE_SHAPES);
    case 'tail': return oneOf(v, TAIL_STYLES);
    case 'tailWidth': return num(v, 0.4, 2);
    case 'padding': return num(v, 0, 3);
    case 'rotate': return v === 'auto' ? 'auto' : num(v, -30, 30);
    case 'sfxEffect': return oneOf(v, SFX_EFFECTS);
    case 'arc': return num(v, -1, 1);
    default: return undefined;
  }
};

/** Clamp ranges, validate enums/font ids/colours (normalizeColor); drop unknown keys; undefined if nothing valid. */
export function sanitizeLetterStylePatch(raw: unknown): LetterStylePatch | undefined {
  if (!isObj(raw)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of STYLE_KEYS) {
    if (!(key in raw)) continue;
    const value = sanitizeKey(key, raw[key]);
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length ? (out as LetterStylePatch) : undefined;
}

/** Shallow per key; textStroke/shadow replaced wholesale; null deletes a key; returns undefined when empty. */
export function mergeStylePatch(a: LetterStylePatch | undefined, b: LetterStylePatch | null | undefined): LetterStylePatch | undefined {
  if (b === null) return undefined;
  const out: Record<string, unknown> = { ...(a || {}) };
  if (b) {
    for (const [k, v] of Object.entries(b)) {
      if (v === null || v === undefined) delete out[k];
      else out[k] = v;
    }
  }
  return Object.keys(out).length ? (out as LetterStylePatch) : undefined;
}

const sanitizeKinds = (raw: unknown): Partial<Record<LineKind, LetterStylePatch>> | undefined => {
  if (!isObj(raw)) return undefined;
  const out: Partial<Record<LineKind, LetterStylePatch>> = {};
  for (const k of LINE_KINDS) {
    const p = sanitizeLetterStylePatch(raw[k]);
    if (p) out[k] = p;
  }
  return Object.keys(out).length ? out : undefined;
};
const sanitizeSpeakers = (raw: unknown, allow?: ReadonlySet<string>): Record<string, LetterStylePatch> | undefined => {
  if (!isObj(raw)) return undefined;
  const out: Record<string, LetterStylePatch> = {};
  for (const [id, v] of Object.entries(raw)) {
    if (!id || id.length > 64 || (allow && !allow.has(id))) continue;
    const p = sanitizeLetterStylePatch(v);
    if (p) out[id] = p;
  }
  return Object.keys(out).length ? out : undefined;
};

/** Missing/invalid → DEFAULT_LETTERING (no auto). */
export function sanitizeLetteringStyle(raw: unknown): LetteringStyle {
  if (!isObj(raw)) return { ...DEFAULT_LETTERING };
  const presetId = oneOf(raw.presetId, LETTERING_PRESET_IDS);
  if (!presetId) return { ...DEFAULT_LETTERING };
  const out: LetteringStyle = { presetId };
  if (typeof raw.auto === 'boolean') out.auto = raw.auto;
  const base = sanitizeLetterStylePatch(raw.base);
  if (base) out.base = base;
  const kinds = sanitizeKinds(raw.kinds);
  if (kinds) out.kinds = kinds;
  const speakers = sanitizeSpeakers(raw.speakers);
  if (speakers) out.speakers = speakers;
  const margin = num(raw.safeMargin, 0, MAX_SAFE_MARGIN);
  if (margin !== undefined) out.safeMargin = margin;
  return out;
}

const STYLE_PATCH_MAX_BYTES = 2048;
const tooBig = (v: unknown) => v !== null && v !== undefined && JSON.stringify(v).length > STYLE_PATCH_MAX_BYTES;

/** Server/director validation of a `letter_style` op patch. null = reject (invalid or empty). */
export function sanitizeLetteringStyleOpPatch(raw: unknown, castIds: ReadonlySet<string>): LetteringStyleOpPatch | null {
  if (!isObj(raw)) return null;
  const out: LetteringStyleOpPatch = {};
  if (raw.presetId !== undefined) {
    const presetId = oneOf(raw.presetId, LETTERING_PRESET_IDS);
    if (!presetId) return null;
    out.presetId = presetId;
  }
  if (typeof raw.keepOverrides === 'boolean') out.keepOverrides = raw.keepOverrides;
  if (raw.auto === null || typeof raw.auto === 'boolean') out.auto = raw.auto as boolean | null;
  if (raw.base !== undefined) {
    if (tooBig(raw.base)) return null;
    if (raw.base === null) out.base = null;
    else {
      const base = sanitizeLetterStylePatch(raw.base);
      if (base) out.base = base;
    }
  }
  if (raw.kinds !== undefined) {
    if (!isObj(raw.kinds)) return null;
    const kinds: Partial<Record<LineKind, LetterStylePatch | null>> = {};
    for (const k of LINE_KINDS) {
      const v = raw.kinds[k];
      if (v === undefined) continue;
      if (tooBig(v)) return null;
      if (v === null) kinds[k] = null;
      else {
        const p = sanitizeLetterStylePatch(v);
        if (p) kinds[k] = p;
      }
    }
    if (Object.keys(kinds).length) out.kinds = kinds;
  }
  if (raw.speakers !== undefined) {
    if (!isObj(raw.speakers)) return null;
    const speakers: Record<string, LetterStylePatch | null> = {};
    for (const [id, v] of Object.entries(raw.speakers)) {
      if (!castIds.has(id)) return null;
      if (tooBig(v)) return null;
      if (v === null) speakers[id] = null;
      else {
        const p = sanitizeLetterStylePatch(v);
        if (p) speakers[id] = p;
      }
    }
    if (Object.keys(speakers).length) out.speakers = speakers;
  }
  if (raw.safeMargin === null) out.safeMargin = null;
  else if (raw.safeMargin !== undefined) {
    const m = num(raw.safeMargin, 0, MAX_SAFE_MARGIN);
    if (m === undefined) return null;
    out.safeMargin = m;
  }
  return Object.keys(out).length ? out : null;
}

// ── Resolution ───────────────────────────────────────────────────────────────

const applyPatch = (style: LetterStyle, patch: LetterStylePatch | null | undefined): LetterStyle => {
  if (!patch) return style;
  const out = { ...style } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && k in style) out[k] = v;
  }
  return out as unknown as LetterStyle;
};

/** preset.base → preset.kinds[k] → doc.base → doc.kinds[k] → doc.speakers[speakerId] → line.style. */
export function resolveLetterStyle(doc: Pick<ComicDoc, 'letterStyle' | 'format'>, line: Line): LetterStyle {
  const ls = doc.letterStyle ?? DEFAULT_LETTERING;
  const preset = LETTERING_PRESETS[ls.presetId] ?? LETTERING_PRESETS.classic;
  let style = applyPatch(preset.base, preset.kinds[line.kind]);
  style = applyPatch(style, ls.base);
  style = applyPatch(style, ls.kinds?.[line.kind]);
  if (line.speakerId) style = applyPatch(style, ls.speakers?.[line.speakerId]);
  style = applyPatch(style, line.style);
  return style;
}

const KIDS_RE = /\b(kids?|child|children|toddlers?|preschool(?:ers)?|young readers|little ones|early readers)\b|बच्च|పిల్లల/i;

/** storybook kind or kids audience → storybook; manga → manga; webtoon → webtoon; noir/detective genre → noir; else classic. */
export function presetForComic(format: Format, brief: Brief): LetteringPresetId {
  if (format.kind === 'storybook' || KIDS_RE.test(brief.audience || '')) return 'storybook';
  if (format.kind === 'manga') return 'manga';
  if (format.kind === 'webtoon') return 'webtoon';
  if (/\b(noir|detective|hard-?boiled)\b/i.test(`${brief.genre || ''} ${brief.tone || ''}`)) return 'noir';
  return 'classic';
}
