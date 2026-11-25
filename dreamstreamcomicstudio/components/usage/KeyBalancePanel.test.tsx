// Settings → API keys: the own OpenRouter key's balance, shown first (credit-safety.md MN-3). Synthetic readings.
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderBalanceReport } from '../../shared/providerBalances';
import { checkPersonalProviderBalance } from '../../services/accountProviderUsage';
import { getProviderKeyValue } from '../../services/apiKeys';
import { __resetKeyBalanceForTests, seedKeyBalance } from '../../services/keyBalance';
import { KeyBalancePanel } from './KeyBalancePanel';

vi.mock('../../services/accountProviderUsage', () => ({ checkPersonalProviderBalance: vi.fn() }));
vi.mock('../../services/apiKeys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/apiKeys')>()),
  getProviderKeyValue: vi.fn(),
  getAccountKeyMeta: vi.fn(() => [])
}));

const check = vi.mocked(checkPersonalProviderBalance);
const reading = (over: Partial<ProviderBalanceReport> = {}): ProviderBalanceReport => ({
  provider: 'openrouter', status: 'reported', checkedAt: Date.now() - 3 * 60_000, accountBalances: null, keyQuotaUsd: { limit: 20, remaining: 12.4, usage: 7.6 }, ...over
});

beforeEach(() => {
  __resetKeyBalanceForTests();
  vi.mocked(getProviderKeyValue).mockImplementation((p) => (p === 'openrouter' ? 'sk-or-v1-synthetic-owner-key' : null));
});
afterEach(() => vi.clearAllMocks());

describe('the OpenRouter balance in Settings', () => {
  it('shows the figure prominently with when it was read and the key facts, and reads it once when Settings opens', async () => {
    check.mockResolvedValue({ report: reading(), saved: true });
    render(<KeyBalancePanel ownerId="owner-synthetic" />);
    expect(screen.getByText('Reading your balance from OpenRouter…')).toBeInTheDocument();
    expect(await screen.findByText('$12.40')).toBeInTheDocument();
    expect(screen.getByText('left on your OpenRouter key')).toBeInTheDocument();
    expect(screen.getByText('3 min ago')).toBeInTheDocument();
    expect(screen.getByText('Key limit $20.00 · $7.60 used on this key')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Add funds/ })).toHaveAttribute('href', 'https://openrouter.ai/settings/credits');
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('a fresh reading needs no request; Check now reads it again', async () => {
    seedKeyBalance(reading());
    render(<KeyBalancePanel ownerId="owner-synthetic" />);
    expect(screen.getByText('$12.40')).toBeInTheDocument();
    expect(check).not.toHaveBeenCalled();
    check.mockResolvedValue({ report: reading({ checkedAt: Date.now(), keyQuotaUsd: { limit: 20, remaining: 11, usage: 9 } }), saved: true });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Check now/ }));
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('$11.00')).toBeInTheDocument();
    expect(screen.getByText('just now')).toBeInTheDocument();
  });

  it('the smaller of the key limit left and the account credits; an older reading says so', () => {
    seedKeyBalance(reading({ checkedAt: Date.now() - 40 * 60_000, accountBalances: [{ currency: 'USD', remaining: 4.5 }] }));
    render(<KeyBalancePanel ownerId="owner-synthetic" />);
    expect(screen.getByText('$4.50')).toBeInTheDocument();
    expect(screen.getByText(/an older reading/)).toBeInTheDocument();
    expect(screen.getByText(/Account credits \$4\.50/)).toBeInTheDocument();
  });

  it('is honest when OpenRouter shares no balance for the key, or cannot be read', async () => {
    check.mockResolvedValueOnce({ report: reading({ keyQuotaUsd: { limit: null, remaining: null, usage: 2 } }), saved: true });
    const { unmount } = render(<KeyBalancePanel ownerId="owner-synthetic" />);
    expect(await screen.findByText(/shares what a key has left only when the key has a credit limit/)).toBeInTheDocument();
    unmount();
    __resetKeyBalanceForTests();
    check.mockRejectedValueOnce(new Error('offline'));
    render(<KeyBalancePanel ownerId="owner-synthetic" />);
    expect(await screen.findByText(/Couldn’t read the balance just now/)).toBeInTheDocument();
  });

  it('nothing for a person without their own OpenRouter key, and no request', () => {
    vi.mocked(getProviderKeyValue).mockReturnValue(null);
    const { container } = render(<KeyBalancePanel ownerId="owner-synthetic" />);
    expect(container.querySelector('[data-key-balance-panel]')).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it('no colour beside the money', async () => {
    seedKeyBalance(reading());
    const { container } = render(<KeyBalancePanel ownerId="owner-synthetic" />);
    // The DS Button's own invalid-state edge (aria-invalid only) is not colour on the money.
    const markup = container.innerHTML.replace(/aria-\[invalid=true\]:[^\s"]+/g, '');
    expect(markup).not.toMatch(/--ds-(?:hue|spark|success|warning|danger)|text-(?:red|amber|green)-/);
  });
});
