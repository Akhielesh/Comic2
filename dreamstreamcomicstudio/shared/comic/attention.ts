// What the comic is waiting on the person for, derived in one place (notify SPEC §5.1; root cause R6): the alert core's
// "Needs you" moments, and later the stored comic status (NF-7). Pure and server-safe: a function of the stored doc
// (settle.ts says which cards are still open), so a reload, another tab and the server agree. It never reads a price
// and returns no text: a key (gate, message and card ids, the same on a replayed stream) and, for an approval, how many
// pictures wait.
//
// Order of checks:
//  1. approval: an open spend gate (doc.gate.status === 'open');
//  2. question: in any assistant message since the person's last message, newest first, while the card is still live
//     by the settle rule (a later agent turn settles it; a message from work already running does not), an open options card with
//     choices, an unresolved conflict card, a pending publish confirm, or a live model-outage choice;
//  3. plan: the page plan waits for its OK (planStatus 'draft', at least one page, a live plan card or a breakdown card
//     that is not a gate's own, and nothing drawing);
//  4. style: looks waiting to be picked (a live style_presets card with nothing picked, or a live style_choice card while
//     the style is not locked and at least one option is drawn).

import type { Card, ComicDoc, Msg, RenderState } from './doc.js';
import { buildSettleIndex, settleKey, type SettleIndex } from './settle.js';

export type NeedsWhy = 'approval' | 'question' | 'plan' | 'style';

export interface NeedsYou {
  why: NeedsWhy;
  /** 'gate:<gateId>' | 'card:<msgId>:<cardId>' | 'plan:<msgId>:<cardId>' | 'style:<msgId>:<cardId>'. */
  key: string;
  /** approval: pictures waiting to be drawn. */
  imageCount?: number;
}

const BUSY = new Set(['queued', 'rendering']);
const busy = (r: RenderState | undefined | null): boolean => !!r && BUSY.has(r.status);
const list = <T>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);

/** A render is queued or running on any target (pages, cover, cast and place sheets, style options). */
export function anyRenderBusy(doc: ComicDoc | null | undefined): boolean {
  if (!doc) return false;
  try {
    return (
      list(doc.pages).some((p) => busy(p?.render)) ||
      busy(doc.cover?.render) ||
      list(doc.cast).some((c) => busy(c?.sheet)) ||
      list(doc.places).some((p) => busy(p?.sheet)) ||
      list(doc.style?.options).some((o) => busy(o?.render))
    );
  } catch {
    return false;
  }
}

const cardsOf = (m: Msg | undefined): Card[] => (Array.isArray(m?.cards) ? (m!.cards as Card[]) : []);
const hasId = (c: unknown): c is Card & { id: string } => !!c && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string';

/** Assistant messages after the person's last message, newest first. */
const sinceLastUser = (conv: readonly Msg[]): Msg[] => {
  const out: Msg[] = [];
  for (let i = conv.length - 1; i >= 0; i -= 1) {
    const m = conv[i];
    if (m?.role === 'user') break;
    if (m?.role === 'assistant' && typeof m.id === 'string') out.push(m);
  }
  return out;
};

/** Every assistant message, newest first (live views settle on their own once passed or replaced). */
const assistantNewestFirst = (conv: readonly Msg[]): Msg[] => conv.filter((m) => m?.role === 'assistant' && typeof m.id === 'string').reverse();

const stateOf = (index: SettleIndex, m: Msg, c: Card & { id: string }) => index.get(settleKey(m.id, c.id))?.state;

const isQuestion = (index: SettleIndex, m: Msg, c: Card & { id: string }): boolean => {
  const state = stateOf(index, m, c);
  switch (c.type) {
    case 'options':
      return state === 'open' && Array.isArray(c.choices) && c.choices.length > 0;
    case 'conflict':
      return state === 'open';
    case 'publish':
      return c.status === 'pending' && state === 'live';
    case 'model_outage':
      return state === 'live';
    // credit-safety.md: a run that stopped on an empty key, or a step that did not fit, waits on a top-up or a key
    // switch (the card stays live until the chat moves past it), so it is not "Pages are ready".
    case 'credit':
      return state === 'live';
    default:
      return false;
  }
};

/** What waits on the person in this comic, most pressing first, or null. */
export function needsYouOf(doc: ComicDoc | null | undefined): NeedsYou | null {
  if (!doc) return null;
  try {
    const gate = doc.gate;
    if (gate && gate.status === 'open' && typeof gate.id === 'string') {
      const n = Number.isFinite(gate.imageCount) && gate.imageCount > 0 ? Math.floor(gate.imageCount) : undefined;
      return { why: 'approval', key: `gate:${gate.id}`, ...(n ? { imageCount: n } : {}) };
    }
    const conv = list(doc.conversation);
    if (!conv.length) return null;
    const index = buildSettleIndex(doc);

    for (const m of sinceLastUser(conv)) {
      for (const c of cardsOf(m)) if (hasId(c) && isQuestion(index, m, c)) return { why: 'question', key: `card:${m.id}:${c.id}` };
    }

    const assistant = assistantNewestFirst(conv);
    if (doc.planStatus === 'draft' && list(doc.pages).length > 0 && !anyRenderBusy(doc)) {
      for (const m of assistant) {
        for (const c of cardsOf(m)) {
          if (!hasId(c)) continue;
          const planCard = c.type === 'plan' || (c.type === 'breakdown' && !c.gateId);
          if (planCard && stateOf(index, m, c) === 'live') return { why: 'plan', key: `plan:${m.id}:${c.id}` };
        }
      }
    }

    const locked = doc.style?.status === 'locked';
    const drawnLook = list(doc.style?.options).some((o) => o?.render?.status === 'ready');
    for (const m of assistant) {
      for (const c of cardsOf(m)) {
        if (!hasId(c) || stateOf(index, m, c) !== 'live') continue;
        if (c.type === 'style_presets' && !(typeof c.picked === 'string' && c.picked)) return { why: 'style', key: `style:${m.id}:${c.id}` };
        if (c.type === 'style_choice' && !locked && drawnLook) return { why: 'style', key: `style:${m.id}:${c.id}` };
      }
    }
    return null;
  } catch {
    return null;
  }
}
