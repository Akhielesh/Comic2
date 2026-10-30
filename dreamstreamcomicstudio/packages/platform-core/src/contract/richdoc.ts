/**
 * FROZEN CONTRACT (platform contract v1, plan §5.2): RichDoc v1 and its ops. Types and caps only; the schema, the
 * ops and `migrate()` live in `src/models/richdoc/**`. Additive changes only (see contract/schema.ts).
 *
 * Page breaks are sections: a section starts a new page when `pageBreakBefore` is true, so a break never restyles
 * the paragraph before it (the "insert a page break" gotcha of some Word engines).
 */
import type { AssetRef, ListItem, OpBase, OpResult, Run, TableRow } from './schema.js';

export interface RichDoc {
  v: 1;
  /** Revision: absent means 0; `applyDocOps` bumps it (contract/schema.ts `OpBase`). */
  rev?: number;
  title: string;
  meta?: DocMeta;
  /** At most `RICHDOC_LIMITS.sections`. */
  sections: DocSection[];
}

export interface DocMeta {
  author?: string;
  subject?: string;
  keywords?: string[];
  /** A BCP 47 tag such as `en` or `te-IN`. */
  lang?: string;
}

export interface DocSection {
  id: string;
  /** Start this section on a new page (ignored for the first section). */
  pageBreakBefore: boolean;
  /** At most `RICHDOC_LIMITS.blocksPerSection`. */
  blocks: DocBlock[];
}

export type DocBlock = DocHeading | DocParagraph | DocList | DocTable | DocImage | DocDivider | DocScript;

export type DocBlockType = DocBlock['type'];

export interface DocHeading {
  type: 'heading';
  id: string;
  level: 1 | 2 | 3;
  runs: Run[];
}

export type ParagraphStyle = 'body' | 'lead' | 'quote' | 'caption';

export interface DocParagraph {
  type: 'paragraph';
  id: string;
  /** Absent means `'body'`. */
  style?: ParagraphStyle;
  runs: Run[];
}

export interface DocList {
  type: 'list';
  id: string;
  ordered: boolean;
  items: ListItem[];
}

/** At most `RICHDOC_LIMITS.tableRows` rows of `RICHDOC_LIMITS.tableCols` cells. */
export interface DocTable {
  type: 'table';
  id: string;
  /** The first row is a header row. */
  header?: boolean;
  rows: TableRow[];
}

export interface DocImage {
  type: 'image';
  id: string;
  ref: AssetRef;
  alt: string;
  caption?: string;
  /** Fraction of the text width, `RICHDOC_LIMITS.imageWidthMin`–1; absent means fit. */
  width?: number;
}

export interface DocDivider {
  type: 'divider';
  id: string;
}

/** Comic scripts: a scene heading, a panel description, a line of dialogue, a caption or a sound effect. */
export type ScriptKind = 'scene' | 'panel' | 'dialogue' | 'caption' | 'sfx';

export interface DocScript {
  type: 'script';
  id: string;
  kind: ScriptKind;
  /** Who speaks (dialogue) or captions (caption). */
  speaker?: string;
  runs: Run[];
}

// ── Ops ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Insert `block` into section `sectionId` at `index` (absent appends). */
export interface DocInsertBlockOp extends OpBase {
  op: 'insert_block';
  sectionId: string;
  index?: number;
  block: DocBlock;
}

/** Replace block `blockId` with `block` (same id). */
export interface DocUpdateBlockOp extends OpBase {
  op: 'update_block';
  blockId: string;
  block: DocBlock;
}

export interface DocRemoveBlockOp extends OpBase {
  op: 'remove_block';
  blockId: string;
}

/** Insert `section` at `index` (absent appends). */
export interface DocInsertSectionOp extends OpBase {
  op: 'insert_section';
  index?: number;
  section: DocSection;
}

export interface DocSetTitleOp extends OpBase {
  op: 'set_title';
  title: string;
}

export type DocOp = DocInsertBlockOp | DocUpdateBlockOp | DocRemoveBlockOp | DocInsertSectionOp | DocSetTitleOp;

export type DocOpName = DocOp['op'];

/** `applyDocOps(doc, ops)`. */
export type DocOpResult = OpResult<RichDoc, DocOp>;

/** An agent's proposed change to a user's document, accepted (or not) one op at a time. `at` is Unix ms. */
export interface DocSuggestion {
  id: string;
  op: DocOp;
  author: 'agent';
  at: number;
}

// ── Caps ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const RICHDOC_LIMITS = {
  title: 300,
  sections: 200,
  blocksPerSection: 2000,
  /** Runs in one heading, paragraph or script block. */
  runsPerBlock: 500,
  listItems: 500,
  tableRows: 50,
  tableCols: 12,
  runsPerCell: 100,
  caption: 1000,
  speaker: 100,
  imageWidthMin: 0.1,
  metaText: 500,
  keywords: 20,
  keyword: 64,
  lang: 35,
  suggestions: 500,
} as const;
