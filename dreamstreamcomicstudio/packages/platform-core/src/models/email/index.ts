/**
 * `@dreamstream/platform-core/models/email`: EmailDoc v1 (plan §5.2, §7): the schema (`Infer` is the frozen contract
 * type) with the plain-text body cap and attachment refinements, `checkEmailDoc` / `migrateEmailDoc`,
 * `applyEmailOps` with exact inverses, and `stampAgentEmailOp` (model output → an op; never `set_recipients`).
 * Rendering and recipient/link review live in `@dreamstream/platform-core/email`.
 */
export type {
  AgentEmailOp,
  AttachmentKind,
  AttachmentSource,
  AttachmentSpec,
  EmailAttachOp,
  EmailBlock,
  EmailBlockType,
  EmailButton,
  EmailColumn,
  EmailColumnBlock,
  EmailColumns,
  EmailDetachOp,
  EmailDivider,
  EmailDoc,
  EmailHeading,
  EmailImage,
  EmailInsertBlockOp,
  EmailList,
  EmailMode,
  EmailOp,
  EmailOpBase,
  EmailOpName,
  EmailOpResult,
  EmailParagraph,
  EmailQuote,
  EmailRecipient,
  EmailRemoveBlockOp,
  EmailSetRecipientsOp,
  EmailSetSubjectOp,
  EmailUpdateBlockOp,
} from '../../contract/email.js';
export { EMAIL_LIMITS } from '../../contract/email.js';
export type { ApplyOptions, InverseMeta } from '../common.js';
export { MODEL_OPS_MAX } from '../common.js';
export {
  AgentEmailOpSchema,
  AttachmentSpecSchema,
  EMAIL_TEXT_ALLOWANCE,
  EmailBlockSchema,
  EmailColumnBlockSchema,
  EmailDocSchema,
  EmailOpSchema,
  EmailRecipientSchema,
  checkEmailDoc,
  checkEmailOp,
  emailBodyTextLength,
  migrateEmailDoc,
  refineAttachment,
  refineEmailDoc,
  refineEmailOp,
  stampAgentEmailOp,
} from './schema.js';
export { applyEmailOps, invertEmailOp, invertEmailOps } from './ops.js';
