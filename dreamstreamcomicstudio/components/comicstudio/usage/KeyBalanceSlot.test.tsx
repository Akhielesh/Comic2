// The studio header's own-key balance (credit-safety.md MN-3): who sees it, when it reads, what it says, and that it
// carries no colour beside money. Synthetic owner, key and readings.
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities';
import type { ProviderBalanceReport } from '../../../shared/providerBalances';
import { checkPersonalProviderBalance } from '../../../services/accountProviderUsage';
import { getProviderKeyValue } from '../../../services/apiKeys';
import { __resetKeyBalanceForTests, seedKeyBalance } from '../../../services/keyBalance';
import { makeSampleDoc } from '../conversation/testing/fixtures';
import { KeyBalanceSlot } from './KeyBalanceSlot';

const auth = vi.hoisted(() => ({ user: { id: 'owner-synthetic' } as { id: string } | null }));
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => ({ user: auth.user }) }));
vi.mock('../../../services/accountProviderUsage', () => ({ checkPersonalProviderBalance: vi.fn() }));
vi.mock('../../../services/apiKeys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/apiKeys')>()),
  getProviderKeyValue: vi.fn(),
  getAccountKeyMeta: vi.fn(() => [])
}));

const check = vi.mocked(checkPersonalProviderBalance);
const OWN: StudioCaps = { ...DEFAULT_CAPS, byok: true };
const GOVERNED: StudioCaps = { ...DEFAULT_CAPS, byok: false, usage: { governed: true, pctLeft: 40, exhausted: false, pctPerStandardPage: 1 } };
const reading = (remaining: number | null, checkedAt = Date.now()): ProviderBalanceReport => ({
  provider: 'openrouter', status: 'reported', checkedAt, accountBalances: null, keyQuotaUsd: { limit: 20, remaining, usage: 1 }
});
const idle = () => makeSampleDoc({ style: { ...makeSampleDoc().style, options: [] } });
const drawing = (): ComicDoc => {
  const doc = idle();
  return { ...doc, pages: doc.pages.map((p, i) => (i === 1 ? { ...p, render: { ...p.render, status: 'rendering' } } : p)) };
};
const slot = (caps: StudioCaps, doc: ComicDoc = idle(), compact = false) => <KeyBalanceSlot studio={{ doc, caps }} compact={compact} />;

beforeEach(() => {
  __resetKeyBalanceForTests();
  auth.user = { id: 'owner-synthetic' };
  vi.mocked(getProviderKeyValue).mockImplementation((p) => (p === 'openrouter' ? 'sk-or-v1-synthetic-owner-key' : null));
  check.mockResolvedValue({ report: reading(12.4), saved: true });
});
afterEach(() => vi.clearAllMocks());

describe('the studio header balance', () => {
  it('shows what the own key has left and when it was read, after reading it once when the studio opens', async () => {
    render(slot(OWN));
    expect(await screen.findByText('$12.40 left')).toBeInTheDocument();
    expect(screen.getByText('· just now')).toBeInTheDocument();
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith('owner-synthetic', 'openrouter', expect.any(AbortSignal));
    expect(screen.getByRole('button', { name: 'OpenRouter balance: $12.40 left, read just now. Read it again.' })).toBeInTheDocument();
  });

  it('a fresh reading is shown without a request; a stale one is read again when the studio opens', async () => {
    seedKeyBalance(reading(3));
    const { unmount } = render(slot(OWN));
    expect(screen.getByText('$3.00 left')).toBeInTheDocument();
    expect(check).not.toHaveBeenCalled();
    unmount();
    __resetKeyBalanceForTests();
    seedKeyBalance(reading(3, Date.now() - 20 * 60_000));
    render(slot(OWN));
    expect(screen.getByText('· 20 min ago')).toBeInTheDocument();
    expect(await screen.findByText('$12.40 left')).toBeInTheDocument();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('a tap reads it again and says what it found', async () => {
    seedKeyBalance(reading(3));
    render(slot(OWN));
    check.mockResolvedValueOnce({ report: reading(2.5), saved: true });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /OpenRouter balance/ }));
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('$2.50 left')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Balance read: $2.50 left.');
  });

  it('reads it again once a drawing run settles, never while it draws and never on a timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      seedKeyBalance(reading(3));
      const { rerender } = render(slot(OWN, drawing()));
      await act(async () => {
        vi.advanceTimersByTime(60 * 60_000);
      });
      expect(check).not.toHaveBeenCalled();
      await act(async () => {
        rerender(slot(OWN, idle()));
      });
      expect(check).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('phones show the amount alone; the full sentence stays in the label', async () => {
    seedKeyBalance(reading(12.4));
    render(slot(OWN, idle(), true));
    expect(screen.getByText('$12.40')).toBeInTheDocument();
    expect(screen.queryByText(/· just now/)).toBeNull();
    expect(screen.getByRole('button', { name: /\$12\.40 left, read just now/ })).toBeInTheDocument();
  });

  it('governed people, signed-out views and keys with no reported balance show nothing (no request for the governed)', async () => {
    const { container, rerender } = render(slot(GOVERNED));
    expect(container.querySelector('[data-key-balance]')).toBeNull();
    expect(check).not.toHaveBeenCalled();
    auth.user = null;
    rerender(slot(OWN));
    expect(container.querySelector('[data-key-balance]')).toBeNull();
    auth.user = { id: 'owner-synthetic' };
    check.mockResolvedValue({ report: reading(null), saved: true });
    __resetKeyBalanceForTests();
    rerender(slot({ ...OWN }));
    await act(async () => undefined);
    expect(container.querySelector('[data-key-balance]')).toBeNull();
  });

  it('carries no colour: ink and muted only beside the money', async () => {
    seedKeyBalance(reading(0));
    render(slot(OWN));
    const button = screen.getByRole('button', { name: /OpenRouter balance/ });
    expect(button.textContent).toContain('$0.00 left');
    expect(button.outerHTML).not.toMatch(/--ds-(?:hue|spark|accent|success|warning|danger|art)|STATUS|text-(?:red|amber|green)-/);
  });
});
