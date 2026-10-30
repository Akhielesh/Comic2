/**
 * RichDoc v1 in the schema DSL (plan §5.2): `Infer<typeof RichDocSchema>` IS the frozen contract type `RichDoc`
 * (src/contract/richdoc.ts), and so on for every schema here (models/contract.test.ts proves it under a strict
 * compile). `checkRichDoc` is what a host runs on a stored or model-made document; `migrateRichDoc` reads any version.
 */
import type { CheckError, CheckOptions, CheckResult } from '../../contract/schema.js';
import { MODEL_LIMITS } from '../../contract/schema.js';
import type { DocOp, DocSuggestion, RichDoc } from '../../contract/richdoc.js';
import { RICHDOC_LIMITS } from '../../contract/richdoc.js';
import { check } from '../../schema/check.js';
import { s } from '../../schema/s.js';
import { checkRefined, idSchema, insertIndexSchema, listItemsOf, migrateV1, opBaseFields, refineError, runsOf, tableRowsOf } from '../common.js';

const R = RICHDOC_LIMITS;

/** One block: heading, paragraph, list, table, image, divider or comic `script`. */
export const DocBlockSchema = s.union('type', [
  s.object({ type: s.literal('heading'), id: idSchema, level: s.enum([1, 2, 3]), runs: runsOf(R.runsPerBlock) }),
  s.object({
    type: s.literal('paragraph'),
    id: idSchema,
    style: s.optional(s.enum(['body', 'lead', 'quote', 'caption'])),
    runs: runsOf(R.runsPerBlock),
  }),
  s.object({ type: s.literal('list'), id: idSchema, ordered: s.bool(), items: listItemsOf(R.listItems, R.runsPerBlock) }),
  s.object({ type: s.literal('table'), id: idSchema, header: s.optional(s.bool()), rows: tableRowsOf(R.tableRows, R.tableCols, R.runsPerCell) }),
  s.object({
    type: s.literal('image'),
    id: idSchema,
    ref: s.assetRef(),
    alt: s.text({ max: MODEL_LIMITS.alt }),
    caption: s.optional(s.text({ max: R.caption })),
    width: s.optional(s.number({ min: R.imageWidthMin, max: 1 })),
  }),
  s.object({ type: s.literal('divider'), id: idSchema }),
  s.object({
    type: s.literal('script'),
    id: idSchema,
    kind: s.enum(['scene', 'panel', 'dialogue', 'caption', 'sfx']),
    speaker: s.optional(s.text({ max: R.speaker, singleLine: true })),
    runs: runsOf(R.runsPerBlock),
  }),
]);

/** A section: a page break before it (or not) and its blocks. Page breaks ARE sections. */
export const DocSectionSchema = s.object({ id: idSchema, pageBreakBefore: s.bool(), blocks: s.array(DocBlockSchema, { max: R.blocksPerSection }) });

export const DocMetaSchema = s.object({
  author: s.optional(s.text({ max: R.metaText })),
  subject: s.optional(s.text({ max: R.metaText })),
  keywords: s.optional(s.array(s.text({ max: R.keyword }), { max: R.keywords })),
  lang: s.optional(s.text({ max: R.lang })),
});

export const RichDocSchema = s.object({
  v: s.literal(1),
  rev: s.optional(s.int({ min: 0 })),
  title: s.text({ max: R.title, singleLine: true }),
  meta: s.optional(DocMetaSchema),
  sections: s.array(DocSectionSchema, { max: R.sections }),
});

/** Every `DocOp`. `set_title` is single-line like the title it sets, so an op can never make an invalid document. */
export const DocOpSchema = s.union('op', [
  s.object({ op: s.literal('insert_block'), ...opBaseFields, sectionId: idSchema, index: insertIndexSchema, block: DocBlockSchema }),
  s.object({ op: s.literal('update_block'), ...opBaseFields, blockId: idSchema, block: DocBlockSchema }),
  s.object({ op: s.literal('remove_block'), ...opBaseFields, blockId: idSchema }),
  s.object({ op: s.literal('insert_section'), ...opBaseFields, index: insertIndexSchema, section: DocSectionSchema }),
  s.object({ op: s.literal('remove_section'), ...opBaseFields, sectionId: idSchema }),
  s.object({ op: s.literal('set_title'), ...opBaseFields, title: s.text({ max: R.title, singleLine: true }) }),
]);

/** An agent's proposed change to a user's document (`at` is Unix ms, stamped by the host). */
export const DocSuggestionSchema = s.object({ id: idSchema, op: DocOpSchema, author: s.literal('agent'), at: s.int({ min: 0 }) });

/** Op rules the DSL cannot say: `update_block` keeps the block's id. */
export const refineDocOp = (op: DocOp): CheckError[] =>
  op.op === 'update_block' && op.block.id !== op.blockId ? [refineError(['block', 'id'], 'literal', `must be the blockId, ${JSON.stringify(op.blockId)}`)] : [];

/** A RichDoc v1 (a fresh copy on success). Hosts run it on every stored, imported or model-made document. */
export const checkRichDoc = (value: unknown, options?: CheckOptions): CheckResult<RichDoc> => check(RichDocSchema, value, options);

/** One `DocOp`, with the refinements `applyDocOps` applies. */
export const checkDocOp = (value: unknown): CheckResult<DocOp> => checkRefined(DocOpSchema, value, refineDocOp);

/** One `DocSuggestion`. */
export const checkDocSuggestion = (value: unknown): CheckResult<DocSuggestion> =>
  checkRefined(DocSuggestionSchema, value, (sg) => refineDocOp(sg.op).map((e) => ({ ...e, path: `op.${e.path}` })));

/** Read a stored RichDoc of any version into v1 (v1 is the only version yet: validated and copied). */
export const migrateRichDoc = (value: unknown): CheckResult<RichDoc> => migrateV1(value, 'RichDoc', (v) => checkRichDoc(v));
