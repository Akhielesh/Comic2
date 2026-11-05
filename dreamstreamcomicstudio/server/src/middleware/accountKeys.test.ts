// @vitest-environment node
// Account key vs platform key (middleware/accountKeys.ts). While the user runs on the DreamStream
// usage, platform-funded providers stay on the PLATFORM key even when an account key is on file;
// once the usage is used up the account key is injected only in 'auto' mode. The decision needs a
// READABLE status: when the budget database cannot answer (getAllowanceStatus fails soft with
// enabled:false) the platform key is kept — the usage enforcer then refuses with
// usage_budget_unavailable and nothing is spent on either key. It used to fail OPEN into the
// user's wallet: an unreadable status skipped the suppression and the stored key was spent without
// consent, even in 'never' mode with usage left.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const rows = vi.hoisted(() => ({ list: [] as { provider: string; encrypted_key: string; iv: string }[] }));
vi.mock('../lib/secureStore.js', () => ({
  isSecureStoreAvailable: () => true,
  decryptSecret: (enc: string) => enc
}));
vi.mock('../services/supabase.js', () => ({
  getSupabaseCapabilityStatus: () => ({ storagePersistenceEnabled: true }),
  getSupabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: async () => ({ data: rows.list, error: null })
      })
    })
  })
}));
const logs = vi.hoisted(() => ({ warn: [] as string[] }));
vi.mock('../lib/logger.js', () => ({
  logger: {
    debug: () => undefined,
    info: () => undefined,
    warn: (event: string) => {
      logs.warn.push(event);
    },
    error: () => undefined
  }
}));
type Mode = 'ask' | 'auto' | 'never';
const status = vi.hoisted(() => ({ enabled: true, exhausted: false, mode: 'never' as Mode, usePlatformAllowance: true }));
vi.mock('../services/platformAllowance.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/platformAllowance.js')>()),
  allowanceEnabled: () => true,
  getAllowanceStatus: async () => ({
    enabled: status.enabled,
    governed: true,
    exhausted: status.exhausted,
    exempt: false,
    allowPro: false,
    capUsd: 10,
    usedUsd: status.exhausted ? 10 : 1,
    pctUsed: status.exhausted ? 100 : 10,
    pctLeft: status.exhausted ? 0 : 90,
    period: 'lifetime',
    resetsAt: null,
    crossed: []
  }),
  getBillingPrefs: async () => ({ usePlatformAllowance: status.usePlatformAllowance, byokFallbackMode: status.mode })
}));

const { attachAccountKeys } = await import('./accountKeys.js');

const PLATFORM = { key: 'sk-or-platform', byok: false };
const OWN = { key: 'sk-or-USERS-OWN', byok: true };

let seq = 0;
// A fresh user per run: the middleware caches a user's account keys for 60 s.
const makeReq = () =>
  ({
    user: { id: `u-${Date.now()}-${seq++}` },
    header: () => undefined,
    apiKeys: {
      openRouterKey: 'sk-or-platform',
      openRouterByok: false,
      providerKeys: { openrouter: { key: 'sk-or-platform', byok: false } }
    }
  }) as unknown as Request;

const run = async () => {
  const req = makeReq();
  await new Promise<void>((resolve, reject) =>
    attachAccountKeys(req, {} as Response, ((err?: unknown) => (err ? reject(err) : resolve())) as NextFunction)
  );
  return { key: req.apiKeys?.openRouterKey, byok: req.apiKeys?.openRouterByok };
};

const setStatus = (over: Partial<typeof status>) => Object.assign(status, over);

beforeEach(() => {
  rows.list = [{ provider: 'openrouter', encrypted_key: 'sk-or-USERS-OWN', iv: 'iv' }];
  setStatus({ enabled: true, exhausted: false, mode: 'never', usePlatformAllowance: true });
  logs.warn = [];
});

describe('attachAccountKeys — a readable usage status', () => {
  it('usage left: the platform key stays, whatever the fallback mode', async () => {
    for (const mode of ['ask', 'auto', 'never'] as const) {
      setStatus({ mode });
      expect(await run()).toEqual(PLATFORM);
    }
  });

  it("usage used up + 'auto': the stored key is injected (the user consented to the fallback)", async () => {
    setStatus({ exhausted: true, mode: 'auto' });
    expect(await run()).toEqual(OWN);
  });

  it("usage used up + 'ask' / 'never': the platform key stays so the enforcer refuses honestly", async () => {
    for (const mode of ['ask', 'never'] as const) {
      setStatus({ exhausted: true, mode });
      expect(await run()).toEqual(PLATFORM);
    }
  });

  it('platform usage switched off by the user: their own key is used (an explicit choice)', async () => {
    setStatus({ usePlatformAllowance: false, mode: 'never' });
    expect(await run()).toEqual(OWN);
  });
});

describe('attachAccountKeys — the usage status cannot be read (fails closed)', () => {
  // Without the fix: {key:'sk-or-USERS-OWN', byok:true} — the user's key spent without consent.
  it("'never', usage not used up: keeps the platform key (never the user's key without consent)", async () => {
    setStatus({ enabled: false, exhausted: false, mode: 'never' });
    expect(await run()).toEqual(PLATFORM);
  });

  it("'ask' (the default): keeps the platform key", async () => {
    setStatus({ enabled: false, mode: 'ask' });
    expect(await run()).toEqual(PLATFORM);
  });

  it("'auto': still keeps the platform key — consent covers used-up usage, which an unreadable status cannot show", async () => {
    setStatus({ enabled: false, exhausted: false, mode: 'auto' });
    expect(await run()).toEqual(PLATFORM);
  });

  it('is visible in the logs as account_keys_status_unavailable', async () => {
    setStatus({ enabled: false, mode: 'never' });
    await run();
    expect(logs.warn).toContain('account_keys_status_unavailable');
  });

  it('platform usage switched off: the status is not consulted and the own key is used', async () => {
    setStatus({ enabled: false, usePlatformAllowance: false, mode: 'never' });
    expect(await run()).toEqual(OWN);
    expect(logs.warn).not.toContain('account_keys_status_unavailable');
  });
});
