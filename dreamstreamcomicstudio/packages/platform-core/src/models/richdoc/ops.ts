/**
 * RichDoc ops (plan §5.2): `applyDocOps(doc, ops) → {doc, applied, rejected}`, their exact inverses (undo) and
 * accepting an agent's suggestion. The op rules are in models/common.ts; what is RichDoc's own:
 *
 * - Block ids are unique across the whole document (ops address a block by id alone) and section ids across its
 *   sections. An op that would repeat one is refused as `invalid`; nothing an op does can create a duplicate.
 * - Positions are exact: an `index` past the end is refused (`invalid`), never clamped, so every inverse is exact.
 * - Page breaks are sections. Inserting or removing a section never touches another section: the paragraph before a
 *   page break keeps its style (the "insert a page break" gotcha of some Word engines), and every untouched section
 *   is the same object as before.
 * - Caps: `RICHDOC_LIMITS.sections` sections and `RICHDOC_LIMITS.blocksPerSection` blocks per section (`limit`).
 */
import type { OpId } from '../../contract/schema.js';
import type { DocOp, DocOpResult, DocSection, DocSuggestion, RichDoc } from '../../contract/richdoc.js';
import { RICHDOC_LIMITS } from '../../contract/richdoc.js';
import type { ApplyOptions, InverseMeta, OpKernel, Step } from '../common.js';
import {
  applyOpsWith,
  describeErrors,
  firstRepeat,
  indexById,
  insertAt,
  invertOpWith,
  invertOpsWith,
  isRecord,
  removeAt,
  replaceAt,
  revOf,
  stepFail,
  stepOk,
} from '../common.js';
import { DocOpSchema, checkDocSuggestion, refineDocOp } from './schema.js';

const R = RICHDOC_LIMITS;

/** Where block `blockId` sits: its section's position and its own, or null. */
const findBlock = (doc: RichDoc, blockId: string): { section: number; block: number } | null => {
  for (let section = 0; section < doc.sections.length; section++) {
    const block = indexById(doc.sections[section].blocks, blockId);
    if (block !== -1) return { section, block };
  }
  return null;
};

const withSection = (doc: RichDoc, index: number, section: DocSection): RichDoc => ({ ...doc, sections: replaceAt(doc.sections, index, section) });

const pastEnd = (index: number, length: number, what: string): string => `index ${index} is past the end of ${what} (${length})`;

const step = (doc: RichDoc, op: DocOp): Step<RichDoc> => {
  switch (op.op) {
    case 'insert_block': {
      const at = indexById(doc.sections, op.sectionId);
      if (at === -1) return stepFail('not-found', `there is no section ${op.sectionId}`);
      if (findBlock(doc, op.block.id)) return stepFail('invalid', `block id ${op.block.id} is already used`);
      const section = doc.sections[at];
      const index = op.index === undefined ? section.blocks.length : op.index;
      if (index > section.blocks.length) return stepFail('invalid', pastEnd(index, section.blocks.length, `section ${section.id}`));
      if (section.blocks.length >= R.blocksPerSection) return stepFail('limit', `a section holds at most ${R.blocksPerSection} blocks`);
      return stepOk(withSection(doc, at, { ...section, blocks: insertAt(section.blocks, index, op.block) }));
    }
    case 'update_block': {
      const where = findBlock(doc, op.blockId);
      if (!where) return stepFail('not-found', `there is no block ${op.blockId}`);
      const section = doc.sections[where.section];
      return stepOk(withSection(doc, where.section, { ...section, blocks: replaceAt(section.blocks, where.block, op.block) }));
    }
    case 'remove_block': {
      const where = findBlock(doc, op.blockId);
      if (!where) return stepFail('not-found', `there is no block ${op.blockId}`);
      const section = doc.sections[where.section];
      return stepOk(withSection(doc, where.section, { ...section, blocks: removeAt(section.blocks, where.block) }));
    }
    case 'insert_section': {
      if (indexById(doc.sections, op.section.id) !== -1) return stepFail('invalid', `section id ${op.section.id} is already used`);
      const ids = op.section.blocks.map((b) => b.id);
      const repeat = firstRepeat(ids);
      if (repeat !== null) return stepFail('invalid', `block id ${repeat} appears twice in the new section`);
      for (const id of ids) if (findBlock(doc, id)) return stepFail('invalid', `block id ${id} is already used`);
      const index = op.index === undefined ? doc.sections.length : op.index;
      if (index > doc.sections.length) return stepFail('invalid', pastEnd(index, doc.sections.length, 'the sections'));
      if (doc.sections.length >= R.sections) return stepFail('limit', `a document holds at most ${R.sections} sections`);
      return stepOk({ ...doc, sections: insertAt(doc.sections, index, op.section) });
    }
    case 'remove_section': {
      const at = indexById(doc.sections, op.sectionId);
      if (at === -1) return stepFail('not-found', `there is no section ${op.sectionId}`);
      return stepOk({ ...doc, sections: removeAt(doc.sections, at) });
    }
    case 'set_title':
      return stepOk({ ...doc, title: op.title });
  }
};

/** The exact inverse of `op` as applied to `before` (null when it does not apply). */
const invert = (before: RichDoc, op: DocOp, id: OpId, baseRev: number): DocOp | null => {
  switch (op.op) {
    case 'insert_block':
      return { op: 'remove_block', id, baseRev, blockId: op.block.id };
    case 'update_block': {
      const where = findBlock(before, op.blockId);
      return where ? { op: 'update_block', id, baseRev, blockId: op.blockId, block: before.sections[where.section].blocks[where.block] } : null;
    }
    case 'remove_block': {
      const where = findBlock(before, op.blockId);
      if (!where) return null;
      const section = before.sections[where.section];
      return { op: 'insert_block', id, baseRev, sectionId: section.id, index: where.block, block: section.blocks[where.block] };
    }
    case 'insert_section':
      return { op: 'remove_section', id, baseRev, sectionId: op.section.id };
    case 'remove_section': {
      const at = indexById(before.sections, op.sectionId);
      return at === -1 ? null : { op: 'insert_section', id, baseRev, index: at, section: before.sections[at] };
    }
    case 'set_title':
      return { op: 'set_title', id, baseRev, title: before.title };
  }
};

const KERNEL: OpKernel<RichDoc, DocOp> = { noun: 'document', schema: DocOpSchema, refine: refineDocOp, step, invert };

/**
 * Apply `ops` to `doc`: pure, immutable, never throws. Returns the next document (the same object when nothing
 * applied), the ops that applied (checked copies) and the ones refused, with why: `invalid`, `stale`, `duplicate`,
 * `not-found` or `limit`. See the op rules in models/common.ts.
 */
export const applyDocOps = (doc: RichDoc, ops: readonly DocOp[], options?: ApplyOptions): DocOpResult => applyOpsWith(KERNEL, doc, ops, options);

/**
 * The undo batch for the ops one `applyDocOps(before, …)` call applied (its `applied`): newest first, each stamped
 * with `meta.id(op, index)` and `meta.baseRev` (the `rev` after the call). `remove_block` ↔ `insert_block` at the old
 * position, `remove_section` ↔ `insert_section` at the old index, `update_block` / `set_title` ↔ themselves with the
 * old value. Null when an op does not apply to `before`.
 */
export const invertDocOps = (before: RichDoc, applied: readonly DocOp[], meta: InverseMeta<DocOp>): DocOp[] | null =>
  invertOpsWith(KERNEL, before, applied, meta);

/** The exact inverse of one op as applied to `before`, or null. */
export const invertDocOp = (before: RichDoc, op: DocOp, meta: { id: OpId; baseRev: number }): DocOp | null => invertOpWith(KERNEL, before, op, meta);

/** The block or section id an op targets, when it names one (`insert_section` and `set_title` name none). */
const targetOf = (op: DocOp): { kind: 'section' | 'block'; id: string } | null => {
  switch (op.op) {
    case 'insert_block':
    case 'remove_section':
      return { kind: 'section', id: op.sectionId };
    case 'update_block':
    case 'remove_block':
      return { kind: 'block', id: op.blockId };
    default:
      return null;
  }
};

/**
 * Accept one agent suggestion: its target (the section or block its op names) must still exist, else it is refused
 * as `not-found` and NOT re-stamped; then its op's `baseRev` is re-stamped to the document's current `rev` and the op
 * applied, so accepting one suggestion never makes the others stale. Each suggestion's op id still applies at most
 * once when the host passes its op log in `options.seenOpIds`.
 *
 * The check is by id only: an accepted `update_block` replaces whatever the block holds now. A host that must not
 * overwrite a later user edit compares the block with the one the suggestion saw first.
 */
export const acceptDocSuggestion = (doc: RichDoc, suggestion: DocSuggestion, options?: ApplyOptions): DocOpResult => {
  const r = checkDocSuggestion(suggestion);
  if (r.ok === false) return { doc, applied: [], rejected: [{ index: 0, code: 'invalid', message: describeErrors(r.errors) }] };
  const op = r.value.op;
  const target = targetOf(op);
  if (target && isRecord(doc) && Array.isArray(doc.sections)) {
    let found: boolean;
    try {
      found = target.kind === 'section' ? indexById(doc.sections, target.id) !== -1 : findBlock(doc, target.id) !== null;
    } catch {
      found = false;
    }
    if (!found) return { doc, applied: [], rejected: [{ index: 0, opId: op.id, code: 'not-found', message: `the suggestion's ${target.kind} ${target.id} is gone` }] };
  }
  return applyDocOps(doc, [{ ...op, baseRev: revOf(doc) }], options);
};
