// Settled cards (PROGRAM3 SETTLE-0 + SETTLE-SRV; settle.md §5; lead decision D3, CHANGED).
//
// What an old chat card turns into once the conversation has moved on. Pure: a function of the stored doc, plus this
// tab's message on its way, so a reload, a second tab and another device all agree, and legacy docs need no migration
// (production's unanswered option cards read "Not answered — you moved on").
//
// D3 (the owner: users "should not be able to view/edit those options once the chat has moved forward"): a settled card
// has NO controls and NO "Show details". It collapses to one line of words (summaryOf). A settled renders or media card
// adds one plain link to where the pictures live (the board or Media) and mounts no image. There is no details model.
//
// Card states (§5.1): open = a question or approval the user can answer now; live = a current view that may carry
// actions; settled = the one summary line. A card settles once it is PASSED (a committed user message comes after its
// message, or this tab's message is sending), except an open gate, a running render and a waiting "wait and retry",
// which stay live however old they are. Live views (plan, cast, renders, …) also settle when a newer card of the same
// kind arrives (kindKeyOf).
//
// Two facts the live doc forgets are stamped on the card by the server with `message_patch` (≤ about 120 bytes each):
// a gate's outcome (`closed`, jobs.ts commitGate and session.ts's expiry, through gateStampOps) and a book card's counts
// (`counts`, withPlanCounts where a plan or breakdown card is posted). shared/comic/doc.ts is frozen in S2, so the
// stamped shapes are typed here and read through guards; normalizeCards keeps gate, plan and breakdown cards exactly as
// stored, so the extra fields survive a load.

import type { Card, ClientAction, ComicDoc, ConflictCard, Gate, Msg, RenderTarget } from './doc.js';
import { getRender } from './doc.js';
import type { DocOp } from './ops.js';
import { editionProgress } from './i18n.js';
import { languageSpec } from './languages.js';
import { getImageModel } from './models.js';
import { getStylePreset } from './stylePresets.js';

// ── Flags ────────────────────────────────────────────────────────────────────

/** Rollout stage of settled cards (PROGRAM3 D6): 'off' is the kill switch, 'admins' shows them to admins only. */
export type SettledCardsStage = 'off' | 'admins' | 'all';

/**
 * Admins first in S2; the S2 integration flips it to 'all' after a week. A code constant, not an env var: the client
 * reads `studio.caps.admin`, so capabilities.ts is untouched.
 */
export const SETTLED_CARDS: SettledCardsStage = 'admins';

/** Whether settled cards apply for this viewer at a stage. */
export const settledCardsOn = (admin: boolean | null | undefined, stage: SettledCardsStage = SETTLED_CARDS): boolean =>
  stage === 'all' || (stage === 'admins' && admin === true);

/**
 * settle.md §8 D7 (accept "Noir ink, please" as picking "Noir ink": a courtesy suffix only, never a fuzzy guess) has no
 * recommended default and no PROGRAM3 §6 entry, so it stays off until the owner decides.
 */
export const SETTLE_COURTESY_MATCH: boolean = false;

// ── Terms ────────────────────────────────────────────────────────────────────

type OptionsCard = Extract<Card, { type: 'options' }>;
type GateCard = Extract<Card, { type: 'gate' }>;
type BookCard = Extract<Card, { type: 'plan' | 'breakdown' }>;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isCard = (v: unknown): v is Card => isObject(v) && typeof v.type === 'string';
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * This tab's message on its way (useStudio's pending bubble, studioReducer PendingUserMessage): only a 'sending' one
 * passes the cards before it. `card` is the option card it answers, when the client named one.
 */
export interface SettlePending {
  text: string;
  status: 'sending' | 'failed';
  card?: { id: string; choiceIds?: string[]; custom?: string };
}

export interface SettleOptions {
  pending?: SettlePending | null;
  /** Outage cards with a waiting "wait and retry" intent (reliability/retryIntents.ts waitingRetries()): they stay live. */
  retrying?: ReadonlySet<string> | readonly string[];
  /** The director is working (studio.busy): a translation card stays live while its editions are still being written. */
  working?: boolean;
}

export type SettleState = 'open' | 'live' | 'settled';

/**
 * Why a card settled:
 * - options: 'picked' (a choice; this tab's answer too), 'answered' (a typed answer), 'skipped' (passed unanswered);
 * - conflict: 'resolved' (every item answered), 'left' (passed with items unresolved: the creator's edit stands);
 * - gate: 'closed' (closed or replaced; summaryOf reads the stamp); a gate's own breakdown: 'folded' into that line;
 * - live views: 'newer' (a newer card of the same kind), 'passed'; style_presets also 'picked';
 * - publish: 'done' (published or declined).
 */
export type SettleOutcome = 'picked' | 'answered' | 'skipped' | 'resolved' | 'left' | 'closed' | 'folded' | 'newer' | 'passed' | 'done';

export interface CardSettle {
  state: SettleState;
  outcome?: SettleOutcome;
  /** Settled by this tab's sending message, before the server has it. */
  pending?: true;
  /** options: the picked choice ids, or the typed answer ('answered'). */
  picked?: string[];
}

const OPEN: CardSettle = Object.freeze({ state: 'open' }) as CardSettle;
const LIVE: CardSettle = Object.freeze({ state: 'live' }) as CardSettle;
const settled = (outcome: SettleOutcome, extra: Partial<CardSettle> = {}): CardSettle => ({ state: 'settled', outcome, ...extra });

const conversationOf = (doc: ComicDoc | null | undefined): Msg[] => (Array.isArray(doc?.conversation) ? doc!.conversation : []);
const cardsOf = (m: Msg | undefined): Card[] => (Array.isArray(m?.cards) ? (m!.cards as Card[]) : []);

/** Index of the last committed user message, or -1. */
const lastUserIndex = (conv: readonly Msg[]): number => {
  for (let i = conv.length - 1; i >= 0; i -= 1) if (conv[i]?.role === 'user') return i;
  return -1;
};

const sending = (opts: SettleOptions | undefined): SettlePending | null =>
  opts?.pending && opts.pending.status === 'sending' && typeof opts.pending.text === 'string' ? opts.pending : null;

/** A committed user message comes after message `msgIndex` (the server's view: the message being routed is not in yet). */
const passedCommitted = (conv: readonly Msg[], msgIndex: number): boolean => msgIndex < lastUserIndex(conv);

/** passed(card) (§5.1): a committed user message comes after the card's message, or this tab's message is sending. */
export const isPassed = (doc: ComicDoc | null | undefined, msgIndex: number, opts: SettleOptions = {}): boolean =>
  passedCommitted(conversationOf(doc), msgIndex) || !!sending(opts);

const ownerKey = (owner: unknown): string => {
  if (!isObject(owner)) return '?';
  return `${str(owner.kind)}:${str(owner.id)}`;
};
const targetKey = (target: unknown): string => (isObject(target) ? `${str(target.kind)}:${str(target.id)}` : '?');

/**
 * The kind key of a live view (§5.1): a card is `latest` when no later card has the same key. null for cards that do
 * not settle on "newer" (questions, gates, notices, publish, outages, a gate's own breakdown, unknown types).
 */
export const kindKeyOf = (card: Card | null | undefined): string | null => {
  if (!isCard(card)) return null;
  switch (card.type) {
    case 'plan':
      return 'book';
    case 'breakdown':
      return card.gateId ? null : 'book';
    case 'style_choice':
    case 'cast':
    case 'recap':
    case 'style_presets':
    case 'share':
    case 'renders':
      return card.type;
    case 'refs':
      return `refs:${ownerKey(card.owner)}`;
    case 'versions':
      return `versions:${targetKey(card.target)}`;
    case 'translation':
      return `translation:${(Array.isArray(card.languages) ? card.languages.filter((l) => typeof l === 'string') : []).slice().sort().join(',')}`;
    case 'history':
      return `history:${str((card as { view?: unknown }).view)}`;
    default:
      return null;
  }
};

// ── Matching an answer to a card's choices (moved from director.ts normalizeAnswer / pickedChoices) ─────────────

/** Lower-case, whitespace collapsed (director.ts normalizeAnswer). */
export const normalizeAnswer = (s: string): string => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

// "…, please" / "… thanks!" / "…!" — one courtesy word and closing punctuation at the very end (D7, behind the flag).
const COURTESY_SUFFIX_RE = /(?:[\s,;:–—-]*\b(?:please|pls|plz|thanks|thank you|thx|ty)\b)?[\s!.…]*$/u;

const choiceText = (c: unknown): { id: string; reply: string; label: string } | null =>
  isObject(c) && typeof c.id === 'string' ? { id: c.id, reply: normalizeAnswer(str(c.reply) || str(c.label)), label: normalizeAnswer(str(c.label)) } : null;

const exactChoices = (card: OptionsCard, want: string): string[] => {
  if (!want) return [];
  const choices = (Array.isArray(card.choices) ? card.choices : []).map(choiceText).filter((c): c is NonNullable<typeof c> => !!c);
  const byText = (s: string) => choices.find((c) => c.reply === s || c.label === s);
  const one = byText(want);
  if (one) return [one.id];
  if (!card.multi) return [];
  // A multi-select card sends its picks as "A, B and C" (OptionsCard.joinChoices).
  const parts = want.split(/\s*,\s*|\s+and\s+/).filter(Boolean);
  const ids = parts.map((p) => byText(p)?.id);
  return parts.length > 1 && ids.every((id): id is string => !!id) ? [...new Set(ids)] : [];
};

/**
 * The choice ids the user's text picks on an options card (none when it is free text). Exact after lower-casing and
 * collapsing whitespace; a multi-select card also takes "A, B and C". With the courtesy match on (D7,
 * SETTLE_COURTESY_MATCH), a choice followed only by "please", "thanks", "!" or "." picks it too — never a fuzzy guess.
 */
export function matchChoices(card: OptionsCard, userText: string, opts: { courtesy?: boolean } = {}): string[] {
  if (!isCard(card) || card.type !== 'options') return [];
  const want = normalizeAnswer(userText);
  const exact = exactChoices(card, want);
  if (exact.length || !(opts.courtesy ?? SETTLE_COURTESY_MATCH)) return exact;
  const trimmed = want.replace(COURTESY_SUFFIX_RE, '').trim();
  return trimmed && trimmed !== want ? exactChoices(card, trimmed) : [];
}

const answeredOf = (card: OptionsCard): string[] => (Array.isArray(card.answered) ? card.answered.filter((a): a is string => typeof a === 'string' && !!a) : []);

// ── The settle rule ─────────────────────────────────────────────────────────

interface PendingAnswer {
  msgIndex: number;
  cardId: string;
  ids: string[];
  custom: boolean;
}

/** Everything the per-card rule needs, computed once per doc revision (O(messages × cards)). */
interface SettleContext {
  doc: ComicDoc;
  conv: Msg[];
  lastUser: number;
  pending: SettlePending | null;
  /** The option card this tab's sending message answers, as the server would record it. */
  answer: PendingAnswer | null;
  /** Last position of each kind key: [message index, card index]. */
  last: Map<string, [number, number]>;
  retrying: ReadonlySet<string>;
  working: boolean;
}

/**
 * The card a sending message answers, the way the server records it (director.ts recordOptionAnswer): the card the
 * client named, when it is not passed and the answer fits it; otherwise the most recent unanswered, not-passed options
 * card whose choices the text matches.
 */
const pendingAnswerOf = (conv: Msg[], lastUser: number, pending: SettlePending | null): PendingAnswer | null => {
  if (!pending) return null;
  const ref = isObject(pending.card) && typeof pending.card.id === 'string' ? pending.card : null;
  if (ref) {
    for (let i = conv.length - 1; i >= 0; i -= 1) {
      const m = conv[i];
      if (m?.role !== 'assistant') continue;
      const card = cardsOf(m).find((c): c is OptionsCard => isCard(c) && c.type === 'options' && c.id === ref.id);
      if (!card) continue;
      // A passed or answered card is kept as it is (answerByRef 'kept'): nothing is recorded, no other card is guessed.
      if (i <= lastUser || answeredOf(card).length) return null;
      const ids = [...new Set(Array.isArray(ref.choiceIds) ? ref.choiceIds.filter((id): id is string => typeof id === 'string') : [])];
      if (ids.length) {
        const known = ids.every((id) => (card.choices || []).some((c) => isObject(c) && c.id === id));
        return known && (card.multi || ids.length === 1) ? { msgIndex: i, cardId: card.id, ids, custom: false } : null;
      }
      const custom = normalizeAnswer(str(ref.custom));
      if (!card.allowCustom || !custom || custom !== normalizeAnswer(pending.text)) return null;
      return { msgIndex: i, cardId: card.id, ids: [pending.text.replace(/\s+/g, ' ').trim()], custom: true };
    }
    // The named card is gone: the server matches the text alone (below).
  }
  for (let i = conv.length - 1; i > lastUser; i -= 1) {
    const m = conv[i];
    if (m?.role !== 'assistant') continue;
    for (const card of cardsOf(m)) {
      if (!isCard(card) || card.type !== 'options' || answeredOf(card).length) continue;
      const ids = matchChoices(card, pending.text);
      if (ids.length) return { msgIndex: i, cardId: card.id, ids, custom: false };
    }
  }
  return null;
};

const contextOf = (doc: ComicDoc, opts: SettleOptions = {}): SettleContext => {
  const conv = conversationOf(doc);
  const lastUser = lastUserIndex(conv);
  const pending = sending(opts);
  const last = new Map<string, [number, number]>();
  conv.forEach((m, i) => cardsOf(m).forEach((c, j) => {
    const key = kindKeyOf(c);
    if (key) last.set(key, [i, j]);
  }));
  const retrying = opts.retrying instanceof Set ? opts.retrying : new Set(Array.isArray(opts.retrying) ? opts.retrying : []);
  return { doc, conv, lastUser, pending, answer: pendingAnswerOf(conv, lastUser, pending), last, retrying, working: opts.working === true };
};

const isBusy = (doc: ComicDoc, target: RenderTarget): boolean => {
  try {
    const status = getRender(doc, target)?.status;
    return status === 'queued' || status === 'rendering';
  } catch {
    return false;
  }
};

const translationRunning = (doc: ComicDoc, languages: unknown): boolean => {
  if (!Array.isArray(languages)) return false;
  try {
    return languages.some((lang) => typeof lang === 'string' && !!languageSpec(lang) && (() => {
      const p = editionProgress(doc, lang);
      return p.done < p.total;
    })());
  } catch {
    return false;
  }
};

const gateOpen = (doc: ComicDoc, gateId: unknown): boolean => !!doc.gate && doc.gate.id === gateId && doc.gate.status === 'open';

function settleWith(ctx: SettleContext, msgIndex: number, cardIndex: number, card: Card): CardSettle {
  const { doc } = ctx;
  const committed = msgIndex < ctx.lastUser;
  const passed = committed || !!ctx.pending;
  const key = kindKeyOf(card);
  const at = key ? ctx.last.get(key) : undefined;
  const latest = !at || (at[0] === msgIndex && at[1] === cardIndex);
  const view = (): CardSettle => (!latest ? settled('newer') : passed ? settled('passed') : LIVE);
  switch (card.type) {
    case 'options': {
      const answered = answeredOf(card);
      if (answered.length) {
        const ids = new Set((card.choices || []).filter(isObject).map((c) => c.id));
        return settled(answered.every((a) => ids.has(a)) ? 'picked' : 'answered', { picked: answered });
      }
      if (committed) return settled('skipped');
      if (ctx.pending) {
        const a = ctx.answer;
        return a && a.msgIndex === msgIndex && a.cardId === card.id
          ? settled(a.custom ? 'answered' : 'picked', { pending: true, picked: a.ids })
          : settled('skipped', { pending: true });
      }
      return OPEN;
    }
    case 'conflict': {
      const items = Array.isArray((card as ConflictCard).items) ? (card as ConflictCard).items.filter(isObject) : [];
      if (items.every((item) => item.resolved === 'mine' || item.resolved === 'theirs')) return settled('resolved');
      return passed ? settled('left', committed ? {} : { pending: true }) : OPEN;
    }
    case 'gate':
      // An open gate never settles on passed: it is the one live approval (the redesign's Approval bar mirrors it).
      return gateOpen(doc, card.gateId) ? OPEN : settled('closed');
    case 'breakdown':
      if (card.gateId) return gateOpen(doc, card.gateId) ? LIVE : settled('folded');
      return view();
    case 'renders': {
      const targets = Array.isArray(card.targets) ? card.targets : [];
      // A running render shows its progress until it finishes, however old its message is.
      if (targets.some((t) => isObject(t) && isBusy(doc, t as RenderTarget))) return LIVE;
      return view();
    }
    case 'style_presets':
      if (typeof card.picked === 'string' && card.picked) return settled('picked');
      return view();
    case 'translation':
      if (ctx.working && translationRunning(doc, card.languages)) return LIVE;
      return view();
    case 'publish':
      if (card.status === 'done' || card.status === 'declined') return settled('done');
      return passed ? settled('passed') : LIVE;
    case 'model_outage':
      // A waiting "wait and retry" keeps its card (and "Don't retry") live.
      if (ctx.retrying.has(card.id)) return LIVE;
      return passed ? settled('passed') : LIVE;
    case 'plan':
    case 'style_choice':
    case 'cast':
    case 'recap':
    case 'refs':
    case 'versions':
    case 'share':
    case 'history':
      return view();
    case 'notice':
    default:
      return passed ? settled('passed') : LIVE;
  }
}

const positionOf = (conv: Msg[], msgIndex: number, card: Card): number => {
  const cards = cardsOf(conv[msgIndex]);
  const same = cards.indexOf(card);
  if (same >= 0) return same;
  return cards.findIndex((c) => isCard(c) && c.type === card.type && (c as { id?: unknown }).id === (card as { id?: unknown }).id);
};

/** How one card reads now (§5.2). `msgIndex` is its message's index in doc.conversation. */
export function cardSettle(doc: ComicDoc, msgIndex: number, card: Card, opts: SettleOptions = {}): CardSettle {
  if (!isCard(card)) return settled('passed');
  const ctx = contextOf(doc, opts);
  return settleWith(ctx, msgIndex, positionOf(ctx.conv, msgIndex, card), card);
}

/** Settle states by message and card id (settleKey); built once per doc revision. */
export type SettleIndex = ReadonlyMap<string, CardSettle>;

export const settleKey = (msgId: string, cardId: string): string => `${msgId}\u0000${cardId}`;

/** Every card's settle state in one pass (ConversationPane memoises it per revision). */
export function buildSettleIndex(doc: ComicDoc, opts: SettleOptions = {}): SettleIndex {
  const out = new Map<string, CardSettle>();
  if (!doc) return out;
  const ctx = contextOf(doc, opts);
  ctx.conv.forEach((m, i) => {
    if (!m || typeof m.id !== 'string') return;
    cardsOf(m).forEach((card, j) => {
      if (!isCard(card) || typeof (card as { id?: unknown }).id !== 'string') return;
      out.set(settleKey(m.id, (card as { id: string }).id), settleWith(ctx, i, j, card));
    });
  });
  return out;
}

/** The settle state of a card in an index (undefined when the card is not in the doc the index was built from). */
export const settleOf = (index: SettleIndex, msg: Pick<Msg, 'id'>, card: Pick<Card, 'id'>): CardSettle | undefined => index.get(settleKey(msg.id, card.id));

/**
 * The last reply asks something the creator has not answered and has not moved past: an open options card (with
 * choices) or a conflict card with an item not yet resolved. A1's queue holds on it (messageQueue.ts openQuestion);
 * a card the creator moved past — their message committed, or this tab's message sending — is not open.
 */
export function isOpenQuestion(doc: ComicDoc | null | undefined, pending?: SettlePending | null): boolean {
  if (!doc) return false;
  const conv = conversationOf(doc);
  let i = conv.length - 1;
  while (i >= 0 && conv[i]?.role !== 'assistant') i -= 1;
  if (i < 0) return false;
  const cards = conv[i]?.cards;
  if (!Array.isArray(cards)) return false;
  const ctx = contextOf(doc, { pending });
  return cards.some((card, j) => {
    if (!isCard(card)) return false;
    if (card.type === 'options' && !(Array.isArray(card.choices) && card.choices.length > 0)) return false;
    if (card.type !== 'options' && card.type !== 'conflict') return false;
    return settleWith(ctx, i, j, card).state === 'open';
  });
}

// ── Server stamps (the two facts the live doc forgets) ───────────────────────────────────────

/** How a gate closed. 'replaced': a newer gate took its place; 'superseded': a newer action made it moot. */
export type GateClosedStatus = 'approved' | 'declined' | 'nothing_to_draw' | 'replaced' | 'expired' | 'superseded';
export const GATE_CLOSED_STATUSES: readonly GateClosedStatus[] = ['approved', 'declined', 'nothing_to_draw', 'replaced', 'expired', 'superseded'];

/** The outcome stamped on a gate card when it closes (≤ about 120 bytes). The price is only kept for an approval. */
export interface GateClosed {
  status: GateClosedStatus;
  /** Who closed it: only the creator's own Approve and "Not now" are 'user'; a system close never reads "Not now". */
  by: 'user' | 'system';
  /** The approved quote (charged USD) and what it drew. */
  usd?: number;
  imageCount?: number;
  model?: string;
  at: number;
}

/** A gate card as the server stamps it (doc.ts stays untouched: the stamp is read through isGateClosed). */
export type GateCardStamped = GateCard & { closed?: GateClosed };

/** The page plan's size when a plan or breakdown card was posted. */
export interface PlanCounts {
  pages: number;
  panels: number;
}

/** A plan or breakdown card as posted with its counts. */
export type BookCardCounted = BookCard & { counts?: PlanCounts };

/** Longest model name kept on a stamp (the stamp stays ≈ 120 bytes). */
export const GATE_STAMP_MODEL_CHARS = 24;

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100_000;

export const isGateClosed = (v: unknown): v is GateClosed =>
  isObject(v) &&
  (GATE_CLOSED_STATUSES as readonly unknown[]).includes(v.status) &&
  (v.by === 'user' || v.by === 'system') &&
  typeof v.at === 'number' && Number.isFinite(v.at) &&
  (v.usd === undefined || (typeof v.usd === 'number' && Number.isFinite(v.usd) && v.usd >= 0)) &&
  (v.imageCount === undefined || isCount(v.imageCount)) &&
  (v.model === undefined || typeof v.model === 'string');

export const isPlanCounts = (v: unknown): v is PlanCounts => isObject(v) && isCount(v.pages) && isCount(v.panels);

/** The stamped outcome of a gate card, when it is well-formed. */
export const gateClosedOf = (card: Card | null | undefined): GateClosed | undefined => {
  const closed = isCard(card) && card.type === 'gate' ? (card as GateCardStamped).closed : undefined;
  return isGateClosed(closed) ? closed : undefined;
};

/** The stamped counts of a plan or breakdown card, when they are well-formed. */
export const planCountsOf = (card: Card | null | undefined): PlanCounts | undefined => {
  const counts = isCard(card) && (card.type === 'plan' || card.type === 'breakdown') ? (card as BookCardCounted).counts : undefined;
  return isPlanCounts(counts) ? counts : undefined;
};

/** The stamp for a gate closing now. */
export function gateClosedFor(gate: Pick<Gate, 'estimateUsd' | 'imageCount' | 'model'>, status: GateClosedStatus, by: 'user' | 'system', at: number): GateClosed {
  if (status !== 'approved') return { status, by, at };
  const usd = Number.isFinite(gate.estimateUsd) && gate.estimateUsd > 0 ? Math.round(gate.estimateUsd * 10_000) / 10_000 : 0;
  const model = str(gate.model).trim().slice(0, GATE_STAMP_MODEL_CHARS);
  return { status, by, usd, ...(isCount(gate.imageCount) ? { imageCount: gate.imageCount } : {}), ...(model ? { model } : {}), at };
}

/**
 * `message_patch` ops that write `closed` on every card of gate `gateId` — or, with null, clear it (the approval was put
 * back: it never ran). [] when no message shows that gate, or nothing would change.
 */
export function gateStampOps(doc: ComicDoc, gateId: string, closed: GateClosed | null): DocOp[] {
  const ops: DocOp[] = [];
  for (const m of conversationOf(doc)) {
    const cards = cardsOf(m);
    if (!cards.some((c) => isCard(c) && c.type === 'gate' && c.gateId === gateId)) continue;
    let changed = false;
    const next = cards.map((c) => {
      if (!isCard(c) || c.type !== 'gate' || c.gateId !== gateId) return c;
      const stamped = c as GateCardStamped;
      if (closed === null) {
        if (stamped.closed === undefined) return c;
        changed = true;
        const { closed: _drop, ...rest } = stamped;
        return rest as Card;
      }
      if (JSON.stringify(stamped.closed) === JSON.stringify(closed)) return c;
      changed = true;
      return { ...stamped, closed } as Card;
    });
    if (changed) ops.push({ op: 'message_patch', id: m.id, patch: { cards: next } });
  }
  return ops;
}

/** The plan's size for a book card (its pages, or the whole book). */
export function planCountsFor(doc: ComicDoc, pageIds?: readonly string[]): PlanCounts {
  const all = Array.isArray(doc?.pages) ? doc.pages : [];
  const ids = pageIds?.length ? new Set(pageIds) : null;
  const pages = ids ? all.filter((p) => ids.has(p.id)) : all;
  return { pages: pages.length, panels: pages.reduce((n, p) => n + (Array.isArray(p.panels) ? p.panels.length : 0), 0) };
}

/** A plan or breakdown card with its counts stamped at creation (§5.6). */
export function withPlanCounts<C extends BookCard>(card: C, doc: ComicDoc): C & { counts: PlanCounts } {
  const pageIds = card.type === 'breakdown' ? card.pageIds : undefined;
  return { ...card, counts: planCountsFor(doc, pageIds) };
}

// ── Summary (words only) ─────────────────────────────────────────────────────

/**
 * How a summary words a price for this viewer: the client's conversation/cost.ts useCostFormat() and the server's
 * costText.ts costFormatter() both fit. Governed users read a share of their usage, never `$` or `¢`. Without one, a
 * summary names no amount at all.
 */
export interface SettleCost {
  readonly governed: boolean;
  approx(usd: number): string;
}

/** The one plain link a settled renders or media card keeps: where the pictures live (changes nothing). */
export interface SettledLink {
  label: string;
  client: ClientAction;
}

export interface SettledSummary {
  /** The line, words only. Empty for a folded card. */
  text: string;
  /** 'done': ✓ (picked, approved, published); 'quiet': muted (skipped, closed, replaced); 'plain': the card's own icon. */
  tone: 'done' | 'quiet' | 'plain';
  link?: SettledLink;
  /** A gate's own breakdown: folded into the gate's line, nothing renders. */
  folded?: true;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/** At most `max` characters, cut at a word when one ends near the limit ("…asleep…", not "…asleep b…"). */
const clip = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/u, '')}…`;
};
const listWords = (items: string[]): string =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
const names = (items: string[], max: number): string =>
  items.length > max ? `${items.slice(0, max).join(', ')} +${items.length - max}` : items.join(', ');

const choiceLabel = (card: OptionsCard, id: string): string => {
  const c = (card.choices || []).find((x) => isObject(x) && x.id === id);
  return clip(str(c?.label) || id, 40);
};

const pageNumber = (doc: ComicDoc, pageId: unknown): number | null => {
  const p = Array.isArray(doc.pages) ? doc.pages.find((x) => x.id === pageId) : undefined;
  return p && typeof p.n === 'number' ? p.n : null;
};

const targetWords = (doc: ComicDoc, target: unknown): string => {
  if (!isObject(target)) return 'this picture';
  switch (target.kind) {
    case 'page': {
      const n = pageNumber(doc, target.id);
      return n === null ? 'a page' : `page ${n}`;
    }
    case 'cover':
      return 'the cover';
    case 'sheet': {
      const c = (doc.cast || []).find((x) => x.id === target.id);
      return c ? `${c.name}’s sheet` : 'a character sheet';
    }
    case 'place': {
      const p = (doc.places || []).find((x) => x.id === target.id);
      return p ? p.name : 'a place';
    }
    case 'style_option':
      return 'a style option';
    default:
      return 'this picture';
  }
};

/** Where a target's pictures live: the page itself, or the board tab that shows them. */
const targetLink = (doc: ComicDoc, target: unknown): SettledLink => {
  if (isObject(target) && target.kind === 'page' && typeof target.id === 'string' && pageNumber(doc, target.id) !== null) {
    return { label: `Open page ${pageNumber(doc, target.id)}`, client: { type: 'open_page', pageId: target.id } };
  }
  if (isObject(target) && target.kind === 'sheet') return { label: 'Open the cast', client: { type: 'open_tab', tab: 'cast' } };
  if (isObject(target) && target.kind === 'style_option') return { label: 'Open the style', client: { type: 'open_tab', tab: 'style' } };
  return { label: 'Open Media', client: { type: 'open_tab', tab: 'media' } };
};

const BOARD_LINK: SettledLink = { label: 'Open the pages', client: { type: 'open_tab', tab: 'pages' } };

/** A gate's outcome: its stamp, or what the current doc.gate still says, or 'legacy' (replaced before stamps). */
const gateOutcome = (card: GateCard, doc: ComicDoc): GateClosed | { status: 'declined'; by?: undefined } | 'legacy' => {
  const stamp = gateClosedOf(card);
  if (stamp) return stamp;
  const g = doc.gate;
  if (g && g.id === card.gateId && g.status !== 'open') {
    if (g.status === 'approved') return gateClosedFor(g, 'approved', 'user', g.createdAt || 0);
    if (g.closedReason === 'nothing_to_draw') return { status: 'nothing_to_draw', by: 'system', at: g.createdAt || 0 };
    // An unstamped decline: who said no is not known, so it never reads as the user's "Not now".
    return { status: 'declined' };
  }
  return 'legacy';
};

function gateSummary(card: GateCard, doc: ComicDoc, cost?: SettleCost | null): SettledSummary {
  const out = gateOutcome(card, doc);
  if (out === 'legacy') return { text: 'An earlier approval', tone: 'quiet' };
  switch (out.status) {
    case 'approved': {
      const parts = ['Approved'];
      if (cost && typeof out.usd === 'number') parts.push(cost.approx(out.usd));
      if (typeof out.imageCount === 'number' && out.imageCount > 0) parts.push(plural(out.imageCount, 'image'));
      return { text: parts.join(' · '), tone: 'done' };
    }
    case 'declined':
      return { text: out.by === 'user' ? 'Not now — nothing spent' : 'Closed — nothing spent', tone: 'quiet' };
    case 'nothing_to_draw':
      return { text: 'Nothing left to draw — nothing spent', tone: 'quiet' };
    case 'replaced':
      return { text: 'Closed — a newer approval replaced it', tone: 'quiet' };
    case 'superseded':
      return { text: 'Closed — a newer request covered it', tone: 'quiet' };
    case 'expired':
      return { text: 'Closed after a day — nothing spent', tone: 'quiet' };
    default:
      return { text: 'An earlier approval', tone: 'quiet' };
  }
}

function rendersSummary(card: Extract<Card, { type: 'renders' }>, doc: ComicDoc): SettledSummary {
  const targets = (Array.isArray(card.targets) ? card.targets : []).filter(isObject) as RenderTarget[];
  let pages = 0;
  let cover = false;
  let sheets = 0;
  let places = 0;
  let styles = 0;
  let missed = 0;
  for (const t of targets) {
    let status: string | undefined;
    try {
      status = getRender(doc, t)?.status;
    } catch {
      status = undefined;
    }
    if (status !== 'ready' && status !== 'stale') {
      missed += 1;
      continue;
    }
    if (t.kind === 'page') pages += 1;
    else if (t.kind === 'cover') cover = true;
    else if (t.kind === 'sheet') sheets += 1;
    else if (t.kind === 'place') places += 1;
    else if (t.kind === 'style_option') styles += 1;
  }
  const drew = [
    pages ? plural(pages, 'page') : '',
    cover ? 'the cover' : '',
    sheets ? plural(sheets, 'character sheet') : '',
    places ? plural(places, 'place') : '',
    styles ? plural(styles, 'style option') : ''
  ].filter(Boolean);
  const head = drew.length ? `Drew ${listWords(drew)}` : 'Nothing was drawn';
  const text = missed && drew.length ? `${head} · ${missed} didn’t finish` : head;
  const kinds = new Set(targets.map((t) => t.kind));
  const link =
    targets.length === 1 ? targetLink(doc, targets[0])
    : kinds.size === 1 && kinds.has('sheet') ? targetLink(doc, targets[0])
    : kinds.size === 1 && kinds.has('style_option') ? targetLink(doc, targets[0])
    : BOARD_LINK;
  return { text, tone: 'plain', link };
}

/**
 * The settled card's one line (§5.2, D3): words only, prices through the viewer's `cost` (none without it), and for
 * renders and media cards one plain link to where the pictures live. null while the card is open or live.
 */
export function summaryOf(card: Card, doc: ComicDoc, settle: CardSettle, cost?: SettleCost | null): SettledSummary | null {
  if (!settle || settle.state !== 'settled') return null;
  if (!isCard(card) || !doc) return { text: 'Earlier card', tone: 'quiet' };
  switch (card.type) {
    case 'options': {
      if (settle.outcome === 'skipped') return { text: 'Not answered — you moved on', tone: 'quiet' };
      const picked = settle.picked ?? answeredOf(card);
      if (settle.outcome === 'answered') return { text: `You answered “${clip(picked.join(' '), 60)}”`, tone: 'done' };
      return { text: `You picked ${listWords(picked.map((id) => choiceLabel(card, id)))}`, tone: 'done' };
    }
    case 'conflict': {
      const items = (Array.isArray(card.items) ? card.items : []).filter(isObject);
      const mine = items.filter((i) => i.resolved === 'mine').length;
      const theirs = items.filter((i) => i.resolved === 'theirs').length;
      const left = items.length - mine - theirs;
      if (!mine && !theirs) return { text: 'Left as yours', tone: 'quiet' };
      const parts = [mine ? `kept yours (${mine})` : '', theirs ? `used the director’s (${theirs})` : '', left ? `left as yours (${left})` : ''].filter(Boolean);
      const text = parts.join(' · ');
      return { text: text.charAt(0).toUpperCase() + text.slice(1), tone: 'done' };
    }
    case 'gate':
      return gateSummary(card, doc, cost);
    case 'breakdown':
      if (card.gateId) return { text: '', tone: 'plain', folded: true };
    // falls through: a book view
    case 'plan': {
      if (settle.outcome === 'newer') return { text: 'Closed — a newer plan replaced it', tone: 'quiet' };
      const counts = planCountsOf(card);
      return counts
        ? { text: `Page plan · ${plural(counts.pages, 'page')} · ${plural(counts.panels, 'panel')}`, tone: 'plain' }
        : { text: 'An earlier page plan', tone: 'plain' };
    }
    case 'style_choice': {
      const style = doc.style;
      const link: SettledLink = { label: 'Open the style', client: { type: 'open_tab', tab: 'style' } };
      if (style?.status === 'locked' && style.name) return { text: `Style locked: ${clip(style.name, 40)}`, tone: 'done', link };
      const n = Array.isArray(style?.options) ? style.options.length : 0;
      return { text: n ? plural(n, 'style option') : 'Style options', tone: 'plain', link };
    }
    case 'style_presets': {
      const presetName = (id: unknown) => (typeof id === 'string' ? getStylePreset(id)?.name : undefined);
      if (settle.outcome === 'picked') return { text: `You picked the ${presetName(card.picked) ?? 'suggested'} style`, tone: 'done' };
      const list = (Array.isArray(card.presetIds) ? card.presetIds : []).map(presetName).filter((n): n is string => !!n);
      return { text: list.length ? `Styles suggested: ${names(list, 3)}` : 'Styles suggested', tone: 'plain' };
    }
    case 'cast': {
      const ids = Array.isArray(card.characterIds) ? card.characterIds : [];
      const list = ids.map((id) => (doc.cast || []).find((c) => c.id === id)?.name).filter((n): n is string => !!n);
      return { text: list.length ? `Cast: ${names(list, 2)}` : 'Cast', tone: 'plain', link: { label: 'Open the cast', client: { type: 'open_tab', tab: 'cast' } } };
    }
    case 'recap': {
      const pages = Array.isArray(doc.pages) ? doc.pages.length : 0;
      const style = doc.style?.name || getStylePreset(doc.style?.presetId)?.name;
      const cast = Array.isArray(doc.cast) ? doc.cast.length : 0;
      const parts = ['Setup confirmed', pages ? plural(pages, 'page') : '', style ? clip(style, 40) : '', cast ? plural(cast, 'character') : ''].filter(Boolean);
      return { text: parts.join(' · '), tone: 'plain' };
    }
    case 'renders':
      return rendersSummary(card, doc);
    case 'versions': {
      let count = 0;
      try {
        const r = getRender(doc, card.target);
        count = (Array.isArray(r?.history) ? r!.history.length : 0) + (r?.asset ? 1 : 0);
      } catch {
        count = 0;
      }
      const of = targetWords(doc, card.target);
      return { text: count ? `${plural(count, 'version')} of ${of}` : `Versions of ${of}`, tone: 'plain', link: targetLink(doc, card.target) };
    }
    case 'refs': {
      const n = Array.isArray(card.paths) ? card.paths.length : 0;
      const owner = card.owner;
      const who =
        owner?.kind === 'character' ? (doc.cast || []).find((c) => c.id === owner.id)?.name
        : owner?.kind === 'place' ? (doc.places || []).find((p) => p.id === owner.id)?.name
        : owner?.kind === 'style' ? 'the style'
        : undefined;
      return { text: `Added ${plural(n, 'photo')}${who ? ` to ${clip(who, 40)}` : ''}`, tone: 'plain', link: { label: 'Open Media', client: { type: 'open_tab', tab: 'media' } } };
    }
    case 'translation': {
      const langs = (Array.isArray(card.languages) ? card.languages : []).filter((l) => typeof l === 'string' && languageSpec(l));
      const list = langs.map((l) => languageSpec(l)!.english);
      let ready = false;
      try {
        ready = langs.length > 0 && langs.every((l) => {
          const p = editionProgress(doc, l);
          return p.done >= p.total;
        });
      } catch {
        ready = false;
      }
      const head = list.length ? `${names(list, 2)} ${list.length === 1 ? 'edition' : 'editions'}` : 'Translation';
      return { text: `${head} · ${ready ? 'ready' : 'not finished'}`, tone: ready ? 'done' : 'plain' };
    }
    case 'publish': {
      if (card.status === 'done') {
        const word = card.mode === 'unpublish' ? 'Unpublished' : card.mode === 'regenerate' ? 'New link made' : card.mode === 'update' ? 'Updated' : 'Published';
        return { text: word, tone: 'done' };
      }
      if (card.status === 'failed') return { text: 'Didn’t publish', tone: 'quiet' };
      return { text: 'Not published', tone: 'quiet' };
    }
    case 'share':
      return { text: 'Share link', tone: 'plain' };
    case 'model_outage': {
      const name = getImageModel(card.modelId)?.nickname ?? 'The image model';
      const blocked = card.blockedAction as { type?: unknown; pageIds?: unknown } | undefined;
      const pages = blocked?.type === 'render_pages' && Array.isArray(blocked.pageIds) ? blocked.pageIds.length : 0;
      return { text: `${name} was paused${pages ? ` · ${plural(pages, 'page')} waited` : ''}`, tone: 'quiet' };
    }
    case 'history': {
      const n = pageNumber(doc, card.pageId);
      const what =
        n !== null ? `page ${n}`
        : card.view === 'compare' ? 'a comparison'
        : card.view === 'confirm' ? 'a restore offer'
        : card.view === 'undo_ai' ? 'undo the last AI change'
        : card.view === 'moment' ? 'an earlier version'
        : '';
      return { text: what ? `History · ${what}` : 'History', tone: 'plain' };
    }
    case 'notice': {
      const fixes = Array.isArray(card.fixes) ? card.fixes.length : 0;
      const text = clip(str(card.text), 200) || 'A note';
      return { text: fixes ? `${text} · ${plural(fixes, 'fix', 'fixes')} offered` : text, tone: card.tone === 'success' ? 'done' : 'plain' };
    }
    default:
      return { text: 'Earlier card', tone: 'quiet' };
  }
}

/**
 * The outcome in the model's words, for director.ts cardText (settle.md §5.7, V.8): "skipped", "answered: Noir ink",
 * "approved", "not now", "closed by the studio", "replaced by a newer plan", or '' while the card is open or live.
 * Never an amount: a governed user's director never sees a dollar figure to repeat (director.ts:162).
 */
export function outcomeForModel(card: Card, doc: ComicDoc, settle: CardSettle): string {
  if (!settle || settle.state !== 'settled' || !isCard(card)) return '';
  switch (card.type) {
    case 'options':
      if (settle.outcome === 'skipped') return 'skipped';
      return `answered: ${(settle.picked ?? []).map((id) => (settle.outcome === 'answered' ? clip(id, 80) : choiceLabel(card, id))).join(', ')}`;
    case 'conflict':
      return settle.outcome === 'resolved' ? 'resolved' : 'left as the creator’s';
    case 'gate': {
      const out = gateOutcome(card, doc);
      if (out === 'legacy') return 'closed earlier';
      switch (out.status) {
        case 'approved':
          return 'approved';
        case 'declined':
          return out.by === 'user' ? 'not now' : 'closed by the studio, nothing spent';
        case 'nothing_to_draw':
          return 'closed: nothing left to draw';
        case 'replaced':
          return 'replaced by a newer approval';
        case 'superseded':
          return 'closed: a newer request covered it';
        case 'expired':
          return 'expired, nothing spent';
        default:
          return 'closed earlier';
      }
    }
    default:
      return settle.outcome === 'newer' ? 'replaced by a newer one' : '';
  }
}
