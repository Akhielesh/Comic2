import { describe, it, expect } from 'vitest';
import { cgPlanIsPro, resolveKnownCoin } from './finance2.js';

describe('cgPlanIsPro', () => {
  it('selects pro only for explicit paid plans (case/whitespace tolerant)', () => {
    expect(cgPlanIsPro('pro')).toBe(true);
    expect(cgPlanIsPro(' PRO ')).toBe(true);
    expect(cgPlanIsPro('Analyst')).toBe(true);
    expect(cgPlanIsPro('demo')).toBe(false);
    expect(cgPlanIsPro('free')).toBe(false);
    expect(cgPlanIsPro('')).toBe(false);
    expect(cgPlanIsPro(undefined)).toBe(false);
  });
});

describe('resolveKnownCoin', () => {
  it('maps majors (and their tickers) without a search round-trip', () => {
    expect(resolveKnownCoin('bitcoin')?.id).toBe('bitcoin');
    expect(resolveKnownCoin('BTC')?.id).toBe('bitcoin');
    expect(resolveKnownCoin(' Ethereum ')?.id).toBe('ethereum');
    expect(resolveKnownCoin('sol')?.id).toBe('solana');
    expect(resolveKnownCoin('xrp')?.id).toBe('ripple');
  });

  it('returns null for unknown coins (caller falls back to /search)', () => {
    expect(resolveKnownCoin('some-obscure-token')).toBeNull();
  });
});
