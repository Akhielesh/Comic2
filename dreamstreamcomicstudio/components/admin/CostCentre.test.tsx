import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CostCentreReport } from '../../shared/types/costCentre';

const getCostCentre = vi.hoisted(() => vi.fn());
vi.mock('../../services/adminCosts', () => ({ getCostCentre }));

import { CostCentre } from './CostCentre';

const FIXED_PER_DAY = 5.5 / 30;
const days = ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'];

const fixture = (overrides: Partial<CostCentreReport> = {}): CostCentreReport => ({
  generatedAt: '2026-10-21T12:00:00.000Z',
  range: { from: '2026-10-15T00:00:00.000Z', to: '2026-10-21T12:00:00.000Z', days: 7 },
  totals: {
    costUsd: 1.6581,
    prevCostUsd: 1.8074,
    aiProviderUsd: 0.15,
    aiBillableUsd: 0.18,
    aiMarginUsd: 0.03,
    revenueMrrUsd: 51.98,
    creditRevenueUsd: 10,
    users: 4,
    activeUsers: 4,
    costPerActiveUserUsd: 0.4145
  },
  daily: days.map((day) => ({
    day,
    ai: day === '2026-10-16' ? 0.1 : day === '2026-10-20' ? 0.05 : 0,
    email: day === '2026-10-20' ? 0.0007 : 0,
    containers: day === '2026-10-18' ? 0.112 : 0,
    connectors: 0,
    fixed: FIXED_PER_DAY
  })),
  categories: [
    { id: 'ai', label: 'AI providers', usd: 0.15, source: 'measured', note: '2 settled platform calls.' },
    { id: 'containers', label: 'Code Studio sandbox', usd: 0.2241, source: 'estimated', note: '4 runs.' },
    { id: 'connectors', label: 'Data connectors', usd: 0, source: 'measured', note: '58 upstream calls.' },
    { id: 'email', label: 'Email sending', usd: 0.0007, source: 'measured', note: '3 emails sent.' },
    { id: 'fixed', label: 'Fixed plans', usd: 1.2833, source: 'fixed', note: '$5.50/mo amortized.' }
  ],
  ai: {
    byModel: [
      { provider: 'openrouter', model: 'model-x', events: 2, providerUsd: 0.1, billableUsd: 0.13, byok: 1, byokUsd: 0.4 },
      { provider: 'openrouter', model: 'model-y', events: 1, providerUsd: 0.05, billableUsd: 0.05, byok: 0, byokUsd: 0 }
    ],
    byOperation: [{ operation: 'text.panel_breakdown', events: 1, providerUsd: 0.1 }],
    topUsers: [{ userId: 'u1', email: 'one@example.com', events: 2, providerUsd: 0.1 }],
    byokEvents: 1,
    byokProviderUsd: 0.4
  },
  connectors: [
    { provider: 'tavily', calls: 55, errors: 1, blocked: 2, monthlyBudget: 1050, pctOfBudget: 22.4, peakDayPct: 100, usd: 0 },
    { provider: 'example.com', calls: 3, errors: 0, blocked: 0, monthlyBudget: null, pctOfBudget: null, peakDayPct: null, usd: 0 }
  ],
  email: { sent: 3, failed: 1, monthToDate: 3002, freeMonthly: 3000, usd: 0.0007 },
  containers: { runs: 4, awakeHours: 2, usd: 0.2241, note: 'Estimated.' },
  fixed: [
    { service: 'Cloudflare Workers', plan: 'Workers Paid', usdMonth: 5, note: 'Flat plan fee.', source: 'fixed' },
    { service: 'Backend container', plan: 'basic', usdMonth: 0.5, note: 'Estimate.', source: 'estimated' }
  ],
  revenue: {
    byTier: [
      { tier: 'studio', subscribers: 1, priceUsd: 39.99, mrrUsd: 39.99, comped: 0 },
      { tier: 'creator', subscribers: 1, priceUsd: 11.99, mrrUsd: 11.99, comped: 0 },
      { tier: 'pro', subscribers: 0, priceUsd: 49, mrrUsd: 0, comped: 1 }
    ],
    creditPurchasesUsd: 10
  },
  products: [
    { id: 'comic', label: 'Comic Studio', costUsd: 0.1, requests: 2, users: 1, revenueUsd: null, note: 'AI calls.', verdict: '$0.10 platform AI for 2 requests.' },
    { id: 'chat', label: 'Chat & Assistant', costUsd: 0.05, requests: 40, users: 3, revenueUsd: null, note: 'Monthly counter.', verdict: '$0.05 for 40 requests.' },
    { id: 'stream', label: 'Stream Studio & Baby monitor', costUsd: 0, requests: 0, users: 2, revenueUsd: null, note: 'Infra only.', verdict: 'No metered cost.' },
    { id: 'code', label: 'Code Studio sandbox', costUsd: 0.2241, requests: 4, users: 2, revenueUsd: null, note: 'Estimated.', verdict: '$0.22 for 4 runs — retiring it saves ~$0.96/mo.' }
  ],
  cloudflare: { configured: false },
  notes: ['Code Studio sandbox $ is an estimate at list price.'],
  ...overrides
});

const emptyAiFixture = (): CostCentreReport => {
  const base = fixture();
  return {
    ...base,
    totals: { ...base.totals, aiProviderUsd: 0, aiBillableUsd: 0, aiMarginUsd: 0 },
    ai: { byModel: [], byOperation: [], topUsers: [], byokEvents: 0, byokProviderUsd: 0 },
    notes: ['No AI spend recorded in this period.']
  };
};

const dataRowNames = (table: HTMLElement) =>
  within(table)
    .getAllByRole('row')
    .slice(1) // header
    .map((row) => within(row).getAllByRole('cell')[0].textContent || '');

beforeEach(() => {
  getCostCentre.mockReset();
  window.localStorage.clear();
});

describe('CostCentre', () => {
  it('renders KPI values from the report', async () => {
    getCostCentre.mockResolvedValue(fixture());
    render(<CostCentre />);

    const total = await screen.findByTestId('kpi-total');
    expect(within(total).getByText('$1.66')).toBeInTheDocument();
    expect(within(total).getByText('-8.3%')).toBeInTheDocument(); // cost fell vs the prior period
    expect(within(screen.getByTestId('kpi-ai')).getByText('$0.15')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-ai')).getByText(/Billable \$0\.18 · margin \$0\.03/)).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-revenue')).getByText('$51.98')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-per-user')).getByText('$0.41')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-per-user')).getByText('4 active of 4 users')).toBeInTheDocument();
    expect(getCostCentre).toHaveBeenCalledWith(30, expect.objectContaining({ fresh: false }));
  });

  it('draws the stacked daily chart with a legend and per-day tooltip on focus', async () => {
    getCostCentre.mockResolvedValue(fixture());
    render(<CostCentre />);

    const chart = await screen.findByRole('img', { name: /daily cost by category over 7 days/i });
    expect(chart.querySelectorAll('svg path, svg rect').length).toBeGreaterThan(7);
    expect(screen.getByRole('list', { name: 'Cost categories' })).toHaveTextContent('AI providers');

    fireEvent.focus(chart); // keyboard users get the same tooltip as hover (last day first)
    expect(within(chart).getByRole('status')).toHaveTextContent('Total');
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    expect(within(chart).getByRole('status')).toHaveTextContent('$0.05');
  });

  it('sorts a table by column click', async () => {
    getCostCentre.mockResolvedValue(fixture());
    render(<CostCentre />);

    const table = await screen.findByRole('table', { name: 'Products cost-benefit' });
    expect(dataRowNames(table)[0]).toContain('Comic Studio'); // server order
    fireEvent.click(within(table).getByRole('button', { name: 'Cost' }));
    expect(dataRowNames(table)[0]).toContain('Code Studio sandbox'); // numbers sort high → low first
    fireEvent.click(within(table).getByRole('button', { name: 'Cost' }));
    expect(dataRowNames(table)[0]).toContain('Stream Studio');
    expect(within(table).getByRole('columnheader', { name: 'Cost' })).toHaveAttribute('aria-sort', 'ascending');
  });

  it('says plainly when no AI spend was recorded', async () => {
    getCostCentre.mockResolvedValue(emptyAiFixture());
    render(<CostCentre />);

    const ai = await screen.findByTestId('kpi-ai');
    expect(within(ai).getByText('$0')).toBeInTheDocument();
    expect(within(ai).getByText('No AI spend recorded in this period.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'AI' }));
    const table = screen.getByRole('table', { name: 'AI usage by model' });
    expect(within(table).getByText('No AI spend recorded in this period.')).toBeInTheDocument();
  });

  it('shows the Cloudflare setup card when analytics are not configured', async () => {
    getCostCentre.mockResolvedValue(fixture());
    render(<CostCentre />);
    expect(await screen.findByText('Live Cloudflare usage')).toBeInTheDocument();
    expect(screen.getByText('CF_ANALYTICS_API_TOKEN')).toBeInTheDocument();
    expect(screen.getByText('CLOUDFLARE_ACCOUNT_ID')).toBeInTheDocument();
  });

  it('shows an error state with a working retry', async () => {
    getCostCentre.mockRejectedValueOnce(new Error('Admin access required')).mockResolvedValueOnce(fixture());
    render(<CostCentre />);

    expect(await screen.findByText("Couldn't load the cost report")).toBeInTheDocument();
    expect(screen.getByText('Admin access required')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('kpi-total')).toBeInTheDocument();
    expect(getCostCentre).toHaveBeenLastCalledWith(30, expect.objectContaining({ fresh: true }));
  });

  it('refetches when the range changes and remembers the choice', async () => {
    getCostCentre.mockResolvedValue(fixture());
    render(<CostCentre />);
    await screen.findByTestId('kpi-total');

    fireEvent.click(screen.getByRole('button', { name: '90d' }));
    expect(getCostCentre).toHaveBeenLastCalledWith(90, expect.objectContaining({ fresh: false }));
    expect(window.localStorage.getItem('ds.admin.costs.days')).toBe('90');
  });
});
