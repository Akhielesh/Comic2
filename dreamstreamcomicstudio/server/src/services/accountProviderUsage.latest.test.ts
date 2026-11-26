// @vitest-environment node
// The reading a paid step compares with (credit-safety.md): the owner's saved observation of exactly this key while it is
// fresh, else a fresh read through the code behind POST /api/keys/balance; never a stale reading, never on a timer.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProviderBalanceReport } from '../../../shared/providerBalances.js';

const io = vi.hoisted(() => ({ rpc: vi.fn(), table: vi.fn(), keys: vi.fn(), probe: vi.fn() }));
vi.mock('./supabase.js', () => ({ getSupabaseAdmin: () => ({ rpc: io.rpc, from: io.table }) }));
vi.mock('../middleware/accountKeys.js', () => ({ readAccountBalanceKeys: io.keys }));
vi.mock('./providerBalances.js', () => ({ getProviderBalanceReport: io.probe }));
import { __resetOwnKeyBalanceReadsForTests, latestOwnKeyBalance } from './accountProviderUsage.js';

const NOW = 1_790_000_000_000;
const report = (checkedAt: number, remaining = 4.2): ProviderBalanceReport => ({
  provider: 'openrouter', status: 'reported', checkedAt, accountBalances: null, keyQuotaUsd: { limit: 10, remaining, usage: 10 - remaining }
});
/** The saved observation table: the newest row for the binding asked for, recording which owner was asked. */
const savedRows = (row: ProviderBalanceReport | null) => {
  const asked: string[] = [];
  io.table.mockImplementation(() => {
    const q = {
      select: () => q, is: () => q, order: () => q, limit: () => q,
      eq: (name: string, value: string) => { if (name === 'owner_id') asked.push(value); return q; },
      maybeSingle: async () => ({ data: row ? { report: row } : null, error: null })
    };
    return q;
  });
  return asked;
};
const credential = { ownerId: 'owner-synthetic', provider: 'openrouter' as const, key: 'sk-or-synthetic' };

beforeEach(() => {
  vi.resetAllMocks();
  __resetOwnKeyBalanceReadsForTests();
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-only-binding');
  io.rpc.mockResolvedValue({ data: null, error: null });
});
afterEach(() => vi.unstubAllEnvs());

it('uses a saved reading under 15 minutes old for this owner without reading the provider', async () => {
  const fresh = report(NOW - 5 * 60_000);
  const asked = savedRows(fresh);
  expect(await latestOwnKeyBalance(credential, { now: () => NOW })).toEqual(fresh);
  expect(asked).toEqual(['owner-synthetic']);
  expect(io.probe).not.toHaveBeenCalled();
});

it('reads the provider again when the saved reading is stale, and saves the new one', async () => {
  savedRows(report(NOW - 20 * 60_000, 9));
  const fresh = report(NOW, 1.5);
  io.probe.mockResolvedValue(fresh);
  expect(await latestOwnKeyBalance(credential, { now: () => NOW })).toEqual(fresh);
  expect(io.probe).toHaveBeenCalledWith({ ownerId: 'owner-synthetic', provider: 'openrouter', key: 'sk-or-synthetic' });
  expect(io.rpc).toHaveBeenCalledWith('record_provider_balance', expect.objectContaining({ p_owner: 'owner-synthetic', p_report: fresh }));
});

it('never decides on a stale reading: a failed or slow refresh is unknown', async () => {
  savedRows(report(NOW - 20 * 60_000, 0));
  io.probe.mockResolvedValue({ ...report(NOW), status: 'unavailable', keyQuotaUsd: null });
  expect(await latestOwnKeyBalance(credential, { now: () => NOW })).toBeNull();
  __resetOwnKeyBalanceReadsForTests();
  io.probe.mockImplementation(() => new Promise(() => undefined));
  expect(await latestOwnKeyBalance(credential, { now: () => NOW, timeoutMs: 5 })).toBeNull();
});

it('a slow or failing provider is asked at most once per two minutes, and checks meanwhile share one read', async () => {
  savedRows(report(NOW - 20 * 60_000, 0));
  let release: (r: ProviderBalanceReport) => void = () => undefined;
  io.probe.mockImplementation(() => new Promise<ProviderBalanceReport>((resolve) => { release = resolve; }));
  // Two checks at once wait on one provider read.
  const [a, b] = await Promise.all([
    latestOwnKeyBalance(credential, { now: () => NOW, timeoutMs: 5 }),
    latestOwnKeyBalance(credential, { now: () => NOW, timeoutMs: 5 })
  ]);
  expect([a, b]).toEqual([null, null]);
  expect(io.probe).toHaveBeenCalledTimes(1);
  // It timed out: the next check within the cooldown does not wait or ask again.
  const started = Date.now();
  expect(await latestOwnKeyBalance(credential, { now: () => NOW + 60_000, timeoutMs: 1_000 })).toBeNull();
  expect(Date.now() - started).toBeLessThan(500);
  expect(io.probe).toHaveBeenCalledTimes(1);
  // The slow read lands (and is saved); once the cooldown is over the provider is asked again.
  release(report(NOW, 3));
  await new Promise((r) => setTimeout(r, 0));
  io.probe.mockResolvedValue(report(NOW + 3 * 60_000, 2));
  expect(await latestOwnKeyBalance(credential, { now: () => NOW + 3 * 60_000 })).toEqual(report(NOW + 3 * 60_000, 2));
  expect(io.probe).toHaveBeenCalledTimes(2);
});

it('a stricter age reads a recent reading again, past the provider cache, and keeps it when that read fails', async () => {
  const recent = report(NOW - 2 * 60_000, 0.02);
  savedRows(recent);
  const topped = report(NOW, 10.02);
  io.probe.mockResolvedValue(topped);
  // The default age keeps a 2-minute-old reading; 30 s does not.
  expect(await latestOwnKeyBalance(credential, { now: () => NOW })).toEqual(recent);
  expect(io.probe).not.toHaveBeenCalled();
  expect(await latestOwnKeyBalance(credential, { now: () => NOW, maxAgeMs: 30_000 })).toEqual(topped);
  expect(io.probe).toHaveBeenCalledWith({ ownerId: 'owner-synthetic', provider: 'openrouter', key: 'sk-or-synthetic', fresh: true });
  // A read that fails leaves the saved reading that is still under 15 minutes old (it is what the check had).
  __resetOwnKeyBalanceReadsForTests();
  io.probe.mockResolvedValue({ ...report(NOW), status: 'unavailable', keyQuotaUsd: null });
  expect(await latestOwnKeyBalance(credential, { now: () => NOW, maxAgeMs: 30_000 })).toEqual(recent);
});

it('is unknown for a provider with no balance API, a missing key, or a server without the binding secret', async () => {
  savedRows(report(NOW));
  expect(await latestOwnKeyBalance({ ...credential, provider: 'gemini' }, { now: () => NOW })).toBeNull();
  expect(await latestOwnKeyBalance({ ...credential, key: '  ' }, { now: () => NOW })).toBeNull();
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
  expect(await latestOwnKeyBalance(credential, { now: () => NOW })).toBeNull();
  expect(io.table).not.toHaveBeenCalled();
  expect(io.probe).not.toHaveBeenCalled();
});

it('reads the provider when the saved history cannot be read, and never throws', async () => {
  io.table.mockImplementation(() => { throw new Error('history down'); });
  const fresh = report(NOW);
  io.probe.mockResolvedValue(fresh);
  expect(await latestOwnKeyBalance(credential, { now: () => NOW })).toEqual(fresh);
  io.probe.mockRejectedValue(new Error('network'));
  expect(await latestOwnKeyBalance(credential, { now: () => NOW })).toBeNull();
});
