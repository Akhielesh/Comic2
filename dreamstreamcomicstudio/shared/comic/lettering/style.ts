// Lettering style — ONE `LetteringStyle` for fonts, colours, opacity, bubble shapes and tails.
//
// Contract §10.1 (wave 0, exact). Dependency-free; imports only TYPES from doc.ts (cycle rule §2).
// Resolution order for one line (PE-LETTER adds the named style, agent-editor plan §3 C7):
//   preset.base → preset.kinds[kind] → doc.base → doc.kinds[kind] → doc.named[line.styleId] → doc.speakers[speakerId]
//   → line.style
// `classic` is regression-locked to the pre-v5 constants (balloonGeometry.ts LETTERING / KIND_FONT_SCALE),
// so every existing doc (normalized to `{ presetId: 'classic' }`) letters exactly as before.

import type { Brief, ComicDoc, Format, Line, LineKind } from '../doc.js';
import { PRO_LETTER_LIMITS } from '../limits.js'; // dependency-free constants (no cycle)
import { isProFontId, PRO_FONT_IDS } from './proFonts.js'; // proFonts.ts imports only a TYPE from this file (no cycle)

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

// ── Pro Edit lettering ids and text styling (master plan §2.3, §2.4; PE-0 contract, drawn by PE-LETTER) ─────────────
//
// PE-LETTER (S2) draws them: resolveLetterStyle now applies the Pro text keys, the six Pro shapes, the five S2 SFX
// effects and the Pro fonts (DRAWN_*), and the layout, svgMarkup and canvas exporter draw them. A CLIENT may still not
// write any of them until the lead flips PRO_EDIT_OPS_PATCHABLE (S2b lead decision, collisions B-3 / C-9): the client
// sanitizers accept a Pro key or id only with the explicit `{allowPro: true}` option, which the server passes as
// PRO_EDIT_OPS_PATCHABLE (style.ts cannot import ops.ts: ops → doc → style). Without it they behave exactly as before.
//
// They stay separate types (collisions B-4, no fold in S2): BubbleShape and SfxEffect key exhaustive records in files
// other packages own (place.ts SHAPE_BLEED, ShapePicker, ProLetteringPanel). A resolved LetterStyle may therefore carry a
// Pro shape or effect at runtime under the narrow type; AnyBubbleShape / AnySfxEffect name what is really there.
//
// Rollback rule (the opaque-layer rule, master plan §2.3 graft 1 and §6.4): the LOAD normalizer (normalizeDoc, through
// `{keepStoredPro: true}`) keeps what a newer build stored, structurally checked, and resolveLetterStyle treats a stored
// Pro id it cannot draw as absent (halftone_fill until S3, a font PE-FONTS has not shipped, a look a newer build added).

export type ProBubbleShape = 'radio' | 'monster' | 'telepathic' | 'icicle' | 'heart' | 'sticky';
export const PRO_BUBBLE_SHAPES: readonly ProBubbleShape[] = ['radio', 'monster', 'telepathic', 'icicle', 'heart', 'sticky'];
/** extrude3d, outline_stack, wobble, shatter and gradient draw in S2; halftone_fill needs canvas patterns (S3). */
export type ProSfxEffect = 'extrude3d' | 'outline_stack' | 'wobble' | 'shatter' | 'gradient' | 'halftone_fill';
export const PRO_SFX_EFFECTS: readonly ProSfxEffect[] = ['extrude3d', 'outline_stack', 'wobble', 'shatter', 'gradient', 'halftone_fill'];
/** The Pro SFX effects this build draws (S2): every PRO_SFX_EFFECTS id but halftone_fill (PE-TONES, S3). */
export const DRAWN_PRO_SFX_EFFECTS: readonly ProSfxEffect[] = ['extrude3d', 'outline_stack', 'wobble', 'shatter', 'gradient'];
/** Any bubble shape or SFX effect a resolved style may carry at runtime (the base unions stay narrow until the fold). */
export type AnyBubbleShape = BubbleShape | ProBubbleShape;
export type AnySfxEffect = SfxEffect | ProSfxEffect;
/** Text warp (per glyph): offered for Latin, Cyrillic and CJK editions only (§2.4). */
export type WarpStyle = 'none' | 'arc' | 'bulge' | 'wave' | 'rise' | 'flag';
export const WARP_STYLES: readonly WarpStyle[] = ['none', 'arc', 'bulge', 'wave', 'rise', 'flag'];
/** The honest note where warp cannot be offered (master plan §2.4): the layout draws such an edition unwarped. */
export const WARP_SCRIPT_NOTE = "Warp isn't available for this script yet";

/** A two-stop text fill; `angle` in degrees (0 = left to right). */
export interface FillGradient { from: Color; to: Color; angle: number }
/** One of up to PRO_LETTER_LIMITS.strokes stacked outlines (supersedes `textStroke` when present); `w` in em. */
export interface StrokeLayer { color: Color; w: number }
/** A soft glow drawn as stacked strokes (never a filter, so SVG and canvas match); `size` in em. */
export interface Glow { color: Color; size: number }

/** The Pro text-styling fields of a LetterStyle, all present (PRO_LETTER_DEFAULTS fills the absent ones). */
export interface ProLetterStyle {
  fillGradient: FillGradient | null;
  strokes: StrokeLayer[];
  glow: Glow | null;
  warp: WarpStyle;
  /** −PRO_LETTER_LIMITS.warpAmountMax..warpAmountMax. */
  warpAmount: number;
}
/** Neutral: a style without them draws exactly as today, so resolveLetterStyle stays byte-identical for old docs. */
export const PRO_LETTER_DEFAULTS: Readonly<ProLetterStyle> = Object.freeze({ fillGradient: null, strokes: [], glow: null, warp: 'none', warpAmount: 0 });
/** The Pro keys, in stored order (lineStyleBytes 2048 still caps the whole Line.style). */
export const PRO_STYLE_KEYS: readonly (keyof ProLetterStyle)[] = ['fillGradient', 'strokes', 'glow', 'warp', 'warpAmount'];

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
  // --- Pro Edit text styling (master plan §2.3; PE-0, drawn by PE-LETTER). Optional and absent from every base look, so
  //     the resolved style of an existing line is unchanged; read them through proLetterOf. A client writes them only
  //     with `{allowPro: true}`; kept on load (keepStoredPro); resolveLetterStyle applies them from any cascade layer. ---
  fillGradient?: FillGradient | null;
  strokes?: StrokeLayer[];
  glow?: Glow | null;
  warp?: WarpStyle;
  warpAmount?: number;
}
export type LetterStylePatch = Partial<LetterStyle>;

/** A style's Pro text styling with the neutral defaults filled in (a fresh object; never the frozen defaults). */
export const proLetterOf = (style: Partial<ProLetterStyle> | null | undefined): ProLetterStyle => ({
  fillGradient: style?.fillGradient ?? PRO_LETTER_DEFAULTS.fillGradient,
  strokes: Array.isArray(style?.strokes) ? style!.strokes.slice() : [],
  glow: style?.glow ?? PRO_LETTER_DEFAULTS.glow,
  warp: style?.warp ?? PRO_LETTER_DEFAULTS.warp,
  warpAmount: typeof style?.warpAmount === 'number' && Number.isFinite(style.warpAmount) ? style.warpAmount : PRO_LETTER_DEFAULTS.warpAmount
});

export type LetteringPresetId = 'classic' | 'manga' | 'storybook' | 'noir' | 'webtoon' | 'retro_pulp' | 'minimal' | 'handwritten';
export const LETTERING_PRESET_IDS: readonly LetteringPresetId[] = [
  'classic', 'manga', 'storybook', 'noir', 'webtoon', 'retro_pulp', 'minimal', 'handwritten'
];

/**
 * The 16 Pro looks (master plan §2.4: 8 → 24). A separate list on purpose (collisions B-5, C-8): the exhaustive records
 * keyed by LetteringPresetId (server replies.ts PRESET_ALIASES, the director's set_lettering enum) stay valid, a client
 * picks one only with `{allowPro: true}`, and an older build keeps a stored one on load (sanitizeLetteringStyle with
 * keepStoredPro) and draws it as classic instead of wiping the doc's lettering.
 */
export type ProLetteringPresetId =
  | 'shonen' | 'horror' | 'romance' | 'kids' | 'sci_fi' | 'western' | 'villain' | 'robot'
  | 'narrator_box' | 'newspaper' | 'retro_caption' | 'flashback' | 'superhero' | 'fantasy' | 'comedy' | 'zine';
export const PRO_LETTERING_PRESET_IDS: readonly ProLetteringPresetId[] = [
  'shonen', 'horror', 'romance', 'kids', 'sci_fi', 'western', 'villain', 'robot',
  'narrator_box', 'newspaper', 'retro_caption', 'flashback', 'superhero', 'fantasy', 'comedy', 'zine'
];
export type AnyLetteringPresetId = LetteringPresetId | ProLetteringPresetId;

export interface LetteringStyle {
  /** A base look. At runtime it may also hold a ProLetteringPresetId (allowPro writes) or, after a rollback, a look a
   *  newer build stored (kept on load, drawn as classic): read the look through letteringPresetOf, never index
   *  LETTERING_PRESETS with it directly. */
  presetId: LetteringPresetId;
  /** true = the director may switch preset when kind/audience changes (never after a manual pick). */
  auto?: boolean;
  base?: LetterStylePatch;
  kinds?: Partial<Record<LineKind, LetterStylePatch>>;
  speakers?: Record<string, LetterStylePatch>; // characterId → overrides
  /** Auto-placement safe margin (fraction of page width). Default 0.03. Manual drags only keep the OUTLINE ≥ 0.008 inside. */
  safeMargin?: number;
  /** Saved, named looks ("Villain", "Radio"), keyed by style id; lines use one through `Line.styleId` (agent-editor plan
   *  §3 C7, owner decision D6: LINKED — editing a style restyles every line using it). Optional; never part of a spec hash,
   *  but part of the publication fingerprint (through doc.letterStyle), so a style edit shows as a change since publishing.
   *  The cascade applies it between doc.kinds and doc.speakers (PE-LETTER); a client writes it only through
   *  `letter_style {named}` with `{allowPro: true}`. The load normalizer keeps it (≤ PRO_LETTER_LIMITS.namedStyles,
   *  names ≤ namedNameChars), and so do the `letter_style` op, its inverse and a reset (PE-LETTER keeps that reset
   *  semantics: lines link to their styles), so a rollback never loses a creator's saved styles. Deleting one folds its
   *  patch back into the lines that use it (foldNamedStyle), so nothing changes on the page. */
  named?: Record<string, NamedLetterStyle>;
}
/** One saved lettering look (agent-editor plan §3 C7): the name the creator gave it and the overrides it applies. */
export interface NamedLetterStyle {
  name: string;
  patch: LetterStylePatch;
}
export interface LetteringPreset {
  /** A base look's id; a Pro look (PRO_LETTERING_PRESETS) carries a ProLetteringPresetId here. */
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
  /** Saved named styles by id: an entry upserts that style, null deletes it (deleting folds it back first: foldNamedStyle).
   *  Accepted only with `{allowPro: true}`; applied by ops.ts through mergeNamedStyles. */
  named?: Record<string, NamedLetterStyle | null>;
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

// ── Pro looks (PE-LETTER; master plan §2.4) ──────────────────────────────────
//
// Built from the classic base like the 8 base looks, so every one is a complete LetterStyle drawn with shipped faces.
// They may use the Pro shapes, SFX effects and text styling (the base unions stay narrow until the fold, so those ids
// are cast at their one use here). The four of PE-LETTER's choosing (AMENDMENTS): superhero, fantasy, comedy, zine.

/** A Pro look: a LetteringPreset whose id is a ProLetteringPresetId. */
export interface ProLetteringPreset extends Omit<LetteringPreset, 'id'> {
  id: ProLetteringPresetId;
}
const proShape = (shape: ProBubbleShape): BubbleShape => shape as unknown as BubbleShape;
const proSfx = (effect: ProSfxEffect): SfxEffect => effect as unknown as SfxEffect;

export const PRO_LETTERING_PRESETS: Record<ProLetteringPresetId, ProLetteringPreset> = {
  shonen: {
    id: 'shonen',
    name: 'Shonen action',
    blurb: 'Punchy oval balloons, exploding shouts and stacked-outline sound effects for fights.',
    base: { ...CLASSIC_BASE, font: 'shantell-sans', weight: 700, shape: 'oval', padding: 1.2, tail: 'pointer', tailWidth: 0.8 },
    kinds: {
      thought: { shape: 'cloud', tail: 'bubbles' },
      shout: { shape: 'explosion', weight: 800, tail: 'straight', sizeScale: 1.1 },
      whisper: { borderStyle: 'dashed' },
      caption: { shape: 'rect', fill: '#ffffff', borderWidth: 1.2, tail: 'none' },
      sfx: { font: 'dela-gothic-one', weight: 400, sfxEffect: proSfx('outline_stack'), textColor: '#ffffff', textStroke: { color: INK, width: 0.12 }, shadow: null, rotate: -10, ...SFX_NO_BUBBLE }
    },
    promptHint: 'Letter it like an action manga: bold oval balloons, exploding shout balloons, big outlined sound effects.'
  },
  horror: {
    id: 'horror',
    name: 'Horror',
    blurb: 'Shaky hand lettering, dripping shout balloons and blood-red sound effects.',
    base: { ...CLASSIC_BASE, font: 'patrick-hand', weight: 400, textCase: 'as_typed', textColor: '#1a0f0f', fill: '#f4f1ea', border: '#3a0d0d', shape: 'wavy', borderWidth: 1.1 },
    kinds: {
      thought: { shape: 'cloud', tail: 'bubbles' },
      shout: { shape: proShape('monster'), fill: '#fff0f0', tail: 'straight', textCase: 'upper' },
      whisper: { borderStyle: 'dashed', textColor: '#4a3a3a' },
      caption: { shape: 'rect', fill: '#1a0f0fe6', textColor: '#e8d8c8', font: 'special-elite', border: '#000000', tail: 'none' },
      sfx: { font: 'permanent-marker', weight: 400, sfxEffect: proSfx('wobble'), textColor: '#8b0000', textStroke: { color: INK, width: 0.1 }, shadow: null, rotate: 'auto', ...SFX_NO_BUBBLE }
    },
    promptHint: 'Letter it like a horror comic: shaky hand lettering in pale balloons, dripping shout balloons, red scratchy sound effects.'
  },
  romance: {
    id: 'romance',
    name: 'Romance',
    blurb: 'Soft rose balloons, heart-shaped thoughts and glossy sound effects.',
    base: { ...CLASSIC_BASE, font: 'andika', textCase: 'as_typed', textColor: '#3b2430', fill: '#fffafc', border: '#c2185b', borderWidth: 0.8, shape: 'oval' },
    kinds: {
      thought: { shape: proShape('heart'), tail: 'bubbles', fill: '#fff0f5' },
      shout: { shape: 'burst', tail: 'straight', fill: '#fff0f5' },
      whisper: { italic: true, borderStyle: 'dashed' },
      caption: { shape: 'scroll', fill: '#fde7ef', border: '#c2185b', italic: true, tail: 'none' },
      sfx: { font: 'luckiest-guy', weight: 400, sizeScale: 1, sfxEffect: proSfx('gradient'), textColor: '#ff4f8b', textStroke: { color: '#ffffff', width: 0.1 }, shadow: null, rotate: 'auto', ...SFX_NO_BUBBLE }
    },
    promptHint: 'Letter it like a romance comic: soft mixed-case text in rose-edged oval balloons, heart-shaped thought balloons.'
  },
  kids: {
    id: 'kids',
    name: 'Kids bright',
    blurb: 'Big friendly text, sticky-note captions and chunky 3D sound effects.',
    base: { ...CLASSIC_BASE, font: 'andika', textCase: 'as_typed', sizeScale: 1.2, lineHeight: 1.35, fill: '#ffffff', border: '#2b6cb0', borderWidth: 1.2, shape: 'rounded_rect' },
    kinds: {
      thought: { shape: 'cloud', tail: 'bubbles' },
      shout: { shape: 'burst', fill: '#fff3c4', tail: 'straight' },
      whisper: { italic: true, borderStyle: 'dashed' },
      caption: { shape: proShape('sticky'), fill: '#fff59d', border: '#b7950b', tail: 'none' },
      sfx: { font: 'luckiest-guy', weight: 400, sizeScale: 1, sfxEffect: proSfx('extrude3d'), textColor: 'auto', textStroke: { color: '#ffffff', width: 0.08 }, shadow: { color: '#2b6cb0', dx: 0.06, dy: 0.06 }, rotate: 'auto', ...SFX_NO_BUBBLE }
    },
    promptHint: 'Letter it for young readers: big friendly mixed-case text in bright rounded balloons, sticky-note captions.'
  },
  sci_fi: {
    id: 'sci_fi',
    name: 'Sci-fi',
    blurb: 'Clean tech lettering, telepathic thoughts and glowing cyan sound effects.',
    base: { ...CLASSIC_BASE, font: 'atkinson', weight: 700, fill: '#f2fbff', border: '#0b4f6c', shape: 'rounded_rect', tail: 'straight', tailWidth: 0.7 },
    kinds: {
      thought: { shape: proShape('telepathic'), tail: 'bubbles' },
      shout: { shape: 'electronic', tail: 'lightning' },
      whisper: { borderStyle: 'dotted' },
      caption: { shape: 'rect', fill: '#0b1f2ae6', textColor: '#9be7ff', border: '#0b4f6c', textCase: 'as_typed', tail: 'none' },
      sfx: { font: 'dela-gothic-one', weight: 400, sfxEffect: proSfx('gradient'), textColor: '#00b4d8', textStroke: { color: '#0b1f2a', width: 0.1 }, shadow: null, rotate: 0, glow: { color: '#9be7ff', size: 0.12 }, ...SFX_NO_BUBBLE }
    },
    promptHint: 'Letter it like a sci-fi comic: clean uppercase tech lettering in rounded panels, dark captions with cyan text, glowing sound effects.'
  },
  western: {
    id: 'western',
    name: 'Western',
    blurb: 'Dusty parchment balloons, banner captions and slab-serif sound effects.',
    base: { ...CLASSIC_BASE, font: 'kalam', weight: 700, fill: '#fbf3e0', border: '#5a3a1a', textColor: '#2e1d0e' },
    kinds: {
      thought: { shape: 'cloud', tail: 'bubbles' },
      shout: { shape: 'jagged', tail: 'straight' },
      whisper: { borderStyle: 'dashed' },
      caption: { shape: 'ribbon', fill: '#e8cfa0', border: '#5a3a1a', font: 'ultra', weight: 400, tail: 'none' },
      sfx: { font: 'ultra', weight: 400, sfxEffect: proSfx('extrude3d'), textColor: '#c1440e', textStroke: { color: '#2e1d0e', width: 0.08 }, shadow: { color: '#5a3a1a', dx: 0.06, dy: 0.06 }, rotate: 'auto', ...SFX_NO_BUBBLE }
    },
    promptHint: 'Letter it like a western: hand lettering in parchment balloons, banner captions in wanted-poster type, slab-serif sound effects.'
  },
  villain: {
    id: 'villain',
    name: 'Villain',
    blurb: 'Black balloons with pale text, menacing shouts and shattered red sound effects.',
    base: { ...CLASSIC_BASE, fill: '#1b1b1b', textColor: '#f5f5f5', border: '#000000' },
    kinds: {
      thought: { shape: 'cloud', tail: 'bubbles' },
      shout: { shape: proShape('monster'), fill: '#2a0000', textColor: '#ff5252', tail: 'straight' },
      whisper: { borderStyle: 'dashed', border: '#555555' },
      caption: { shape: 'rect', fill: '#3a0000', textColor: '#ffd7d7', tail: 'none' },
      sfx: { font: 'ultra', weight: 400, sfxEffect: proSfx('shatter'), textColor: '#d00000', textStroke: { color: INK, width: 0.12 }, shadow: null, rotate: 'auto', glow: { color: '#ff1a1a', size: 0.1 }, ...SFX_NO_BUBBLE }
    },
    promptHint: 'Letter the villain darkly: black balloons with pale text, menacing shout balloons, shattered red sound effects.'
  },
  robot: {
    id: 'robot',
    name: 'Robot',
    blurb: 'Radio-wave balloons, lightning tails and steel-grey sound effects.',
    base: { ...CLASSIC_BASE, font: 'atkinson', weight: 700, fill: '#eef3f7', border: '#37474f', textColor: '#1c262b', shape: proShape('radio'), tail: 'lightning' },
    kinds: {
      thought: { shape: 'electronic', tail: 'bubbles' },
      shout: { shape: 'electronic', tail: 'lightning', weight: 800 },
      whisper: { borderStyle: 'dotted' },
      caption: { shape: 'rect', fill: '#263238', textColor: '#b2ebf2', border: '#37474f', tail: 'none' },
      sfx: { font: 'dela-gothic-one', weight: 400, sfxEffect: proSfx('outline_stack'), textColor: '#90a4ae', textStroke: { color: '#263238', width: 0.12 }, shadow: null, rotate: 0, ...SFX_NO_BUBBLE }
    },
    promptHint: 'Letter the robot like a broadcast: uppercase tech lettering in zig-zag radio balloons with lightning tails.'
  },
  narrator_box: {
    id: 'narrator_box',
    name: 'Narrator box',
    blurb: 'Classic balloons with typewriter narration in boxed, left-aligned captions.',
    base: CLASSIC_BASE,
    kinds: {
      thought: { shape: 'cloud', tail: 'bubbles' },
      shout: { shape: 'burst', tail: 'straight' },
      whisper: { italic: true, borderStyle: 'dashed' },
      caption: { shape: 'rect', fill: '#fff6c8', font: 'special-elite', weight: 400, textCase: 'as_typed', align: 'left', borderWidth: 1.2, padding: 1.3, tail: 'none' },
      sfx: { font: 'bangers', weight: 400, sfxEffect: 'filled_stroke', textColor: 'auto', textStroke: { color: INK, width: 0.12 }, shadow: { color: INK, dx: 0.05, dy: 0.05 }, rotate: 'auto', ...SFX_NO_BUBBLE }
    },
    promptHint: 'Letter it with a narrator: classic balloons, and narration in boxed, left-aligned typewriter captions.'
  },
  newspaper: {
    id: 'newspaper',
    name: 'Newspaper strip',
    blurb: 'Crisp black-and-white print lettering with double-ruled captions.',
    base: { ...CLASSIC_BASE, font: 'atkinson', weight: 700, border: '#000000', textColor: '#000000', borderWidth: 0.9 },
    kinds: {
      thought: { shape: 'cloud', tail: 'bubbles' },
      shout: { shape: 'burst', tail: 'straight', weight: 800 },
      whisper: { borderStyle: 'dashed' },
      caption: { shape: 'rect', fill: '#ffffff', borderStyle: 'double', textCase: 'as_typed', tail: 'none' },
      sfx: { font: 'bangers', weight: 400, sfxEffect: 'outlined', textColor: '#ffffff', textStroke: { color: '#000000', width: 0.12 }, shadow: null, rotate: 'auto', ...SFX_NO_BUBBLE }
    },
    promptHint: 'Letter it like a newspaper strip: crisp black uppercase print lettering in white balloons, double-ruled captions.'
  },
  retro_caption: {
    id: 'retro_caption',
    name: 'Retro caption',
    blurb: 'Golden-age yellow notched captions over cream balloons.',
    base: { ...CLASSIC_BASE, fill: '#fffbe8', borderWidth: 1.2 },
    kinds: {
      thought: { shape: 'cloud', tail: 'bubbles' },
      shout: { shape: 'burst', tail: 'straight' },
      whisper: { italic: true, borderStyle: 'dashed' },
      caption: { shape: 'notched', fill: '#ffe066', weight: 800, borderWidth: 1.4, padding: 1.2, tail: 'none' },
      sfx: { font: 'ultra', weight: 400, sfxEffect: 'filled_stroke', textColor: 'auto', textStroke: { color: INK, width: 0.12 }, shadow: { color: INK, dx: 0.06, dy: 0.06 }, rotate: 'auto', ...SFX_NO_BUBBLE }
    },
    promptHint: 'Letter it like a golden-age comic: cream balloons and bold uppercase narration in yellow notched caption boxes.'
  },
  flashback: {
    id: 'flashback',
    name: 'Flashback',
    blurb: 'Sepia wavy balloons and scroll captions for memories.',
    base: { ...CLASSIC_BASE, font: 'kalam', weight: 400, textCase: 'as_typed', textColor: '#4a3726', fill: '#f3e7cf', border: '#7a5c3a', shape: 'wavy', borderWidth: 0.9 },
    kinds: {
      thought: { shape: 'cloud', tail: 'bubbles' },
      shout: { shape: 'burst', tail: 'straight' },
      whisper: { borderStyle: 'dashed' },
      caption: { shape: 'scroll', fill: '#ead7b0', border: '#7a5c3a', italic: true, tail: 'none' },
      sfx: { font: 'permanent-marker', weight: 400, sfxEffect: 'skewed', textColor: '#7a5c3a', textStroke: { color: '#f3e7cf', width: 0.08 }, shadow: null, rotate: 'auto', ...SFX_NO_BUBBLE }
    },
    promptHint: 'Letter it as a flashback: sepia hand lettering in soft wavy balloons, scroll-shaped captions.'
  },
  superhero: {
    id: 'superhero',
    name: 'Superhero',
    blurb: 'Bold heavy-outlined balloons, explosion shouts and 3D sound effects.',
    base: { ...CLASSIC_BASE, weight: 800, borderWidth: 1.3 },
    kinds: {
      thought: { shape: 'cloud', tail: 'bubbles' },
      shout: { shape: 'explosion', fill: '#fff3c4', tail: 'straight' },
      whisper: { italic: true, borderStyle: 'dashed' },
      caption: { shape: 'rect', fill: '#ffd84a', tail: 'none' },
      sfx: { font: 'bangers', weight: 400, sfxEffect: proSfx('extrude3d'), textColor: 'auto', textStroke: { color: INK, width: 0.12 }, shadow: { color: INK, dx: 0.07, dy: 0.07 }, rotate: 'auto', ...SFX_NO_BUBBLE }
    },
    promptHint: 'Letter it like a superhero comic: bold uppercase lettering with heavy outlines, explosion shouts, big 3D sound effects.'
  },
  fantasy: {
    id: 'fantasy',
    name: 'Fantasy',
    blurb: 'Storybook hand lettering, parchment scroll captions and golden sound effects.',
    base: { ...CLASSIC_BASE, font: 'kalam', weight: 700, textCase: 'as_typed', fill: '#fffaf0', border: '#5b3e1f', textColor: '#2b1d0e', shape: 'oval' },
    kinds: {
      thought: { shape: 'cloud', tail: 'bubbles' },
      shout: { shape: 'burst', tail: 'straight' },
      whisper: { italic: true, borderStyle: 'dashed' },
      caption: { shape: 'scroll', fill: '#f5e6c4', border: '#8a6a3a', weight: 400, italic: true, tail: 'none' },
      sfx: { font: 'luckiest-guy', weight: 400, sfxEffect: proSfx('gradient'), textColor: '#d4a017', textStroke: { color: '#5b3e1f', width: 0.1 }, shadow: null, rotate: 'auto', ...SFX_NO_BUBBLE }
    },
    promptHint: 'Letter it like a fantasy tale: warm hand lettering in parchment oval balloons, scroll captions, golden sound effects.'
  },
  comedy: {
    id: 'comedy',
    name: 'Comedy',
    blurb: 'Bouncy mixed-case lettering, sticky-note asides and wobbly sound effects.',
    base: { ...CLASSIC_BASE, font: 'shantell-sans', weight: 600, textCase: 'as_typed', border: '#222222' },
    kinds: {
      thought: { shape: 'cloud', tail: 'bubbles' },
      shout: { shape: 'jagged', tail: 'straight', weight: 800 },
      whisper: { italic: true, borderStyle: 'dashed' },
      caption: { shape: proShape('sticky'), fill: '#fff59d', border: '#b7950b', tail: 'none' },
      sfx: { font: 'luckiest-guy', weight: 400, sizeScale: 1, sfxEffect: proSfx('wobble'), textColor: 'auto', textStroke: { color: INK, width: 0.1 }, shadow: null, rotate: 'auto', ...SFX_NO_BUBBLE }
    },
    promptHint: 'Letter it like a comedy strip: bouncy mixed-case text in round balloons, sticky-note captions, wobbly sound effects.'
  },
  zine: {
    id: 'zine',
    name: 'Zine',
    blurb: 'Photocopied marker lettering, wobbly outlines and shattered sound effects.',
    base: { ...CLASSIC_BASE, font: 'permanent-marker', weight: 400, shape: 'wavy', borderWidth: 1.4 },
    kinds: {
      thought: { shape: 'cloud', tail: 'bubbles' },
      shout: { shape: 'jagged', tail: 'straight' },
      whisper: { borderStyle: 'dashed' },
      caption: { shape: proShape('sticky'), fill: '#f1f1f1', font: 'special-elite', textCase: 'as_typed', tail: 'none' },
      sfx: { font: 'permanent-marker', weight: 400, sizeScale: 1, sfxEffect: proSfx('shatter'), textColor: '#111111', textStroke: { color: '#ffffff', width: 0.1 }, shadow: null, rotate: 'auto', ...SFX_NO_BUBBLE }
    },
    promptHint: 'Letter it like a photocopied zine: marker lettering in wobbly balloons, taped-on captions, broken sound effects.'
  }
};

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
export const isLetteringPresetId = (v: unknown): v is LetteringPresetId => typeof v === 'string' && hasOwn(LETTERING_PRESETS, v);
export const isProLetteringPresetId = (v: unknown): v is ProLetteringPresetId => typeof v === 'string' && hasOwn(PRO_LETTERING_PRESETS, v);

/**
 * The look a stored presetId draws: a base look, a Pro look, or classic for anything else (a look a newer build stored,
 * kept on load). Never indexes with an unchecked key (a stored "constructor" draws classic too).
 */
export function letteringPresetOf(id: unknown): LetteringPreset | ProLetteringPreset {
  if (isLetteringPresetId(id)) return LETTERING_PRESETS[id];
  if (isProLetteringPresetId(id)) return PRO_LETTERING_PRESETS[id];
  return LETTERING_PRESETS.classic;
}

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

/** Options of the lettering sanitizers. */
export interface LetterSanitizeOptions {
  /**
   * LOAD ONLY: normalizeDoc (normalizeLine and the doc's letterStyle) passes it; client patch sanitizers never do. Also
   * keeps the Pro lettering a newer build stored, when structurally valid: the PRO_STYLE_KEYS, a PRO_BUBBLE_SHAPES shape,
   * a PRO_SFX_EFFECTS effect (halftone_fill too: S3 draws it), a Pro font id (any well-formed id, so a face PE-FONTS adds
   * later survives), `letterStyle.named`, and a well-formed look id this build does not know (sanitizeLetteringStyle
   * keeps it with its base, kinds, speakers and named, and resolveLetterStyle draws it as classic). The server hydrates
   * through normalizeDoc and writes the whole doc back, so without it a rollback would strip them for good. Numbers are
   * kept as stored when finite (sign checks only): the write bounds (PRO_LETTER_LIMITS strokeWMax, glowSizeMax,
   * warpAmountMax) are the client sanitizer's and the drawing's, so they may change without another load-side deploy.
   */
  keepStoredPro?: boolean;
  /**
   * CLIENT WRITES of Pro lettering (PE-LETTER; S2b lead decision, collisions B-3 / C-9): accept the Pro text keys within
   * the write bounds, the Pro shapes, the drawn Pro SFX effects, PRO_FONT_IDS, the Pro looks and `named` styles. The
   * server passes `allowPro: PRO_EDIT_OPS_PATCHABLE` (sanitize/lettering.ts; style.ts cannot import ops.ts), so no client
   * stores any of them until the lead flips that switch. Without it every sanitizer behaves exactly as before.
   */
  allowPro?: boolean;
}

/** A stored font id this build may not ship (a Pro face, PE-FONTS): lower-case words joined by '-'. Load only. */
const STORED_FONT_ID_RE = /^[a-z][a-z0-9-]{1,47}$/;
/** A stored look id this build may not know (a newer build's look): lower-case words joined by '_'. Load only. */
const STORED_PRESET_ID_RE = /^[a-z][a-z0-9_]{1,31}$/;
/** A named style's key ('st_…' or any short id) as stored. */
const NAMED_STYLE_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
/**
 * A well-formed look id as the load keeps it: a base or Pro look, or one a newer build added (C-8). The shared
 * letter_style op applies such a look, so the undo of a restyle (a reset, then the stored look with its base, kinds and
 * speakers) gives a rolled-back comic its lettering back. Which look a CLIENT may send stays the server's call
 * (sanitize/lettering.ts: a pickable look, or the doc's own stored one re-asserted); an unknown look draws as classic.
 */
export const isStoredLookId = (v: unknown): v is LetteringPresetId =>
  isLetteringPresetId(v) || isProLetteringPresetId(v) || (typeof v === 'string' && STORED_PRESET_ID_RE.test(v) && !UNSAFE_KEYS.has(v));
const finiteNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : undefined);
const nonNegNum = (v: unknown): number | undefined => {
  const n = finiteNum(v);
  return n !== undefined && n >= 0 ? n : undefined;
};

/** A stored Pro text-styling value, structurally valid (load only), or undefined. */
const storedProKey = (key: keyof ProLetterStyle, v: unknown): unknown => {
  switch (key) {
    case 'fillGradient': {
      if (v === null) return null;
      if (!isObj(v)) return undefined;
      const from = normalizeColor(v.from);
      const to = normalizeColor(v.to);
      const angle = finiteNum(v.angle);
      return from && to && angle !== undefined ? { from, to, angle } : undefined;
    }
    case 'strokes': {
      if (!Array.isArray(v)) return undefined;
      const out: StrokeLayer[] = [];
      for (const s of v) {
        if (out.length >= PRO_LETTER_LIMITS.strokes) break;
        if (!isObj(s)) continue;
        const color = normalizeColor(s.color);
        const w = nonNegNum(s.w);
        if (color && w !== undefined) out.push({ color, w });
      }
      // [] is kept (no strokes, superseding textStroke); a list with nothing valid in it is dropped.
      return out.length || !v.length ? out : undefined;
    }
    case 'glow': {
      if (v === null) return null;
      if (!isObj(v)) return undefined;
      const color = normalizeColor(v.color);
      const size = nonNegNum(v.size);
      return color && size !== undefined ? { color, size } : undefined;
    }
    case 'warp': return oneOf(v, WARP_STYLES);
    case 'warpAmount': return finiteNum(v);
    default: return undefined;
  }
};

/** A colour a Pro paint can draw: '#rrggbb[aa]' only ('none' and 'auto' mean nothing for a gradient stop or a glow). */
const proColor = (v: unknown): Color | undefined => {
  const c = normalizeColor(v);
  return c && c.startsWith('#') ? c : undefined;
};

/** A client's Pro text-styling value within the write bounds (allowPro), or undefined. */
const writeProKey = (key: keyof ProLetterStyle, v: unknown): unknown => {
  switch (key) {
    case 'fillGradient': {
      if (v === null) return null;
      if (!isObj(v)) return undefined;
      const from = proColor(v.from);
      const to = proColor(v.to);
      const angle = num(v.angle ?? 90, -360, 360);
      return from && to && angle !== undefined ? { from, to, angle } : undefined;
    }
    case 'strokes': {
      if (!Array.isArray(v)) return undefined;
      const out: StrokeLayer[] = [];
      for (const s of v.slice(0, PRO_LETTER_LIMITS.strokes)) {
        if (!isObj(s)) continue;
        const color = proColor(s.color);
        const w = num(s.w, 0, PRO_LETTER_LIMITS.strokeWMax);
        if (color && w !== undefined && w > 0) out.push({ color, w });
      }
      return out.length || !v.length ? out : undefined;
    }
    case 'glow': {
      if (v === null) return null;
      if (!isObj(v)) return undefined;
      const color = proColor(v.color);
      const size = num(v.size, 0, PRO_LETTER_LIMITS.glowSizeMax);
      return color && size !== undefined && size > 0 ? { color, size } : undefined;
    }
    case 'warp': return oneOf(v, WARP_STYLES);
    case 'warpAmount': return num(v, -PRO_LETTER_LIMITS.warpAmountMax, PRO_LETTER_LIMITS.warpAmountMax);
    default: return undefined;
  }
};

/** Per-key validation; `keep` = the load keep, `pro` = a client's Pro write (allowPro). */
const sanitizeKey = (key: keyof LetterStyle, v: unknown, keep = false, pro = false): unknown => {
  switch (key) {
    case 'font':
      return oneOf(v, FONT_IDS) ?? (pro && isProFontId(v) ? v : undefined) ?? (keep && typeof v === 'string' && STORED_FONT_ID_RE.test(v) ? v : undefined);
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
    case 'shape': return oneOf(v, BUBBLE_SHAPES) ?? (keep || pro ? oneOf(v, PRO_BUBBLE_SHAPES) : undefined);
    case 'tail': return oneOf(v, TAIL_STYLES);
    case 'tailWidth': return num(v, 0.4, 2);
    case 'padding': return num(v, 0, 3);
    case 'rotate': return v === 'auto' ? 'auto' : num(v, -30, 30);
    case 'sfxEffect':
      return oneOf(v, SFX_EFFECTS) ?? (keep ? oneOf(v, PRO_SFX_EFFECTS) : pro ? oneOf(v, DRAWN_PRO_SFX_EFFECTS) : undefined);
    case 'arc': return num(v, -1, 1);
    default: return undefined;
  }
};

/**
 * Clamp ranges, validate enums/font ids/colours (normalizeColor); drop unknown keys; undefined if nothing valid.
 * A client patch (no options) never keeps a Pro key or id. `{allowPro: true}` accepts them within the write bounds
 * (PE-LETTER, behind PRO_EDIT_OPS_PATCHABLE); `{keepStoredPro: true}` is the load normalizer's (LetterSanitizeOptions).
 * Either way the Pro keys come after the base keys, in PRO_STYLE_KEYS order (idempotent).
 */
export function sanitizeLetterStylePatch(raw: unknown, opts?: LetterSanitizeOptions): LetterStylePatch | undefined {
  if (!isObj(raw)) return undefined;
  const keep = opts?.keepStoredPro === true;
  const pro = opts?.allowPro === true;
  const out: Record<string, unknown> = {};
  for (const key of STYLE_KEYS) {
    if (!(key in raw)) continue;
    const value = sanitizeKey(key, raw[key], keep, pro);
    if (value !== undefined) out[key] = value;
  }
  if (keep || pro) {
    for (const key of PRO_STYLE_KEYS) {
      if (!(key in raw)) continue;
      // The load keep is the more lenient of the two (any finite stored number), so it wins when both are passed.
      const value = keep ? storedProKey(key, raw[key]) : writeProKey(key, raw[key]);
      if (value !== undefined) out[key] = value;
    }
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

const sanitizeKinds = (raw: unknown, opts?: LetterSanitizeOptions): Partial<Record<LineKind, LetterStylePatch>> | undefined => {
  if (!isObj(raw)) return undefined;
  const out: Partial<Record<LineKind, LetterStylePatch>> = {};
  for (const k of LINE_KINDS) {
    const p = sanitizeLetterStylePatch(raw[k], opts);
    if (p) out[k] = p;
  }
  return Object.keys(out).length ? out : undefined;
};
const sanitizeSpeakers = (raw: unknown, allow?: ReadonlySet<string>, opts?: LetterSanitizeOptions): Record<string, LetterStylePatch> | undefined => {
  if (!isObj(raw)) return undefined;
  const out: Record<string, LetterStylePatch> = {};
  for (const [id, v] of Object.entries(raw)) {
    if (!id || id.length > 64 || (allow && !allow.has(id))) continue;
    const p = sanitizeLetterStylePatch(v, opts);
    if (p) out[id] = p;
  }
  return Object.keys(out).length ? out : undefined;
};

/** A named style's key and name as a writer may set them (the load keep is the same rule). */
const namedKeyOk = (id: string): boolean => NAMED_STYLE_KEY_RE.test(id) && !UNSAFE_KEYS.has(id);
const namedNameOk = (name: unknown): name is string =>
  typeof name === 'string' && !!name.trim() && name.length <= PRO_LETTER_LIMITS.namedNameChars;

/**
 * Stored named styles (load only), structurally valid: a key of 1..64 id characters (never __proto__ and friends), a
 * name of 1..PRO_LETTER_LIMITS.namedNameChars characters, an object patch (sanitized with the Pro keys kept; it may be
 * empty), at most PRO_LETTER_LIMITS.namedStyles in stored order. Undefined when none is left.
 */
const storedNamedStyles = (raw: unknown): Record<string, NamedLetterStyle> | undefined => {
  if (!isObj(raw)) return undefined;
  const out: Record<string, NamedLetterStyle> = {};
  let n = 0;
  for (const [id, v] of Object.entries(raw)) {
    if (n >= PRO_LETTER_LIMITS.namedStyles) break;
    if (!namedKeyOk(id) || !isObj(v)) continue;
    if (!namedNameOk(v.name) || !isObj(v.patch)) continue;
    out[id] = { name: v.name, patch: sanitizeLetterStylePatch(v.patch, { keepStoredPro: true }) ?? {} };
    n += 1;
  }
  return n ? out : undefined;
};

/** A stored look id: a base or Pro look, or (load keep) a well-formed id a newer build added. */
const storedPresetId = (v: unknown, keep: boolean, pro: boolean): LetteringPresetId | undefined => {
  if (isLetteringPresetId(v)) return v;
  if ((keep || pro) && isProLetteringPresetId(v)) return v as unknown as LetteringPresetId;
  if (keep && typeof v === 'string' && STORED_PRESET_ID_RE.test(v) && !UNSAFE_KEYS.has(v)) return v as LetteringPresetId;
  return undefined;
};

/**
 * Missing/invalid → DEFAULT_LETTERING (no auto). `{keepStoredPro: true}` (normalizeDoc only) also keeps the Pro keys in
 * base, kinds and speakers, `named`, and a Pro look or a well-formed look id this build does not know WITH its patches
 * (C-8: before PE-LETTER an unknown look reset the doc's lettering, so a rolled-back build would wipe it; it now draws as
 * classic and the next newer build draws it again). `{allowPro: true}` (a client's whole lettering style, behind
 * PRO_EDIT_OPS_PATCHABLE) accepts a Pro look, the Pro keys and ids in base, kinds and speakers within the write bounds,
 * and `named` under the same rules as a `letter_style {named}` write (writeNamedStyles; a bad entry drops `named`).
 */
export function sanitizeLetteringStyle(raw: unknown, opts?: LetterSanitizeOptions): LetteringStyle {
  if (!isObj(raw)) return { ...DEFAULT_LETTERING };
  const keepOn = opts?.keepStoredPro === true;
  const proOn = !keepOn && opts?.allowPro === true;
  const presetId = storedPresetId(raw.presetId, keepOn, proOn);
  if (!presetId) return { ...DEFAULT_LETTERING };
  const keep: LetterSanitizeOptions | undefined = keepOn ? { keepStoredPro: true } : proOn ? { allowPro: true } : undefined;
  const out: LetteringStyle = { presetId };
  if (typeof raw.auto === 'boolean') out.auto = raw.auto;
  const base = sanitizeLetterStylePatch(raw.base, keep);
  if (base) out.base = base;
  const kinds = sanitizeKinds(raw.kinds, keep);
  if (kinds) out.kinds = kinds;
  const speakers = sanitizeSpeakers(raw.speakers, undefined, keep);
  if (speakers) out.speakers = speakers;
  const margin = num(raw.safeMargin, 0, MAX_SAFE_MARGIN);
  if (margin !== undefined) out.safeMargin = margin;
  if (keepOn) {
    const named = storedNamedStyles(raw.named);
    if (named) out.named = named;
  } else if (proOn && raw.named !== undefined) {
    const named = mergeNamedStyles(undefined, writeNamedStyles(raw.named, { allowPro: true }) ?? undefined);
    if (named) out.named = named;
  }
  return out;
}

const STYLE_PATCH_MAX_BYTES = 2048;
const tooBig = (v: unknown) => v !== null && v !== undefined && JSON.stringify(v).length > STYLE_PATCH_MAX_BYTES;

/** A client's `named` entries (allowPro): null deletes; a style needs a valid key and name; ≤ namedStyles per patch. */
const writeNamedStyles = (raw: unknown, opts: LetterSanitizeOptions): Record<string, NamedLetterStyle | null> | null | undefined => {
  if (!isObj(raw)) return null;
  const out: Record<string, NamedLetterStyle | null> = {};
  let n = 0;
  for (const [id, v] of Object.entries(raw)) {
    if (!namedKeyOk(id)) return null;
    if (n >= PRO_LETTER_LIMITS.namedStyles) return null;
    n += 1;
    if (v === null) {
      out[id] = null;
      continue;
    }
    if (!isObj(v) || tooBig(v)) return null;
    const name = typeof v.name === 'string' ? v.name.trim() : v.name;
    if (!namedNameOk(name)) return null;
    out[id] = { name, patch: (v.patch === undefined ? undefined : sanitizeLetterStylePatch(v.patch, opts)) ?? {} };
  }
  return Object.keys(out).length ? out : undefined;
};

/**
 * Server/director validation of a `letter_style` op patch. null = reject (invalid or empty). Without options exactly as
 * before PE-LETTER (base looks only, no Pro key or id, `named` ignored); `{allowPro: true}` also accepts the Pro looks,
 * the Pro keys and ids in base / kinds / speakers, and `named` upserts and deletes (LetterSanitizeOptions.allowPro).
 */
export function sanitizeLetteringStyleOpPatch(raw: unknown, castIds: ReadonlySet<string>, opts?: LetterSanitizeOptions): LetteringStyleOpPatch | null {
  if (!isObj(raw)) return null;
  const pro = opts?.allowPro === true;
  const patchOpts: LetterSanitizeOptions | undefined = pro ? { allowPro: true } : undefined;
  const out: LetteringStyleOpPatch = {};
  if (raw.presetId !== undefined) {
    const presetId = oneOf(raw.presetId, LETTERING_PRESET_IDS) ?? (pro && isProLetteringPresetId(raw.presetId) ? (raw.presetId as unknown as LetteringPresetId) : undefined);
    if (!presetId) return null;
    out.presetId = presetId;
  }
  if (typeof raw.keepOverrides === 'boolean') out.keepOverrides = raw.keepOverrides;
  if (raw.auto === null || typeof raw.auto === 'boolean') out.auto = raw.auto as boolean | null;
  if (raw.base !== undefined) {
    if (tooBig(raw.base)) return null;
    if (raw.base === null) out.base = null;
    else {
      const base = sanitizeLetterStylePatch(raw.base, patchOpts);
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
        const p = sanitizeLetterStylePatch(v, patchOpts);
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
        const p = sanitizeLetterStylePatch(v, patchOpts);
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
  if (pro && raw.named !== undefined) {
    const named = writeNamedStyles(raw.named, { allowPro: true });
    if (named === null) return null;
    if (named) out.named = named;
  }
  return Object.keys(out).length ? out : null;
}

// ── Named styles (agent-editor plan §3 C7; PE-LETTER) ────────────────────────

/** The saved style a line links to (`line.styleId` naming an own key of `letterStyle.named`), or undefined. */
export function namedStyleOf(ls: Pick<LetteringStyle, 'named'> | null | undefined, styleId: unknown): NamedLetterStyle | undefined {
  const named = ls?.named;
  if (!named || typeof styleId !== 'string' || !styleId || !hasOwn(named, styleId)) return undefined;
  const style = named[styleId];
  return isObj(style) && isObj(style.patch) ? style : undefined;
}

/**
 * `letterStyle.named` after a `letter_style {named}` patch: an entry replaces that style (its patch whole), null deletes
 * it, and a new style past PRO_LETTER_LIMITS.namedStyles is not added. Existing styles keep their order. undefined when
 * none is left. For ops.ts (the frozen apply; wave note) and the editor's optimistic preview.
 */
export function mergeNamedStyles(
  cur: Record<string, NamedLetterStyle> | undefined,
  patch: Record<string, NamedLetterStyle | null> | undefined
): Record<string, NamedLetterStyle> | undefined {
  const out: Record<string, NamedLetterStyle> = { ...(cur || {}) };
  for (const [id, v] of Object.entries(patch || {})) {
    if (!namedKeyOk(id)) continue;
    if (v === null) delete out[id];
    else if (isObj(v) && namedNameOk(v.name)) {
      if (!hasOwn(out, id) && Object.keys(out).length >= PRO_LETTER_LIMITS.namedStyles) continue;
      out[id] = { name: v.name, patch: isObj(v.patch) ? { ...v.patch } : {} };
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * The style a line keeps when its named style is deleted: the named patch folded into the line's own style, so it
 * resolves exactly as before (agent-editor plan §3 C7: "deleting a style folds its patch back, nothing changes
 * visually"). A named key is folded only where nothing later in the cascade already decides it: the line's own style or
 * its speaker's patch (a value this build draws). Returns the line's style unchanged when it uses no saved style.
 */
export function foldedLineStyle(ls: Pick<LetteringStyle, 'named' | 'speakers'> | null | undefined, line: Pick<Line, 'style' | 'styleId' | 'speakerId'>): LetterStylePatch | undefined {
  const named = namedStyleOf(ls, line.styleId);
  if (!named) return line.style;
  const speaker = line.speakerId && ls?.speakers && hasOwn(ls.speakers, line.speakerId) ? ls.speakers[line.speakerId] : undefined;
  const decides = (p: LetterStylePatch | undefined, k: string): boolean => {
    if (!p || !hasOwn(p, k)) return false;
    const v = (p as Record<string, unknown>)[k];
    return v !== undefined && drawable(k, v);
  };
  const add: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(named.patch)) {
    if (v === undefined || decides(line.style, k) || decides(speaker, k)) continue;
    add[k] = v;
  }
  // A spread, not mergeStylePatch: a named `null` (no glow, no shadow) is a value that decides the look and must stay.
  const out = { ...(line.style || {}), ...add };
  return Object.keys(out).length ? (out as LetterStylePatch) : undefined;
}

/** One line a named style's deletion restyles: where it is and the style it keeps (undefined = no own style). */
export interface FoldedLine {
  pageId: string;
  lineId: string;
  style: LetterStylePatch | undefined;
  /**
   * The folded style is over the line-style cap (2 KB serialized, server LINE_STYLE_MAX_BYTES): a named entry and a line's
   * own style may each be up to 2 KB, so their fold can be larger and its `line_style {mode: 'replace'}` would be refused.
   * The editor refuses the deletion calmly instead (foldRefusal) and sends nothing.
   */
  tooBig: boolean;
}

/**
 * Deleting saved style `styleId`: every line on a live page that links to it, with the style it keeps (foldedLineStyle).
 * The editor sends, in one undo entry, a `line_style` replace per line, the `line {styleId: null}` unlinks and
 * `letter_style {named: {[styleId]: null}}` (PE-INSPECT / styleOps), or nothing at all, saying foldRefusal's sentence,
 * when a folded style would be past the line-style cap (FoldedLine.tooBig). A trashed page's lines keep the link and draw
 * without the style if restored after the deletion (no op edits a trashed page).
 */
export function foldNamedStyle(doc: Pick<ComicDoc, 'letterStyle' | 'pages'>, styleId: string): FoldedLine[] {
  const ls = doc.letterStyle;
  if (!namedStyleOf(ls, styleId)) return [];
  const out: FoldedLine[] = [];
  for (const page of doc.pages || []) {
    for (const panel of page.panels || []) {
      for (const line of panel.lines || []) {
        if (line.styleId !== styleId) continue;
        const style = foldedLineStyle(ls, line);
        out.push({ pageId: page.id, lineId: line.id, style, tooBig: tooBig(style) });
      }
    }
  }
  return out;
}

/**
 * The calm one-sentence refusal when a named style cannot be deleted because folding it would make some balloons' own
 * styles too large (FoldedLine.tooBig), naming how many; undefined when the deletion can go ahead.
 */
export function foldRefusal(folded: readonly FoldedLine[]): string | undefined {
  const n = folded.filter((f) => f.tooBig).length;
  if (!n) return undefined;
  return n === 1
    ? "This style can't be folded into 1 balloon; shorten its own style first."
    : `This style can't be folded into ${n} balloons; shorten their own styles first.`;
}

// ── Resolution ───────────────────────────────────────────────────────────────

/** Bubble shapes, SFX effects and fonts this build draws: the base lists plus the Pro ones PE-LETTER draws (B-4) and
 *  PE-FONTS ships. A later Pro id (halftone_fill, a face not shipped yet) is kept on load but is not drawable. */
const DRAWN_SHAPES: ReadonlySet<string> = new Set<string>([...BUBBLE_SHAPES, ...PRO_BUBBLE_SHAPES]);
const DRAWN_SFX_EFFECTS: ReadonlySet<string> = new Set<string>([...SFX_EFFECTS, ...DRAWN_PRO_SFX_EFFECTS]);
const DRAWN_FONTS: ReadonlySet<string> = new Set<string>([...FONT_IDS, ...PRO_FONT_IDS]);
const PRO_KEY_SET: ReadonlySet<string> = new Set<string>(PRO_STYLE_KEYS);
/** A stored value this build can draw. A Pro id it cannot draw yet (kept on load) is skipped by the cascade, so every
 *  exhaustive record keyed by them only sees drawn ids. */
const drawable = (k: string, v: unknown): boolean =>
  k === 'shape' ? DRAWN_SHAPES.has(v as string) : k === 'sfxEffect' ? DRAWN_SFX_EFFECTS.has(v as string) : k === 'font' ? DRAWN_FONTS.has(v as string) : true;
/** A bubble shape this build draws (base or Pro). */
export const isDrawnShape = (v: unknown): v is AnyBubbleShape => typeof v === 'string' && DRAWN_SHAPES.has(v);
/** An SFX effect this build draws (base or the S2 Pro ones). */
export const isDrawnSfxEffect = (v: unknown): v is AnySfxEffect => typeof v === 'string' && DRAWN_SFX_EFFECTS.has(v);

const applyPatch = (style: LetterStyle, patch: LetterStylePatch | null | undefined): LetterStyle => {
  if (!patch) return style;
  const out = { ...style } as Record<string, unknown>;
  // `k in style` keeps unknown keys out; the Pro text keys are in no base look, so they are let in by name.
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && (k in style || PRO_KEY_SET.has(k)) && drawable(k, v)) out[k] = v;
  }
  return out as unknown as LetterStyle;
};

/** preset.base → preset.kinds[k] → doc.base → doc.kinds[k] → doc.named[line.styleId] → doc.speakers[speakerId] → line.style. */
export function resolveLetterStyle(doc: Pick<ComicDoc, 'letterStyle' | 'format'>, line: Line): LetterStyle {
  const ls = doc.letterStyle ?? DEFAULT_LETTERING;
  const preset = letteringPresetOf(ls.presetId);
  let style = applyPatch(preset.base, preset.kinds[line.kind]);
  style = applyPatch(style, ls.base);
  style = applyPatch(style, ls.kinds?.[line.kind]);
  const named = line.styleId ? namedStyleOf(ls, line.styleId) : undefined;
  if (named) style = applyPatch(style, named.patch);
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
