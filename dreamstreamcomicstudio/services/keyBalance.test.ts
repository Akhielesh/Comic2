// The own OpenRouter key's balance store (credit-safety.md MN-3): which credential it follows (never the key), when it
// reads (missing or stale on open, forced on a tap), and what a reading shows. Synthetic keys and readings only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderBalanceReport } from '../shared/providerBalances';
import { checkPersonalProviderBalance } from './accountProviderUsage';
import { getAccountKeyMeta, getProviderKeyValue } from './apiKeys';
import { isProviderEnabled } from './sourceGovernance';
import { __resetKeyBalanceForTests, keyBalanceFor, keyBalanceView, ownKeyScope, readingAge, refreshKeyBalance, seedKeyBalance } from './keyBalance';

vi.mock('./accountProviderUsage', () => ({ checkPersonalProviderBalance: vi.fn() }));
vi.mock('./apiKeys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./apiKeys')>()),
  getProviderKeyValue: vi.fn(),
  getAccountKeyMeta: vi.fn(() => [])
}));
vi.mock('./sourceGovernance', async (importOriginal) => ({ ...(await importOriginal<typeof import('./sourceGovernance')>()), isProviderEnabled: vi.fn(() => true) }));

const check = vi.mocked(checkPersonalProviderBalance);
const KEY = 'sk-or-v1-synthetic-owner-key';
const reading = (remaining: number | null, checkedAt = Date.now(), credits?: number): ProviderBalanceReport => ({
  provider: 'openrouter', status: 'reported', checkedAt,
  accountBalances: credits === undefined ? null : [{ currency: 'USD', remaining: credits }],
  keyQuotaUsd: { limit: 20, remaining, usage: 3 }
});

beforeEach(() => {
  __resetKeyBalanceForTests();
  vi.mocked(getProviderKeyValue).mockReturnValue(KEY);
  vi.mocked(getAccountKeyMeta).mockReturnValue([]);
  vi.mocked(isProviderEnabled).mockReturnValue(true);
});
afterEach(() => vi.clearAllMocks());

describe('which credential the balance follows', () => {
  it('a fingerprint of the active key, the account key suffix, or nothing — never the key itself', () => {
    const scope = ownKeyScope();
    expect(scope).toMatch(/^local:/);
    expect(scope).not.toContain(KEY);
    expect(scope).not.toContain('synthetic');
    vi.mocked(getProviderKeyValue).mockReturnValue(null);
    vi.mocked(getAccountKeyMeta).mockReturnValue([{ provider: 'openrouter', suffix: 'a1b2' } as never]);
    expect(ownKeyScope()).toBe('account:a1b2');
    vi.mocked(getAccountKeyMeta).mockReturnValue([]);
    expect(ownKeyScope()).toBe('');
    vi.mocked(getProviderKeyValue).mockReturnValue(KEY);
    vi.mocked(isProviderEnabled).mockReturnValue(false);
    expect(ownKeyScope()).toBe('');
  });
});

describe('when it reads', () => {
  it('reads when there is no reading, not again while it is fresh, and again on a tap (force)', async () => {
    check.mockResolvedValue({ report: reading(12.4), saved: true });
    await refreshKeyBalance('owner-1');
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith('owner-1', 'openrouter', expect.any(AbortSignal));
    expect(keyBalanceFor(ownKeyScope())).toMatchObject({ state: 'ready', report: { keyQuotaUsd: { remaining: 12.4 } } });
    await refreshKeyBalance('owner-1');
    expect(check).toHaveBeenCalledTimes(1);
    await refreshKeyBalance('owner-1', { force: true });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('reads again when the reading is older than 15 minutes, and shares one request between views', async () => {
    seedKeyBalance(reading(5, Date.now() - 16 * 60_000));
    check.mockResolvedValue({ report: reading(4), saved: true });
    await Promise.all([refreshKeyBalance('owner-1'), refreshKeyBalance('owner-1'), refreshKeyBalance('owner-1', { force: true })]);
    expect(check).toHaveBeenCalledTimes(1);
    expect(keyBalanceFor(ownKeyScope()).report?.keyQuotaUsd?.remaining).toBe(4);
  });

  it('a failed read keeps the previous reading with its own time; no owner or no key reads nothing', async () => {
    const before = reading(7, Date.now() - 20 * 60_000);
    seedKeyBalance(before);
    check.mockRejectedValueOnce(new Error('offline'));
    await refreshKeyBalance('owner-1');
    expect(keyBalanceFor(ownKeyScope())).toMatchObject({ state: 'unavailable', report: before });
    check.mockClear();
    await refreshKeyBalance(undefined);
    vi.mocked(getProviderKeyValue).mockReturnValue(null);
    await refreshKeyBalance('owner-1');
    expect(check).not.toHaveBeenCalled();
  });

  it('a reading that lands after the key changed is not shown for the new key', async () => {
    let finish!: (v: { report: ProviderBalanceReport; saved: boolean }) => void;
    check.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const pending = refreshKeyBalance('owner-1');
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    vi.mocked(getProviderKeyValue).mockReturnValue('sk-or-v1-another-synthetic-key');
    finish({ report: reading(99), saved: true });
    await pending;
    expect(keyBalanceFor(ownKeyScope()).report).toBeNull();
  });
});

describe('what a reading shows', () => {
  it('the smaller of the key limit left and the account credits, in dollars, with when it was read', () => {
    const now = Date.now();
    expect(keyBalanceView(reading(12.4, now), now)).toMatchObject({ amount: '$12.40', age: 'just now', stale: false, spoken: 'OpenRouter balance: $12.40 left, read just now.' });
    expect(keyBalanceView(reading(12.4, now - 5 * 60_000, 3.25), now)).toMatchObject({ amount: '$3.25', age: '5 min ago', spoken: 'OpenRouter balance: $3.25 left, read 5 minutes ago.' });
    expect(keyBalanceView(reading(null, now, 8), now)?.amount).toBe('$8.00');
    expect(keyBalanceView(reading(0, now - 2 * 60 * 60_000), now)).toMatchObject({ amount: '$0.00', age: '2 h ago', stale: true });
  });

  it('is unknown (null) when the provider shared no balance for this key', () => {
    expect(keyBalanceView({ ...reading(null), keyQuotaUsd: { limit: null, remaining: null, usage: 2 } })).toBeNull();
    expect(keyBalanceView(null)).toBeNull();
    expect(readingAge(Date.now() - 30_000)).toBe('just now');
  });
});
