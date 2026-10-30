/**
 * `@dreamstream/platform-core/models/richdoc`: RichDoc v1 (plan §5.2): the schema (`Infer` is the frozen contract
 * type), `checkRichDoc` / `migrateRichDoc`, `applyDocOps` with exact inverses, and accepting agent suggestions.
 */
export type {
  DocBlock,
  DocBlockType,
  DocDivider,
  DocHeading,
  DocImage,
  DocInsertBlockOp,
  DocInsertSectionOp,
  DocList,
  DocMeta,
  DocOp,
  DocOpName,
  DocOpResult,
  DocParagraph,
  DocRemoveBlockOp,
  DocRemoveSectionOp,
  DocScript,
  DocSection,
  DocSetTitleOp,
  DocSuggestion,
  DocTable,
  DocUpdateBlockOp,
  ParagraphStyle,
  RichDoc,
  ScriptKind,
  Section,
} from '../../contract/richdoc.js';
export { RICHDOC_LIMITS } from '../../contract/richdoc.js';
export type { ApplyOptions, InverseMeta } from '../common.js';
export { MODEL_OPS_MAX } from '../common.js';
export {
  DocBlockSchema,
  DocMetaSchema,
  DocOpSchema,
  DocSectionSchema,
  DocSuggestionSchema,
  RichDocSchema,
  checkDocOp,
  checkDocSuggestion,
  checkRichDoc,
  migrateRichDoc,
  refineDocOp,
} from './schema.js';
export { acceptDocSuggestion, applyDocOps, invertDocOp, invertDocOps } from './ops.js';
