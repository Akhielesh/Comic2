// P2-PLATFORM: the legacy editor's "This comic" chip never shows governed users dollars.
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AllowanceStatus } from '../services/usageAllowance';

const billing = vi.hoisted(() => ({ report: null as unknown, fail: false }));
vi.mock('../services/billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/billing')>()),
  getComicCost: vi.fn(async () => {
    if (billing.fail) throw new Error('billing backend unavailable');
    return billing.report;
  })
}));

const allowance = vi.hoisted(() => ({ status: null as AllowanceStatus | null }));
vi.mock('./usage/useUsageAllowance', () => ({ useUsageAllowance: () => allowance.status }));

import { ComicCostChip } from './ComicEditor';

const status = (governed: boolean): AllowanceStatus => ({
  enabled: true,
  governed,
  pctUsed: 10,
  pctLeft: 90,
  exhausted: false,
  crossed: [],
  resetsAt: null,
  friendlyUnits: governed ? { standardPages: 60, draftPages: 120, pctPerStandardPage: 1.46, label: 'about 60 standard comic pages left' } : null,
  usePlatformAllowance: true,
  byokFallbackMode: 'ask',
  byokAvailable: false
});

const DOLLARS = {
  comicId: 'p1',
  totalEstimatedCt: 0,
  totalActualCt: 2000,
  totalBillableUsd: 0.2,
  totalProviderCostUsd: 0.154,
  byStage: { generation: { ct: 2000, usd: 0.2 } },
  byModel: {},
  events: []
};

describe('ComicCostChip', () => {
  beforeEach(() => {
    billing.report = null;
    billing.fail = false;
    allowance.status = null;
  });

  it('governed: "This comic: ≈N% of your usage", no dollars', async () => {
    allowance.status = status(true);
    billing.report = { comicId: 'p1', governed: true, usagePct: 2, byStage: { generation: { usagePct: 2 } }, byModel: {}, ownKeyEvents: 0 };
    render(<ComicCostChip projectId="p1" />);
    expect(await screen.findByText('This comic: ≈2% of your usage')).toBeTruthy();
    expect(screen.getByText('Usage by stage')).toBeTruthy();
    expect(screen.queryByText(/\$\d/)).toBeNull();
  });

  it('governed user with a dollar-shaped report: still no dollars', async () => {
    allowance.status = status(true);
    billing.report = DOLLARS;
    render(<ComicCostChip projectId="p1" />);
    await waitFor(() => expect(screen.getByText(/^This comic: .*% of your usage$/)).toBeTruthy());
    expect(screen.queryByText(/\$\d/)).toBeNull();
  });

  it('admin: the dollar total and per-stage split', async () => {
    allowance.status = status(false);
    billing.report = DOLLARS;
    render(<ComicCostChip projectId="p1" />);
    expect(await screen.findByText('This comic: $0.20')).toBeTruthy();
    expect(screen.getByText('$0.200')).toBeTruthy();
  });

  it('billing backend unavailable: hides instead of showing a broken chip', async () => {
    billing.fail = true;
    const { container } = render(<ComicCostChip projectId="p1" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe('');
  });
});
