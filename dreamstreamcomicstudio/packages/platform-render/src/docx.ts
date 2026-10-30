/**
 * RichDoc v1 → DOCX (plan §5.2, W1.7) with `docx` (MIT, pinned exactly in the app's package.json).
 *
 * - **Styles come from the BrandKit** (`RenderBrand.docStyles`): body and heading fonts, colours and sizes, line
 *   spacing and link colour live in the file's style sheet (Normal, Heading 1–3, Hyperlink, Lead, Quote, Caption and
 *   the comic-script styles), so a reader who edits the file keeps the brand.
 * - **Page breaks are sections.** A section with `pageBreakBefore` starts with a next-page section break, any other
 *   with a continuous one; no paragraph is restyled to carry a break.
 * - **Nothing is fetched or read.** Images are `data:` images (a host asset id goes through the host's
 *   `resolveAsset`), checked by the contract's own rule; a link is written only when it is `https:` or `mailto:`
 *   (`isSafeHref`), otherwise its text stays and the link is dropped. Text is cleaned of characters XML cannot carry.
 *
 * Pure and environment-neutral: it returns the file's bytes; saving them is the host's job.
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  SectionType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { FileChild, IParagraphStyleOptions, IRunOptions, ISectionOptions, ParagraphChild } from 'docx';
import type { DocBlock, DocScript, RichDoc } from '../../platform-core/src/contract/richdoc.js';
import { RICHDOC_LIMITS } from '../../platform-core/src/contract/richdoc.js';
import type { Run, TableRow as DocTableRow } from '../../platform-core/src/contract/schema.js';
import { MODEL_LIMITS } from '../../platform-core/src/contract/schema.js';
import { isSafeHref } from '../../platform-core/src/schema/index.js';
import { RenderError } from './errors.js';
import type { ImageOptions, PreparedImage } from './images.js';
import { imagePreparer } from './images.js';
import type { FontFamilyResolver, RenderBrand } from './style.js';
import { brandOf, cleanText, fontFamilyOf, hexOf, sizeOf } from './style.js';

export interface DocxRenderOptions extends ImageOptions {
  /** A BrandKit (or its `docStyles` part); default `DEFAULT_RENDER_BRAND`. */
  brand?: RenderBrand;
  /** Font-registry id → family name; see `fontFamilyOf`. */
  fontFamily?: FontFamilyResolver;
  /** Default `'letter'` (8.5 × 11 in); `'a4'` is 210 × 297 mm. Margins are 1 in either way. */
  pageSize?: 'letter' | 'a4';
}

/** Twips (1/1440 in). */
const PAGE = {
  letter: { width: 12240, height: 15840 },
  a4: { width: 11906, height: 16838 },
} as const;
const MARGIN = 1440;
/** Images are measured in CSS pixels at 96 to the inch: 15 twips each. */
const TWIPS_PER_PX = 15;
const CODE_FONT = 'Courier New';
const FALLBACK_FONT = 'Calibri';

const BULLETS = 'ds-bullets';
const NUMBERS = 'ds-numbers';

export const DOCX_STYLE_IDS = ['Lead', 'Quote', 'Caption', 'ScriptScene', 'ScriptPanel', 'ScriptDialogue', 'ScriptSfx'] as const;

interface Ctx {
  bodyColor: string;
  mutedColor: string;
  accentColor: string;
  contentPx: number;
  maxImagePx: number;
  listInstance: number;
  panel: number;
  prepare: (ref: Parameters<ReturnType<typeof imagePreparer>>[0], where: string) => Promise<PreparedImage>;
}

/** Runs → docx run children: marks, line breaks, and `https:`/`mailto:` links (others keep their text, unlinked). */
const runChildren = (runs: Run[] | undefined, extra: IRunOptions = {}): ParagraphChild[] => {
  const out: ParagraphChild[] = [];
  if (!Array.isArray(runs)) return out;
  for (const run of runs.slice(0, RICHDOC_LIMITS.runsPerBlock)) {
    if (!run || typeof run !== 'object') continue;
    const text = cleanText(run.text).slice(0, MODEL_LIMITS.runText);
    if (!text) continue;
    const marks = Array.isArray(run.marks) ? run.marks : [];
    const href = run.link && typeof run.link.href === 'string' && isSafeHref(run.link.href) ? run.link.href : undefined;
    const base: IRunOptions = {
      ...extra,
      ...(marks.indexOf('b') !== -1 ? { bold: true } : {}),
      ...(marks.indexOf('i') !== -1 ? { italics: true } : {}),
      ...(marks.indexOf('u') !== -1 ? { underline: {} } : {}),
      ...(marks.indexOf('code') !== -1 ? { font: CODE_FONT } : {}),
      ...(href ? { style: 'Hyperlink' } : {}),
    };
    const pieces = text.split(/\r\n|\r|\n|\u2028|\u2029/);
    const textRuns = pieces.map((piece, i) => new TextRun({ ...base, text: piece, ...(i > 0 ? { break: 1 } : {}) }));
    if (href) out.push(new ExternalHyperlink({ link: href, children: textRuns }));
    else out.push(...textRuns);
  }
  return out;
};

/** `[0, 1, …, n - 1]`. */
const range = (n: number): number[] => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i);
  return out;
};

const label = (text: string, extra: IRunOptions = {}): TextRun => new TextRun({ ...extra, text, bold: true, allCaps: true });

const scriptParagraph = (block: DocScript, ctx: Ctx): Paragraph => {
  const speaker = cleanText(block.speaker).replace(/[\r\n\u2028\u2029]+/g, ' ').slice(0, RICHDOC_LIMITS.speaker).trim();
  switch (block.kind) {
    case 'scene':
      ctx.panel = 0;
      return new Paragraph({ style: 'ScriptScene', children: runChildren(block.runs) });
    case 'panel':
      ctx.panel += 1;
      return new Paragraph({ style: 'ScriptPanel', children: [label(`Panel ${ctx.panel}`), new TextRun({ text: '  ' }), ...runChildren(block.runs)] });
    case 'dialogue':
      return new Paragraph({ style: 'ScriptDialogue', children: [...(speaker ? [label(speaker), new TextRun({ text: ': ' })] : []), ...runChildren(block.runs)] });
    case 'caption':
      return new Paragraph({ style: 'ScriptDialogue', children: [label(speaker ? `Caption (${speaker})` : 'Caption'), new TextRun({ text: ': ' }), ...runChildren(block.runs, { italics: true })] });
    case 'sfx':
    default:
      return new Paragraph({ style: 'ScriptSfx', children: [label('SFX'), new TextRun({ text: ': ' }), ...runChildren(block.runs, { bold: true, allCaps: true })] });
  }
};

const tableOf = (rows: DocTableRow[], header: boolean, ctx: Ctx): Table | null => {
  const kept = rows.slice(0, RICHDOC_LIMITS.tableRows).filter((r) => r && Array.isArray(r.cells));
  const cols = Math.min(RICHDOC_LIMITS.tableCols, kept.reduce((n, r) => Math.max(n, r.cells.length), 0));
  if (!kept.length || !cols) return null;
  const width = Math.floor((ctx.contentPx * TWIPS_PER_PX) / cols);
  const border = { style: BorderStyle.SINGLE, size: 4, color: ctx.mutedColor };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: range(cols).map(() => width),
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: kept.map(
      (row, ri) =>
        new TableRow({
          tableHeader: header && ri === 0,
          children: range(cols).map((ci) => {
            const cell = row.cells[ci];
            const isHead = header && ri === 0;
            return new TableCell({
              width: { size: width, type: WidthType.DXA },
              ...(isHead ? { shading: { fill: 'F2F1EE', color: 'auto' } } : {}),
              children: [new Paragraph({ children: runChildren(cell && cell.runs ? cell.runs.slice(0, RICHDOC_LIMITS.runsPerCell) : [], isHead ? { bold: true } : {}) })],
            });
          }),
        }),
    ),
  });
};

const imageParagraphs = async (block: Extract<DocBlock, { type: 'image' }>, ctx: Ctx, where: string): Promise<Paragraph[]> => {
  const img = await ctx.prepare(block.ref, where);
  const natW = img.width || ctx.contentPx;
  const natH = img.height || Math.round(natW * 0.75);
  const fraction = typeof block.width === 'number' && isFinite(block.width) ? Math.max(RICHDOC_LIMITS.imageWidthMin, Math.min(1, block.width)) : undefined;
  let w = fraction !== undefined ? ctx.contentPx * fraction : Math.min(natW, ctx.contentPx);
  let h = (w * natH) / natW;
  if (h > ctx.maxImagePx) {
    w = (w * ctx.maxImagePx) / h;
    h = ctx.maxImagePx;
  }
  const alt = cleanText(block.alt).slice(0, MODEL_LIMITS.alt);
  const caption = cleanText(block.caption).slice(0, RICHDOC_LIMITS.caption);
  const out = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      ...(caption ? { keepNext: true } : {}),
      children: [
        new ImageRun({
          type: img.mime === 'image/png' ? 'png' : 'jpg',
          data: img.bytes,
          transformation: { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) },
          altText: { name: alt.slice(0, 100) || 'Image', description: alt, title: alt.slice(0, 100) },
        }),
      ],
    }),
  ];
  if (caption) out.push(new Paragraph({ style: 'Caption', alignment: AlignmentType.CENTER, children: runChildren([{ text: caption }]) }));
  return out;
};

const blockChildren = async (block: DocBlock, ctx: Ctx, where: string): Promise<FileChild[]> => {
  if (!block || typeof block !== 'object') return [];
  switch (block.type) {
    case 'heading': {
      ctx.panel = 0;
      const level = block.level === 1 ? HeadingLevel.HEADING_1 : block.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      return [new Paragraph({ heading: level, children: runChildren(block.runs) })];
    }
    case 'paragraph': {
      const style = block.style === 'lead' ? 'Lead' : block.style === 'quote' ? 'Quote' : block.style === 'caption' ? 'Caption' : undefined;
      return [new Paragraph({ ...(style ? { style } : {}), children: runChildren(block.runs) })];
    }
    case 'list': {
      const instance = ++ctx.listInstance;
      const items = Array.isArray(block.items) ? block.items.slice(0, RICHDOC_LIMITS.listItems) : [];
      return items.map(
        (item) =>
          new Paragraph({
            numbering: {
              reference: block.ordered ? NUMBERS : BULLETS,
              level: Math.max(0, Math.min(MODEL_LIMITS.listIndentMax, Math.floor(Number(item && item.indent) || 0))),
              instance,
            },
            children: runChildren(item && item.runs),
          }),
      );
    }
    case 'table': {
      const table = tableOf(Array.isArray(block.rows) ? block.rows : [], !!block.header, ctx);
      // A paragraph after the table keeps two adjacent tables apart and gives Word a place for the cursor.
      return table ? [table, new Paragraph({ children: [] })] : [];
    }
    case 'image':
      return imageParagraphs(block, ctx, where);
    case 'divider':
      return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ctx.mutedColor, space: 1 } }, children: [] })];
    case 'script':
      return [scriptParagraph(block, ctx)];
    default:
      return [];
  }
};

const paragraphStyles = (b: RenderBrand, fonts: { heading: string; body: string }): IParagraphStyleOptions[] => {
  const d = b.docStyles;
  const muted = hexOf(d.mutedColor, '67635A');
  const accent = hexOf(d.accentColor, 'D97757');
  const sz = (n: unknown, f: number): number => Math.round(sizeOf(n, f, 4, 200) * 2);
  const style = (id: string, name: string, run: IParagraphStyleOptions['run'], paragraph: IParagraphStyleOptions['paragraph']): IParagraphStyleOptions => ({
    id,
    name,
    basedOn: 'Normal',
    next: 'Normal',
    quickFormat: true,
    run,
    paragraph,
  });
  return [
    style('Lead', 'Lead', { size: sz(d.sizes && d.sizes.lead, 13) }, { spacing: { after: 160 } }),
    style('Quote', 'Quote', { italics: true, color: muted }, { indent: { left: 720 }, border: { left: { style: BorderStyle.SINGLE, size: 18, color: accent, space: 12 } } }),
    style('Caption', 'Caption', { size: sz(d.sizes && d.sizes.caption, 9), color: muted, italics: true }, { spacing: { before: 60, after: 160 } }),
    style('ScriptScene', 'Script Scene', { bold: true, allCaps: true, font: fonts.heading }, { keepNext: true, spacing: { before: 240, after: 120 } }),
    style('ScriptPanel', 'Script Panel', {}, { keepNext: true, spacing: { before: 120, after: 80 } }),
    style('ScriptDialogue', 'Script Dialogue', {}, { indent: { left: 1440, right: 720 }, spacing: { after: 80 } }),
    style('ScriptSfx', 'Script SFX', { color: accent }, { indent: { left: 1440 }, spacing: { after: 80 } }),
  ];
};

const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

/**
 * RichDoc v1 → the bytes of a `.docx` file. Throws `RenderError`: `invalid` (not a RichDoc v1), `too-large` (over the
 * contract's section or block caps, or an image over 5 MB), `blocked` (an image that is not a `data:` image),
 * `asset-missing` (an asset id the host cannot resolve), `unsupported` (WebP without a transcoder).
 */
export const renderDocx = async (doc: RichDoc, opts: DocxRenderOptions = {}): Promise<Uint8Array> => {
  if (!doc || typeof doc !== 'object' || doc.v !== 1 || !Array.isArray(doc.sections)) throw new RenderError('invalid', 'This is not a RichDoc v1 document.');
  if (doc.sections.length > RICHDOC_LIMITS.sections) throw new RenderError('too-large', `A document has at most ${RICHDOC_LIMITS.sections} sections.`);
  const brand = brandOf(opts.brand);
  const d = brand.docStyles;
  const fonts = {
    heading: fontFamilyOf(d.headingFont, opts.fontFamily, FALLBACK_FONT),
    body: fontFamilyOf(d.bodyFont, opts.fontFamily, FALLBACK_FONT),
  };
  const page = PAGE[opts.pageSize === 'a4' ? 'a4' : 'letter'];
  const contentPx = Math.floor((page.width - 2 * MARGIN) / TWIPS_PER_PX);
  const ctx: Ctx = {
    bodyColor: hexOf(d.bodyColor, '1A1915'),
    mutedColor: hexOf(d.mutedColor, '67635A'),
    accentColor: hexOf(d.accentColor, 'D97757'),
    contentPx,
    maxImagePx: Math.floor((page.height - 2 * MARGIN) / TWIPS_PER_PX) - 48,
    listInstance: 0,
    panel: 0,
    prepare: imagePreparer(opts),
  };

  const sections: ISectionOptions[] = [];
  for (let si = 0; si < doc.sections.length; si++) {
    const section = doc.sections[si];
    if (!section || !Array.isArray(section.blocks)) throw new RenderError('invalid', `Section ${si + 1} has no blocks list.`);
    if (section.blocks.length > RICHDOC_LIMITS.blocksPerSection) throw new RenderError('too-large', `A section has at most ${RICHDOC_LIMITS.blocksPerSection} blocks.`);
    ctx.panel = 0;
    const children: FileChild[] = [];
    for (let bi = 0; bi < section.blocks.length; bi++) {
      children.push(...(await blockChildren(section.blocks[bi], ctx, `Section ${si + 1}, block ${bi + 1}`)));
    }
    if (!children.length) children.push(new Paragraph({ children: [] }));
    sections.push({
      properties: {
        ...(si > 0 ? { type: section.pageBreakBefore ? SectionType.NEXT_PAGE : SectionType.CONTINUOUS } : {}),
        page: { size: { width: page.width, height: page.height }, margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN } },
      },
      children,
    });
  }
  if (!sections.length) sections.push({ properties: { page: { size: { width: page.width, height: page.height } } }, children: [new Paragraph({ children: [] })] });

  const meta = doc.meta && typeof doc.meta === 'object' ? doc.meta : {};
  const oneLine = (v: unknown, max: number): string => cleanText(v).replace(/[\r\n\u2028\u2029\t]+/g, ' ').slice(0, max).trim();
  const author = oneLine(meta.author, RICHDOC_LIMITS.metaText) || oneLine(brand.name, 100) || 'DreamStream';
  const lang = typeof meta.lang === 'string' && LANG.test(meta.lang) ? meta.lang : undefined;
  const keywords = Array.isArray(meta.keywords) ? meta.keywords.slice(0, RICHDOC_LIMITS.keywords).map((k) => oneLine(k, RICHDOC_LIMITS.keyword)).filter(Boolean).join(', ') : '';
  const heading = (size: number, fallback: number) => ({
    run: { font: fonts.heading, size: Math.round(sizeOf(size, fallback, 4, 200) * 2), bold: true, color: hexOf(d.headingColor, ctx.bodyColor) },
    paragraph: { keepNext: true, keepLines: true, spacing: { before: 240, after: 120 } },
  });
  const sizes = d.sizes || ({} as RenderBrand['docStyles']['sizes']);

  const file = new Document({
    title: oneLine(doc.title, RICHDOC_LIMITS.title) || 'Untitled',
    creator: author,
    lastModifiedBy: author,
    ...(meta.subject ? { subject: oneLine(meta.subject, RICHDOC_LIMITS.metaText) } : {}),
    ...(keywords ? { keywords } : {}),
    styles: {
      default: {
        document: {
          run: { font: fonts.body, size: Math.round(sizeOf(sizes.body, 11, 4, 200) * 2), color: ctx.bodyColor, ...(lang ? { language: { value: lang } } : {}) },
          paragraph: { spacing: { line: Math.round(240 * sizeOf(d.lineSpacing, 1.15, 0.5, 4)), after: 120 } },
        },
        heading1: heading(sizes.h1, 24),
        heading2: heading(sizes.h2, 18),
        heading3: heading(sizes.h3, 14),
        hyperlink: { run: { color: hexOf(d.linkColor, 'A0472A'), underline: {} } },
      },
      paragraphStyles: paragraphStyles(brand, fonts),
    },
    numbering: {
      config: [
        {
          reference: BULLETS,
          levels: [0, 1, 2].map((level) => ({
            level,
            format: LevelFormat.BULLET,
            text: ['\u2022', '\u25E6', '\u25AA'][level],
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
        {
          reference: NUMBERS,
          levels: [0, 1, 2].map((level) => ({
            level,
            format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level],
            text: `%${level + 1}.`,
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections,
  });
  return new Uint8Array(await Packer.toArrayBuffer(file));
};
