// @vitest-environment node
// SETTLE-CORE wave note 2 (B-9a, with amendment A; S2b integration): with SETTLED_CARDS on, a card the chat has moved
// past is settled. A late answer to it is ordinary text (nothing is written on the card, no other card is guessed), and
// the director reads every settled options, gate and conflict card with its outcome in words, never an amount.

import { describe, expect, it, vi } from 'vitest';
import type { Card, ComicDoc, Gate, Msg } from '../../../shared/comic/doc.js';
import { conversationForDirector, recordOptionAnswer } from './director.js';
import { newSession, plannedDoc } from './orchestrator.fakes.js';

vi.spyOn(console, 'info').mockImplementation(() => undefined);

const optionsCard = (): Card => ({
  type: 'options',
  id: 'q',
  question: 'Which ink?',
  choices: [
    { id: 'c1', label: 'Noir ink' },
    { id: 'c2', label: 'Bright ink' }
  ]
} as Card);
const msg = (id: string, role: Msg['role'], text: string, cards?: Card[]): Msg => ({ id, role, text, at: 1, ...(cards ? { cards } : {}) });

/** [a1 options q (c1 Noir ink), u1 'other', a2]: q is passed (u1 came after it). */
const passedSession = () => {
  const doc: ComicDoc = { ...plannedDoc(), conversation: [msg('a1', 'assistant', 'Pick one.', [optionsCard()]), msg('u1', 'user', 'other'), msg('a2', 'assistant', 'Sure.')] };
  return newSession(doc);
};
const qOf = (doc: ComicDoc) => doc.conversation[0].cards!.find((c) => c.id === 'q') as Extract<Card, { type: 'options' }>;

describe('recordOptionAnswer with SETTLED_CARDS (SETTLE-CORE #2 (b)-(d))', () => {
  it('(i) a tap on a passed card is kept: false and nothing written; without settled it is answered (today, and the mutation proof)', () => {
    const settledSession = passedSession();
    expect(recordOptionAnswer(settledSession, 'Noir ink', { id: 'q', choiceIds: ['c1'] }, { settled: true })).toBe(false);
    expect(qOf(settledSession.doc).answered).toBeUndefined();
    const today = passedSession();
    expect(recordOptionAnswer(today, 'Noir ink', { id: 'q', choiceIds: ['c1'] }, { settled: false })).toBe(true);
    expect(qOf(today.doc).answered).toEqual(['c1']);
  });

  it('(ii) the same words with no card reference write nothing on a passed card either; without settled the text still matches', () => {
    const settledSession = passedSession();
    expect(recordOptionAnswer(settledSession, 'Noir ink', undefined, { settled: true })).toBe(false);
    expect(qOf(settledSession.doc).answered).toBeUndefined();
    const today = passedSession();
    expect(recordOptionAnswer(today, 'Noir ink')).toBe(true);
    expect(qOf(today.doc).answered).toEqual(['c1']);
  });

  it('a card on the latest reply is still answered with settled on (the message being routed is not committed yet)', () => {
    const doc: ComicDoc = { ...plannedDoc(), conversation: [msg('u0', 'user', 'start'), msg('a1', 'assistant', 'Pick one.', [optionsCard()])] };
    const session = newSession(doc);
    expect(recordOptionAnswer(session, 'Noir ink', { id: 'q', choiceIds: ['c1'] }, { settled: true })).toBe(true);
    expect((session.doc.conversation[1].cards![0] as Extract<Card, { type: 'options' }>).answered).toEqual(['c1']);
  });
});

describe('conversationForDirector outcomes (SETTLE-CORE #2 (e), amendment A)', () => {
  const approved = (estimateUsd: number): ComicDoc => {
    const gate = { id: 'g1', status: 'approved', reason: 'big', action: { type: 'render_pages' }, estimateUsd, createdAt: 1 } as unknown as Gate;
    return {
      ...plannedDoc(),
      gate,
      conversation: [
        msg('u0', 'user', 'start'),
        msg('a1', 'assistant', 'Two things.', [optionsCard(), { type: 'gate', id: 'gc1', gateId: 'g1' } as Card]),
        msg('u1', 'user', 'go on')
      ]
    };
  };
  const text = (doc: ComicDoc, outcomes: boolean) => conversationForDirector(doc.conversation, undefined, doc, { outcomes }).map((m) => m.content).join('\n');

  it('(iii) a passed options card reads "no option picked", the approved gate "approved", and no amount appears, whatever the cost', () => {
    for (const usd of [0.42, 12.5]) {
      const out = text(approved(usd), true);
      expect(out).toContain('[asked: Which ink? — options: Noir ink / Bright ink; no option picked]');
      expect(out).toContain('[asked the user to approve a spend; approved]');
      expect(out).not.toContain('$');
      expect(out).not.toContain(String(usd));
    }
    // Off (the default stage for non-admins): exactly the old words.
    const off = text(approved(0.42), false);
    expect(off).toContain('[asked: Which ink? — options: Noir ink / Bright ink]');
    expect(off).toContain('[asked the user to approve a spend]');
  });

  it('an answered card reads "answered: <label>" with outcomes on, as the old suffix did', () => {
    const doc = approved(0.42);
    (doc.conversation[1].cards![0] as Extract<Card, { type: 'options' }>).answered = ['c1'];
    expect(text(doc, true)).toContain('[asked: Which ink? — options: Noir ink / Bright ink; answered: Noir ink]');
  });

  it('(iv) an open options card on the last reply adds no "; " suffix', () => {
    const doc: ComicDoc = { ...plannedDoc(), conversation: [msg('u0', 'user', 'start'), msg('a1', 'assistant', 'Pick one.', [optionsCard()])] };
    const out = text(doc, true);
    expect(out).toContain('[asked: Which ink? — options: Noir ink / Bright ink]');
    expect(out).not.toMatch(/options: [^\]]*; /);
  });

  it('the outcome is judged on the window: a passed card at the start of a long conversation keeps its own index', () => {
    const doc = approved(0.42);
    const filler = Array.from({ length: 30 }, (_, i) => msg(`f${i}`, i % 2 ? 'assistant' : 'user', `m${i}`));
    const long: ComicDoc = { ...doc, conversation: [...filler, ...doc.conversation] };
    expect(text(long, true)).toContain('; no option picked]');
  });
});
