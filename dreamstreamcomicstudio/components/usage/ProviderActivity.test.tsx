import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountProviderUsageReport } from '../../shared/accountProviderUsage';
import type { ProviderBalanceReport } from '../../shared/providerBalances';
import { checkPersonalProviderBalance, fetchAccountProviderUsage } from '../../services/accountProviderUsage';
import { PersonalProviderBalance, ProviderActivityPanel, useProviderActivity } from './ProviderActivity';
import { ProviderReading } from './ProviderReading';

vi.mock('../../services/accountProviderUsage', () => ({ fetchAccountProviderUsage: vi.fn(), checkPersonalProviderBalance: vi.fn() }));
const check = vi.mocked(checkPersonalProviderBalance);
const fetchUsage = vi.mocked(fetchAccountProviderUsage);
const report: AccountProviderUsageReport = {
  from: '2026-11-01T00:00:00Z', to: '2026-11-23T12:00:00Z', generatedAt: '2026-11-23T12:00:00Z',
  providers: [{ provider: 'deepseek', modelRequests: 8, byokRequests: 6, platformRequests: 2, connectorCalls: 11, connectorErrors: 1, connectorBlocked: 2, estimatedByokUsd: 0.21, reportedByokUsd: 0.4, unpricedByokRequests: 3 }],
  sources: { models: 'available', connectors: 'available', balances: 'available' }, balanceReports: []
};
const saved: ProviderBalanceReport = { provider: 'deepseek', status: 'reported', checkedAt: Date.UTC(2026, 0, 1), accountBalances: [{ currency: 'USD', remaining: 0 }, { currency: 'CNY', remaining: 7.67 }], keyQuotaUsd: null };
const props = { ownerId: 'alice', provider: 'deepseek' as const, enabled: true, hasKey: true, scope: {}, onSaved: vi.fn() };
afterEach(() => vi.clearAllMocks());

describe('provider account activity and limits', () => {
  it('distinguishes funding sources, recorded and estimated personal spend, unpriced calls, and blocked connectors', () => {
    render(<ProviderActivityPanel report={report} status="ready" refresh={vi.fn()} />);
    expect(screen.getByText(/6 on your keys · 2 on DreamStream/)).toHaveTextContent('Provider-reported cost on your keys USD');
    expect(screen.getByText(/Estimated cost on your keys/)).toHaveTextContent('Cost unavailable for 3 personal requests');
    expect(screen.getByText(/11 connector calls sent/)).toHaveTextContent('(1 failed) · 2 blocked before sending');
  });

  it('has distinct empty, inaccessible and previous activity states', () => {
    const { rerender } = render(<ProviderActivityPanel report={null} status="unavailable" refresh={vi.fn()} />);
    expect(screen.getByText(/activity is temporarily unavailable/)).toBeInTheDocument();
    rerender(<ProviderActivityPanel report={{ ...report, providers: [] }} status="ready" refresh={vi.fn()} />);
    expect(screen.getByText('No activity recorded this month.')).toBeInTheDocument();
    rerender(<ProviderActivityPanel report={{ ...report, providers: [], sources: { models: 'unavailable', connectors: 'available', balances: 'unavailable' } }} status="unavailable" refresh={vi.fn()} />);
    expect(screen.queryByText('No activity recorded this month.')).toBeNull();
    expect(screen.getByText('Model activity unavailable for this report.')).toBeInTheDocument();
    expect(screen.getByText(/Saved provider readings are temporarily unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/Showing your last activity report/)).toBeInTheDocument();
  });

  it('shows the original reading time and preserves separate currencies, including zero, on refresh failure', async () => {
    check.mockRejectedValueOnce(new Error('sensitive-upstream-text'));
    render(<PersonalProviderBalance {...props} saved={saved} />);
    expect(check).not.toHaveBeenCalled();
    expect(screen.getByText(/Previous provider reading/)).toBeInTheDocument();
    expect(screen.getByText(/USD\s*0\.00/)).toBeInTheDocument();
    expect(screen.getByText(/CNY\s*7\.67/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check provider' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Couldn’t refresh');
    expect(screen.queryByText(/sensitive-upstream-text/)).toBeNull();
    expect(screen.getByText(/CNY\s*7\.67/)).toBeInTheDocument();
  });

  it('does not invent a balance for a key quota or a subscription window', () => {
    render(<ProviderReading report={{ ...saved, accountBalances: null, keyQuotaUsd: { usage: 0, limit: null, remaining: 0.005 }, planQuotas: [{ label: '5-hour window', remainingPercent: 68 }] }} />);
    expect(screen.queryByText(/Account balance/)).toBeNull();
    expect(screen.getByText('Key budget remaining')).toBeInTheDocument();
    expect(screen.getByText('Lifetime key usage')).toBeInTheDocument();
    expect(screen.getByText('68% remaining')).toBeInTheDocument();
    expect(screen.queryByText('Key spending limit')).toBeNull();
  });

  it('offers provider billing for dashboard-only APIs and requests no absent or disabled credential', () => {
    const { rerender } = render(<PersonalProviderBalance {...props} provider="openai" />);
    expect(screen.getByRole('link', { name: 'Open provider dashboard' })).toHaveAttribute('href', 'https://platform.openai.com/settings/organization/billing/overview');
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<PersonalProviderBalance {...props} hasKey={false} />);
    expect(screen.getByText(/Add a personal API key below/)).toBeInTheDocument();
    rerender(<PersonalProviderBalance {...props} enabled={false} />);
    expect(screen.getByText(/Enable this provider/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it('ignores a late live response after rotating credentials; new readings show if persistence is down', async () => {
    let finish!: (result: { report: ProviderBalanceReport; saved: boolean }) => void;
    check.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { rerender } = render(<PersonalProviderBalance {...props} />);
    fireEvent.click(screen.getByRole('button'));
    const next = { ...props, scope: {} };
    rerender(<PersonalProviderBalance {...next} />);
    await act(async () => { finish({ report: saved, saved: true }); });
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(screen.queryByText(/CNY/)).toBeNull();
    check.mockResolvedValueOnce({ report: saved, saved: false });
    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByRole('status')).toHaveTextContent('could not be saved');
    expect(screen.getByText(/CNY\s*7\.67/)).toBeInTheDocument();
  });

  it('drops old user balances immediately on owner changes and ignores their in-flight request', async () => {
    let resolveOld!: (r: AccountProviderUsageReport) => void;
    fetchUsage.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
    fetchUsage.mockResolvedValueOnce({ ...report, providers: [] });
    const Harness = ({ owner }: { owner: string }) => <ProviderActivityPanel {...useProviderActivity(owner, 'keys')} />;
    const { rerender } = render(<Harness owner="alice" />);
    rerender(<Harness owner="bob" />);
    expect(await screen.findByText('No activity recorded this month.')).toBeInTheDocument();
    await act(async () => { resolveOld(report); });
    expect(screen.queryByText(/6 on your keys/)).toBeNull();
    expect(fetchUsage.mock.calls[0][1].aborted).toBe(true);
  });
});
