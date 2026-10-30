/**
 * EmailDoc v1 in the schema DSL (plan §5.2, §7): `Infer<typeof EmailDocSchema>` IS the frozen contract type
 * `EmailDoc`, `Infer<typeof AgentEmailOpSchema>` is `AgentEmailOp`. Rules the DSL cannot say are refinements, run by
 * `checkEmailDoc` and by `applyEmailOps`:
 * - the whole plain-text body (`emailBodyTextLength`) is at most `EMAIL_LIMITS.field` characters, so a draft fits a
 *   10,000-character composer (`too-long` at `blocks`);
 * - a `docx` attachment carries a doc and a `pptx` one a deck (`tag` at `spec.type`); an attached doc or deck obeys
 *   its own model's refinements;
 * - block ids are unique across the email (columns included) and attachment ids across its attachments; a run names
 *   each mark at most once.
 *
 * An email with no attachments has no `attachments` field: the list, when present, holds at least one (`too-few`), so
 * attach followed by its undo gives back exactly the email it started from. Hosts drop an empty list a model writes
 * before `checkEmailDoc`.
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
import {
  checkRefined,
  idSchema,
  idScope,
  insertIndexSchema,
  isRecord,
  listItemsOf,
  migrateV1,
  opBaseFields,
  refineError,
  repeatedMarks,
  runsOf,
} from '../common.js';
import { DeckSpecSchema, refineDeckSpec } from '../deck/schema.js';
import { RichDocSchema, refineRichDoc } from '../richdoc/schema.js';

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
  /** Absent when there are none: a present list holds 1–5 (so attach + undo is exact). */
  attachments: s.optional(s.array(AttachmentSpecSchema, { min: 1, max: E.attachments })),
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
 * What `emailBodyTextLength` adds for the plain-text formatting around the text. The measure is an UPPER bound on
 * the plain text `emailToPlainText` (src/email/plainText.ts) writes, so a body under the cap always fits the composer.
 * It follows that layout: blocks are separated by a blank line; a list item is `  `×indent, then `- ` or `n. `, and
 * every line after its first is padded to the same width; every line of a quote starts with `> ` and its cite is a
 * last line `> — cite`; an image is `[Image: alt]`; the signature follows a `-- ` line. A layout that needs more room
 * changes these numbers (and the tests that pin them), never the cap.
 */
export const EMAIL_TEXT_ALLOWANCE = {
  /** The blank line between blocks (and before the signature). */
  block: 2,
  /** A list item's prefix (at most 9: an indent of 4, then `100. `) and the line break before the next item. */
  listItem: 10,
  /** ` (` + `)` around a linked run's href. */
  link: 3,
  /** `: ` between a button's label and its href, and a line break. */
  button: 4,
  /** `[Image: ` + `]` around an image's alt text. */
  image: 9,
  /** A rule (`---`) and its line break. */
  divider: 4,
  /** The `> ` before a quote's first line. */
  quote: 2,
  /** The line break, `> ` and `— ` before a quote's cite. */
  cite: 5,
  /**
   * What a line break inside a quote (or its cite) adds: the next line's `> `. A line break inside a list item adds
   * that item's prefix width instead (`listPrefixWidth`); in a heading, paragraph, alt text or the signature it adds
   * nothing (alt text is written on one line).
   */
  lineBreak: 2,
  /** The `-- ` line before the signature. */
  signature: 4,
} as const;

const A = EMAIL_TEXT_ALLOWANCE;
const LINE_BREAK = /\r\n|\r|\n/g;

/**
 * The width of list item `number`'s prefix (1-based, counting every item of the list): `  ` per indent level, then
 * `- ` or `n. `. Every line of the item after its first is padded to this width. At most 9 within the schema's caps.
 */
export const listPrefixWidth = (ordered: boolean, indent: number, number: number): number => 2 * indent + (ordered ? String(number).length + 2 : 2);

/** `text` plus `perBreak` for each of its line breaks (CRLF counts once). */
const textLength = (text: string, perBreak: number): number => text.length + (perBreak ? (text.match(LINE_BREAK) || []).length * perBreak : 0);

const runsLength = (runs: readonly Run[], perBreak: number): number => {
  let n = 0;
  for (const run of runs) n += textLength(run.text, perBreak) + (run.link ? run.link.href.length + A.link : 0);
  return n;
};

const blockLength = (block: EmailBlock): number => {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
      return runsLength(block.runs, 0) + A.block;
    case 'list': {
      let n = A.block;
      block.items.forEach((item, i) => {
        n += runsLength(item.runs, listPrefixWidth(block.ordered, item.indent || 0, i + 1)) + A.listItem;
      });
      return n;
    }
    case 'button':
      return textLength(block.label, 0) + block.href.length + A.button + A.block;
    case 'quote':
      return A.quote + runsLength(block.runs, A.lineBreak) + (block.cite !== undefined ? textLength(block.cite, A.lineBreak) + A.cite : 0) + A.block;
    case 'divider':
      return A.divider + A.block;
    case 'image':
      return textLength(block.alt, 0) + A.image + A.block;
    case 'columns': {
      let n = A.block;
      for (const column of block.columns) for (const inner of column.blocks) n += blockLength(inner);
      return n;
    }
  }
};

/**
 * The most characters the plain-text rendering of the body (the blocks and the signature; not the subject) can hold:
 * every text, href, label, cite and alt, plus `EMAIL_TEXT_ALLOWANCE` for the layout around them (see there). The cap
 * `EMAIL_LIMITS.field` applies to it. For a schema-checked document.
 */
export const emailBodyTextLength = (doc: Pick<EmailDoc, 'blocks' | 'signature'>): number => {
  let n = 0;
  for (const block of doc.blocks) n += blockLength(block);
  if (doc.signature !== undefined) n += textLength(doc.signature, 0) + A.signature;
  return n;
};

// ── Refinements ────────────────────────────────────────────────────────────────────────────────────────────────

/** A docx needs a doc and a pptx a deck (a pdf takes either); an attached doc or deck obeys its model's refinements. */
export const refineAttachment = (attachment: AttachmentSpec, path: RefinePath): CheckError[] => {
  const errors: CheckError[] = [];
  const { kind, spec } = attachment;
  if ((kind === 'docx' && spec.type !== 'doc') || (kind === 'pptx' && spec.type !== 'deck')) {
    errors.push(refineError(path.concat(['spec', 'type']), 'tag', `a ${kind} attachment needs a ${kind === 'docx' ? 'doc' : 'deck'}`));
  }
  return errors.concat(
    spec.type === 'deck' ? refineDeckSpec(spec.deck, path.concat(['spec', 'deck'])) : refineRichDoc(spec.doc, path.concat(['spec', 'doc'])),
  );
};

/** The refinements of a whole (schema-checked) email. */
export const refineEmailDoc = (doc: EmailDoc): CheckError[] => {
  let errors: CheckError[] = [];
  const attachmentIds = idScope('attachment');
  (doc.attachments || []).forEach((attachment, i) => {
    attachmentIds.add(attachment.id, ['attachments', i]);
    errors = errors.concat(refineAttachment(attachment, ['attachments', i]));
  });
  const blockIds = idScope('block');
  doc.blocks.forEach((block, i) => {
    blockIds.add(block.id, ['blocks', i]);
    if (block.type === 'columns') {
      block.columns.forEach((column, c) => column.blocks.forEach((inner, j) => blockIds.add(inner.id, ['blocks', i, 'columns', c, 'blocks', j])));
    }
  });
  errors = errors.concat(attachmentIds.errors, blockIds.errors, repeatedMarks(doc.blocks, ['blocks']));
  const length = emailBodyTextLength(doc);
  if (length > E.field) {
    errors.push(refineError(['blocks'], 'too-long', `the body must be at most ${E.field} characters of plain text (it has about ${length})`));
  }
  return errors;
};

/**
 * Op rules the DSL cannot say: an attached spec obeys `refineAttachment`; `update_block` keeps the block's id; a
 * carried block repeats no mark.
 */
export const refineEmailOp = (op: EmailOp): CheckError[] => {
  if (op.op === 'attach') return refineAttachment(op.attachment, ['attachment']);
  if (op.op !== 'insert_block' && op.op !== 'update_block') return [];
  const errors =
    op.op === 'update_block' && op.block.id !== op.blockId ? [refineError(['block', 'id'], 'literal', `must be the blockId, ${JSON.stringify(op.blockId)}`)] : [];
  return errors.concat(repeatedMarks(op.block, ['block']));
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
