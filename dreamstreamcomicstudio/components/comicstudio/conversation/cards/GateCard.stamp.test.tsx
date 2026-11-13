// GateCard reads a closed gate's past tense from the server's stamp (PROGRAM3 SETTLE-UI; bug B3: a gate the studio
// closed — a newer request covered it, a day passed, a stale quote was re-quoted — read "Not now — nothing was
// spent.", which says the CREATOR declined). The stamp is shared/comic/settle.ts GateClosed, written by jobs.ts
// commitGate and session.ts's expiry. This is the live GateCard (settled cards off, or a host without a settle);
// with settled cards on, a closed gate is its one line from summaryOf instead.

import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Gate } from '../../../../shared/comic/doc';
import { gateClosedFor, type GateClosed, type GateCardStamped } from '../../../../shared/comic/settle';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices, showUsagePrices } from '../testing/fixtures';
import { CardRenderer } from './CardRenderer';
import { gateClosedCopy } from './GateCard';
import { costFormat } from '../cost';

beforeEach(showDollarPrices);
afterEach(resetUsageStatus);

const gate: Gate = {
  id: 'gate_1',
  action: { type: 'render_pages', pageIds: ['pg_2'] },
  title: 'Draw 1 page?',
  summary: '1 page on Nano Banana 2.1 (2K) · ≈ $0.07.',
  estimateUsd: 0.07,
  imageCount: 1,
  model: 'Nano Banana 2.1',
  createdAt: 1,
  status: 'declined',
  reason: 'first_render'
};
const stamped = (closed: GateClosed): GateCardStamped => ({ type: 'gate', id: 'card_g', gateId: 'gate_1', closed });
const renderGate = (card: GateCardStamped, docGate: Gate | undefined) =>
  render(<CardRenderer card={card} studio={makeFakeStudio({ doc: makeSampleDoc(docGate ? { gate: docGate } : {}) })} />);

describe('GateCard closed copy from the stamp', () => {
  it('a gate the studio closed never reads "Not now"', () => {
    for (const [closed, words] of [
      [{ status: 'declined', by: 'system', at: 2 }, /Closed by the studio — nothing was spent\./],
      [{ status: 'superseded', by: 'system', at: 2 }, /Closed — a newer request covered it\. Nothing was spent here\./],
      [{ status: 'expired', by: 'system', at: 2 }, /Closed after a day without an answer — nothing was spent\./]
    ] as const) {
      const { unmount } = renderGate(stamped(closed), gate);
      expect(screen.getByText(words)).toBeInTheDocument();
      expect(screen.queryByText(/Not now/)).toBeNull();
      expect(screen.queryByRole('button')).toBeNull();
      unmount();
    }
  });

  it('the creator’s own "Not now" still reads "Not now"', () => {
    renderGate(stamped({ status: 'declined', by: 'user', at: 2 }), gate);
    expect(screen.getByText(/Not now — nothing was spent\./)).toBeInTheDocument();
  });

  it('an approval that a later gate followed still reads "Approved", with its quote, never "replaced"', () => {
    const closed = gateClosedFor({ estimateUsd: 0.42, imageCount: 6, model: 'Nano Banana 2.1' }, 'approved', 'user', 2);
    const { unmount } = renderGate(stamped(closed), { ...gate, id: 'gate_2', status: 'open' });
    expect(screen.getByText('Approved · ≈ $0.42 · 6 images.')).toBeInTheDocument();
    expect(screen.queryByText(/replaced by a newer one/)).toBeNull();
    unmount();
    // A governed creator reads a share of their usage, never a dollar.
    showUsagePrices(2);
    const { container } = renderGate(stamped(closed), { ...gate, id: 'gate_2', status: 'open' });
    expect(container.textContent).toMatch(/Approved · .*of your usage · 6 images\./);
    expect(container.textContent).not.toMatch(/[$¢]/);
  });

  it('a stamped "replaced" and an unstamped legacy card keep today’s words; the current approval keeps "drawing now"', () => {
    const r1 = renderGate(stamped({ status: 'replaced', by: 'system', at: 2 }), { ...gate, id: 'gate_2', status: 'open' });
    expect(screen.getByText(/replaced by a newer one/)).toBeInTheDocument();
    r1.unmount();
    const r2 = renderGate({ type: 'gate', id: 'card_g', gateId: 'gate_1' }, gate);
    expect(screen.getByText(/Not now — nothing was spent\./)).toBeInTheDocument();
    r2.unmount();
    renderGate(stamped(gateClosedFor(gate, 'approved', 'user', 2)), { ...gate, status: 'approved' });
    expect(screen.getByText(/Approved — drawing now\./)).toBeInTheDocument();
  });

  it('gateClosedCopy: words for every stamp, no amount for an approval that drew nothing priced', () => {
    const dollars = costFormat({ governed: false });
    expect(gateClosedCopy({ status: 'nothing_to_draw', by: 'system', at: 1 }, dollars, true)).toBe('Nothing left to draw — nothing was spent.');
    expect(gateClosedCopy({ status: 'approved', by: 'user', at: 1 }, dollars, true)).toBeNull();
    expect(gateClosedCopy({ status: 'approved', by: 'user', usd: 0, at: 1 }, dollars, false)).toBe('Approved.');
  });
});
