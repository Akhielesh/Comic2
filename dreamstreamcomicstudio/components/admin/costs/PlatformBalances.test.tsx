import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformBalances } from './PlatformBalances';

const api = vi.hoisted(() => ({ getPlatformBalances: vi.fn(), refreshPlatformBalance: vi.fn(), ownerId: 'operator-1' }));
vi.mock('../../../services/adminProviderBalances', () => api);
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: api.ownerId } }) }));
const saved = { provider: 'openrouter', status: 'reported', accountBalances: [{ currency: 'USD', remaining: 78 }], keyQuotaUsd: null, checkedAt: Date.now() - 86400000 };
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Platform provider balances and quotas' }));
beforeEach(() => { vi.clearAllMocks(); api.ownerId = 'operator-1'; });
afterEach(() => vi.useRealTimers());

describe('Cost Centre platform readings', () => {
  it('loads only saved data on opening and refreshes exactly the operator-selected provider', async () => {
    api.getPlatformBalances.mockResolvedValue({ available: true, balanceReports: [saved] });
    api.refreshPlatformBalance.mockResolvedValue({ report: { ...saved, provider: 'deepseek', checkedAt: Date.now(),
      accountBalances: [{ currency: 'CNY', remaining: 12 }] }, saved: false });
    render(<PlatformBalances />);
    expect(api.getPlatformBalances).not.toHaveBeenCalled();
    open();
    expect(await screen.findByText('Account balance (USD)')).toBeInTheDocument();
    expect(screen.getByText(/Previous provider reading/)).toBeInTheDocument();
    expect(api.refreshPlatformBalance).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Platform provider'), { target: { value: 'deepseek' } });
    expect(screen.queryByText('Account balance (USD)')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check provider' }));
    expect(await screen.findByText('Account balance (CNY)')).toBeInTheDocument();
    expect(screen.getByText(/could not be saved to history/)).toBeInTheDocument();
    expect(api.refreshPlatformBalance).toHaveBeenCalledWith('operator-1', 'deepseek', expect.any(AbortSignal));
  });

  it('shows unavailable and missing credentials honestly and clears the previous amount on removal', async () => {
    api.getPlatformBalances.mockResolvedValue({ available: true, balanceReports: [saved] });
    api.refreshPlatformBalance
      .mockResolvedValueOnce({ report: { ...saved, status: 'unavailable' }, saved: false })
      .mockResolvedValueOnce({ report: { ...saved, status: 'missing' }, saved: false });
    render(<PlatformBalances />); open();
    await screen.findByText('Account balance (USD)');
    fireEvent.click(screen.getByRole('button', { name: 'Check provider' }));
    await screen.findByText(/did not return a current reading/);
    expect(screen.getByText(/Previous provider reading/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check provider' }));
    await screen.findByText(/No platform credential/);
    expect(screen.queryByText('Account balance (USD)')).toBeNull();
  });

  it('drops a prior admin’s values when the account changes', async () => {
    api.getPlatformBalances.mockResolvedValueOnce({ available: true, balanceReports: [saved] })
      .mockResolvedValue({ available: false, balanceReports: [] });
    const view = render(<PlatformBalances />); open();
    await screen.findByText('Account balance (USD)');
    api.ownerId = 'operator-2';
    view.rerender(<PlatformBalances />);
    await waitFor(() => expect(screen.queryByText('Account balance (USD)')).toBeNull());
    expect(await screen.findByText('Saved readings could not be loaded.')).toBeInTheDocument();
  });

  it('rechecks saved observations once after a background provider refresh', async () => {
    vi.useFakeTimers();
    api.getPlatformBalances
      .mockResolvedValueOnce({ available: true, balancesRefreshing: true, balanceReports: [saved] })
      .mockResolvedValue({ available: true, balancesRefreshing: false, balanceReports: [{ ...saved,
        checkedAt: Date.now(), accountBalances: [{ currency: 'USD', remaining: 89 }] }] });
    render(<PlatformBalances />);
    await act(async () => open());
    expect(screen.getByText(/Refreshing saved readings/)).toBeInTheDocument();
    expect(screen.getByText(/USD\s+78\.00/)).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(12_000));
    expect(screen.getByText(/USD\s+89\.00/)).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(api.getPlatformBalances).toHaveBeenCalledTimes(2);
    expect(api.refreshPlatformBalance).not.toHaveBeenCalled();
  });
});
