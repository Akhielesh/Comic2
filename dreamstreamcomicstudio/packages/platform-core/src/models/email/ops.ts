/**
 * EmailDoc ops (plan §5.2, §7): `applyEmailOps(doc, ops) → {doc, applied, rejected}` with exact inverses. The op
 * rules are in models/common.ts; what is EmailDoc's own:
 *
 * - Only a person changes recipients. `set_recipients` without `actor: 'user'` (absent means agent) is refused as
 *   `forbidden`, before anything else is looked at. It replaces `to`, `cc` and `bcc` together: an absent `cc` / `bcc`
 *   clears that field, and its inverse carries the previous three fields exactly (absent stays absent).
 * - Block ops address TOP-LEVEL blocks only: `index` is a position in `blocks`, and a `blockId` that names a block
 *   inside a `columns` block is `not-found` (that block changes through an `update_block` of its columns block).
 * - Block ids are unique across the email, columns included; attachment ids across its attachments (`invalid`).
 * - `attach` honours `index` (absent appends); `detach`'s inverse is an `attach` at the old index. An email with no
 *   attachments has no `attachments` field (the schema refuses an empty list): detaching the last attachment removes
 *   the field, so attach followed by its undo is exact.
 * - Caps: `EMAIL_LIMITS.blocks` blocks and `EMAIL_LIMITS.attachments` attachments, and a block op may not take the
 *   plain-text body past `EMAIL_LIMITS.field` characters (`emailBodyTextLength`) (`limit`).
 * - There is no op, mode or field that sends.
 */
import type { OpId } from '../../contract/schema.js';
import type { EmailBlock, EmailDoc, EmailOp, EmailOpResult, EmailRecipient } from '../../contract/email.js';
import { EMAIL_LIMITS } from '../../contract/email.js';
import type { ApplyOptions, InverseMeta, OpKernel, Step } from '../common.js';
import { applyOpsWith, firstRepeat, indexById, insertAt, invertOpWith, invertOpsWith, removeAt, replaceAt, stepFail, stepOk } from '../common.js';
import { EmailOpSchema, emailBodyTextLength, refineEmailOp } from './schema.js';

const E = EMAIL_LIMITS;

/** A block's own id and, for `columns`, every id inside it. */
const idsOf = (block: EmailBlock): string[] => {
  const ids = [block.id];
  if (block.type === 'columns') for (const column of block.columns) for (const inner of column.blocks) ids.push(inner.id);
  return ids;
};

/** Every block id in `blocks` except those of the block at `skip`. */
const usedIds = (blocks: readonly EmailBlock[], skip = -1): Set<string> => {
  const out = new Set<string>();
  blocks.forEach((block, i) => {
    if (i !== skip) for (const id of idsOf(block)) out.add(id);
  });
  return out;
};

/** Why `block` cannot join `blocks` (a repeated or already-used id), or null. */
const idClash = (block: EmailBlock, blocks: readonly EmailBlock[], skip = -1): string | null => {
  const ids = idsOf(block);
  const repeat = firstRepeat(ids);
  if (repeat !== null) return `block id ${repeat} appears twice in the new block`;
  const used = usedIds(blocks, skip);
  for (const id of ids) if (used.has(id)) return `block id ${id} is already used`;
  return null;
};

/** Refuse a body change that takes the plain-text body past the cap (and longer than it was). */
const withinBody = (doc: EmailDoc, next: EmailDoc): Step<EmailDoc> => {
  const after = emailBodyTextLength(next);
  if (after > E.field && after > emailBodyTextLength(doc)) {
    return stepFail('limit', `the body would be about ${after} characters of plain text; an email holds at most ${E.field}`);
  }
  return stepOk(next);
};

const notTopLevel = (blockId: string): string => `there is no top-level block ${blockId} (a block inside columns changes through its columns block)`;

const step = (doc: EmailDoc, op: EmailOp): Step<EmailDoc> => {
  switch (op.op) {
    case 'set_subject':
      return stepOk({ ...doc, subject: op.subject });
    case 'insert_block': {
      const clash = idClash(op.block, doc.blocks);
      if (clash) return stepFail('invalid', clash);
      const index = op.index === undefined ? doc.blocks.length : op.index;
      if (index > doc.blocks.length) return stepFail('invalid', `index ${index} is past the end of the blocks (${doc.blocks.length})`);
      if (doc.blocks.length >= E.blocks) return stepFail('limit', `an email holds at most ${E.blocks} blocks`);
      return withinBody(doc, { ...doc, blocks: insertAt(doc.blocks, index, op.block) });
    }
    case 'update_block': {
      const at = indexById(doc.blocks, op.blockId);
      if (at === -1) return stepFail('not-found', notTopLevel(op.blockId));
      const clash = idClash(op.block, doc.blocks, at);
      if (clash) return stepFail('invalid', clash);
      return withinBody(doc, { ...doc, blocks: replaceAt(doc.blocks, at, op.block) });
    }
    case 'remove_block': {
      const at = indexById(doc.blocks, op.blockId);
      if (at === -1) return stepFail('not-found', notTopLevel(op.blockId));
      return stepOk({ ...doc, blocks: removeAt(doc.blocks, at) });
    }
    case 'attach': {
      const list = doc.attachments || [];
      if (indexById(list, op.attachment.id) !== -1) return stepFail('invalid', `attachment id ${op.attachment.id} is already used`);
      const index = op.index === undefined ? list.length : op.index;
      if (index > list.length) return stepFail('invalid', `index ${index} is past the end of the attachments (${list.length})`);
      if (list.length >= E.attachments) return stepFail('limit', `an email holds at most ${E.attachments} attachments`);
      return stepOk({ ...doc, attachments: insertAt(list, index, op.attachment) });
    }
    case 'detach': {
      const list = doc.attachments || [];
      const at = indexById(list, op.attachmentId);
      if (at === -1) return stepFail('not-found', `there is no attachment ${op.attachmentId}`);
      const next: EmailDoc = { ...doc, attachments: removeAt(list, at) };
      if (!next.attachments || !next.attachments.length) delete next.attachments;
      return stepOk(next);
    }
    case 'set_recipients': {
      // The gate already refused every actor but 'user'; this is the second lock on the same door.
      if (op.actor !== 'user') return stepFail('forbidden', 'only a person changes recipients');
      const next: EmailDoc = { ...doc, to: op.to };
      if (op.cc !== undefined) next.cc = op.cc;
      else delete next.cc;
      if (op.bcc !== undefined) next.bcc = op.bcc;
      else delete next.bcc;
      return stepOk(next);
    }
  }
};

/** `{op, id, baseRev}` plus the forward op's `actor` when it had one (whoever did, undoes). */
const envelope = <K extends string>(op: K, from: EmailOp, id: OpId, baseRev: number): { op: K; id: OpId; baseRev: number; actor?: 'user' | 'agent' } =>
  from.actor !== undefined ? { op, id, baseRev, actor: from.actor } : { op, id, baseRev };

const invert = (before: EmailDoc, op: EmailOp, id: OpId, baseRev: number): EmailOp | null => {
  switch (op.op) {
    case 'set_subject':
      return { ...envelope('set_subject', op, id, baseRev), subject: before.subject };
    case 'insert_block':
      return { ...envelope('remove_block', op, id, baseRev), blockId: op.block.id };
    case 'update_block': {
      const at = indexById(before.blocks, op.blockId);
      return at === -1 ? null : { ...envelope('update_block', op, id, baseRev), blockId: op.blockId, block: before.blocks[at] };
    }
    case 'remove_block': {
      const at = indexById(before.blocks, op.blockId);
      return at === -1 ? null : { ...envelope('insert_block', op, id, baseRev), index: at, block: before.blocks[at] };
    }
    case 'attach':
      return { ...envelope('detach', op, id, baseRev), attachmentId: op.attachment.id };
    case 'detach': {
      const list = before.attachments || [];
      const at = indexById(list, op.attachmentId);
      return at === -1 ? null : { ...envelope('attach', op, id, baseRev), index: at, attachment: list[at] };
    }
    case 'set_recipients': {
      const out: { op: 'set_recipients'; id: OpId; baseRev: number; actor: 'user'; to: EmailRecipient[]; cc?: EmailRecipient[]; bcc?: EmailRecipient[] } = {
        op: 'set_recipients',
        id,
        baseRev,
        actor: 'user',
        to: before.to,
      };
      if (before.cc !== undefined) out.cc = before.cc;
      if (before.bcc !== undefined) out.bcc = before.bcc;
      return out;
    }
  }
};

/** Refused before the op's shape is even read: only a person (the host stamps `actor: 'user'`) changes recipients. */
const gate = (raw: Record<string, unknown>): { code: 'forbidden'; message: string } | null =>
  raw.op === 'set_recipients' && raw.actor !== 'user'
    ? { code: 'forbidden', message: "only a person changes recipients: set_recipients needs actor 'user', which the host stamps" }
    : null;

const KERNEL: OpKernel<EmailDoc, EmailOp> = { noun: 'email', schema: EmailOpSchema, refine: refineEmailOp, gate, step, invert };

/**
 * Apply `ops` to `doc`: pure, immutable, never throws. Returns the next email (the same object when nothing applied),
 * the ops that applied (checked copies) and the refused ones with why (`forbidden` for an agent's `set_recipients`).
 * See the op rules in models/common.ts and above.
 */
export const applyEmailOps = (doc: EmailDoc, ops: readonly EmailOp[], options?: ApplyOptions): EmailOpResult => applyOpsWith(KERNEL, doc, ops, options);

/**
 * The undo batch for the ops one `applyEmailOps(before, …)` call applied: newest first, stamped with
 * `meta.id(op, index)` and `meta.baseRev`, each carrying its forward op's `actor`. `insert_block` ↔ `remove_block`
 * (back at the old index), `attach` ↔ `detach` (back at the old index); `set_subject`, `update_block` and
 * `set_recipients` invert to themselves with the old value. Null when an op does not apply to `before`.
 */
export const invertEmailOps = (before: EmailDoc, applied: readonly EmailOp[], meta: InverseMeta<EmailOp>): EmailOp[] | null =>
  invertOpsWith(KERNEL, before, applied, meta);

/** The exact inverse of one op as applied to `before`, or null. */
export const invertEmailOp = (before: EmailDoc, op: EmailOp, meta: { id: OpId; baseRev: number }): EmailOp | null => invertOpWith(KERNEL, before, op, meta);
