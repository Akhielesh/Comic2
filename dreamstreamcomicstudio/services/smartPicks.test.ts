import { describe, it, expect } from 'vitest';
import { deriveSmartPicks, tileKey } from './smartPicks';

describe('deriveSmartPicks', () => {
  it('mines tickers from memory ($SYM and "X stock" forms)', () => {
    const picks = deriveSmartPicks('User tracks $NVDA closely and asked about TSLA stock twice.', []);
    const labels = picks.map((p) => p.label);
    expect(labels).toContain('NVDA stock');
    expect(labels).toContain('TSLA stock');
  });

  it('never treats common words as tickers', () => {
    const picks = deriveSmartPicks('THE user said TO track ALL the NEWS for ME.', []);
    expect(picks.every((p) => !['THE stock', 'ALL stock', 'NEWS stock', 'ME stock'].includes(p.label))).toBe(true);
  });

  it('mines places ("trip to X", "lives in X") into weather picks', () => {
    const picks = deriveSmartPicks('Planning a trip to Tokyo in July. The user lives in Austin Texas.', []);
    const labels = picks.map((p) => p.label);
    expect(labels).toContain('Weather · Tokyo');
    expect(labels).toContain('Weather · Austin Texas');
  });

  it('mines followed topics into news picks', () => {
    const picks = deriveSmartPicks('The user is interested in fusion energy and learning Spanish.', []);
    const labels = picks.map((p) => p.label);
    expect(labels).toContain('News · fusion energy');
  });

  it('maps crypto mentions to crypto_price tiles', () => {
    const picks = deriveSmartPicks('Holds some bitcoin since 2021.', []);
    const btc = picks.find((p) => p.tile.tool === 'crypto_price');
    expect(btc?.tile.args).toEqual({ coin: 'bitcoin' });
  });

  it('suppresses picks already pinned on the dashboard', () => {
    const first = deriveSmartPicks('Tracks $NVDA.', []);
    const nvda = first.find((p) => p.label === 'NVDA stock')!;
    const again = deriveSmartPicks('Tracks $NVDA.', [], new Set([tileKey(nvda.tile)]));
    expect(again.find((p) => p.label === 'NVDA stock')).toBeUndefined();
  });

  it('suggests NOTHING when there is no real signal (no generic fallbacks)', () => {
    expect(deriveSmartPicks('', [])).toEqual([]);
    expect(deriveSmartPicks('hello there, nice day', [])).toEqual([]);
  });

  it('uses recent session titles as signal too', () => {
    const picks = deriveSmartPicks('', ['Trip planner: trip to Lisbon', 'Market pulse: $AMD']);
    const labels = picks.map((p) => p.label);
    expect(labels).toContain('Weather · Lisbon');
    expect(labels).toContain('AMD stock');
  });
});
