// P2-PLATFORM-FOLLOWUP: the legacy stream view's run-confirm gate and cost chip never show dollars
// to governed users (everyone on the included DreamStream usage) — they read as a share of the
// usage. Admins / exempt accounts and own-key (BYOK) runs see the real price.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AllowanceStatus } from '../../../services/usageAllowance';
import { standardPageProviderUsd } from '../../../services/costDisplay';

const allowance = vi.hoisted(() => ({ status: null as AllowanceStatus | null }));
vi.mock('../../usage/useUsageAllowance', () => ({ useUsageAllowance: () => allowance.status }));

import { ComicStreamView, gateCostSentence } from './ComicStreamView';
import { AppStep, type ComicState } from '../../../types';

const status = (over: Partial<AllowanceStatus> = {}): AllowanceStatus => ({
  enabled: true,
  governed: true,
  pctUsed: 20,
  pctLeft: 80,
  exhausted: false,
  crossed: [],
  resetsAt: null,
  // One Standard page = 2% of the usage → $X of provider cost maps to a share.
  friendlyUnits: { standardPages: 40, draftPages: 80, pctPerStandardPage: 2, label: 'about 40 standard comic pages left' },
  usePlatformAllowance: true,
  byokFallbackMode: 'ask',
  byokAvailable: false,
  ...over
});

const state = { step: AppStep.SCRIPT_INPUT, scenes: [], styleVariants: [], characters: [], panels: [], comments: [] } as unknown as ComicState;

const renderGate = (props: { byok?: boolean } = {}) => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ComicStreamView
      state={state}
      projectTitle="Rooftop Heist"
      pendingGate={{ estimateUsd: 0.3 }}
      costUsd={0.42}
      onConfirmGate={onConfirm}
      onCancelGate={onCancel}
      {...props}
    />
  );
  return { onConfirm, onCancel };
};

afterEach(() => {
  allowance.status = null;
});

describe('ComicStreamView run gate — governed vs admin vs BYOK', () => {
  it('governed user: a share of the usage, no dollars anywhere', () => {
    allowance.status = status();
    const { onConfirm } = renderGate();
    expect(standardPageProviderUsd()).toBeGreaterThan(0);
    expect(document.body.textContent).toMatch(/This run will use ≈\d+(\.\d)?% of your usage\./);
    expect(document.body.textContent).not.toMatch(/\$\d/);
    const run = screen.getByRole('button', { name: 'Run it' });
    fireEvent.click(run);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/This comic ·/).textContent).toMatch(/of your usage/);
  });

  it('usage status not loaded / unavailable: still no dollars (fails closed)', () => {
    allowance.status = null;
    renderGate();
    expect(document.body.textContent).toContain('This run uses a little of your usage.');
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });

  it('admin / exempt (no limit applies): the real price', () => {
    allowance.status = status({ governed: false });
    renderGate();
    expect(document.body.textContent).toContain('This run is estimated at $0.30.');
    expect(screen.getByRole('button', { name: 'Run · $0.30' })).toBeTruthy();
    expect(screen.getByText(/This comic ·/).textContent).toContain('$0.42');
  });

  it('own key (BYOK): the real price even for a governed account', () => {
    allowance.status = status();
    renderGate({ byok: true });
    expect(document.body.textContent).toContain('This run is estimated at $0.30.');
    expect(screen.getByRole('button', { name: 'Run · $0.30' })).toBeTruthy();
  });

  it('“Not yet” cancels; both actions are 44 px tall and wrap on narrow screens', () => {
    allowance.status = status();
    const { onCancel } = renderGate();
    const notYet = screen.getByRole('button', { name: 'Not yet' });
    fireEvent.click(notYet);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(notYet.className).toContain('min-h-11');
    expect(notYet.parentElement!.className).toContain('flex-wrap');
  });
});

describe('gateCostSentence', () => {
  const text = (node: React.ReactNode) => {
    const { container, unmount } = render(<p>{node}</p>);
    const t = container.textContent;
    unmount();
    return t;
  };
  it('reads naturally for every label shape', () => {
    expect(text(gateCostSentence(0.3, { governed: false }))).toBe('This run is estimated at $0.30.');
    expect(text(gateCostSentence(0, { governed: true, pctPerUsd: 5 }))).toBe('This run doesn’t use any of your usage.');
    expect(text(gateCostSentence(0.3, { governed: true, pctPerUsd: null }))).toBe('This run uses a little of your usage.');
    expect(text(gateCostSentence(0.3, { governed: true, pctPerUsd: 10 }))).toBe('This run will use ≈3% of your usage.');
    expect(text(gateCostSentence(0.001, { governed: true, pctPerUsd: 10 }))).toBe('This run will use <0.1% of your usage.');
  });
});
