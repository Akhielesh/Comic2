// The registry cards, verified IN SITU (P2-CONVERSATION): every card type a wave-1 feature
// registered (breakdown, versions, style_presets, refs, publish, share, translation) renders
// inside a real director reply — through AssistantMessage → CardRenderer → features.ts — with
// the message it rides on, never falls into the error boundary, and keeps the reply from being
// "silent". The registries are the real ones (no module mocks).

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { Card, Msg } from '../../../shared/comic/doc';
import { registeredCard, registeredCardTypes } from '../features';
import { AssistantMessage } from './MessageItem';
import { CARD_TYPES } from './cards/CardRenderer';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from './testing/fixtures';

beforeEach(showDollarPrices);
afterEach(resetUsageStatus);

const REGISTRY_CARDS: Card[] = [
  { type: 'breakdown', id: 'card_bd', view: 'plan' },
  { type: 'versions', id: 'card_v', target: { kind: 'page', id: 'pg_1' } },
  { type: 'style_presets', id: 'card_sp', presetIds: ['noir-ink', 'ligne-claire', 'modern-heroic'], note: 'Three looks that fit a heist.' },
  { type: 'refs', id: 'card_refs', owner: { kind: 'character', id: 'c_maya' }, paths: [] },
  { type: 'publish', id: 'card_pub', mode: 'publish', status: 'pending' },
  { type: 'share', id: 'card_share' },
  { type: 'translation', id: 'card_tr', languages: ['te'] }
];

const reply = (card: Card): Msg => ({ id: `msg_${card.id}`, role: 'assistant', text: '', at: 1, cards: [card] });

describe('registry cards in a director reply', () => {
  it('every expected feature card is registered (and none shadows a built-in)', () => {
    const types = registeredCardTypes();
    for (const c of REGISTRY_CARDS) expect(types).toContain(c.type);
    for (const t of types) expect(CARD_TYPES).not.toContain(t);
  });

  it.each(REGISTRY_CARDS.map((c) => [c.type, c] as const))('%s renders through CardRenderer with its message', (_type, card) => {
    const doc = makeSampleDoc({ conversation: [reply(card)] });
    const studio = makeFakeStudio({ doc });
    const { container } = render(<AssistantMessage msg={reply(card)} studio={studio} />);
    expect(registeredCard(card.type)).toBeDefined();
    // Not the error boundary, and not the "Done — the board shows the latest." silence fallback.
    expect(container.textContent).not.toMatch(/This card couldn’t be shown/);
    expect(screen.queryByText('Done — the board shows the latest.')).toBeNull();
    // The card is mounted inside the reply and shows something real.
    const slot = container.querySelector('[data-role="assistant"] .studio-reveal') as HTMLElement;
    expect(slot).toBeTruthy();
    expect(slot.childElementCount).toBeGreaterThan(0);
    expect((slot.textContent || '').trim().length + slot.querySelectorAll('img,svg').length).toBeGreaterThan(0);
  });

  it('a gate with its breakdown sibling shows the breakdown once, above the approval', () => {
    const gateId = 'gate_1';
    const cards: Card[] = [
      { type: 'breakdown', id: 'card_bd2', pageIds: ['pg_2'], view: 'cost', gateId },
      { type: 'gate', id: 'card_gate', gateId }
    ];
    const doc = makeSampleDoc({
      gate: {
        id: gateId,
        action: { type: 'render_pages', pageIds: ['pg_2'] },
        title: 'Draw 1 page?',
        summary: '1 page on Nano Banana 2.1 (2K) · ≈ $0.07.',
        estimateUsd: 0.07,
        imageCount: 1,
        model: 'Nano Banana 2.1',
        createdAt: 1,
        status: 'open',
        reason: 'first_render'
      },
      conversation: [{ id: 'm1', role: 'assistant', text: 'Here is what I would draw.', at: 1, cards }]
    });
    const studio = makeFakeStudio({ doc });
    render(<AssistantMessage msg={doc.conversation[0]} studio={studio} />);
    const approval = screen.getByRole('region', { name: 'Spend approval' });
    expect(within(approval).getByRole('button', { name: /^Approve ·/ })).toBeInTheDocument();
    // The embedded copy is skipped because the reply already carries the breakdown above the gate.
    expect(within(approval).queryByRole('button', { name: /Approve & (draw|render) all/ })).toBeNull();
  });
});
