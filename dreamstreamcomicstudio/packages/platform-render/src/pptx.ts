/**
 * DeckSpec v1 → PPTX (plan §5.2, W1.7) with the vendored, patched PptxGenJS 4.0.1 (src/vendor/pptxgenjs, PATCHES.md).
 *
 * - **Export is refused while content elements overlap.** No engine moves things apart, so a deck whose `content`
 *   elements collide throws `RenderError('overlap')` listing every pair, before anything is drawn. The rule is
 *   platform-core's `overlapCheck` (models/deck); a host can pass that function itself as `overlapCheck`.
 * - **Every element is placed by its own rectangle** (slide fractions), `background` elements under `content` ones.
 * - **The theme comes from the deck and the BrandKit:** `preset: 'brand'` takes the kit's deck theme, `light` and
 *   `dark` are fixed, and the deck's own `background` / `text` / `accent` win over both. Titles use the kit's title
 *   font, everything else its body font.
 * - **Nothing is fetched or read.** Images are `data:` images (host asset ids through `resolveAsset`), checked by the
 *   contract's rule; the vendored library itself also throws `blocked` on any `path`, URL, SVG or media. Links are
 *   kept only when `https:` or `mailto:`.
 */
import type { DeckElement, DeckImage, DeckParagraph, DeckRect, DeckSpec, DeckText, OverlapPair, Slide } from '../../platform-core/src/contract/deck.js';
import { DECK_LIMITS } from '../../platform-core/src/contract/deck.js';
import type { TableRow } from '../../platform-core/src/contract/schema.js';
import { MODEL_LIMITS } from '../../platform-core/src/contract/schema.js';
import { isSafeHref } from '../../platform-core/src/schema/index.js';
import type { SlideOverlap } from './errors.js';
import { RenderError } from './errors.js';
import type { ImageOptions, PreparedImage } from './images.js';
import { imagePreparer } from './images.js';
import type { FontFamilyResolver, RenderBrand } from './style.js';
import { brandOf, cleanText, fontFamilyOf, hexOf, sizeOf, textOn } from './style.js';
import PptxGenJS from './vendor/pptxgenjs/pptxgen.es.js';
import type { Slide as PptSlide, TableCell as PptCell, TextRun as PptRun, TextRunOptions } from './vendor/pptxgenjs/pptxgen.es.js';

export interface PptxRenderOptions extends ImageOptions {
  /** A BrandKit (or its `deckTheme` part); default `DEFAULT_RENDER_BRAND`. */
  brand?: RenderBrand;
  /** Font-registry id → family name; see `fontFamilyOf`. */
  fontFamily?: FontFamilyResolver;
  /** The overlap rule; default `contentOverlaps` (the same rule as platform-core's `overlapCheck`). */
  overlapCheck?: (slide: Slide) => OverlapPair[];
}

// ── Overlaps (the rule of platform-core models/deck `overlapCheck`) ─────────────────────────────────────────────

const E = 1e-6;

const rectOf = (el: unknown): DeckRect | null => {
  const r = el && typeof el === 'object' ? (el as { rect?: unknown }).rect : undefined;
  if (!Array.isArray(r) || r.length !== 4) return null;
  for (const n of r) if (typeof n !== 'number' || !isFinite(n)) return null;
  return r as DeckRect;
};

const isLine = (r: DeckRect): boolean => r[2] <= E || r[3] <= E;
const shared = (lo1: number, len1: number, lo2: number, len2: number): number => Math.min(lo1 + len1, lo2 + len2) - Math.max(lo1, lo2);

const crosses = (line: DeckRect, box: DeckRect): boolean => {
  const [lx, ly, lw, lh] = line;
  const [bx, by, bw, bh] = box;
  if (lw <= E && lh <= E) return false;
  if (lh <= E) return ly > by + E && ly < by + bh - E && shared(lx, lw, bx, bw) > E;
  return lx > bx + E && lx < bx + bw - E && shared(ly, lh, by, bh) > E;
};

const overlapOf = (a: DeckRect, b: DeckRect): number | null => {
  const lineA = isLine(a);
  const lineB = isLine(b);
  if (lineA && lineB) return null;
  if (lineA) return crosses(a, b) ? 0 : null;
  if (lineB) return crosses(b, a) ? 0 : null;
  const w = shared(a[0], a[2], b[0], b[2]);
  const h = shared(a[1], a[3], b[1], b[3]);
  return w > E && h > E ? w * h : null;
};

/**
 * Every pair of `content` elements on `slide` whose rects overlap (element order, `a` before `b`), with the overlap's
 * area as a fraction of the slide. `background` elements never count; a line (a rect with no width or no height)
 * overlaps a box it runs through, with area 0; edges that only touch do not overlap. Never throws.
 */
export const contentOverlaps = (slide: Slide): OverlapPair[] => {
  const out: OverlapPair[] = [];
  if (!slide || !Array.isArray(slide.elements)) return out;
  const boxes: { id: string; rect: DeckRect }[] = [];
  for (const el of slide.elements as unknown[]) {
    const rect = rectOf(el);
    const e = el as { layer?: unknown; id?: unknown };
    if (rect && e.layer === 'content' && typeof e.id === 'string') boxes.push({ id: e.id, rect });
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const area = overlapOf(boxes[i].rect, boxes[j].rect);
      if (area !== null) out.push({ a: boxes[i].id, b: boxes[j].id, area });
    }
  }
  return out;
};

// ── Theme ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface Theme {
  background: string;
  text: string;
  accent: string;
  muted: string;
  titleFont: string;
  bodyFont: string;
}

const PRESETS = {
  light: { background: 'FFFFFF', text: '1A1915' },
  dark: { background: '1A1915', text: 'F5F4EF' },
} as const;

/** `a` mixed toward `b` by `t` (0–1); both `RRGGBB`. */
const mix = (a: string, b: string, t: number): string => {
  let out = '';
  for (let i = 0; i < 6; i += 2) {
    const v = Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t);
    out += `0${v.toString(16)}`.slice(-2);
  }
  return out.toUpperCase();
};

const themeOf = (deck: DeckSpec, brand: RenderBrand, resolve: FontFamilyResolver | undefined): Theme => {
  const kit = brand.deckTheme.theme;
  const t = deck.theme && typeof deck.theme === 'object' ? deck.theme : { preset: 'light' as const };
  const base = t.preset === 'brand' ? { background: hexOf(kit.background, 'FFFFFF'), text: hexOf(kit.text, '1A1915') } : PRESETS[t.preset === 'dark' ? 'dark' : 'light'];
  const background = hexOf(t.background, base.background);
  const text = hexOf(t.text, base.text);
  return {
    background,
    text,
    accent: hexOf(t.accent, hexOf(kit.accent, 'D97757')),
    muted: mix(text, background, 0.35),
    titleFont: fontFamilyOf(brand.deckTheme.titleFont, resolve, 'Calibri'),
    bodyFont: fontFamilyOf(brand.deckTheme.bodyFont, resolve, 'Calibri'),
  };
};

/** Theme-independent series colours after the accent (enough for every pie slice: `DECK_LIMITS.chartCategories`). */
const PALETTE = ['2F6F9F', 'E0A43A', '5B8C5A', '8C5A8C', 'C2554B', '4F9C9C', '7A6A58', 'A3A847'];

const chartColors = (accent: string): string[] => {
  const out = [accent];
  while (out.length < DECK_LIMITS.chartCategories) out.push(PALETTE[(out.length - 1) % PALETTE.length]);
  return out;
};

// ── Elements ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Slide size in inches (PptxGenJS `LAYOUT_16x9` / `LAYOUT_4x3`). */
const SLIDE = { '16:9': { w: 10, h: 5.625, layout: 'LAYOUT_16x9' }, '4:3': { w: 10, h: 7.5, layout: 'LAYOUT_4x3' } } as const;

const ROLE_SIZE = { title: 36, subtitle: 22, body: 18, caption: 12, quote: 24 } as const;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** A shape name for PowerPoint's selection pane: the element's kind and id, cleaned. */
const nameOf = (kind: string, id: unknown): string => `${kind} ${cleanText(String(id)).replace(/[^A-Za-z0-9 _.:-]/g, '')}`.slice(0, 80);

/** A rect in inches, clamped inside the slide. */
const box = (rect: DeckRect, W: number, H: number): { x: number; y: number; w: number; h: number } => {
  const x = clamp01(rect[0]);
  const y = clamp01(rect[1]);
  const w = Math.min(clamp01(rect[2]), 1 - x);
  const h = Math.min(clamp01(rect[3]), 1 - y);
  const r = (n: number): number => Math.round(n * 10000) / 10000;
  return { x: r(x * W), y: r(y * H), w: r(w * W), h: r(h * H) };
};

/** One paragraph's runs: marks, soft line breaks, safe links; bullet and indent on its first run only. */
const paragraphRuns = (runs: DeckParagraph['runs'] | undefined, first: TextRunOptions, last: boolean): PptRun[] => {
  const out: PptRun[] = [];
  const list = Array.isArray(runs) ? runs.slice(0, DECK_LIMITS.runsPerParagraph) : [];
  for (const run of list) {
    if (!run || typeof run !== 'object') continue;
    const text = cleanText(run.text).slice(0, MODEL_LIMITS.runText);
    if (!text) continue;
    const marks = Array.isArray(run.marks) ? run.marks : [];
    const href = run.link && typeof run.link.href === 'string' && isSafeHref(run.link.href) ? run.link.href : undefined;
    const pieces = text.split(/\r\n|\r|\n|\u2028|\u2029/);
    pieces.forEach((piece, i) => {
      const options: TextRunOptions = {};
      if (marks.indexOf('b') !== -1) options.bold = true;
      if (marks.indexOf('i') !== -1) options.italic = true;
      if (marks.indexOf('u') !== -1) options.underline = { style: 'sng' };
      if (marks.indexOf('code') !== -1) options.fontFace = 'Courier New';
      if (href) options.hyperlink = { url: href };
      if (i > 0) options.softBreakBefore = true;
      out.push({ text: piece || ' ', options });
    });
  }
  if (!out.length) return out;
  out[0].options = { ...first, ...out[0].options };
  if (!last) out[out.length - 1].options = { ...out[out.length - 1].options, breakLine: true };
  return out;
};

const addText = (slide: PptSlide, el: DeckText, theme: Theme, W: number, H: number): void => {
  const role = el.role || 'body';
  const paragraphs = Array.isArray(el.paragraphs) ? el.paragraphs.slice(0, DECK_LIMITS.paragraphs) : [];
  const runs: PptRun[] = [];
  paragraphs.forEach((p, i) => {
    const first: TextRunOptions = {};
    if (p && p.bullet) first.bullet = true;
    const indent = p && typeof p.indent === 'number' ? Math.max(0, Math.min(MODEL_LIMITS.listIndentMax, Math.floor(p.indent))) : 0;
    if (indent) first.indentLevel = indent;
    runs.push(...paragraphRuns(p && p.runs, first, i === paragraphs.length - 1));
  });
  if (!runs.length) return;
  const head = role === 'title' || role === 'subtitle';
  slide.addText(runs, {
    ...box(el.rect, W, H),
    fontFace: head ? theme.titleFont : theme.bodyFont,
    fontSize: sizeOf(el.fontSize, ROLE_SIZE[role] || ROLE_SIZE.body, DECK_LIMITS.fontSizeMin, DECK_LIMITS.fontSizeMax),
    color: role === 'caption' ? theme.muted : theme.text,
    align: el.align === 'center' || el.align === 'right' ? el.align : 'left',
    valign: head || role === 'quote' ? 'middle' : 'top',
    ...(role === 'title' ? { bold: true } : {}),
    ...(role === 'quote' ? { italic: true } : {}),
    margin: [4, 4, 2, 2],
    fit: 'shrink',
    objectName: nameOf('text', el.id),
  });
};

const addImage = (slide: PptSlide, el: DeckImage, img: PreparedImage, W: number, H: number): void => {
  const b = box(el.rect, W, H);
  if (b.w <= 0 || b.h <= 0) return;
  const alt = cleanText(el.alt).slice(0, MODEL_LIMITS.alt);
  const name = nameOf('image', el.id);
  if (!img.width || !img.height) {
    slide.addImage({ data: img.dataUri, ...b, altText: alt, objectName: name });
    return;
  }
  if (el.fit === 'cover') {
    const scale = Math.max(b.w / img.width, b.h / img.height);
    slide.addImage({ data: img.dataUri, x: b.x, y: b.y, w: img.width * scale, h: img.height * scale, sizing: { type: 'cover', w: b.w, h: b.h }, altText: alt, objectName: name });
    return;
  }
  const scale = Math.min(b.w / img.width, b.h / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  slide.addImage({ data: img.dataUri, x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h, altText: alt, objectName: name });
};

const tableCells = (rows: TableRow[], header: boolean, theme: Theme): PptCell[][] => {
  const kept = rows.slice(0, DECK_LIMITS.tableRows).filter((r) => r && Array.isArray(r.cells));
  const cols = Math.min(DECK_LIMITS.tableCols, kept.reduce((n, r) => Math.max(n, r.cells.length), 0));
  const onAccent = textOn(theme.accent);
  return kept.map((row, ri) => {
    const out: PptCell[] = [];
    for (let ci = 0; ci < cols; ci++) {
      const cell = row.cells[ci];
      const runs = paragraphRuns(cell && cell.runs ? cell.runs.slice(0, DECK_LIMITS.runsPerCell) : [], {}, true);
      const head = header && ri === 0;
      out.push({ text: runs.length ? runs : '', options: head ? { bold: true, fill: { color: theme.accent }, color: onAccent } : {} });
    }
    return out;
  });
};

const addElement = async (slide: PptSlide, el: DeckElement, theme: Theme, W: number, H: number, prepare: (el: DeckImage, where: string) => Promise<PreparedImage>, where: string): Promise<void> => {
  if (!el || typeof el !== 'object' || !rectOf(el)) return;
  switch (el.kind) {
    case 'text':
      addText(slide, el, theme, W, H);
      return;
    case 'image':
      addImage(slide, el, await prepare(el, where), W, H);
      return;
    case 'shape': {
      const b = box(el.rect, W, H);
      const name = nameOf('shape', el.id);
      if (el.shape === 'line' || isLine(el.rect)) {
        slide.addShape('line', { ...b, line: { color: hexOf(el.stroke, hexOf(el.fill, theme.accent)), width: 1.5 }, objectName: name });
        return;
      }
      const fill = el.fill ? hexOf(el.fill, theme.accent) : undefined;
      const stroke = el.stroke ? hexOf(el.stroke, theme.text) : undefined;
      const shape = el.shape === 'roundRect' || el.shape === 'ellipse' ? el.shape : 'rect';
      slide.addShape(shape, {
        ...b,
        ...(fill || !stroke ? { fill: { color: fill || theme.accent } } : {}),
        ...(stroke ? { line: { color: stroke, width: 1 } } : {}),
        ...(shape === 'roundRect' ? { rectRadius: Math.min(b.w, b.h) * 0.15 } : {}),
        objectName: name,
      });
      return;
    }
    case 'table': {
      const rows = tableCells(Array.isArray(el.rows) ? el.rows : [], !!el.header, theme);
      const cols = rows.length ? rows[0].length : 0;
      if (!rows.length || !cols) return;
      const b = box(el.rect, W, H);
      const colW = b.w / cols;
      slide.addTable(rows, {
        ...b,
        colW: rows[0].map(() => Math.round(colW * 10000) / 10000),
        fontFace: theme.bodyFont,
        fontSize: rows.length > 10 ? 11 : 14,
        color: theme.text,
        border: { type: 'solid', pt: 1, color: theme.muted },
        autoPage: false,
        valign: 'middle',
        objectName: nameOf('table', el.id),
      });
      return;
    }
    case 'chart': {
      const categories = (Array.isArray(el.categories) ? el.categories : []).slice(0, DECK_LIMITS.chartCategories).map((c) => cleanText(c).slice(0, DECK_LIMITS.label));
      const series = (Array.isArray(el.series) ? el.series : []).slice(0, el.chart === 'pie' ? 1 : DECK_LIMITS.chartSeries).map((sr, i) => ({
        name: cleanText(sr && sr.name).slice(0, DECK_LIMITS.label) || `Series ${i + 1}`,
        labels: categories,
        values: categories.map((_, ci) => {
          const v = sr && Array.isArray(sr.values) ? sr.values[ci] : 0;
          return typeof v === 'number' && isFinite(v) ? v : 0;
        }),
      }));
      if (!categories.length || !series.length) return;
      const title = cleanText(el.title).replace(/[\r\n]+/g, ' ').slice(0, DECK_LIMITS.chartTitle);
      slide.addChart(el.chart === 'line' || el.chart === 'pie' ? el.chart : 'bar', series, {
        ...box(el.rect, W, H),
        ...(title ? { title, showTitle: true, titleColor: theme.text, titleFontFace: theme.titleFont, titleFontSize: 14 } : { showTitle: false }),
        showLegend: series.length > 1 || el.chart === 'pie',
        legendPos: 'b',
        legendColor: theme.text,
        legendFontFace: theme.bodyFont,
        chartColors: chartColors(theme.accent),
        ...(el.chart === 'bar' ? { barDir: 'col' as const } : {}),
        ...(el.chart === 'pie' ? { showPercent: true, dataLabelColor: textOn(theme.accent) } : {}),
        catAxisLabelColor: theme.text,
        valAxisLabelColor: theme.text,
        catAxisLabelFontFace: theme.bodyFont,
        valAxisLabelFontFace: theme.bodyFont,
        objectName: nameOf('chart', el.id),
      });
      return;
    }
    default:
      return;
  }
};

/** A `blocked` error thrown by the vendored library (PATCHES.md) as our `RenderError`; anything else unchanged. */
const asRenderError = (err: unknown): unknown => {
  if (err instanceof RenderError) return err;
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e && e.code === 'blocked') return new RenderError('blocked', typeof e.message === 'string' ? e.message : 'blocked');
  return err;
};

/**
 * DeckSpec v1 → the bytes of a `.pptx` file. Throws `RenderError`: `overlap` (content elements collide; `overlaps`
 * lists every pair), `invalid` (not a DeckSpec v1), `too-large` (over the slide or element caps, an image over
 * 5 MB), `blocked` (an image that is not a `data:` image, or anything the vendored library refuses),
 * `asset-missing` and `unsupported` (as `renderDocx`).
 */
export const renderPptx = async (deck: DeckSpec, opts: PptxRenderOptions = {}): Promise<Uint8Array> => {
  if (!deck || typeof deck !== 'object' || deck.v !== 1 || !Array.isArray(deck.slides)) throw new RenderError('invalid', 'This is not a DeckSpec v1 deck.');
  if (deck.slides.length > DECK_LIMITS.slides) throw new RenderError('too-large', `A deck has at most ${DECK_LIMITS.slides} slides.`);
  const check = opts.overlapCheck || contentOverlaps;
  const overlaps: SlideOverlap[] = [];
  deck.slides.forEach((slide, i) => {
    if (!slide || !Array.isArray(slide.elements)) throw new RenderError('invalid', `Slide ${i + 1} has no elements list.`);
    if (slide.elements.length > DECK_LIMITS.elementsPerSlide) throw new RenderError('too-large', `A slide has at most ${DECK_LIMITS.elementsPerSlide} elements.`);
    for (const p of check(slide)) overlaps.push({ slideId: slide.id, slideNumber: i + 1, a: p.a, b: p.b, area: p.area });
  });
  if (overlaps.length) {
    const slides: number[] = [];
    for (const o of overlaps) if (slides.indexOf(o.slideNumber) === -1) slides.push(o.slideNumber);
    throw new RenderError('overlap', `Some things overlap on slide${slides.length > 1 ? 's' : ''} ${slides.join(', ')}. Move them apart, then export again.`, overlaps);
  }

  const brand = brandOf(opts.brand);
  const theme = themeOf(deck, brand, opts.fontFamily);
  const size = SLIDE[deck.size === '4:3' ? '4:3' : '16:9'];
  const prepareRef = imagePreparer(opts);
  const prepare = (el: DeckImage, where: string): Promise<PreparedImage> => prepareRef(el.ref, where);
  const oneLine = (v: unknown, max: number): string => cleanText(v).replace(/[\r\n\t]+/g, ' ').slice(0, max).trim();

  try {
    const pptx = new PptxGenJS();
    pptx.layout = size.layout;
    const title = oneLine(deck.title, DECK_LIMITS.title) || 'Untitled deck';
    const owner = oneLine(brand.name, 100) || 'DreamStream';
    pptx.title = title;
    pptx.subject = title;
    pptx.author = owner;
    pptx.company = owner;
    pptx.theme = { headFontFace: theme.titleFont, bodyFontFace: theme.bodyFont };
    for (let si = 0; si < deck.slides.length; si++) {
      const spec = deck.slides[si];
      const slide = pptx.addSlide();
      slide.background = { color: theme.background };
      const ordered = spec.elements.filter((el) => el && el.layer === 'background').concat(spec.elements.filter((el) => el && el.layer !== 'background'));
      for (let ei = 0; ei < ordered.length; ei++) {
        await addElement(slide, ordered[ei], theme, size.w, size.h, prepare, `Slide ${si + 1}, ${ordered[ei] && ordered[ei].kind ? ordered[ei].kind : 'element'} ${ordered[ei] && ordered[ei].id ? ordered[ei].id : ei + 1}`);
      }
      const notes = cleanText(spec.notes).slice(0, DECK_LIMITS.notes);
      if (notes) slide.addNotes(notes);
    }
    const out = await pptx.write({ outputType: 'uint8array', compression: true });
    if (!(out instanceof Uint8Array)) throw new RenderError('invalid', 'The presentation could not be written.');
    return out;
  } catch (err) {
    throw asRenderError(err);
  }
};
