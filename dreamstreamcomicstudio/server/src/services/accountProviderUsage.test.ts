// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { ProviderBalanceReport } from '../../../shared/providerBalances.js';

const io = vi.hoisted(() => ({ rpc: vi.fn(), table: vi.fn(), keys: vi.fn(), probe: vi.fn() }));
vi.mock('./supabase.js', () => ({ getSupabaseAdmin: () => ({ rpc: io.rpc, from: io.table }) }));
vi.mock('../middleware/accountKeys.js', () => ({ readAccountBalanceKeys: io.keys }));
vi.mock('./providerBalances.js', () => ({ getProviderBalanceReport: io.probe }));
import { accountProviderUsage, combineAccountUsage, platformBalanceHistory, refreshProviderBalance } from './accountProviderUsage.js';

const checked: ProviderBalanceReport = { provider:'deepseek', checkedAt: 1_760_000_000_000, status:'reported', accountBalances:[{currency:'CNY',remaining:15}], keyQuotaUsd:null };
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-only-binding'); });
afterEach(() => vi.unstubAllEnvs());

it('reads the authenticated owner and the UTC window from trusted arguments and reports partial outages distinctly', async () => {
  io.rpc.mockResolvedValueOnce({ data:[{provider:'openrouter',byok_requests:1,platform_requests:9,estimated_byok_usd:null,reported_byok_usd:0}], error:null });
  io.rpc.mockRejectedValueOnce(new Error('upstream detail'));
  io.keys.mockRejectedValueOnce(new Error('private error'));
  const report = await accountProviderUsage('owner-a', new Date('2026-12-31T23:59:59Z'));
  expect(io.rpc.mock.calls).toEqual([
    ['member_provider_models',{p_owner:'owner-a',p_from:'2026-12-01T00:00:00.000Z',p_to:'2026-12-31T23:59:59.000Z'}],
    ['member_provider_connectors',{p_owner:'owner-a',p_from:'2026-12-01',p_to:'2027-01-01'}]
  ]);
  expect(report.sources).toEqual({models:'available',connectors:'unavailable',balances:'unavailable'});
  expect(report.providers[0]).toMatchObject({modelRequests:10,estimatedByokUsd:null,reportedByokUsd:0});
  expect(JSON.stringify(report)).not.toMatch(/upstream|private error/);
  expect(io.probe).not.toHaveBeenCalled();
});

it('combines unknown model identifiers and arbitrary connector hosts without exposing private names, pricing, or URLs', () => {
  const rows=combineAccountUsage([
    {provider:'PRIVATE-HOST',byok_requests:2,platform_requests:1,estimated_byok_usd:0.5},
    {provider:'__proto__',platform_requests:1,platform_cost_usd:999}
  ], [{provider:'internal.domain',calls:3,errors:1,blocked:2}]);
  expect(rows).toEqual([{provider:'other',modelRequests:4,byokRequests:2,platformRequests:2,estimatedByokUsd:0.5,reportedByokUsd:null,unpricedByokRequests:0,connectorCalls:3,connectorErrors:1,connectorBlocked:2}]);
});

it('binds saved financial observations to owner, provider and exact credential; cached observations never follow rotations', async () => {
  io.probe.mockResolvedValue(checked);
  const saved = new Map<string,ProviderBalanceReport>();
  io.rpc.mockImplementation(async (_name, args) => { if (args.p_report) saved.set(args.p_binding, args.p_report); return {data:[],error:null}; });
  io.table.mockImplementation(() => {
    let binding = '';
    const q={ select:()=>q, eq:(name:string,value:string)=>{if(name==='credential_binding') binding=value;return q;},
      is:()=>q,order:()=>q,limit:()=>q,maybeSingle:async()=>({data:saved.has(binding)?{report:saved.get(binding)}:null,error:null}) };
    return q;
  });
  expect((await refreshProviderBalance({ownerId:'alice',provider:'deepseek',key:'personal-key'})).saved).toBe(true);
  expect((await refreshProviderBalance({ownerId:'bob',provider:'deepseek',key:'personal-key'})).saved).toBe(true);
  expect((await refreshProviderBalance({ownerId:null,provider:'deepseek',key:'personal-key'})).saved).toBe(true);
  expect(saved.size).toBe(3);
  expect(JSON.stringify(io.rpc.mock.calls)).not.toContain('personal-key');
  io.keys.mockResolvedValue({deepseek:'personal-key'});
  io.probe.mockResolvedValue({...checked,status:'unavailable',accountBalances:null});
  expect((await accountProviderUsage('alice')).balanceReports).toEqual([checked]);
  io.keys.mockResolvedValue({deepseek:'rotated-key'});
  expect((await accountProviderUsage('alice')).balanceReports).toEqual([]);
  vi.stubEnv('DEEPSEEK_API_KEY','platform-rotated');
  expect((await platformBalanceHistory()).balanceReports).toEqual([]);
  io.probe.mockResolvedValue({...checked,status:'unavailable',accountBalances:null});
  expect((await refreshProviderBalance({ownerId:'alice',provider:'deepseek',key:'personal-key'})).saved).toBe(false);
  expect(saved.size).toBe(3);
});

it('starts one background sample for simultaneous dashboard reads, returns immediately, and backs off after a failed probe', async () => {
  const q={select:()=>q,eq:()=>q,order:()=>q,limit:()=>q,maybeSingle:async()=>({data:null,error:null})};
  io.table.mockReturnValue(q);
  io.rpc.mockResolvedValue({data:[],error:null});
  io.keys.mockResolvedValue({deepseek:'sample-only-test-key'});
  let finish!: (result:ProviderBalanceReport)=>void;
  io.probe.mockImplementation(()=>new Promise<ProviderBalanceReport>(resolve=>{finish=resolve;}));
  expect((await accountProviderUsage('sampling-owner', new Date(), () => false)).balancesRefreshing).toBe(false);
  expect(io.probe).not.toHaveBeenCalled();
  const initial=await Promise.all([accountProviderUsage('sampling-owner'),accountProviderUsage('sampling-owner')]);
  expect(initial.every(r=>r.balancesRefreshing && !r.balanceReports.length)).toBe(true);
  expect(io.probe).toHaveBeenCalledTimes(1);
  finish({...checked,status:'unavailable',accountBalances:null});
  await new Promise(resolve=>setTimeout(resolve,0));
  expect((await accountProviderUsage('sampling-owner')).balancesRefreshing).toBe(false);
  expect(io.probe).toHaveBeenCalledTimes(1);
});
