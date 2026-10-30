/**
 * EmailDoc v1 in the schema DSL (plan §5.2, §7): `Infer<typeof EmailDocSchema>` IS the frozen contract type
 * `EmailDoc`, `Infer<typeof AgentEmailOpSchema>` is `AgentEmailOp`. Rules the DSL cannot say are refinements, run by
 * `checkEmailDoc` and by `applyEmailOps`:
 * - the whole plain-text body (`emailBodyTextLength`) is at most `EMAIL_LIMITS.field` characters, so a draft fits a
 *   10,000-character composer (`too-long` at `blocks`);
 * - a `docx` attachment carries a doc and a `pptx` one a deck (`tag` at `spec.type`); an attached deck obeys the
 *   deck refinements.
 *
 * Agents draft; people send. Nothing here can send, and an agent can never change recipients: `set_recipients` needs
 * `actor: 'user'`, which the HOST stamps; `stampAgentEmailOp` is how a host turns model output into an op.
 */
import type { CheckError, CheckOptions, CheckResult } from '../../contract/schema.js';
import { MODEL_LIMITS } from '../../contract/schema.js';
import type { AgentEmailOp, AttachmentSpec, EmailBlock, EmailDoc, EmailOp } from '../../contract/email.js';
import { EMAIL_LIMITS } from '../../contract/email.js';
import type { Run } from '../../contract/schema.js';
import { check } from '../../schema/check.js';
import { s } from '../../schema/s.js';
import type { RefinePath } from '../common.js';
import { checkRefined, idSchema, insertIndexSchema, isRecord, listItemsOf, migrateV1, opBaseFields, refineError, runsOf } from '../common.js';
import { DeckSpecSchema, refineDeckSpec } from '../deck/schema.js';
import { RichDocSchema } from '../richdoc/schema.js';

const E = EMAIL_LIMITS;

/** One plain address and an optional display name. */
export const EmailRecipientSchema = s.object({ address: s.email(), name: s.optional(s.text({ max: E.recipientName, singleLine: true })) });

const recipients = s.array(EmailRecipientSchema, { max: E.recipients });

const leafBlocks = [
  s.object({ type: s.literal('heading'), id: idSchema, level: s.enum([1, 2, 3]), runs: runsOf(E.runsPerBlock) }),
  s.object({ type: s.literal('paragraph'), id: idSchema, runs: runsOf(E.runsPerBlock) }),
  s.object({ type: s.literal('list'), id: idSchema, ordered: s.bool(), items: listItemsOf(E.listItems, E.runsPerBlock) }),
  s.object({ type: s.literal('button'), id: idSchema, label: s.text({ max: E.buttonLabel, singleLine: true }), href: s.link() }),
  s.object({ type: s.literal('quote'), id: idSchema, runs: runsOf(E.runsPerBlock), cite: s.optional(s.text({ max: E.cite })) }),
  s.object({ type: s.literal('divider'), id: idSchema }),
  s.object({
    type: s.literal('image'),
    id: idSchema,
    ref: s.assetRef(),
    alt: s.text({ max: MODEL_LIMITS.alt }),
    width: s.optional(s.int({ min: E.imageWidthMin, max: E.imageWidthMax })),
  }),
] as const;

/** What a column may hold: every block but another `columns`. */
export const EmailColumnBlockSchema = s.union('type', leafBlocks);

/** One top-level block. */
export const EmailBlockSchema = s.union('type', [
  ...leafBlocks,
  s.object({
    type: s.literal('columns'),
    id: idSchema,
    columns: s.array(s.object({ blocks: s.array(EmailColumnBlockSchema, { max: E.blocksPerColumn }) }), { max: E.columns }),
  }),
]);

/** A file the host renders after a human click (specs only; nothing here renders or sends one). */
export const AttachmentSpecSchema = s.object({
  id: idSchema,
  name: s.text({ max: E.attachmentName, singleLine: true }),
  kind: s.enum(['docx', 'pdf', 'pptx']),
  spec: s.union('type', [s.object({ type: s.literal('doc'), doc: RichDocSchema }), s.object({ type: s.literal('deck'), deck: DeckSpecSchema })]),
});

export const EmailDocSchema = s.object({
  v: s.literal(1),
  rev: s.optional(s.int({ min: 0 })),
  mode: s.enum(['compose', 'reply', 'reply-all', 'forward']),
  subject: s.text({ max: E.subject, singleLine: true }),
  preheader: s.optional(s.text({ max: E.preheader, singleLine: true })),
  to: recipients,
  cc: s.optional(recipients),
  bcc: s.optional(recipients),
  blocks: s.array(EmailBlockSchema, { max: E.blocks }),
  signature: s.optional(s.text({ max: E.field })),
  attachments: s.optional(s.array(AttachmentSpecSchema, { max: E.attachments })),
  brand: s.optional(idSchema),
});

const actor = s.optional(s.enum(['user', 'agent']));

const agentOps = [
  s.object({ op: s.literal('set_subject'), ...opBaseFields, actor, subject: s.text({ max: E.subject, singleLine: true }) }),
  s.object({ op: s.literal('insert_block'), ...opBaseFields, actor, index: insertIndexSchema, block: EmailBlockSchema }),
  s.object({ op: s.literal('update_block'), ...opBaseFields, actor, blockId: idSchema, block: EmailBlockSchema }),
  s.object({ op: s.literal('remove_block'), ...opBaseFields, actor, blockId: idSchema }),
  s.object({ op: s.literal('attach'), ...opBaseFields, actor, index: insertIndexSchema, attachment: AttachmentSpecSchema }),
  s.object({ op: s.literal('detach'), ...opBaseFields, actor, attachmentId: idSchema }),
] as const;

/** Every `EmailOp`: what a host applies (it stamps `actor` itself). */
export const EmailOpSchema = s.union('op', [
  ...agentOps,
  s.object({ op: s.literal('set_recipients'), ...opBaseFields, actor: s.literal('user'), to: recipients, cc: s.optional(recipients), bcc: s.optional(recipients) }),
]);

/** What a MODEL may propose: every op but `set_recipients`. Model-facing tool inputs project this, never `EmailOpSchema`. */
export const AgentEmailOpSchema = s.union('op', agentOps);

// ── The plain-text body cap ────────────────────────────────────────────────────────────────────────────────────

/**
 * What `emailBodyTextLength` adds for the plain-text formatting around the text, per element. They are generous on
 * purpose: the measure is an UPPER bound on any plain-text rendering of the body (`emailToPlainText` must stay within
 * it), so a body under the cap always fits the composer.
 */
export const EMAIL_TEXT_ALLOWANCE = {
  /** The blank line after every block. */
  block: 2,
  /** A list item's indent (at most 4), marker (at most `100. `) and line break. */
  listItem: 10,
  /** ` (` + `)` around a linked run's href. */
  link: 3,
  /** `: ` between a button's label and its href, and a line break. */
  button: 4,
  /** `[` + `]` around an image's alt text, and a line break. */
  image: 4,
  /** A rule (`---`) and its line break. */
  divider: 4,
  /** `— ` before a quote's cite, and a line break. */
  cite: 4,
  /** A prefix repeated after each line break inside a text (a quote's `> `, a list item's indent). */
  lineBreak: 4,
  /** The `-- ` line before the signature. */
  signature: 4,
} as const;

const A = EMAIL_TEXT_ALLOWANCE;
const LINE_BREAK = /\r\n|\r|\n/g;

const textLength = (text: string): number => text.length + (text.match(LINE_BREAK) || []).length * A.lineBreak;

const runsLength = (runs: readonly Run[]): number => {
  let n = 0;
  for (const run of runs) n += textLength(run.text) + (run.link ? run.link.href.length + A.link : 0);
  return n;
};

const blockLength = (block: EmailBlock): number => {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
      return runsLength(block.runs) + A.block;
    case 'list': {
      let n = A.block;
      for (const item of block.items) n += runsLength(item.runs) + A.listItem;
      return n;
    }
    case 'button':
      return textLength(block.label) + block.href.length + A.button + A.block;
    case 'quote':
      return runsLength(block.runs) + (block.cite !== undefined ? textLength(block.cite) + A.cite : 0) + A.block;
    case 'divider':
      return A.divider + A.block;
    case 'image':
      return textLength(block.alt) + A.image + A.block;
    case 'columns': {
      let n = A.block;
      for (const column of block.columns) for (const inner of column.blocks) n += blockLength(inner);
      return n;
    }
  }
};

/**
 * The most characters a plain-text rendering of the body (the blocks and the signature; not the subject) can hold:
 * every text, href, label, cite and alt, plus `EMAIL_TEXT_ALLOWANCE` for the formatting around them. The cap
 * `EMAIL_LIMITS.field` applies to it. For a schema-checked document.
 */
export const emailBodyTextLength = (doc: Pick<EmailDoc, 'blocks' | 'signature'>): number => {
  let n = 0;
  for (const block of doc.blocks) n += blockLength(block);
  if (doc.signature !== undefined) n += textLength(doc.signature) + A.signature;
  return n;
};

// ── Refinements ────────────────────────────────────────────────────────────────────────────────────────────────

/** A docx needs a doc and a pptx a deck (a pdf takes either); an attached deck obeys the deck refinements. */
export const refineAttachment = (attachment: AttachmentSpec, path: RefinePath): CheckError[] => {
  const errors: CheckError[] = [];
  const { kind, spec } = attachment;
  if ((kind === 'docx' && spec.type !== 'doc') || (kind === 'pptx' && spec.type !== 'deck')) {
    errors.push(refineError(path.concat(['spec', 'type']), 'tag', `a ${kind} attachment needs a ${kind === 'docx' ? 'doc' : 'deck'}`));
  }
  return spec.type === 'deck' ? errors.concat(refineDeckSpec(spec.deck, path.concat(['spec', 'deck']))) : errors;
};

/** The refinements of a whole (schema-checked) email. */
export const refineEmailDoc = (doc: EmailDoc): CheckError[] => {
  let errors: CheckError[] = [];
  (doc.attachments || []).forEach((attachment, i) => {
    errors = errors.concat(refineAttachment(attachment, ['attachments', i]));
  });
  const length = emailBodyTextLength(doc);
  if (length > E.field) {
    errors.push(refineError(['blocks'], 'too-long', `the body must be at most ${E.field} characters of plain text (it has about ${length})`));
  }
  return errors;
};

/** Op rules the DSL cannot say: an attached spec obeys `refineAttachment`; `update_block` keeps the block's id. */
export const refineEmailOp = (op: EmailOp): CheckError[] => {
  if (op.op === 'attach') return refineAttachment(op.attachment, ['attachment']);
  if (op.op === 'update_block' && op.block.id !== op.blockId) return [refineError(['block', 'id'], 'literal', `must be the blockId, ${JSON.stringify(op.blockId)}`)];
  return [];
};

/** An EmailDoc v1 with its refinements (a fresh copy on success). */
export const checkEmailDoc = (value: unknown, options?: CheckOptions): CheckResult<EmailDoc> => checkRefined(EmailDocSchema, value, refineEmailDoc, options);

/** One `EmailOp`, with the refinements `applyEmailOps` applies. */
export const checkEmailOp = (value: unknown): CheckResult<EmailOp> => checkRefined(EmailOpSchema, value, refineEmailOp);

/**
 * Model output → an op the host may apply. Whatever `actor` the model wrote is dropped and `'agent'` stamped in its
 * place; then the op must be an `AgentEmailOp`, so a `set_recipients` is refused (`tag` at `op`) even when it claims
 * `actor: 'user'`. A fresh copy on success.
 */
export const stampAgentEmailOp = (raw: unknown): CheckResult<AgentEmailOp> => {
  if (!isRecord(raw)) return check(AgentEmailOpSchema, raw);
  const stamped: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    // defineProperty keeps an own `__proto__` key a key (check() then refuses it) instead of setting the prototype.
    if (key !== 'actor') Object.defineProperty(stamped, key, { value: raw[key], enumerable: true, writable: true, configurable: true });
  }
  stamped.actor = 'agent';
  return checkRefined(AgentEmailOpSchema, stamped, (op) => refineEmailOp(op));
};

/** Read a stored EmailDoc of any version into v1 (v1 is the only version yet: validated and copied). */
export const migrateEmailDoc = (value: unknown): CheckResult<EmailDoc> => migrateV1(value, 'EmailDoc', (v) => checkEmailDoc(v));
