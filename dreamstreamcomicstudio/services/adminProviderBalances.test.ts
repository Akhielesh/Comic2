import { afterEach, expect, it, vi } from 'vitest';
import { getPlatformBalances, refreshPlatformBalance } from './adminProviderBalances';

vi.mock('./accountProviderUsage', () => ({ ownerBearer: vi.fn(async () => 'Bearer own-admin-token') }));
vi.mock('./clientConfig', () => ({ buildApiUrl: (path: string) => 'https://backend.example' + path }));
afterEach(() => vi.unstubAllGlobals());

it('sends only the account bearer to fixed admin routes and never puts a provider credential in a request', async () => {
  const report = { provider: 'openrouter', status: 'reported', accountBalances: [{ currency: 'USD', remaining: 1 }], keyQuotaUsd: null, checkedAt: 1000 };
  const fetcher = vi.fn(async (_url: string, opts: RequestInit) => Response.json(opts.method === 'GET' ? { available: true, balanceReports: [report] } : { report, saved: true }));
  vi.stubGlobal('fetch', fetcher);
  const signal = new AbortController().signal;
  expect((await getPlatformBalances('operator', signal)).balanceReports).toEqual([report]);
  expect(await refreshPlatformBalance('operator', 'openrouter', signal)).toEqual({ report, saved: true });
  expect(fetcher.mock.calls).toEqual([
    ['https://backend.example/api/admin/provider-balances', { method: 'GET', headers: { Authorization: 'Bearer own-admin-token' }, cache: 'no-store', redirect: 'error', signal }],
    ['https://backend.example/api/admin/provider-balances/openrouter', { method: 'POST', headers: { Authorization: 'Bearer own-admin-token' }, cache: 'no-store', redirect: 'error', signal }]
  ]);
});
