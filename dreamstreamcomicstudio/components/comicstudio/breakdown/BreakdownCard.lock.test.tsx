// A comic locked to Nano Banana Pro is quoted on Pro in the chat, with no call-site change (plan.ts derives the
// lock from the doc). Expected prices come from the registry with an explicit lock, so these fail if the shared
// quote ignores it.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Card, ComicDoc, ImageModelLock } from '../../../shared/comic/doc';
import { estimateJobs, formatUsd } from '../../../shared/comic/models';
import { quoteRenderPages } from '../../../shared/comic/plan';
import { CastCard } from '../conversation/cards/CastCard';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from '../conversation/testing/fixtures';
import { BreakdownCard } from './BreakdownCard';

const PRO: ImageModelLock = { modelId: 'nano-banana-pro', lockedAt: 1, origin: 'user_change' };
const msg = { id: 'msg_1', role: 'assistant' as const, text: '', at: 1 };
const bd = (extra: Partial<Extract<Card, { type: 'breakdown' }>> = {}): Extract<Card, { type: 'breakdown' }> => ({ type: 'breakdown', id: 'card_bd', ...extra });

/** A button whose accessible name carries this price ("≈$0.21", "≈ $0.21"), wherever the label puts it. */
const priced = (usd: number) => new RegExp(`≈ ?${formatUsd(usd).replace('$', '\\$').replace('.', '\\.')}(?!\\d)`);

const proLocked = (): ComicDoc => {
  const doc = makeSampleDoc();
  doc.imageModel = { ...PRO };
  return doc;
};

beforeEach(showDollarPrices);
afterEach(resetUsageStatus);

describe('a Pro-locked comic is quoted on Pro in the chat cards', () => {
  it('breakdown card: "Approve & render all" carries the Pro price', () => {
    const doc = proLocked();
    const studio = makeFakeStudio({ doc });
    // Which pages and sheets would be drawn does not depend on the model; the price does.
    const q = quoteRenderPages(doc, { byok: false, tier: doc.settings.quality });
    const proUsd = estimateJobs(
      [
        { kind: 'page', count: q.pageIds.length },
        { kind: 'sheet', count: q.sheetIds.length }
      ],
      doc.settings.quality,
      { lock: PRO }
    ).usd;
    const unlockedUsd = estimateJobs([{ kind: 'page', count: q.pageIds.length }, { kind: 'sheet', count: q.sheetIds.length }], doc.settings.quality, {}).usd;
    expect(proUsd).toBeGreaterThan(unlockedUsd);
    render(<BreakdownCard card={bd()} message={msg} studio={studio} />);
    // Matched by role and price, not by the full label: the card's owner may reword the button (held-back pages,
    // "Draw anyway") without changing what this guards — the run is quoted on the locked model.
    expect(screen.getAllByRole('button', { name: priced(proUsd) }).length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('button', { name: priced(unlockedUsd) })).toHaveLength(0);
  });

  it('cast card: "Draw 1 sheet" is quoted on Pro', () => {
    const doc = proLocked();
    const studio = makeFakeStudio({ doc });
    render(<CastCard card={{ type: 'cast', id: 'card_c', characterIds: ['c_maya', 'c_arjun'] }} studio={studio} />);
    const sheet = estimateJobs([{ kind: 'sheet', count: 1 }], doc.settings.quality, { lock: PRO }).usd;
    expect(screen.getByRole('button', { name: new RegExp(`^Draw 1 sheet ≈ ?${formatUsd(sheet).replace('$', '\\$')}$`) })).toBeInTheDocument();
  });
});
