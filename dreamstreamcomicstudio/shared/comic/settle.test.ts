// Settled cards: the shared rule (PROGRAM3 SETTLE-0; settle.md §5; lead decision D3, CHANGED: one line, no controls,
// no details). Every case here reads "today nothing settles": without settle.ts an old card stays open or live forever.

import { describe, expect, it } from 'vitest';
import { createEmptyDoc, type Card, type ComicDoc, type Gate, type Msg } from './doc';
import { applyOps } from './ops';
import { editionProgress } from './i18n';
import { IMAGE_MODELS } from './models';
import { makeQaDoc } from '../../components/comicstudio/testing/qaFixtures';
import { makeSampleDoc } from '../../components/comicstudio/conversation/testing/fixtures';
import { costFormat } from '../../components/comicstudio/conversation/cost';
import {
  GATE_STAMP_MODEL_CHARS,
  SETTLED_CARDS,
  SETTLE_COURTESY_MATCH,
  buildSettleIndex,
  cardSettle,
  gateClosedFor,
  gateClosedOf,
  gateStampOps,
  isGateClosed,
  isOpenQuestion,
  isPassed,
  isPlanCounts,
  kindKeyOf,
  matchChoices,
  outcomeForModel,
  planCountsFor,
  planCountsOf,
  settleKey,
  settleOf,
  settledCardsOn,
  summaryOf,
  withPlanCounts,
  type CardSettle,
  type SettlePending,
  type SettleCost
} from './settle';

type OptionsCard = Extract<Card, { type: 'options' }>;

const DOLLARS: SettleCost = costFormat({ governed: false });
const GOVERNED: SettleCost = costFormat({ governed: true, pctPerUsd: 4 });

const find = (doc: ComicDoc, cardId: string): { i: number; card: Card } => {
  for (const [i, m] of doc.conversation.entries()) {
    const card = (m.cards || []).find((c) => c.id === cardId);
    if (card) return { i, card };
  }
  throw new Error(`no card ${cardId}`);
};
const settleById = (doc: ComicDoc, cardId: string, opts: Parameters<typeof cardSettle>[3] = {}): CardSettle => {
  const { i, card } = find(doc, cardId);
  return cardSettle(doc, i, card, opts);
};
const summaryById = (doc: ComicDoc, cardId: string, cost?: SettleCost, opts: Parameters<typeof cardSettle>[3] = {}) => {
  const { i, card } = find(doc, cardId);
  return summaryOf(card, doc, cardSettle(doc, i, card, opts), cost);
};
const user = (id: string, text: string, at = 10): Msg => ({ id, role: 'user', text, at });
const reply = (id: string, cards: Card[] = [], at = 11): Msg => ({ id, role: 'assistant', text: '', at, ...(cards.length ? { cards } : {}) });
const sendingMsg = (text: string, card?: SettlePending['card']): SettlePending => ({ text, status: 'sending', ...(card ? { card } : {}) });
const look: OptionsCard = {
  type: 'options',
  id: 'q_look',
  question: 'Which look?',
  allowCustom: true,
  choices: [
    { id: 'c1', label: 'Noir ink' },
    { id: 'c2', label: 'Crayon', reply: 'Crayon, the kid-drawn one' }
  ]
};
const withConv = (conversation: Msg[], over: Partial<ComicDoc> = {}): ComicDoc => ({ ...createEmptyDoc('p', 'T', 1), conversation, ...over });

describe('flags', () => {
  it('is on for everyone (R00 SF-1); the admins stage and the off kill switch still work; the courtesy match waits (D7)', () => {
    expect(SETTLED_CARDS).toBe('all');
    expect(settledCardsOn(true)).toBe(true);
    expect(settledCardsOn(false)).toBe(true);
    expect(settledCardsOn(undefined)).toBe(true);
    expect(settledCardsOn(false, 'admins')).toBe(false);
    expect(settledCardsOn(true, 'admins')).toBe(true);
    expect(settledCardsOn(true, 'off')).toBe(false);
    expect(settledCardsOn(false, 'off')).toBe(false);
    expect(SETTLE_COURTESY_MATCH).toBe(false);
  });
});

describe('the heist-12p conversation (the QA studio scene)', () => {
  const doc = makeQaDoc('heist-12p');

  it('o1 settles as skipped: "Noir ink, please" matches no choice, and the chat moved on', () => {
    expect(settleById(doc, 'o1')).toEqual({ state: 'settled', outcome: 'skipped' });
    expect(summaryById(doc, 'o1')).toEqual({ text: 'Not answered — you moved on', tone: 'quiet' });
    // The same answer with the courtesy match (D7, off by default) would have picked Noir ink.
    const o1 = find(doc, 'o1').card as OptionsCard;
    expect(matchChoices(o1, 'Noir ink, please')).toEqual([]);
    expect(matchChoices(o1, 'Noir ink, please', { courtesy: true })).toEqual(['c1']);
  });

  it('the open "Render all" gate stays open even once the chat moves past it', () => {
    expect(doc.gate).toMatchObject({ id: 'gate_qa', status: 'open' });
    expect(settleById(doc, 'cg1')).toEqual({ state: 'open' });
    const passed = { ...doc, conversation: [...doc.conversation, user('u_late', 'make it rain'), reply('a_late')] };
    expect(isPassed(passed, find(passed, 'cg1').i)).toBe(true);
    expect(settleById(passed, 'cg1')).toEqual({ state: 'open' });
    expect(settleById(doc, 'cg1', { pending: sendingMsg('later') })).toEqual({ state: 'open' });
  });

  it('a running render stays live however old; settles to its tally once every target is done', () => {
    const passed = { ...doc, conversation: [...doc.conversation, user('u_late', 'next')] };
    expect(doc.pages.some((p) => p.render.status === 'queued' || p.render.status === 'rendering')).toBe(true);
    expect(settleById(passed, 'cr1')).toEqual({ state: 'live' });
    const finish = <R extends { status: string }>(r: R): R => (r.status === 'queued' || r.status === 'rendering' ? { ...r, status: 'ready' } : r);
    const done: ComicDoc = {
      ...passed,
      pages: passed.pages.map((p) => ({ ...p, render: finish(p.render) })),
      cast: passed.cast.map((c) => ({ ...c, sheet: finish(c.sheet) })),
      style: { ...passed.style, options: passed.style.options.map((o) => ({ ...o, render: finish(o.render) })) }
    };
    expect(settleById(done, 'cr1')).toEqual({ state: 'settled', outcome: 'passed' });
    const line = summaryById(done, 'cr1')!;
    // 12 page targets: 'none' ×2 and 'failed' ×1 never finished; the cover, 4 sheets and the style option count as drawn when ready.
    expect(line.text).toMatch(/^Drew 9 pages(, | and )the cover/);
    expect(line.text).toMatch(/· \d+ didn’t finish$/);
    expect(line.link).toEqual({ label: 'Open the pages', client: { type: 'open_tab', tab: 'pages' } });
    expect(line.text).not.toMatch(/[$¢]/);
  });

  it('latest-of-kind across plan and breakdown cards: the plan card is replaced by the later breakdown', () => {
    expect(kindKeyOf(find(doc, 'cp1').card)).toBe('book');
    expect(kindKeyOf(find(doc, 'bd1').card)).toBe('book');
    expect(settleById(doc, 'cp1')).toEqual({ state: 'settled', outcome: 'newer' });
    expect(summaryById(doc, 'cp1')).toEqual({ text: 'Closed — a newer plan replaced it', tone: 'quiet' });
    // The latest book card on the last reply is live.
    expect(settleById(doc, 'bd1')).toEqual({ state: 'live' });
    // A gate's own breakdown is not a book view: it never replaces the plan card, and folds into the gate line.
    const gateBreakdown: Card = { type: 'breakdown', id: 'bd_gate', pageIds: [], view: 'cost', gateId: 'gate_qa' };
    expect(kindKeyOf(gateBreakdown)).toBeNull();
    const only = withConv([reply('a0', [{ type: 'plan', id: 'p1' }]), reply('a1', [gateBreakdown])]);
    expect(settleById(only, 'p1')).toEqual({ state: 'live' });
  });

  it('latest-of-kind within one message: the first of two book cards is replaced by the second', () => {
    const doc = withConv([reply('a1', [{ type: 'plan', id: 'p1' }, { type: 'breakdown', id: 'b1', view: 'plan' }])]);
    expect(settleById(doc, 'p1')).toEqual({ state: 'settled', outcome: 'newer' });
    expect(settleById(doc, 'b1')).toEqual({ state: 'live' });
    const index = buildSettleIndex(doc);
    expect(index.get(settleKey('a1', 'p1'))).toEqual({ state: 'settled', outcome: 'newer' });
    expect(index.get(settleKey('a1', 'b1'))).toEqual({ state: 'live' });
  });

  it('the settle index agrees with cardSettle for every card, and is keyed by message and card', () => {
    const index = buildSettleIndex(doc);
    let n = 0;
    doc.conversation.forEach((m, i) =>
      (m.cards || []).forEach((card) => {
        n += 1;
        expect(settleOf(index, m, card)).toEqual(cardSettle(doc, i, card));
      })
    );
    expect(index.size).toBe(n);
    expect(index.get(settleKey('a1', 'o1'))).toEqual({ state: 'settled', outcome: 'skipped' });
  });
});

describe('option cards', () => {
  it('the production-shaped fixture: 10 unanswered option cards the user moved past all settle as skipped', () => {
    // Production (settle.md §1): 10 options cards, all allowCustom, ~2.5 choices, each followed by a user message
    // 1–5 messages later; 3 of those next messages equal a choice — but nothing recorded it, so they stay skipped.
    const conv: Msg[] = [];
    for (let k = 0; k < 10; k += 1) {
      const choices = [{ id: `k${k}a`, label: `Look ${k}` }, { id: `k${k}b`, label: `Plan ${k}` }, ...(k % 2 ? [{ id: `k${k}c`, label: `Idea ${k}` }] : [])];
      conv.push(reply(`a${k}`, [{ type: 'options', id: `o${k}`, question: `Question ${k}?`, allowCustom: true, choices }], k * 10));
      for (let gap = 0; gap < (k % 5); gap += 1) conv.push(reply(`f${k}_${gap}`, [], k * 10 + gap + 1));
      conv.push(user(`u${k}`, k < 3 ? `look ${k}` : `something else ${k}`, k * 10 + 6));
    }
    const doc = withConv(conv);
    const index = buildSettleIndex(doc);
    for (let k = 0; k < 10; k += 1) {
      expect(index.get(settleKey(`a${k}`, `o${k}`))).toEqual({ state: 'settled', outcome: 'skipped' });
      expect(summaryById(doc, `o${k}`)?.text).toBe('Not answered — you moved on');
    }
  });

  it('a tapped card is picked (the server wrote `answered`), with the choice in the line', () => {
    const doc = withConv([reply('a1', [{ ...look, answered: ['c1'] }])]);
    expect(settleById(doc, 'q_look')).toEqual({ state: 'settled', outcome: 'picked', picked: ['c1'] });
    expect(summaryById(doc, 'q_look')).toEqual({ text: 'You picked Noir ink', tone: 'done' });
    const multi = withConv([reply('a1', [{ ...look, multi: true, answered: ['c1', 'c2'] }]), user('u1', 'Noir ink and Crayon')]);
    expect(summaryById(multi, 'q_look')?.text).toBe('You picked Noir ink and Crayon');
    const custom = withConv([reply('a1', [{ ...look, answered: ['a quiet rooftop at dawn, with the whole city still asleep below the fog'] }])]);
    expect(settleById(custom, 'q_look').outcome).toBe('answered');
    expect(summaryById(custom, 'q_look')?.text).toBe('You answered “a quiet rooftop at dawn, with the whole city still asleep…”');
  });

  it('a pending message equal to a choice picks it before the server has it; any other sending message skips', () => {
    const doc = withConv([user('u0', 'hi'), reply('a1', [look])]);
    expect(settleById(doc, 'q_look')).toEqual({ state: 'open' });
    expect(settleById(doc, 'q_look', { pending: sendingMsg('  NOIR   ink ') })).toEqual({ state: 'settled', outcome: 'picked', pending: true, picked: ['c1'] });
    expect(summaryById(doc, 'q_look', undefined, { pending: sendingMsg('Noir ink') })?.text).toBe('You picked Noir ink');
    // The choice's reply text counts too (what the tap sends).
    expect(settleById(doc, 'q_look', { pending: sendingMsg('Crayon, the kid-drawn one') }).picked).toEqual(['c2']);
    // The tap names the card: picked by reference; a typed answer in its own field reads "You answered".
    expect(settleById(doc, 'q_look', { pending: sendingMsg('whatever', { id: 'q_look', choiceIds: ['c2'] }) })).toMatchObject({ outcome: 'picked', picked: ['c2'], pending: true });
    expect(settleById(doc, 'q_look', { pending: sendingMsg('a rooftop', { id: 'q_look', custom: 'a rooftop' }) })).toMatchObject({ outcome: 'answered', picked: ['a rooftop'] });
    // Free text: the user moved on.
    expect(settleById(doc, 'q_look', { pending: sendingMsg('make it longer') })).toEqual({ state: 'settled', outcome: 'skipped', pending: true });
    // A message that failed before the server took it passes nothing.
    expect(settleById(doc, 'q_look', { pending: { text: 'Noir ink', status: 'failed' } })).toEqual({ state: 'open' });
  });

  it('a sending answer never picks a card the chat already moved past (the server keeps it)', () => {
    const doc = withConv([reply('a1', [look]), user('u1', 'longer please'), reply('a2', [])]);
    expect(settleById(doc, 'q_look', { pending: sendingMsg('Noir ink', { id: 'q_look', choiceIds: ['c1'] }) })).toEqual({ state: 'settled', outcome: 'skipped' });
    // An old tab's tap on the passed card never lands on the newer card by its text either (the server keeps it).
    const newer = withConv([reply('a1', [look]), user('u1', 'longer please'), reply('a2', [{ ...look, id: 'q_new' }])]);
    expect(settleById(newer, 'q_new', { pending: sendingMsg('Noir ink', { id: 'q_look', choiceIds: ['c1'] }) })).toEqual({ state: 'settled', outcome: 'skipped', pending: true });
    // A card that is gone: the text is matched as the server would.
    expect(settleById(newer, 'q_new', { pending: sendingMsg('Noir ink', { id: 'q_gone', choiceIds: ['c1'] }) })).toMatchObject({ outcome: 'picked', picked: ['c1'] });
  });

  it('matchChoices is director.ts pickedChoices: exact after case and whitespace; multi takes "A, B and C"', () => {
    expect(matchChoices(look, 'noir INK')).toEqual(['c1']);
    expect(matchChoices(look, 'Noir')).toEqual([]);
    expect(matchChoices(look, 'Noir ink and Crayon')).toEqual([]);
    expect(matchChoices({ ...look, multi: true }, 'Noir ink and Crayon')).toEqual(['c1', 'c2']);
    expect(matchChoices({ ...look, multi: true }, 'Noir ink, Crayon, Pastel')).toEqual([]);
    expect(matchChoices(look, '')).toEqual([]);
    // Courtesy (D7, behind the flag): a suffix only, never a fuzzy guess.
    expect(matchChoices(look, 'Noir ink!', { courtesy: true })).toEqual(['c1']);
    expect(matchChoices(look, 'noir ink thanks.', { courtesy: true })).toEqual(['c1']);
    expect(matchChoices(look, 'please', { courtesy: true })).toEqual([]);
    expect(matchChoices(look, 'Noir inks please', { courtesy: true })).toEqual([]);
    // Malformed stored choices never throw.
    expect(matchChoices({ ...look, choices: [null, { id: 'x' }] as unknown as OptionsCard['choices'] }, 'x')).toEqual([]);
  });
});

describe('renders cards', () => {
  const base = makeQaDoc('heist-12p');
  const [p1, p2] = base.pages;
  const page = (id: string) => ({ kind: 'page' as const, id });
  const withStatus = (doc: ComicDoc, statuses: Record<string, ComicDoc['pages'][number]['render']['status']>): ComicDoc => ({
    ...doc,
    pages: doc.pages.map((p) => (statuses[p.id] ? { ...p, render: { ...p.render, status: statuses[p.id] } } : p))
  });
  const renders = (id: string, ids: string[]): Card => ({ type: 'renders', id, targets: ids.map(page), label: 'Drawing' });

  it('"Redraw page 1" keeps only the new card live: the old card stays settled and reads "being redrawn"', () => {
    // The probe: [a1 renders(pg 1, pg 2), u1 "redraw page 1", a2 renders(pg 1)] while page 1 draws again.
    const conv = [reply('a1', [renders('r_old', [p1.id, p2.id])]), user('u1', 'redraw page 1'), reply('a2', [renders('r_new', [p1.id])])];
    const doc = withStatus({ ...base, conversation: conv }, { [p1.id]: 'rendering', [p2.id]: 'ready' });
    expect(settleById(doc, 'r_old')).toEqual({ state: 'settled', outcome: 'newer' });
    expect(settleById(doc, 'r_new')).toEqual({ state: 'live' });
    const line = summaryById(doc, 'r_old')!;
    expect(line.text).toBe('Drew 1 page · 1 being redrawn');
    expect(line.text).toContain('1 being redrawn');
    expect(line.text).not.toMatch(/didn’t finish/);
    // Queued counts as busy too; the settle index agrees.
    const queued = withStatus(doc, { [p1.id]: 'queued' });
    expect(buildSettleIndex(queued).get(settleKey('a1', 'r_old'))).toEqual({ state: 'settled', outcome: 'newer' });
    expect(buildSettleIndex(queued).get(settleKey('a2', 'r_new'))).toEqual({ state: 'live' });
    // Everything it drew is being redrawn: no "Nothing was drawn", no "didn't finish".
    const both = withStatus({ ...base, conversation: [conv[0], conv[1], reply('a2', [renders('r_new', [p1.id, p2.id])])] }, { [p1.id]: 'rendering', [p2.id]: 'queued' });
    expect(summaryById(both, 'r_old')?.text).toBe('Being redrawn: 2 pages');
    // A failed page still reads "didn't finish", beside the one being redrawn.
    const failed = withStatus(doc, { [p2.id]: 'failed', [base.pages[2].id]: 'ready' });
    const three = { ...failed, conversation: [reply('a1', [renders('r_old', [p1.id, p2.id, base.pages[2].id])]), conv[1], conv[2]] };
    expect(summaryById(three, 'r_old')?.text).toBe('Drew 1 page · 1 didn’t finish · 1 being redrawn');
  });

  it('a card whose own run is still drawing stays live, even under a newer card for other pictures', () => {
    const conv = [reply('a1', [renders('r_run', [p1.id, p2.id])]), user('u1', 'and the cover'), reply('a2', [{ type: 'renders', id: 'r_cover', targets: [{ kind: 'cover' }], label: 'Cover' }])];
    const doc = withStatus({ ...base, conversation: conv }, { [p1.id]: 'ready', [p2.id]: 'rendering' });
    expect(settleById(doc, 'r_run')).toEqual({ state: 'live' });
    // Once it ends it settles on the newer card, with the single cover card linking to the pages (the cover lives there).
    const ended = withStatus(doc, { [p2.id]: 'ready' });
    expect(settleById(ended, 'r_run')).toEqual({ state: 'settled', outcome: 'newer' });
    const cover = { ...ended, conversation: [...conv, user('u2', 'thanks')], cover: { ...ended.cover, render: { ...ended.cover.render, status: 'ready' as const } } };
    expect(summaryById(cover, 'r_cover')).toEqual({ text: 'Drew the cover', tone: 'plain', link: { label: 'Open the pages', client: { type: 'open_tab', tab: 'pages' } } });
  });
});

/**
 * A1's legacy rule, copied inline (SETTLE-UI wave note 4): messageQueue.openQuestion now delegates to isOpenQuestion,
 * so comparing against it would compare the function with itself. The last assistant message has an options card with
 * choices and no answer, or a conflict card with an unresolved item.
 */
const openQuestion = (doc: ComicDoc | null | undefined): boolean => {
  const list = doc?.conversation;
  if (!Array.isArray(list)) return false;
  let last: Msg | undefined;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.role === 'assistant') {
      last = list[i];
      break;
    }
  }
  const cards = last?.cards;
  if (!Array.isArray(cards)) return false;
  return cards.some((card) => {
    if (!card || typeof card !== 'object') return false;
    if (card.type === 'options') return Array.isArray(card.choices) && card.choices.length > 0 && !(card.answered || []).some(Boolean);
    if (card.type === 'conflict') return Array.isArray(card.items) && card.items.some((item) => item && !item.resolved);
    return false;
  });
};

describe('parity with A1’s openQuestion (messageQueue.ts), on A1’s cases', () => {
  const q: Msg = { id: 'm_a', role: 'assistant', text: 'Here you go', at: 2, cards: [{ type: 'options', id: 'card_q', question: 'Which cover?', choices: [{ id: 'c1', label: 'Moody' }] }] };
  const item = { id: 'i1', where: { pageId: 'pg_1', label: 'page 1' }, mine: 'a', theirs: 'b', proposed: [] };
  const cases: [string, ComicDoc | null][] = [
    ['an unanswered options card on the last reply', makeSampleDoc({ conversation: [q] })],
    ['answered', makeSampleDoc({ conversation: [{ ...q, cards: [{ ...(q.cards![0] as OptionsCard), answered: ['c1'] }] }] })],
    ['an older unanswered card', makeSampleDoc({ conversation: [q, user('u2', 'something else', 3), reply('m_b')] })],
    ['an unresolved conflict', makeSampleDoc({ conversation: [{ ...q, cards: [{ type: 'conflict', id: 'cf', items: [item] }] as Card[] }] })],
    ['a resolved conflict', makeSampleDoc({ conversation: [{ ...q, cards: [{ type: 'conflict', id: 'cf', items: [{ ...item, resolved: 'mine' }] }] as Card[] }] })],
    ['no choices', makeSampleDoc({ conversation: [{ ...q, cards: [{ type: 'options', id: 'e', question: '?', choices: [] }] }] })],
    ['an empty conversation', makeSampleDoc({ conversation: [] })],
    ['no doc', null]
  ];
  it.each(cases)('%s', (_name, doc) => {
    expect(isOpenQuestion(doc)).toBe(openQuestion(doc));
  });

  it('beyond A1: a card the creator just answered by sending is not open (the queue stops holding on it)', () => {
    const doc = makeSampleDoc({ conversation: [q] });
    expect(openQuestion(doc)).toBe(true);
    expect(isOpenQuestion(doc, sendingMsg('Moody'))).toBe(false);
    expect(isOpenQuestion(doc, sendingMsg('something else'))).toBe(false);
    expect(isOpenQuestion(doc, { text: 'x', status: 'failed' })).toBe(true);
  });
});

describe('gate cards', () => {
  const gate: Gate = {
    id: 'g1', action: { type: 'render_cover' }, title: 'Draw the cover', summary: '', estimateUsd: 0.4235, imageCount: 6,
    model: 'Model A', createdAt: 1, status: 'open', reason: 'policy'
  };
  const card: Card = { type: 'gate', id: 'cg', gateId: 'g1' };

  it('a gate replaced without a stamp reads the legacy "An earlier approval"', () => {
    const doc = withConv([reply('a1', [card])], { gate: { ...gate, id: 'g2' } });
    expect(settleById(doc, 'cg')).toEqual({ state: 'settled', outcome: 'closed' });
    expect(summaryById(doc, 'cg', DOLLARS)).toEqual({ text: 'An earlier approval', tone: 'quiet' });
  });

  it('a stamped gate reads its outcome; the price goes through the viewer’s formatter (a governed summary has no $)', () => {
    const at = 5;
    const stamped = (status: Parameters<typeof gateClosedFor>[1], by: 'user' | 'system') =>
      withConv([reply('a1', [{ ...card, closed: gateClosedFor(gate, status, by, at) } as Card])], { gate: { ...gate, id: 'g9' } });
    expect(summaryById(stamped('approved', 'user'), 'cg', DOLLARS)).toEqual({ text: 'Approved · ≈ $0.42 · 6 images', tone: 'done' });
    const governed = summaryById(stamped('approved', 'user'), 'cg', GOVERNED)!.text;
    expect(governed).toMatch(/^Approved · .*of your usage · 6 images$/);
    expect(governed).not.toMatch(/[$¢]/);
    // No formatter: no amount at all.
    expect(summaryById(stamped('approved', 'user'), 'cg')!.text).toBe('Approved · 6 images');
    expect(summaryById(stamped('declined', 'user'), 'cg')!.text).toBe('Not now — nothing spent');
    // B3: a close the studio made never reads as the user's "Not now".
    for (const [status, text] of [
      ['nothing_to_draw', 'Nothing left to draw — nothing spent'],
      ['replaced', 'Closed — a newer approval replaced it'],
      ['superseded', 'Closed — a newer request covered it'],
      ['expired', 'Closed after a day — nothing spent'],
      ['declined', 'Closed — nothing spent']
    ] as const) {
      const line = summaryById(stamped(status, 'system'), 'cg')!.text;
      expect(line).toBe(text);
      expect(line).not.toMatch(/Not now/);
    }
  });

  it('the current gate without a stamp (legacy): approved reads its quote; an unknown decline is never "Not now"', () => {
    expect(summaryById(withConv([reply('a1', [card])], { gate: { ...gate, status: 'approved' } }), 'cg', DOLLARS)!.text).toBe('Approved · ≈ $0.42 · 6 images');
    expect(summaryById(withConv([reply('a1', [card])], { gate: { ...gate, status: 'declined' } }), 'cg')!.text).toBe('Closed — nothing spent');
    expect(summaryById(withConv([reply('a1', [card])], { gate: { ...gate, status: 'declined', closedReason: 'nothing_to_draw' } }), 'cg')!.text).toBe(
      'Nothing left to draw — nothing spent'
    );
  });

  it('a gate’s own breakdown is live while its gate is open, then folds into the gate line', () => {
    const bd: Card = { type: 'breakdown', id: 'bdg', view: 'cost', gateId: 'g1' };
    const open = withConv([reply('a1', [bd, card]), user('u1', 'later')], { gate });
    expect(settleById(open, 'bdg')).toEqual({ state: 'live' });
    const closed = { ...open, gate: { ...gate, status: 'approved' as const } };
    expect(settleById(closed, 'bdg')).toEqual({ state: 'settled', outcome: 'folded' });
    expect(summaryById(closed, 'bdg')).toEqual({ text: '', tone: 'plain', folded: true });
  });

  it('gateStampOps writes the stamp on every card of the gate, clears it, and is idempotent; the stamp stays ≈ 120 bytes', () => {
    const doc = withConv([reply('a1', [card, { type: 'notice', id: 'n', tone: 'info', text: 'hi' }]), reply('a2', [])], { gate });
    const closed = gateClosedFor({ ...gate, model: 'x'.repeat(80), imageCount: 120, estimateUsd: 12.34567 }, 'approved', 'user', 1_762_000_000_000);
    expect(closed.model).toHaveLength(GATE_STAMP_MODEL_CHARS);
    expect(closed.usd).toBe(12.3457);
    expect(JSON.stringify({ closed }).length).toBeLessThanOrEqual(130);
    expect(JSON.stringify({ closed: gateClosedFor(gate, 'superseded', 'system', 1_762_000_000_000) }).length).toBeLessThanOrEqual(70);
    const ops = gateStampOps(doc, 'g1', closed);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'message_patch', id: 'a1' });
    const after = applyOps(doc, ops, 2);
    expect(gateClosedOf(after.conversation[0].cards![0])).toEqual(closed);
    expect(after.conversation[0].cards![1]).toEqual(doc.conversation[0].cards![1]);
    expect(gateStampOps(after, 'g1', closed)).toEqual([]);
    const cleared = applyOps(after, gateStampOps(after, 'g1', null), 3);
    expect(cleared.conversation[0].cards![0]).toEqual(card);
    expect(gateStampOps(cleared, 'g1', null)).toEqual([]);
    expect(gateStampOps(doc, 'g_other', closed)).toEqual([]);
  });

  it('the guards refuse malformed stamps (a legacy or hand-edited doc never crashes a summary)', () => {
    expect(isGateClosed({ status: 'approved', by: 'user', at: 1 })).toBe(true);
    expect(isGateClosed({ status: 'nope', by: 'user', at: 1 })).toBe(false);
    expect(isGateClosed({ status: 'declined', by: 'someone', at: 1 })).toBe(false);
    expect(isGateClosed({ status: 'approved', by: 'user', at: 1, usd: -1 })).toBe(false);
    const bad = withConv([reply('a1', [{ ...card, closed: { status: 'approved' } } as Card])], { gate: { ...gate, id: 'g2' } });
    expect(summaryById(bad, 'cg')!.text).toBe('An earlier approval');
  });
});

describe('book cards and counts', () => {
  it('counts are stamped at creation; a passed plan reads them, a legacy one reads "An earlier page plan"', () => {
    const doc = makeQaDoc('heist-12p');
    const counts = planCountsFor(doc);
    expect(counts).toEqual({ pages: 12, panels: doc.pages.reduce((n, p) => n + p.panels.length, 0) });
    const sub = withPlanCounts({ type: 'breakdown', id: 'b', pageIds: [doc.pages[0].id, doc.pages[1].id], view: 'plan' }, doc);
    expect(sub.counts).toEqual({ pages: 2, panels: doc.pages[0].panels.length + doc.pages[1].panels.length });
    expect(isPlanCounts(sub.counts)).toBe(true);
    expect(isPlanCounts({ pages: -1, panels: 2 })).toBe(false);
    const plan = withPlanCounts({ type: 'plan' as const, id: 'pl' }, doc);
    const passed = withConv([reply('a1', [plan]), user('u1', 'ok')]);
    expect(planCountsOf(find(passed, 'pl').card)).toEqual(counts);
    expect(summaryById(passed, 'pl')).toEqual({ text: `Page plan · 12 pages · ${counts.panels} panels`, tone: 'plain' });
    const legacy = withConv([reply('a1', [{ type: 'plan', id: 'pl' }]), user('u1', 'ok')]);
    expect(summaryById(legacy, 'pl')?.text).toBe('An earlier page plan');
    expect(JSON.stringify({ counts }).length).toBeLessThanOrEqual(40);
  });
});

describe('other cards', () => {
  it('a conflict settles once resolved, or when passed with items left (the creator’s edit stands)', () => {
    const item = (id: string, resolved?: 'mine' | 'theirs') => ({ id, where: { label: 'p1' }, mine: 'a', theirs: 'b', proposed: [], ...(resolved ? { resolved } : {}) });
    const cf = (items: unknown[]) => ({ type: 'conflict', id: 'cf', items }) as unknown as Card;
    expect(settleById(withConv([reply('a1', [cf([item('1')])])]), 'cf')).toEqual({ state: 'open' });
    const done = withConv([reply('a1', [cf([item('1', 'mine'), item('2', 'mine'), item('3', 'theirs')])])]);
    expect(summaryById(done, 'cf')?.text).toBe('Kept yours (2) · used the director’s (1)');
    const left = withConv([reply('a1', [cf([item('1')])]), user('u1', 'go on')]);
    expect(settleById(left, 'cf')).toEqual({ state: 'settled', outcome: 'left' });
    expect(summaryById(left, 'cf')?.text).toBe('Left as yours');
  });

  it('a waiting "wait and retry" keeps its outage card live; otherwise it settles when passed', () => {
    const card = { type: 'model_outage', id: 'mo', modelId: IMAGE_MODELS[0].id, options: [{ kind: 'wait_and_retry' }], blockedAction: { type: 'render_pages', pageIds: ['a', 'b', 'c'] } } as unknown as Card;
    const doc = withConv([reply('a1', [card]), user('u1', 'ok')]);
    expect(settleById(doc, 'mo', { retrying: ['mo'] })).toEqual({ state: 'live' });
    expect(settleById(doc, 'mo', { retrying: new Set(['mo']) })).toEqual({ state: 'live' });
    expect(settleById(doc, 'mo')).toEqual({ state: 'settled', outcome: 'passed' });
    expect(summaryById(doc, 'mo')?.text).toMatch(/ was paused · 3 pages waited$/);
  });

  it('only the latest translation card stays live while the director writes its edition', () => {
    const base = makeQaDoc('heist-12p');
    const t = (id: string): Card => ({ type: 'translation', id, languages: ['es'] });
    // A failed or abandoned Spanish edition never finishes; the creator asked again, then sent another message.
    const doc = { ...base, conversation: [reply('a1', [t('t_old')]), user('u1', 'try the Spanish again'), reply('a2', [t('t_new')]), user('u2', 'and make the title bigger')] };
    const p = editionProgress(doc, 'es');
    expect(p.total).toBeGreaterThan(0);
    expect(p.done).toBeLessThan(p.total);
    expect(settleById(doc, 't_new', { working: true })).toEqual({ state: 'live' });
    expect(settleById(doc, 't_old', { working: true })).toEqual({ state: 'settled', outcome: 'newer' });
    // Not working: the passed latest card settles too.
    expect(settleById(doc, 't_new')).toEqual({ state: 'settled', outcome: 'passed' });
    expect(summaryById(doc, 't_new')?.text).toBe('Spanish edition · not finished');
  });

  it('a publish card reads honestly per mode; a running publish stays live however old', () => {
    const pub = (mode: string, status: string) => ({ type: 'publish', id: 'pb', mode, status }) as unknown as Card;
    const passed = (card: Card) => withConv([reply('a1', [card]), user('u1', 'ok'), reply('a2')]);
    expect(settleById(passed(pub('publish', 'running')), 'pb')).toEqual({ state: 'live' });
    expect(settleById(passed(pub('unpublish', 'running')), 'pb')).toEqual({ state: 'live' });
    expect(settleById(passed(pub('publish', 'pending')), 'pb')).toEqual({ state: 'settled', outcome: 'passed' });
    for (const [mode, done, failed, kept] of [
      ['publish', 'Published', 'Didn’t publish', 'Not published'],
      ['update', 'Updated', 'Didn’t update', 'Kept the published version'],
      ['unpublish', 'Unpublished', 'Didn’t unpublish', 'Still published'],
      ['regenerate', 'New link made', 'Didn’t make a new link', 'Kept the current link']
    ] as const) {
      expect(summaryById(passed(pub(mode, 'done')), 'pb')).toEqual({ text: done, tone: 'done' });
      expect(summaryById(passed(pub(mode, 'failed')), 'pb')).toEqual({ text: failed, tone: 'quiet' });
      expect(summaryById(passed(pub(mode, 'declined')), 'pb')).toEqual({ text: kept, tone: 'quiet' });
      expect(summaryById(passed(pub(mode, 'pending')), 'pb')).toEqual({ text: kept, tone: 'quiet' });
    }
  });

  it('a media link opens the tab by its visible name, Assets', () => {
    const doc = withConv(
      [
        reply('a1', [
          { type: 'refs', id: 'rf', owner: { kind: 'style' }, paths: ['a.webp', 'b.webp'] } as Card,
          { type: 'versions', id: 'vs', target: { kind: 'place', id: 'pl_x' } }
        ]),
        user('u1', 'ok')
      ]
    );
    expect(summaryById(doc, 'rf')).toEqual({ text: 'Added 2 photos to the style', tone: 'plain', link: { label: 'Open Assets', client: { type: 'open_tab', tab: 'media' } } });
    expect(summaryById(doc, 'vs')?.link).toEqual({ label: 'Open Assets', client: { type: 'open_tab', tab: 'media' } });
  });

  it('notices, unknown cards and live views settle when passed; picture cards keep one plain link and no price', () => {
    const doc = makeQaDoc('heist-12p');
    const passed = { ...doc, conversation: [...doc.conversation, user('u_late', 'next')] };
    expect(summaryById(passed, 'n2')).toEqual({ text: 'Rendering failed for page 7. Nothing was charged.', tone: 'plain' });
    expect(summaryById(passed, 'cc1')).toMatchObject({ text: 'Cast: Maya, Arjun +2', link: { client: { type: 'open_tab', tab: 'cast' } } });
    expect(summaryById(passed, 'rc1')?.text).toMatch(/^Setup confirmed · 12 pages/);
    const unknown = withConv([reply('a1', [{ type: 'mystery', id: 'x' } as unknown as Card]), user('u1', 'ok')]);
    expect(settleById(unknown, 'x')).toEqual({ state: 'settled', outcome: 'passed' });
    expect(summaryById(unknown, 'x')).toEqual({ text: 'Earlier card', tone: 'quiet' });
    expect(summaryOf(find(doc, 'o1').card, doc, { state: 'open' })).toBeNull();
  });

  it('the director reads outcomes in words, never an amount', () => {
    const gate: Gate = { id: 'g1', action: { type: 'render_cover' }, title: 't', summary: '', estimateUsd: 2.5, imageCount: 1, model: 'm', createdAt: 1, status: 'approved', reason: 'policy' };
    const doc = withConv([reply('a1', [{ ...look, answered: ['c1'] }, { type: 'gate', id: 'cg', gateId: 'g1' }]), reply('a2', [{ ...look, id: 'q2' }]), user('u1', 'x')], { gate });
    const words = (id: string) => {
      const { i, card } = find(doc, id);
      return outcomeForModel(card, doc, cardSettle(doc, i, card));
    };
    expect(words('q_look')).toBe('answered: Noir ink');
    // "no option picked", not "skipped": the next message may still answer it in free text ("the noir one").
    expect(words('q2')).toBe('no option picked');
    expect(words('cg')).toBe('approved');
    expect(words('cg')).not.toMatch(/[$¢\d]/);
  });
});
