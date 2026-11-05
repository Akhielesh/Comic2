/**
 * Types for the vendored, patched PptxGenJS 4.0.1 (`pptxgen.es.js`, see PATCHES.md). Ours, not upstream's: only the
 * API `src/pptx.ts` uses, written against the PATCHED behaviour — images take `data` only (no `path`), there is no
 * `addMedia` and no `writeFile`, and hyperlinks are `https:` / `mailto:` only. Sizes are inches unless noted.
 */

export type HexNoHash = string;

export interface Hyperlink {
  /** `https://…` or `mailto:…` (anything else throws `blocked`). */
  url: string;
  tooltip?: string;
}

export interface TextRunOptions {
  bold?: boolean;
  italic?: boolean;
  underline?: { style?: 'sng' | 'none' };
  fontFace?: string;
  fontSize?: number;
  color?: HexNoHash;
  hyperlink?: Hyperlink;
  /** Ends the paragraph after this run. */
  breakLine?: boolean;
  /** A line break (`<a:br/>`) before this run, inside the same paragraph. */
  softBreakBefore?: boolean;
  bullet?: boolean | { indent?: number; type?: 'number' };
  indentLevel?: number;
  align?: 'left' | 'center' | 'right' | 'justify';
  paraSpaceAfter?: number;
}

export interface TextRun {
  text: string;
  options?: TextRunOptions;
}

export interface PositionOptions {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextBoxOptions extends PositionOptions {
  fontFace?: string;
  fontSize?: number;
  color?: HexNoHash;
  align?: 'left' | 'center' | 'right' | 'justify';
  valign?: 'top' | 'middle' | 'bottom';
  italic?: boolean;
  bold?: boolean;
  /** Inset in points: `[left, right, bottom, top]`. */
  margin?: number | [number, number, number, number];
  fit?: 'none' | 'shrink' | 'resize';
  objectName?: string;
}

export interface ImageOptions extends PositionOptions {
  /** `data:image/(png|jpeg|webp);base64,…` only. */
  data: string;
  altText?: string;
  sizing?: { type: 'contain' | 'cover' | 'crop'; w: number; h: number; x?: number; y?: number };
  objectName?: string;
}

export interface ShapeOptions extends PositionOptions {
  fill?: { color: HexNoHash; transparency?: number };
  line?: { color: HexNoHash; width?: number };
  rectRadius?: number;
  objectName?: string;
}

export interface TableCellOptions {
  bold?: boolean;
  color?: HexNoHash;
  fill?: { color: HexNoHash };
  fontFace?: string;
  fontSize?: number;
}

export interface TableCell {
  text: TextRun[] | string;
  options?: TableCellOptions;
}

export interface TableOptions extends PositionOptions {
  colW?: number[];
  fontFace?: string;
  fontSize?: number;
  color?: HexNoHash;
  border?: { type?: 'solid' | 'none'; pt?: number; color?: HexNoHash };
  autoPage?: boolean;
  valign?: 'top' | 'middle' | 'bottom';
  margin?: number;
  objectName?: string;
}

export interface ChartSeriesData {
  name: string;
  labels: string[];
  values: number[];
}

export interface ChartOptions extends PositionOptions {
  title?: string;
  showTitle?: boolean;
  titleColor?: HexNoHash;
  titleFontFace?: string;
  titleFontSize?: number;
  showLegend?: boolean;
  legendPos?: 'b' | 't' | 'l' | 'r' | 'tr';
  legendColor?: HexNoHash;
  legendFontFace?: string;
  chartColors?: HexNoHash[];
  barDir?: 'bar' | 'col';
  catAxisLabelColor?: HexNoHash;
  valAxisLabelColor?: HexNoHash;
  catAxisLabelFontFace?: string;
  valAxisLabelFontFace?: string;
  showPercent?: boolean;
  showValue?: boolean;
  dataLabelColor?: HexNoHash;
  objectName?: string;
}

export type ShapeName = 'rect' | 'roundRect' | 'ellipse' | 'line';
export type ChartName = 'bar' | 'line' | 'pie';

export interface Slide {
  background?: { color?: HexNoHash; data?: string };
  addText(text: TextRun[] | string, options: TextBoxOptions): Slide;
  addImage(options: ImageOptions): Slide;
  addShape(shape: ShapeName, options: ShapeOptions): Slide;
  addTable(rows: TableCell[][], options: TableOptions): Slide;
  addChart(type: ChartName, data: ChartSeriesData[], options: ChartOptions): Slide;
  addNotes(notes: string): Slide;
}

export interface WriteOptions {
  outputType: 'uint8array' | 'arraybuffer' | 'base64' | 'blob' | 'nodebuffer';
  compression?: boolean;
}

export default class PptxGenJS {
  /** `LAYOUT_16x9` (10 × 5.625 in) or `LAYOUT_4x3` (10 × 7.5 in). */
  layout: string;
  title: string;
  author: string;
  company: string;
  subject: string;
  theme: { headFontFace?: string; bodyFontFace?: string };
  addSlide(): Slide;
  write(options: WriteOptions): Promise<unknown>;
}
