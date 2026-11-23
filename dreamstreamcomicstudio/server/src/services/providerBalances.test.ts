import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeSavedBalanceReport, type BalanceProvider } from '../../../shared/providerBalances.js';
import { getProviderBalanceReport } from './providerBalances.js';

const read = (provider: BalanceProvider, key: string | null, ownerId = 'one') => getProviderBalanceReport({ ownerId, provider, key });
const json = (body: unknown, status = 200) => Response.json(body, { status });
const upstream = (reply: (url: string, init: RequestInit) => Response) => {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => reply(url, init));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
};
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('personal provider balance reads', () => {
  it('keeps a management account balance and a key-specific quota separate and whitelists the result', async () => {
    const fetcher = upstream((url, init) => {
      expect(url.startsWith('https://openrouter.ai/api/v1/')).toBe(true);
      expect(init).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer management-demo' } });
      return url.endsWith('/key')
        ? json({ data: { is_management_key: true, limit: 15, limit_remaining: 3, usage: 8, label: 'private' } })
        : json({ data: { total_credits: 30, total_usage: 20 } });
    });
    const report = await read('openrouter', 'management-demo');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({ status: 'reported', accountBalances: [{ currency: 'USD', remaining: 10 }], keyQuotaUsd: { limit: 15, remaining: 3, usage: 8 } });
    expect(JSON.stringify(report)).not.toMatch(/management-demo|private/);
  });

  it('an inference key can report usage and a real zero remaining without account-reading permissions', async () => {
    const fetcher = upstream(() => json({ data: { is_management_key: false, limit: 10, limit_remaining: 0, usage: 12 } }));
    expect(await read('openrouter', 'personal-demo')).toMatchObject({ accountBalances: null, keyQuotaUsd: { limit: 10, remaining: 0, usage: 12 } });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['https://openrouter.ai/api/v1/key']);
  });

  it.each([{ total_credits: null, total_usage: null }, { total_credits: 9 }, { total_usage: 1 }, {}])('cannot derive a balance from missing amounts (%j)', async body => {
    upstream(url => json({ data: url.endsWith('/key') ? { is_management_key: true } : body }));
    expect(await read('openrouter', 'partial-' + JSON.stringify(body))).toMatchObject({ status: 'unavailable', accountBalances: null, keyQuotaUsd: null });
  });

  it('retains native currencies, zero and negative balances without summing or converting them', async () => {
    const fetcher = upstream((url, init) => {
      expect(url).toBe('https://api.deepseek.com/user/balance');
      expect(init).toMatchObject({ redirect: 'error', method: 'GET', headers: { Authorization: 'Bearer multi-currency' } });
      return json({ is_available: true, balance_infos: [
        { currency: 'CNY', total_balance: '0.00' }, { currency: 'USD', total_balance: '-0.50' },
        { currency: 'USD', total_balance: null }, { currency: 'BTC', total_balance: '75' }
      ] });
    });
    const report = await read('deepseek', 'multi-currency');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(report.accountBalances).toEqual([{ currency: 'CNY', remaining: 0 }, { currency: 'USD', remaining: -0.5 }]);
  });

  it('reads documented subscription windows and skips ambiguous counters and unavailable models', async () => {
    upstream((url, init) => {
      if (url.includes('minimax.io')) return json({ base_resp: { status_code: 0 }, model_remains: [
        { model_name: 'general', current_interval_remaining_percent: 30, current_weekly_remaining_percent: 100 },
        { model_name: 'video', current_weekly_remaining_percent: 100, current_weekly_status: 3 },
        { model_name: 'speech', current_interval_usage_count: 100 }
      ] });
      expect(init.headers).toMatchObject({ Authorization: 'plan-zai' });
      return json({ success: true, data: { limits: [
        { type: 'TOKENS_LIMIT', percentage: 15 }, { type: 'TIME_LIMIT', percentage: 100 }, { type: 'TIME_LIMIT', percentage: null }
      ] } });
    });
    expect((await read('minimax', 'plan-minimax')).planQuotas).toEqual([
      { label: 'general current window', remainingPercent: 30 }, { label: 'general weekly', remainingPercent: 100 }
    ]);
    expect((await read('zai', 'plan-zai')).planQuotas).toEqual([
      { label: 'Token allowance', remainingPercent: 85 }, { label: 'MCP tool allowance', remainingPercent: 0 }
    ]);
  });

  it('deduplicates simultaneous reads and caches only the same owner, provider and credential for one minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let balance = 0;
    const fetcher = upstream(() => json({ balance_infos: [{ currency: 'USD', total_balance: String(++balance) }] }));
    const pair = await Promise.all([read('deepseek', 'cache-a'), read('deepseek', 'cache-a')]);
    expect(pair[0]).toEqual(pair[1]);
    await read('deepseek', 'cache-a', 'another');
    await read('deepseek', 'cache-b');
    await read('deepseek', 'cache-a');
    expect(fetcher).toHaveBeenCalledTimes(3);
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
    expect((await read('deepseek', 'cache-a')).accountBalances?.[0].remaining).toBe(4);
  });

  it('never calls an upstream for an absent owner, key or unsupported source', async () => {
    const fetcher = upstream(() => { throw new Error('unexpected'); });
    expect((await read('deepseek', 'device-key', '')).status).toBe('missing');
    expect((await read('openrouter', null)).status).toBe('missing');
    expect((await read('anthropic', 'other-key')).status).toBe('unsupported');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('turns denial, malformed provider data and transport failures into an unknown balance', async () => {
    upstream((url) => {
      if (url.includes('minimax')) throw new Error('secret details');
      if (url.includes('deepseek')) return json({ secret_text: 'do not echo' }, 403);
      return json({ success: false, data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 0 }] } });
    });
    for (const provider of ['deepseek','zai','minimax'] as const) {
      const status = await read(provider, 'failure');
      expect(status).toMatchObject({ status: 'unavailable', accountBalances: null, keyQuotaUsd: null });
      expect(JSON.stringify(status)).not.toMatch(/secret|echo/);
    }
  });

  it('rehydrates only the expected provider’s known amounts and units', () => {
    const raw = { provider: 'deepseek', status: 'reported', checkedAt: 1000, rawKey: 'hidden',
      accountBalances: [{ currency: 'CNY', remaining: 4, marker: 'extra' }, { currency: 'ETH', remaining: 5 }],
      keyQuotaUsd: { usage: 3 }, planQuotas: [{ label: 'invalid', remainingPercent: 29 }] };
    expect(normalizeSavedBalanceReport(raw, 'openrouter')).toBeNull();
    expect(normalizeSavedBalanceReport(raw, 'deepseek')).toEqual({ provider: 'deepseek', status: 'reported', checkedAt: 1000,
      accountBalances: [{ currency: 'CNY', remaining: 4 }], keyQuotaUsd: null });
  });
});
