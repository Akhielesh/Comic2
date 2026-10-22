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
//  - One source of truth per fact: a character's look is stated once (cast block);
//    panels only name who is in them.
//  - Lettering never leaks prompt text: overlay pages are text-free with room left for
//    balloons; in-art pages letter the script's lines verbatim and nothing else.

import {
  findPlace,
  type AspectRatio,
  type Character,
  type ComicDoc,
  type ComicKind,
  type Format,
  type Line,
  type LineKind,
  type Page,
  type Panel,
  type PanelSize,
  type Place,
  type RenderState,
  type ShotType,
  type StyleOption
} from '../../../shared/comic/doc.js';
import {
  nearestAspect,
  resolveImageJob,
  type ImageJobKind,
  type ImageModelSpec,
  type ResolvedImageJob
} from '../../../shared/comic/models.js';
import { STYLE_PRESETS, getStylePreset } from '../../../shared/comic/stylePresets.js';
import { StudioError, type CompiledImageJob } from './types.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Used when the doc has no style spec (and no preset fits the format). Strong, neutral, drawable. */
export const DEFAULT_STYLE_SPEC =
  'Modern professional comic book art: confident clean inks with varied line weight, solid anatomy and ' +
  'expressive acting, clear readable staging, cel-shaded digital coloring with soft gradients and controlled ' +
  'saturation, consistent lighting within each scene, detailed but uncluttered backgrounds.';

const DEFAULT_AVOID = ['photorealism', 'muddy or blurry rendering', 'warped anatomy or extra fingers', 'watermarks or signatures'];

/** Path placeholder for the red-outlined copy of the page; the job runner substitutes the real image. */
export const REGION_REFERENCE_PATH = '__region__';

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

const SIZE_TEXT: Record<PanelSize, string> = {
  small: 'small',
  medium: 'medium',
  large: 'large',
  wide: 'wide',
  tall: 'tall',
  splash: 'splash'
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

/** How each lettering element should look when the model letters the page (in_art). */
const LETTERING_SHAPES: Record<LineKind, string> = {
  speech: 'speech balloons as white ovals with black borders and a tail pointing to the speaker',
  thought: 'thought balloons as clouds with a trail of small bubbles',
  whisper: 'whispers as dashed-outline balloons with smaller letters',
  shout: 'shouts as spiky burst balloons with bold letters',
  caption: 'captions as rectangular boxes',
  sfx: 'sound effects as bold display lettering integrated into the art'
};

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

/**
 * The style every image is drawn in: the doc's style bible, filled from its preset, else
 * a preset matching the comic kind (when its color mode fits), else DEFAULT_STYLE_SPEC.
 */
export const resolveStyle = (doc: ComicDoc): ResolvedStyle => {
  const preset = getStylePreset(doc.style.presetId);
  const kindPreset =
    !clean(doc.style.spec) && !preset
      ? STYLE_PRESETS.find((p) => p.kind === doc.format.kind && (!p.colorMode || p.colorMode === doc.format.colorMode))
      : undefined;
  const base = preset || kindPreset;
  const avoid = (doc.style.avoid?.length ? doc.style.avoid : base?.avoid || DEFAULT_AVOID).map(clean).filter(Boolean);
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

/** The ART STYLE paragraph body (spec + palette + linework + avoid list). */
const styleParagraph = (doc: ComicDoc, opts: { avoid?: boolean } = {}): string => {
  const style = resolveStyle(doc);
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
  resolveImageJob(kind, doc.settings.quality, doc.settings.imageModelOverride);

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

const usableAsset = (render?: RenderState): string | undefined =>
  render && render.status === 'ready' && render.asset?.path ? render.asset.path : undefined;

/** Possessive pronoun for legend instructions ("Match her face…"). */
const possessive = (c: Character): string => {
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
  add('build', look.build);
  add('face', look.face);
  add('hair', look.hair);
  add('eyes', look.eyes);
  add('skin', look.skin);
  add('outfit', look.outfit);
  if (opts.colors !== false) add('colors', look.palette);
  add('props', look.props);
  add('always visible', look.marks);
  if (!parts.length) return `no fixed description yet — give ${upperName(c.name)} one clear, distinctive design and keep it identical in every panel.`;
  return `${parts.join('; ')}.`;
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

// ── Layout blueprint (synthesis + parsing; shared with writer and vision) ───

export interface LayoutCell {
  /** Panel indexes (0-based, reading order) in this row/band. */
  panels: number[];
  /** Relative height weight of the row. */
  weight: number;
  /** A tall panel spanning two rows beside a stack: index into `panels` of the tall one. */
  span?: { tallSide: 'left' | 'right'; stacked: number };
}

export interface ParsedLayout {
  mode: 'rows' | 'stack' | 'single';
  rows: LayoutCell[];
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, single: 1, two: 2, pair: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9
};

const numberFrom = (token: string): number | undefined => {
  const t = token.toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  return NUMBER_WORDS[t];
};

const rangeText = (from: number, to: number) => (from === to ? `panel ${from}` : `panels ${from}–${to}`);

/**
 * Synthesize a row blueprint from panel sizes when the plan has no usable layout:
 * splash = full page (or a dominant full-width row), wide/large = a full row, tall = spans
 * two rows beside up to two stacked panels, small/medium pair up (three smalls share a row).
 * The output uses the same vocabulary the writer is asked for, so parseLayout() reads it.
 */
export const synthesizeLayout = (
  panels: Pick<Panel, 'size'>[],
  format: Pick<Format, 'kind' | 'readingDirection'>
): string => {
  const n = panels.length;
  if (!n) return '';
  const rtl = format.readingDirection === 'rtl';
  if (format.kind === 'webtoon') {
    const tall = panels.map((p, i) => (p.size === 'tall' || p.size === 'splash' || p.size === 'large' ? i + 1 : 0)).filter(Boolean);
    return `Stacked vertically: ${n} full-width panel${n === 1 ? '' : 's'} (${rangeText(1, n)}), top to bottom.${
      tall.length ? ` Panel${tall.length > 1 ? 's' : ''} ${tall.join(', ')} ${tall.length > 1 ? 'are' : 'is'} extra tall.` : ''
    }`;
  }
  if (format.kind === 'strip') {
    return `Row 1: ${n === 1 ? 'one panel' : `${n} equal panels side by side`} (${rangeText(1, n)}${rtl ? ', right to left' : ''}).`;
  }
  if (n === 1) return 'One full-page splash panel (panel 1).';
  const rows: string[] = [];
  let row = 1;
  let i = 0;
  const pairText = (count: number, from: number) =>
    `${count === 2 ? 'two equal panels' : 'three small panels'} side by side (${rangeText(from, from + count - 1)}${rtl ? ', right to left' : ''})`;
  while (i < n) {
    const size = panels[i].size;
    const next = panels[i + 1]?.size;
    const shares = (s?: PanelSize) => s === 'small' || s === 'medium';
    if (size === 'splash') {
      rows.push(`Row ${row}: one dominant splash panel across the full width, about half the page height (panel ${i + 1}).`);
      i += 1;
      row += 1;
    } else if (size === 'wide' || size === 'large') {
      rows.push(`Row ${row}: one ${size} panel across the full width (panel ${i + 1}).`);
      i += 1;
      row += 1;
    } else if (size === 'tall') {
      let stacked = 0;
      while (stacked < 2 && i + 1 + stacked < n && shares(panels[i + 1 + stacked].size)) stacked += 1;
      if (stacked === 0) {
        rows.push(`Row ${row}: one tall panel across the full width (panel ${i + 1}).`);
        i += 1;
        row += 1;
      } else {
        const tallSide = rtl ? 'right' : 'left';
        const stackSide = rtl ? 'left' : 'right';
        const stack = stacked === 1 ? `one panel on the ${stackSide} (panel ${i + 2})` : `two stacked panels on the ${stackSide} (${rangeText(i + 2, i + 1 + stacked)})`;
        rows.push(`Rows ${row}–${row + 1}: one tall panel on the ${tallSide} (panel ${i + 1}) beside ${stack}.`);
        i += 1 + stacked;
        row += 2;
      }
    } else if (size === 'small' && panels[i + 1]?.size === 'small' && panels[i + 2]?.size === 'small' && panels[i + 3]?.size !== 'small') {
      rows.push(`Row ${row}: ${pairText(3, i + 1)}.`);
      i += 3;
      row += 1;
    } else if (shares(next) && shares(size)) {
      rows.push(`Row ${row}: ${pairText(2, i + 1)}.`);
      i += 2;
      row += 1;
    } else {
      rows.push(`Row ${row}: one panel across the full width (panel ${i + 1}).`);
      i += 1;
      row += 1;
    }
  }
  return rows.join(' ');
};

const rowWeight = (text: string): number => {
  if (/\b(splash|dominant|two-thirds|most of the page)\b/i.test(text)) return 2.2;
  if (/\b(large|big|tall|half the page|half-page)\b/i.test(text)) return 1.6;
  if (/\b(small|thin|short|narrow)\b/i.test(text)) return 0.85;
  return 1;
};

const COUNT_RE = /\b(\d+|an?|one|single|two|pair|three|four|five|six|seven|eight|nine)\s+(?:of\s+)?((?:[a-z-]+\s+){0,3}?)panels?\b/gi;

/** Every "<number> [adjectives] panel(s)" phrase in a segment, in order. */
const countPhrases = (segment: string): { n: number; words: string }[] => {
  const out: { n: number; words: string }[] = [];
  const re = new RegExp(COUNT_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment))) {
    const n = numberFrom(m[1]);
    if (n) out.push({ n, words: (m[2] || '').toLowerCase() });
  }
  return out;
};

/**
 * Count panels described in one row segment ("two equal panels", "3 panels", "a wide
 * panel"). A leading plural count wins ("two panels: one small panel and one large panel"
 * is 2); otherwise singular phrases add up ("one small panel and one large panel" is 2).
 */
const countInSegment = (segment: string): number => {
  const phrases = countPhrases(segment);
  if (!phrases.length) return 0;
  if (phrases[0].n >= 2) return phrases[0].n;
  return phrases.reduce((sum, p) => sum + p.n, 0);
};

/**
 * Parse a row blueprint ("Row 1: one wide panel. Row 2: two equal panels. Rows 3–4: one
 * tall panel on the left beside two stacked panels on the right.", "Stacked vertically: 5
 * full-width panels") into rows. Returns null when it can't be read with confidence.
 */
export const parseLayout = (layout: string): ParsedLayout | null => {
  const text = clean(layout);
  if (!text) return null;
  const stack = /\bstacked vertically\b|\bvertical stack\b/i.exec(text);
  if (stack) {
    const m = /(\d+|one|two|three|four|five|six|seven|eight|nine)\s+(?:[a-z-]+\s+){0,2}panels?/i.exec(text);
    const n = m ? numberFrom(m[1]) : undefined;
    if (!n) return null;
    const tall = new Set<number>();
    const tallMatch = /panels?\s+([\d,\sand]+)\s+(?:is|are)\s+extra tall/i.exec(text);
    if (tallMatch) for (const d of tallMatch[1].match(/\d+/g) || []) tall.add(Number(d) - 1);
    return {
      mode: 'stack',
      rows: Array.from({ length: n }, (_, i) => ({ panels: [i], weight: tall.has(i) ? 1.6 : 1 }))
    };
  }
  if (/^one full-page splash panel\b|^a single full-page (splash )?panel\b|^full-page splash\b/i.test(text)) {
    return { mode: 'single', rows: [{ panels: [0], weight: 1 }] };
  }
  // Split into row segments at "Row N" / "Rows N–M"; else at sentence boundaries.
  const marked = text.split(/(?=\brows?\s*\d+)/i).map(clean).filter((s) => /\brows?\s*\d+/i.test(s));
  const segments = marked.length ? marked : text.split(/(?<=[.;])\s+|\n+/).map(clean).filter((s) => /panel/i.test(s));
  if (!segments.length) return null;
  const rows: LayoutCell[] = [];
  let next = 0;
  for (const segment of segments) {
    const spanRange = /\brows\s*(\d+)\s*(?:–|—|-|to|and)\s*(\d+)/i.exec(segment);
    const isSpan = /\btall\b/i.test(segment) && /\b(stacked|beside|next to)\b/i.test(segment);
    if (isSpan || (spanRange && /\btall\b/i.test(segment))) {
      // The stacked group is every counted phrase that isn't the tall panel itself.
      const others = countPhrases(segment.replace(/\brows?\s*\d+\s*(?:–|—|-|to|and)?\s*\d*\s*:?/i, '')).filter((p) => !/\btall\b/.test(p.words));
      const stacked = Math.min(3, others.length ? (others[0].n >= 2 ? others[0].n : others.reduce((s, p) => s + p.n, 0)) : 2);
      const sideMatch = /\btall panel\b[^.;]*?\bon the (left|right)\b/i.exec(segment) || /\bon the (left|right)\b[^.;]*?\btall panel\b/i.exec(segment);
      const tallSide = (sideMatch?.[1]?.toLowerCase() as 'left' | 'right') || 'left';
      const panels = Array.from({ length: 1 + stacked }, (_, k) => next + k);
      rows.push({ panels, weight: 2, span: { tallSide, stacked } });
      next += 1 + stacked;
      continue;
    }
    const count = countInSegment(segment.replace(/\brows?\s*\d+\s*:?/i, ''));
    if (!count) return null;
    rows.push({ panels: Array.from({ length: count }, (_, k) => next + k), weight: rowWeight(segment) });
    next += count;
  }
  return rows.length ? { mode: 'rows', rows } : null;
};

/** Number of panels a parsed layout accounts for. */
export const layoutPanelCount = (parsed: ParsedLayout | null): number =>
  parsed ? parsed.rows.reduce((n, r) => n + r.panels.length, 0) : 0;

const FULL_WIDTH_SIZES = new Set<PanelSize>(['wide', 'large', 'splash']);

/** True when a panel's size contradicts its row (a wide/large/splash panel sharing a row). */
export const layoutConflicts = (parsed: ParsedLayout, panels: Pick<Panel, 'size'>[]): boolean =>
  parsed.mode === 'rows' &&
  parsed.rows.some((r) => !r.span && r.panels.length > 1 && r.panels.some((i) => FULL_WIDTH_SIZES.has(panels[i]?.size)));

/** Index (into the page's panels) of the tall panel of a span row, by reading order. */
const tallIndexOf = (row: LayoutCell, rtl: boolean): number => {
  const startSide = rtl ? 'right' : 'left';
  return row.span?.tallSide === startSide ? row.panels[0] : row.panels[1] ?? row.panels[0];
};

/**
 * Make panel sizes agree with a parsed blueprint (the writer's layout is the page's
 * design): full-width single rows are "wide" (unless large/splash/tall), shared rows never
 * hold wide/large/splash panels, a span row's tall panel is "tall", a single-panel page is
 * a "splash". Returns new panel objects; unchanged sizes are kept.
 */
export const harmonizePanelSizes = <P extends Pick<Panel, 'size'>>(panels: P[], parsed: ParsedLayout, rtl = false): P[] => {
  const out = panels.map((p) => ({ ...p }));
  const set = (i: number, size: PanelSize) => {
    if (out[i]) out[i].size = size;
  };
  if (parsed.mode === 'single') {
    set(0, 'splash');
    return out;
  }
  if (parsed.mode === 'stack') return out;
  for (const row of parsed.rows) {
    if (row.span) {
      const tall = tallIndexOf(row, rtl);
      for (const i of row.panels) {
        if (i === tall) set(i, 'tall');
        else if (out[i] && out[i].size !== 'small' && out[i].size !== 'medium') set(i, 'medium');
      }
    } else if (row.panels.length > 1) {
      for (const i of row.panels) if (out[i] && FULL_WIDTH_SIZES.has(out[i].size)) set(i, 'medium');
    } else {
      const i = row.panels[0];
      if (out[i] && (out[i].size === 'small' || out[i].size === 'medium')) set(i, 'wide');
    }
  }
  return out;
};

/**
 * The page's layout when it matches its panels (count, format and sizes), else a
 * blueprint synthesized from the panel sizes — so the prompt never describes a layout
 * that contradicts its own panel list.
 */
export const effectiveLayout = (page: Page, format: Pick<Format, 'kind' | 'readingDirection'>): string => {
  const layout = clean(page.layout);
  const parsed = layout ? parseLayout(layout) : null;
  // Webtoon segments must be a vertical stack; a row grid would contradict the format.
  const fits = parsed && (format.kind !== 'webtoon' || parsed.mode === 'stack');
  if (fits && layoutPanelCount(parsed) === page.panels.length && !layoutConflicts(parsed, page.panels)) return layout;
  return synthesizeLayout(page.panels, format);
};

// ── References ───────────────────────────────────────────────────────────────

export type ReferenceKind = 'character' | 'place' | 'style' | 'previous_page' | 'current_page' | 'region' | 'author';

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
}

const STYLE_BOARD_INSTRUCTION = 'Match its rendering style, line quality and color treatment (not its content).';

/** Legend lines ("Image 1 — LABEL. instruction") in attachment order. */
export const referenceLegend = (refs: { label: string; instruction?: string }[]): string =>
  refs.length
    ? [
        'REFERENCE IMAGES (in the order attached):',
        ...refs.map((r, i) => `Image ${i + 1} — ${r.label}.${r.instruction ? ` ${r.instruction}` : ''}`)
      ].join('\n')
    : '';

const characterReference = (c: Character): PlannedReference | undefined => {
  const pos = possessive(c);
  const sheet = usableAsset(c.sheet);
  if (sheet) {
    const features = hasFacialHair(c) ? 'face, facial hair, hairstyle' : 'face, hairstyle';
    return {
      kind: 'character',
      slot: 'character',
      label: `CHARACTER SHEET: ${upperName(c.name)}`,
      path: sheet,
      instruction: `Match ${pos} ${features}, body type, outfit and colors exactly.`,
      characterId: c.id
    };
  }
  const upload = c.refs.find((r) => r?.path);
  if (upload) {
    const obj = pos === 'her' ? 'her' : pos === 'his' ? 'him' : 'them';
    return {
      kind: 'author',
      slot: 'character',
      label: `CHARACTER REFERENCE: ${upperName(c.name)}`,
      path: upload.path,
      instruction: `Match ${pos} face, hair and features; draw ${obj} in this page's art style.`,
      characterId: c.id
    };
  }
  return undefined;
};

const placeReference = (p: Place): PlannedReference | undefined => {
  const path = usableAsset(p.sheet) || p.refs.find((r) => r?.path)?.path;
  if (!path) return undefined;
  return {
    kind: 'place',
    slot: 'object',
    label: `LOCATION: ${upperName(p.name)}`,
    path,
    instruction: 'Match architecture, props and palette.',
    placeId: p.id
  };
};

/**
 * Style anchors within caps. Models with a distinct style class (Pro) get the board plus
 * up to 2 user style refs as STYLE refs; others get the board (or, without one, the first
 * user style ref) as a single OBJECT ref.
 */
const styleReferences = (doc: ComicDoc, spec: ImageModelSpec, budget: { total: number; objects: number }): PlannedReference[] => {
  const out: PlannedReference[] = [];
  const board = doc.style.board?.path;
  const userRefs = doc.style.refs.filter((r) => r?.path);
  if (spec.refs.style > 0) {
    const max = Math.min(spec.refs.style, 3, budget.total);
    if (board && out.length < max) out.push({ kind: 'style', slot: 'style', label: 'STYLE BOARD', path: board, instruction: STYLE_BOARD_INSTRUCTION });
    for (const ref of userRefs.slice(0, 2)) {
      if (out.length >= max) break;
      out.push({
        kind: 'style',
        slot: 'style',
        label: `STYLE REFERENCE ${out.filter((r) => r.label.startsWith('STYLE REFERENCE')).length + 1}`,
        path: ref.path,
        instruction: 'Match its rendering style and color treatment only (not its content).'
      });
    }
    budget.total -= out.length;
    return out;
  }
  if (budget.objects <= 0 || budget.total <= 0) return out;
  if (board) out.push({ kind: 'style', slot: 'object', label: 'STYLE BOARD', path: board, instruction: STYLE_BOARD_INSTRUCTION });
  else if (userRefs[0])
    out.push({
      kind: 'style',
      slot: 'object',
      label: 'STYLE REFERENCE 1',
      path: userRefs[0].path,
      instruction: 'Match its rendering style and color treatment only (not its content).'
    });
  budget.objects -= out.length;
  budget.total -= out.length;
  return out;
};

/**
 * Reference images for a page render, ordered exactly as they must be attached:
 * characters → locations → style → previous page.
 *
 * Budget priority (when caps bind): characters (≤ refs.characters, the page's lead/support
 * cast ranked by panel appearances; extras and overflow are text-locked only), then the
 * style anchor, then location sheets by how many panels use them, then the previous page
 * for continuity — all within refs.objects and refs.total.
 */
export const planPageReferences = (doc: ComicDoc, page: Page, spec: ImageModelSpec, previousPage?: Page): PlannedReference[] => {
  const budget = { total: Math.max(0, spec.refs.total), objects: Math.max(0, spec.refs.objects) };
  const characters: PlannedReference[] = [];
  let characterSlots = Math.min(Math.max(0, spec.refs.characters), budget.total);
  for (const c of rankPageCast(doc, page)) {
    if (characterSlots <= 0) break;
    if (c.tier === 'extra') continue;
    const ref = characterReference(c);
    if (!ref) continue;
    characters.push(ref);
    characterSlots -= 1;
    budget.total -= 1;
  }

  const style = styleReferences(doc, spec, budget);

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
    const ref = place && placeReference(place);
    if (!ref) continue;
    places.push(ref);
    budget.objects -= 1;
    budget.total -= 1;
  }

  const previous: PlannedReference[] = [];
  const prevPath =
    previousPage && previousPage.id !== page.id && (previousPage.render.status === 'ready' || previousPage.render.status === 'stale')
      ? previousPage.render.asset?.path
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

  return [...characters, ...places, ...style, ...previous];
};

const toJobReferences = (refs: PlannedReference[]) => refs.map((r) => ({ label: r.label, path: r.path }));

// ── Page ─────────────────────────────────────────────────────────────────────

const panelLine = (doc: ComicDoc, page: Page, panel: Panel, names: Map<string, string>): string => {
  const angle = clean(panel.angle);
  const head = `Panel ${panel.n} — ${SIZE_TEXT[panel.size] || 'medium'}, ${SHOT_TEXT[panel.shot] || SHOT_TEXT.medium}${angle ? `, ${angle}` : ''}.`;
  const place = findPlace(doc, panel.placeId);
  const action = sentence(panel.action) || 'A quiet beat that continues the scene.';
  const staged = stagePanel(page, panel).filter((s) => names.has(s.id));
  const who = staged.length
    ? `Characters: ${staged.map((s) => (s.word ? `${names.get(s.id)} (${s.word})` : names.get(s.id))).join(', ')}.`
    : 'No characters.';
  const mood = clean(panel.mood) ? ` Mood: ${sentence(panel.mood)}` : '';
  return `${head} ${place ? `${upperName(place.name)}: ` : ''}${action} ${who}${mood}`;
};

const speakerLabel = (doc: ComicDoc, line: Line): string => {
  const speaker = line.speakerId ? doc.cast.find((c) => c.id === line.speakerId) : undefined;
  if (line.kind === 'caption') return speaker ? `CAPTION (${upperName(speaker.name)} narrating)` : 'CAPTION';
  if (line.kind === 'sfx') return 'SFX';
  return `${speaker ? upperName(speaker.name) : 'OFF-PANEL VOICE'} (${LINE_KIND_TEXT[line.kind] || 'speech'})`;
};

const letteringBlock = (doc: ComicDoc, page: Page): string => {
  const lettered = page.panels.filter((p) => p.lines.some((l) => clean(l.text)));
  if (doc.format.lettering !== 'in_art') {
    const base = 'LETTERING: Do not draw any text, letters, speech balloons, captions or sound effects.';
    if (!lettered.length) return `${base} This page is wordless.`;
    const which = lettered.length === page.panels.length ? 'each panel' : `panel${lettered.length > 1 ? 's' : ''} ${joinList(lettered.map((p) => String(p.n)))}`;
    return `${base} Leave natural empty space near the top of ${which} for balloons that will be added later; keep faces and key action out of that space.`;
  }
  if (!lettered.length) return 'LETTERING: This page is wordless — draw no text, balloons, captions or sound effects anywhere.';
  const kinds = new Set<LineKind>();
  for (const p of lettered) for (const l of p.lines) if (clean(l.text)) kinds.add(l.kind);
  const shapes = (['speech', 'thought', 'whisper', 'shout', 'caption', 'sfx'] as LineKind[]).filter((k) => kinds.has(k)).map((k) => LETTERING_SHAPES[k]);
  const lang = (clean(doc.format.language) || 'en').toLowerCase();
  const caseless = isCaselessLanguage(lang);
  const font = caseless
    ? `Use clean, highly legible comic lettering${lang.startsWith('ja') ? ' (vertical text in balloons, as in printed manga)' : ''}.`
    : 'Use a clean comic lettering font in UPPERCASE.';
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
    'No other text anywhere on the page.'
  ].join('\n');
};

const layoutBlock = (doc: ComicDoc, page: Page): string => {
  const n = page.panels.length;
  const rtl = doc.format.readingDirection === 'rtl';
  const blueprint = effectiveLayout(page, doc.format);
  if (doc.format.kind === 'webtoon') {
    return [
      `PAGE LAYOUT — webtoon segment, ${n} panel${n === 1 ? '' : 's'} read top to bottom:`,
      blueprint,
      'Each panel spans the full width of the image; separate panels with generous vertical white space. No page border grid, no side-by-side panels.'
    ].join('\n');
  }
  const order = rtl ? 'right-to-left, top-to-bottom (manga order: panel 1 is at the top right)' : 'left-to-right, top-to-bottom';
  return [
    n === 1 ? 'PAGE LAYOUT — a single full-page panel:' : `PAGE LAYOUT — ${n} panels, read ${order}:`,
    blueprint,
    n === 1
      ? 'One clean black border around the art.'
      : 'Clean white gutters between panels, crisp black panel borders, no panel overlaps unless stated.'
  ].join('\n');
};

/** Compile the image job for one comic page (one image containing every panel). */
export const compilePage = (doc: ComicDoc, page: Page, opts: { previousPage?: Page } = {}): CompiledImageJob => {
  if (!page.panels.length) throw new StudioError('BAD_REQUEST', `Page ${page.n} has no panels to draw yet.`, { status: 400 });
  const { spec, resolution } = resolveJob(doc, 'page');
  const aspect = pageAspectFor(doc, spec, page.panels.length);
  const refs = planPageReferences(doc, page, spec, opts.previousPage);
  const imageIndex = new Map<string, number>();
  refs.forEach((r, i) => {
    if (r.characterId) imageIndex.set(`c:${r.characterId}`, i + 1);
    if (r.placeId) imageIndex.set(`p:${r.placeId}`, i + 1);
  });

  const cast = rankPageCast(doc, page);
  const names = new Map(cast.map((c) => [c.id, upperName(c.name)]));
  const bw = doc.format.colorMode === 'bw';
  const header =
    `Create one finished comic page as a single image: a ${KIND_TEXT[doc.format.kind] || 'comic book'} page, ` +
    `${aspect} ${orientationOf(aspect)}, ${colorSentence(doc)}. It must look like a professionally drawn and ` +
    `${bw ? 'inked' : 'colored'} published page.`;

  const castBlock = cast.length
    ? [
        'CAST ON THIS PAGE — keep every identity distinct; never merge, swap or duplicate people. Each keeps the same face, hair, outfit and colors in every panel:',
        ...cast.map((c) => {
          const idx = imageIndex.get(`c:${c.id}`);
          return `- ${names.get(c.id)} ${idx ? `(Image ${idx})` : '(no reference — follow this description exactly)'}: ${describeLook(c, { colors: !bw })}`;
        })
      ].join('\n')
    : '';

  const placeIds = [...new Set(page.panels.map((p) => p.placeId).filter((id): id is string => !!id))];
  const placeLines = placeIds
    .map((id) => findPlace(doc, id))
    .filter((p): p is Place => !!p && (!!clean(p.look) || imageIndex.has(`p:${p.id}`)))
    .map((p) => {
      const idx = imageIndex.get(`p:${p.id}`);
      return `- ${upperName(p.name)}${idx ? ` (Image ${idx})` : ''}${clean(p.look) ? `: ${sentence(p.look)}` : ''}`;
    });
  const placeBlock = placeLines.length ? ['LOCATIONS:', ...placeLines].join('\n') : '';

  const panelsBlock = ['PANELS:', ...page.panels.map((panel) => panelLine(doc, page, panel, names))].join('\n');
  const footer = cast.length
    ? 'Only the characters listed for a panel appear in it (unnamed background figures only where the action mentions them).'
    : '';

  const prompt = [
    header,
    `ART STYLE — apply identically in every panel:\n${styleParagraph(doc)}`,
    referenceLegend(refs),
    castBlock,
    placeBlock,
    layoutBlock(doc, page),
    panelsBlock,
    letteringBlock(doc, page),
    footer
  ]
    .filter(Boolean)
    .join('\n\n');

  return { spec, resolution, aspect, prompt, references: toJobReferences(refs) };
};

// ── Character sheet (§6.3) ───────────────────────────────────────────────────

const AUTHOR_REF_LIMIT = 3;

/** Model sheet (turnaround + expressions) — the identity anchor for every page. */
export const compileCharacterSheet = (doc: ComicDoc, character: Character): CompiledImageJob => {
  const { spec, resolution } = resolveJob(doc, 'sheet');
  const aspect = nearestAspect(spec, '3:2');
  const name = upperName(character.name);
  const look = character.look || { summary: '' };
  const bw = doc.format.colorMode === 'bw';
  const budget = { total: Math.max(0, spec.refs.total), objects: Math.max(0, spec.refs.objects) };

  const refs: PlannedReference[] = [];
  const authorCap = Math.min(
    AUTHOR_REF_LIMIT,
    spec.refs.characters > 0 ? spec.refs.characters : budget.objects,
    Math.max(0, budget.total - (doc.style.board ? 1 : 0))
  );
  character.refs
    .filter((r) => r?.path)
    .slice(0, Math.max(0, authorCap))
    .forEach((r, k) => {
      refs.push({
        kind: 'author',
        slot: spec.refs.characters > 0 ? 'character' : 'object',
        label: `AUTHOR REFERENCE ${k + 1} FOR ${name}`,
        path: r.path,
        instruction: "Match face, hair and features; redraw in the art style below (not the photo's lighting, realism or background).",
        characterId: character.id
      });
    });
  budget.total -= refs.length;
  if (spec.refs.characters <= 0) budget.objects -= refs.length;
  refs.push(...styleReferences(doc, spec, budget));

  const kids = doc.format.kind === 'storybook' || /\b(kid|kids|child|children|toddler|preschool|young readers)\b/i.test(doc.brief.audience || '');
  const expressions = kids ? 'neutral, smiling, surprised' : 'neutral, smiling, angry';
  const summaryText = clean(look.summary);
  const build = stripEnd(clean(look.build));
  const idParts = [
    identityPhrase(look.age, look.gender, summaryText),
    build && !summaryText.toLowerCase().includes(build.toLowerCase()) ? build : ''
  ]
    .filter(Boolean)
    .join(', ');
  const field = (label: string, value?: string) => (clean(value) ? `${label}: ${sentence(value)}` : '');
  const summary = sentence(look.summary);
  const description = [
    summary,
    idParts ? `Identity: ${idParts}.` : '',
    field('Face', look.face),
    field('Hair', look.hair),
    field('Eyes', look.eyes),
    field('Skin', look.skin),
    field('Outfit', look.outfit),
    bw ? '' : field('Colors', look.palette),
    field('Props', look.props),
    field('Distinguishing marks (must always show)', look.marks)
  ]
    .filter(Boolean)
    .join(' ');
  const personality = clean(character.personality) ? `Let the expressions show the personality: ${sentence(clip(character.personality!, 140))}` : '';

  const prompt = [
    `Character model sheet for a comic, one image on a plain light-grey background, no text, no labels: ${name}. ` +
      'Left to right: full-body front view, full-body three-quarter view, full-body side profile — same outfit in each. ' +
      `Bottom-right: three head close-ups (${expressions}). Even studio lighting, clean edges${bw ? ', black and white with grey tones only' : ''}.`,
    description || `No description given — design one clear, memorable look for ${name} that fits the story (${clean(doc.brief.genre) || 'comic'}).`,
    personality,
    `Art style: ${styleParagraph(doc, { avoid: true })}`,
    referenceLegend(refs)
  ]
    .filter(Boolean)
    .join('\n');

  return { spec, resolution, aspect, prompt, references: toJobReferences(refs) };
};

// ── Place sheet ──────────────────────────────────────────────────────────────

/** Environment concept sheet: a wide establishing view + two detail vignettes, no people. */
export const compilePlaceSheet = (doc: ComicDoc, place: Place): CompiledImageJob => {
  const { spec, resolution } = resolveJob(doc, 'place');
  const aspect = nearestAspect(spec, '3:2');
  const name = upperName(place.name);
  const budget = { total: Math.max(0, spec.refs.total), objects: Math.max(0, spec.refs.objects) };
  const refs: PlannedReference[] = [];
  const photoCap = Math.min(3, budget.objects, Math.max(0, budget.total - (doc.style.board ? 1 : 0)));
  place.refs
    .filter((r) => r?.path)
    .slice(0, Math.max(0, photoCap))
    .forEach((r, k) => {
      refs.push({
        kind: 'place',
        slot: 'object',
        label: `LOCATION PHOTO ${k + 1}: ${name}`,
        path: r.path,
        instruction: 'Match its architecture, layout, props and materials; redraw it in the art style below.',
        placeId: place.id
      });
    });
  budget.total -= refs.length;
  budget.objects -= refs.length;
  refs.push(...styleReferences(doc, spec, budget));

  const setting = clean(doc.brief.setting);
  const prompt = [
    `Environment concept sheet for a comic, one image, no people, no text, no labels: ${name}. ` +
      'Top two-thirds: a wide establishing view of the whole location. Bottom third: two detail vignettes side by side ' +
      'showing its key props and textures. Same time of day and lighting in all three views, clean separations between them' +
      `${doc.format.colorMode === 'bw' ? ', black and white with grey tones only' : ''}.`,
    sentence(place.look) || `A location that fits the story${setting ? ` (${setting})` : ''}.`,
    `Art style: ${styleParagraph(doc)}`,
    referenceLegend(refs)
  ]
    .filter(Boolean)
    .join('\n');

  return { spec, resolution, aspect, prompt, references: toJobReferences(refs) };
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
export const compileStyleOption = (doc: ComicDoc, option: StyleOption): CompiledImageJob => {
  const { spec, resolution } = resolveJob(doc, 'style_option');
  const aspect = nearestAspect(spec, '4:5');
  const budget = { total: Math.max(0, spec.refs.total), objects: Math.max(0, spec.refs.objects) };
  const refs: PlannedReference[] = doc.style.refs
    .filter((r) => r?.path)
    .slice(0, Math.min(3, budget.objects, budget.total))
    .map((r, k) => ({
      kind: 'style' as const,
      slot: 'object' as const,
      label: `STYLE REFERENCE ${k + 1}`,
      path: r.path,
      instruction: "The author's taste reference: borrow its mood and finish where it fits the style below (not its content)."
    }));

  const lead = leadCharacter(doc);
  const leadSummary = lead ? stripEnd(clean(lead.look?.summary)) : '';
  const feature = lead
    ? `Feature ${upperName(lead.name)}${leadSummary ? `, ${leadSummary}` : ''} (no specific likeness required).`
    : "Feature the story's main character (no specific likeness required).";
  const setting = clean(doc.brief.setting) ? ` Setting: ${sentence(doc.brief.setting)}` : '';
  const optionSpec = sentence(option.spec) || resolveStyle(doc).spec;
  const kind = KIND_TEXT[doc.format.kind] || 'comic';

  const prompt = [
    `Style test for a ${kind}: one striking, cover-quality illustration of this moment: ${sentence(keyMoment(doc))} ${feature}${setting}`,
    `Rendered in this exact style: ${optionSpec}${doc.format.colorMode === 'bw' ? ' Black and white with grey tones only.' : ''}`,
    'No text, no letters, no logos.',
    referenceLegend(refs)
  ]
    .filter(Boolean)
    .join('\n');

  return { spec, resolution, aspect, prompt, references: toJobReferences(refs) };
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
  args: { instruction: string; panelN?: number; hasRegion: boolean }
): CompiledImageJob => {
  const current = page.render.asset?.path;
  if (!current) throw new StudioError('BAD_REQUEST', `Page ${page.n} has no image to edit yet — render it first.`, { status: 400 });
  const instruction = sentence(args.instruction);
  if (!instruction) throw new StudioError('BAD_REQUEST', 'Say what to change on the page.', { status: 400 });
  const { spec, resolution } = resolveJob(doc, 'edit');
  const aspect = aspectFromSize(spec, page.render.asset?.w, page.render.asset?.h) || pageAspectFor(doc, spec, page.panels.length);

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
    if (c.tier === 'extra') continue;
    const ref = characterReference(c);
    if (!ref) continue;
    refs.push({ ...ref, instruction: `Keep ${possessive(c)} identity exactly as on this sheet wherever ${upperName(c.name)} is redrawn.` });
    characterSlots -= 1;
    total -= 1;
  }

  const where = args.hasRegion
    ? `The area to change is outlined in red in Image 2${panel ? ` (in panel ${panel.n})` : ''}.`
    : panel
      ? `The change is in panel ${panel.n}, which shows: ${sentence(clip(panel.action, 180))}`
      : '';
  const keepLettering =
    doc.format.lettering === 'in_art' ? 'lettering' : 'the empty balloon space (the art stays free of any text)';
  const prompt = [
    `Edit Image 1, a finished comic page. Change only this: ${instruction}`,
    where,
    `Keep everything else exactly as it is: page layout, panel borders, every other panel, characters' identities and outfits, ${keepLettering}, colors and art style.` +
      `${args.hasRegion ? ' Do not add a red outline to the result.' : ''} Output the full page at the same framing.`,
    referenceLegend(refs)
  ]
    .filter(Boolean)
    .join('\n');

  return { spec, resolution, aspect, prompt, references: toJobReferences(refs) };
};

// ── Cover (§6.6) ─────────────────────────────────────────────────────────────

const COVER_TEXT: Record<ComicKind, string> = {
  comic: 'Comic book cover',
  manga: 'Manga volume cover',
  webtoon: 'Webtoon series cover',
  strip: 'Comic strip collection cover',
  storybook: 'Storybook cover'
};

/** Characters featured on the cover: leads ranked by appearances (supports if no leads). */
const coverCast = (doc: ComicDoc): Character[] => {
  const appearances = new Map<string, number>();
  for (const page of doc.pages) for (const panel of page.panels) for (const id of new Set(panel.castIds)) appearances.set(id, (appearances.get(id) || 0) + 1);
  const order = new Map(doc.cast.map((c, i) => [c.id, i]));
  const rank = (list: Character[]) =>
    list.sort((a, b) => (appearances.get(b.id) || 0) - (appearances.get(a.id) || 0) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const leads = rank(doc.cast.filter((c) => c.tier === 'lead'));
  if (leads.length) return leads.slice(0, 4);
  return rank(doc.cast.filter((c) => c.tier === 'support')).slice(0, 2);
};

/** Cover: title lettering, optional tagline, the leads as hero image, style board. */
export const compileCover = (doc: ComicDoc): CompiledImageJob => {
  const { spec, resolution } = resolveJob(doc, 'cover');
  const aspect = coverAspectFor(doc, spec);
  const budget = { total: Math.max(0, spec.refs.total), objects: Math.max(0, spec.refs.objects) };
  const featured = coverCast(doc);
  const characters: PlannedReference[] = [];
  let slots = Math.min(Math.max(0, spec.refs.characters), budget.total);
  for (const c of featured) {
    if (slots <= 0) break;
    const ref = characterReference(c);
    if (!ref) continue;
    characters.push(ref);
    slots -= 1;
    budget.total -= 1;
  }
  const refs = [...characters, ...styleReferences(doc, spec, budget)];
  const imageIndex = new Map(characters.map((r, i) => [r.characterId!, i + 1]));
  const bw = doc.format.colorMode === 'bw';

  const title = clean(doc.cover.title) || clean(doc.brief.title) || 'Untitled';
  const tagline = clean(doc.cover.tagline);
  const genre = clean(doc.brief.genre) || clean(doc.brief.tone) || 'the story';
  const hero = clean(doc.cover.direction)
    ? stripEnd(clean(doc.cover.direction))
    : `an iconic, dramatic composition that sells this story — ${keyMoment(doc)} —`;
  const names = featured.map((c) => {
    const idx = imageIndex.get(c.id);
    return `${upperName(c.name)}${idx ? ` (Image ${idx})` : ''}`;
  });
  const featuring = names.length ? `, featuring ${joinList(names)}` : '';
  const castLines = featured.map((c) => `- ${upperName(c.name)}: ${describeLook(c, { colors: !bw })}`);

  const prompt = [
    `${COVER_TEXT[doc.format.kind] || COVER_TEXT.comic}, ${aspect} ${orientationOf(aspect)}, published-quality, ${colorSentence(doc)}. ` +
      `Title lettering at the top: ${quoteForPrompt(title)} in bold display lettering that fits the genre (${genre})` +
      `${tagline ? `; below it, a small tagline: ${quoteForPrompt(tagline)}` : ''}.`,
    `Hero image: ${hero}${featuring.replace(/^,/, hero.endsWith('—') ? '' : ',')}.`,
    castLines.length ? ['CAST — keep each identity exact and distinct:', ...castLines].join('\n') : '',
    `Art style: ${styleParagraph(doc)}`,
    `Spell the title exactly; no other text except ${tagline ? 'the tagline and ' : ''}an optional small issue number.`,
    referenceLegend(refs)
  ]
    .filter(Boolean)
    .join('\n');

  return { spec, resolution, aspect, prompt, references: toJobReferences(refs) };
};
