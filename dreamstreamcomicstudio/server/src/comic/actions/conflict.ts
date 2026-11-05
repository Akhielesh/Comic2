// Answering a conflict card (resolve_conflict; agent-editor plan §3 A3.1, owner decision D3). Owned by A3 CONFLICT.
//
// Free, never a spend. 'mine' keeps the creator's edit and marks the items answered. 'theirs' re-sanitizes the stored
// held-back ops against the CURRENT doc with the CLIENT patch sanitizer (sanitizePatchOps: the same checks, safety
// screen included, as any edit the creator sends; a server-only op can never be committed from a card) and commits
// them with origin 'director', so the creator's Undo brings their version back. It never applies half an item:
//   - a `tooBig` item (its ops were not stored whole) is refused in plain words and stays open;
//   - a stale item (its line was removed since, or the sanitizer refuses an op) is refused in plain words and stays open;
//   - a line the creator moved to another panel since still takes the director's words (the op follows the line).
// Items are marked answered by rewriting the card's message (one `message` op), so a reload or another device shows it.
// With the conflict guard off (COMIC_CONFLICT_GUARD) the answer is refused before anything runs, and nothing changes.

import { conflictGuardOn } from '../../../../shared/comic/capabilities.js';
import { newId, normalizeConflictCard, type Card, type ComicDoc, type ConflictCard, type ConflictItem, type Msg } from '../../../../shared/comic/doc.js';
import { applyOps, type DocOp, type ResolveConflictAction } from '../../../../shared/comic/ops.js';
import { locateLine } from '../conflictGuard.js';
import type { ActionHandler } from '../extensions.js';
import { sanitizeCtxFor, sanitizePatchOps, type ActionOutcome, type RunActionOptions, type StartedAction } from '../jobs.js';
import { StudioError, type StudioContext } from '../types.js';

export const CONFLICT_NOT_AVAILABLE = "Answering a conflict card isn't available right now. Nothing was changed.";

/** The undo label of a "Use the director's" answer ("Undo use the director's version"). */
export const USE_THEIRS_LABEL = "Use the director's version";

/** Plain words for an item "Use the director's" cannot apply. */
export const TOO_BIG_TEXT = "that change is too big to apply from here; Show me opens it";
export const STALE_TEXT = "it was removed since, so the director's version can't be applied";

const finished = (outcome: ActionOutcome): StartedAction => ({ outcome, done: Promise.resolve() });

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The message holding conflict card `cardId` (newest first), with the card as stored. */
const findCard = (doc: ComicDoc, cardId: string): { msg: Msg; card: ConflictCard } | undefined => {
  for (let i = doc.conversation.length - 1; i >= 0; i -= 1) {
    const msg = doc.conversation[i];
    const card = msg.cards?.find((c): c is ConflictCard => c.type === 'conflict' && c.id === cardId);
    if (card) return { msg, card };
  }
  return undefined;
};

/** A well-formed answer, or a 400 (a client never sends anything else). */
const parseAnswer = (action: unknown): ResolveConflictAction => {
  const a = action as Partial<ResolveConflictAction> | null;
  const ok =
    !!a &&
    typeof a.cardId === 'string' &&
    !!a.cardId &&
    a.cardId.length <= 80 &&
    Array.isArray(a.itemIds) &&
    a.itemIds.length > 0 &&
    a.itemIds.length <= 50 &&
    a.itemIds.every((id) => typeof id === 'string' && !!id && id.length <= 80) &&
    (a.choice === 'mine' || a.choice === 'theirs');
  if (!ok) throw new StudioError('BAD_REQUEST', "That answer doesn't fit the question. Nothing was changed.", { status: 400 });
  return { type: 'resolve_conflict', cardId: a!.cardId!, itemIds: [...new Set(a!.itemIds!)], choice: a!.choice! };
};

/**
 * The item's held-back ops, followed to where their lines are NOW, or the plain reason they can't be applied. A line
 * the creator deleted is stale (an upsert would silently re-create it); a line the creator moved to another panel takes
 * the op along (its panelId is rewritten), so the director's words land on the line wherever it sits.
 */
export function followOps(doc: ComicDoc, ops: readonly DocOp[]): { ops: DocOp[] } | { stale: string } {
  const out: DocOp[] = [];
  // Lines this item itself adds: later ops on them (its balloon, its look) follow the new line, never "removed since".
  const created = new Set<string>();
  const isNew = (id: string) => created.has(id) && !locateLine(doc, id);
  for (const op of ops) {
    switch (op.op) {
      case 'line': {
        if (typeof op.index === 'number' && op.patch !== null) {
          // A new line the director wanted to add: the sanitizer checks its panel still exists.
          if (!locateLine(doc, op.id)) created.add(op.id);
          out.push(op);
          break;
        }
        if (isNew(op.id)) {
          if (op.patch === null) created.delete(op.id);
          out.push(op);
          break;
        }
        const at = locateLine(doc, op.id);
        if (!at) return { stale: STALE_TEXT };
        out.push(at.page.id === op.pageId && at.panel.id === op.panelId ? op : { ...op, pageId: at.page.id, panelId: at.panel.id });
        break;
      }
      case 'line_move':
      case 'balloon': {
        if (isNew(op.op === 'balloon' ? op.lineId : op.id)) {
          out.push(op);
          break;
        }
        const at = locateLine(doc, op.op === 'balloon' ? op.lineId : op.id);
        if (!at || at.page.id !== op.pageId) return { stale: STALE_TEXT };
        out.push(op);
        break;
      }
      case 'line_style': {
        if (!op.lineIds.length || op.lineIds.some((id) => !isNew(id) && locateLine(doc, id)?.page.id !== op.pageId)) return { stale: STALE_TEXT };
        out.push(op);
        break;
      }
      default:
        out.push(op);
    }
  }
  return { ops: out };
}

/** Tell the creator what could not be applied: a notice in the director's message, else a new assistant message. */
const say = (ctx: StudioContext, opts: RunActionOptions, text: string): void => {
  const card: Card = { type: 'notice', id: newId('card'), tone: 'info', text };
  if (opts?.collectCard) opts.collectCard(card);
  else {
    const msg: Msg = { id: newId('msg'), role: 'assistant', text, at: Date.now(), cards: [card] };
    ctx.session.commit([{ op: 'message', msg }]);
  }
};

/** "page 2 · panel 1 · line 2" with a capital first letter, for the start of a sentence. */
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Answer a conflict card. Free; synchronous; one content commit (origin 'director', undoable as one step) and one
 * card rewrite. Returns `done` when at least one item was answered, else `blocked` with the plain reason.
 */
export function resolveConflict(ctx: StudioContext, raw: ResolveConflictAction, opts: RunActionOptions): ActionOutcome {
  const action = parseAnswer(raw);
  const doc = ctx.session.doc;
  const found = findCard(doc, action.cardId);
  const card = found ? normalizeConflictCard(found.card) : undefined;
  if (!found || !card) {
    const message = "That question is no longer in the conversation. Nothing was changed.";
    say(ctx, opts, message);
    return { status: 'blocked', message };
  }
  const wanted = new Set(action.itemIds);
  const chosen = card.items.filter((it) => wanted.has(it.id));
  if (!chosen.length) {
    const message = "Nothing on that card matches your answer. Nothing was changed.";
    say(ctx, opts, message);
    return { status: 'blocked', message };
  }

  let working = doc;
  const content: DocOp[] = [];
  const answered = new Map<string, NonNullable<ConflictItem['resolved']>>();
  const refusals: string[] = [];
  let already = 0;
  for (const item of chosen) {
    if (item.resolved) {
      already += 1;
      continue;
    }
    if (action.choice === 'mine') {
      answered.set(item.id, 'mine');
      continue;
    }
    if (item.tooBig) {
      refusals.push(`${cap(item.where.label)}: ${TOO_BIG_TEXT}.`);
      continue;
    }
    if (!item.proposed.length) {
      refusals.push(`${cap(item.where.label)}: nothing of the director's version is left to apply.`);
      continue;
    }
    const followed = followOps(working, item.proposed);
    if ('stale' in followed) {
      refusals.push(`${cap(item.where.label)}: ${followed.stale}. Nothing was changed there.`);
      continue;
    }
    try {
      // The CLIENT patch sanitizer against the doc as this answer has built it: ids, limits, safety screen, and no
      // server-only op (a card can never commit what the creator could not send themselves).
      const clean = sanitizePatchOps(working, followed.ops, sanitizeCtxFor(ctx, opts));
      working = applyOps(working, clean);
      content.push(...clean);
      answered.set(item.id, 'theirs');
    } catch (err) {
      if (!(err instanceof StudioError)) throw err;
      const why = err.userMessage.replace(/[.!\s]+$/, '');
      refusals.push(`${cap(item.where.label)}: the director's version can't be applied (${why}). Nothing was changed there.`);
    }
  }

  if (content.length) {
    try {
      ctx.session.commit(content, { origin: 'director', label: USE_THEIRS_LABEL });
    } catch (err) {
      if (!(err instanceof StudioError)) throw err;
      // The doc refused the batch (size cap): nothing was applied, so nothing is marked answered 'theirs'.
      for (const [id, how] of answered) if (how === 'theirs') answered.delete(id);
      refusals.push(`The director's version can't be applied right now (${err.userMessage.replace(/[.!\s]+$/, '')}). Nothing was changed.`);
    }
  }

  if (answered.size) {
    const items = card.items.map((it) => (answered.has(it.id) ? { ...it, resolved: answered.get(it.id)! } : it));
    const cards = (found.msg.cards || []).map((c) => (c.type === 'conflict' && c.id === card.id ? { ...card, items } : c));
    ctx.session.commit([{ op: 'message', msg: { ...found.msg, cards } }]);
  }

  const kept = [...answered.values()].filter((v) => v === 'mine').length;
  const used = answered.size - kept;
  const parts: string[] = [];
  if (kept) parts.push(kept === 1 ? 'Kept your version.' : `Kept your version of ${plural(kept, 'thing')}.`);
  if (used) parts.push(used === 1 ? "Used the director's version. Undo brings yours back." : `Used the director's version of ${plural(used, 'thing')}. Undo brings yours back.`);
  if (refusals.length) {
    const text = refusals.join(' ');
    say(ctx, opts, text);
    parts.push(text);
  }
  if (!answered.size && !refusals.length && already) {
    return { status: 'done', message: already === 1 ? 'That was already answered.' : 'Those were already answered.' };
  }
  const message = parts.join(' ');
  return answered.size ? { status: 'done', message } : { status: 'blocked', message };
}

/** resolve_conflict (free): refused while the conflict guard is off for this user, before anything runs. */
export const resolveConflictAction: ActionHandler = {
  type: 'resolve_conflict',
  spend: false,
  unavailable: (ctx) => (conflictGuardOn(ctx?.caps) ? null : CONFLICT_NOT_AVAILABLE),
  run: async (ctx, action, opts) => finished(resolveConflict(ctx, action as ResolveConflictAction, opts ?? { confirmed: false }))
};

export const CONFLICT_ACTIONS: ActionHandler[] = [resolveConflictAction];
