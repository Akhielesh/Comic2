// Governed users never see dollars (P1-LIMITS rule, P2-CONVERSATION surfaces): every chip, quote,
// badge, button and panel in the conversation speaks in a share of the user's usage
// ("≈2% of your usage"); admins and own-key comics keep real prices.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import type { Card, ComicDoc, Gate, Msg } from '../../../shared/comic/doc';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { DOLLAR_CONTEXT, standardPageProviderUsd } from '../../../services/costDisplay';
import { normalizeAllowanceStatus } from '../../../services/usageAllowance';
import { CardRenderer } from './cards/CardRenderer';
import { AssistantMessage } from './MessageItem';
import { ActivityLine } from './ActivityLine';
import { FormatPanel } from './panels/FormatPanel';
import { QualityPanel } from './panels/QualityPanel';
import { StylePanel } from './panels/StylePanel';
import { PlanList } from './cards/PlanCard';
import { costContextFor, costFormat, useCostFormat, usageSafeSpendText } from './cost';
import { gateReasonCopy } from './cards/GateCard';
import { priceBadge, chipLabel } from './cards/NextStepChips';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices, showUsagePrices } from './testing/fixtures';

afterEach(resetUsageStatus);

const NO_DOLLARS = /\$\s?\d/;

const openGate = (extra: Partial<Gate> = {}): Gate => ({
  id: 'gate_1',
  action: { type: 'render_pages', pageIds: ['pg_2'] },
  title: 'Draw 1 page?',
  summary: '1 page on Nano Banana 2.1 (2K) · ≈ $0.21. That would bring this comic to $1.20 — over your $1.00 budget.',
  estimateUsd: 0.21,
  imageCount: 1,
  model: 'Nano Banana 2.1',
  createdAt: 1,
  status: 'open',
  reason: 'budget',
  ...extra
});

describe('cost context', () => {
  it('own key and admins → dollars; a governed status or caps snapshot → usage terms; unknown → usage terms', () => {
    const governed = normalizeAllowanceStatus({ enabled: true, governed: true, pctUsed: 0, pctLeft: 100, friendlyUnits: { label: 'x', pctPerStandardPage: 1 } });
    expect(costContextFor(governed, DEFAULT_CAPS, true)).toEqual(DOLLAR_CONTEXT);
    expect(costContextFor(governed, { ...DEFAULT_CAPS, byok: true })).toEqual(DOLLAR_CONTEXT);
    expect(costContextFor(null, { ...DEFAULT_CAPS, admin: true })).toEqual(DOLLAR_CONTEXT);
    expect(costContextFor(governed, DEFAULT_CAPS).governed).toBe(true);
    const fromCaps = costContextFor(null, { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 80, exhausted: false, pctPerStandardPage: 2 } });
    expect(fromCaps.governed).toBe(true);
    expect(fromCaps.pctPerUsd).toBeCloseTo(2 / standardPageProviderUsd());
    expect(costContextFor(null, { ...DEFAULT_CAPS, usage: { governed: false, pctLeft: 100, exhausted: false, pctPerStandardPage: null } })).toEqual(DOLLAR_CONTEXT);
    // Not loaded yet: never a dollar figure for someone who might be governed.
    expect(costContextFor(null, DEFAULT_CAPS)).toEqual({ governed: true, pctPerUsd: null });
  });

  it('formats quotes, badges, savings and spoken text without a dollar sign', () => {
    const per = standardPageProviderUsd(); // 1% per page ⇒ $per = 1%
    const fmt = costFormat({ governed: true, pctPerUsd: 1 / per });
    const marked = per * 2 * 1.3; // client quotes include the platform markup
    expect(fmt.approx(marked)).toBe('≈2% of your usage');
    expect(fmt.badge(marked)).toBe('≈2% of your usage');
    expect(fmt.spoken(marked)).toBe('about 2% of your usage');
    expect(fmt.saved(marked)).toBe('Saved ≈2% of your usage');
    expect(fmt.saved(0.0001)).toBe('No AI cost');
    expect(fmt.approx(0)).toBe('Free');
    const dollars = costFormat(DOLLAR_CONTEXT);
    expect(dollars.approx(0.07)).toBe('≈ $0.07');
    expect(dollars.badge(0.07)).toBe('≈$0.07');
    expect(dollars.saved(0.07)).toBe('Saved ≈$0.07');
  });

  it('server spend text loses its dollars for a governed user (and is untouched for admins)', () => {
    const fmt = costFormat({ governed: true, pctPerUsd: 10 });
    const out = usageSafeSpendText(openGate().summary, fmt);
    expect(out).not.toMatch(NO_DOLLARS);
    expect(out).toMatch(/^1 page on Nano Banana 2\.1 \(2K\) · ≈[\d.]+% of your usage\.$/);
    expect(usageSafeSpendText('Translate 12 lines', fmt)).toBe('Translate 12 lines');
    const summary = openGate().summary;
    expect(usageSafeSpendText(summary, costFormat(DOLLAR_CONTEXT))).toBe(summary);
  });

  it('the hook follows the shared usage status (no polling)', () => {
    showDollarPrices();
    const { result } = renderHook(() => useCostFormat({ byok: false, caps: DEFAULT_CAPS }));
    expect(result.current.governed).toBe(false);
    act(() => showUsagePrices(1));
    expect(result.current.governed).toBe(true);
    expect(result.current.approx(0.2)).toMatch(/% of your usage$/);
  });
});

describe('conversation surfaces for a governed user', () => {
  beforeEach(() => showUsagePrices(1));

  it('GateCard: quote, Approve, reason and summary are in usage terms', () => {
    const doc = makeSampleDoc({ gate: openGate(), settings: { ...makeSampleDoc().settings, budgetUsd: 1 } });
    const studio = makeFakeStudio({ doc });
    const card: Card = { type: 'gate', id: 'card_gate', gateId: 'gate_1' };
    const msg: Msg = { id: 'm1', role: 'assistant', text: '', at: 1, cards: [{ type: 'breakdown', id: 'bd', gateId: 'gate_1' }, card] };
    render(<CardRenderer card={card} studio={studio} message={msg} />);
    const approval = screen.getByRole('region', { name: 'Spend approval' });
    expect(approval.textContent).not.toMatch(NO_DOLLARS);
    expect(screen.getByTestId('gate-usage-price')).toHaveTextContent(/≈[\d.]+%of your usage|≈[\d.]+% of your usage/);
    expect(within(approval).getByRole('button', { name: /^Approve · ≈[\d.]+% of your usage$/ })).toBeInTheDocument();
    expect(approval).toHaveTextContent('past the budget you set for it');
  });

  it('gateReasonCopy names no dollar threshold for a governed user', () => {
    const doc = makeSampleDoc();
    const fmt = costFormat({ governed: true, pctPerUsd: 10 });
    const policy = gateReasonCopy(openGate({ reason: 'policy', estimateUsd: 5 }), { ...doc, settings: { ...doc.settings, bigSpendUsd: 0.5 } } as ComicDoc, fmt);
    expect(policy).toBe('You asked me to check before bigger spends.');
  });

  it('next-step chips badge a share of the usage; the name a screen reader hears matches', () => {
    const msg: Msg = {
      id: 'a1',
      role: 'assistant',
      text: 'Ready.',
      at: 1,
      nextSteps: [
        { label: 'Make the cover · ≈$0.07', action: { type: 'render_cover', quotedUsd: 0.0845 }, usd: 0.0845 },
        { label: 'Read it', client: { type: 'open_reader' }, usd: 0 }
      ]
    };
    render(<AssistantMessage msg={msg} showSuggestions studio={makeFakeStudio()} />);
    const group = screen.getByRole('group', { name: 'Next steps' });
    expect(group.textContent).not.toMatch(NO_DOLLARS);
    expect(within(group).getByRole('button', { name: /^Make the cover, ≈[\d.]+% of your usage$/ })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Read it, Free' })).toBeInTheDocument();
    // A server label already in usage terms reads its price once.
    expect(chipLabel('Draw 2 pages · ≈4% of your usage', priceBadge(0.1, costFormat({ governed: true, pctPerUsd: 40 })))).toBe('Draw 2 pages');
  });

  it('the plan list, panels and the savings badge never show dollars', () => {
    const doc = makeSampleDoc({ spend: { ...makeSampleDoc().spend, savedUsd: 0 } });
    const studio = makeFakeStudio({ doc });
    const { unmount } = render(<PlanList card={{ type: 'plan', id: 'p' }} studio={studio} />);
    expect(screen.getByRole('button', { name: /Approve & render all \(≈[\d.]+% of your usage\)/ })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(NO_DOLLARS);
    unmount();

    // (No style options drawing, so the "Explore 3 directions" quote shows.)
    const idle = { ...doc, style: { ...doc.style, options: doc.style.options.filter((o) => o.render.status !== 'rendering') } };
    for (const panel of [
      <FormatPanel key="f" doc={doc} patch={() => undefined} caps={DEFAULT_CAPS} />,
      <StylePanel key="s" doc={idle} patch={() => undefined} act={() => undefined} onDescribeOwn={() => undefined} onDone={() => undefined} caps={DEFAULT_CAPS} />,
      <QualityPanel key="q" doc={doc} patch={() => undefined} caps={DEFAULT_CAPS} />
    ]) {
      const r = render(panel);
      expect(r.container.textContent).not.toMatch(NO_DOLLARS);
      expect(r.container.textContent).toMatch(/% of your usage/);
      r.unmount();
    }

    const busy = makeFakeStudio({ doc, busy: true, activity: [{ id: 'x', label: 'Lettering page 2', phase: 'start', at: 1 }] });
    const { rerender } = render(<ActivityLine studio={busy} />);
    rerender(<ActivityLine studio={{ ...busy, doc: { ...doc, spend: { ...doc.spend, savedUsd: 1 } } }} />);
    const status = screen.getByRole('status');
    expect(status.textContent).not.toMatch(NO_DOLLARS);
    expect(status).toHaveTextContent(/Saved ≈[\d.]+% of your usage|No AI cost/);
  });

  it('the AI-writer step badge speaks of usage, not cents, for a governed user', () => {
    const doc = makeSampleDoc();
    const step = { id: 'w', label: 'Writing page 2', phase: 'start' as const, at: 1, cost: 'text' as const };
    const { unmount } = render(<ActivityLine studio={makeFakeStudio({ doc, busy: true, activity: [step] })} />);
    const status = screen.getByRole('status');
    expect(status.textContent).not.toMatch(/cent|\$/i);
    expect(within(status).getByTitle('Uses the AI writer — barely touches your usage')).toHaveTextContent(/^AI/);
    unmount();
    // Admins keep the plain-money hint.
    showDollarPrices();
    render(<ActivityLine studio={makeFakeStudio({ doc, busy: true, activity: [step] })} />);
    expect(within(screen.getByRole('status')).getByTitle('Uses the AI writer — a fraction of a cent')).toBeInTheDocument();
  });

  it('own-key comics keep real prices even for a governed account', () => {
    const doc = makeSampleDoc({ gate: openGate({ reason: 'first_render' }) });
    render(<CardRenderer card={{ type: 'gate', id: 'g', gateId: 'gate_1' }} studio={makeFakeStudio({ doc, byok: true })} />);
    expect(screen.getByRole('button', { name: 'Approve · $0.21' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
  });
});
