// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { __resetAccessCacheForTests, checkQualityAccess, PRO_QUALITY_DENIED_MESSAGE } from './access.js';

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
