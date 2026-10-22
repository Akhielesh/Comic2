// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { PAID_PLAN_IDS } from '../../../shared/comic/capabilities.js';
import { toEffectiveTier } from '../services/modelAccessPolicy.js';
import {
  __resetAccessCacheForTests,
  CEILING_ON_LOOKUP_FAILURE,
  checkQualityAccess,
  PAID_PLAN_TIERS,
  PRO_QUALITY_DENIED_MESSAGE,
  qualityDeniedFromCaps,
  studioCapsFor
} from './access.js';

const req = (userId?: string) => ({ user: userId ? { id: userId } : undefined }) as unknown as Request;

beforeEach(() => __resetAccessCacheForTests());

describe('checkQualityAccess', () => {
  it('always allows draft and standard', async () => {
    const planFor = vi.fn(async () => 'free');
    expect(await checkQualityAccess(req('u'), 'draft', false, { planFor, billingEnabled: true })).toEqual({ ok: true });
    expect(await checkQualityAccess(req('u'), 'standard', false, { planFor, billingEnabled: true })).toEqual({ ok: true });
    expect(planFor).not.toHaveBeenCalled();
  });

  it('allows Pro with the user’s own key, whatever the plan', async () => {
    const planFor = vi.fn(async () => 'free');
    expect(await checkQualityAccess(req('u'), 'pro', true, { planFor, billingEnabled: true })).toEqual({ ok: true });
    expect(planFor).not.toHaveBeenCalled();
  });

  it.each(['creator', 'pro', 'studio', 'custom', 'admin', 'Creator '])('allows Pro on the paid plan %s', async (plan) => {
    expect(await checkQualityAccess(req(`u-${plan}`), 'pro', false, { planFor: async () => plan, billingEnabled: true })).toEqual({ ok: true });
  });

  it('denies Pro on the free plan with the friendly message', async () => {
    expect(await checkQualityAccess(req('u'), 'pro', false, { planFor: async () => 'free', billingEnabled: true })).toEqual({
      ok: false,
      message: PRO_QUALITY_DENIED_MESSAGE
    });
    expect(PRO_QUALITY_DENIED_MESSAGE).toBe('Pro quality uses Nano Banana Pro and needs a paid plan or your own Gemini/OpenRouter key.');
  });

  it('fails open when the billing lookup errors', async () => {
    const planFor = vi.fn(async () => {
      throw new Error('billing backend unavailable');
    });
    expect(await checkQualityAccess(req('u'), 'pro', false, { planFor, billingEnabled: true })).toEqual({ ok: true });
  });

  it('denies Pro without a signed-in user, and allows everything when billing is off', async () => {
    expect((await checkQualityAccess(req(), 'pro', false, { planFor: async () => 'pro', billingEnabled: true })).ok).toBe(false);
    expect(await checkQualityAccess(req(), 'pro', false, { planFor: async () => 'free', billingEnabled: false })).toEqual({ ok: true });
  });

  it('caches the plan lookup briefly per user', async () => {
    const planFor = vi.fn(async () => 'creator');
    await checkQualityAccess(req('same'), 'pro', false, { planFor, billingEnabled: true });
    await checkQualityAccess(req('same'), 'pro', false, { planFor, billingEnabled: true });
    expect(planFor).toHaveBeenCalledTimes(1);
  });
});

describe('studioCapsFor', () => {
  const deps = (over: Partial<Parameters<typeof studioCapsFor>[2]> = {}) => ({
    billingEnabled: true,
    planFor: async () => 'free',
    isAdminFor: async () => false,
    accountCeilingFor: async () => 'PG-13' as const,
    ...over
  });

  it('free with no key → draft + standard, no model picker, Pro editor still on, 40 pages', async () => {
    const caps = await studioCapsFor(req('u1'), { byok: false }, deps());
    expect(caps).toMatchObject({ plan: 'free', byok: false, qualityTiers: ['draft', 'standard'], modelOverride: false, maxPages: 40, defaultMode: 'easy', proEditor: true, customFonts: false, ratingCeiling: 'PG-13', admin: false });
    expect(qualityDeniedFromCaps(caps)).toBe(PRO_QUALITY_DENIED_MESSAGE);
  });

  it('own key → Pro tier and the model picker; paid plan → paid + pro default mode; admin → admin', async () => {
    expect(await studioCapsFor(req('u2'), { byok: true }, deps())).toMatchObject({ plan: 'free', byok: true, qualityTiers: ['draft', 'standard', 'pro'], modelOverride: true });
    const paid = await studioCapsFor(req('u3'), { byok: false }, deps({ planFor: async () => 'Studio' }));
    expect(paid).toMatchObject({ plan: 'paid', qualityTiers: ['draft', 'standard', 'pro'], defaultMode: 'pro' });
    expect(qualityDeniedFromCaps(paid)).toBeUndefined();
    expect(await studioCapsFor(req('u4'), { byok: false }, deps({ isAdminFor: async () => true }))).toMatchObject({ plan: 'admin', admin: true, modelOverride: true });
  });

  it('applies the account-age ceiling; a failed ceiling lookup never lifts it (PG)', async () => {
    expect((await studioCapsFor(req('u5'), { byok: false }, deps({ accountCeilingFor: async () => 'PG' }))).ratingCeiling).toBe('PG');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failed = await studioCapsFor(req('u6'), { byok: false }, deps({ accountCeilingFor: async () => { throw new Error('db down'); } }));
    expect(failed.ratingCeiling).toBe(CEILING_ON_LOOKUP_FAILURE);
    expect(CEILING_ON_LOOKUP_FAILURE).toBe('PG');
    warn.mockRestore();
  });

  it('fails open on the tier gate when billing is off or the plan lookup fails; admin lookup fails closed', async () => {
    const off = await studioCapsFor(req('u7'), { byok: false }, deps({ billingEnabled: false }));
    expect(off).toMatchObject({ plan: 'free', qualityTiers: ['draft', 'standard', 'pro'], modelOverride: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failed = await studioCapsFor(req('u8'), { byok: false }, deps({ planFor: async () => { throw new Error('ledger down'); }, isAdminFor: async () => { throw new Error('roles down'); } }));
    expect(failed).toMatchObject({ qualityTiers: ['draft', 'standard', 'pro'], admin: false, plan: 'free' });
    warn.mockRestore();
  });

  it('shares the plan cache with checkQualityAccess (one lookup per user per minute)', async () => {
    const planFor = vi.fn(async () => 'creator');
    await studioCapsFor(req('same-user'), { byok: false }, deps({ planFor }));
    await checkQualityAccess(req('same-user'), 'pro', false, { planFor, billingEnabled: true });
    expect(planFor).toHaveBeenCalledTimes(1);
  });

  it('PAID_PLAN_IDS is the single source for access.ts and modelAccessPolicy.ts', () => {
    expect([...PAID_PLAN_TIERS].sort()).toEqual([...PAID_PLAN_IDS].sort());
    for (const plan of PAID_PLAN_IDS) expect(toEffectiveTier(plan)).toBe('pro');
    for (const plan of ['free', 'starter', '', 'enterprise-trial']) expect(toEffectiveTier(plan)).toBe('free');
  });
});
