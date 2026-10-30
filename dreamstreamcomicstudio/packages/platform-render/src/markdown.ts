/**
 * Markdown (CommonMark + GFM) → RichDoc v1, with unified + remark-parse + remark-gfm (all MIT, already in the
 * lockfile; unified and remark-parse are pinned exactly in the app's package.json).
 *
 * Untrusted Markdown (a model's answer, a pasted file) becomes data, never markup:
 * - **raw HTML is dropped**, block and inline (`<script>`, `<iframe>`, `<img onerror>` …); text between inline tags
 *   stays as text;
 * - **links are kept only when `https:` or `mailto:`** (`isSafeHref`); a `javascript:`, `data:`, `http:` or relative
 *   link keeps its text and loses the link;
 * - **images are never fetched:** a `data:` PNG/JPEG/WebP image that passes the contract's rule becomes an image
 *   block; any other image keeps only its alt text, as `[alt]`;
 * - every cap of the contract holds: runs ≤ 4,000 characters (longer text is split), ≤ 500 runs per block, tables
 *   ≤ 50 × 12 (longer tables continue in a new table with the header repeated; extra columns are cut, with a note),
 *   ≤ 2,000 blocks per section (a new section continues without a page break), ≤ 200 sections (the rest is cut, with
 *   a note); text loses control and bidi-override characters.
 *
 * GFM tables become RichDoc tables (`header: true`), task lists keep a ballot box, footnotes become `[n]` references
 * and paragraphs. Pure and synchronous.
 */
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { DocBlock, DocSection, RichDoc } from '../../platform-core/src/contract/richdoc.js';
import { RICHDOC_LIMITS } from '../../platform-core/src/contract/richdoc.js';
import type { Run, RunMark, TableRow } from '../../platform-core/src/contract/schema.js';
import { MODEL_LIMITS } from '../../platform-core/src/contract/schema.js';
import { check, isSafeHref, s } from '../../platform-core/src/schema/index.js';
import { RenderError } from './errors.js';
import { cleanText } from './style.js';

/** Markdown longer than this is refused (`too-large`): about 2 MB of text, far past any chat answer or script. */
export const MARKDOWN_MAX_CHARS = 2000000;

export interface MarkdownOptions {
  /** The document title; default the first heading, else the first line, else "Untitled". */
  title?: string;
  /** A BCP 47 tag for `meta.lang`. */
  lang?: string;
  /** `meta.author`. */
  author?: string;
}

/** The mdast nodes this reads (structural, so no mdast types package is needed). */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  depth?: number;
  ordered?: boolean | null;
  checked?: boolean | null;
  identifier?: string;
  label?: string | null;
  children?: MdNode[];
}

const DATA_IMAGE = s.assetRef();
const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
/** Inline elements whose content is never text for a reader. */
const RAW_CONTENT = /^<(script|style|iframe|textarea|noscript|template|title|xmp|noembed|noframes|object)\b/i;
const BALLOT = { done: '\u2611 ', open: '\u2610 ' };

/** A link target as kept in a RichDoc: `https:` / `mailto:` (scheme case folded) that passes `isSafeHref`, else none. */
const safeLink = (url: unknown): string | undefined => {
  if (typeof url !== 'string') return undefined;
  const href = url.trim().replace(/^https:/i, 'https:').replace(/^mailto:/i, 'mailto:');
  return isSafeHref(href) ? href : undefined;
};

const sameMarks = (a: RunMark[] | undefined, b: RunMark[] | undefined): boolean => (a || []).join() === (b || []).join();

/** Appends text as runs, merging with the previous run when the marks and link match and splitting at the run cap. */
const pushText = (runs: Run[], raw: string, marks: RunMark[], href: string | undefined): void => {
  let text = cleanText(raw);
  if (!text) return;
  const last = runs[runs.length - 1];
  if (last && sameMarks(last.marks, marks) && (last.link ? last.link.href : undefined) === href && last.text.length < MODEL_LIMITS.runText) {
    const room = MODEL_LIMITS.runText - last.text.length;
    last.text += text.slice(0, room);
    text = text.slice(room);
  }
  while (text) {
    const run: Run = { text: text.slice(0, MODEL_LIMITS.runText) };
    if (marks.length) run.marks = marks.slice();
    if (href) run.link = { href };
    runs.push(run);
    text = text.slice(MODEL_LIMITS.runText);
  }
};

class Builder {
  readonly sections: DocSection[] = [];
  private n = 0;
  private cut = false;
  firstHeading = '';
  firstLine = '';
  readonly defs: { [id: string]: string } = {};

  constructor() {
    this.newSection();
  }

  id(prefix: string): string {
    this.n += 1;
    return `${prefix}${this.n}`;
  }

  private newSection(): boolean {
    if (this.sections.length >= RICHDOC_LIMITS.sections) return false;
    this.sections.push({ id: this.id('s'), pageBreakBefore: false, blocks: [] });
    return true;
  }

  push(block: DocBlock): void {
    if (this.cut) return;
    let section = this.sections[this.sections.length - 1];
    if (section.blocks.length >= RICHDOC_LIMITS.blocksPerSection) {
      // The last section keeps room for the note that says the rest was cut.
      if (this.sections.length >= RICHDOC_LIMITS.sections || !this.newSection()) {
        this.cut = true;
        return;
      }
      section = this.sections[this.sections.length - 1];
    }
    if (this.sections.length === RICHDOC_LIMITS.sections && section.blocks.length === RICHDOC_LIMITS.blocksPerSection - 1) {
      this.cut = true;
      section.blocks.push({ type: 'paragraph', id: this.id('b'), style: 'caption', runs: [{ text: 'The rest of this document was too long to include.' }] });
      return;
    }
    section.blocks.push(block);
  }

  /** Runs for a paragraph-like block: at most `runsPerBlock`; nothing when there is no text. */
  paragraph(runs: Run[], style?: 'quote' | 'caption'): void {
    if (!runs.length) return;
    if (!this.firstLine) this.firstLine = runs.map((r) => r.text).join('');
    for (let i = 0; i < runs.length; i += RICHDOC_LIMITS.runsPerBlock) {
      const block: DocBlock = { type: 'paragraph', id: this.id('b'), runs: runs.slice(i, i + RICHDOC_LIMITS.runsPerBlock) };
      if (style) block.style = style;
      this.push(block);
    }
  }
}

/**
 * Inline nodes → runs. Images inside the text that are valid `data:` images come back in `images` so the caller can
 * place them as blocks after the text; any other image leaves `[alt]`.
 */
const inline = (nodes: MdNode[] | undefined, b: Builder, runs: Run[], images: { dataUri: string; alt: string }[], marks: RunMark[] = [], href?: string): Run[] => {
  // Inline raw HTML is dropped tag by tag; for elements whose content is code or hidden (`<script>`, `<style>` …)
  // the content between the tags goes too, up to the closing tag (or to the end of the paragraph without one).
  let skipping = '';
  for (const node of nodes || []) {
    if (skipping) {
      if (node.type === 'html' && new RegExp(`^</${skipping}\\s*>`, 'i').test((node.value || '').trim())) skipping = '';
      continue;
    }
    if (node.type === 'html') {
      const open = RAW_CONTENT.exec((node.value || '').trim());
      if (open && !new RegExp(`</${open[1]}\\s*>$`, 'i').test((node.value || '').trim())) skipping = open[1].toLowerCase();
      continue;
    }
    switch (node.type) {
      case 'text':
        pushText(runs, node.value || '', marks, href);
        break;
      case 'inlineCode':
        pushText(runs, node.value || '', marks.indexOf('code') === -1 ? marks.concat('code') : marks, href);
        break;
      case 'emphasis':
        inline(node.children, b, runs, images, marks.indexOf('i') === -1 ? marks.concat('i') : marks, href);
        break;
      case 'strong':
        inline(node.children, b, runs, images, marks.indexOf('b') === -1 ? marks.concat('b') : marks, href);
        break;
      case 'delete':
        inline(node.children, b, runs, images, marks, href);
        break;
      case 'break':
        pushText(runs, '\n', marks, href);
        break;
      case 'link':
        inline(node.children, b, runs, images, marks, safeLink(node.url));
        break;
      case 'linkReference':
        inline(node.children, b, runs, images, marks, safeLink(b.defs[(node.identifier || '').toLowerCase()]));
        break;
      case 'image':
      case 'imageReference': {
        const url = node.type === 'image' ? node.url : b.defs[(node.identifier || '').toLowerCase()];
        const alt = cleanText(node.alt || '').slice(0, MODEL_LIMITS.alt);
        if (typeof url === 'string' && check(DATA_IMAGE, { kind: 'data', dataUri: url }).ok) images.push({ dataUri: url, alt });
        else if (alt) pushText(runs, `[${alt}]`, marks, href);
        break;
      }
      case 'footnoteReference':
        pushText(runs, `[${cleanText(node.label || node.identifier || '')}]`, marks, href);
        break;
      default:
        // `html` (raw tags, `<script>` included) and anything unknown: dropped; children of unknown containers kept.
        if (node.type !== 'html' && Array.isArray(node.children)) inline(node.children, b, runs, images, marks, href);
        break;
    }
  }
  return runs;
};

const imageBlocks = (images: { dataUri: string; alt: string }[], b: Builder): void => {
  for (const img of images) b.push({ type: 'image', id: b.id('b'), ref: { kind: 'data', dataUri: img.dataUri }, alt: img.alt });
};

/** One paragraph-like node's text, images placed after it. */
const textBlock = (node: MdNode, b: Builder, style?: 'quote' | 'caption', prefix = ''): void => {
  const images: { dataUri: string; alt: string }[] = [];
  const runs: Run[] = [];
  if (prefix) pushText(runs, prefix, [], undefined);
  inline(node.children, b, runs, images);
  b.paragraph(runs, style);
  imageBlocks(images, b);
};

/** A list item's text: its paragraphs joined by line breaks; nested lists come back to the caller. */
const listItems = (list: MdNode, indent: number, b: Builder, out: { runs: Run[]; indent: number }[], images: { dataUri: string; alt: string }[]): void => {
  for (const item of list.children || []) {
    const runs: Run[] = [];
    if (item.checked === true || item.checked === false) pushText(runs, item.checked ? BALLOT.done : BALLOT.open, [], undefined);
    const nested: MdNode[] = [];
    for (const child of item.children || []) {
      if (child.type === 'list') nested.push(child);
      else if (child.type === 'code') {
        if (runs.length) pushText(runs, '\n', [], undefined);
        pushText(runs, child.value || '', ['code'], undefined);
      } else {
        if (runs.length && !(runs.length === 1 && (runs[0].text === BALLOT.done || runs[0].text === BALLOT.open))) pushText(runs, '\n', [], undefined);
        inline(child.children || (child.value ? [{ type: 'text', value: child.value }] : []), b, runs, images);
      }
    }
    out.push({ runs: runs.slice(0, RICHDOC_LIMITS.runsPerBlock), indent: Math.min(indent, MODEL_LIMITS.listIndentMax) });
    for (const sub of nested) listItems(sub, indent + 1, b, out, images);
  }
};

const tableBlocks = (node: MdNode, b: Builder): void => {
  const rows: TableRow[] = [];
  let widest = 0;
  for (const row of node.children || []) {
    const cells = (row.children || []).map((cell) => ({ runs: inline(cell.children, b, [], []).slice(0, RICHDOC_LIMITS.runsPerCell) }));
    widest = Math.max(widest, cells.length);
    rows.push({ cells: cells.slice(0, RICHDOC_LIMITS.tableCols) });
  }
  if (!rows.length) return;
  const [head, ...body] = rows;
  const per = RICHDOC_LIMITS.tableRows - 1;
  let i = 0;
  do {
    b.push({ type: 'table', id: b.id('b'), header: true, rows: [head, ...body.slice(i, i + per)] });
    i += per;
  } while (i < body.length);
  if (widest > RICHDOC_LIMITS.tableCols) {
    b.paragraph([{ text: `This table has ${widest} columns; the first ${RICHDOC_LIMITS.tableCols} are shown.` }], 'caption');
  }
};

const blocks = (nodes: MdNode[] | undefined, b: Builder, inQuote = false): void => {
  for (const node of nodes || []) {
    switch (node.type) {
      case 'heading': {
        if (inQuote) {
          textBlock(node, b, 'quote');
          break;
        }
        const images: { dataUri: string; alt: string }[] = [];
        const runs = inline(node.children, b, [], images).slice(0, RICHDOC_LIMITS.runsPerBlock);
        if (runs.length) {
          if (!b.firstHeading) b.firstHeading = runs.map((r) => r.text).join('');
          const depth = node.depth || 1;
          b.push({ type: 'heading', id: b.id('b'), level: depth <= 1 ? 1 : depth === 2 ? 2 : 3, runs });
        }
        imageBlocks(images, b);
        break;
      }
      case 'paragraph':
        textBlock(node, b, inQuote ? 'quote' : undefined);
        break;
      case 'blockquote':
        blocks(node.children, b, true);
        break;
      case 'list': {
        const items: { runs: Run[]; indent: number }[] = [];
        const images: { dataUri: string; alt: string }[] = [];
        listItems(node, 0, b, items, images);
        for (let i = 0; i < items.length; i += RICHDOC_LIMITS.listItems) {
          b.push({
            type: 'list',
            id: b.id('b'),
            ordered: !!node.ordered,
            items: items.slice(i, i + RICHDOC_LIMITS.listItems).map((it) => (it.indent ? { runs: it.runs, indent: it.indent } : { runs: it.runs })),
          });
        }
        imageBlocks(images, b);
        break;
      }
      case 'code': {
        const runs: Run[] = [];
        pushText(runs, node.value || '', ['code'], undefined);
        b.paragraph(runs, inQuote ? 'quote' : undefined);
        break;
      }
      case 'table':
        tableBlocks(node, b);
        break;
      case 'thematicBreak':
        b.push({ type: 'divider', id: b.id('b') });
        break;
      case 'footnoteDefinition':
        for (const [i, child] of (node.children || []).entries()) {
          if (child.type === 'paragraph') textBlock(child, b, 'caption', i === 0 ? `[${cleanText(node.label || node.identifier || '')}] ` : '');
          else blocks([child], b, inQuote);
        }
        break;
      case 'html':
      case 'definition':
      case 'yaml':
        // Raw HTML is never carried over; definitions were read up front; front matter is not content.
        break;
      default:
        if (Array.isArray(node.children)) blocks(node.children, b, inQuote);
        break;
    }
  }
};

/** Every `[label]: url` definition, keyed the way references name them. */
const collectDefinitions = (node: MdNode, defs: { [id: string]: string }): void => {
  if (node.type === 'definition' && node.identifier && typeof node.url === 'string') {
    const key = node.identifier.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(defs, key)) defs[key] = node.url;
  }
  for (const child of node.children || []) collectDefinitions(child, defs);
};

const oneLine = (text: string, max: number): string => cleanText(text).replace(/[\r\n\u2028\u2029\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();

/**
 * Markdown → a RichDoc v1 that passes the contract's caps. Throws `RenderError('too-large')` past
 * `MARKDOWN_MAX_CHARS`, and `RenderError('invalid')` for a value that is not a string.
 */
export const richdocFromMarkdown = (markdown: string, opts: MarkdownOptions = {}): RichDoc => {
  if (typeof markdown !== 'string') throw new RenderError('invalid', 'Markdown must be text.');
  if (markdown.length > MARKDOWN_MAX_CHARS) throw new RenderError('too-large', `Markdown over ${MARKDOWN_MAX_CHARS.toLocaleString('en-US')} characters is not converted.`);
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as unknown as MdNode;
  const b = new Builder();
  collectDefinitions(tree, b.defs);
  blocks(tree.children, b);
  const title = oneLine(opts.title || '', RICHDOC_LIMITS.title) || oneLine(b.firstHeading, RICHDOC_LIMITS.title) || oneLine(b.firstLine.split('\n')[0] || '', RICHDOC_LIMITS.title) || 'Untitled';
  const doc: RichDoc = { v: 1, title, sections: b.sections };
  const author = oneLine(opts.author || '', RICHDOC_LIMITS.metaText);
  const lang = typeof opts.lang === 'string' && LANG.test(opts.lang) ? opts.lang : '';
  if (author || lang) doc.meta = { ...(author ? { author } : {}), ...(lang ? { lang } : {}) };
  return doc;
};
