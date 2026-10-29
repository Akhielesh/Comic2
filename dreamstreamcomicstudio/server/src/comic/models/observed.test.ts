// @vitest-environment node
// Our own per-call facts (models.md §2.3 observed price, §2.4 R4, §4.4 T2/T7, AT-9 privacy).
import { describe, expect, it } from 'vitest';
import { callRow, memoryImageCalls } from './__fixtures__/catalogFakes.js';
import {
  MIN_PLATFORM_USERS,
  median,
  monthlyByModel,
  observedEntriesFor,
  observedFor,
  observedMedians,
  platformReliabilityFor,
  platformTopModels,
  qcObservedFor,
  reliabilityFor
} from './observed.js';

const NOW = Date.parse('2026-10-22T18:20:00Z');
const MIN = 60_000;

describe('observed price (models.md §2.3 step 2)', () => {
  it('median of the last ≤ 20 priced calls of the same model, kind and resolution', () => {
    const rows = [0.0428, 0.0465, 0.0474, 0.0538].map((c, i) => callRow({ at: NOW - i * MIN, providerCostUsd: c }));
    const e = observedFor(rows, { modelId: 'nano-banana-2.1', kind: 'page', res: '1K' })!;
    expect(e).toMatchObject({ n: 4, medianUsd: 0.047, minUsd: 0.0428, maxUsd: 0.0538, scope: 'you' });
    expect(e.to > e.from).toBe(true);
    // Another kind, resolution or model never mixes in.
    rows.push(callRow({ at: NOW, kind: 'sheet', providerCostUsd: 9 }), callRow({ at: NOW, res: '2K', providerCostUsd: 9 }), callRow({ at: NOW, modelId: 'nano-banana-pro', providerCostUsd: 9 }));
    expect(observedFor(rows, { modelId: 'nano-banana-2.1', kind: 'page', res: '1K' })!.medianUsd).toBe(0.047);
  });

  it('only the newest 20 count', () => {
    const old = Array.from({ length: 20 }, (_, i) => callRow({ at: NOW - (100 + i) * MIN, providerCostUsd: 1 }));
    const recent = Array.from({ length: 20 }, (_, i) => callRow({ at: NOW - i * MIN, providerCostUsd: 0.05 }));
    expect(observedFor([...old, ...recent], { modelId: 'nano-banana-2.1', kind: 'page', res: '1K' })).toMatchObject({ n: 20, medianUsd: 0.05 });
  });

  it('n < 3, failed calls and unreported costs give no observed price', () => {
    const rows = [
      callRow({ at: NOW, providerCostUsd: 0.05 }),
      callRow({ at: NOW - MIN, providerCostUsd: 0.05 }),
      callRow({ at: NOW - 2 * MIN, outcome: 'failed', providerCostUsd: 0 }),
      callRow({ at: NOW - 3 * MIN, providerCostUsd: null })
    ];
    expect(observedFor(rows, { modelId: 'nano-banana-2.1', kind: 'page', res: '1K' })).toBeNull();
  });

  it('median handles even counts and drops non-numbers', () => {
    expect(median([3, 1, 2, 4])).toBe(2.5);
    expect(median([Number.NaN, 5])).toBe(5);
    expect(median([])).toBeNull();
  });
});

describe('platform aggregates are hidden below 5 distinct users (AT-9)', () => {
  const rowsFor = (users: number) =>
    Array.from({ length: users * 2 }, (_, i) => callRow({ at: NOW - i * MIN, userId: `u${i % users}`, providerCostUsd: 0.05 + (i % 3) * 0.001 }));

  it('4 users: the stats function returns nothing, so no platform entry, no reliability, no "most used"', async () => {
    const db = memoryImageCalls(rowsFor(4));
    const stats = await db.platformStats(new Date(NOW - 86_400_000).toISOString());
    expect(stats).toEqual([]);
    expect(observedEntriesFor([], stats, 'nano-banana-2.1')).toEqual([]);
    expect(platformReliabilityFor(stats, 'nano-banana-2.1')).toBeNull();
    expect(platformTopModels(stats)).toBeNull();
  });

  it('5 users: the platform median is used for a user with no own calls, and "most used" appears', async () => {
    const db = memoryImageCalls(rowsFor(MIN_PLATFORM_USERS));
    const stats = await db.platformStats(new Date(NOW - 86_400_000).toISOString());
    const entries = observedEntriesFor([], stats, 'nano-banana-2.1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ scope: 'platform', n: 10, kind: 'page', res: '1K' });
    expect(platformTopModels(stats)).toEqual([{ modelId: 'nano-banana-2.1', calls: 10, users: 5 }]);
    expect(platformReliabilityFor(stats, 'nano-banana-2.1')).toMatchObject({ calls: 10, failed: 0, scope: 'platform' });
  });

  it('belt and braces: a group that slipped through with < 5 users is still ignored', () => {
    const leaked = [{ modelId: 'nano-banana-2.1', kind: 'page', res: '1K', calls: 9, ok: 9, failed: 0, rateLimited: 0, distinctUsers: 2, medianCostUsd: 0.05, minCostUsd: 0.05, maxCostUsd: 0.05, firstAt: null, lastAt: null }];
    expect(observedEntriesFor([], leaked, 'nano-banana-2.1')).toEqual([]);
    expect(platformTopModels(leaked)).toBeNull();
    expect(platformReliabilityFor(leaked, 'nano-banana-2.1')).toBeNull();
  });

  it("the user's own entry wins over the platform's for the same kind and resolution", async () => {
    const all = rowsFor(5);
    const db = memoryImageCalls(all);
    const stats = await db.platformStats(new Date(NOW - 86_400_000).toISOString());
    const mine = all.filter((r) => r.userId === 'u0').concat([callRow({ at: NOW, userId: 'u0', providerCostUsd: 0.06 })]);
    const entries = observedEntriesFor(mine, stats, 'nano-banana-2.1');
    expect(entries.map((e) => e.scope)).toEqual(['you']);
    expect(observedMedians(mine, stats).every((m) => m.scope === 'you')).toBe(true);
  });
});

describe('reliability (models.md §2.4 R4)', () => {
  it('last 24 h: calls, failures and 429s; preflight-blocked rows are not calls; older rows are out', () => {
    const rows = [
      callRow({ at: NOW - MIN }),
      callRow({ at: NOW - 2 * MIN, outcome: 'failed', httpStatus: 429, errorCode: 'RATE_LIMIT', providerCostUsd: 0 }),
      callRow({ at: NOW - 3 * MIN, outcome: 'failed', httpStatus: 500, errorCode: 'UPSTREAM', providerCostUsd: 0 }),
      callRow({ at: NOW - 4 * MIN, outcome: 'blocked', providerCostUsd: null }),
      callRow({ at: NOW - 25 * 3_600_000 })
    ];
    expect(reliabilityFor(rows, { modelId: 'nano-banana-2.1', now: NOW })).toEqual({ windowH: 24, calls: 3, failed: 2, rateLimited: 1, scope: 'you' });
    expect(reliabilityFor(rows, { modelId: 'nano-banana-pro', now: NOW })).toBeNull();
    expect(reliabilityFor(rows, { modelId: 'nano-banana-2.1', now: NOW, windowH: 168 })!.calls).toBe(4);
  });
});

describe('QC and monthly use', () => {
  it('observed QC per page only with n ≥ 5', () => {
    const qc = (n: number) => Array.from({ length: n }, (_, i) => callRow({ at: NOW - i * MIN, modelId: 'gemini-3.8-flash', kind: 'qc', res: null, providerCostUsd: 0.0049 }));
    expect(qcObservedFor(qc(4))).toBeNull();
    expect(qcObservedFor(qc(7))).toEqual({ medianUsd: 0.0049, n: 7 });
  });

  it('T2: your images per month per model (successful calls only)', () => {
    const rows = [
      callRow({ at: Date.parse('2026-09-30T12:00:00Z') }),
      callRow({ at: Date.parse('2026-10-01T12:00:00Z') }),
      callRow({ at: Date.parse('2026-10-02T12:00:00Z') }),
      callRow({ at: Date.parse('2026-10-02T13:00:00Z'), outcome: 'failed' })
    ];
    expect(monthlyByModel(rows)).toEqual([
      { month: '2026-09', modelId: 'nano-banana-2.1', images: 1 },
      { month: '2026-10', modelId: 'nano-banana-2.1', images: 2 }
    ]);
  });
});
