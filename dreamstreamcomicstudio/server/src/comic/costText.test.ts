// Server-side cost wording (P2-SERVER): governed users never read dollars; admins, own keys and
// legacy callers (no caps) read real prices. Same formula as the client's services/costDisplay.ts.
import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities.js';
import { PLATFORM_MARKUP } from '../../../shared/comic/models.js';
import { DOLLAR_VIEW, costFormatter, costViewFor, governDollars, standardPageProviderUsd } from './costText.js';

const usage = (pctPerStandardPage: number | null, governed = true): StudioCaps['usage'] => ({ governed, pctLeft: 70, exhausted: false, pctPerStandardPage });

describe('costViewFor', () => {
  it('dollars need a positive answer that no limit applies; unknown usage stays in usage terms', () => {
    expect(costViewFor(undefined)).toBe(DOLLAR_VIEW); // legacy / tests with no request
    expect(costViewFor({ ...DEFAULT_CAPS, admin: true })).toBe(DOLLAR_VIEW);
    expect(costViewFor({ ...DEFAULT_CAPS, byok: true })).toBe(DOLLAR_VIEW);
    expect(costViewFor({ ...DEFAULT_CAPS, usage: usage(1, false) })).toBe(DOLLAR_VIEW);
    expect(costViewFor({ ...DEFAULT_CAPS })).toEqual({ governed: true, pctPerUsd: null });
    const v = costViewFor({ ...DEFAULT_CAPS, usage: usage(2) });
    expect(v.governed).toBe(true);
    expect(v.pctPerUsd).toBeCloseTo(2 / standardPageProviderUsd(), 6);
  });
});

describe('costFormatter', () => {
  it('dollars for a dollar view, exactly like formatUsd', () => {
    const c = costFormatter(DOLLAR_VIEW);
    expect(c(0.0512)).toBe('$0.05');
    expect(c.approx(0.0512)).toBe('≈ $0.05');
    expect(c(0)).toBe('$0.00');
    expect(c.governed).toBe(false);
  });

  it('governed: one Standard page (charged, markup included) is exactly its share of the usage', () => {
    const c = costFormatter(costViewFor({ ...DEFAULT_CAPS, usage: usage(2) }));
    const onePageCharged = standardPageProviderUsd() * PLATFORM_MARKUP;
    expect(c(onePageCharged)).toBe('≈2% of your usage');
    expect(c.approx(onePageCharged)).toBe('≈2% of your usage'); // the words carry their own ≈
    expect(c(onePageCharged * 10)).toBe('≈20% of your usage');
    expect(c(onePageCharged / 1000)).toBe('<0.1% of your usage');
    expect(c(0)).toBe('free');
    // Usage not known yet: never a dollar figure, never a made-up share.
    expect(costFormatter(costViewFor({ ...DEFAULT_CAPS }))(0.3)).toBe('a little of your usage');
  });
});

describe('governDollars (the safety net under every governed text)', () => {
  const view = costViewFor({ ...DEFAULT_CAPS, usage: usage(2) });
  it('rewords every dollar amount a template or a model wrote; a dollar view is untouched', () => {
    const onePage = (standardPageProviderUsd() * PLATFORM_MARKUP).toFixed(2);
    const text = `Drawing page 1 now (≈ $${onePage}) — spent ~$0.00 so far, the cover is <$0.01 and $1 buys a lot.`;
    const out = governDollars(text, view);
    expect(out).not.toMatch(/\$/);
    expect(out).toMatch(/^Drawing page 1 now \(≈\d/);
    expect(out).toContain('spent free so far');
    expect(governDollars(text, DOLLAR_VIEW)).toBe(text);
    expect(governDollars('no money here', view)).toBe('no money here');
  });
});
