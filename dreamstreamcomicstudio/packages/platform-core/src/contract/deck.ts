/**
 * FROZEN CONTRACT (platform contract v1, plan §5.2): DeckSpec v1 and its ops. Types and caps only; the schema,
 * the ops, `overlapCheck` and `migrate()` live in `src/models/deck/**`. Additive changes only.
 *
 * Every element is placed by an explicit rectangle in slide fractions, so layout never depends on an engine's
 * collision avoidance; export is refused while two `content` elements overlap (`overlapCheck`).
 */
import type { AssetRef, HexColor, OpBase, OpResult, Run, TableRow } from './schema.js';

export type DeckSize = '16:9' | '4:3';

export type SlideLayout = 'title' | 'section' | 'content' | 'image-full' | 'two-col' | 'end';

/** `background` elements may sit under others; `content` elements may not overlap each other. */
export type DeckLayer = 'background' | 'content';

/** `[x, y, w, h]` as fractions of the slide, each 0–1, with `x + w ≤ 1` and `y + h ≤ 1`. */
export type DeckRect = [number, number, number, number];

export interface DeckTheme {
  preset: 'light' | 'dark' | 'brand';
  background?: HexColor;
  text?: HexColor;
  accent?: HexColor;
}

export interface DeckSpec {
  v: 1;
  /** Revision: absent means 0; `applyDeckOps` bumps it (contract/schema.ts `OpBase`). */
  rev?: number;
  title: string;
  size: DeckSize;
  theme: DeckTheme;
  /** At most `DECK_LIMITS.slides`. */
  slides: Slide[];
}

export interface Slide {
  id: string;
  layout: SlideLayout;
  /** Speaker notes. */
  notes?: string;
  /** At most `DECK_LIMITS.elementsPerSlide`. */
  elements: DeckElement[];
}

export type DeckElement = DeckText | DeckImage | DeckShape | DeckTable | DeckChart;

export type DeckElementKind = DeckElement['kind'];

export type TextRole = 'title' | 'subtitle' | 'body' | 'caption' | 'quote';

export interface DeckParagraph {
  runs: Run[];
  bullet?: boolean;
  /** 0–`MODEL_LIMITS.listIndentMax`. */
  indent?: number;
}

export interface DeckText {
  kind: 'text';
  id: string;
  rect: DeckRect;
  layer: DeckLayer;
  role?: TextRole;
  align?: 'left' | 'center' | 'right';
  /** Points, `DECK_LIMITS.fontSizeMin`–`DECK_LIMITS.fontSizeMax`; absent lets the theme size it by role. */
  fontSize?: number;
  paragraphs: DeckParagraph[];
}

export interface DeckImage {
  kind: 'image';
  id: string;
  rect: DeckRect;
  layer: DeckLayer;
  ref: AssetRef;
  alt: string;
  fit?: 'contain' | 'cover';
}

export type ShapeType = 'rect' | 'roundRect' | 'ellipse' | 'line';

export interface DeckShape {
  kind: 'shape';
  id: string;
  rect: DeckRect;
  layer: DeckLayer;
  shape: ShapeType;
  fill?: HexColor;
  stroke?: HexColor;
}

export interface DeckTable {
  kind: 'table';
  id: string;
  rect: DeckRect;
  layer: DeckLayer;
  header?: boolean;
  rows: TableRow[];
}

export type ChartType = 'bar' | 'line' | 'pie';

/** One series: one value per category. */
export interface ChartSeries {
  name: string;
  values: number[];
}

export interface DeckChart {
  kind: 'chart';
  id: string;
  rect: DeckRect;
  layer: DeckLayer;
  chart: ChartType;
  title?: string;
  categories: string[];
  series: ChartSeries[];
}

/** Two `content` elements of one slide whose rects overlap; `area` is the overlap as a fraction of the slide. */
export interface OverlapPair {
  a: string;
  b: string;
  area: number;
}

// ── Ops ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Insert `slide` at `index` (absent appends). */
export interface DeckAddSlideOp extends OpBase {
  op: 'add_slide';
  index?: number;
  slide: Slide;
}

/** Replace slide `slideId` with `slide` (same id). */
export interface DeckUpdateSlideOp extends OpBase {
  op: 'update_slide';
  slideId: string;
  slide: Slide;
}

export interface DeckRemoveSlideOp extends OpBase {
  op: 'remove_slide';
  slideId: string;
}

/** Move slide `slideId` to `index` (its position after the move). */
export interface DeckMoveSlideOp extends OpBase {
  op: 'move_slide';
  slideId: string;
  index: number;
}

export interface DeckSetThemeOp extends OpBase {
  op: 'set_theme';
  theme: DeckTheme;
}

export type DeckOp = DeckAddSlideOp | DeckUpdateSlideOp | DeckRemoveSlideOp | DeckMoveSlideOp | DeckSetThemeOp;

export type DeckOpName = DeckOp['op'];

/** `applyDeckOps(deck, ops)`. */
export type DeckOpResult = OpResult<DeckSpec, DeckOp>;

// ── Caps ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const DECK_LIMITS = {
  title: 300,
  slides: 60,
  elementsPerSlide: 40,
  notes: 5000,
  paragraphs: 50,
  runsPerParagraph: 100,
  tableRows: 20,
  tableCols: 10,
  runsPerCell: 100,
  chartTitle: 200,
  chartCategories: 50,
  chartSeries: 8,
  /** A category or series name. */
  label: 100,
  fontSizeMin: 8,
  fontSizeMax: 120,
} as const;
