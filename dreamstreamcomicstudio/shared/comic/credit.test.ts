// The stored `credit` card (credit-safety.md): malformed cards are dropped, an allowance card never keeps a dollar field,
// and the actions it offers are only the image spends a run can carry.
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, normalizeDoc, type Msg } from './doc';
import { normalizeCreditCard } from './credit';

const msg = (cards: unknown[]): Msg => ({ id: 'm1', role: 'assistant', text: 'Stopped.', at: 1, cards: cards as Msg['cards'] });

describe('normalizeCreditCard', () => {
  it('keeps a well-formed own-key card as written', () => {
    const card = {
      type: 'credit', id: 'c1', reason: 'short', payer: 'own_key', provider: 'openrouter', what: 'pages 1–3', needUsd: 0.21, leftUsd: 0.05, checkedAt: 1_790_000_000_000,
      fits: { action: { type: 'render_pages', pageIds: ['p1'], quotedUsd: 0.04 }, usd: 0.04, pages: 1 }
    };
    expect(normalizeCreditCard(card)).toEqual(card);
  });

  it('an allowance card keeps percentages only: dollar fields and a provider never survive', () => {
    const out = normalizeCreditCard({ type: 'credit', id: 'c2', reason: 'short', payer: 'allowance', provider: 'openrouter', needUsd: 1.2, leftUsd: 0.1, needPct: 12.5, leftPct: 140 });
    expect(out).toEqual({ type: 'credit', id: 'c2', reason: 'short', payer: 'allowance', needPct: 12.5, leftPct: 100 });
    expect(normalizeCreditCard({ type: 'credit', id: 'c3', reason: 'short', payer: 'allowance', needPct: null, leftPct: 0 })).toMatchObject({ needPct: null, leftPct: 0 });
  });

  it('drops a malformed card and an offer that is not an image spend', () => {
    expect(normalizeCreditCard({ type: 'credit', id: '', reason: 'short', payer: 'own_key' })).toBeUndefined();
    expect(normalizeCreditCard({ type: 'credit', id: 'c4', reason: 'later', payer: 'own_key' })).toBeUndefined();
    expect(normalizeCreditCard({ type: 'credit', id: 'c5', reason: 'stopped', payer: 'someone_else' })).toBeUndefined();
    const out = normalizeCreditCard({
      type: 'credit', id: 'c6', reason: 'stopped', payer: 'own_key', provider: 'gemini', noQuota: true, drawn: 1, notStarted: -2,
      rest: { action: { type: 'publish' }, usd: 1 }, fits: { action: { type: 'render_pages' }, usd: 0, pages: 1 }
    });
    expect(out).toEqual({ type: 'credit', id: 'c6', reason: 'stopped', payer: 'own_key', provider: 'gemini', noQuota: true, drawn: 1 });
  });

  it('runs on every stored doc: older comics without the card load as before, a bad card is dropped', () => {
    const base = createEmptyDoc('p1', 'Synthetic', 1);
    const good = { type: 'credit', id: 'c7', reason: 'stopped', payer: 'own_key', provider: 'openrouter', drawn: 0, notStarted: 2 };
    const doc = normalizeDoc({ ...base, conversation: [msg([good, { type: 'credit', id: 'c8' }])] });
    expect(doc.conversation[0].cards).toEqual([good]);
    expect(normalizeDoc({ ...base, conversation: [msg([{ type: 'notice', id: 'n1', tone: 'info', text: 'Hi' }])] }).conversation[0].cards).toHaveLength(1);
  });
});
