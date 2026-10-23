import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CostCentreReport, StreamCostSection } from '../../../shared/types/costCentre';

const getCostCentre = vi.hoisted(() => vi.fn());
vi.mock('../../../services/adminCosts', () => ({ getCostCentre }));

import { CostCentre } from '../CostCentre';
import { StreamCard, fmtUnits } from './StreamCard';

const stream = (over: Partial<StreamCostSection> = {}): StreamCostSection => ({
  sources: { graphql: true, analyticsEngine: true },
  month: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-21T12:00:00.000Z', daysElapsed: 20.5, daysInMonth: 31 },
  marginalUsd: 0,
  listValueUsd: 0.0412,
  prevListValueUsd: 0.03,
  perNurseryMonthUsd: 0.21,
  perBroadcastHourUsd: 0.011,
  freePathShare: 0.9,
  activeNurseries: 2,
  events: 1,
  features: [
    { id: 'monitor', label: 'Baby monitor', units: [{ label: 'Durable Object requests', value: 27_000, unit: 'requests' }], listValueUsd: 0.0049, source: 'estimated', note: 'Server relay frames.' },
    { id: 'drive_save', label: 'Drive saves', units: [], listValueUsd: 0, source: 'estimated' },
    { id: 'push', label: 'Push alerts', units: [], listValueUsd: 0, source: 'fixed' }
  ],
  pathMix: [
    { kind: 'monitor', label: 'Baby monitor', minutes: { lan: 740, direct: 400, turn: 0, server: 60 } },
    { kind: 'call', label: 'Family & direct calls', minutes: { lan: 0, direct: 30, turn: 30, server: 0 } },
    { kind: 'meeting', label: 'Meetings', minutes: { lan: 0, direct: 0, turn: 0, server: 0 } }
  ],
  top: {
    nurseries: [{ scope: 'nursery', id: 'n-1', label: 'Aria’s room', owner: 'mom@example.com', listValueUsd: 0.005, serverMinutes: 60, turnGb: 0, minutes: 1200 }],
    accounts: [{ scope: 'account', id: 'u-1', label: 'caller@example.com', owner: null, listValueUsd: 0.017, serverMinutes: 0, turnGb: 0.34, minutes: 60 }],
    events: []
  },
  headroom: [
    { id: 'turnGb', label: 'TURN relay egress', unit: 'GB', used: 40, allowance: 1000, projected: 60.5, projectedPct: 6.1, crossesOn: null, overageUsd: 0, source: 'measured', note: 'Account-wide.' },
    { id: 'doRowsWritten', label: 'Durable Object rows written', unit: 'rows', used: 40_000_000, allowance: 50_000_000, projected: 60_000_000, projectedPct: 120, crossesOn: '2026-10-26', overageUsd: 0, source: 'measured' }
  ],
  projection: { perNurseryMonthUsd: 0.21, at1k: 210, at10k: 2100, source: 'estimated' },
  kpis: { activeNurseryDays: 3, doRequests: 2000, rowsWritten: 6000, gbSeconds: 12, serverShare: 0.05, source: 'measured', note: 'MonitorRoom namespace.' },
  alerts: [
    { id: 'free_tier:doRowsWritten', severity: 'critical', title: 'Durable Object rows written: free tier will run out this month', cause: '40,000,000 used so far.' },
    { id: 'turn_spend', severity: 'warning', title: 'TURN on course for $10.85 at list price this month', cause: 'Still inside the free 1,000 GB.' }
  ],
  pricesCheckedOn: '2026-10-22',
  notes: ['Estimates use list prices checked 2026-10-22.', 'Free allowances are account-wide.'],
  errors: [],
  ...over
});

describe('StreamCard', () => {
  it('shows marginal $ next to the list value, labelled as estimates and never as a charge', () => {
    render(<StreamCard stream={stream()} days={30} />);
    const marginal = screen.getByTestId('stream-kpi-marginal');
    expect(within(marginal).getByText('$0')).toBeInTheDocument();
    expect(within(marginal).getByText(/Inside the free allowances/)).toBeInTheDocument();
    const list = screen.getByTestId('stream-kpi-list');
    expect(within(list).getByText('List value · 30d (est.)')).toBeInTheDocument();
    expect(within(list).getByText('$0.04')).toBeInTheDocument();
    expect(within(list).getByText('+37%')).toBeInTheDocument();
    expect(within(screen.getByTestId('stream-kpi-free')).getByText('90.0%')).toBeInTheDocument();
    expect(screen.queryByText(/charged to you|you owe|your bill/i)).toBeNull();
  });

  it('lists alerts with severity words and icons, most severe first', () => {
    render(<StreamCard stream={stream()} days={30} />);
    const alerts = within(screen.getByTestId('stream-alerts')).getAllByRole('listitem');
    expect(alerts[0]).toHaveTextContent('free tier will run out this month · critical');
    expect(alerts[1]).toHaveTextContent('TURN on course for $10.85 at list price this month · warning');
  });

  it('shows account-wide headroom with month-end projection and the day it crosses', () => {
    render(<StreamCard stream={stream()} days={30} />);
    const table = screen.getByRole('table', { name: 'Stream Studio free-tier headroom' });
    expect(within(table).getByText('TURN relay egress')).toBeInTheDocument();
    expect(within(table).getByText('60,000,000 rows')).toBeInTheDocument();
    expect(within(table).getByText('not this month')).toBeInTheDocument();
    expect(within(table).getAllByRole('meter')).toHaveLength(2);
    expect(within(table).getAllByText('Measured')).toHaveLength(2);
  });

  it('draws the path mix with words, not color alone', () => {
    render(<StreamCard stream={stream()} days={30} />);
    const mix = screen.getByTestId('stream-path-mix');
    expect(within(mix).getByRole('list', { name: 'Path legend' })).toHaveTextContent('Home Wi-Fi· freeDirect· freeThrough our relayThrough our server');
    expect(within(mix).getByRole('img', { name: /Baby monitor: Home Wi-Fi 62%, Direct 33%, Through our server 5%/ })).toBeInTheDocument();
    expect(within(mix).getByRole('img', { name: 'Meetings: no minutes' })).toBeInTheDocument();
  });

  it('switches top consumers between nurseries, accounts and events', () => {
    render(<StreamCard stream={stream()} days={30} />);
    expect(screen.getByRole('table', { name: 'Top nurseries by Stream Studio usage' })).toHaveTextContent('Aria’s room');
    fireEvent.click(screen.getByRole('button', { name: 'Accounts' }));
    expect(screen.getByRole('table', { name: 'Top accounts by Stream Studio usage' })).toHaveTextContent('caller@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Events' }));
    expect(screen.getByText('No events used anything in this period.')).toBeInTheDocument();
  });

  it('shows the per-nursery-day KPIs against the ADR 0006 budgets, and the scale projection', () => {
    render(<StreamCard stream={stream()} days={30} />);
    const kpis = screen.getByTestId('stream-kpis');
    expect(kpis).toHaveTextContent('6,000 rows');
    expect(within(kpis).getAllByLabelText('over budget')).toHaveLength(2); // 2,000 requests > 1,000 · 6,000 rows > 1,800 · 12 GB-s fine
    expect(screen.getByTestId('stream-projection')).toHaveTextContent('1k nurseries ≈ $210.00/mo · 10k ≈ $2,100/mo');
  });

  it('shows the setup steps when nothing is measured yet', () => {
    render(<StreamCard stream={stream({ sources: { graphql: false, analyticsEngine: false } })} days={30} />);
    expect(screen.getByText('Stream Studio costs — not measured yet')).toBeInTheDocument();
    expect(screen.getByText('CF_ANALYTICS_API_TOKEN')).toBeInTheDocument();
    expect(screen.getByText(/budget alert/)).toBeInTheDocument();
    expect(screen.queryByTestId('stream-card')).toBeNull();
  });

  it('says Cloudflare didn’t answer (with why) when the token is set but every dataset failed — never "connect it" or "fits the $5 plan"', () => {
    render(<StreamCard stream={stream({ sources: { graphql: false, analyticsEngine: false }, configured: true, errors: ['TURN egress: HTTP 403: Authentication error'] })} days={30} />);
    expect(screen.getByText('Stream Studio costs — Cloudflare analytics didn’t answer')).toBeInTheDocument();
    expect(within(screen.getByTestId('stream-no-answer')).getByText('TURN egress: HTTP 403: Authentication error')).toBeInTheDocument();
    expect(screen.queryByText('Stream Studio costs — not measured yet')).toBeNull();
    expect(screen.queryByText(/Workers Paid plan/)).toBeNull();
    expect(screen.queryByTestId('stream-card')).toBeNull();
  });

  it('never claims what Stream Studio costs before anything is measured', () => {
    render(<StreamCard stream={stream({ sources: { graphql: false, analyticsEngine: false } })} days={30} />);
    expect(screen.queryByText(/fits inside/i)).toBeNull();
  });

  it('labels a monitor bar that only has our-server minutes, instead of showing it as a share', () => {
    const mix = stream().pathMix.map((m) => (m.kind === 'monitor' ? { ...m, minutes: { lan: 0, direct: 0, turn: 0, server: 60 } } : m));
    render(<StreamCard stream={stream({ pathMix: mix, freePathShare: 0.5 })} days={30} />);
    expect(screen.getByTestId('stream-monitor-paths-note')).toHaveTextContent('only minutes through our server are measured');
    expect(within(screen.getByTestId('stream-kpi-free')).getByText(/Calls and meetings only/)).toBeInTheDocument();
  });

  it('says which datasets failed and still shows the rest', () => {
    render(<StreamCard stream={stream({ errors: ['TURN egress: timed out after 8s'] })} days={7} />);
    expect(screen.getByText('TURN egress: timed out after 8s')).toBeInTheDocument();
    expect(screen.getByTestId('stream-kpi-marginal')).toBeInTheDocument();
  });

  it('formats units sensibly', () => {
    expect(fmtUnits(27_000.4, 'requests')).toBe('27,000 requests');
    expect(fmtUnits(0.3375, 'GB')).toBe('0.34 GB');
    expect(fmtUnits(68.99, 'GB-s')).toBe('69 GB-s');
  });
});

describe('CostCentre — Stream Studio tab', () => {
  beforeEach(() => {
    getCostCentre.mockReset();
    window.localStorage.clear();
  });

  const report = (): CostCentreReport =>
    ({
      generatedAt: '2026-10-21T12:00:00.000Z',
      range: { from: '2026-09-22T00:00:00.000Z', to: '2026-10-21T12:00:00.000Z', days: 30 },
      totals: { costUsd: 5.5, prevCostUsd: 5.5, aiProviderUsd: 0, aiBillableUsd: 0, aiMarginUsd: 0, revenueMrrUsd: 0, creditRevenueUsd: 0, users: 1, activeUsers: 1, costPerActiveUserUsd: 5.5 },
      daily: [{ day: '2026-10-21', ai: 0, email: 0, containers: 0, connectors: 0, fixed: 0.18 }],
      categories: [{ id: 'fixed', label: 'Fixed plans', usd: 5.5, source: 'fixed', note: 'Plans.' }],
      ai: { byModel: [], byOperation: [], topUsers: [] },
      connectors: [],
      email: { sent: 0, failed: 0, monthToDate: 0, freeMonthly: 3000, usd: 0 },
      containers: { runs: 0, awakeHours: 0, usd: 0, note: '' },
      fixed: [],
      revenue: { byTier: [], creditPurchasesUsd: 0 },
      products: [{ id: 'stream', label: 'Stream Studio & Baby monitor', costUsd: 0, listValueUsd: 0.0412, requests: 10, users: 1, revenueUsd: null, note: 'Infra.', verdict: '$0 marginal (inside free tiers) · $0.04 at list price, est.' }],
      cloudflare: { configured: false },
      notes: [],
      stream: stream()
    }) as CostCentreReport;

  it('shows the list value beside the marginal cost in the Products table', async () => {
    getCostCentre.mockResolvedValue(report());
    render(<CostCentre />);
    const table = await screen.findByRole('table', { name: 'Products cost-benefit' });
    expect(within(table).getByText('$0.04 est.')).toBeInTheDocument();
  });

  it('shows the badge when a dataset couldn’t be measured, even with no alert firing', async () => {
    getCostCentre.mockResolvedValue({ ...report(), stream: stream({ alerts: [], errors: ['TURN egress: timed out after 8s'] }) });
    render(<CostCentre />);
    const badge = await screen.findByTestId('stream-alert-badge');
    expect(badge).toHaveTextContent('Stream Studio: couldn’t measure 1 dataset');
  });

  it('opens the Stream Studio tab from the alert badge', async () => {
    getCostCentre.mockResolvedValue(report());
    render(<CostCentre />);
    const badge = await screen.findByTestId('stream-alert-badge');
    expect(badge).toHaveTextContent('2 Stream Studio alerts');
    fireEvent.click(badge);
    expect(await screen.findByTestId('stream-card')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stream Studio' })).toHaveAttribute('aria-pressed', 'true');
  });
});
