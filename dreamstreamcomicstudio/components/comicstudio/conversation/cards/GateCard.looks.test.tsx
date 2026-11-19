// GateCard's reason line on a style test (stylepick SC-0): every Director style test now waits for Approve, usually
// as a small 'policy' gate under the spend threshold. That gate says looks are drawn only after Approve, never "the
// up-to-date price" (a re-quote's words) and never a price word, for dollar and usage readers alike. Over the
// threshold, and under "check before every spend", the setting is named as before.

import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Gate } from '../../../../shared/comic/doc';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices, showUsagePrices } from '../testing/fixtures';
import { CardRenderer } from './CardRenderer';
import { gateReasonCopy } from './GateCard';

beforeEach(showDollarPrices);
afterEach(resetUsageStatus);

const LOOKS_LINE = 'Looks are drawn only after you approve — nothing is spent until then.';

const looksGate: Gate = {
  id: 'gate_1',
  action: { type: 'render_style_options', count: 3 },
  title: 'Draw 3 looks picked for your story?',
  summary: '3 looks picked for your story on Nano Banana 2.1 (1K) · ≈ $0.12.',
  estimateUsd: 0.12,
  imageCount: 3,
  model: 'Nano Banana 2.1',
  createdAt: 1,
  status: 'open',
  reason: 'policy'
};

const bigPolicy = (settings: Partial<ReturnType<typeof makeSampleDoc>['settings']> = {}) =>
  makeSampleDoc({ settings: { ...makeSampleDoc().settings, confirm: 'big', bigSpendUsd: 0.5, ...settings } });

describe('GateCard reason line for a style test', () => {
  it('a small policy gate for looks says they are drawn only after Approve (no price words)', () => {
    const doc = bigPolicy();
    expect(gateReasonCopy(looksGate, doc)).toBe(LOOKS_LINE);
    expect(gateReasonCopy({ ...looksGate, estimateUsd: 0.5 }, doc)).toBe(LOOKS_LINE);
    expect(LOOKS_LINE).not.toMatch(/\$|price|cost|usage/i);
  });

  it('other small policy gates keep the re-quote line; big gates and "always" name the setting', () => {
    const doc = bigPolicy();
    expect(gateReasonCopy({ ...looksGate, action: { type: 'render_cover' } }, doc)).toBe('Here’s the up-to-date price first — nothing is spent until you approve.');
    expect(gateReasonCopy({ ...looksGate, estimateUsd: 0.84 }, doc)).toMatch(/check before spends over \$0\.50/);
    expect(gateReasonCopy(looksGate, bigPolicy({ confirm: 'always' }))).toBe('You asked me to check before every spend.');
    expect(gateReasonCopy({ ...looksGate, reason: 'no_intent' }, doc)).toMatch(/didn’t ask me to draw/);
  });

  it('renders the looks line on the live card, for a governed reader too', () => {
    const card = { type: 'gate' as const, id: 'card_g', gateId: 'gate_1' };
    const { unmount } = render(<CardRenderer card={card} studio={makeFakeStudio({ doc: { ...bigPolicy(), gate: looksGate } })} />);
    expect(screen.getByText(LOOKS_LINE)).toBeInTheDocument();
    unmount();
    showUsagePrices();
    render(<CardRenderer card={card} studio={makeFakeStudio({ doc: { ...bigPolicy(), gate: looksGate } })} />);
    expect(screen.getByText(LOOKS_LINE)).toBeInTheDocument();
  });
});
