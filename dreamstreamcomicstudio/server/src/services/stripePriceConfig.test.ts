import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resetStripePriceConfigCache,
  resolveCreditPackFromStripePriceId,
  resolveCreditPackStripePriceId,
  resolvePlanFromStripePriceId,
  resolvePlanStripePriceId
} from './stripePriceConfig.js';

const ENV_KEYS = [
  'STRIPE_PRICE_ID',
  'STRIPE_PRICE_ID_CREATOR',
  'STRIPE_PRICE_ID_CREATOR_ANNUAL',
  'STRIPE_PRICE_ID_PRO',
  'STRIPE_PRICE_ID_PRO_ANNUAL',
  'STRIPE_PRICE_ID_STUDIO',
  'STRIPE_PRICE_ID_STUDIO_ANNUAL',
  'STRIPE_PRICE_ID_CREDIT_PACK_10',
  'STRIPE_PRICE_ID_CREDIT_PACK_25',
  'STRIPE_PRICE_ID_CREDIT_PACK_100'
] as const;

const snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
  resetStripePriceConfigCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
  resetStripePriceConfigCache();
});

describe('stripePriceConfig env fallback', () => {
  it('resolves plan price ids by tier + interval', async () => {
    process.env.STRIPE_PRICE_ID_CREATOR = 'price_creator_month';
    process.env.STRIPE_PRICE_ID_CREATOR_ANNUAL = 'price_creator_year';
    process.env.STRIPE_PRICE_ID_PRO = 'price_pro_month';
    process.env.STRIPE_PRICE_ID_PRO_ANNUAL = 'price_pro_year';

    await expect(resolvePlanStripePriceId('creator', 'month')).resolves.toBe('price_creator_month');
    await expect(resolvePlanStripePriceId('creator', 'year')).resolves.toBe('price_creator_year');
    await expect(resolvePlanStripePriceId('pro', 'month')).resolves.toBe('price_pro_month');
    await expect(resolvePlanStripePriceId('pro', 'year')).resolves.toBe('price_pro_year');
  });

  it('supports reverse lookup from price id to plan tier + interval', async () => {
    process.env.STRIPE_PRICE_ID_STUDIO = 'price_studio_month';
    process.env.STRIPE_PRICE_ID_STUDIO_ANNUAL = 'price_studio_year';

    await expect(resolvePlanFromStripePriceId('price_studio_month')).resolves.toEqual({
      planTier: 'studio',
      interval: 'month'
    });

    await expect(resolvePlanFromStripePriceId('price_studio_year')).resolves.toEqual({
      planTier: 'studio',
      interval: 'year'
    });

    await expect(resolvePlanFromStripePriceId('unknown')).resolves.toBeNull();
  });

  it('resolves credit pack lookups', async () => {
    process.env.STRIPE_PRICE_ID_CREDIT_PACK_25 = 'price_pack_25';

    await expect(resolveCreditPackStripePriceId('pack_25')).resolves.toBe('price_pack_25');
    await expect(resolveCreditPackFromStripePriceId('price_pack_25')).resolves.toBe('pack_25');
    await expect(resolveCreditPackFromStripePriceId('unknown')).resolves.toBeNull();
  });
});
