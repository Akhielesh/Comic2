// @vitest-environment node
// Probe: middleware/accountKeys.ts decides whether a stored account key replaces the PLATFORM key.
// Contract (its own comment): while the user runs on the DreamStream usage, platform-funded
// providers stay on the platform key; once usage is used up the account key is injected only in
// 'auto' mode — in 'ask'/'never' the platform key is kept "instead of silently spending the user's
// key". The suppression is computed only when `status.enabled` is true, and getAllowanceStatus
// reports `enabled:false` whenever the budget database cannot be read (it "fails soft").
// Expected: a database hiccup never spends the user's own key without consent (mode 'never').
// Observed: with the status unavailable, the stored key is injected as BYOK and the call runs on
// the user's key — the fail-soft status read fails OPEN into the user's wallet.
import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const rows = vi.hoisted(() => ({ list: [] as { provider: string; encrypted_key: string; iv: string }[] }));
vi.mock('../../server/src/lib/secureStore.js', () => ({
  isSecureStoreAvailable: () => true,
  decryptSecret: (enc: string) => enc
}));
vi.mock('../../server/src/services/supabase.js', () => ({
  getSupabaseCapabilityStatus: () => ({ storagePersistenceEnabled: true }),
  getSupabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: async () => ({ data: rows.list, error: null })
      })
    })
  })
}));
const status = vi.hoisted(() => ({ enabled: true, exhausted: false, mode: 'never' as 'ask' | 'auto' | 'never' }));
vi.mock('../../server/src/services/platformAllowance.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/src/services/platformAllowance.js')>()),
  allowanceEnabled: () => true,
  getAllowanceStatus: async () => ({ enabled: status.enabled, governed: true, exhausted: status.exhausted, exempt: false, allowPro: false, capUsd: 10, usedUsd: 1, pctUsed: 10, pctLeft: 90, period: 'lifetime', resetsAt: null, crossed: [] }),
  getBillingPrefs: async () => ({ usePlatformAllowance: true, byokFallbackMode: status.mode })
}));

const { attachAccountKeys, invalidateAccountKeys } = await import('../../server/src/middleware/accountKeys.js');

const makeReq = (userId: string) =>
  ({
    user: { id: userId },
    header: () => undefined,
    apiKeys: {
      openRouterKey: 'sk-or-platform',
      openRouterByok: false,
      providerKeys: { openrouter: { key: 'sk-or-platform', byok: false } }
    }
  }) as unknown as Request;

const run = async (req: Request) => {
  await new Promise<void>((resolve, reject) => attachAccountKeys(req, {} as Response, ((err?: unknown) => (err ? reject(err) : resolve())) as NextFunction));
  return { key: req.apiKeys?.openRouterKey, byok: req.apiKeys?.openRouterByok };
};

describe('account key vs platform key when the usage status cannot be read', () => {
  it("mode 'never', usage NOT used up, status unavailable: keeps the platform key (never the user's key without consent)", async () => {
    rows.list = [{ provider: 'openrouter', encrypted_key: 'sk-or-USERS-OWN', iv: 'iv' }];
    status.mode = 'never';
    status.exhausted = false;
    status.enabled = true;
    const u1 = `u-${Date.now()}-a`;
    const withStatus = await run(makeReq(u1));
    status.enabled = false; // the budget database is unreachable → getAllowanceStatus reports enabled:false
    const u2 = `u-${Date.now()}-b`;
    invalidateAccountKeys(u2);
    const withoutStatus = await run(makeReq(u2));
    process.stderr.write(`probe5 ${JSON.stringify({ withStatus, withoutStatus })}\n`);
    expect(withStatus).toEqual({ key: 'sk-or-platform', byok: false });
    expect(withoutStatus).toEqual({ key: 'sk-or-platform', byok: false });
  });
});
