/**
 * One defensive reader for an EmailDoc, shared by `renderEmail`, `emailToPlainText` and `reviewEmail`. Hosts run
 * `check()` first; this still never trusts its input: it reads only own fields of plain objects, keeps the contract's
 * caps (`EMAIL_LIMITS`), cleans every string (`cleanText`), validates every href (`https:`/`mailto:` only) and drops
 * anything it does not recognise, so the renderers downstream only ever see safe values.
 */
import { EMAIL_LIMITS, type EmailMode } from '../contract/email.js';
import { MODEL_LIMITS, type RunMark } from '../contract/schema.js';
import { cleanText, safeUrl } from './layout.js';

export interface ReadRun {
  text: string;
  marks: RunMark[];
  /** A safe href, or `''` (no link, or one that was dropped). */
  href: string;
  /** True when the run carried a link that was not `https:`/`mailto:` (it renders as plain text). */
  droppedLink: boolean;
}

export interface ReadItem {
  runs: ReadRun[];
  indent: number;
}

export type ReadBlock =
  | { type: 'heading'; id: string; level: 1 | 2 | 3; runs: ReadRun[] }
  | { type: 'paragraph'; id: string; runs: ReadRun[] }
  | { type: 'list'; id: string; ordered: boolean; items: ReadItem[] }
  | { type: 'button'; id: string; label: string; href: string; droppedLink: boolean }
  | { type: 'quote'; id: string; runs: ReadRun[]; cite: string }
  | { type: 'divider'; id: string }
  | { type: 'image'; id: string; ref: unknown; alt: string; width?: number }
  | { type: 'columns'; id: string; columns: ReadBlock[][] };

export interface ReadRecipient {
  address: string;
  name?: string;
}

export interface ReadDoc {
  mode: EmailMode;
  subject: string;
  preheader: string;
  to: ReadRecipient[];
  cc: ReadRecipient[];
  bcc: ReadRecipient[];
  blocks: ReadBlock[];
  signature: string;
  attachments: number;
  brand?: string;
}

const MODES: readonly EmailMode[] = ['compose', 'reply', 'reply-all', 'forward'];
const MARKS: readonly RunMark[] = ['b', 'i', 'u', 'code'];

type Obj = { [key: string]: unknown };

/** A plain object's own field (never an inherited one). */
const own = (o: unknown, key: string): unknown => {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return undefined;
  return Object.prototype.hasOwnProperty.call(o, key) ? (o as Obj)[key] : undefined;
};

const items = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

/** Cap first, then clean: the work is bounded by the cap whatever the input holds. */
const text = (v: unknown, max: number): string => cleanText(typeof v === 'string' ? v.slice(0, max) : v);

const line = (v: unknown, max: number): string => text(v, max).replace(/\n/g, ' ');

const idOf = (b: unknown): string => line(own(b, 'id'), 64);

export const readRuns = (v: unknown, max: number = EMAIL_LIMITS.runsPerBlock): ReadRun[] =>
  items(v, max).map((r) => {
    const marks: RunMark[] = [];
    for (const m of items(own(r, 'marks'), MODEL_LIMITS.marks)) if (MARKS.indexOf(m as RunMark) !== -1 && marks.indexOf(m as RunMark) === -1) marks.push(m as RunMark);
    const linkObj = own(r, 'link');
    const raw = own(linkObj, 'href');
    const href = safeUrl(raw);
    return { text: text(own(r, 'text'), MODEL_LIMITS.runText), marks, href, droppedLink: linkObj !== undefined && !href };
  });

const level = (v: unknown): 1 | 2 | 3 => (v === 2 || v === 3 ? v : 1);

const readBlock = (b: unknown, nested: boolean): ReadBlock | undefined => {
  const id = idOf(b);
  switch (own(b, 'type')) {
    case 'heading':
      return { type: 'heading', id, level: level(own(b, 'level')), runs: readRuns(own(b, 'runs')) };
    case 'paragraph':
      return { type: 'paragraph', id, runs: readRuns(own(b, 'runs')) };
    case 'list':
      return {
        type: 'list',
        id,
        ordered: own(b, 'ordered') === true,
        items: items(own(b, 'items'), EMAIL_LIMITS.listItems).map((it) => {
          const indent = own(it, 'indent');
          return {
            runs: readRuns(own(it, 'runs')),
            indent: typeof indent === 'number' && indent >= 0 && indent <= MODEL_LIMITS.listIndentMax ? Math.floor(indent) : 0,
          };
        }),
      };
    case 'button': {
      const raw = own(b, 'href');
      const href = safeUrl(raw);
      return { type: 'button', id, label: line(own(b, 'label'), EMAIL_LIMITS.buttonLabel), href, droppedLink: !href };
    }
    case 'quote':
      return { type: 'quote', id, runs: readRuns(own(b, 'runs')), cite: line(own(b, 'cite'), EMAIL_LIMITS.cite) };
    case 'divider':
      return { type: 'divider', id };
    case 'image': {
      const w = own(b, 'width');
      const width = typeof w === 'number' && w >= EMAIL_LIMITS.imageWidthMin && w <= EMAIL_LIMITS.imageWidthMax ? Math.round(w) : undefined;
      const out: ReadBlock = { type: 'image', id, ref: own(b, 'ref'), alt: line(own(b, 'alt'), MODEL_LIMITS.alt) };
      if (width !== undefined) out.width = width;
      return out;
    }
    case 'columns':
      if (nested) return undefined; // a column never holds another columns block
      return {
        type: 'columns',
        id,
        columns: items(own(b, 'columns'), EMAIL_LIMITS.columns).map((c) => readBlocks(own(c, 'blocks'), EMAIL_LIMITS.blocksPerColumn, true)),
      };
    default:
      return undefined;
  }
};

export const readBlocks = (v: unknown, max: number = EMAIL_LIMITS.blocks, nested = false): ReadBlock[] => {
  const out: ReadBlock[] = [];
  for (const b of items(v, max)) {
    const r = readBlock(b, nested);
    if (r) out.push(r);
  }
  return out;
};

const recipients = (v: unknown): ReadRecipient[] =>
  items(v, EMAIL_LIMITS.recipients).map((r) => {
    const name = line(own(r, 'name'), EMAIL_LIMITS.recipientName).trim();
    const out: ReadRecipient = { address: typeof own(r, 'address') === 'string' ? (own(r, 'address') as string).trim() : '' };
    if (name) out.name = name;
    return out;
  });

/** The whole document, read defensively. */
export const readDoc = (doc: unknown): ReadDoc => {
  const mode = own(doc, 'mode');
  const brand = own(doc, 'brand');
  const out: ReadDoc = {
    mode: MODES.indexOf(mode as EmailMode) !== -1 ? (mode as EmailMode) : 'compose',
    subject: line(own(doc, 'subject'), EMAIL_LIMITS.subject),
    preheader: line(own(doc, 'preheader'), EMAIL_LIMITS.preheader),
    to: recipients(own(doc, 'to')),
    cc: recipients(own(doc, 'cc')),
    bcc: recipients(own(doc, 'bcc')),
    blocks: readBlocks(own(doc, 'blocks')),
    signature: text(own(doc, 'signature'), EMAIL_LIMITS.field),
    attachments: items(own(doc, 'attachments'), EMAIL_LIMITS.attachments).length,
  };
  if (typeof brand === 'string') out.brand = brand;
  return out;
};
