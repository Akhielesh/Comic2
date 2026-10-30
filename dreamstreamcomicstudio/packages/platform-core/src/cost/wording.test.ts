// @vitest-environment node
//
// Parity with the host (W1.4): core's price wording is DreamStream's own `formatCostForUser`
// (services/costDisplay.ts) and `formatUsd` (shared/comic/models.ts), word for word, over the 1,000 seeded amounts
// and every kind of share (known, tiny, huge, zero, negative, unknown, NaN, Infinity), so a chip, a card and a
// sentence agree. The host modules are loaded at run time only, so the app's module graph stays out of the package.
import { describe, expect, it } from 'vitest';
import { UNKNOWN_USAGE_SHARE, UNKNOWN_USAGE_SHARE_IN_SENTENCE, costLabel, formatUsd, governText } from './index.js';
import { seededAmounts } from '../testing/conformance.js';

type Ctx = { governed: boolean; pctPerUsd?: number | null };
const app = (rel: string): Promise<Record<string, unknown>> => import(/* @vite-ignore */ new URL(`../../../../${rel}`, import.meta.url).href);
const host = (await app('services/costDisplay.ts')) as {
  formatCostForUser: (usd: number, ctx: Ctx) => string;
  UNKNOWN_USAGE_SHARE: string;
  amountInSentence: (formatted: string) => string;
};
const models = (await app('shared/comic/models.ts')) as { formatUsd: (usd: number) => string };

const AMOUNTS = seededAmounts(20261102, 1000);
const SHARES: (number | null | undefined)[] = [10, 0.37, 40, 2, 1234.5, 1e-9, 0, -1, null, undefined, NaN, Infinity];

describe('core wording equals the host’s', () => {
  it('costLabel is formatCostForUser for 1,000 seeded amounts, governed or not, under every share', () => {
    const diffs: string[] = [];
    for (const usd of AMOUNTS) {
      for (const governed of [true, false]) {
        for (const pctPerUsd of SHARES) {
          const ctx: Ctx = { governed, pctPerUsd };
          const core = costLabel(usd, ctx);
          const hostText = host.formatCostForUser(usd, ctx);
          if (core !== hostText) diffs.push(`${usd} ${JSON.stringify(ctx)}: core "${core}" host "${hostText}"`);
        }
      }
    }
    expect(diffs.slice(0, 10)).toEqual([]);
  });

  it('formatUsd is the host’s formatUsd, and the unknown share reads the same, in a sentence too', () => {
    for (const usd of AMOUNTS) expect(formatUsd(usd), String(usd)).toBe(models.formatUsd(usd));
    expect(UNKNOWN_USAGE_SHARE).toBe(host.UNKNOWN_USAGE_SHARE);
    expect(UNKNOWN_USAGE_SHARE_IN_SENTENCE).toBe(host.amountInSentence(host.UNKNOWN_USAGE_SHARE));
    expect(governText('This page costs $0.40 once.', { governed: true })).toBe(`This page costs ${host.amountInSentence(host.formatCostForUser(0.4, { governed: true }))} once.`);
    expect(governText('This page costs $0.40 once.', { governed: true, pctPerUsd: 10 })).toBe(`This page costs ${host.formatCostForUser(0.4, { governed: true, pctPerUsd: 10 })} once.`);
  });
});
