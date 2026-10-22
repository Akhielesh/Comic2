// Director tool group "lettering" (contract §12.1/§12.2, lettering.md §8). Owned by P1-LETTER-ENGINE.
//
// Tools (all FREE: deterministic software edits, no spend, no gate, no redraw):
//   set_lettering_style  whole-comic / per-kind / per-speaker defaults        → `letter_style`
//   restyle_balloons     per-balloon overrides by page/panel/kind/speaker/…   → `line_style`
//   arrange_balloons     placement: auto layout, move, nudge, resize, tails,
//                        z-order, lock, link, fit text                         → `balloon` / `balloons`
// Phase gate: overlay lettering and at least one page.
//
// Results are honest sentences: what changed (counts, pages), what was kept and why, and — when a
// target matched nothing — what actually exists ("No whisper balloons; page 1 has speech ×2, caption ×3").

import { resolveCharacter, type Balloon, type ComicDoc, type Line, type LineKind, type Page } from '../../../../shared/comic/doc.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import { FONT_REGISTRY, fontCoversLanguage } from '../../../../shared/comic/lettering/fonts.js';
import { estimateMeasure, letteringAspect, letteringSizer } from '../../../../shared/comic/lettering/layout.js';
import { fitBalloonOnPage, placeBalloonsDetailed, safeAreaBox, stagedSpeakerX } from '../../../../shared/comic/lettering/place.js';
import {
  BORDER_STYLES,
  BUBBLE_SHAPES,
  DEFAULT_LETTERING,
  DEFAULT_SAFE_MARGIN,
  FONT_IDS,
  LETTERING_PRESETS,
  LETTERING_PRESET_IDS,
  LINE_KINDS,
  NAMED_COLORS,
  SFX_EFFECTS,
  TAIL_STYLES,
  TEXT_CASES,
  normalizeColor,
  presetForComic,
  resolveLetterStyle,
  sanitizeLetterStylePatch,
  sanitizeLetteringStyleOpPatch,
  type FontId,
  type LetterStyle,
  type LetterStylePatch,
  type LetteringPresetId,
  type LetteringStyleOpPatch
} from '../../../../shared/comic/lettering/style.js';
import { panelBoxesFor } from '../../../../shared/comic/pageGeometry.js';
import { estimateWidthForText, normalizeLetteringText } from '../../../../shared/comic/textLayout.js';
import { defineTool, toolArgError, type DirectorTool, type SanitizeCtx, type ToolGroup } from '../extensions.js';
import type { DirectorTurn } from '../tools.js';
import type { StudioContext } from '../types.js';
import { LETTERING_SANITIZERS } from '../sanitize/lettering.js';

// ── Small helpers ────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const int = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : undefined;
};
const numArg = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() ? Number(v.trim().replace(/%$/, '')) / (v.trim().endsWith('%') ? 100 : 1) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const quote = (text: string, max = 40) => {
  const t = normalizeLetteringText(text).replace(/\n/g, ' ');
  return `“${t.length > max ? `${t.slice(0, max - 1)}…` : t}”`;
};
const pageRange = (ns: number[]): string => {
  const sorted = [...new Set(ns)].sort((a, b) => a - b);
  if (!sorted.length) return '';
  if (sorted.length === 1) return `page ${sorted[0]}`;
  const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
  return contiguous ? `pages ${sorted[0]}–${sorted[sorted.length - 1]}` : `pages ${sorted.join(', ')}`;
};
const FREE_NOTE = 'Free — done by the editor, no redraw and no AI cost.';
const KIND_WORD: Record<LineKind, string> = { speech: 'speech', thought: 'thought', caption: 'caption', sfx: 'sound-effect', whisper: 'whisper', shout: 'shout' };

const nameOf = (doc: ComicDoc, id?: string) => (id ? doc.cast.find((c) => c.id === id)?.name : undefined);

// ── Arguments: fonts, presets, style ─────────────────────────────────────────

const FONT_ALIASES: Record<string, FontId> = {
  comic: 'comic-neue', classic: 'comic-neue', default: 'comic-neue',
  kids: 'andika', 'kids readable': 'andika', 'early readers': 'andika', storybook: 'andika', friendly: 'andika',
  readable: 'atkinson', legible: 'atkinson', 'easy to read': 'atkinson', accessible: 'atkinson', 'low vision': 'atkinson',
  handwritten: 'patrick-hand', 'hand written': 'patrick-hand', handwriting: 'patrick-hand', indie: 'patrick-hand',
  marker: 'permanent-marker', sharpie: 'permanent-marker',
  typewriter: 'special-elite', noir: 'special-elite', detective: 'special-elite',
  retro: 'ultra', pulp: 'ultra', 'golden age': 'ultra', serif: 'ultra',
  manga: 'shantell-sans', webtoon: 'shantell-sans', modern: 'shantell-sans',
  impact: 'bangers', action: 'bangers', sfx: 'bangers', 'sound effects': 'bangers', superhero: 'bangers',
  cartoon: 'luckiest-guy', bubbly: 'luckiest-guy', playful: 'luckiest-guy',
  japanese: 'dela-gothic-one', 'manga sfx': 'dela-gothic-one',
  hindi: 'kalam', devanagari: 'kalam', 'noto': 'noto-sans', 'plain': 'noto-sans', sans: 'noto-sans'
};

const fontChoices = () =>
  FONT_IDS.filter((id) => FONT_REGISTRY[id].source === 'fontsource' || id === 'noto-sans')
    .map((id) => `${FONT_REGISTRY[id].label ?? id} (${id})`)
    .join(', ');

const parseFont = (raw: unknown): FontId => {
  const key = str(raw, 60).toLowerCase().replace(/^dsl\s+/, '').replace(/\s+font$/, '').replace(/[_]/g, '-');
  if (!key) throw toolArgError(`Name a font: ${fontChoices()}.`);
  if ((FONT_IDS as readonly string[]).includes(key)) return key as FontId;
  const alias = FONT_ALIASES[key] ?? FONT_ALIASES[key.replace(/-/g, ' ')];
  if (alias) return alias;
  const byLabel = FONT_IDS.find((id) => (FONT_REGISTRY[id].label ?? '').toLowerCase() === key.replace(/-/g, ' ') || FONT_REGISTRY[id].family.toLowerCase() === key);
  if (byLabel) return byLabel;
  throw toolArgError(`I don't have a font called "${str(raw, 40)}". Choose one of: ${fontChoices()}.`);
};

const parsePreset = (raw: unknown): LetteringPresetId => {
  const key = str(raw, 60).toLowerCase();
  const id = LETTERING_PRESET_IDS.find(
    (p) => p === key || p === key.replace(/[\s-]+/g, '_') || LETTERING_PRESETS[p].name.toLowerCase() === key || LETTERING_PRESETS[p].name.toLowerCase().includes(key)
  );
  if (!id || !key) {
    throw toolArgError(`Unknown lettering preset "${str(raw, 40)}". Choose one of: ${LETTERING_PRESET_IDS.map((p) => `${p} (${LETTERING_PRESETS[p].name})`).join(', ')}.`);
  }
  return id;
};

const parseKind = (raw: unknown): LineKind => {
  const key = str(raw, 20).toLowerCase().replace(/s$/, '');
  const alias: Record<string, LineKind> = { dialogue: 'speech', speech: 'speech', narration: 'caption', narrator: 'caption', caption: 'caption', 'sound effect': 'sfx', sound: 'sfx', sfx: 'sfx', thought: 'thought', whisper: 'whisper', shout: 'shout', yell: 'shout' };
  const kind = alias[key] ?? ((LINE_KINDS as readonly string[]).includes(key) ? (key as LineKind) : undefined);
  if (!kind) throw toolArgError(`Unknown balloon kind "${str(raw, 20)}". Use one of: ${LINE_KINDS.join(', ')}.`);
  return kind;
};

const colorArg = (raw: unknown, what: string): string => {
  const c = normalizeColor(raw);
  if (!c || c === 'auto') throw toolArgError(`"${str(raw, 30)}" isn't a ${what} I can use. Give a colour name (red, navy, cream) or a hex like #ff3366.`);
  return c;
};

const enumArg = <T extends string>(raw: unknown, list: readonly T[], what: string): T => {
  const key = str(raw, 30).toLowerCase();
  const variants = [key, key.replace(/[\s-]+/g, '_'), key.replace(/[\s_]+/g, '-')];
  const hit = list.find((v) => variants.includes(v));
  if (!hit) throw toolArgError(`Unknown ${what} "${str(raw, 30)}". Use one of: ${list.join(', ')}.`);
  return hit;
};

/** Relative / absolute size → sizeScale. */
const sizeArg = (raw: unknown, current: number): number => {
  if (typeof raw === 'number') return clamp(raw, 0.5, 3.5);
  const key = str(raw, 30).toLowerCase();
  const rel: Record<string, number> = {
    smaller: 0.85, small: 0.85, 'a bit smaller': 0.9, 'slightly smaller': 0.9, 'much smaller': 0.7, tiny: 0.7,
    larger: 1.2, bigger: 1.2, big: 1.2, large: 1.2, 'a bit larger': 1.1, 'a bit bigger': 1.1, 'slightly larger': 1.1, 'slightly bigger': 1.1,
    'much larger': 1.45, 'much bigger': 1.45, huge: 1.6, normal: 0, default: 0, reset: 0
  };
  if (key in rel) return rel[key] === 0 ? 1 : clamp(current * rel[key], 0.5, 3.5);
  const n = numArg(key.replace(/x$/, ''));
  if (n !== undefined && n > 0) return clamp(n, 0.5, 3.5);
  throw toolArgError(`Size must be "smaller", "larger" or a scale like 1.2 (got "${str(raw, 20)}").`);
};

/** styleArgs (flat, natural names) → a sanitized LetterStylePatch, relative to the style it modifies. */
const buildStylePatch = (raw: unknown, current: LetterStyle): LetterStylePatch => {
  if (!isObject(raw)) throw toolArgError('style must be an object, e.g. {"font":"bangers","text_color":"red"}.');
  const p: Record<string, unknown> = {};
  if (raw.font !== undefined) p.font = parseFont(raw.font);
  if (raw.size !== undefined) p.sizeScale = sizeArg(raw.size, current.sizeScale);
  if (typeof raw.bold === 'boolean') p.weight = raw.bold ? (current.weight >= 700 ? Math.min(900, current.weight + 100) : 700) : 400;
  if (typeof raw.italic === 'boolean') p.italic = raw.italic;
  if (raw.case !== undefined) p.textCase = enumArg(raw.case === 'uppercase' ? 'upper' : raw.case === 'lowercase' ? 'lower' : raw.case, TEXT_CASES, 'text case');
  if (raw.text_color !== undefined) p.textColor = colorArg(raw.text_color, 'text colour');
  if (raw.outline_color !== undefined || raw.outline_width !== undefined) {
    const width = numArg(raw.outline_width);
    const colorRaw = raw.outline_color;
    if (width === 0 || (typeof colorRaw === 'string' && /^(none|no|off|transparent)$/i.test(colorRaw.trim()))) p.textStroke = null;
    else {
      const color = colorRaw !== undefined ? colorArg(colorRaw, 'outline colour') : current.textStroke?.color ?? '#111111';
      p.textStroke = { color, width: clamp(width ?? current.textStroke?.width ?? 0.08, 0.01, 0.3) };
    }
  }
  if (raw.fill_color !== undefined) p.fill = normalizeColor(raw.fill_color) === 'none' ? 'none' : colorArg(raw.fill_color, 'fill colour');
  if (raw.border_color !== undefined) p.border = colorArg(raw.border_color, 'border colour');
  if (raw.border_width !== undefined) {
    const n = numArg(raw.border_width);
    if (n === undefined) throw toolArgError('border_width must be a number (1 = normal, 0 = none, up to 4).');
    p.borderWidth = n;
  }
  if (raw.border_style !== undefined) p.borderStyle = enumArg(raw.border_style, BORDER_STYLES, 'border style');
  if (raw.shape !== undefined) p.shape = enumArg(raw.shape, BUBBLE_SHAPES, 'bubble shape');
  if (raw.tail !== undefined) p.tail = enumArg(raw.tail, TAIL_STYLES, 'tail style');
  for (const [arg, key] of [
    ['letter_spacing', 'letterSpacing'],
    ['line_height', 'lineHeight'],
    ['padding', 'padding'],
    ['rotate', 'rotate'],
    ['arc', 'arc']
  ] as const) {
    if (raw[arg] === undefined) continue;
    const n = numArg(raw[arg]);
    if (n === undefined) throw toolArgError(`${arg} must be a number.`);
    p[key] = n;
  }
  if (raw.align !== undefined) p.align = enumArg(raw.align, ['center', 'left', 'right'] as const, 'alignment');
  if (raw.sfx_effect !== undefined) p.sfxEffect = enumArg(raw.sfx_effect, SFX_EFFECTS, 'sound-effect style');
  const clean = sanitizeLetterStylePatch(p);
  if (!clean && !('textStroke' in p)) throw toolArgError('That style has nothing I can change. Try font, size, text_color, fill_color, shape or tail.');
  // textStroke: null (remove outline) is a valid clearing value the sanitizer keeps.
  return clean ?? { textStroke: null };
};

/** '#e63946'-style values back to the colour words the user typed ("red"), when they match exactly. */
const COLOR_WORDS = new Map<string, string>(NAMED_COLORS.map(([name]) => [normalizeColor(name) ?? '', name] as [string, string]).filter(([hex]) => !!hex));

/** Human summary of a style patch ("font Bangers, red text, cloud bubbles"). */
const describePatch = (p: LetterStylePatch): string => {
  const parts: string[] = [];
  const color = (c: string) => COLOR_WORDS.get(c) ?? c;
  if (p.font) parts.push(`font ${FONT_REGISTRY[p.font]?.label ?? p.font}`);
  if (p.sizeScale !== undefined) parts.push(`size ×${p.sizeScale}`);
  if (p.weight !== undefined) parts.push(p.weight >= 700 ? 'bold' : 'regular weight');
  if (p.italic !== undefined) parts.push(p.italic ? 'italic' : 'not italic');
  if (p.textCase) parts.push(p.textCase === 'as_typed' ? 'mixed case' : `${p.textCase}case`.replace('titlecase', 'title case'));
  if (p.textColor) parts.push(`text ${color(p.textColor)}`);
  if (p.textStroke !== undefined) parts.push(p.textStroke ? `outline ${color(p.textStroke.color)}` : 'no text outline');
  if (p.fill) parts.push(`fill ${color(p.fill)}`);
  if (p.border) parts.push(`border ${color(p.border)}`);
  if (p.borderWidth !== undefined) parts.push(`border width ×${p.borderWidth}`);
  if (p.borderStyle) parts.push(`${p.borderStyle} border`);
  if (p.shape) parts.push(`${p.shape.replace('_', ' ')} bubbles`);
  if (p.tail) parts.push(`${p.tail} tails`);
  if (p.letterSpacing !== undefined) parts.push(`letter spacing ${p.letterSpacing}em`);
  if (p.lineHeight !== undefined) parts.push(`line height ${p.lineHeight}`);
  if (p.align) parts.push(`${p.align}-aligned`);
  if (p.padding !== undefined) parts.push(`padding ×${p.padding}`);
  if (p.rotate !== undefined) parts.push(p.rotate === 'auto' ? 'auto tilt' : `tilt ${p.rotate}°`);
  if (p.sfxEffect) parts.push(`${p.sfxEffect.replace('_', ' ')} sound effects`);
  if (p.arc !== undefined) parts.push(`arc ${p.arc}`);
  return parts.join(', ');
};

// ── Targets ──────────────────────────────────────────────────────────────────

interface Hit {
  page: Page;
  panelN: number;
  panelIndex: number;
  line: Line;
}

const allHits = (doc: ComicDoc, pages: Page[]): Hit[] =>
  pages.flatMap((page) =>
    page.panels.flatMap((panel, panelIndex) =>
      panel.lines.filter((l) => normalizeLetteringText(l.text)).map((line) => ({ page, panelN: panel.n, panelIndex, line }))
    )
  );

const inventory = (doc: ComicDoc, pages: Page[]): string => {
  const parts = pages.slice(0, 4).map((page) => {
    const counts = new Map<LineKind, number>();
    for (const h of allHits(doc, [page])) counts.set(h.line.kind, (counts.get(h.line.kind) ?? 0) + 1);
    const list = [...counts.entries()].map(([k, n]) => `${KIND_WORD[k]} ×${n}`).join(', ');
    return `page ${page.n} has ${list || 'no lettered lines'}`;
  });
  if (pages.length > 4) parts.push(`…and ${pages.length - 4} more pages`);
  return parts.join('; ');
};

interface TargetSpec {
  page?: number;
  panel?: number;
  kind?: LineKind;
  speakerId?: string;
  speakerName?: string;
  contains?: string;
  lineIds?: string[];
  selected?: boolean;
}

const parseTarget = (doc: ComicDoc, raw: unknown, turn: DirectorTurn | undefined): TargetSpec => {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) throw toolArgError('target must be an object, e.g. {"page":1,"speaker":"Max"}.');
  const t: TargetSpec = {};
  if (raw.page !== undefined) {
    t.page = int(raw.page);
    if (t.page === undefined || !doc.pages.some((p) => p.n === t.page)) {
      throw toolArgError(`No page ${str(String(raw.page), 10)} — the comic has ${plural(doc.pages.length, 'page')}.`);
    }
  }
  if (raw.panel !== undefined) {
    t.panel = int(raw.panel);
    if (t.panel === undefined || t.panel < 1) throw toolArgError('panel must be a panel number (1, 2, …).');
  }
  if (raw.kind !== undefined) t.kind = parseKind(raw.kind);
  if (raw.speaker !== undefined && str(raw.speaker)) {
    const who = resolveCharacter(doc, str(raw.speaker, 80));
    if (!who) {
      const cast = doc.cast.map((c) => c.name).filter(Boolean);
      throw toolArgError(`No character called "${str(raw.speaker, 40)}"${cast.length ? `. The cast is: ${cast.join(', ')}` : ' — the cast is empty'}.`);
    }
    t.speakerId = who.id;
    t.speakerName = who.name;
  }
  if (raw.text_contains !== undefined && str(raw.text_contains)) t.contains = str(raw.text_contains, 120).toLowerCase();
  if (Array.isArray(raw.line_ids)) t.lineIds = raw.line_ids.filter((x): x is string => typeof x === 'string').slice(0, 80);
  if (raw.selected === true) {
    const ids = turn?.focus?.lineIds?.filter((x) => typeof x === 'string') ?? [];
    if (!ids.length) throw toolArgError('Nothing is selected on the board right now — ask which balloon (page, panel, speaker or a few words of it).');
    t.selected = true;
    t.lineIds = [...(t.lineIds ?? []), ...ids];
  }
  return t;
};

const describeTarget = (t: TargetSpec): string => {
  const bits: string[] = [];
  if (t.selected) bits.push('selected');
  if (t.kind) bits.push(KIND_WORD[t.kind]);
  bits.push('balloons');
  if (t.speakerName) bits.push(`by ${t.speakerName}`);
  if (t.contains) bits.push(`containing “${t.contains}”`);
  if (t.panel) bits.push(`in panel ${t.panel}`);
  if (t.page) bits.push(`on page ${t.page}`);
  return bits.join(' ');
};

const matchTargets = (doc: ComicDoc, t: TargetSpec, pageOverride?: Page): { hits: Hit[]; pages: Page[] } => {
  const pages = pageOverride ? [pageOverride] : t.page ? doc.pages.filter((p) => p.n === t.page) : doc.pages;
  const ids = t.lineIds ? new Set(t.lineIds) : undefined;
  const hits = allHits(doc, pages).filter(
    (h) =>
      (!t.panel || h.panelN === t.panel) &&
      (!t.kind || h.line.kind === t.kind) &&
      (!t.speakerId || h.line.speakerId === t.speakerId) &&
      (!t.contains || normalizeLetteringText(h.line.text).toLowerCase().includes(t.contains)) &&
      (!ids || ids.has(h.line.id))
  );
  return { hits, pages };
};

/** Honest "nothing matched" sentence listing what exists. */
const noMatch = (doc: ComicDoc, t: TargetSpec, pages: Page[]): string => {
  const extra: string[] = [];
  if (t.speakerId) {
    const theirs = allHits(doc, doc.pages).filter((h) => h.line.speakerId === t.speakerId);
    extra.push(
      theirs.length
        ? `${t.speakerName} speaks on ${pageRange(theirs.map((h) => h.page.n))}`
        : `${t.speakerName} has no lines yet`
    );
  }
  if (t.panel && pages.length === 1) extra.push(`page ${pages[0].n} has ${plural(pages[0].panels.length, 'panel')}`);
  if (t.selected) extra.push('the selected balloons are not on that page');
  return `No ${describeTarget(t)} matched — nothing was changed. ${inventory(doc, pages)}.${extra.length ? ` ${extra.join('; ')}.` : ''}`;
};

// ── Guards ───────────────────────────────────────────────────────────────────

const requireOverlay = (doc: ComicDoc) => {
  if (doc.format.lettering !== 'overlay') {
    const drawn = doc.pages.filter((p) => p.render.status === 'ready').length;
    throw toolArgError(
      `This comic's text is painted into the artwork (in-art lettering), so lettering styles and balloon moves don't apply. ` +
        `Switching to overlay lettering makes every balloon editable for free afterwards, but ${drawn ? `the ${plural(drawn, 'drawn page')} would need redrawing without text (a paid re-render — quote it first)` : 'pages drawn from then on will leave room for overlay balloons'}.`
    );
  }
};

const runSanitizer = (doc: ComicDoc, op: DocOp, ctx: StudioContext): DocOp => {
  const s = LETTERING_SANITIZERS.find((x) => x.op === op.op);
  if (!s) return op;
  const sctx: SanitizeCtx = { userId: ctx.userId, caps: ctx.caps as SanitizeCtx['caps'], rating: ctx.rating as SanitizeCtx['rating'], now: Date.now() };
  return s.sanitize(doc, op, sctx);
};

const USER_ASKED_LETTERING_RE = /\b(font|letter(?:ing)?|balloon|bubble|text|caption|style|preset|manga|storybook|noir|webtoon|pulp|handwritten|minimal|classic)\b/i;

// ── set_lettering_style ──────────────────────────────────────────────────────

const STYLE_SCHEMA = {
  type: 'object',
  description: 'Only the keys you set change.',
  properties: {
    font: { type: 'string', description: 'Font id or plain words: comic, kids readable, readable, handwritten, marker, typewriter, retro, manga, impact, cartoon' },
    size: { type: 'string', description: '"smaller", "larger" or a scale like "1.2"' },
    bold: { type: 'boolean' },
    italic: { type: 'boolean' },
    case: { type: 'string', enum: [...TEXT_CASES] },
    text_color: { type: 'string', description: 'CSS colour name or hex' },
    outline_color: { type: 'string', description: 'Text outline colour, or "none"' },
    outline_width: { type: 'number', description: 'Text outline in em, 0–0.3' },
    fill_color: { type: 'string', description: 'Balloon fill; hex with alpha (#ffffff80) for see-through' },
    border_color: { type: 'string' },
    border_width: { type: 'number', description: '1 = normal, 0 = none, up to 4' },
    border_style: { type: 'string', enum: [...BORDER_STYLES] },
    shape: { type: 'string', enum: [...BUBBLE_SHAPES] },
    tail: { type: 'string', enum: [...TAIL_STYLES] },
    letter_spacing: { type: 'number', description: 'em, −0.05–0.3' },
    line_height: { type: 'number', description: '0.9–1.8' },
    align: { type: 'string', enum: ['center', 'left', 'right'] },
    padding: { type: 'number', description: '× normal padding, 0–3' },
    rotate: { type: 'number', description: 'degrees −30–30' },
    sfx_effect: { type: 'string', enum: [...SFX_EFFECTS] },
    arc: { type: 'number', description: 'Sound-effect arc −1–1' }
  }
};

const TARGET_SCHEMA = {
  type: 'object',
  description: 'Which balloons (all conditions must match; no page = every page).',
  properties: {
    page: { type: 'integer' },
    panel: { type: 'integer' },
    kind: { type: 'string', enum: [...LINE_KINDS] },
    speaker: { type: 'string', description: 'Character name' },
    text_contains: { type: 'string' },
    line_ids: { type: 'array', items: { type: 'string' } },
    selected: { type: 'boolean', description: 'The balloons the user has selected ("this bubble")' }
  }
};

const currentScopeStyle = (doc: ComicDoc, scope: 'comic' | 'kind' | 'speaker', kind?: LineKind, speakerId?: string): LetterStyle =>
  resolveLetterStyle(doc, { id: '_scope', kind: scope === 'kind' && kind ? kind : 'speech', text: '', ...(scope === 'speaker' && speakerId ? { speakerId } : {}) });

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Lines in scope whose resolved style really changed between two docs (what the user will see). */
const restyledCount = (before: ComicDoc, after: ComicDoc, filter: (l: Line) => boolean): number => {
  const old = new Map(allHits(before, before.pages).map((h) => [h.line.id, h.line]));
  return allHits(after, after.pages).filter(
    (h) => filter(h.line) && !sameValue(resolveLetterStyle(before, old.get(h.line.id) ?? h.line), resolveLetterStyle(after, h.line))
  ).length;
};

/** Lines in scope where a more specific setting (kind / speaker / balloon) still wins over `patch`. */
const overridesBlocking = (doc: ComicDoc, patch: LetterStylePatch | undefined, filter: (l: Line) => boolean): number => {
  const entries = Object.entries(patch ?? {});
  if (!entries.length) return 0;
  return allHits(doc, doc.pages).filter((h) => {
    if (!filter(h.line)) return false;
    const resolved = resolveLetterStyle(doc, h.line) as unknown as Record<string, unknown>;
    return entries.some(([k, v]) => !sameValue(resolved[k], v));
  }).length;
};

const coverageNote = (doc: ComicDoc, font: FontId | undefined): string => {
  if (!font) return '';
  const langs = [doc.format.language, ...Object.keys(doc.i18n?.editions ?? {})].filter(Boolean);
  const missing = [...new Set(langs)].filter((l) => !fontCoversLanguage(font, l));
  if (!missing.length) return '';
  return ` ${FONT_REGISTRY[font].label ?? font} has no letters for ${missing.join(', ')}, so those lines keep their script's font.`;
};

function setLetteringStyleTool(ctx: StudioContext, turn: DirectorTurn | undefined): DirectorTool {
  return defineTool(
    'set_lettering_style',
    'free',
    'Change the lettering look of the whole comic, one balloon kind, or one speaker: a preset (classic, manga, storybook, noir, webtoon, retro_pulp, minimal, handwritten) and/or style changes (font, size, colours, bubble shape, tail…). Overlay edit — never redraw for lettering.',
    {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: [...LETTERING_PRESET_IDS] },
        scope: { type: 'string', enum: ['comic', 'kind', 'speaker'], description: 'Default: comic' },
        kind: { type: 'string', enum: [...LINE_KINDS], description: 'With scope "kind"' },
        speaker: { type: 'string', description: 'Character name, with scope "speaker"' },
        style: STYLE_SCHEMA,
        reset: { type: 'boolean', description: 'Clear the custom overrides of that scope' }
      }
    },
    (args) => {
      const doc = ctx.session.doc;
      requireOverlay(doc);
      const preset = args.preset !== undefined && str(args.preset) ? parsePreset(args.preset) : undefined;
      const scopeRaw = str(args.scope, 10).toLowerCase();
      const scope: 'comic' | 'kind' | 'speaker' =
        scopeRaw === 'kind' || scopeRaw === 'speaker' || scopeRaw === 'comic' ? scopeRaw : args.speaker ? 'speaker' : args.kind ? 'kind' : 'comic';
      const kind = scope === 'kind' ? (args.kind !== undefined ? parseKind(args.kind) : undefined) : undefined;
      if (scope === 'kind' && !kind) throw toolArgError(`scope "kind" needs kind: one of ${LINE_KINDS.join(', ')}.`);
      let speakerId: string | undefined;
      let speakerName: string | undefined;
      if (scope === 'speaker') {
        const who = resolveCharacter(doc, str(args.speaker, 80));
        if (!who) {
          const cast = doc.cast.map((c) => c.name).filter(Boolean);
          throw toolArgError(`scope "speaker" needs a cast member's name${cast.length ? ` (${cast.join(', ')})` : ' — the cast is empty'}.`);
        }
        speakerId = who.id;
        speakerName = who.name;
      }
      const reset = args.reset === true;
      const stylePatch = args.style !== undefined ? buildStylePatch(args.style, currentScopeStyle(doc, scope, kind, speakerId)) : undefined;
      if (!preset && !stylePatch && !reset) throw toolArgError('Give a preset, a style change, or reset: true.');

      const ls = doc.letterStyle ?? DEFAULT_LETTERING;
      const patch: LetteringStyleOpPatch = {};
      if (preset) {
        patch.presetId = preset;
        // The director picking a fitting preset on its own keeps "auto"; a user's pick stops it.
        if (ls.auto && preset !== ls.presetId && !USER_ASKED_LETTERING_RE.test(turn?.userText ?? '')) patch.auto = true;
      }
      if (scope === 'comic') {
        if (reset) {
          patch.base = null;
          if (ls.kinds) patch.kinds = Object.fromEntries(Object.keys(ls.kinds).map((k) => [k, null]));
        }
        if (stylePatch) patch.base = stylePatch;
      } else if (scope === 'kind' && kind) {
        patch.kinds = { [kind]: reset && !stylePatch ? null : stylePatch ?? null };
      } else if (scope === 'speaker' && speakerId) {
        patch.speakers = { [speakerId]: reset && !stylePatch ? null : stylePatch ?? null };
      }
      const castIds = new Set(doc.cast.map((c) => c.id));
      const clean = sanitizeLetteringStyleOpPatch(patch, castIds);
      if (!clean) throw toolArgError('That lettering change has nothing valid in it.');
      const op = runSanitizer(doc, { op: 'letter_style', patch: clean }, ctx);
      const label = preset ? `Lettering: ${LETTERING_PRESETS[preset].name}` : 'Lettering style';
      const after = ctx.session.commit([op], { origin: 'director', label });

      const lines = allHits(after, after.pages);
      const inScope = (l: Line) => (scope === 'kind' ? l.kind === kind : scope === 'speaker' ? l.speakerId === speakerId : true);
      const affected = lines.filter((h) => inScope(h.line)).length;
      const changed = restyledCount(doc, after, inScope);
      const blocked = overridesBlocking(after, stylePatch, inScope);
      const who = scope === 'kind' ? `${KIND_WORD[kind!]} balloons` : scope === 'speaker' ? `${speakerName}'s balloons` : 'the comic';
      const parts: string[] = [];
      if (preset) {
        const p = LETTERING_PRESETS[preset];
        parts.push(`Lettering is now *${p.name}* — ${p.blurb}`);
        if (ls.presetId !== preset && (ls.base || ls.kinds) && !clean.keepOverrides) parts.push('Earlier comic-wide lettering tweaks were cleared for the new preset.');
      }
      if (reset && !stylePatch) parts.push(`Reset the custom lettering for ${who}${preset ? '' : ` back to the ${LETTERING_PRESETS[(after.letterStyle ?? DEFAULT_LETTERING).presetId].name} preset`}.`);
      if (stylePatch) parts.push(`Set ${describePatch(stylePatch)} for ${who}.`);
      parts.push(affected ? `${plural(changed, 'balloon')} restyled.` : 'No lettered lines yet — new ones will use it.');
      if (blocked) {
        parts.push(
          `${plural(blocked, 'balloon')} keep${blocked === 1 ? 's' : ''} a more specific setting for that (a per-kind, per-speaker or per-balloon override wins; restyle_balloons with reset clears a balloon's own).`
        );
      }
      const note = coverageNote(after, stylePatch?.font);
      return `${parts.join(' ')}${note} ${FREE_NOTE}`;
    }
  );
}

// ── restyle_balloons ─────────────────────────────────────────────────────────

function restyleBalloonsTool(ctx: StudioContext, turn: DirectorTurn | undefined): DirectorTool {
  return defineTool(
    'restyle_balloons',
    'free',
    'Restyle specific balloons (per-balloon overrides): pick them by page, panel, kind, speaker, words, line ids or the user\'s selection, then set style changes or reset them to the comic\'s lettering.',
    {
      type: 'object',
      properties: { target: TARGET_SCHEMA, style: STYLE_SCHEMA, reset: { type: 'boolean', description: 'Remove these balloons\' own overrides (with style: replace them by it)' } },
      required: ['target']
    },
    (args) => {
      const doc = ctx.session.doc;
      requireOverlay(doc);
      const t = parseTarget(doc, args.target, turn);
      const reset = args.reset === true;
      if (args.style === undefined && !reset) throw toolArgError('Give style changes, or reset: true.');
      const { hits, pages } = matchTargets(doc, t);
      if (!hits.length) return noMatch(doc, t, pages);

      // Per line (relative sizes depend on each balloon's current size), grouped per page + identical patch.
      const groups = new Map<string, { pageId: string; ids: string[]; patch: LetterStylePatch | null }>();
      let summary: LetterStylePatch | undefined;
      for (const h of hits) {
        const patch = args.style !== undefined ? buildStylePatch(args.style, resolveLetterStyle(doc, h.line)) : null;
        if (patch && !summary) summary = patch;
        const key = `${h.page.id}|${patch ? JSON.stringify(patch) : 'null'}`;
        const g = groups.get(key) ?? { pageId: h.page.id, ids: [], patch };
        g.ids.push(h.line.id);
        groups.set(key, g);
      }
      const ops: DocOp[] = [];
      for (const g of groups.values()) {
        for (let i = 0; i < g.ids.length; i += 80) {
          // reset + style = replace the balloons' own overrides with just this style.
          ops.push(runSanitizer(doc, { op: 'line_style', pageId: g.pageId, lineIds: g.ids.slice(i, i + 80), patch: g.patch, mode: reset && g.patch ? 'replace' : 'merge' }, ctx));
        }
      }
      ctx.session.commit(ops, { origin: 'director', label: reset && !summary ? 'Reset balloon style' : 'Restyle balloons' });
      const speakerBit = t.speakerName ? ` of ${t.speakerName}'s` : '';
      const where = pageRange(hits.map((h) => h.page.n));
      const what = summary ? `(${describePatch(summary)})` : '(back to the comic\'s lettering)';
      const total = t.speakerId ? allHits(doc, doc.pages).filter((h) => h.line.speakerId === t.speakerId).length : 0;
      const ofTotal = t.speakerId && total > hits.length ? ` ${hits.length} of ${total}` : ` ${hits.length}`;
      return `Restyled${ofTotal}${speakerBit} balloon${hits.length === 1 ? '' : 's'} on ${where} ${what}.${coverageNote(doc, summary?.font)} ${FREE_NOTE}`;
    }
  );
}

// ── arrange_balloons ─────────────────────────────────────────────────────────

const ARRANGE_ACTIONS = ['auto_layout', 'move', 'nudge', 'resize', 'aim_tail', 'front', 'back', 'lock', 'unlock', 'link', 'unlink', 'fit_text'] as const;
type ArrangeAction = (typeof ARRANGE_ACTIONS)[number];
const POSITIONS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'] as const;
type Position = (typeof POSITIONS)[number];
const PANEL_PAD = 0.012;
const SPOKEN: ReadonlySet<LineKind> = new Set<LineKind>(['speech', 'thought', 'whisper', 'shout']);

interface PageCtx {
  doc: ComicDoc;
  page: Page;
  aspect: number;
  rtl: boolean;
  boxes: { x: number; y: number; w: number; h: number }[];
  safeMargin: number;
  sizer: (line: Line, w: number) => { h: number; bounds: { x: number; y: number; w: number; h: number } };
  /** Every lettered line's current balloon (stored, or where the board draws it today). */
  current: Map<string, Balloon>;
  stored: Set<string>;
}

const pageCtx = (doc: ComicDoc, page: Page): PageCtx => {
  const aspect = letteringAspect(doc, page);
  const boxes = panelBoxesFor(doc, page);
  const ls = doc.letterStyle ?? DEFAULT_LETTERING;
  const safeMargin = typeof ls.safeMargin === 'number' ? ls.safeMargin : DEFAULT_SAFE_MARGIN;
  const sizer = letteringSizer(doc, page, aspect, estimateMeasure);
  const rtl = doc.format.readingDirection === 'rtl';
  const qc = page.render.qc;
  const filled = placeBalloonsDetailed({
    page, boxes, aspect, rtl, plansFor: sizer, keepOut: qc?.keepOut, heads: qc?.heads, safeMargin, existing: page.balloons, keep: 'all', lang: doc.format.language
  });
  const stored = new Set(page.balloons.map((b) => b.lineId));
  return { doc, page, aspect, rtl, boxes, safeMargin, sizer, current: new Map(filled.balloons.map((b) => [b.lineId, b])), stored };
};

/** Where to put a balloon of `line` at `pos` inside its panel, keeping the outline inside the safe area. */
const positionIn = (
  pc: PageCtx,
  hit: Hit,
  w: number,
  pos: Position
): { x: number; y: number; h: number; bounds: { x: number; y: number; w: number; h: number }; yMin: number; yMax: number } => {
  const box = pc.boxes[hit.panelIndex] ?? { x: 0, y: 0, w: 1, h: 1 };
  const safe = safeAreaBox(pc.safeMargin, pc.aspect);
  const s = pc.sizer(hit.line, w);
  const region = {
    x: Math.max(box.x + PANEL_PAD, safe.x),
    y: Math.max(box.y + PANEL_PAD, safe.y),
    r: Math.min(box.x + box.w - PANEL_PAD, safe.x + safe.w),
    b: Math.min(box.y + box.h - PANEL_PAD, safe.y + safe.h)
  };
  const xLo = region.x - s.bounds.x;
  const xHi = region.r - (s.bounds.x + s.bounds.w);
  const yLo = region.y - s.bounds.y;
  const yHi = region.b - (s.bounds.y + s.bounds.h);
  const horiz = pos.endsWith('left') ? 0 : pos.endsWith('right') ? 1 : 0.5;
  const vert = pos.startsWith('top') ? 0 : pos.startsWith('bottom') ? 1 : 0.5;
  const x = xHi >= xLo ? xLo + (xHi - xLo) * horiz : (xLo + xHi) / 2;
  const y = yHi >= yLo ? yLo + (yHi - yLo) * vert : (yLo + yHi) / 2;
  // Never off the safe area even when the panel is smaller than the balloon.
  const sx = clamp(x, safe.x - s.bounds.x, safe.x + safe.w - (s.bounds.x + s.bounds.w));
  const yMin = safe.y - s.bounds.y;
  const yMax = Math.max(yMin, safe.y + safe.h - (s.bounds.y + s.bounds.h));
  return { x: sx, y: clamp(y, yMin, yMax), h: s.h, bounds: s.bounds, yMin, yMax };
};

const balloonOp = (pc: PageCtx, lineId: string, patch: Partial<Balloon>): DocOp => {
  const cur = pc.current.get(lineId);
  // A line without a stored balloon gets a COMPLETE balloon (never the 0.1/0.1/0.28 default).
  const full: Partial<Balloon> = pc.stored.has(lineId) || !cur ? patch : { ...cur, ...patch };
  const clean: Partial<Balloon> = {};
  for (const [k, v] of Object.entries(full)) {
    if (k === 'lineId' || v === undefined) continue;
    (clean as Record<string, unknown>)[k] = typeof v === 'number' ? r4(v) : v;
  }
  return { op: 'balloon', pageId: pc.page.id, lineId, patch: clean };
};

function arrangeBalloonsTool(ctx: StudioContext, turn: DirectorTurn | undefined): DirectorTool {
  return defineTool(
    'arrange_balloons',
    'free',
    'Place balloons on a page: auto_layout (re-letter the page around faces, free, from the page\'s stored analysis), move to a panel position, nudge, resize, aim_tail at a speaker, front/back, lock/unlock, link/unlink consecutive balloons, fit_text.',
    {
      type: 'object',
      properties: {
        page: { type: 'integer' },
        action: { type: 'string', enum: [...ARRANGE_ACTIONS] },
        target: TARGET_SCHEMA,
        position: { type: 'string', enum: [...POSITIONS], description: 'Inside the balloon\'s panel (move)' },
        dx: { type: 'number', description: 'nudge: fraction of page width (+ right), e.g. 0.03' },
        dy: { type: 'number', description: 'nudge: fraction of page height (+ down)' },
        width_scale: { type: 'number', description: 'resize: 0.5–2' },
        tail_to: { type: 'string', description: 'aim_tail: character name' },
        include_pinned: { type: 'boolean', description: 'auto_layout: also move balloons the user placed (never locked ones)' }
      },
      required: ['page', 'action']
    },
    (args) => {
      const doc = ctx.session.doc;
      requireOverlay(doc);
      const n = int(args.page);
      const page = n !== undefined ? doc.pages.find((p) => p.n === n) : undefined;
      if (!page) throw toolArgError(`No page ${str(String(args.page ?? ''), 10)} — the comic has ${plural(doc.pages.length, 'page')}.`);
      const action = enumArg(args.action, ARRANGE_ACTIONS, 'arrange action') as ArrangeAction;
      const pc = pageCtx(doc, page);
      const everyLine = allHits(doc, [page]);
      if (!everyLine.length) return `Page ${page.n} has no lettered lines yet — nothing to arrange.`;

      // Targets: explicit, else the user's selection on this page, else (auto_layout) the whole page.
      let t: TargetSpec = parseTarget(doc, args.target, turn);
      if (t.page !== undefined && t.page !== page.n) throw toolArgError(`target.page (${t.page}) and page (${page.n}) disagree — arrange one page at a time.`);
      if (args.target === undefined && action !== 'auto_layout') {
        const sel = (turn?.focus?.lineIds ?? []).filter((id) => everyLine.some((h) => h.line.id === id));
        if (!sel.length) {
          throw toolArgError(
            `Which balloon on page ${page.n}? Give a target (speaker, panel, kind or words). It has: ${everyLine.slice(0, 8).map((h) => `panel ${h.panelN} ${KIND_WORD[h.line.kind]}${h.line.speakerId ? ` (${nameOf(doc, h.line.speakerId) ?? '?'})` : ''} ${quote(h.line.text, 24)}`).join('; ')}.`
          );
        }
        t = { lineIds: sel, selected: true };
      }
      const { hits } = args.target === undefined && action === 'auto_layout' ? { hits: everyLine } : matchTargets(doc, t, page);
      if (!hits.length) return noMatch(doc, { ...t, page: page.n }, [page]);

      const ops: DocOp[] = [];
      const label = `Arrange balloons · page ${page.n}`;
      const commit = () => {
        if (ops.length) ctx.session.commit(ops, { origin: 'director', label });
      };
      const who = hits.length === 1 ? `the ${KIND_WORD[hits[0].line.kind]} balloon ${quote(hits[0].line.text, 30)}` : plural(hits.length, 'balloon');

      switch (action) {
        case 'auto_layout': {
          // Lettering tools are FREE by contract (lettering.md §8): never start a vision call from here, even
          // when asked to "re-check" — that paid step is a gated spend action of its own (recheck_page).
          const recheckNote =
            args.recheck === true
              ? ' I used the page\'s stored analysis (free); a fresh AI re-read of the artwork is a separate paid step that I don\'t start from here.'
              : '';
          const lockedIds = new Set(page.balloons.filter((b) => b.locked).map((b) => b.lineId));
          const pinnedIds = new Set(page.balloons.filter((b) => b.pinned && !b.locked).map((b) => b.lineId));
          const targetIds = hits.map((h) => h.line.id).filter((id) => !lockedIds.has(id) && (args.include_pinned === true || !pinnedIds.has(id)));
          if (!targetIds.length) {
            return `Every chosen balloon on page ${page.n} is ${lockedIds.size ? 'locked or ' : ''}placed by you (pinned), so I left them alone. Say "include the ones I moved" to re-letter those too.${recheckNote}`;
          }
          const qc = page.render.qc;
          const res = placeBalloonsDetailed({
            page, boxes: pc.boxes, aspect: pc.aspect, rtl: pc.rtl, plansFor: pc.sizer, keepOut: qc?.keepOut, heads: qc?.heads,
            safeMargin: pc.safeMargin, existing: page.balloons, only: targetIds, lang: doc.format.language
          });
          ops.push({ op: 'balloons', pageId: page.id, balloons: res.balloons });
          commit();
          const keptPinned = hits.filter((h) => pinnedIds.has(h.line.id) && !targetIds.includes(h.line.id)).length;
          const keptLocked = hits.filter((h) => lockedIds.has(h.line.id)).length;
          const parts = [`Re-lettered page ${page.n}: placed ${plural(res.placed.length, 'balloon')} around the art${qc?.keepOut?.length ? ' (keeping faces clear)' : ''}.`];
          if (keptPinned) parts.push(`Kept ${plural(keptPinned, 'balloon')} you positioned.`);
          if (keptLocked) parts.push(`${plural(keptLocked, 'locked balloon')} stayed put.`);
          if (res.crowded.length) {
            const lines = res.crowded.map((id) => everyLine.find((h) => h.line.id === id)).filter((h): h is Hit => !!h);
            parts.push(`${plural(lines.length, 'balloon')} still had no clear spot (${lines.map((h) => `panel ${h.panelN} ${quote(h.line.text, 24)}`).join('; ')}) — shortening that text or moving it to another panel fixes it.`);
          }
          if (!qc?.panelBoxes?.length) parts.push('Panel edges are estimated from the layout (the page has no measured panels yet).');
          return `${parts.join(' ')}${recheckNote} ${FREE_NOTE}`;
        }
        case 'move': {
          const pos = args.position !== undefined ? enumArg(args.position, POSITIONS, 'position') : undefined;
          if (!pos) throw toolArgError(`move needs position: ${POSITIONS.join(', ')} (inside the balloon's panel). Use nudge with dx/dy for small shifts.`);
          // Several balloons sent to one spot stack in reading order (outline to outline, 0.01 apart):
          // downwards from a top/middle spot, upwards from a bottom one — never on top of each other.
          const stacks = new Map<number, { top: number; bottom: number }>();
          for (const h of hits) {
            const cur = pc.current.get(h.line.id);
            if (!cur) continue;
            const p = positionIn(pc, h, cur.w, pos);
            let y = p.y;
            const prev = stacks.get(h.panelIndex);
            if (prev) y = pos.startsWith('bottom') ? Math.min(y, prev.top - 0.01 - (p.bounds.y + p.bounds.h)) : Math.max(y, prev.bottom + 0.01 - p.bounds.y);
            y = clamp(y, p.yMin, p.yMax);
            const top = y + p.bounds.y;
            const bottom = top + p.bounds.h;
            stacks.set(h.panelIndex, prev ? { top: Math.min(prev.top, top), bottom: Math.max(prev.bottom, bottom) } : { top, bottom });
            ops.push(balloonOp(pc, h.line.id, { x: p.x, y, w: cur.w, pinned: true }));
          }
          commit();
          return `Moved ${who} to the ${pos.replace('-', ' ')} of ${hits.length === 1 ? `panel ${hits[0].panelN}` : 'their panels'} on page ${page.n}, inside the safe margin. Pinned, so auto-layout won't move ${hits.length === 1 ? 'it' : 'them'}. ${FREE_NOTE}`;
        }
        case 'nudge': {
          const dx = clamp(numArg(args.dx) ?? 0, -0.5, 0.5);
          const dy = clamp(numArg(args.dy) ?? 0, -0.5, 0.5);
          if (!dx && !dy) throw toolArgError('nudge needs dx and/or dy (fractions of the page, e.g. dx: -0.03 moves left a little).');
          let clamped = 0;
          for (const h of hits) {
            const cur = pc.current.get(h.line.id);
            if (!cur) continue;
            const hFrac = pc.sizer(h.line, cur.w).h;
            const fit = fitBalloonOnPage({ x: cur.x + dx, y: cur.y + dy, w: cur.w }, h.line.kind, hFrac, pc.aspect);
            if (Math.abs(fit.x - (cur.x + dx)) > 1e-4 || Math.abs(fit.y - (cur.y + dy)) > 1e-4) clamped += 1;
            ops.push(balloonOp(pc, h.line.id, { x: fit.x, y: fit.y, w: fit.w, pinned: true }));
          }
          commit();
          return `Nudged ${who} on page ${page.n}.${clamped ? ` ${plural(clamped, 'balloon')} stopped at the page edge so ${clamped === 1 ? 'its' : 'their'} outline stays visible.` : ''} ${FREE_NOTE}`;
        }
        case 'resize': {
          const scale = numArg(args.width_scale);
          if (scale === undefined || scale <= 0) throw toolArgError('resize needs width_scale, e.g. 1.2 (wider) or 0.8 (narrower).');
          const k = clamp(scale, 0.5, 2);
          for (const h of hits) {
            const cur = pc.current.get(h.line.id);
            if (!cur) continue;
            const w = clamp(cur.w * k, 0.08, 0.95);
            const hFrac = pc.sizer(h.line, w).h;
            const fit = fitBalloonOnPage({ x: cur.x + (cur.w - w) / 2, y: cur.y, w }, h.line.kind, hFrac, pc.aspect);
            ops.push(balloonOp(pc, h.line.id, { x: fit.x, y: fit.y, w: fit.w, pinned: true }));
          }
          commit();
          return `Made ${who} on page ${page.n} ${k >= 1 ? 'wider' : 'narrower'} (×${r4(k)}); the text re-wraps to fit. ${FREE_NOTE}`;
        }
        case 'aim_tail': {
          const name = str(args.tail_to, 80);
          const who2 = name ? resolveCharacter(doc, name) : undefined;
          if (!who2) {
            const cast = doc.cast.map((c) => c.name).filter(Boolean);
            throw toolArgError(`aim_tail needs tail_to: a character name${cast.length ? ` (${cast.join(', ')})` : ''}.`);
          }
          const done: Hit[] = [];
          const missing: Hit[] = [];
          for (const h of hits) {
            const cur = pc.current.get(h.line.id);
            if (!cur) continue;
            const panel = page.panels[h.panelIndex];
            const box = pc.boxes[h.panelIndex] ?? { x: 0, y: 0, w: 1, h: 1 };
            const head = (page.render.qc?.heads ?? []).find((m) => m.panel === panel.n && m.characterId === who2.id);
            const inPanel = panel.castIds.includes(who2.id);
            if (!head && !inPanel) {
              missing.push(h);
              continue;
            }
            const hFrac = pc.sizer(h.line, cur.w).h;
            const tip = head
              ? head.mouth ?? head.head
              : { x: box.x + stagedSpeakerX(page, h.panelIndex, who2.id) * box.w, y: Math.min(Math.max(cur.y + hFrac + 0.035, box.y + box.h * 0.4), box.y + box.h - PANEL_PAD) };
            ops.push(balloonOp(pc, h.line.id, { x: cur.x, y: cur.y, w: cur.w, tailX: clamp(tip.x, 0, 1), tailY: clamp(tip.y, 0, 1), pinned: true }));
            done.push(h);
          }
          commit();
          const parts: string[] = [];
          if (done.length) parts.push(`Pointed ${done.length === 1 ? 'the tail' : plural(done.length, 'tail')} at ${who2.name} on page ${page.n}${page.render.qc?.heads?.some((m) => m.characterId === who2.id) ? '' : ' (aimed where the page staged them — no face data for this page yet)'}.`);
          if (missing.length) {
            const panelsWith = page.panels.filter((p) => p.castIds.includes(who2.id)).map((p) => p.n);
            parts.push(`${who2.name} isn't in panel ${[...new Set(missing.map((h) => h.panelN))].join(', ')}${panelsWith.length ? ` (they appear in panel ${panelsWith.join(', ')})` : ' on this page'}, so ${missing.length === 1 ? 'that tail was' : 'those tails were'} left as they were.`);
          }
          const nonSpoken = done.filter((h) => !SPOKEN.has(h.line.kind)).length;
          if (nonSpoken) parts.push(`${plural(nonSpoken, 'caption/sound effect')} only show a tail if its style has one.`);
          return `${parts.join(' ')}${done.length ? ` ${FREE_NOTE}` : ''}`;
        }
        case 'front':
        case 'back': {
          const zs = everyLine.map((h, i) => {
            const b = page.balloons.find((x) => x.lineId === h.line.id);
            return typeof b?.z === 'number' ? b.z : i;
          });
          let z = action === 'front' ? Math.max(...zs) + 1 : Math.min(...zs) - 1;
          for (const h of hits) {
            ops.push(balloonOp(pc, h.line.id, { z: clamp(z, -100, 100) }));
            z += action === 'front' ? 1 : -1;
          }
          commit();
          return `Brought ${who} on page ${page.n} to the ${action === 'front' ? 'front' : 'back'} of the stack. ${FREE_NOTE}`;
        }
        case 'lock':
        case 'unlock': {
          for (const h of hits) ops.push(balloonOp(pc, h.line.id, action === 'lock' ? { locked: true, pinned: true } : { locked: false }));
          commit();
          return action === 'lock'
            ? `Locked ${who} on page ${page.n}: auto-layout and drags won't move ${hits.length === 1 ? 'it' : 'them'}. ${FREE_NOTE}`
            : `Unlocked ${who} on page ${page.n} (still where ${hits.length === 1 ? 'it is' : 'they are'}; auto-layout may move ${hits.length === 1 ? 'it' : 'them'} again only if you ask). ${FREE_NOTE}`;
        }
        case 'link': {
          if (hits.length < 2) throw toolArgError('link needs at least two balloons (e.g. target {page, panel, speaker}) — consecutive lines in one panel.');
          const panels = new Set(hits.map((h) => h.panelIndex));
          if (panels.size > 1) throw toolArgError(`Linked balloons must be in the same panel — these are in panels ${[...new Set(hits.map((h) => h.panelN))].join(', ')}.`);
          // Same convention as the board (lettering/styleOps linkOps): each balloon links to the PREVIOUS one in
          // reading order. One `balloons` op: unstored chain members get their complete current balloon, and
          // any older link that would now close a loop is dropped (the contract forbids cycles).
          const chain = hits.map((h) => h.line.id);
          const next = page.balloons.map((b) => ({ ...b }));
          for (const id of chain) {
            const cur = pc.current.get(id);
            if (!next.some((b) => b.lineId === id) && cur) next.push({ ...cur });
          }
          for (const b of next) {
            const k = chain.indexOf(b.lineId);
            if (k > 0) b.linkTo = chain[k - 1];
          }
          ops.push({ op: 'balloons', pageId: page.id, balloons: breakLinkCycles(next, new Set(chain.slice(1))) });
          commit();
          return `Linked ${plural(hits.length, 'balloon')} in panel ${hits[0].panelN} on page ${page.n} with connector necks, in reading order. ${FREE_NOTE}`;
        }
        case 'unlink': {
          // A link touches a balloon from either end (it links to its previous line; the next one links to it).
          const ids = new Set(hits.map((h) => h.line.id));
          const touches = (b: Balloon) => !!b.linkTo && (ids.has(b.lineId) || ids.has(b.linkTo));
          const linked = page.balloons.filter(touches);
          if (!linked.length) return `None of those balloons on page ${page.n} are linked — nothing changed.`;
          const balloons = page.balloons.map((b) => {
            if (!touches(b)) return b;
            const { linkTo: _drop, ...rest } = b;
            return rest;
          });
          ops.push({ op: 'balloons', pageId: page.id, balloons });
          commit();
          return `Unlinked ${plural(linked.length, 'balloon')} on page ${page.n}. ${FREE_NOTE}`;
        }
        case 'fit_text': {
          for (const h of hits) {
            const cur = pc.current.get(h.line.id);
            if (!cur) continue;
            const box = pc.boxes[h.panelIndex] ?? { x: 0, y: 0, w: 1, h: 1 };
            const lang = h.line.lang || doc.format.language;
            const w = clamp(Math.min(estimateWidthForText(h.line.text, lang, resolveLetterStyle(doc, h.line).font), box.w - 2 * PANEL_PAD), 0.08, 0.95);
            const hFrac = pc.sizer(h.line, w).h;
            const cx = cur.x + cur.w / 2;
            let y = cur.y;
            if (y + hFrac > box.y + box.h - PANEL_PAD) y = Math.max(box.y + PANEL_PAD, box.y + box.h - PANEL_PAD - hFrac);
            const fit = fitBalloonOnPage({ x: cx - w / 2, y, w }, h.line.kind, hFrac, pc.aspect);
            ops.push(balloonOp(pc, h.line.id, { x: fit.x, y: fit.y, w: fit.w, pinned: true }));
          }
          commit();
          return `Re-sized ${who} on page ${page.n} to fit ${hits.length === 1 ? 'its' : 'their'} text. ${FREE_NOTE}`;
        }
        default:
          throw toolArgError(`Unknown action. Use one of: ${ARRANGE_ACTIONS.join(', ')}.`);
      }
    }
  );
}

/** Drop the fewest links that close a loop, never one in `keep` while another member of the loop can go. */
function breakLinkCycles(balloons: Balloon[], keep: ReadonlySet<string>): Balloon[] {
  const byId = new Map(balloons.map((b) => [b.lineId, b]));
  for (const start of balloons) {
    const path: Balloon[] = [];
    const seen = new Set<string>();
    let cur: Balloon | undefined = start;
    while (cur?.linkTo && !seen.has(cur.lineId)) {
      seen.add(cur.lineId);
      path.push(cur);
      cur = byId.get(cur.linkTo);
    }
    if (!cur || !seen.has(cur.lineId)) continue;
    const loop = path.slice(path.indexOf(cur));
    const victim = loop.find((b) => !keep.has(b.lineId)) ?? loop[0];
    delete victim.linkTo;
  }
  return balloons;
}

// ── Helpers for core tools (edit_panel_text style/position, P1-DIRECTOR / P2-SERVER) ──

/** JSON schema of the flat styleArgs every lettering-aware tool accepts. */
export const LETTERING_STYLE_ARGS_SCHEMA = STYLE_SCHEMA;

/** styleArgs → sanitized LetterStylePatch relative to `current` (throws ToolArgError with a fix-it message). */
export const styleArgsToPatch = (raw: unknown, current: LetterStyle): LetterStylePatch => buildStylePatch(raw, current);

/**
 * A complete balloon for `lineId` at a panel position (outline kept inside the safe area), pinned.
 * Undefined when the line isn't lettered on that page or the position is unknown.
 */
export function balloonAtPosition(doc: ComicDoc, page: Page, lineId: string, position: string): Balloon | undefined {
  const pos = (POSITIONS as readonly string[]).includes(position) ? (position as Position) : undefined;
  if (!pos) return undefined;
  const hit = allHits(doc, [page]).find((h) => h.line.id === lineId);
  if (!hit) return undefined;
  const pc = pageCtx(doc, page);
  const cur = pc.current.get(lineId);
  const w = cur?.w ?? estimateWidthForText(hit.line.text, hit.line.lang || doc.format.language);
  const p = positionIn(pc, hit, w, pos);
  return { ...(cur || {}), lineId, x: r4(p.x), y: r4(p.y), w: r4(w), pinned: true };
}

// ── Prompt + summary ─────────────────────────────────────────────────────────

const LETTERING_RULES = [
  'LETTERING (overlay comic — balloons sit on top of the art):',
  '- Font, colour, size, bubble shape, tail and balloon position changes are FREE overlay edits. Use set_lettering_style (whole comic / a kind / a speaker), restyle_balloons (specific balloons) and arrange_balloons (placement). Never use render_pages or edit_page for lettering, and never redraw to fix it.',
  '- "this/that bubble" while balloons are selected → target {selected: true}.',
  '- If the preset is still automatic and no longer fits the comic (kids → storybook, manga, webtoon, noir/detective), call set_lettering_style with that preset; never override a preset the user picked.',
  '- Overlapping or edge-hugging balloons → arrange_balloons auto_layout (free; it keeps faces clear and leaves balloons the user placed).',
  '- Repeat tool results honestly: if nothing matched, say what exists instead.'
].join('\n');

const summaryFor = (doc: ComicDoc, turn: DirectorTurn | undefined): string[] => {
  const ls = doc.letterStyle ?? DEFAULT_LETTERING;
  const bits: string[] = [];
  if (ls.base) bits.push(`comic ${describePatch(ls.base)}`);
  for (const [k, p] of Object.entries(ls.kinds ?? {})) if (p) bits.push(`${k} ${describePatch(p)}`);
  for (const [id, p] of Object.entries(ls.speakers ?? {})) if (p) bits.push(`${nameOf(doc, id) ?? id} ${describePatch(p)}`);
  const balloonOverrides = allHits(doc, doc.pages).filter((h) => h.line.style && Object.keys(h.line.style).length).length;
  const fit = presetForComic(doc.format, doc.brief);
  let line = `Lettering: preset ${ls.presetId}${ls.auto ? ` (auto${fit !== ls.presetId ? `; ${fit} fits this comic` : ''})` : ''}`;
  if (bits.length) line += `; overrides: ${bits.slice(0, 4).join('; ')}${bits.length > 4 ? '; …' : ''}`;
  if (balloonOverrides) line += `; ${plural(balloonOverrides, 'balloon override')}`;
  const out = [`${line}.`];
  const ids = turn?.focus?.lineIds ?? [];
  if (ids.length) {
    const sel = allHits(doc, doc.pages).filter((h) => ids.includes(h.line.id)).slice(0, 5);
    if (sel.length) {
      const pageN = sel[0].page.n;
      out.push(
        `The user has selected on page ${pageN}: ${sel
          .map((h) => `[${h.line.id}] ${quote(h.line.text, 60)} (${h.line.kind}${h.line.speakerId ? `, ${nameOf(doc, h.line.speakerId) ?? 'unknown'}` : ''})`)
          .join('; ')}${ids.length > sel.length ? ' …' : ''}.`
      );
    }
  }
  return out;
};

export const letteringToolGroup: ToolGroup = {
  id: 'lettering',
  priority: 20,
  when: (ctx) => {
    const doc = ctx.session.doc;
    return doc.format.lettering === 'overlay' && doc.pages.length > 0;
  },
  tools: (ctx, turn) => [setLetteringStyleTool(ctx, turn), restyleBalloonsTool(ctx, turn), arrangeBalloonsTool(ctx, turn)],
  promptRules: () => LETTERING_RULES,
  summaryLines: (doc, turn) => summaryFor(doc, turn),
  activity: {
    set_lettering_style: 'Changing the lettering style',
    restyle_balloons: 'Restyling balloons',
    arrange_balloons: 'Arranging balloons'
  }
};
