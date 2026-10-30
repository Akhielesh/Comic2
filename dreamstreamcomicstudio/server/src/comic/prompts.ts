// Prompt compiler for Comic Studio (v4) image jobs.
//
// Pure and deterministic: (doc, target) → CompiledImageJob { model, resolution, aspect,
// prompt, labeled references }. No I/O, no clocks, no randomness — the same doc always
// compiles to the same job, so prompts are unit-testable and a render can be traced
// back to exactly what the model was told. See docs/features/comic-studio-v4.md §5–§6.
//
// Craft principles (why the old studio failed, §1):
//  - The PAGE is the unit: one image per page with panels, gutters and lettering space.
//  - Every reference image is LABELED by index in a legend whose order matches the
//    attachment order exactly, and never exceeds the model's caps (refs in models.ts).
//  - One source of truth per fact: a character's full look is stated once (cast block);
//    each panel block names who is in it with a short identity anchor (≤ 12 words) and the
//    box it fills, what it must show, and who speaks or is heard off-panel (plan §4.2).
//  - Lettering never leaks prompt text: overlay pages are text-free with open background
//    beside each speaker (never blank bars); in-art pages letter the script's lines verbatim
//    and nothing else.
//  - Non-humans are first-class cast: animals, creatures, robots and groups ("DUCKLINGS ×3")
//    get the same identity lock as people; recurring props get a PROPS lock.
//  - Every image carries the comic's content rating (PG-13 ceiling, kids lower) as an art
//    rule plus rating negatives on the "Never:" line; a `safe` take is one notch gentler.
//  - User references are RANKED (shared/comic/refRanking.ts): the main photo first, then the
//    labels that fit the job, never two near-duplicates, never a blocked image.

import {
  castKindOf,
  coverCastOf,
  findPlace,
  isPageStale,
  letterStyleOf,
  type AspectRatio,
  type AssetRef,
  type Box,
  type Character,
  type ComicDoc,
  type ComicKind,
  type Line,
  type LineKind,
  type Page,
  type Panel,
  type Place,
  type RefAsset,
  type RefLabel,
  type RenderState,
  type ShotType,
  type StyleOption
} from '../../../shared/comic/doc.js';
import { LETTERING_PRESETS } from '../../../shared/comic/lettering/style.js';
import {
  nearestAspect,
  resolveImageJob,
  type ImageJobKind,
  type ImageModelSpec,
  type ResolvedImageJob
} from '../../../shared/comic/models.js';
import { deriveLock } from '../../../shared/comic/modelLock.js';
import { isPhotoLikeness, pickRefs, type RefContext } from '../../../shared/comic/refRanking.js';
import {
  drawnLayoutBoxes,
  effectiveLayout,
  harmonizePanelSizes,
  layoutConflicts,
  layoutPanelCount,
  parseLayout,
  synthesizeLayout,
  type LayoutCell,
  type ParsedLayout
} from '../../../shared/comic/pageGeometry.js';
import { REF_LIMITS } from '../../../shared/comic/refs.js';
import {
  ALWAYS_ART_AVOID,
  CONTENT_RATINGS,
  RATING_RULES,
  SAFE_TAKE_LINE,
  canServeToOwner,
  effectiveRating,
  isKidsAudience,
  minRating,
  safetyStatusOf,
  saferRating,
  softenAction,
  type ContentRating
} from '../../../shared/comic/safety.js';
import { STYLE_PRESETS, getStylePreset } from '../../../shared/comic/stylePresets.js';
import { StudioError, type CompiledImageJob } from './types.js';

/**
 * What every compiler returns: the image job plus the USER reference paths it attached
 * (author photos, place photos, user style refs — never generated sheets/boards/pages), in
 * attachment order. The job runner records them as `VersionMeta.refPaths` ("drawn from older
 * photos"); for a character sheet they are exactly that character's photos (sheetRefsChanged).
 */
export interface CompiledRenderJob extends CompiledImageJob {
  refPaths: string[];
}

/** Shared compile options. `safe` = the one-notch-gentler "safe take" (PG-13 → PG → G). */
export interface CompileOptions {
  safe?: boolean;
  /**
   * A further ceiling the caller knows about (the account-age ceiling, or the account-clamped
   * effective rating). It can only LOWER the doc's effective rating, never raise it: passing
   * 'PG-13' for a kids comic still draws at PG.
   */
  rating?: ContentRating;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Used when the doc has no style spec (and no preset fits the format). Strong, neutral, drawable. */
export const DEFAULT_STYLE_SPEC =
  'Modern professional comic book art: confident clean inks with varied line weight, solid anatomy and ' +
  'expressive acting, clear readable staging, cel-shaded digital coloring with soft gradients and controlled ' +
  'saturation, consistent lighting within each scene, detailed but uncluttered backgrounds.';

const DEFAULT_AVOID = ['photorealism', 'muddy or blurry rendering', 'warped anatomy or extra fingers', 'watermarks or signatures'];

/** Path placeholder for the red-outlined copy of the page; the job runner substitutes the real image. */
export const REGION_REFERENCE_PATH = '__region__';

/**
 * Path placeholder for the page layout guide (plan C9; panelize/wireframe.ts renders it from
 * pageLayoutBoxes at prepare time; nothing is stored). Attached only when the caller asks for it
 * (`layoutGuide`, set by the job runner while COMIC_LAYOUT_GUIDE is on — off until the A/B).
 */
export const LAYOUT_REFERENCE_PATH = '__layout__';
export const LAYOUT_GUIDE_LABEL = 'PAGE LAYOUT GUIDE';
const LAYOUT_GUIDE_INSTRUCTION =
  'Draw the panel borders exactly on its black lines and keep its white gutters; it shows layout only — never copy its flat fill, and it holds no characters or text.';

export const SHOT_TEXT: Record<ShotType, string> = {
  establishing: 'establishing shot (the whole location)',
  wide: 'wide shot',
  full: 'full shot (figures head to toe)',
  medium: 'medium shot (waist up)',
  close_up: 'close-up (head and shoulders)',
  extreme_close_up: 'extreme close-up',
  over_shoulder: 'over-the-shoulder shot',
  insert: 'insert shot (close detail of an object)',
  pov: 'point-of-view shot'
};

const KIND_TEXT: Record<ComicKind, string> = {
  comic: 'comic book',
  manga: 'manga',
  webtoon: 'webtoon (vertical-scroll comic)',
  strip: 'comic strip',
  storybook: 'illustrated storybook'
};

const LINE_KIND_TEXT: Record<LineKind, string> = {
  speech: 'speech',
  thought: 'thought',
  whisper: 'whisper',
  shout: 'shout',
  caption: 'caption',
  sfx: 'sfx'
};

/**
 * How each lettering element should look when the model letters the page (in_art). The
 * lettering preset's `promptHint` follows it (lettering.md §9); for any preset other than
 * classic the speech balloon drops its colors so the hint decides them.
 */
export const LETTERING_LOOK: Record<LineKind, string> = {
  speech: 'speech balloons as white ovals with black borders and a tail pointing to the speaker',
  thought: 'thought balloons as clouds with a trail of small bubbles',
  whisper: 'whispers as dashed-outline balloons with smaller letters',
  shout: 'shouts as spiky burst balloons with bold letters',
  caption: 'captions as rectangular boxes',
  sfx: 'sound effects as bold display lettering integrated into the art'
};
const NEUTRAL_SPEECH_LOOK = 'speech balloons with a tail pointing to the speaker';

/** Scripts without letter case — "UPPERCASE" lettering makes no sense for them. */
const CASELESS_LANGS = new Set([
  'ja', 'zh', 'ko', 'ar', 'he', 'fa', 'ur', 'hi', 'bn', 'th', 'ta', 'te', 'kn', 'ml', 'mr', 'gu', 'pa', 'si', 'km', 'lo', 'my', 'am', 'ka'
]);

// ── Small text helpers ───────────────────────────────────────────────────────

const clean = (value?: string | null): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/** Trim and make sure the text ends with terminal punctuation. */
const sentence = (value?: string | null): string => {
  const text = clean(value);
  if (!text) return '';
  return /[.!?…]["'”’)\]]*$/.test(text) ? text : `${text}.`;
};

const stripEnd = (value: string) => value.replace(/[\s.;,:]+$/, '');

const clip = (value: string, max: number): string => {
  const text = clean(value);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '')}…`;
};

export const upperName = (name?: string): string => clean(name).toUpperCase() || 'UNNAMED';

/**
 * Wrap text in straight double quotes for a prompt, turning any double quotes INSIDE the
 * text into typographic ones so the delimiters stay unambiguous (a stray `"` would end
 * the quoted line early and the model would letter garbage).
 */
export const quoteForPrompt = (text: string): string => {
  let open = true;
  const inner = clean(text).replace(/"/g, () => {
    const mark = open ? '“' : '”';
    open = !open;
    return mark;
  });
  return `"${inner}"`;
};

const ratioOf = (aspect: string): number => {
  const [w, h] = aspect.split(':').map(Number);
  return w > 0 && h > 0 ? w / h : 1;
};

const orientationOf = (aspect: AspectRatio): string => {
  const r = ratioOf(aspect);
  if (r < 0.6) return 'tall vertical';
  if (r < 0.95) return 'portrait';
  if (r <= 1.05) return 'square';
  if (r > 1.9) return 'wide panoramic';
  return 'landscape';
};

const languageName = (code?: string): string => {
  const tag = clean(code) || 'en';
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) || tag;
  } catch {
    return tag;
  }
};

const isCaselessLanguage = (code?: string) => CASELESS_LANGS.has((clean(code) || 'en').toLowerCase().split(/[-_]/)[0]);

/** "a comic book", "an illustrated storybook". */
const withArticle = (noun: string): string => `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;

const joinList = (items: string[]): string => {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
};

// ── Palette names (hex → words a model can follow) ───────────────────────────

const NAMED_COLORS: [string, number, number, number][] = [
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
  ['indigo', 63, 55, 201], ['purple', 106, 76, 147], ['lavender', 205, 180, 219], ['deep purple', 27, 27, 47]
];

const hexToName = (value: string): string => {
  const raw = clean(value);
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
  if (!m) return raw;
  const hex = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  let best = NAMED_COLORS[0];
  let bestD = Infinity;
  for (const named of NAMED_COLORS) {
    // Weighted RGB distance (cheap perceptual approximation).
    const d = 2 * (named[1] - r) ** 2 + 4 * (named[2] - g) ** 2 + 3 * (named[3] - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = named;
    }
  }
  return best[0];
};

/** "crimson, golden yellow and deep navy" from hex or named palette entries (deduped). */
export const paletteWords = (palette?: string[]): string => {
  const names: string[] = [];
  for (const entry of palette || []) {
    const name = hexToName(entry);
    if (name && !names.includes(name)) names.push(name);
  }
  return joinList(names.slice(0, 6));
};

// ── Style ────────────────────────────────────────────────────────────────────

export interface ResolvedStyle {
  spec: string;
  palette: string[];
  linework?: string;
  avoid: string[];
}

// ── Content rating (safety.md §3.2) ──────────────────────────────────────────

const wordsIn = (phrase: string) => ` ${phrase.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/**
 * Merge avoid lists, dropping case-insensitive duplicates and any phrase another kept phrase
 * already contains as whole words ("gore" is covered by "gore or exposed wounds").
 */
const mergeAvoid = (...lists: readonly (readonly string[])[]): string[] => {
  const out: string[] = [];
  for (const raw of lists.flat()) {
    const item = stripEnd(clean(raw));
    if (!item) continue;
    const w = wordsIn(item);
    if (out.some((kept) => wordsIn(kept).includes(w))) continue;
    for (let i = out.length - 1; i >= 0; i -= 1) if (w.includes(wordsIn(out[i]))) out.splice(i, 1);
    out.push(item);
  }
  return out;
};

/**
 * The style's own avoid list followed by the rating negatives. Every safety phrase is kept
 * VERBATIM: a style phrase only ever drops out when a safety phrase already covers it, never
 * the other way round — so a style avoid such as "no nudity restrictions" can't swallow the
 * "nudity" negative (it would read "Never: no nudity restrictions").
 */
const withSafetyAvoid = (own: readonly string[], safety: readonly string[]): string[] => {
  const covered = safety.map(wordsIn);
  return [...mergeAvoid(own).filter((item) => !covered.some((s) => s.includes(wordsIn(item)))), ...safety];
};

/** The doc's effective rating, lowered (never raised) by a caller's ceiling. */
const ceilingRating = (doc: ComicDoc, rating?: ContentRating): ContentRating =>
  minRating(effectiveRating(doc).rating, rating && CONTENT_RATINGS.includes(rating) ? rating : undefined);

/**
 * Rating negatives for the "Never:" line of every image prompt: the platform's always-avoid
 * art list plus the rating's own avoid list (RATING_RULES), deduplicated.
 */
export const SAFETY_AVOID: Readonly<Record<ContentRating, readonly string[]>> = {
  G: mergeAvoid(ALWAYS_ART_AVOID, RATING_RULES.G.avoid),
  PG: mergeAvoid(ALWAYS_ART_AVOID, RATING_RULES.PG.avoid),
  'PG-13': mergeAvoid(ALWAYS_ART_AVOID, RATING_RULES['PG-13'].avoid)
};

/**
 * The rating the art is drawn at: the doc's effective rating (lowered by the caller's ceiling,
 * never raised — the PG-13 platform ceiling and kids ceilings always hold), one notch stricter
 * for a safe take.
 */
export const artRatingFor = (doc: ComicDoc, opts: CompileOptions = {}): ContentRating => {
  const base = ceilingRating(doc, opts.rating);
  return opts.safe ? saferRating(base) : base;
};

/**
 * The CONTENT RATING paragraph every compiler appends after the art style: the rating's art
 * rule (G / PG / PG-13 — creative action and horror are fine, nothing graphic or sexual),
 * plus the SAFE TAKE line on a safer redraw.
 */
export const contentParagraph = (doc: ComicDoc, opts: CompileOptions = {}): string => {
  const rating = artRatingFor(doc, opts);
  return [`CONTENT RATING ${rating} — ${RATING_RULES[rating].art}`, opts.safe ? SAFE_TAKE_LINE : ''].filter(Boolean).join('\n');
};

/** Free text the image model reads (actions, moods, directions): softened on a safe take. */
const safeText = (text: string, opts: CompileOptions): string => (opts.safe ? softenAction(text) : text);

/**
 * The style every image is drawn in: the doc's style bible, filled from its preset, else
 * a preset matching the comic kind (when its color mode fits), else DEFAULT_STYLE_SPEC.
 * `avoid` always ends with the rating negatives (SAFETY_AVOID), verbatim, for `rating` (the
 * doc's effective rating, lowered — never raised — by the given one).
 */
export const resolveStyle = (doc: ComicDoc, rating?: ContentRating): ResolvedStyle => {
  const preset = getStylePreset(doc.style.presetId);
  const kindPreset =
    !clean(doc.style.spec) && !preset
      ? STYLE_PRESETS.find((p) => p.kind === doc.format.kind && (!p.colorMode || p.colorMode === doc.format.colorMode))
      : undefined;
  const base = preset || kindPreset;
  const own = (doc.style.avoid?.length ? doc.style.avoid : base?.avoid || DEFAULT_AVOID).map(clean).filter(Boolean);
  const avoid = withSafetyAvoid(own, SAFETY_AVOID[ceilingRating(doc, rating)]);
  return {
    spec: sentence(doc.style.spec) || sentence(base?.spec) || DEFAULT_STYLE_SPEC,
    palette: doc.style.palette?.length ? doc.style.palette : base?.palette || [],
    linework: clean(doc.style.linework) || clean(base?.linework) || undefined,
    avoid
  };
};

/** "full color" / "black and white with grey tones only" / "limited palette: …". */
export const colorSentence = (doc: ComicDoc): string => {
  switch (doc.format.colorMode) {
    case 'bw':
      return 'black and white with grey tones only';
    case 'limited': {
      const words = paletteWords(resolveStyle(doc).palette);
      return `limited palette: ${words || 'two or three flat ink colors plus black and paper white'}`;
    }
    default:
      return 'full color';
  }
};

/** The ART STYLE paragraph body (spec + palette + linework + avoid list incl. rating negatives). */
const styleParagraph = (doc: ComicDoc, opts: { avoid?: boolean; rating?: ContentRating } = {}): string => {
  const style = resolveStyle(doc, opts.rating);
  const parts = [style.spec];
  // Palette is stated once: in the color sentence for limited mode, never for b/w.
  if (doc.format.colorMode === 'color') {
    const words = paletteWords(style.palette);
    if (words) parts.push(`Palette: ${words}.`);
  }
  if (style.linework) parts.push(`Linework: ${stripEnd(style.linework)}.`);
  if (opts.avoid !== false && style.avoid.length) parts.push(`Never: ${style.avoid.map(stripEnd).join(', ')}.`);
  return parts.join(' ');
};

// ── Aspect & model resolution ────────────────────────────────────────────────

const resolveJob = (doc: ComicDoc, kind: ImageJobKind): ResolvedImageJob =>
  resolveImageJob(kind, doc.settings.quality, doc.settings.imageModelOverride, doc.imageModel ?? deriveLock(doc));

/**
 * Aspect for a page render. Webtoon segments are tall (1:4 when the model supports it and
 * the segment has 4+ panels, else 9:16); strips are one wide row (21:9 for 4+ panels,
 * else 16:9). Explicitly tall/wide user choices are kept for those kinds.
 */
export const pageAspectFor = (doc: ComicDoc, spec: ImageModelSpec, panelCount?: number): AspectRatio => {
  const want = doc.format.pageAspect || '2:3';
  if (doc.format.kind === 'webtoon') {
    if (ratioOf(want) <= 9 / 16 + 1e-6) return nearestAspect(spec, want);
    if ((panelCount ?? 4) >= 4 && spec.aspects.includes('1:4')) return '1:4';
    return nearestAspect(spec, '9:16');
  }
  if (doc.format.kind === 'strip') {
    if (ratioOf(want) >= 16 / 9 - 1e-6) return nearestAspect(spec, want);
    if ((panelCount ?? 3) >= 4 && spec.aspects.includes('21:9')) return '21:9';
    return nearestAspect(spec, '16:9');
  }
  return nearestAspect(spec, want);
};

/** Cover aspect: the page aspect, except webtoon (9:16 key art) and strips (16:9). */
export const coverAspectFor = (doc: ComicDoc, spec: ImageModelSpec): AspectRatio => {
  if (doc.format.kind === 'webtoon') {
    const want = doc.format.pageAspect || '9:16';
    return nearestAspect(spec, ratioOf(want) <= 9 / 16 + 1e-6 && ratioOf(want) >= 0.5 ? want : '9:16');
  }
  if (doc.format.kind === 'strip') return pageAspectFor(doc, spec, 3);
  return nearestAspect(spec, doc.format.pageAspect || '2:3');
};

/**
 * The frame shape stated in words (bug: a 4:5 page came back 1:1). Image models honour the
 * aspect parameter unevenly, so every page and cover prompt also SAYS the shape:
 * "FRAME: a tall 4:5 portrait page, taller than wide (4 wide by 5 tall)…".
 */
export const frameSentence = (aspect: AspectRatio, what = 'image'): string => {
  const [w, h] = aspect.split(':').map(Number);
  const r = ratioOf(aspect);
  const orientation = orientationOf(aspect);
  if (r >= 0.95 && r <= 1.05) return `FRAME: a ${aspect} square ${what}, as wide as it is tall; fill the whole frame, no letterboxing.`;
  const tall = r < 0.95;
  const adjective = tall ? (orientation === 'tall vertical' ? '' : 'tall ') : orientation === 'wide panoramic' ? '' : 'wide ';
  return `FRAME: a ${adjective}${aspect} ${orientation} ${what}, ${tall ? 'taller than wide' : 'wider than tall'} (${w} wide by ${h} tall); fill the whole frame — never square, no letterboxing.`;
};

/** Nearest supported aspect for an existing image's pixel size. */
const aspectFromSize = (spec: ImageModelSpec, w?: number, h?: number): AspectRatio | undefined => {
  if (!w || !h || w <= 0 || h <= 0) return undefined;
  const target = Math.log(w / h);
  return spec.aspects.reduce((best, a) =>
    Math.abs(Math.log(ratioOf(a)) - target) < Math.abs(Math.log(ratioOf(best)) - target) ? a : best
  );
};

// ── Cast helpers ─────────────────────────────────────────────────────────────

const TIER_RANK: Record<string, number> = { lead: 0, support: 1, extra: 2 };

const FEMALE_WORDS = /\b(female|woman|women|girl|lady|she|her|feminine|mother|queen|princess|grandmother)\b/i;
const MALE_WORDS = /\b(male|man|men|boy|gentleman|he|his|masculine|father|king|prince|grandfather)\b/i;

/** Reference gate (safety.md §3.2): a blocked or quarantined image is never sent to a model. */
const servable = (asset?: AssetRef): asset is AssetRef => !!asset?.path && canServeToOwner(asset);

const usableAsset = (render?: RenderState): string | undefined =>
  render && render.status === 'ready' && servable(render.asset) ? render.asset.path : undefined;

/** Group of 2–12 drawn as one identity class ("three ducklings"); 1 otherwise. */
const groupSize = (c: Character): number => {
  const n = typeof c.count === 'number' && Number.isFinite(c.count) ? Math.floor(c.count) : 1;
  return n >= 2 ? Math.min(n, 12) : 1;
};

/** Prompt name: "MAYA", "DUCKLINGS ×3" (a group). */
export const castLabel = (c: Character): string => {
  const n = groupSize(c);
  return n > 1 ? `${upperName(c.name)} ×${n}` : upperName(c.name);
};

/** Recurring props (a red kite, the magic shell) get a PROPS lock instead of a character line. */
const isProp = (c: Character) => castKindOf(c) === 'object';

const KIND_WORD: Record<string, string> = { animal: 'animal', creature: 'creature', robot: 'robot', toy: 'toy', vehicle: 'vehicle', object: 'object' };

/** Possessive pronoun for legend instructions ("Match her face…"); a group is always "their". */
const possessive = (c: Character): string => {
  if (groupSize(c) > 1) return 'their';
  if (castKindOf(c) !== 'person') return 'its';
  const gender = clean(c.look?.gender).toLowerCase();
  const probe = gender || clean(c.look?.summary).toLowerCase();
  if (FEMALE_WORDS.test(probe)) return 'her';
  if (MALE_WORDS.test(probe)) return 'his';
  return 'their';
};

const hasFacialHair = (c: Character) =>
  /\b(beard|bearded|moustache|mustache|stubble|goatee|sideburns)\b/i.test(
    [c.look?.summary, c.look?.face, c.look?.hair, c.look?.marks].map(clean).join(' ')
  );

/** Per-character panel + line counts on a page (only characters that exist in the doc). */
const pageCastStats = (doc: ComicDoc, page: Page) => {
  const stats = new Map<string, { panels: number; lines: number; first: number }>();
  const known = new Set(doc.cast.map((c) => c.id));
  page.panels.forEach((panel, i) => {
    for (const id of new Set(panel.castIds)) {
      if (!known.has(id)) continue;
      const s = stats.get(id) || { panels: 0, lines: 0, first: i };
      s.panels += 1;
      stats.set(id, s);
    }
    for (const line of panel.lines) {
      if (!line.speakerId || !stats.has(line.speakerId)) continue;
      stats.get(line.speakerId)!.lines += 1;
    }
  });
  return stats;
};

/**
 * The page's cast ranked by importance on THIS page: panel appearances, then tier
 * (lead > support > extra), then lines spoken, then the book's cast order (leads first).
 */
export const rankPageCast = (doc: ComicDoc, page: Page): Character[] => {
  const stats = pageCastStats(doc, page);
  const order = new Map(doc.cast.map((c, i) => [c.id, i]));
  return doc.cast
    .filter((c) => stats.has(c.id))
    .sort((a, b) => {
      const sa = stats.get(a.id)!;
      const sb = stats.get(b.id)!;
      return (
        sb.panels - sa.panels ||
        (TIER_RANK[a.tier] ?? 1) - (TIER_RANK[b.tier] ?? 1) ||
        sb.lines - sa.lines ||
        (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
      );
    });
};

/**
 * "34-year-old female" / "mid-30s" / "elderly man" from the age + gender fields, leaving
 * out whatever the summary already says (no trait is stated twice).
 */
const identityPhrase = (age?: string, gender?: string, summary = ''): string => {
  const said = summary.toLowerCase();
  const a = clean(age);
  const g = clean(gender);
  const ageText = a && !said.includes(a.toLowerCase()) ? (/^\d{1,3}$/.test(a) ? `${a}-year-old` : a) : '';
  const genderSaid =
    !!g &&
    (said.includes(g.toLowerCase()) || (FEMALE_WORDS.test(g) && FEMALE_WORDS.test(said)) || (MALE_WORDS.test(g) && !FEMALE_WORDS.test(g) && MALE_WORDS.test(said)));
  return [ageText, genderSaid ? '' : g].filter(Boolean).join(' ');
};

/**
 * Full visual lock for one character, stated once: the summary plus every non-empty look
 * field the summary doesn't already contain, with distinguishing marks last.
 */
export const describeLook = (c: Character, opts: { colors?: boolean } = {}): string => {
  const look = c.look || { summary: '' };
  const summary = stripEnd(clean(look.summary));
  const seen = summary.toLowerCase();
  const parts: string[] = summary ? [summary] : [];
  const add = (label: string, value?: string) => {
    const v = stripEnd(clean(value));
    if (!v || seen.includes(v.toLowerCase())) return;
    parts.push(label ? `${label}: ${v}` : v);
  };
  const identity = identityPhrase(look.age, look.gender, summary);
  if (identity) parts.push(identity);
  const kind = castKindOf(c);
  if (kind !== 'person') {
    // What it IS, once: the species ("mallard duckling"), else the kind ("animal") unless the summary says it.
    const species = stripEnd(clean(look.species));
    if (species && !seen.includes(species.toLowerCase())) parts.push(`species: ${species}`);
    else if (!species && kind !== 'object' && KIND_WORD[kind] && !seen.includes(KIND_WORD[kind])) parts.push(`kind: ${KIND_WORD[kind]}`);
  }
  add('build', look.build);
  add('face', look.face);
  add('hair', look.hair);
  add('eyes', look.eyes);
  add('skin', look.skin);
  add('outfit', look.outfit);
  if (opts.colors !== false) add('colors', look.palette);
  add('props', look.props);
  add('markings (never change)', look.markings);
  add('always visible', look.marks);
  if (!parts.length) return `no fixed description yet — give ${upperName(c.name)} one clear, distinctive design and keep it identical in every panel.`;
  const n = groupSize(c);
  return `${n > 1 ? `a group of exactly ${n}, all drawn to this one design: ` : ''}${parts.join('; ')}.`;
};

// ── Identity anchors (plan §4.2: every panel's Who line restates ≤ 12 words of the look) ──

const ANCHOR_WORDS = 12;
const ANCHOR_PIECE_WORDS = 7;
/** Words a fragment never ends on ("black bun with a" → "black bun"). */
const ANCHOR_TAIL_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'with', 'of', 'on', 'in', 'at', 'to', 'for', 'from', 'by', 'over', 'under', 'through',
  'across', 'around', 'near', 'beside', 'its', 'his', 'her', 'their', 'that', 'which', 'who'
]);
const ANCHOR_CUT = /\s(?:with|on|in|at|of|over|under|through|across|around|near|beside|from|that|which|who)\s/gi;

const wordCount = (text: string): number => (text ? text.split(/\s+/).filter(Boolean).length : 0);

/** Drop trailing filler words and punctuation; keep at most `max` words. */
const trimFragment = (text: string, max: number): string => {
  const words = text.split(/\s+/).filter(Boolean).slice(0, max);
  while (words.length > 1 && ANCHOR_TAIL_WORDS.has(words[words.length - 1].toLowerCase().replace(/[^\p{L}]/gu, ''))) words.pop();
  return words.join(' ').replace(/[\s,;:]+$/, '');
};

/** The fragment before its first prepositional phrase that leaves ≥ `minHead` words ("" when none). */
const headBeforePreposition = (text: string, minHead: number): string => {
  for (const m of text.matchAll(ANCHOR_CUT)) {
    const head = text.slice(0, m.index);
    if (wordCount(head) >= minHead) return head;
  }
  return '';
};

/**
 * One short visual fragment of a look field: its first clause (comma parts join until the fragment
 * holds ≥ 3 words, so "fine, soft brown hair" stays whole), without a leading article, cut before
 * a prepositional tail when longer than 7 words, at most 7 words.
 */
const anchorPiece = (value?: string): string => {
  const clause = stripEnd(clean(value)).split(/\s*;\s*/)[0] || '';
  let text = '';
  for (const part of clause.split(/\s*,\s*/)) {
    text = text ? `${text}, ${part}` : part;
    if (wordCount(text) >= 3) break;
  }
  text = text.replace(/^(?:a|an|the)\s+/i, '');
  if (wordCount(text) > ANCHOR_PIECE_WORDS) text = headBeforePreposition(text, 3) || text;
  return trimFragment(text, ANCHOR_PIECE_WORDS);
};

/** Palette entries in words ("#e63946, cream" → "red, cream"). */
const paletteText = (value?: string): string =>
  clean(value)
    .split(/\s*,\s*/)
    .map((entry) => hexToName(entry))
    .filter(Boolean)
    .join(', ');

/**
 * A being's identity anchor: ≤ 12 words picked from its look in the plan's order — people: hair,
 * outfit, marks, markings, always-visible props (then the face, when room is left); non-humans and props: what it is (the summary's
 * head), markings, marks, colours, props. A fragment that does not fit is shortened to its core
 * ("thin scar through left eyebrow" → "thin scar") or skipped; the summary's head is the fallback;
 * '' when the look is empty. The full look is still stated once, in the CAST block. `colors: false`
 * (black-and-white pages) leaves the palette out, exactly as describeLook does for the CAST block.
 */
export const identityAnchor = (c: Character, opts: { colors?: boolean } = {}): string => {
  const look = c.look || { summary: '' };
  const fields =
    castKindOf(c) === 'person'
      ? [look.hair, look.outfit, look.marks, look.markings, look.props, look.face]
      : [look.summary, look.markings, look.marks, opts.colors === false ? '' : paletteText(look.palette), look.props];
  const pieces: string[] = [];
  let used = 0;
  for (const field of fields) {
    let piece = anchorPiece(field);
    if (!piece || pieces.some((p) => p.toLowerCase().includes(piece.toLowerCase()))) continue;
    if (used + wordCount(piece) > ANCHOR_WORDS) piece = trimFragment(headBeforePreposition(piece, 2), ANCHOR_PIECE_WORDS);
    if (!piece || used + wordCount(piece) > ANCHOR_WORDS) continue;
    pieces.push(piece);
    used += wordCount(piece);
  }
  const anchor = pieces.length ? pieces.join(', ') : trimFragment(anchorPiece(look.summary), ANCHOR_WORDS);
  // "Broad spice merchant" → "broad spice merchant" (an acronym or a name such as "LEGO" stays).
  return /^\p{Lu}\p{Ll}/u.test(anchor) ? anchor[0].toLowerCase() + anchor.slice(1) : anchor;
};

// ── Staging (left/right hints, shared with the balloon fallback) ─────────────

export interface StagedCharacter {
  id: string;
  /** Horizontal position in the panel, 0 = left … 1 = right. */
  x: number;
  /** "left", "right", "center"… (absent when the panel has a single character). */
  word?: string;
}

const POSITION_WORDS: Record<number, string[]> = {
  2: ['left', 'right'],
  3: ['left', 'center', 'right'],
  4: ['far left', 'center-left', 'center-right', 'far right']
};

/** True when the action already states where people stand (we never contradict it). */
const actionStatesPositions = (action: string) =>
  /\b(left|right|foreground|background|behind|in front of|between|center|centre)\b/i.test(action);

/**
 * Screen positions for a panel's cast. Characters keep the same left→right order across
 * the whole page (order of first appearance), so screen direction stays consistent within
 * a scene (the 180° rule). Hints are omitted when the action already places people.
 */
export const stagePanel = (page: Page, panel: Panel): StagedCharacter[] => {
  const pageOrder: string[] = [];
  for (const p of page.panels) for (const id of p.castIds) if (!pageOrder.includes(id)) pageOrder.push(id);
  const ids = [...new Set(panel.castIds)].sort((a, b) => pageOrder.indexOf(a) - pageOrder.indexOf(b));
  if (ids.length === 1) return [{ id: ids[0], x: 0.5 }];
  const words = POSITION_WORDS[ids.length];
  const withWords = !!words && !actionStatesPositions(panel.action || '');
  return ids.map((id, i) => ({
    id,
    x: ids.length > 1 ? 0.2 + (0.6 * i) / (ids.length - 1) : 0.5,
    ...(withWords ? { word: words![i] } : {})
  }));
};

// ── Layout blueprint (synthesis + parsing; shared with writer, vision and the client) ───
//
// One implementation: shared/comic/pageGeometry.ts (the board's wireframes, the editor's panel
// hit-testing and the server's prompts and QC all read a blueprint the same way). These are
// re-exported under their old names; pageGeometry.parity.test.ts pins the equality.

export type { LayoutCell, ParsedLayout };
export { layoutPanelCount, parseLayout, synthesizeLayout };

// The layout as drawn — layoutConflicts, harmonizePanelSizes and effectiveLayout — lives in the same shared module
// (one implementation for the prompt, the writer, the plan check, the Render-all gate and layoutFixOps); it is
// re-exported here under its old names.
export { effectiveLayout, harmonizePanelSizes, layoutConflicts };

// ── References ───────────────────────────────────────────────────────────────

export type ReferenceKind = 'character' | 'place' | 'style' | 'previous_page' | 'current_page' | 'region' | 'author' | 'page_art' | 'layout';

export interface PlannedReference {
  kind: ReferenceKind;
  /** Which model cap the image counts against. */
  slot: 'character' | 'object' | 'style';
  label: string;
  path: string;
  /** Legend instruction that follows the label. */
  instruction: string;
  characterId?: string;
  placeId?: string;
  /** A reference image the AUTHOR added (photo, drawing) — reported back as refPaths. */
  userRef?: boolean;
}

const STYLE_BOARD_INSTRUCTION = 'Match its rendering style, line quality and color treatment (not its content).';
const STYLE_REF_INSTRUCTION = 'Match its rendering style and color treatment only (not its content).';
const LIKENESS_INSTRUCTION =
  'Real-life likeness reference: keep face shape, markings and proportions; draw in the page\'s art style — never photographic, ignore its background and lighting.';

/** Legend lines ("Image 1 — LABEL. instruction") in attachment order. */
export const referenceLegend = (refs: { label: string; instruction?: string }[]): string =>
  refs.length
    ? [
        'REFERENCE IMAGES (in the order attached):',
        ...refs.map((r, i) => `Image ${i + 1} — ${r.label}.${r.instruction ? ` ${r.instruction}` : ''}`)
      ].join('\n')
    : '';

/** How a ref label reads in a legend (words for the image model; 'other' says nothing). */
const LABEL_WORDS: Record<RefLabel, string> = {
  face: 'face close-up',
  front: 'front view',
  three_quarter: 'three-quarter view',
  side: 'side view',
  back: 'back view',
  full_body: 'full body',
  outfit: 'outfit',
  expression: 'expression',
  pose: 'pose',
  detail: 'detail',
  wide: 'wide view',
  exterior: 'exterior',
  interior: 'interior',
  lighting: 'lighting',
  linework: 'linework',
  color: 'color',
  texture: 'texture',
  mood: 'mood',
  composition: 'composition',
  other: ''
};

/** Legend keywords a note must never spell in capitals (labels are matched downstream, e.g. PREVIOUS PAGE). */
const RESERVED_LABEL_WORDS = /\b(?:previous page|current page|story page|style board|style reference|character sheet|character reference|author reference|location photo|location|photo of|reference images|same page|page layout guide|layout guide)\b/gi;

/** The author's note as quoted DATA: one line, ≤ 140 chars, never instructions, never a legend keyword. */
const noteText = (ref: RefAsset): string => {
  const raw = typeof ref.note === 'string' ? ref.note.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ') : '';
  const note = clean(raw).replace(RESERVED_LABEL_WORDS, (m) => m.toLowerCase());
  return note ? quoteForPrompt(clip(note, REF_LIMITS.noteChars)) : '';
};

/** ' — side view ("her festival outfit")' for author/place photos; '' when the ref has neither. */
const refDetail = (ref: RefAsset): string => {
  const words = ref.label ? LABEL_WORDS[ref.label] || '' : '';
  const note = noteText(ref);
  if (!words && !note) return '';
  return ` — ${words}${words && note ? ` (${note})` : note}`;
};

/** ' (linework)' / ' (linework; "the ink I love")' for style refs. */
const styleDetail = (ref: RefAsset): string => {
  const parts = [ref.label ? LABEL_WORDS[ref.label] || '' : '', noteText(ref)].filter(Boolean);
  return parts.length ? ` (${parts.join('; ')})` : '';
};

/** Legend instruction for a character's model sheet (people unchanged; non-humans and groups by kind). */
const sheetInstruction = (c: Character): string => {
  const pos = possessive(c);
  const n = groupSize(c);
  const group = n > 1 ? ` It shows one member of the group of ${n}: draw all ${n} to this exact design.` : '';
  switch (castKindOf(c)) {
    case 'person': {
      const features = hasFacialHair(c) ? 'face, facial hair, hairstyle' : 'face, hairstyle';
      return `Match ${pos} ${features}, body type, outfit and colors exactly.${group}`;
    }
    case 'object':
    case 'vehicle':
      return `Match ${pos} shape, proportions, colors and details exactly.${group}`;
    case 'robot':
    case 'toy':
      return `Match ${pos} design, face, proportions, colors and details exactly.${group}`;
    default:
      return `Match ${pos} species, face, markings, proportions and colors exactly.${group}`;
  }
};

/** Pass 1 for one character: the ready sheet, else the best-ranked author photo for this job. */
const characterReference = (c: Character, ctx: RefContext = {}, purpose: 'page' | 'cover' = 'page'): PlannedReference | undefined => {
  const sheet = usableAsset(c.sheet);
  if (sheet) {
    return {
      kind: 'character',
      slot: 'character',
      label: `CHARACTER SHEET: ${upperName(c.name)}`,
      path: sheet,
      instruction: sheetInstruction(c),
      characterId: c.id
    };
  }
  const upload = pickRefs(c.refs, 1, purpose, ctx)[0];
  if (upload) {
    const pos = possessive(c);
    const obj = pos === 'her' ? 'her' : pos === 'his' ? 'him' : pos === 'its' ? 'it' : 'them';
    const what = castKindOf(c) === 'person' ? 'face, hair and features' : 'look, markings and colors';
    return {
      kind: 'author',
      slot: 'character',
      label: `CHARACTER REFERENCE: ${upperName(c.name)}${refDetail(upload)}`,
      path: upload.path,
      instruction: `Match ${pos} ${what}; draw ${obj} in this page's art style.`,
      characterId: c.id,
      userRef: true
    };
  }
  return undefined;
};

/** Sheet + main photo on pages/covers (refs.md §5.1 pass 2): explicit choice, or a photo-based lead/support with room. */
const likenessWanted = (c: Character, spare: number): boolean => {
  if (c.likeness === 'sheet_only') return false;
  if (c.likeness === 'sheet_and_photo') return true;
  return isPhotoLikeness(c) && (c.tier === 'lead' || spare >= 2);
};

/**
 * Character references within `budget`, grouped per character in rank order:
 *  - pass 1: one ref each (sheet, else the best photo) — unchanged ordering and budget;
 *  - pass 2: spare slots add "PHOTO OF MAYA (likeness)" next to a photo-based character's sheet;
 *  - pass 3: spare slots add a second, different photo for characters that have no sheet.
 * On pages every BEING with a ready sheet or photo is eligible whatever its tier (an extra prop
 * stays text-locked), in the page's rank order; a cover references whoever it features
 * (coverCastOf only features extras when the book has no leads, supports or companions). Counts
 * against characters AND total caps.
 */
const castReferences = (
  cast: Character[],
  spec: ImageModelSpec,
  budget: { total: number },
  purpose: 'page' | 'cover',
  ctxFor: (c: Character) => RefContext
): PlannedReference[] => {
  let slots = Math.min(Math.max(0, spec.refs.characters), budget.total);
  const groups: { c: Character; refs: PlannedReference[] }[] = [];
  for (const c of cast) {
    if (slots <= 0) break;
    // Presence, not tier (plan C7): on a page an extra competes like anyone else when it is a being
    // with a ready, servable sheet or photo (the f8312c86 protagonist is an extra in 20 of 20 panels).
    // The page's rank order (rankPageCast) decides who fits the model's character slots.
    if (c.tier === 'extra' && purpose === 'page' && isProp(c)) continue;
    const ref = characterReference(c, ctxFor(c), purpose);
    if (!ref) continue;
    groups.push({ c, refs: [ref] });
    slots -= 1;
    budget.total -= 1;
  }
  for (const g of groups) {
    if (slots <= 0) break;
    if (g.refs[0].kind !== 'character' || !likenessWanted(g.c, slots)) continue;
    const photo = pickRefs(g.c.refs, 1, purpose, ctxFor(g.c))[0];
    if (!photo) continue;
    g.refs.push({
      kind: 'author',
      slot: 'character',
      label: `PHOTO OF ${upperName(g.c.name)} (likeness)`,
      path: photo.path,
      instruction: LIKENESS_INSTRUCTION,
      characterId: g.c.id,
      userRef: true
    });
    slots -= 1;
    budget.total -= 1;
  }
  for (const g of groups) {
    if (slots <= 0) break;
    const first = g.refs[0];
    if (first.kind !== 'author') continue;
    const second = pickRefs(g.c.refs, REF_LIMITS.pagePhotosPerCharacter, purpose, ctxFor(g.c)).find((r) => r.path !== first.path);
    if (!second) continue;
    g.refs.push({
      kind: 'author',
      slot: 'character',
      label: `CHARACTER REFERENCE 2: ${upperName(g.c.name)}${refDetail(second)}`,
      path: second.path,
      instruction: `The same ${castKindOf(g.c) === 'person' ? 'person' : 'individual'} from another photo; combine both into one consistent design.`,
      characterId: g.c.id,
      userRef: true
    });
    slots -= 1;
    budget.total -= 1;
  }
  return groups.flatMap((g) => g.refs);
};

const placeReference = (p: Place, ctx: RefContext = {}): PlannedReference | undefined => {
  const sheet = usableAsset(p.sheet);
  const photo = sheet ? undefined : pickRefs(p.refs, 1, 'place_sheet', ctx)[0];
  const path = sheet || photo?.path;
  if (!path) return undefined;
  return {
    kind: 'place',
    slot: 'object',
    label: `LOCATION: ${upperName(p.name)}${photo ? refDetail(photo) : ''}`,
    path,
    instruction: 'Match architecture, props and palette.',
    placeId: p.id,
    ...(photo ? { userRef: true } : {})
  };
};

/**
 * Style anchors within caps. Models with a distinct style class (Pro) get the board plus
 * up to 2 ranked user style refs as STYLE refs; others get the board (or, without one, the
 * best user style ref) as a single OBJECT ref.
 */
const styleReferences = (doc: ComicDoc, spec: ImageModelSpec, budget: { total: number; objects: number }, ctx: RefContext = {}): PlannedReference[] => {
  const out: PlannedReference[] = [];
  const board = servable(doc.style.board) ? doc.style.board.path : undefined;
  const styleRef = (ref: RefAsset, n: number, slot: 'style' | 'object'): PlannedReference => ({
    kind: 'style',
    slot,
    label: `STYLE REFERENCE ${n}${styleDetail(ref)}`,
    path: ref.path,
    instruction: STYLE_REF_INSTRUCTION,
    userRef: true
  });
  if (spec.refs.style > 0) {
    const max = Math.min(spec.refs.style, 3, budget.total);
    if (board && out.length < max) out.push({ kind: 'style', slot: 'style', label: 'STYLE BOARD', path: board, instruction: STYLE_BOARD_INSTRUCTION });
    for (const ref of pickRefs(doc.style.refs, 2, 'style', ctx)) {
      if (out.length >= max) break;
      out.push(styleRef(ref, out.filter((r) => r.label.startsWith('STYLE REFERENCE')).length + 1, 'style'));
    }
    budget.total -= out.length;
    return out;
  }
  if (budget.objects <= 0 || budget.total <= 0) return out;
  if (board) out.push({ kind: 'style', slot: 'object', label: 'STYLE BOARD', path: board, instruction: STYLE_BOARD_INSTRUCTION });
  else {
    const best = pickRefs(doc.style.refs, 1, 'style', ctx)[0];
    if (best) out.push(styleRef(best, 1, 'object'));
  }
  budget.objects -= out.length;
  budget.total -= out.length;
  return out;
};

/** Page-render options beyond CompileOptions. */
export interface PageCompileOptions extends CompileOptions {
  /**
   * Attach the PAGE LAYOUT GUIDE as Image 1 (plan C9, C19): it takes one object slot before
   * anything else and the panel blocks name their box "in the layout guide". The job runner sets
   * it while COMIC_LAYOUT_GUIDE is on and substitutes LAYOUT_REFERENCE_PATH with the rendered guide.
   */
  layoutGuide?: boolean;
}

/**
 * Reference images for a page render, ordered exactly as they must be attached:
 * (layout guide, when asked) → characters → locations → style → previous page.
 *
 * Budget priority (when caps bind): characters (≤ refs.characters, every being on the page with a
 * ready sheet or photo — extras included — ranked by rankPageCast; overflow and extra props are
 * text-locked only; spare slots add a likeness photo or a second photo next to their character),
 * then the style anchor,
 * then location sheets by how many panels use them, then the previous page for continuity —
 * all within refs.objects and refs.total. Blocked images are never attached.
 */
export const planPageReferences = (
  doc: ComicDoc,
  page: Page,
  spec: ImageModelSpec,
  previousPage?: Page,
  opts: PageCompileOptions = {}
): PlannedReference[] => {
  const budget = { total: Math.max(0, spec.refs.total), objects: Math.max(0, spec.refs.objects) };
  const guide: PlannedReference[] = [];
  // One object slot, first in the legend (C19) — never a model's ONLY object slot (a legacy-locked
  // comic keeps its style anchor; the layout is still stated in words).
  if (opts.layoutGuide && spec.refs.objects >= 2 && budget.objects > 0 && budget.total > 1) {
    guide.push({ kind: 'layout', slot: 'object', label: LAYOUT_GUIDE_LABEL, path: LAYOUT_REFERENCE_PATH, instruction: LAYOUT_GUIDE_INSTRUCTION });
    budget.objects -= 1;
    budget.total -= 1;
  }
  const effective = artRatingFor(doc, opts);
  const shotsOf = (id: string) => page.panels.filter((p) => p.castIds.includes(id)).map((p) => p.shot);
  const characters = castReferences(rankPageCast(doc, page), spec, budget, 'page', (c) => ({ shots: shotsOf(c.id), effectiveRating: effective }));

  const style = styleReferences(doc, spec, budget, { effectiveRating: effective });

  // Locations used on the page, most-used first (ties: first appearance).
  const placeCounts = new Map<string, { count: number; first: number }>();
  page.panels.forEach((panel, i) => {
    if (!panel.placeId) return;
    const entry = placeCounts.get(panel.placeId) || { count: 0, first: i };
    entry.count += 1;
    placeCounts.set(panel.placeId, entry);
  });
  const places: PlannedReference[] = [];
  const rankedPlaces = [...placeCounts.entries()].sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first);
  for (const [placeId] of rankedPlaces) {
    if (budget.objects <= 0 || budget.total <= 0) break;
    const place = findPlace(doc, placeId);
    const ref = place && placeReference(place, { effectiveRating: effective });
    if (!ref) continue;
    places.push(ref);
    budget.objects -= 1;
    budget.total -= 1;
  }

  const previous: PlannedReference[] = [];
  const prevPath =
    previousPage && previousPage.id !== page.id && (previousPage.render.status === 'ready' || previousPage.render.status === 'stale') && servable(previousPage.render.asset)
      ? previousPage.render.asset.path
      : undefined;
  if (prevPath && budget.objects > 0 && budget.total > 0) {
    previous.push({
      kind: 'previous_page',
      slot: 'object',
      label: 'PREVIOUS PAGE',
      path: prevPath,
      instruction: `Keep lighting, outfits and props continuous with it (not its layout${doc.format.lettering === 'in_art' ? ' or lettering' : ''}).`
    });
  }

  return [...guide, ...characters, ...places, ...style, ...previous];
};

const toJobReferences = (refs: PlannedReference[]) => refs.map((r) => ({ label: r.label, path: r.path }));

/** User reference paths actually attached, in attachment order (VersionMeta.refPaths). */
const userRefPathsOf = (refs: PlannedReference[]): string[] => [...new Set(refs.filter((r) => r.userRef).map((r) => r.path))];

/** The finished job: model, size, prompt, legend-ordered references and the user ref paths. */
const finishJob = (resolved: ResolvedImageJob, aspect: AspectRatio, prompt: string, refs: PlannedReference[]): CompiledRenderJob => ({
  spec: resolved.spec,
  resolution: resolved.resolution,
  aspect,
  prompt,
  references: toJobReferences(refs),
  refPaths: userRefPathsOf(refs)
});

// ── Page ─────────────────────────────────────────────────────────────────────

// ── Panel geometry in words (plan §4.2: "box N", measured proportions) ─────────

/**
 * The page's panel rectangles as the prompt (and the layout guide) describe them: the effective
 * blueprint's estimate, in reading order. Never the previous take's measured boxes — the prompt
 * describes the PLAN, so a drifted drawing is not copied into the next one. One implementation:
 * shared drawnLayoutBoxes, so the plan check, the gate and the free fix measure what this draws.
 */
export const pageLayoutBoxes = (doc: ComicDoc, page: Page): Box[] => drawnLayoutBoxes(doc, page);

const ROW_EPS = 0.005;
const pct = (v: number): number => Math.max(1, Math.min(100, Math.round(v * 100)));

/** Distinct row tops (sorted): a tall panel beside a stack starts one row and runs into the next. */
const rowTopsOf = (boxes: Box[]): number[] => {
  const tops: number[] = [];
  for (const b of boxes) if (!tops.some((t) => Math.abs(t - b.y) < ROW_EPS)) tops.push(b.y);
  return tops.sort((a, b) => a - b);
};

/** [first, last] row index a box covers. */
const rowSpanOf = (tops: number[], b: Box): [number, number] => {
  const first = Math.max(0, tops.findIndex((t) => Math.abs(t - b.y) < ROW_EPS));
  let last = first;
  tops.forEach((t, i) => {
    if (i > first && t < b.y + b.h - ROW_EPS) last = i;
  });
  return [first, last];
};

const FULL_WIDTH = 0.9;

/** "left" / "center" / "right" / "full width" from a box's horizontal extent. */
const sideOf = (b: Box): string => {
  if (b.w >= FULL_WIDTH) return 'full width';
  const cx = b.x + b.w / 2;
  return cx < 0.4 ? 'left' : cx > 0.6 ? 'right' : 'center';
};

/** "(row 2, left; 47% wide × 31% tall)" — where box i sits and how big it is. */
const boxWhere = (boxes: Box[], i: number): string => {
  const b = boxes[i];
  if (!b) return '';
  const size = `${pct(b.w)}% wide × ${pct(b.h)}% tall`;
  if (boxes.length === 1) return `the whole page; ${size}`;
  const tops = rowTopsOf(boxes);
  const [first, last] = rowSpanOf(tops, b);
  const rows = first === last ? `row ${first + 1}` : `rows ${first + 1}–${last + 1}`;
  return `${rows}, ${sideOf(b)}; ${size}`;
};

/**
 * The measured line under the blueprint: "Row 1 (top 31% of the page): panel 1, full width. Row 2
 * (next 31%): panels 2 and 3 side by side, 47% wide each." A webtoon segment gives heights only.
 */
const measuredLayout = (doc: ComicDoc, page: Page, boxes: Box[]): string => {
  const n = page.panels.length;
  if (n < 2 || boxes.length !== n || boxes.some((b) => !b)) return '';
  const label = (i: number) => String(page.panels[i]?.n ?? i + 1);
  if (doc.format.kind === 'webtoon') {
    return `Measured heights, top to bottom: ${boxes.map((b, i) => `panel ${label(i)} ${pct(b.h)}%`).join(', ')} of the image height.`;
  }
  const tops = rowTopsOf(boxes);
  const spans = boxes.map((b) => rowSpanOf(tops, b));
  const rows: string[] = [];
  tops.forEach((_, r) => {
    const items = boxes.map((b, i) => ({ b, i })).filter(({ i }) => spans[i][0] === r);
    if (!items.length) return;
    const single = items.filter(({ i }) => spans[i][1] === r);
    const height = Math.min(...(single.length ? single : items).map(({ b }) => b.h));
    const head = `Row ${r + 1} (${r === 0 ? `top ${pct(height)}% of the page` : `next ${pct(height)}%`})`;
    const equal = items.length > 1 && single.length === items.length && items.every(({ b }) => Math.abs(b.w - items[0].b.w) < 0.01);
    let body: string;
    if (items.length === 1 && single.length === 1 && items[0].b.w >= FULL_WIDTH) body = `panel ${label(items[0].i)}, full width`;
    else if (equal) body = `panels ${joinList(items.map(({ i }) => label(i)))} side by side, ${pct(items[0].b.w)}% wide each`;
    else {
      body = items
        .map(({ b, i }) => {
          const tall = spans[i][1] > r ? `, ${pct(b.h)}% tall (rows ${r + 1}–${spans[i][1] + 1})` : '';
          return `panel ${label(i)} on the ${sideOf(b)}, ${pct(b.w)}% wide${tall}`;
        })
        .join('; ');
    }
    rows.push(`${head}: ${body}.`);
  });
  return rows.length ? `Measured proportions: ${rows.join(' ')}` : '';
};

// ── Per-panel block (plan §4.2 / C18 step 1) ─────────────────────────────────

/** Line kinds the software letters as balloons beside a speaker (captions and SFX are not spoken by anyone drawn). */
const BALLOON_KINDS: ReadonlySet<LineKind> = new Set<LineKind>(['speech', 'thought', 'whisper', 'shout']);

const escapeName = (name: string) => clean(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The viewer of a point-of-view panel when the action names them ("From Kalyani's view…",
 * "through Ravi's eyes", "Ravi's POV"). They are heard, not seen: never in the drawn cast.
 * Old plans forced every speaker into the cast ("speakers are visible", writer R8). Names in
 * scripts the pattern cannot match fail safe: the viewer stays drawn.
 */
export const povViewerOf = (doc: ComicDoc, panel: Panel): Character | undefined => {
  if (panel.shot !== 'pov') return undefined;
  const action = clean(panel.action);
  if (!action) return undefined;
  const ids = new Set([...panel.castIds, ...panel.lines.map((l) => l.speakerId).filter((id): id is string => !!id)]);
  return doc.cast.find((c) => {
    if (!ids.has(c.id) || !clean(c.name)) return false;
    const name = escapeName(c.name);
    return new RegExp(
      `(?:\\b(?:from|through)\\s+(?:the\\s+)?${name}['’]s\\s+(?:point of view|view|eyes|perspective|pov)\\b|\\b${name}['’]s\\s+(?:pov|point of view)\\b)`,
      'iu'
    ).test(action);
  });
};

/**
 * The cast ids the page prompt asks to be DRAWN in a panel: its castIds without a POV viewer the
 * action names (the panel block's Who line). QC should check the art against these, not castIds,
 * or correct art reads as "VIEWER missing" (plan §4.3; vision wave note).
 */
export const drawnCastIds = (doc: ComicDoc, panel: Panel): string[] => {
  const viewer = povViewerOf(doc, panel);
  return viewer ? panel.castIds.filter((id) => id !== viewer.id) : [...panel.castIds];
};

/**
 * Cast ids the page prompt names as an "OFF-PANEL VOICE … (do not draw)": anyone with a balloon line
 * (speech, thought, whisper, shout) in the panel who is not drawn there — a speaker missing from
 * castIds, or the POV viewer. In first-line order, each once. QC must never report them as missing.
 */
export const offPanelSpeakerIds = (doc: ComicDoc, panel: Panel): string[] => {
  const drawn = new Set(drawnCastIds(doc, panel));
  const out: string[] = [];
  for (const line of panel.lines) {
    const id = line.speakerId;
    if (!id || !clean(line.text) || !BALLOON_KINDS.has(line.kind) || drawn.has(id) || out.includes(id)) continue;
    if (doc.cast.some((c) => c.id === id)) out.push(id);
  }
  return out;
};

/** "on the left" / "in the center" / "left of center" for a stagePanel position word. */
const positionPhrase = (word: string): string => {
  if (word === 'center') return 'in the center';
  if (word === 'center-left') return 'left of center';
  if (word === 'center-right') return 'right of center';
  return `on the ${word}`;
};

/** "Image 2" / "Images 2 and 3" (no parentheses); '' when nothing is attached. */
const imageWords = (indexes?: number[]): string =>
  indexes?.length ? (indexes.length > 1 ? `Images ${joinList(indexes.map(String))}` : `Image ${indexes[0]}`) : '';

/** A sentence end followed by the start of another sentence (a capital, a digit, a quote or a bracket). */
const SENTENCE_BOUNDARY = /[.!?…]["'”’)\]]*(?=\s+[\p{Lu}\p{N}"“'‘(])/gu;
/** A full stop that ends a title or a single initial ("Dr.", "St.", "J."), not a sentence. */
const ABBREVIATION_END = /(?:^|[^\p{L}\p{N}])(?:Mr|Mrs|Ms|Dr|Prof|St|Mt|Sr|Jr|Capt|Lt|Sgt|Col|Gen|No|vs|etc|\p{Lu})\.$/u;

/**
 * First sentence of an action, and the rest ("Must show" / "Detail"). A boundary after a title or
 * an initial ("Dr. Rao opens the vault.") is not a sentence end, and a one-word first sentence
 * ("Boom! The door falls.") is not split off; with no valid boundary the whole action is the first.
 */
const splitAction = (text: string): { first: string; rest: string } => {
  const t = clean(text);
  for (const m of t.matchAll(SENTENCE_BOUNDARY)) {
    const end = (m.index ?? 0) + m[0].length;
    const first = t.slice(0, end);
    if (ABBREVIATION_END.test(first) || wordCount(first) < 2) continue;
    const rest = t.slice(end).trim();
    if (rest) return { first, rest };
  }
  return { first: t, rest: '' };
};

/**
 * "Detail: <the rest of the action>; <mood>." (plan §4.2: "Detail: her face is worried …; anxious, cold
 * blue light."). Every block with either part has one, so a one-sentence action still carries its
 * mood ("Detail: focused."); '' only when the panel has neither.
 */
const detailLine = (rest: string, mood: string): string => {
  const body = stripEnd(clean(rest));
  const feel = stripEnd(clean(mood)).replace(/^\p{Lu}(?=\p{Ll})/u, (ch) => ch.toLowerCase());
  if (!body && !feel) return '';
  if (!feel) return `Detail: ${sentence(body)}`;
  if (!body) return `Detail: ${sentence(feel)}`;
  // "Gold spills out!" keeps its own ending; the mood follows as its own sentence.
  if (/[!?…]["'”’)\]]*$/.test(body)) return `Detail: ${body} ${sentence(feel[0].toUpperCase() + feel.slice(1))}`;
  return `Detail: ${body}; ${sentence(feel)}`;
};

interface PanelBlockContext {
  names: Map<string, string>;
  props: ReadonlySet<string>;
  index: Map<string, number[]>;
  boxes: Box[];
  /** The layout guide is attached (COMIC_LAYOUT_GUIDE): boxes are named "in the layout guide". */
  guide: boolean;
  /** Restate identity anchors in Who (dropped only when the page prompt runs over budget). */
  anchors: boolean;
  /** Colour page: anchors may name palette colours (a black-and-white page states none, like its CAST block). */
  colors: boolean;
}

/**
 * "Speaks: MEERA — 1 balloon; compose open background … beside her head for it." Speakers drawn in
 * the panel get room beside their heads; anyone not drawn is an "OFF-PANEL VOICE: NAME (do not
 * draw)". Captions and SFX are laid on later and need no room; a panel without balloons says so,
 * so its art fills the frame (no blank bars).
 */
const speaksLine = (doc: ComicDoc, panel: Panel, drawn: ReadonlySet<string>, ctx: PanelBlockContext): string => {
  const counts = new Map<string, number>();
  let captions = 0;
  let sfx = 0;
  for (const line of panel.lines) {
    if (!clean(line.text)) continue;
    if (line.kind === 'caption') captions += 1;
    else if (line.kind === 'sfx') sfx += 1;
    else if (BALLOON_KINDS.has(line.kind)) {
      const key = line.speakerId && doc.cast.some((c) => c.id === line.speakerId) ? line.speakerId : '';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const balloons = (k: number) => `${k} balloon${k === 1 ? '' : 's'}`;
  const nameOf = (id: string) => ctx.names.get(id) || castLabel(doc.cast.find((c) => c.id === id)!);
  const visible = [...counts].filter(([id]) => id && drawn.has(id));
  const offPanel = [...counts].filter(([id]) => !id || !drawn.has(id));
  if (!visible.length && !offPanel.length) {
    const why = captions ? 'narration only' : sfx ? 'sound effects only' : 'a silent panel';
    return `Speaks: nobody (${why}); fill the panel with art to its borders.`;
  }
  const parts: string[] = [];
  if (visible.length) {
    const who = visible.map(([id, k]) => `${nameOf(id)} — ${balloons(k)}`).join('; ');
    const room =
      visible.length === 1
        ? `compose open background (sky, wall, floor or shadow) beside ${possessive(doc.cast.find((c) => c.id === visible[0][0])!)} head for ${visible[0][1] === 1 ? 'it' : 'them'}`
        : "compose open background (sky, wall, floor or shadow) beside each speaker's head for their balloons";
    parts.push(`Speaks: ${who}; ${room}.`);
  }
  const tail = doc.format.lettering === 'in_art' ? '; its tail points out of the panel' : '';
  for (const [id, k] of offPanel) {
    parts.push(`OFF-PANEL VOICE: ${id ? `${nameOf(id)} (do not draw)` : 'unnamed (do not draw)'} — ${balloons(k)}${tail}.`);
  }
  return parts.join(' ');
};

/**
 * One block per panel, naming everything the panel must carry (replaces the old one-line panel):
 *   PANEL 2 of 3 — box 2 in the layout (row 2, left; 47% wide × 46% tall).
 *   Camera: close-up (head and shoulders), high angle. Place: GATE.
 *   Must show: <the action's first sentence>
 *   Who: MEERA (Image 3 — <identity anchor>), on the left.
 *   Speaks: MEERA — 1 balloon; compose open background … beside her head for it.
 *   Detail: <the rest of the action>; <mood>.
 */
const panelBlock = (doc: ComicDoc, page: Page, panel: Panel, i: number, ctx: PanelBlockContext, opts: CompileOptions = {}): string => {
  const count = page.panels.length;
  const where = ctx.boxes[i] ? ` (${boxWhere(ctx.boxes, i)})` : '';
  const head = `PANEL ${panel.n} of ${count} — box ${i + 1} in the layout${ctx.guide ? ' guide' : ''}${where}.`;

  const angle = clean(panel.angle);
  const place = findPlace(doc, panel.placeId);
  const camera = `Camera: ${SHOT_TEXT[panel.shot] || SHOT_TEXT.medium}${angle ? `, ${stripEnd(angle)}` : ''}.${place ? ` Place: ${upperName(place.name)}.` : ''}`;

  const action = clean(safeText(panel.action, opts));
  const { first, rest } = splitAction(action);
  const mustShow = `Must show: ${sentence(first) || 'A quiet beat that continues the scene.'}`;

  const viewer = povViewerOf(doc, panel);
  const drawnPanel = viewer ? { ...panel, castIds: drawnCastIds(doc, panel) } : panel;
  const staged = stagePanel(page, drawnPanel).filter((s) => ctx.names.has(s.id));
  const people = staged.filter((s) => !ctx.props.has(s.id));
  const things = staged.filter((s) => ctx.props.has(s.id));
  const solo = people.length === 1 && things.length > 0;
  const describe = (id: string): string => {
    const c = doc.cast.find((x) => x.id === id)!;
    const inner = [imageWords(ctx.index.get(`c:${id}`)), ctx.anchors ? identityAnchor(c, { colors: ctx.colors }) : ''].filter(Boolean).join(' — ');
    return `${ctx.names.get(id)}${inner ? ` (${inner})` : ''}`;
  };
  const peopleText = people.map((s) => `${describe(s.id)}${s.word && !solo ? `, ${positionPhrase(s.word)}` : ''}`).join('; ');
  const viewerText = viewer
    ? `seen through ${upperName(viewer.name)}'s eyes (do not draw ${upperName(viewer.name)}; at most a hand at the frame edge)`
    : '';
  const whoBody = [peopleText || (viewerText ? '' : 'no characters'), viewerText].filter(Boolean).join('; ');
  const who = `Who: ${whoBody}.${things.length ? ` Props: ${things.map((s) => describe(s.id)).join('; ')}.` : ''}`;

  const drawn = new Set(staged.map((s) => s.id)); // a talking prop listed under Props is drawn too
  const speaks = speaksLine(doc, panel, drawn, ctx);

  const detail = detailLine(rest, clean(panel.mood) ? safeText(panel.mood!, opts) : '');

  return [head, camera, mustShow, who, speaks, detail].filter(Boolean).join('\n');
};

const speakerLabel = (doc: ComicDoc, line: Line): string => {
  const speaker = line.speakerId ? doc.cast.find((c) => c.id === line.speakerId) : undefined;
  if (line.kind === 'caption') return speaker ? `CAPTION (${upperName(speaker.name)} narrating)` : 'CAPTION';
  if (line.kind === 'sfx') return 'SFX';
  return `${speaker ? upperName(speaker.name) : 'OFF-PANEL VOICE'} (${LINE_KIND_TEXT[line.kind] || 'speech'})`;
};

/** "in UPPERCASE" / "uppercase " / "mixed-case " mean nothing for Devanagari, Telugu, Japanese… */
const stripCaseWords = (hint: string): string =>
  clean(hint.replace(/\s*\bin\s+upper-?case\b/gi, '').replace(/\b(?:upper-?case|lower-?case|mixed-?case)\s+/gi, ''));

/**
 * The no-blank-bars rule (plan §4.2; panels challenge R4): the old "leave natural empty space near the
 * top of each panel" produced flat white bars that balloons never filled — even on panels with no
 * lines. Overlay pages now ask for open BACKGROUND beside each speaker (the panel's Speaks line) and
 * forbid empty shapes. Both sentences are the plan's words verbatim (§4.2, design §3.4(d)); the white
 * gutters are asked for separately, by name, in the PAGE LAYOUT block.
 */
export const NO_BLANK_SHAPES = 'Never draw blank boxes, empty bars or white strips.';
const OVERLAY_BALLOONS =
  "Balloons are added later by software. Where a panel lists 'Speaks', compose open background (sky, wall, floor, shadow) beside the speaker's head.";

const letteringBlock = (doc: ComicDoc, page: Page): string => {
  const lettered = page.panels.filter((p) => p.lines.some((l) => clean(l.text)));
  if (doc.format.lettering !== 'in_art') {
    const base = 'LETTERING: Do not draw any text, letters, speech balloons, captions or sound effects.';
    if (!lettered.length) return `${base} This page is wordless. ${NO_BLANK_SHAPES}`;
    return `${base} ${OVERLAY_BALLOONS} ${NO_BLANK_SHAPES}`;
  }
  if (!lettered.length) return 'LETTERING: This page is wordless — draw no text, balloons, captions or sound effects anywhere.';
  const kinds = new Set<LineKind>();
  for (const p of lettered) for (const l of p.lines) if (clean(l.text)) kinds.add(l.kind);
  const preset = LETTERING_PRESETS[letterStyleOf(doc).presetId] || LETTERING_PRESETS.classic;
  const shapes = (['speech', 'thought', 'whisper', 'shout', 'caption', 'sfx'] as LineKind[])
    .filter((k) => kinds.has(k))
    .map((k) => (k === 'speech' && preset.id !== 'classic' ? NEUTRAL_SPEECH_LOOK : LETTERING_LOOK[k]));
  const lang = (clean(doc.format.language) || 'en').toLowerCase();
  const caseless = isCaselessLanguage(lang);
  // The preset's look (lettering.md §9). Scripts without letter case drop its case words.
  const hint = sentence(caseless ? stripCaseWords(preset.promptHint) : preset.promptHint);
  // Caseless scripts: one legibility sentence; the classic hint's own "Use a … font" opener merges into it.
  const legible = `Use clean, highly legible comic lettering${lang.startsWith('ja') ? ' (vertical text in balloons, as in printed manga)' : ''}`;
  const rest = hint.replace(/^Use a clean comic lettering font,?\s*/i, '');
  const font = caseless
    ? rest === hint
      ? `${legible}.${hint ? ` ${hint}` : ''}`
      : `${legible}: ${rest}`
    : hint || 'Use a clean comic lettering font in UPPERCASE.';
  const language = lang.startsWith('en') ? '' : ` Every line is in ${languageName(lang)}; letter it in that language and script.`;
  const order = doc.format.readingDirection === 'rtl' ? 'right-to-left' : 'left-to-right';
  const lines: string[] = [];
  for (const panel of lettered) {
    for (const line of panel.lines) {
      if (!clean(line.text)) continue;
      lines.push(`Panel ${panel.n} — ${speakerLabel(doc, line)}: ${quoteForPrompt(line.text)}`);
    }
  }
  return [
    `LETTERING: Letter the page like a professional comic: ${joinList(shapes)}. ${font}${language} Place balloons in ${order} reading order within each panel and never over faces. Spell every line exactly as written:`,
    ...lines,
    'No other text anywhere on the page. Never draw empty balloons, blank boxes, empty bars or white strips.'
  ].join('\n');
};

/** Legend line of the layout guide image (Image 1 when COMIC_LAYOUT_GUIDE is on; plan C9, C19). */
const LAYOUT_GUIDE_LINE = 'Panel borders: follow the PAGE LAYOUT GUIDE (Image 1) exactly — its black lines are the borders, its white bands the gutters.';

const layoutBlock = (doc: ComicDoc, page: Page, boxes: Box[] = [], guide = false): string => {
  const n = page.panels.length;
  const rtl = doc.format.readingDirection === 'rtl';
  const blueprint = effectiveLayout(page, doc.format);
  const measured = measuredLayout(doc, page, boxes);
  const guideLine = guide ? LAYOUT_GUIDE_LINE : '';
  if (doc.format.kind === 'webtoon') {
    return [
      `PAGE LAYOUT — webtoon segment, ${n} panel${n === 1 ? '' : 's'} read top to bottom:`,
      blueprint,
      measured,
      'Each panel spans the full width of the image; separate panels with generous vertical white space. No page border grid, no side-by-side panels.',
      guideLine
    ]
      .filter(Boolean)
      .join('\n');
  }
  const order = rtl ? 'right-to-left, top-to-bottom (manga order: panel 1 is at the top right)' : 'left-to-right, top-to-bottom';
  return [
    n === 1 ? 'PAGE LAYOUT — a single full-page panel:' : `PAGE LAYOUT — ${n} panels, read ${order}:`,
    blueprint,
    measured,
    n === 1
      ? 'One clean black border around the art.'
      : 'Clean white gutters between panels, crisp black panel borders, no panel overlaps unless stated.',
    guideLine
  ]
    .filter(Boolean)
    .join('\n');
};

/** "(Image 2)" / "(Images 1 and 2)" for a cast or place line; undefined when nothing is attached. */
const imageTag = (indexes?: number[]): string | undefined => {
  const words = imageWords(indexes);
  return words ? `(${words})` : undefined;
};

/** Attachment indexes (1-based) per character / place, in legend order. */
const indexReferences = (refs: PlannedReference[]): Map<string, number[]> => {
  const index = new Map<string, number[]>();
  const add = (key: string, i: number) => index.set(key, [...(index.get(key) || []), i]);
  refs.forEach((r, i) => {
    if (r.characterId) add(`c:${r.characterId}`, i + 1);
    if (r.placeId) add(`p:${r.placeId}`, i + 1);
  });
  return index;
};

/**
 * CAST (+ PROPS) lock for the page: every being stated once with its look; groups as
 * "DUCKLINGS ×3"; recurring props in their own list; anyone without an attached image is
 * text-locked "(no reference — follow this description exactly)".
 */
const castBlocks = (cast: Character[], names: Map<string, string>, index: Map<string, number[]>, bw: boolean): string[] => {
  const line = (c: Character) =>
    `- ${names.get(c.id)} ${imageTag(index.get(`c:${c.id}`)) || '(no reference — follow this description exactly)'}: ${describeLook(c, { colors: !bw })}`;
  const beings = cast.filter((c) => !isProp(c));
  const props = cast.filter(isProp);
  const nonHuman = beings.some((c) => castKindOf(c) !== 'person');
  const group = beings.some((c) => groupSize(c) > 1);
  const head =
    nonHuman || group
      ? `CAST ON THIS PAGE — keep every identity distinct; never merge, swap or duplicate characters${
          group ? ' (a group "×N" is exactly N look-alike members, no more and no fewer)' : ''
        }. Each keeps the same look, markings and colors in every panel:`
      : 'CAST ON THIS PAGE — keep every identity distinct; never merge, swap or duplicate people. Each keeps the same face, hair, outfit and colors in every panel:';
  return [
    beings.length ? [head, ...beings.map(line)].join('\n') : '',
    props.length ? ['PROPS — the same object, colors and details every time it appears:', ...props.map(line)].join('\n') : ''
  ];
};

/**
 * Character budget for a page prompt (plan C18: 9,000 with a fixed drop order). Ship 1's only
 * droppable text is the identity anchors restated in each panel's Who line (the CAST block keeps
 * every full look), so a crowded page drops those first and never loses a panel or a rule.
 */
export const PAGE_PROMPT_CHAR_BUDGET = 9000;

/** Compile the image job for one comic page (one image containing every panel). */
export const compilePage = (doc: ComicDoc, page: Page, opts: { previousPage?: Page } & PageCompileOptions = {}): CompiledRenderJob => {
  if (!page.panels.length) throw new StudioError('BAD_REQUEST', `Page ${page.n} has no panels to draw yet.`, { status: 400 });
  const resolved = resolveJob(doc, 'page');
  const { spec } = resolved;
  const aspect = pageAspectFor(doc, spec, page.panels.length);
  const rating = artRatingFor(doc, opts);
  const refs = planPageReferences(doc, page, spec, opts.previousPage, opts);
  const index = indexReferences(refs);
  const guide = refs.some((r) => r.kind === 'layout');
  const boxes = pageLayoutBoxes(doc, page);

  const cast = rankPageCast(doc, page);
  const names = new Map(cast.map((c) => [c.id, castLabel(c)]));
  const props = new Set(cast.filter(isProp).map((c) => c.id));
  const bw = doc.format.colorMode === 'bw';
  const header =
    `Create one finished comic page as a single image: ${withArticle(KIND_TEXT[doc.format.kind] || 'comic book')} page, ` +
    `${colorSentence(doc)}. It must look like a professionally drawn and ${bw ? 'inked' : 'colored'} published page.\n` +
    frameSentence(aspect, 'page');

  const placeIds = [...new Set(page.panels.map((p) => p.placeId).filter((id): id is string => !!id))];
  const placeLines = placeIds
    .map((id) => findPlace(doc, id))
    .filter((p): p is Place => !!p && (!!clean(p.look) || index.has(`p:${p.id}`)))
    .map((p) => {
      const tag = imageTag(index.get(`p:${p.id}`));
      return `- ${upperName(p.name)}${tag ? ` ${tag}` : ''}${clean(p.look) ? `: ${sentence(p.look)}` : ''}`;
    });
  const placeBlock = placeLines.length ? ['LOCATIONS:', ...placeLines].join('\n') : '';

  const footer = cast.length
    ? "Only the characters named in a panel's Who line appear in it (unnamed background figures only where the action mentions them)."
    : '';

  const build = (anchors: boolean): string => {
    const ctx: PanelBlockContext = { names, props, index, boxes, guide, anchors, colors: !bw };
    const panelsBlock = ['PANELS:', ...page.panels.map((panel, i) => panelBlock(doc, page, panel, i, ctx, opts))].join('\n');
    return [
      header,
      `ART STYLE — apply identically in every panel:\n${styleParagraph(doc, { rating })}`,
      contentParagraph(doc, opts),
      referenceLegend(refs),
      ...castBlocks(cast, names, index, bw),
      placeBlock,
      layoutBlock(doc, page, boxes, guide),
      panelsBlock,
      letteringBlock(doc, page),
      footer
    ]
      .filter(Boolean)
      .join('\n\n');
  };
  const full = build(true);
  const prompt = full.length > PAGE_PROMPT_CHAR_BUDGET ? build(false) : full;

  return finishJob(resolved, aspect, prompt, refs);
};

// ── Character sheet (§6.3) ───────────────────────────────────────────────────

const AUTHOR_REF_INSTRUCTION = "Match face, hair and features; redraw in the art style below (not the photo's lighting, realism or background).";

/** Model sheet (turnaround + expressions) — the identity anchor for every page. */
export const compileCharacterSheet = (doc: ComicDoc, character: Character, opts: CompileOptions = {}): CompiledRenderJob => {
  const resolved = resolveJob(doc, 'sheet');
  const { spec } = resolved;
  const aspect = nearestAspect(spec, '3:2');
  const name = upperName(character.name);
  const look = character.look || { summary: '' };
  const bw = doc.format.colorMode === 'bw';
  const rating = artRatingFor(doc, opts);
  const kind = castKindOf(character);
  const n = groupSize(character);
  const budget = { total: Math.max(0, spec.refs.total), objects: Math.max(0, spec.refs.objects) };

  const refs: PlannedReference[] = [];
  const authorCap = Math.min(
    REF_LIMITS.sheetAuthorRefs,
    spec.refs.characters > 0 ? spec.refs.characters : budget.objects,
    Math.max(0, budget.total - (servable(doc.style.board) ? 1 : 0))
  );
  // Ranked, diverse author photos (refs.md §5.2) — the same pick sheetRefs() reports to the UI.
  pickRefs(character.refs, Math.max(0, authorCap), 'sheet').forEach((r, k) => {
    refs.push({
      kind: 'author',
      slot: spec.refs.characters > 0 ? 'character' : 'object',
      label: `AUTHOR REFERENCE ${k + 1} FOR ${name}${refDetail(r)}`,
      path: r.path,
      instruction: AUTHOR_REF_INSTRUCTION,
      characterId: character.id,
      userRef: true
    });
  });
  const authorPaths = refs.map((r) => r.path);
  budget.total -= refs.length;
  if (spec.refs.characters <= 0) budget.objects -= refs.length;
  refs.push(...styleReferences(doc, spec, budget, { effectiveRating: rating }));

  const kids = isKidsAudience(doc);
  const expressions = kids ? 'neutral, smiling, surprised' : 'neutral, smiling, angry';
  const summaryText = clean(look.summary);
  const build = stripEnd(clean(look.build));
  const species = clean(look.species);
  const idParts = [
    identityPhrase(look.age, look.gender, summaryText),
    build && !summaryText.toLowerCase().includes(build.toLowerCase()) ? build : ''
  ]
    .filter(Boolean)
    .join(', ');
  const field = (label: string, value?: string) => (clean(value) ? `${label}: ${sentence(value)}` : '');
  const summary = sentence(look.summary);
  const kindLine =
    kind !== 'person' && kind !== 'object' && KIND_WORD[kind] && !species && !summaryText.toLowerCase().includes(KIND_WORD[kind]) ? `Kind: ${KIND_WORD[kind]}.` : '';
  const description = [
    summary,
    idParts ? `Identity: ${idParts}.` : '',
    field('Species', look.species),
    kindLine,
    field('Face', look.face),
    field('Hair', look.hair),
    field('Eyes', look.eyes),
    field('Skin', look.skin),
    field('Outfit', look.outfit),
    bw ? '' : field('Colors', look.palette),
    field('Props', look.props),
    field('Markings (must never change)', look.markings),
    field('Distinguishing marks (must always show)', look.marks)
  ]
    .filter(Boolean)
    .join(' ');
  const personality = clean(character.personality) ? `Let the expressions show the personality: ${sentence(clip(character.personality!, 140))}` : '';
  const propSheet = kind === 'object' || kind === 'vehicle';
  const tone = `Even studio lighting, clean edges${bw ? ', black and white with grey tones only' : ''}.`;
  const opening = propSheet
    ? `Prop model sheet for a comic, one image on a plain light-grey background, no text, no labels: ${name}. ` +
      `Left to right: front view, three-quarter view, side view — identical design in each. Bottom-right: two close-ups of its key details. ${tone}`
    : `Character model sheet for a comic, one image on a plain light-grey background, no text, no labels: ${name}. ` +
      `Left to right: full-body front view, full-body three-quarter view, full-body side profile — same ${kind === 'person' ? 'outfit' : 'design'} in each. ` +
      `Bottom-right: three head close-ups (${expressions}). ${tone}`;
  const group = n > 1 ? `${name} is a group of ${n} look-alike members: draw ONE member — the exact design all ${n} share.` : '';
  const combine = authorPaths.length > 1 ? 'Different photos show the same individual from different angles; combine them into ONE consistent design.' : '';

  const prompt = [
    opening,
    group,
    description || `No description given — design one clear, memorable look for ${name} that fits the story (${clean(doc.brief.genre) || 'comic'}).`,
    personality,
    `Art style: ${styleParagraph(doc, { avoid: true, rating })}`,
    contentParagraph(doc, opts),
    combine,
    referenceLegend(refs)
  ]
    .filter(Boolean)
    .join('\n');

  // refPaths = this character's photos only: sheetRefsChanged compares them with sheetRefs().
  return { ...finishJob(resolved, aspect, prompt, refs), refPaths: authorPaths };
};

// ── Place sheet ──────────────────────────────────────────────────────────────

/** Environment concept sheet: a wide establishing view + two detail vignettes, no people. */
export const compilePlaceSheet = (doc: ComicDoc, place: Place, opts: CompileOptions = {}): CompiledRenderJob => {
  const resolved = resolveJob(doc, 'place');
  const { spec } = resolved;
  const aspect = nearestAspect(spec, '3:2');
  const name = upperName(place.name);
  const rating = artRatingFor(doc, opts);
  const budget = { total: Math.max(0, spec.refs.total), objects: Math.max(0, spec.refs.objects) };
  const refs: PlannedReference[] = [];
  const photoCap = Math.min(3, budget.objects, Math.max(0, budget.total - (servable(doc.style.board) ? 1 : 0)));
  pickRefs(place.refs, Math.max(0, photoCap), 'place_sheet', { effectiveRating: rating }).forEach((r, k) => {
    refs.push({
      kind: 'place',
      slot: 'object',
      label: `LOCATION PHOTO ${k + 1}: ${name}${refDetail(r)}`,
      path: r.path,
      instruction: 'Match its architecture, layout, props and materials; redraw it in the art style below.',
      placeId: place.id,
      userRef: true
    });
  });
  budget.total -= refs.length;
  budget.objects -= refs.length;
  refs.push(...styleReferences(doc, spec, budget, { effectiveRating: rating }));

  const setting = clean(doc.brief.setting);
  const prompt = [
    `Environment concept sheet for a comic, one image, no people, no text, no labels: ${name}. ` +
      'Top two-thirds: a wide establishing view of the whole location. Bottom third: two detail vignettes side by side ' +
      'showing its key props and textures. Same time of day and lighting in all three views, clean separations between them' +
      `${doc.format.colorMode === 'bw' ? ', black and white with grey tones only' : ''}.`,
    sentence(place.look) || `A location that fits the story${setting ? ` (${setting})` : ''}.`,
    `Art style: ${styleParagraph(doc, { rating })}`,
    contentParagraph(doc, opts),
    referenceLegend(refs)
  ]
    .filter(Boolean)
    .join('\n');

  return finishJob(resolved, aspect, prompt, refs);
};

// ── Style option (§6.4) ──────────────────────────────────────────────────────

/** Strip comic-script scaffolding (PAGE/PANEL headers, sluglines, NAME: prefixes) to find prose. */
const firstStorySentences = (script: string, max: number): string => {
  const lines = script
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(page|panel)\s+\w+/i.test(l) && !/^(int|ext)\.?\s/i.test(l) && !/^[A-Z][A-Z .'-]{1,30}:?$/.test(l))
    .map((l) => l.replace(/^[A-Z][A-Z .'-]{1,30}:\s*/, '').replace(/^#+\s*/, ''));
  const text = clean(lines.join(' '));
  if (!text) return '';
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  let out = '';
  for (const s of sentences) {
    if ((out + s).length > max) break;
    out += s;
  }
  return clip(out || sentences[0], max);
};

/** The story moment a style test (or a cover without direction) should depict. */
export const keyMoment = (doc: ComicDoc): string => {
  const fromBrief = clean(doc.brief.logline) || clean(doc.brief.premise);
  if (fromBrief) return stripEnd(clip(fromBrief, 260));
  const fromSource = doc.source.script ? firstStorySentences(doc.source.script, 260) : '';
  if (fromSource) return stripEnd(fromSource);
  const genre = clean(doc.brief.genre);
  return `a defining moment from ${genre ? `a ${genre} story` : 'the story'} called ${quoteForPrompt(doc.brief.title || 'Untitled')}`;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word, case-insensitive mention of a name in free text. */
const mentions = (text: string, name: string): boolean => {
  const n = clean(name);
  if (!n || !text) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(n)}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
};

const leadCharacter = (doc: ComicDoc): Character | undefined => doc.cast.find((c) => c.tier === 'lead') || doc.cast[0];

/** A single key-moment illustration in a candidate style (cheap swatch; NB 2.1 @1K, 4:5). */
export const compileStyleOption = (doc: ComicDoc, option: StyleOption, opts: CompileOptions = {}): CompiledRenderJob => {
  const resolved = resolveJob(doc, 'style_option');
  const { spec } = resolved;
  const aspect = nearestAspect(spec, '4:5');
  const rating = artRatingFor(doc, opts);
  const budget = { total: Math.max(0, spec.refs.total), objects: Math.max(0, spec.refs.objects) };
  const refs: PlannedReference[] = pickRefs(doc.style.refs, Math.min(3, budget.objects, budget.total), 'style', { effectiveRating: rating }).map((r, k) => ({
    kind: 'style' as const,
    slot: 'object' as const,
    label: `STYLE REFERENCE ${k + 1}${styleDetail(r)}`,
    path: r.path,
    instruction: "The author's taste reference: borrow its mood and finish where it fits the style below (not its content).",
    userRef: true
  }));

  const lead = leadCharacter(doc);
  const leadSummary = lead ? stripEnd(clean(lead.look?.summary)) : '';
  const feature = lead
    ? `Feature ${castLabel(lead)}${leadSummary ? `, ${leadSummary}` : ''} (no specific likeness required).`
    : "Feature the story's main character (no specific likeness required).";
  const setting = clean(doc.brief.setting) ? ` Setting: ${sentence(doc.brief.setting)}` : '';
  const optionSpec = sentence(option.spec) || resolveStyle(doc, rating).spec;
  const kind = KIND_TEXT[doc.format.kind] || 'comic';

  const prompt = [
    `Style test for ${withArticle(kind)}: one striking, cover-quality illustration of this moment: ${sentence(safeText(keyMoment(doc), opts))} ${feature}${setting}`,
    `Rendered in this exact style: ${optionSpec}${doc.format.colorMode === 'bw' ? ' Black and white with grey tones only.' : ''}`,
    contentParagraph(doc, opts),
    `No text, no letters, no logos. Never: ${SAFETY_AVOID[rating].join(', ')}.`,
    referenceLegend(refs)
  ]
    .filter(Boolean)
    .join('\n');

  return finishJob(resolved, aspect, prompt, refs);
};

// ── Page edit (§6.5) ─────────────────────────────────────────────────────────

/**
 * An instruction edit of an existing page render. references[0] is the current page,
 * references[1] (when a region is marked) the same page with the area outlined in red —
 * its path is REGION_REFERENCE_PATH, substituted by the job runner — then the sheets of
 * the characters in the targeted panel (or page) within the remaining caps.
 */
export const compileEdit = (
  doc: ComicDoc,
  page: Page,
  args: { instruction: string; panelN?: number; hasRegion: boolean } & CompileOptions
): CompiledRenderJob => {
  const current = page.render.asset?.path;
  if (!current) throw new StudioError('BAD_REQUEST', `Page ${page.n} has no image to edit yet — render it first.`, { status: 400 });
  // Reference gate (safety.md §3.2): a blocked or quarantined take is never sent to a model, not even to fix it.
  if (!servable(page.render.asset)) {
    throw new StudioError('BAD_REQUEST', `Page ${page.n}'s current take didn't pass the content check, so it can't be edited — redraw it safer instead.`, { status: 400 });
  }
  const asked = sentence(args.instruction);
  if (!asked) throw new StudioError('BAD_REQUEST', 'Say what to change on the page.', { status: 400 });
  const instruction = sentence(safeText(asked, args)) || asked;
  const resolved = resolveJob(doc, 'edit');
  const { spec } = resolved;
  const aspect = aspectFromSize(spec, page.render.asset?.w, page.render.asset?.h) || pageAspectFor(doc, spec, page.panels.length);
  const rating = artRatingFor(doc, args);

  const refs: PlannedReference[] = [
    { kind: 'current_page', slot: 'object', label: 'CURRENT PAGE', path: current, instruction: 'The page to edit.' }
  ];
  if (args.hasRegion) {
    refs.push({
      kind: 'region',
      slot: 'object',
      label: 'SAME PAGE — AREA TO CHANGE OUTLINED IN RED',
      path: REGION_REFERENCE_PATH,
      instruction: 'Shows only where to make the change.'
    });
  }
  let total = Math.max(0, spec.refs.total) - refs.length;
  let characterSlots = Math.min(Math.max(0, spec.refs.characters), total);
  const panel = typeof args.panelN === 'number' ? page.panels.find((p) => p.n === args.panelN) : undefined;
  // Characters involved: the targeted panel's cast (or the page's), plus anyone the
  // instruction names ("add Arjun behind her") even if they aren't on the page yet.
  const named = doc.cast.filter((c) => mentions(args.instruction, c.name));
  const scope = panel ? new Set([...panel.castIds, ...named.map((c) => c.id)]) : null;
  const candidates = [...rankPageCast(doc, page), ...named.filter((c) => !page.panels.some((p) => p.castIds.includes(c.id)))];
  for (const c of candidates) {
    if (characterSlots <= 0 || total <= 0) break;
    if (scope && !scope.has(c.id)) continue;
    if (c.tier === 'extra' && isProp(c)) continue; // presence, not tier (plan C7), as on pages
    const ref = characterReference(c, { effectiveRating: rating });
    if (!ref) continue;
    refs.push({ ...ref, instruction: `Keep ${possessive(c)} identity exactly as on this ${ref.kind === 'character' ? 'sheet' : 'reference'} wherever ${upperName(c.name)} is redrawn.` });
    characterSlots -= 1;
    total -= 1;
  }

  const where = args.hasRegion
    ? `The area to change is outlined in red in Image 2${panel ? ` (in panel ${panel.n})` : ''}.`
    : panel
      ? `The change is in panel ${panel.n}, which shows: ${sentence(clip(safeText(panel.action, args), 180))}`
      : '';
  const keepLettering =
    doc.format.lettering === 'in_art' ? 'lettering' : 'the empty balloon space (the art stays free of any text)';
  const prompt = [
    `Edit Image 1, a finished comic page. Change only this: ${instruction}`,
    where,
    `Keep everything else exactly as it is: page layout, panel borders, every other panel, characters' identities and outfits, ${keepLettering}, colors and art style.` +
      `${args.hasRegion ? ' Do not add a red outline to the result.' : ''} Output the full page at the same framing.`,
    frameSentence(aspect, 'page'),
    contentParagraph(doc, args),
    referenceLegend(refs)
  ]
    .filter(Boolean)
    .join('\n');

  return finishJob(resolved, aspect, prompt, refs);
};

// ── Cover (§6.6) ─────────────────────────────────────────────────────────────

const COVER_TEXT: Record<ComicKind, string> = {
  comic: 'Comic book cover',
  manga: 'Manga volume cover',
  webtoon: 'Webtoon series cover',
  strip: 'Comic strip collection cover',
  storybook: 'Storybook cover'
};

/** Default overlay title block (contract §4.4 CoverTitleStyle.box). */
const DEFAULT_TITLE_BOX = { x: 0.06, y: 0.04, w: 0.88, h: 0.2 };

/** Where the software title will sit on a textless cover: the band the art must keep calm. */
export const coverTitleBand = (doc: ComicDoc): { side: 'top' | 'bottom'; pct: number } => {
  const raw = doc.cover.titleStyle?.box;
  const box = raw && [raw.x, raw.y, raw.w, raw.h].every((v) => typeof v === 'number' && Number.isFinite(v)) ? raw : DEFAULT_TITLE_BOX;
  const tagline = clean(doc.cover.tagline) ? 0.06 : 0;
  const bottom = box.y + box.h / 2 > 0.5;
  const extent = bottom ? 1 - box.y : box.y + box.h + tagline;
  return { side: bottom ? 'bottom' : 'top', pct: Math.round(Math.min(0.45, Math.max(0.15, extent)) * 100) };
};

/**
 * The book's art as a free consistency anchor for the cover (timeline.md §3.2): the first
 * ready, servable page — preferring one that is not out of date. A page judged above the
 * cover's rating is never the anchor (it would pull the cover over the rating too).
 */
const storyPageReference = (doc: ComicDoc, budget: { total: number; objects: number }, rating: ContentRating): PlannedReference[] => {
  if (budget.objects <= 0 || budget.total <= 0) return [];
  const ready = doc.pages
    .filter((p) => p.render.status === 'ready' && servable(p.render.asset) && safetyStatusOf(p.render.asset.safety, rating) !== 'over_rating')
    .sort((a, b) => a.n - b.n);
  const page = ready.find((p) => !isPageStale(doc, p)) || ready[0];
  if (!page?.render.asset) return [];
  budget.objects -= 1;
  budget.total -= 1;
  return [
    {
      kind: 'page_art',
      slot: 'object',
      label: 'STORY PAGE',
      path: page.render.asset.path,
      instruction: `Same characters, creatures, props and palette as this page — not its layout${doc.format.lettering === 'in_art' ? ', panels or lettering' : ' or panels'}.`
    }
  ];
};

/**
 * Cover: the title painted in the art (in_art, the default) or a TEXTLESS cover that keeps a
 * calm band for the editable overlay title (`cover.lettering === 'overlay'` or `textless`);
 * the featured cast (leads + companions, coverCastOf) as the hero image; the style anchor;
 * and, when an object slot remains, the first story page for consistency.
 */
export const compileCover = (doc: ComicDoc, opts: CompileOptions & { textless?: boolean } = {}): CompiledRenderJob => {
  const resolved = resolveJob(doc, 'cover');
  const { spec } = resolved;
  const aspect = coverAspectFor(doc, spec);
  const rating = artRatingFor(doc, opts);
  const textless = !!opts.textless || (doc.cover.lettering ?? 'in_art') === 'overlay';
  const budget = { total: Math.max(0, spec.refs.total), objects: Math.max(0, spec.refs.objects) };
  // contract §4.12: prompts take .slice(0, refs.characters); a model without character slots still names up to 4.
  const featured = coverCastOf(doc).slice(0, spec.refs.characters > 0 ? spec.refs.characters : 4);
  const characters = castReferences(featured, spec, budget, 'cover', () => ({ effectiveRating: rating }));
  const style = styleReferences(doc, spec, budget, { effectiveRating: rating });
  const refs = [...characters, ...style, ...storyPageReference(doc, budget, rating)];
  const index = indexReferences(refs);
  const bw = doc.format.colorMode === 'bw';

  const title = clean(doc.cover.title) || clean(doc.brief.title) || 'Untitled';
  const tagline = clean(doc.cover.tagline);
  const genre = clean(doc.brief.genre) || clean(doc.brief.tone) || 'the story';
  const hero = clean(doc.cover.direction)
    ? stripEnd(clean(safeText(doc.cover.direction!, opts)))
    : `an iconic, dramatic composition that sells this story — ${safeText(keyMoment(doc), opts)} —`;
  const names = featured.map((c) => {
    const tag = imageTag(index.get(`c:${c.id}`));
    return `${castLabel(c)}${tag ? ` ${tag}` : ''}`;
  });
  const featuring = names.length ? `, featuring ${joinList(names)}` : '';
  const castLines = featured.map((c) => `- ${castLabel(c)}: ${describeLook(c, { colors: !bw })}`);
  const groups = featured.some((c) => groupSize(c) > 1);
  const band = coverTitleBand(doc);

  const opening = `${COVER_TEXT[doc.format.kind] || COVER_TEXT.comic}, published-quality, ${colorSentence(doc)}. `;
  const titleLine = textless
    ? `${opening}TEXTLESS COVER: the title is added later as editable text, so keep the ${band.side} ${band.pct}% of the image calm and uncluttered ` +
      `(sky, wall, soft shadow or gradient) with faces and the key action ${band.side === 'top' ? 'below' : 'above'} it.`
    : `${opening}Title lettering at the top: ${quoteForPrompt(title)} in bold display lettering that fits the genre (${genre})` +
      `${tagline ? `; below it, a small tagline: ${quoteForPrompt(tagline)}` : ''}.`;

  const prompt = [
    `${titleLine}\n${frameSentence(aspect, 'cover')}`,
    `Hero image: ${hero}${featuring.replace(/^,/, hero.endsWith('—') ? '' : ',')}.`,
    castLines.length
      ? [`CAST — keep each identity exact and distinct${groups ? ' (a group "×N" is exactly N look-alike members)' : ''}:`, ...castLines].join('\n')
      : '',
    `Art style: ${styleParagraph(doc, { rating })}`,
    contentParagraph(doc, opts),
    textless
      ? 'No text anywhere: no title, no lettering, no logos, no signatures, no issue number.'
      : `Spell the title exactly; no other text except ${tagline ? 'the tagline and ' : ''}an optional small issue number.`,
    referenceLegend(refs)
  ]
    .filter(Boolean)
    .join('\n');

  return finishJob(resolved, aspect, prompt, refs);
};
